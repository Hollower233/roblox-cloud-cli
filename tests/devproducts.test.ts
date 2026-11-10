import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  HttpClient, listDeveloperProducts, parseDeveloperProductSource, parseDeveloperProductTable, planUniverse,
  syncDeveloperProducts, type DeveloperProduct, type DeveloperProductRow,
} from '../src/index.js';
import { writeRbxm } from '../src/localization/rbxm.js';

interface Fake { productId: number; name: string; price: number; isForSale: boolean; isImmutable?: boolean; regional?: boolean; description?: string }
const wire = (p: Fake, universeId = 123) => ({
  productId: p.productId, name: p.name, description: p.description ?? '', iconImageAssetId: 0, universeId, isForSale: p.isForSale,
  priceInformation: { defaultPriceInRobux: p.price, enabledFeatures: p.regional ? ['RegionalPricing'] : [] },
  isImmutable: p.isImmutable ?? false, createdTimestamp: '', updatedTimestamp: '', isManagedPricingEnabled: false,
});

/** In-memory Open Cloud developer product API for one universe (123). */
function cloud(initial: Fake[], hooks: { failPage?: number; repeatToken?: boolean; failWrite?: (kind: string, name: string) => Response | 'timeout' | undefined; pageSize?: number; staleReads?: number } = {}) {
  // After each write, the next `staleReads` single-product GETs return the pre-write state (404 for a new product).
  let stale: { id: number; value: Fake | null; left: number } | null = null;
  const products = new Map(initial.map(p => [p.productId, { ...p }]));
  const log: { method: string; path: string; fields?: Record<string, string> }[] = [];
  let nextId = 9000;
  const http = new HttpClient({ apiKey: 'fictional-key', intervalMs: 0, retries: 0, fetch: async (input, init) => {
    const url = new URL(String(input)), method = init!.method ?? 'GET';
    assert.equal((init!.headers as Record<string, string>)['x-api-key'], 'fictional-key');
    const fields = init!.body instanceof FormData ? Object.fromEntries([...init!.body].map(([k, v]) => [k, String(v)])) : undefined;
    log.push({ method, path: url.pathname, fields });
    const parts = url.pathname.split('/');
    assert.equal(parts.slice(0, 6).join('/'), '/developer-products/v2/universes/123/developer-products');
    if (method === 'GET' && parts[6] === 'creator') {
      const size = Number(url.searchParams.get('pageSize')), start = Number(url.searchParams.get('pageToken') ?? 0);
      assert.equal(size, 50);
      const page = Math.floor(start / (hooks.pageSize ?? size)) + 1;
      if (hooks.failPage === page) return new Response(null, { status: 403 });
      const all = [...products.values()].sort((a, b) => a.productId - b.productId);
      const slice = all.slice(start, start + (hooks.pageSize ?? size));
      const more = start + slice.length < all.length;
      return Response.json({ developerProducts: slice.map(p => wire(p)), nextPageToken: more ? (hooks.repeatToken ? '0' : String(start + slice.length)) : '' });
    }
    if (method === 'GET') {
      const pid = Number(parts[6]);
      if (stale && stale.id === pid && stale.left > 0) { stale.left--; return stale.value ? Response.json(wire(stale.value)) : new Response(null, { status: 404 }); }
      const p = products.get(pid); return p ? Response.json(wire(p)) : new Response(null, { status: 404 });
    }
    const failure = hooks.failWrite?.(method, fields?.name ?? products.get(Number(parts[6]))?.name ?? '');
    if (failure === 'timeout') throw new DOMException('Timeout', 'TimeoutError');
    if (failure) return failure;
    if (method === 'POST') {
      const p: Fake = { productId: nextId++, name: fields!.name!, price: Number(fields!.price), isForSale: fields!.isForSale === 'true', regional: fields!.isRegionalPricingEnabled === 'true' };
      products.set(p.productId, p);
      stale = { id: p.productId, value: null, left: hooks.staleReads ?? 0 };
      return Response.json(wire(p));
    }
    const p = products.get(Number(parts[6]))!;
    stale = { id: p.productId, value: { ...p }, left: hooks.staleReads ?? 0 };
    if (fields!.name !== undefined) p.name = fields!.name;
    if (fields!.price !== undefined) p.price = Number(fields!.price);
    if (fields!.isForSale !== undefined) p.isForSale = fields!.isForSale === 'true';
    if (fields!.description !== undefined) p.description = fields!.description;
    if (fields!.isRegionalPricingEnabled !== undefined) p.regional = fields!.isRegionalPricingEnabled === 'true';
    return new Response(null, { status: 204 });
  } });
  return { http, products, log, writes: () => log.filter(l => l.method !== 'GET') };
}
const rows = (...list: [string, number][]): DeveloperProductRow[] => list.map(([en, price]) => ({ en, zh: `${en}中文`, price }));
const product = (productId: string, name: string, price: number, extra: Partial<DeveloperProduct> = {}): DeveloperProduct =>
  ({ productId, name, description: '', price, isForSale: true, isImmutable: false, regionalPricing: false, iconImageAssetId: null, ...extra });

