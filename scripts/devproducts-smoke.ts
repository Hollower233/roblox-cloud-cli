import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, HttpClient, defaultHome, listDeveloperProducts, updateDeveloperProduct, type DeveloperProduct } from '../src/index.js';
import { id } from '../src/core/errors.js';
import { luaString } from '../src/localization/lua-table.js';
import { writeRbxm } from '../src/localization/rbxm.js';

// Explicit real write test against a development universe. Developer products cannot be deleted, so the
// test keeps at most one permanent product named "ZZ CLI Test ..." and reuses it on later runs.
const universeId = process.env.RBX_LIVE_DEVPRODUCTS_UNIVERSE;
if (!universeId) throw new Error('Set RBX_LIVE_DEVPRODUCTS_UNIVERSE explicitly to opt into live developer product writes.');
id(universeId);
const http = new HttpClient({ apiKey: await new CredentialStore(defaultHome()).get() });
const PREFIX = 'ZZ CLI Test';
const dir = await mkdtemp(join(tmpdir(), 'rbx-dp-smoke-'));

async function table(name: string, rows: { name: string; price: number }[]): Promise<string> {
  const path = join(dir, `${name}.rbxm`);
  const source = `return {\n${rows.map(r => `\t{ en = ${luaString(r.name)}, zh = "", price = ${r.price} },\n`).join('')}}\n`;
  await writeFile(path, writeRbxm([{ className: 'ModuleScript', name: '开发者产品', source, children: [] }]));
  return path;
}
function cli(args: string[]): { status: number | null; out: { status: string; data: any; warnings: unknown[] } } {
  const child = spawnSync(process.execPath, ['dist/cli/main.js', '--json', 'devproduct', ...args], { encoding: 'utf8', timeout: 600000 });
  if (child.error) throw child.error;
  return { status: child.status, out: JSON.parse(child.stdout) };
}
const rowsOf = (list: DeveloperProduct[]) => list.map(p => ({ name: p.name, price: p.price! }));
const states = (data: any) => data.universes[0].actions.map((a: { kind: string; state?: string }) => `${a.kind}:${a.state ?? '-'}`);

const before = await listDeveloperProducts(http, universeId);
const steps: Record<string, unknown> = {};
try {
  // 1. Full pagination is stable and matches the CLI.
  const listed = cli(['list', universeId]);
  assert.equal(listed.status, 0, JSON.stringify(listed.out));
  assert.equal(listed.out.data.count, before.length);
  assert.equal(new Set(before.map(p => p.name)).size, before.length, 'Universe has duplicate names; sync would refuse it.');
  assert.ok(before.every(p => p.price !== null), 'Every product needs a readable price for this test.');
  steps.listed = before.length;

  // 2. Price update and restore, applied immediately without confirmation.
  const target = before.find(p => !p.isImmutable && !p.name.startsWith(PREFIX)) ?? before[0]!;
  const bumped = rowsOf(before).map(r => r.name === target.name ? { ...r, price: r.price + 1 } : r);
  const update = cli(['sync', universeId, '--source', await table('update', bumped)]);
  assert.equal(update.status, 0, JSON.stringify(update.out));
  assert.deepEqual(states(update.out.data), ['update:verified']);
  const restore = cli(['sync', universeId, '--source', await table('restore', rowsOf(before))]);
  assert.equal(restore.status, 0, JSON.stringify(restore.out));
  assert.deepEqual(states(restore.out.data), ['update:verified']);
  steps.priceRoundTrip = target.name;

  // 3. Create the test product only when no earlier run left one behind.
  let leftover = before.find(p => p.name.startsWith(PREFIX));
  if (!leftover) {
    const name = `${PREFIX} ${Date.now()}`;
    const created = cli(['sync', universeId, '--source', await table('create', [...rowsOf(before), { name, price: 5 }])]);
    assert.equal(created.status, 0, JSON.stringify(created.out));
    assert.deepEqual(states(created.out.data), ['create:verified']);
    leftover = (await listDeveloperProducts(http, universeId)).find(p => p.name === name)!;
    steps.created = leftover.productId;
  }

  // 4. Reuse: the test product is the only one missing from the table, so it is renamed after confirmation.
  const current = await listDeveloperProducts(http, universeId);
  const reusedName = `${PREFIX} ${Date.now()} R`;
  const reuseRows = [...rowsOf(current.filter(p => p.productId !== leftover!.productId)), { name: reusedName, price: 6 }];
  const reuseTable = await table('reuse', reuseRows);
  const pending = cli(['sync', universeId, '--source', reuseTable]);
  assert.equal(pending.status, 6, JSON.stringify(pending.out));
  assert.equal(pending.out.status, 'confirmation_required');
  assert.deepEqual(states(pending.out.data), ['reuse:-']);
  const wrong = cli(['sync', universeId, '--source', reuseTable, '--confirm', '000000000000']);
  assert.equal(wrong.status, 6);
  assert.equal(wrong.out.data.stale, true);
  const changedTable = await table('reuse-changed', reuseRows.map(r => r.name === reusedName ? { ...r, price: 7 } : r));
  const stale = cli(['sync', universeId, '--source', changedTable, '--confirm', pending.out.data.confirmToken]);
  assert.equal(stale.status, 6);
  assert.equal(stale.out.data.stale, true);
  assert.equal((await listDeveloperProducts(http, universeId)).find(p => p.productId === leftover!.productId)?.name, leftover.name, 'Nothing written before confirmation');
  const confirmed = cli(['sync', universeId, '--source', reuseTable, '--confirm', pending.out.data.confirmToken]);
  assert.equal(confirmed.status, 0, JSON.stringify(confirmed.out));
  assert.deepEqual(states(confirmed.out.data), ['reuse:verified']);
  steps.reused = { productId: leftover.productId, from: leftover.name, to: reusedName };
} finally {
  // Restore every original price and take the test product off sale.
  const after = await listDeveloperProducts(http, universeId);
  for (const original of before) {
    const now = after.find(p => p.productId === original.productId);
    if (now && !now.name.startsWith(PREFIX) && now.price !== original.price) await updateDeveloperProduct(http, universeId, original.productId, { price: original.price! });
  }
  for (const test of after.filter(p => p.name.startsWith(PREFIX) && p.isForSale)) await updateDeveloperProduct(http, universeId, test.productId, { isForSale: false });
  await rm(dir, { recursive: true, force: true });
}
const final = await listDeveloperProducts(http, universeId);
for (const original of before.filter(p => !p.name.startsWith(PREFIX))) assert.equal(final.find(p => p.productId === original.productId)?.price, original.price);
assert.ok(final.filter(p => p.name.startsWith(PREFIX)).length <= 1, 'At most one permanent test product');
console.log(JSON.stringify({ success: true, universeId, steps, productCount: final.length }));
