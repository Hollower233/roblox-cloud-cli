import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { HttpClient, uploadDeveloperProductIcon } from '../src/index.js';

async function setup(run: (dir: string, image: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-product-icon-'));
  try {
    const image = join(dir, 'input.png');
    await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#ffcc0080' } }).png().toFile(image);
    await run(dir, image);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function cloud(options: { stale?: number; failure?: number | 'timeout'; immutable?: boolean } = {}) {
  let writes = 0, reads = 0;
  const bodies: FormData[] = [];
  const http = new HttpClient({ apiKey: 'fictional', intervalMs: 0, fetch: async (url, init) => {
    assert.match(String(url), /\/universes\/123\/developer-products\/456/);
    if (init?.method === 'PATCH') {
      writes++;
      bodies.push(init.body as FormData);
      if (options.failure === 'timeout') throw new DOMException('timeout', 'TimeoutError');
      return new Response(null, { status: options.failure ?? 204 });
    }
    reads++;
    return Response.json({ productId: 456, universeId: 123, name: 'Coin boost', isForSale: true,
      isImmutable: options.immutable, priceInformation: { defaultPriceInRobux: 15 },
      iconImageAssetId: writes && reads > (options.stale ?? 0) + 1 ? 999 : 111 });
  } });
  return { http, bodies, counts: () => ({ writes, reads }) };
}
test('icon sends only imageFile, normalizes without cropping, backs up before state and polls stale reads', async () => setup(async (dir, image) => {
  const fake = cloud({ stale: 2 }), waits: number[] = [];
  const result = await uploadDeveloperProductIcon(fake.http, '123', '456', image, { backupDirectory: join(dir, 'backup'), sleep: async ms => { waits.push(ms); } });
  assert.equal(result.state, 'verified');
  assert.equal(result.readback?.iconImageAssetId, '999');
  assert.deepEqual(fake.counts(), { writes: 1, reads: 4 });
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual([...fake.bodies[0]!.keys()], ['imageFile']);
  const file = fake.bodies[0]!.get('imageFile') as File;
  assert.equal(file.type, 'image/png');
  const png = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 512); assert.equal(metadata.height, 384); assert.equal(metadata.hasAlpha, true);
  assert.deepEqual(await readFile(`${result.backupPath}.png`), png);
  assert.equal(JSON.parse(await readFile(result.backupPath!, 'utf8')).before.iconImageAssetId, '111');
}));
test('dry run validates with no upload or backup; invalid image and immutable product never write', async () => setup(async (dir, image) => {
  const fake = cloud();
  assert.equal((await uploadDeveloperProductIcon(fake.http, '123', '456', image, { backupDirectory: join(dir, 'backup'), dryRun: true })).state, 'planned');
  assert.equal(fake.counts().writes, 0);
  assert.deepEqual(await readdir(dir), ['input.png']);
  const immutable = cloud({ immutable: true });
  await assert.rejects(uploadDeveloperProductIcon(immutable.http, '123', '456', image, { backupDirectory: dir }), { code: 'ARGUMENT_ERROR' });
  assert.equal(immutable.counts().writes, 0);
  await writeFile(image, 'invalid');
  await assert.rejects(uploadDeveloperProductIcon(fake.http, '123', '456', image, { backupDirectory: dir }), { code: 'ARGUMENT_ERROR' });
}));
test('unchanged ID and lost write response stay unverified; writes never retry', async () => setup(async (dir, image) => {
  for (const options of [{ stale: 99 }, { failure: 'timeout' as const }]) {
    const fake = cloud(options);
    const result = await uploadDeveloperProductIcon(fake.http, '123', '456', image, { backupDirectory: dir, sleep: async () => {} });
    assert.equal(result.state, 'unverified'); assert.equal(fake.counts().writes, 1);
  }
  const denied = cloud({ failure: 403 });
  await assert.rejects(uploadDeveloperProductIcon(denied.http, '123', '456', image, { backupDirectory: dir }), { code: 'FORBIDDEN' });
  assert.equal(denied.counts().writes, 1);
}));
test('backup failure prevents upload', async () => setup(async (dir, image) => {
  const fake = cloud();
  await assert.rejects(uploadDeveloperProductIcon(fake.http, '123', '456', image, { backupDirectory: image }), { code: 'STORAGE_ERROR' });
  assert.equal(fake.counts().writes, 0);
}));