test('list pages to the end, deduplicates and sorts by product ID', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ productId: 1000 - i, name: `P${i}`, price: 10, isForSale: true }));
  const { http, log } = cloud(many);
  const list = await listDeveloperProducts(http, '123');
  assert.equal(list.length, 120);
  assert.equal(log.length, 3);
  assert.deepEqual(list.slice(0, 2).map(p => p.productId), ['881', '882']);
});
test('list fails on a failed page or a repeated token instead of returning a partial list', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ productId: i + 1, name: `P${i}`, price: 10, isForSale: true }));
  await assert.rejects(listDeveloperProducts(cloud(many, { failPage: 2 }).http, '123'), (e: Error & { code: string }) => e.code === 'FORBIDDEN' && /page 2/.test(e.message));
  await assert.rejects(listDeveloperProducts(cloud(Array.from({ length: 150 }, (_, i) => ({ productId: i + 1, name: `P${i}`, price: 1, isForSale: true })), { repeatToken: true }).http, '123'), { code: 'INVALID_RESPONSE' });
});

test('table parser accepts { en, zh, price } rows and rejects bad tables', () => {
  assert.deepEqual(parseDeveloperProductSource('-- header\nreturn {\n\t{ en = "Example Boost", zh = "示例加成", price = 19 },\n\t{ price = 49; en = "Example Refill", zh = "" };\n}\n'),
    [{ en: 'Example Boost', zh: '示例加成', price: 19 }, { en: 'Example Refill', zh: '', price: 49 }]);
  for (const bad of [
    'return { { en = "A", zh = "甲", price = 1 }, { en = "A", zh = "乙", price = 2 } }',
    'return { { en = "", zh = "甲", price = 1 } }', 'return { { en = " A", zh = "甲", price = 1 } }',
    'return { { en = "A", zh = "甲", price = 0 } }', 'return { { en = "A", zh = "甲", price = 1.5 } }',
    'return { { en = "A", zh = "甲", price = "19" } }', 'return { { en = "A", zh = "甲", price = 1, id = 3 } }',
    'return { { en = "A", price = 1 } }', 'return { { en = "A", en = "B", zh = "甲", price = 1 } }', 'return {}',
  ]) assert.throws(() => parseDeveloperProductSource(bad), { code: 'ARGUMENT_ERROR' }, bad);
  const file = writeRbxm([{ className: 'ModuleScript', name: '开发者产品', source: 'return { { en = "A", zh = "甲", price = 5 } }', children: [] }]);
  assert.deepEqual(parseDeveloperProductTable(file), [{ en: 'A', zh: '甲', price: 5 }]);
});

test('plan: match by exact name, update only changed prices, reuse lowest-ID products not in the table, create the rest', () => {
  const plan = planUniverse('123', rows(['Keep', 19], ['Same', 49], ['New A', 99], ['New B', 199], ['New C', 5]), [
    product('30', 'Old Z', 1), product('10', 'Keep', 15), product('20', 'Same', 49), product('5', 'keep', 1, { isImmutable: true }),
  ]);
  assert.equal(plan.rejected, undefined);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.actions.map(a => [a.kind, a.name, a.productId ?? null, a.fromName ?? null, a.fromPrice ?? null, a.price]), [
    ['update', 'Keep', '10', null, 15, 19], ['reuse', 'New A', '30', 'Old Z', 1, 99], ['create', 'New B', null, null, null, 199], ['create', 'New C', null, null, null, 5],
  ]);
  assert.deepEqual(plan.immutable, [{ productId: '5', name: 'keep' }]);
  const spare = planUniverse('123', rows(['Keep', 15]), [product('10', 'Keep', 15), product('40', 'B', 1), product('30', 'A', 2)]);
  assert.deepEqual(spare.actions, []);
  assert.deepEqual(spare.idle.map(p => p.productId), ['30', '40']);
});
test('plan refuses a universe with duplicated product names', () => {
  const plan = planUniverse('123', rows(['A', 1]), [product('2', 'Dup', 1), product('1', 'Dup', 1), product('3', 'A', 1)]);
  assert.equal(plan.rejected?.code, 'DUPLICATE_PRODUCT_NAMES');
  assert.deepEqual(plan.rejected?.duplicates, [{ name: 'Dup', productIds: ['1', '2'] }]);
  assert.deepEqual(plan.actions, []);
});

