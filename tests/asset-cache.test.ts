import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clearAssetCache } from '../src/cache/assets.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'rbx-cache-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const local = join(base, 'local'), temp = join(base, 'temp');
  await mkdir(join(local, 'Roblox', 'rbx-storage'), { recursive: true });
  await mkdir(join(temp, 'Roblox', 'sounds'), { recursive: true });
  await writeFile(join(local, 'Roblox', 'rbx-storage', 'asset'), 'fake');
  await writeFile(join(local, 'Roblox', 'rbx-storage.db'), 'fake database');
  await writeFile(join(local, 'Roblox', 'server.rbxl'), 'keep project');
  await writeFile(join(temp, 'Roblox', 'sounds', 'audio'), 'fake');
  return { local, temp, options: { platform: 'win32', env: { LOCALAPPDATA: local, TEMP: temp }, processes: async () => [] } };
}

test('clears only allowlisted caches, preserves project and supports repeated calls', async t => {
  const f = await fixture(t);
  const result = await clearAssetCache(f.options);
  assert.equal(result.status, 'success');
  assert.equal(result.targets.length, 8);
  assert.equal(await readFile(join(f.local, 'Roblox', 'server.rbxl'), 'utf8'), 'keep project');
  assert.ok((await clearAssetCache(f.options)).targets.every(t => t.status === 'absent'));
});

for (const [name, reason] of [['RobloxStudioBeta', 'STUDIO_RUNNING'], ['RobloxPlayerBeta', 'PLAYER_RUNNING']]) {
  test(`${reason} blocks before deleting any cache`, async t => {
    const f = await fixture(t);
    const result = await clearAssetCache({ ...f.options, processes: async () => [{ name: name!, pid: 123 }] });
    assert.equal(result.code, reason);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.targets, []);
    assert.equal(await readFile(join(f.local, 'Roblox', 'rbx-storage.db'), 'utf8'), 'fake database');
  });
}

test('failed process inspection fails closed', async t => {
  const f = await fixture(t);
  assert.equal((await clearAssetCache({ ...f.options, processes: async () => { throw Error(); } })).code, 'PROCESS_CHECK_FAILED');
  assert.equal(await readFile(join(f.local, 'Roblox', 'rbx-storage.db'), 'utf8'), 'fake database');
});

test('unsupported platform and missing roots are blocked', async () => {
  assert.equal((await clearAssetCache({ platform: 'linux' })).code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await clearAssetCache({ platform: 'win32', env: {} })).code, 'CACHE_PATH_UNAVAILABLE');
});

test('compiled cache command returns JSON without prompts or credentials', () => {
  const result = spawnSync(process.execPath, ['dist/cli/main.js', 'cache', 'clear'], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: '', TEMP: '', ROBLOX_API_KEY: '' }, timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.status, 'blocked');
  assert.equal(value.code, process.platform === 'win32' ? 'CACHE_PATH_UNAVAILABLE' : 'UNSUPPORTED_PLATFORM');
  assert.deepEqual(value.targets, []);
});

test('linked Roblox root blocks the entire operation', async t => {
  const f = await fixture(t);
  await rm(join(f.temp, 'Roblox'), { recursive: true });
  await symlink(join(f.local, 'Roblox'), join(f.temp, 'Roblox'), 'junction');
  assert.equal((await clearAssetCache(f.options)).code, 'CACHE_PATH_LINKED');
  assert.equal(await readFile(join(f.local, 'Roblox', 'rbx-storage.db'), 'utf8'), 'fake database');
});

test('linked cache target is retained and external data is preserved', async t => {
  const f = await fixture(t);
  const external = join(f.local, 'external');
  await mkdir(external);
  await writeFile(join(external, 'keep'), 'keep');
  await symlink(external, join(f.local, 'Roblox', 'rbx-storage-sc'), 'junction');
  const result = await clearAssetCache(f.options);
  assert.equal(result.status, 'partial');
  assert.ok(result.targets.some(t => t.code === 'CACHE_PATH_LINKED'));
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'keep');
});
