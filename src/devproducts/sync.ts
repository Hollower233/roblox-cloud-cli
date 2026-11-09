import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorInfo } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import {
  compareIds, createDeveloperProduct, getDeveloperProduct, listDeveloperProducts, updateDeveloperProduct,
  type DeveloperProduct, type DeveloperProductRow,
} from './products.js';

export type ActionKind = 'update' | 'reuse' | 'create';
export interface PlannedAction {
  kind: ActionKind; name: string; zh: string; price: number;
  productId?: string; fromName?: string; fromPrice?: number | null;
}
export interface UniversePlan {
  universeId: string;
  /** Set when the whole universe is refused (duplicate names, incomplete list); nothing is written to it. */
  rejected?: { code: string; message: string; duplicates?: { name: string; productIds: string[] }[] };
  actions: PlannedAction[];
  unchanged: number;
  /** Products not in the table that were not needed for reuse; reported, never changed. */
  idle: { productId: string; name: string; price: number | null }[];
  /** Products not in the table that Roblox marks immutable; never reused. */
  immutable: { productId: string; name: string }[];
}

/** Pure diff of one universe: match by exact name, reuse products absent from the table (lowest ID first), create the rest. */
export function planUniverse(universeId: string, rows: DeveloperProductRow[], products: DeveloperProduct[]): UniversePlan {
  const plan: UniversePlan = { universeId, actions: [], unchanged: 0, idle: [], immutable: [] };
  const byName = new Map<string, DeveloperProduct[]>();
  for (const product of products) byName.set(product.name, [...(byName.get(product.name) ?? []), product]);
  const duplicates = [...byName].filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({ name, productIds: list.map(p => p.productId).sort(compareIds) }));
  if (duplicates.length) {
    plan.rejected = { code: 'DUPLICATE_PRODUCT_NAMES', message: `Universe has ${duplicates.length} duplicated developer product name(s); rename or retire them in Creator Hub first.`, duplicates };
    return plan;
  }
  const tableNames = new Set(rows.map(row => row.en));
  const unmatched: DeveloperProductRow[] = [];
  for (const row of rows) {
    const product = byName.get(row.en)?.[0];
    if (!product) { unmatched.push(row); continue; }
    if (product.price === row.price) { plan.unchanged++; continue; }
    plan.actions.push({ kind: 'update', name: row.en, zh: row.zh, price: row.price, productId: product.productId, fromPrice: product.price });
  }
  const spare = products.filter(p => !tableNames.has(p.name)).sort((a, b) => compareIds(a.productId, b.productId));
  plan.immutable = spare.filter(p => p.isImmutable).map(p => ({ productId: p.productId, name: p.name }));
  const pool = spare.filter(p => !p.isImmutable);
  unmatched.forEach((row, index) => {
    const product = pool[index];
    plan.actions.push(product
      ? { kind: 'reuse', name: row.en, zh: row.zh, price: row.price, productId: product.productId, fromName: product.name, fromPrice: product.price }
      : { kind: 'create', name: row.en, zh: row.zh, price: row.price });
  });
  plan.idle = pool.slice(unmatched.length).map(p => ({ productId: p.productId, name: p.name, price: p.price }));
  return plan;
}