test('sync without reuse writes immediately: price-only PATCH, create with defaults, readback verified', async () => {
  const fake = cloud([{ productId: 1, name: 'Keep', price: 15, isForSale: false }, { productId: 2, name: 'Same', price: 49, isForSale: true }]);
  const home = await mkdtemp(join(tmpdir(), 'rbx-dp-'));
  try {
    const result = await syncDeveloperProducts([{ universeId: '123', http: fake.http }], rows(['Keep', 19], ['Same', 49], ['Fresh', 99]), { backupDirectory: home });
    assert.equal(result.state, 'synced');
    const universe = result.universes[0]!;
    assert.deepEqual(universe.actions.map(a => ['state' in a ? a.state : '', a.kind, a.name]), [['verified', 'update', 'Keep'], ['verified', 'create', 'Fresh']]);
    assert.deepEqual(fake.writes().map(w => [w.method, w.fields]), [
      ['PATCH', { price: '19' }],
      ['POST', { name: 'Fresh', price: '99', isForSale: 'true', isRegionalPricingEnabled: 'false' }],
    ]);
    assert.equal(fake.products.get(1)!.isForSale, false, 'update touches only price');
    assert.equal((await readdir(home)).length, 1);
    assert.ok(universe.backupPath);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('sync with reuse writes nothing until confirmed with the matching token; stale tokens are refused', async () => {
  const fake = cloud([{ productId: 7, name: 'Retired', price: 3, isForSale: false, description: 'old' }, { productId: 8, name: 'Keep', price: 1, isForSale: true }]);
  const table = rows(['Keep', 2], ['Brand New', 799]);
  const target = [{ universeId: '123', http: fake.http }];
  const first = await syncDeveloperProducts(target, table);
  assert.equal(first.state, 'confirmation_required');
  assert.match(first.confirmToken!, /^[0-9a-f]{12}$/);
  assert.deepEqual(first.universes[0]!.actions.map(a => a.kind), ['update', 'reuse']);
  assert.equal(fake.writes().length, 0, 'even the price update waits for confirmation');

  const wrong = await syncDeveloperProducts(target, table, { confirm: 'ffffffffffff' });
  assert.equal(wrong.state, 'confirmation_required');
  assert.equal(wrong.stale, true);
  assert.equal(fake.writes().length, 0);

  const changed = await syncDeveloperProducts(target, rows(['Keep', 3], ['Brand New', 799]), { confirm: first.confirmToken });
  assert.equal(changed.stale, true);
  assert.notEqual(changed.confirmToken, first.confirmToken);
  assert.equal(fake.writes().length, 0);

  const done = await syncDeveloperProducts(target, table, { confirm: first.confirmToken });
  assert.equal(done.state, 'synced');
  assert.deepEqual(done.universes[0]!.actions.map(a => 'state' in a && a.state), ['verified', 'verified']);
  assert.deepEqual(fake.writes()[1]!.fields, { name: 'Brand New', description: '', price: '799', isForSale: 'true', isRegionalPricingEnabled: 'false' });
  assert.deepEqual({ ...fake.products.get(7)! }, { productId: 7, name: 'Brand New', price: 799, isForSale: true, description: '', regional: false });
});

test('a universe with an incomplete list or duplicate names is refused without writes', async () => {
  const broken = cloud(Array.from({ length: 60 }, (_, i) => ({ productId: i + 1, name: `P${i}`, price: 1, isForSale: true })), { failPage: 2 });
  const result = await syncDeveloperProducts([{ universeId: '123', http: broken.http }], rows(['New', 5]));
  assert.equal(result.state, 'synced');
  assert.equal(result.universes[0]!.rejected?.code, 'PRODUCT_LIST_INCOMPLETE');
  assert.equal(broken.writes().length, 0);
  const dup = cloud([{ productId: 1, name: 'Dup', price: 1, isForSale: true }, { productId: 2, name: 'Dup', price: 1, isForSale: true }]);
  const refused = await syncDeveloperProducts([{ universeId: '123', http: dup.http }], rows(['New', 5]));
  assert.equal(refused.universes[0]!.rejected?.code, 'DUPLICATE_PRODUCT_NAMES');
  assert.equal(dup.writes().length, 0);
});

test('failed and uncertain writes are reported, not retried, and later actions continue', async () => {
  const fake = cloud([{ productId: 1, name: 'A', price: 1, isForSale: true }, { productId: 2, name: 'B', price: 1, isForSale: true }], {
    failWrite: (method, name) => name === 'A' ? new Response(null, { status: 400 }) : method === 'POST' ? 'timeout' : undefined,
  });
  const result = await syncDeveloperProducts([{ universeId: '123', http: fake.http }], rows(['A', 2], ['B', 3], ['C', 4]));
  assert.deepEqual(result.universes[0]!.actions.map(a => 'state' in a && a.state), ['failed', 'verified', 'unverified']);
  assert.equal(fake.writes().length, 3);
});

const preload = `globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/creator')) return Response.json({ developerProducts: [
    { productId: 1, name: 'Old', description: '', iconImageAssetId: 0, universeId: 123, isForSale: true, isImmutable: false, priceInformation: { defaultPriceInRobux: 5, enabledFeatures: [] } },
    { productId: 2, name: 'Dup', description: '', iconImageAssetId: 0, universeId: 123, isForSale: true, isImmutable: false, priceInformation: { defaultPriceInRobux: 5, enabledFeatures: [] } },
  ], nextPageToken: '' });
  throw new Error('unexpected ' + init.method + ' ' + u.pathname);
};`;
function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve('dist/cli/main.js'), '--json', 'devproduct', ...args], {
    encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: 'fictional-key' }, timeout: 10000,
  });
}
test('CLI list emits all products; sync with reuse exits 6 with confirm token and agent instruction', async () => {
  const listed = cli(['list', '123']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.equal(JSON.parse(listed.stdout).data.count, 2);
  const dir = await mkdtemp(join(tmpdir(), 'rbx-dp-cli-'));
  try {
    const source = join(dir, '开发者产品.rbxm');
    await writeFile(source, writeRbxm([{ className: 'ModuleScript', name: '开发者产品', source: 'return { { en = "Dup", zh = "", price = 5 }, { en = "Brand New", zh = "新", price = 9 } }', children: [] }]));
    const result = cli(['sync', '123', '--source', source]);
    assert.equal(result.status, 6, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'confirmation_required');
    assert.match(out.data.confirmToken, /^[0-9a-f]{12}$/);
    assert.match(out.data.agentInstruction, /--confirm/);
    assert.equal(out.data.universes[0].actions[0].kind, 'reuse');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lagging readback is re-read with delays until it matches; writes are never repeated', async () => {
  const fake = cloud([{ productId: 1, name: 'Keep', price: 1, isForSale: true }], { staleReads: 2 });
  const waits: number[] = [];
  const result = await syncDeveloperProducts([{ universeId: '123', http: fake.http }], rows(['Keep', 2], ['Fresh', 3]), { sleep: async ms => { waits.push(ms); } });
  const actions = result.universes[0]!.actions as { state: string; readbacks?: number }[];
  assert.deepEqual(actions.map(a => [a.state, a.readbacks]), [['verified', 3], ['verified', 3]], 'stale price and a not-yet-visible (404) product both settle');
  assert.deepEqual(waits, [1000, 2000, 1000, 2000]);
  assert.equal(fake.writes().length, 2);
});
test('readback that never matches ends unverified after 5 reads without another write', async () => {
  const fake = cloud([{ productId: 1, name: 'Keep', price: 1, isForSale: true }], { staleReads: 99 });
  const waits: number[] = [];
  const result = await syncDeveloperProducts([{ universeId: '123', http: fake.http }], rows(['Keep', 2]), { sleep: async ms => { waits.push(ms); } });
  const action = result.universes[0]!.actions[0] as { state: string; readbacks?: number; error?: { message: string } };
  assert.equal(action.state, 'unverified');
  assert.equal(action.readbacks, 5);
  assert.match(action.error!.message, /after 5 reads/);
  assert.deepEqual(waits, [1000, 2000, 3000, 5000]);
  assert.equal(fake.writes().length, 1);
});
