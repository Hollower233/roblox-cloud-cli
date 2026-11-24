import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readAssetUploadImage } from '../assets/upload.js';
import { backup, object, saveWriteReceipt, type JsonObject, type WriteOptions, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

const productTypes = { consumable: 1, currency: 2, durable: 3 } as const;
const statuses = ['unknown', 'inactive', 'active', 'activating', 'deactivating', 'deleting', 'deleted', 'off-sale'] as const;
const currencies = ['unknown', 'robux', 'local', 'robux-and-local'] as const;
const authenticatedUser = 'https://users.roblox.com/v1/users/authenticated';
type Cover = Awaited<ReturnType<typeof readAssetUploadImage>>;

export type SubscriptionProductType = keyof typeof productTypes;
export interface SubscriptionProduct {
  universeId: string;
  productId: string;
  name: string;
  description: string | null;
  type: SubscriptionProductType | null;
  status: typeof statuses[number];
  statusCode: number;
  currency: typeof currencies[number];
  priceInRobux: number | null;
  regionalPricing: boolean | null;
  coverAssetId: string | null;
}
export interface CreateSubscriptionFields {
  name: string;
  description: string;
  price: number;
  type: SubscriptionProductType;
  image: string;
}
export type UpdateSubscriptionFields = Partial<Pick<CreateSubscriptionFields, 'description' | 'price' | 'image'>>;
export interface SubscriptionWriteOptions extends WriteOptions {
  sleep?: (ms: number) => Promise<void>;
}
export interface SubscriptionReceipt extends WriteReceipt {
  productId?: string;
  cover?: { bytes: number; sha256: string; format: 'png' | 'jpeg'; width: number; height: number };
}

function collectionUrl(universeId: string): string {
  return `https://apis.roblox.com/experience-subscriptions/v1/experiences/${id(universeId)}/experience-subscriptions`;
}

export function subscriptionProductId(value: string): string {
  const token = typeof value === 'string' ? value.replace(/^EXP-/i, '') : '';
  if (!/^[1-9]\d{0,127}$/.test(token)) throw new AppError('ARGUMENT_ERROR', 'Expected a subscription product ID in EXP-… format.');
  return `EXP-${token}`;
}

function responseProductId(value: unknown): string {
  try {
    return subscriptionProductId(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value as string);
  } catch {
    throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid subscription product ID.');
  }
}

function responseNumericId(value: unknown): string | null {
  const token = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof token === 'string' && /^[1-9]\d*$/.test(token) ? token : null;
}

function readProduct(value: unknown, universeId: string, expectedId?: string): SubscriptionProduct {
  const raw = object(value, true), productId = responseProductId(raw.id);
  if (responseNumericId(raw.universeId) !== universeId || (expectedId && productId !== expectedId)) {
    throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the requested Universe and subscription product.');
  }
  if (typeof raw.name !== 'string' || !Number.isSafeInteger(raw.productStatusType)) {
    throw new AppError('INVALID_RESPONSE', 'Roblox returned incomplete subscription product details.');
  }
  const statusCode = raw.productStatusType as number;
  const typeCode = raw.productType ?? raw.developerSubscriptionProductType;
  return {
    universeId, productId, statusCode, name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : null,
    type: (Object.keys(productTypes) as SubscriptionProductType[]).find(type => productTypes[type] === typeCode) ?? null,
    status: statuses[statusCode] ?? 'unknown',
    currency: typeof raw.currencyType === 'number' ? currencies[raw.currencyType] ?? 'unknown' : 'unknown',
    priceInRobux: typeof raw.priceInRobux === 'number' && Number.isSafeInteger(raw.priceInRobux) ? raw.priceInRobux : null,
    regionalPricing: typeof raw.isRegionalPricingEnabled === 'boolean' ? raw.isRegionalPricingEnabled : null,
    coverAssetId: responseNumericId(raw.imageAssetId),
  };
}

function checkedText(input: string, kind: 'name' | 'description'): string {
  const value = typeof input === 'string' ? input.trim() : '';
  if (kind === 'description') {
    if (value.length >= 10 && value.length <= 1000) return value;
    throw new AppError('ARGUMENT_ERROR', 'Subscription description must contain 10–1000 UTF-16 units.');
  }
  if (value.length <= 29 && /^[a-zA-Z0-9.,:/!?@#&' ]+$/.test(value)) return value;
  throw new AppError('ARGUMENT_ERROR', "Subscription name must use 1–29 characters accepted by Creator Dashboard (English letters, numbers, spaces, or .,:/!?@#&').");
}

export function subscriptionRobuxPrice(value: number | string): number {
  const price = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 49) {
    throw new AppError('ARGUMENT_ERROR', 'Subscription price must be a whole number of at least 49 Robux.');
  }
  return price;
}

async function saveCover(path: string | undefined, cover: Cover | undefined): Promise<void> {
  if (!path || !cover) return;
  try {
    await writeFile(`${path}.${cover.format === 'jpeg' ? 'jpg' : 'png'}`, cover.bytes, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new AppError('STORAGE_ERROR', 'Could not save the cover backup; no mutation submitted.');
  }
}

function coverInfo({ bytes, format, width, height }: Cover): NonNullable<SubscriptionReceipt['cover']> {
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), format, width, height };
}

function isRejected(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID'
    || error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500);
}

