import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAssetImage, parseAssetId } from '../src/assets/download.js';
import { HttpClient } from '../src/transport/http-client.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function client(location = 'https://c0.rbxcdn.com/test', status = 200) {
  return new HttpClient({ apiKey: 'fake-key', intervalMs: 0, retries: 0, fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fake-key');
    return Response.json({ location }, { status });
  } });
}
test('asset IDs accept numeric IDs and rbxassetid URIs; reject invalid inputs', () => {
  assert.equal(parseAssetId(' rbxassetid://123 '), '123');
  for (const input of ['0', '-1', '1e5', '../123', '9007199254740992', 'https://evil.com/123']) assert.throws(() => parseAssetId(input));
});
test('download preserves bytes, reports dimensions, and refuses overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-download-'));
  try {
    const output = join(dir, 'image.png');
    const options = { output, fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('x-api-key'), null);
      assert.equal(init?.redirect, 'error');
      return new Response(png);
    }) as typeof fetch };
    const result = await downloadAssetImage(client('https://contentdelivery.roblox.com/v1/bytes/test'), 'rbxassetid://123', options);
    assert.equal(result.width, 1); assert.equal(result.height, 1);
    assert.deepEqual(await readFile(output), png);
    await assert.rejects(downloadAssetImage(client(), '123', options), /already exists/);
    assert.deepEqual(await readFile(output), png);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('resolves XML Decal texture to delivered image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-download-'));
  let calls = 0;
  try {
    const result = await downloadAssetImage(client(), '123', { output: join(dir, 'image.png'), fetch: async () => ++calls === 1
      ? new Response('<roblox><Item class="Decal"><Properties><Content name="Texture"><url>http://www.roblox.com/asset/?id=456</url></Content></Properties></Item></roblox>')
      : new Response(png) });
    assert.equal(result.imageAssetId, '456'); assert.equal(calls, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('rejects CDN destination injection and reports forbidden access', async () => {
  for (const url of ['https://rbxcdn.com.evil.com/a', 'https://contentdelivery.roblox.com.evil.com/a', 'http://c0.rbxcdn.com/a', 'https://secret@c0.rbxcdn.com/a']) {
    await assert.rejects(downloadAssetImage(client(url), '123', { fetch: async () => { assert.fail('must not fetch'); } }), /CDN destination/);
  }
  await assert.rejects(downloadAssetImage(client(undefined, 403), '123'), /legacy-asset:manage/);
});
test('rejects non-image bodies and cyclic Decals', async () => {
  await assert.rejects(downloadAssetImage(client(), '123', { fetch: async () => new Response('<html>error</html>') }), /not a supported/);
  await assert.rejects(downloadAssetImage(client(), '123', { fetch: async () => new Response('<roblox><Content name="Texture"><url>rbxassetid://123</url></Content></roblox>') }), /Cyclic/);
});
