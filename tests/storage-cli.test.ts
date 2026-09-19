import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalStore } from '../src/storage/store.js';
import { CredentialStore } from '../src/auth/credentials.js';
import { savedCatalog, savedGame } from './fixtures/fake-api.js';
import { renderCatalog } from '../src/cli/output.js';

async function temporary(action: (home: string) => Promise<void>) { const home = await mkdtemp(join(tmpdir(), 'rbx-test-')); try { await action(home); } finally { await rm(home, { recursive: true, force: true }); } }
test('atomic cache persistence, account isolation and independent config', async () => temporary(async home => {
  const store = new LocalStore(home);
  await store.locked(async () => { await store.saveCatalog(savedCatalog()); await store.saveConfig({ schemaVersion: 1, currentUserId: '100', accounts: { '100': { manualIds: ['9'] } } }); });
  assert.equal((await store.catalog('100'))!.games.length, 1); assert.equal(await store.catalog('999'), null);
  assert.deepEqual((await store.config()).accounts['100']!.manualIds, ['9']);
  assert.deepEqual((await readdir(home)).sort(), ['catalog-100.json', 'config.json']);
}));
test('lock blocks concurrent writes and releases on failure', async () => temporary(async home => {
  const store = new LocalStore(home);
  await assert.rejects(store.locked(async () => { await assert.rejects(store.locked(async () => {}), { code: 'STORAGE_LOCKED' }); throw new Error('fixture failure'); }));
  await store.locked(async () => {}); assert.ok(!(await readdir(home)).includes('.write.lock'));
}));
test('invalid or future cache files are not silently overwritten', async () => temporary(async home => {
  const store = new LocalStore(home);
  await writeFile(join(home, 'catalog-100.json'), '{bad'); await assert.rejects(store.catalog('100'), { code: 'STORAGE_ERROR' });
  await writeFile(join(home, 'catalog-100.json'), '{"schemaVersion":999}'); await assert.rejects(store.catalog('100'), { code: 'CACHE_VERSION' });
  await assert.rejects(store.catalog('../100'), { code: 'ARGUMENT_ERROR' });
}));
test('Windows persistent credential is DPAPI-encrypted and round-trips', { skip: process.platform !== 'win32' }, async () => temporary(async home => {
  const old = process.env.ROBLOX_API_KEY; delete process.env.ROBLOX_API_KEY;
  try {
    const credentials = new CredentialStore(home); await credentials.set('fixture-not-a-real-key');
    assert.ok(!(await readFile(join(home, 'credential.dpapi'), 'utf8')).includes('fixture-not-a-real-key'));
    assert.equal(await credentials.get(), 'fixture-not-a-real-key');
    process.env.ROBLOX_API_KEY = 'environment-fixture'; assert.equal(await credentials.get(), 'environment-fixture');
    delete process.env.ROBLOX_API_KEY; await credentials.clear(); await assert.rejects(credentials.get(), { code: 'AUTH_REQUIRED' });
  } finally { if (old === undefined) delete process.env.ROBLOX_API_KEY; else process.env.ROBLOX_API_KEY = old; }
}));
test('compiled CLI list works offline with no key and stdout contains only JSON', async () => temporary(async home => {
  const store = new LocalStore(home), catalog = savedCatalog();
  catalog.warnings = [{ code: 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE', message: 'fixture gap' }];
  await store.saveCatalog(catalog); await store.saveConfig({ schemaVersion: 1, currentUserId: '100', accounts: { '100': { manualIds: [] } } });
  const env = { ...process.env }; delete env.ROBLOX_API_KEY;
  const child = spawnSync(process.execPath, [resolve('dist/cli/main.js'), 'universe', 'list', '--home', home, '--json', '--owner', 'Studio'], { env, encoding: 'utf8' });
  assert.equal(child.status, 3, child.stderr); assert.equal(child.stderr, '');
  const data = JSON.parse(child.stdout); assert.equal(data.status, 'partial'); assert.equal(data.data.games[0].ccu, 42);
}));
test('CLI invalid arguments and missing auth return stable errors without echoing secrets', async () => temporary(async home => {
  const env = { ...process.env }; delete env.ROBLOX_API_KEY;
  for (const [args, status, code] of [[['auth', 'status'], 4, 'AUTH_REQUIRED'], [['universe', 'add', '../9'], 2, 'ARGUMENT_ERROR'], [['--fictional-secret-value'], 2, 'ARGUMENT_ERROR']] as const) {
    const child = spawnSync(process.execPath, [resolve('dist/cli/main.js'), ...args, '--home', home, '--json'], { env, encoding: 'utf8' });
    assert.equal(child.status, status, child.stderr); assert.equal(JSON.parse(child.stdout).error.code, code); assert.ok(!child.stdout.includes('fictional-secret-value'));
  }
}));
test('terminal game names cannot inject ANSI controls', () => {
  const game = savedGame(); game.name = '\u001b[2JBad\nName';
  const output = renderCatalog(savedCatalog([game]), [game]); assert.ok(!output.includes('\u001b')); assert.ok(output.includes('Bad Name'));
});

test('profile clear CLI validates arguments before authentication and exposes preview', async () => temporary(async home => {
  const env = { ...process.env }; delete env.ROBLOX_API_KEY;
  for (const [args, code] of [
    [['profile', 'clear', '123'], 'ARGUMENT_ERROR'],
    [['profile', 'clear', '123', '--players', '42', '--preset', 'unknown'], 'ARGUMENT_ERROR'],
    [['profile', 'clear', '123', '--players', '42', '--dry-run'], 'AUTH_REQUIRED'],
  ] as const) {
    const child = spawnSync(process.execPath, [resolve('dist/cli/main.js'), ...args, '--home', home, '--json'], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(child.stdout).error.code, code, child.stderr);
  }
  const help = spawnSync(process.execPath, [resolve('dist/cli/main.js'), 'profile', 'clear', '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--dry-run/); assert.match(help.stdout, /--players/);
}));