/** Creator Dashboard subscription products, authenticated by a Roblox session cookie. */
export class SubscriptionProducts {
  constructor(private http: HttpClient) {}

  async list(universeId: string): Promise<SubscriptionProduct[]> {
    const url = new URL(collectionUrl(universeId));
    url.searchParams.set('ResultsPerPage', '50');
    const products: SubscriptionProduct[] = [], seen = new Set<string>(), cursors = new Set<string>();
    for (;;) {
      const page = object(await this.http.request(url.href, { cookieAuth: true }), true);
      if (!Array.isArray(page.developerSubscriptions)) {
        throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid subscription product list.');
      }
      for (const item of page.developerSubscriptions) {
        const product = readProduct(item, universeId);
        if (seen.has(product.productId)) throw new AppError('INVALID_RESPONSE', 'Roblox returned a duplicate subscription product while paginating.');
        seen.add(product.productId);
        products.push(product);
      }
      const cursor = page.nextCursor;
      if (page.hasMoreResults === false || (!cursor && page.hasMoreResults !== true)) return products;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor)) {
        throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid or repeated subscription list cursor.');
      }
      cursors.add(cursor);
      url.searchParams.set('Cursor', cursor);
    }
  }

  async get(universeId: string, input: string): Promise<SubscriptionProduct> {
    const productId = subscriptionProductId(input);
    const value = await this.http.request(`${collectionUrl(universeId)}/${productId.slice(4)}`, { cookieAuth: true });
    return readProduct(value, universeId, productId);
  }

  async create(universeId: string, fields: CreateSubscriptionFields, options: SubscriptionWriteOptions = {}): Promise<SubscriptionReceipt> {
    const url = collectionUrl(universeId);
    const name = checkedText(fields.name, 'name'), description = checkedText(fields.description, 'description');
    const price = subscriptionRobuxPrice(fields.price);
    if (!Object.hasOwn(productTypes, fields.type)) throw new AppError('ARGUMENT_ERROR', 'Subscription type must be consumable, currency, or durable.');
    if (typeof fields.image !== 'string' || !fields.image.trim()) throw new AppError('ARGUMENT_ERROR', 'A subscription cover image is required.');
    const cover = await readAssetUploadImage(resolve(fields.image));
    const body = { productName: name, productDescription: description, productType: productTypes[fields.type],
      currencyType: 1, basePriceId: null, priceInRobux: price, isRegionalPricingEnabled: true };
    const receipt: SubscriptionReceipt = { universeId, state: 'planned', request: { method: 'POST', url, body }, cover: coverInfo(cover) };
    if (options.dryRun) return receipt;
    const before = await this.list(universeId);
    if (before.some(product => product.status !== 'deleted' && product.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError('ARGUMENT_ERROR', 'A subscription with this name already exists. Use subscription list, then update it by ID.');
    }
    const actor = await this.actor();
    receipt.backupPath = await backup(options.backupDirectory, universeId, receipt.request, before);
    await saveCover(receipt.backupPath, cover);
    receipt.state = 'unverified';
    try {
      const result = object(await this.http.request(url, { cookieAuth: true, method: 'POST', body }), true);
      const created = object(result.developerSubscription, true);
      receipt.productId = responseProductId(created.id);
      receipt.response = { productId: receipt.productId };
      if (responseNumericId(created.universeId) !== universeId) {
        throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the Universe of the created subscription. Inspect the returned ID.');
      }
      if (receipt.backupPath) {
        try {
          await writeFile(`${receipt.backupPath}.created.json`, JSON.stringify({ universeId, ...receipt.response }), { flag: 'wx', mode: 0o600 });
        } catch {
          throw new AppError('STORAGE_ERROR', 'Subscription created, but its ID could not be saved. Keep the returned ID and upload the cover with update.');
        }
      }
      const initial = await this.get(universeId, receipt.productId);
      receipt.readback = { ...initial };
      if (initial.status !== 'inactive') throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the new subscription is inactive.');
      await this.upload(url, receipt.productId, actor, cover);
      await this.verify(receipt, options, product => product.name === name && product.description === description
        && product.priceInRobux === price && product.currency === 'robux' && product.type === fields.type && product.status === 'inactive'
        && product.regionalPricing === true && product.coverAssetId !== null && product.coverAssetId !== initial.coverAssetId);
    } catch (error) {
      if (!receipt.productId && isRejected(error)) throw error;
      receipt.error = errorInfo(error);
    }
    return saveWriteReceipt(receipt);
  }

  async update(universeId: string, input: string, fields: UpdateSubscriptionFields, options: SubscriptionWriteOptions = {}): Promise<SubscriptionReceipt> {
    const productId = subscriptionProductId(input), collection = collectionUrl(universeId);
    const url = `${collection}/${productId.slice(4)}`;
    const body: JsonObject = {};
    if ('name' in fields && fields.name !== undefined) throw new AppError('ARGUMENT_ERROR', 'Roblox subscription names are fixed at creation.');
    if (fields.description !== undefined) body.description = checkedText(fields.description, 'description');
    if (fields.price !== undefined) body.priceInRobux = subscriptionRobuxPrice(fields.price);
    if (!Object.keys(body).length && fields.image === undefined) throw new AppError('ARGUMENT_ERROR', 'Provide at least one subscription field to update.');
    if (fields.image !== undefined && (typeof fields.image !== 'string' || !fields.image.trim())) {
      throw new AppError('ARGUMENT_ERROR', 'Provide a subscription cover image path.');
    }
    const cover = fields.image === undefined ? undefined : await readAssetUploadImage(resolve(fields.image));
    const before = await this.get(universeId, productId);
    if (body.priceInRobux !== undefined && before.currency !== 'robux') {
      throw new AppError('ARGUMENT_ERROR', 'Monthly Robux price can only be changed on a Robux subscription.');
    }
    const changes = Object.fromEntries(Object.entries(body).filter(([key, value]) => value !== before[key as keyof SubscriptionProduct]));
    const patch = Object.keys(changes).length > 0;
    const request = patch || !cover ? { method: 'PATCH' as const, url, body: changes } : { method: 'POST' as const, url: `${url}/upload-image` };
    const receipt: SubscriptionReceipt = { universeId, productId, state: 'planned', request, readback: { ...before },
      ...(cover ? { cover: coverInfo(cover) } : {}) };
    if (options.dryRun) return receipt;
    if (!patch && !cover) return { ...receipt, state: 'verified' };
    const actor = cover ? await this.actor() : undefined;
    receipt.backupPath = await backup(options.backupDirectory, universeId, request, before);
    await saveCover(receipt.backupPath, cover);
    receipt.state = 'unverified';
    let patched = false;
    try {
      if (patch) {
        const response = object(await this.http.request(url, { cookieAuth: true, method: 'PATCH', body: changes }), true);
        if (response.success !== true) throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the subscription update.');
        patched = true;
      }
      if (cover && actor) await this.upload(collection, productId, actor, cover);
      await this.verify(receipt, options, product => Object.entries(body).every(([key, value]) => product[key as keyof SubscriptionProduct] === value)
        && (!cover || product.coverAssetId !== null && product.coverAssetId !== before.coverAssetId));
    } catch (error) {
      if (!patched && isRejected(error)) throw error;
      receipt.error = errorInfo(error);
    }
    return saveWriteReceipt(receipt);
  }

  async activate(universeId: string, input: string, options: SubscriptionWriteOptions = {}): Promise<SubscriptionReceipt> {
    const productId = subscriptionProductId(input), collection = collectionUrl(universeId);
    const before = await this.get(universeId, productId);
    const request = { method: 'POST' as const, url: `${collection}/${productId.slice(4)}/activate` };
    const receipt: SubscriptionReceipt = { universeId, productId, state: 'planned', request, readback: { ...before } };
    if (before.status === 'active') return { ...receipt, state: options.dryRun ? 'planned' : 'verified' };
    if (before.status !== 'inactive' && before.status !== 'off-sale') {
      throw new AppError('ARGUMENT_ERROR', `Subscription cannot be activated from state ${before.status}.`);
    }
    if (options.dryRun) return receipt;
    receipt.backupPath = await backup(options.backupDirectory, universeId, request, before);
    receipt.state = 'unverified';
    try {
      const result = object(await this.http.request(request.url, { cookieAuth: true, method: 'POST' }), true);
      if (result.success !== true) throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the activation request.');
      await this.verify(receipt, options, product => product.status === 'active');
    } catch (error) {
      if (isRejected(error)) throw error;
      receipt.error = errorInfo(error);
    }
    return saveWriteReceipt(receipt);
  }

  private async actor(): Promise<string> {
    const result = object(await this.http.request(authenticatedUser, { cookieAuth: true }), true);
    const actor = responseNumericId(result.id);
    if (!actor) throw new AppError('INVALID_RESPONSE', 'Roblox did not return the authenticated user ID for the cover upload.');
    return actor;
  }

  private async upload(collection: string, productId: string, actor: string, cover: Cover): Promise<void> {
    const form = new FormData();
    form.set('ActingUserId', actor);
    form.set('ImageFile', new Blob([new Uint8Array(cover.bytes)], { type: `image/${cover.format}` }),
      cover.format === 'jpeg' ? 'cover.jpg' : 'cover.png');
    const result = object(await this.http.request(`${collection}/${productId.slice(4)}/upload-image`,
      { cookieAuth: true, method: 'POST', form }), true);
    if (!result.status) throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm the subscription cover upload.');
  }

  private async verify(receipt: SubscriptionReceipt, options: SubscriptionWriteOptions, matches: (product: SubscriptionProduct) => boolean): Promise<void> {
    const sleep = options.sleep ?? delay;
    for (const wait of [0, 400, 1200, 2500]) {
      if (wait) await sleep(wait);
      try {
        const product = await this.get(receipt.universeId, receipt.productId!);
        receipt.readback = { ...product };
        if (matches(product)) {
          receipt.state = 'verified';
          delete receipt.error;
          return;
        }
        receipt.error = { code: 'READBACK_MISMATCH', message: 'Subscription readback did not match the request. Inspect the product before retrying.' };
      } catch (error) {
        receipt.error = errorInfo(error);
        if (isRejected(error)) return;
      }
    }
  }
}