/** Token binding a confirmation to the exact table and cloud snapshots it was shown for. */
export function planToken(rows: DeveloperProductRow[], snapshots: { universeId: string; products: DeveloperProduct[] | null }[]): string {
  const canonical = {
    rows: rows.map(row => [row.en, row.price]),
    universes: snapshots.map(s => [s.universeId, s.products === null ? null
      : s.products.map(p => [p.productId, p.name, p.price, p.isForSale, p.isImmutable]).sort((a, b) => compareIds(String(a[0]), String(b[0])))]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

export type ActionState = 'verified' | 'failed' | 'unverified';
export interface ActionResult extends PlannedAction { state: ActionState; resultProductId?: string; readbacks?: number; error?: ReturnType<typeof errorInfo> }
export interface UniverseResult extends Omit<UniversePlan, 'actions'> { actions: (PlannedAction | ActionResult)[]; backupPath?: string; error?: ReturnType<typeof errorInfo> }
export interface DeveloperProductSyncResult {
  state: 'synced' | 'confirmation_required';
  /** confirmation_required only: the token to pass back with --confirm after a human approved the diff. */
  confirmToken?: string;
  /** confirmation_required with --confirm given but the diff changed since it was shown. */
  stale?: boolean;
  universes: UniverseResult[];
}
export interface DeveloperProductSyncOptions {
  confirm?: string; backupDirectory?: string; onProgress?: (message: string) => void;
  /** Waits between re-reads when a write's readback does not match yet; default READBACK_DELAYS_MS. */
  readbackDelaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>;
}
/** Up to 5 reads over ~11s; measured read-after-write lag was up to ~2s. */
export const READBACK_DELAYS_MS = [1000, 2000, 3000, 5000] as const;

const ALL_DONE = new Set(['verified']);

/**
 * Sync the table into each universe. Without reuse the writes happen immediately; if any universe would reuse
 * (rename) a product, nothing is written anywhere until the call is repeated with the returned confirm token.
 */
export async function syncDeveloperProducts(targets: { universeId: string; http: HttpClient }[], rows: DeveloperProductRow[], options: DeveloperProductSyncOptions = {}): Promise<DeveloperProductSyncResult> {
  if (new Set(targets.map(t => t.universeId)).size !== targets.length) throw new AppError('ARGUMENT_ERROR', 'Each universe may be given only once.');
  const snapshots: { universeId: string; http: HttpClient; products: DeveloperProduct[] | null; plan: UniverseResult }[] = [];
  for (const target of targets) {
    try {
      const products = await listDeveloperProducts(target.http, target.universeId);
      snapshots.push({ ...target, products, plan: planUniverse(target.universeId, rows, products) });
    } catch (error) {
      if (error instanceof AppError && ['CANCELLED', 'AUTH_REQUIRED', 'AUTH_INVALID'].includes(error.code)) throw error;
      snapshots.push({ ...target, products: null, plan: {
        universeId: target.universeId, actions: [], unchanged: 0, idle: [], immutable: [],
        rejected: { code: 'PRODUCT_LIST_INCOMPLETE', message: 'Could not read the complete developer product list; nothing will be written to this universe.' },
        error: errorInfo(error),
      } });
    }
  }
  const token = planToken(rows, snapshots);
  const needsConfirm = snapshots.some(s => !s.plan.rejected && s.plan.actions.some(a => a.kind === 'reuse'));
  const universes = snapshots.map(s => s.plan);
  if (options.confirm !== undefined && options.confirm !== token) return { state: 'confirmation_required', confirmToken: token, stale: true, universes };
  if (needsConfirm && options.confirm === undefined) return { state: 'confirmation_required', confirmToken: token, universes };

  for (const snapshot of snapshots) {
    const plan = snapshot.plan;
    if (plan.rejected || !plan.actions.length) continue;
    try { plan.backupPath = await saveBackup(options.backupDirectory, plan.universeId, snapshot.products!, plan.actions as PlannedAction[]); }
    catch (error) { plan.error = errorInfo(error); plan.actions = plan.actions.map(a => ({ ...a, state: 'failed', error: errorInfo(error) })); continue; }
    const results: ActionResult[] = [];
    for (const action of plan.actions as PlannedAction[]) {
      options.onProgress?.(`${plan.universeId} ${action.kind} ${action.name}`);
      const result = await execute(snapshot.http, plan.universeId, action, options.readbackDelaysMs ?? READBACK_DELAYS_MS, options.sleep ?? (ms => delay(ms)));
      results.push(result);
      if (result.error?.code === 'CANCELLED' || result.error?.code === 'AUTH_INVALID') {
        const pending = (plan.actions as PlannedAction[]).slice(results.length).map(a => ({ ...a, state: 'failed' as const, error: result.error }));
        plan.actions = [...results, ...pending];
        throw new AppError(result.error.code === 'CANCELLED' ? 'CANCELLED' : 'AUTH_INVALID', result.error.message);
      }
    }
    plan.actions = results;
  }
  return { state: 'synced', universes };
}

async function execute(http: HttpClient, universeId: string, action: PlannedAction, delays: readonly number[], sleep: (ms: number) => Promise<void>): Promise<ActionResult> {
  const result: ActionResult = { ...action, state: 'failed' };
  let submitted = false;
  try {
    let productId = action.productId;
    if (action.kind === 'update') {
      submitted = true;
      await updateDeveloperProduct(http, universeId, productId!, { price: action.price });
    } else if (action.kind === 'reuse') {
      submitted = true;
      await updateDeveloperProduct(http, universeId, productId!, { name: action.name, description: '', price: action.price, isForSale: true, isRegionalPricingEnabled: false });
    } else {
      submitted = true;
      productId = (await createDeveloperProduct(http, universeId, { name: action.name, price: action.price, isForSale: true, isRegionalPricingEnabled: false })).productId;
    }
    result.resultProductId = productId;
    result.state = 'unverified';
    // Reads are eventually consistent (observed: ~2s, flipping between old and new values), so a mismatch or a
    // not-yet-visible product (404) is re-read after a delay; the write itself is never repeated.
    let last = 'product not visible yet';
    for (let attempt = 0; ; attempt++) {
      result.readbacks = attempt + 1;
      try {
        const after = await getDeveloperProduct(http, universeId, productId!);
        if (after.name === action.name && after.price === action.price && (action.kind === 'update' || after.isForSale)) break;
        last = `name ${JSON.stringify(after.name)}, price ${after.price}, for sale ${after.isForSale}`;
      } catch (error) {
        if (!(error instanceof AppError && error.httpStatus === 404)) throw error;
      }
      if (attempt >= delays.length) throw new AppError('INVALID_RESPONSE', `Readback still does not match after ${attempt + 1} reads (${last}); inspect before retrying.`);
      await sleep(delays[attempt]!);
    }
    result.state = 'verified';
  } catch (error) {
    const definite = error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500;
    result.state = result.state === 'unverified' || (submitted && !definite) ? 'unverified' : 'failed';
    result.error = errorInfo(error);
  }
  return result;
}

async function saveBackup(directory: string | undefined, universeId: string, products: DeveloperProduct[], actions: PlannedAction[]): Promise<string | undefined> {
  if (!directory) return undefined;
  const path = join(directory, `${universeId}-${Date.now()}-${randomUUID()}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, universeId, at: new Date().toISOString(), actions, products }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch { throw new AppError('STORAGE_ERROR', 'Could not save developer product backup; nothing submitted to this universe.'); }
  return path;
}

/** Warnings for anything not cleanly applied: refused universes and failed/unverified writes. */
export function syncWarnings(result: DeveloperProductSyncResult): { code: string; message: string; resource?: string }[] {
  if (result.state !== 'synced') return [];
  const warnings: { code: string; message: string; resource?: string }[] = [];
  for (const universe of result.universes) {
    if (universe.rejected) warnings.push({ code: universe.rejected.code, message: universe.rejected.message, resource: universe.universeId });
    for (const action of universe.actions) {
      if ('state' in action && !ALL_DONE.has(action.state)) warnings.push({
        code: action.error?.code ?? action.state.toUpperCase(),
        message: `${action.kind} ${action.name}: ${action.state === 'unverified' ? 'result unknown; run devproduct list before retrying' : action.error?.message ?? 'failed'}`,
        resource: universe.universeId,
      });
    }
  }
  return warnings;
}

export const CONFIRM_INSTRUCTION = '尚未写入任何宇宙。本次同步包含改名复用（reuse）：会把云端已不在开发者产品表里的旧商品改名、改价、重新上架给新商品使用。'
  + '改名后，旧商品尚未处理完的收据补发时会按新商品发货；代码里写死但没写进表的商品名也会被当作闲置复用。'
  + '请把以上完整 diff（尤其每一条 reuse 的旧名 → 新名）展示给用户，获得用户明确同意后，再用相同参数加 --confirm <confirmToken> 执行。不得自行确认。';
export const STALE_INSTRUCTION = '确认码已失效：开发者产品表或云端商品在确认后发生了变化，未写入任何宇宙。请把新的 diff 重新展示给用户并获得同意，再使用新的 confirmToken。';
