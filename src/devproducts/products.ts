import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { object } from '../cloud/common.js';
import { AppError, id } from '../core/errors.js';
import { parseRecordRows } from '../localization/lua-table.js';
import { readRbxm } from '../localization/rbxm.js';
import type { HttpClient } from '../transport/http-client.js';

/** One developer product as returned by Open Cloud (only the fields the CLI relies on). */
export interface DeveloperProduct {
  productId: string; name: string; description: string; price: number | null;
  isForSale: boolean; isImmutable: boolean; regionalPricing: boolean; iconImageAssetId: string | null;
}
/** One row of the Studio table 项目文档/开发者产品. `en` is the Roblox product name and the match key. */
export interface DeveloperProductRow { en: string; zh: string; price: number }

export const DEVPRODUCT_TABLE_NAME = '开发者产品';
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

const base = (universeId: string) => `https://apis.roblox.com/developer-products/v2/universes/${id(universeId)}/developer-products`;

function parseProduct(value: unknown, universeId: string): DeveloperProduct {
  const data = object(value, true);
  const productId = typeof data.productId === 'number' && Number.isSafeInteger(data.productId) && data.productId > 0 ? String(data.productId) : null;
  if (!productId || typeof data.name !== 'string') throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid developer product.');
  if (data.universeId !== undefined && String(data.universeId) !== universeId) throw new AppError('INVALID_RESPONSE', 'Roblox returned a developer product from another universe.');
  const pricing = data.priceInformation && typeof data.priceInformation === 'object' ? data.priceInformation as Record<string, unknown> : {};
  const price = typeof pricing.defaultPriceInRobux === 'number' && Number.isSafeInteger(pricing.defaultPriceInRobux) ? pricing.defaultPriceInRobux : null;
  const features = Array.isArray(pricing.enabledFeatures) ? pricing.enabledFeatures : [];
  const icon = typeof data.iconImageAssetId === 'number' && data.iconImageAssetId > 0 ? String(data.iconImageAssetId) : null;
  return {
    productId, name: data.name, description: typeof data.description === 'string' ? data.description : '', price,
    isForSale: data.isForSale === true, isImmutable: data.isImmutable === true,
    regionalPricing: features.includes('RegionalPricing'), iconImageAssetId: icon,
  };
}

/**
 * Every developer product of a universe. Pages until nextPageToken is empty; a repeated token,
 * a runaway page count or any failed page throws, so callers never act on a partial list.
 */
export async function listDeveloperProducts(http: HttpClient, universeId: string, onPage?: (page: number, total: number) => void): Promise<DeveloperProduct[]> {
  const seen = new Map<string, DeveloperProduct>(), tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new AppError('INVALID_RESPONSE', `Developer product list exceeded ${MAX_PAGES} pages.`);
    const url = new URL(`${base(universeId)}/creator`);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (token) url.searchParams.set('pageToken', token);
    let body;
    try { body = object(await http.request(url.toString(), { auth: true }), true); }
    catch (error) {
      if (error instanceof AppError) error.message = `${error.message} (developer product list page ${page})`;
      throw error;
    }
    if (!Array.isArray(body.developerProducts)) throw new AppError('INVALID_RESPONSE', `Roblox returned an invalid developer product page ${page}.`);
    for (const row of body.developerProducts) { const product = parseProduct(row, universeId); seen.set(product.productId, product); }
    onPage?.(page, seen.size);
    const next = body.nextPageToken;
    if (next === undefined || next === null || next === '') break;
    if (typeof next !== 'string' || tokens.has(next)) throw new AppError('INVALID_RESPONSE', `Roblox returned an invalid or repeated developer product page token (page ${page}).`);
    tokens.add(next);
    token = next;
  }
  return [...seen.values()].sort((a, b) => compareIds(a.productId, b.productId));
}

export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export async function getDeveloperProduct(http: HttpClient, universeId: string, productId: string): Promise<DeveloperProduct> {
  return parseProduct(await http.request(`${base(universeId)}/${id(productId)}/creator`, { auth: true }), universeId);
}

export interface ProductFields { name?: string; description?: string; price?: number; isForSale?: boolean; isRegionalPricingEnabled?: boolean }
function form(fields: ProductFields): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) data.append(key, String(value));
  return data;
}

/** POST creates a product; the response carries the new productId. Never retried. */
export async function createDeveloperProduct(http: HttpClient, universeId: string, fields: ProductFields & { name: string }): Promise<DeveloperProduct> {
  return parseProduct(await http.request(base(universeId), { method: 'POST', auth: true, form: form(fields) }), universeId);
}

/** PATCH changes only the fields sent; Roblox answers 204 without a body. Never retried. */
export async function updateDeveloperProduct(http: HttpClient, universeId: string, productId: string, fields: ProductFields): Promise<void> {
  if (!Object.values(fields).some(value => value !== undefined)) throw new AppError('ARGUMENT_ERROR', 'Nothing to update.');
  await http.request(`${base(universeId)}/${id(productId)}`, { method: 'PATCH', auth: true, form: form(fields), rawResponse: true });
}

/** Parse the Studio table exported with export_rbxm: exactly one root ModuleScript of `{ en, zh, price }` rows. */
export function parseDeveloperProductTable(file: Buffer): DeveloperProductRow[] {
  const roots = readRbxm(file).filter(node => node.className === 'ModuleScript');
  if (roots.length !== 1) throw new AppError('ARGUMENT_ERROR', 'The .rbxm must contain exactly one root ModuleScript (the developer product table).');
  const root = roots[0]!;
  if (root.source === null) throw new AppError('ARGUMENT_ERROR', 'The developer product ModuleScript has no Source.');
  return parseDeveloperProductSource(root.source, root.name);
}

export function parseDeveloperProductSource(source: string, module = DEVPRODUCT_TABLE_NAME): DeveloperProductRow[] {
  const rows: DeveloperProductRow[] = [], seen = new Set<string>();
  const fail = (index: number, message: string): never => { throw new AppError('ARGUMENT_ERROR', `${module} row ${index + 1}: ${message}`); };
  parseRecordRows(source, module).forEach(({ fields }, index) => {
    for (const key of Object.keys(fields)) if (!['en', 'zh', 'price'].includes(key)) fail(index, `unknown field ${key}`);
    const { en, zh, price } = fields;
    if (typeof en !== 'string' || !en.trim()) fail(index, 'en must be a non-empty string');
    if ((en as string).trim() !== en) fail(index, 'en must not start or end with whitespace');
    if (typeof zh !== 'string') fail(index, 'zh must be a string');
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 1) fail(index, 'price must be a positive integer');
    if (seen.has(en as string)) fail(index, `duplicate en ${JSON.stringify(en)}`);
    seen.add(en as string);
    rows.push({ en: en as string, zh: zh as string, price: price as number });
  });
  if (!rows.length) throw new AppError('ARGUMENT_ERROR', `${module} has no rows.`);
  return rows;
}

export async function loadDeveloperProductTable(path: string): Promise<DeveloperProductRow[]> {
  let file: Buffer;
  try { file = await readFile(resolve(path)); } catch { throw new AppError('ARGUMENT_ERROR', `Cannot read ${path}.`); }
  return parseDeveloperProductTable(file);
}
