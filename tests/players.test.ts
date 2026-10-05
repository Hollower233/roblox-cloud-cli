import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LocalStore } from '../src/storage/store.js';
import { PlayerCatalogService, findPlayers } from '../src/players/catalog.js';
import { resolveProfilePlayers } from '../src/profiles/copy.js';
import { HttpClient } from '../src/transport/http-client.js';

const saved = [
  { userId: '123', name: 'ExampleFries', alias: '水木' },
  { userId: '456', name: 'ExampleCaptain', alias: '船长' },
];
async function temporary(action: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'rbx-players-'));
  try { await action(home); } finally { await rm(home, { recursive: true, force: true }); }
}
const offline = () => new HttpClient({ fetch: async () => { throw new Error('Unexpected network request'); }, retries: 0 });

test('catalog persists across instances and accounts; UID updates preserve optional alias', async () => temporary(async home => {
  const local = new LocalStore(home), service = new PlayerCatalogService(local);
  assert.deepEqual(await service.list(), []);
  await service.add(saved[0]!, '水木');
  await service.add(saved[1]!, '船长');
  await service.add({ userId: '123', name: 'RenamedFries' });
  await local.saveConfig({ schemaVersion: 1, currentUserId: '999', accounts: {} });
  const next = new PlayerCatalogService(new LocalStore(home));
  assert.equal((await next.list()).length, 2);
  assert.deepEqual(await next.find('水木'), [{ userId: '123', name: 'RenamedFries', alias: '水木' }]);
  await next.alias('fries', '测试号');
  assert.equal((await next.find('测试号'))[0]!.userId, '123');
  await next.remove('CAPTAIN');
  assert.equal((await next.list()).length, 1);
}));

test('matching prioritizes exact name/alias, supports UID, and fragments only match usernames', () => {
  const players = [...saved, { userId: '789', name: 'Fries', alias: '木' }];
  assert.equal(findPlayers('FRIES', players)[0]!.userId, '789');
  assert.equal(findPlayers('example', players).length, 2);
  assert.equal(findPlayers('水', players).length, 0);
  assert.equal(findPlayers('123', players)[0]!.name, 'ExampleFries');
});

test('profile resolver uses local aliases/fragments/IDs, deduplicates, and does not call network', async () => {
  assert.deepEqual(await resolveProfilePlayers('FRIES,水木,123,船长,999', offline(), saved), [
    { userId: '123', name: 'ExampleFries' }, { userId: '456', name: 'ExampleCaptain' }, { userId: '999', name: '999' },
  ]);
  await assert.rejects(resolveProfilePlayers('example', offline(), saved), /Candidates: ExampleFries \(123\).*ExampleCaptain \(456\)/);
  await assert.rejects(resolveProfilePlayers('未知', offline(), saved), { code: 'ARGUMENT_ERROR' });
});

test('unknown usernames retain online lookup without saving; invalid responses fail', async () => temporary(async home => {
  let calls = 0;
  const http = new HttpClient({ intervalMs: 0, retries: 0, fetch: async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://users.roblox.com/v1/usernames/users');
    assert.deepEqual(JSON.parse(options!.body as string), { usernames: ['newexample'], excludeBannedUsers: false });
    return Response.json({ data: [{ requestedUsername: 'newexample', name: 'NewExample', id: 789 }] });
  } });
  const result = await resolveProfilePlayers('水木,NewExample', http, saved);
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ userId: '123', name: 'ExampleFries' }, { userId: '789', name: 'NewExample' }]);
  const service = new PlayerCatalogService(new LocalStore(home));
  assert.deepEqual(await service.list(), []);
  await service.add(result[1]!, '新玩家');
  assert.deepEqual(await service.list(), [{ userId: '789', name: 'NewExample', alias: '新玩家' }]);
  const invalid = new HttpClient({ fetch: async () => Response.json({ data: [{ requestedUsername: 'newexample', name: 'Wrong', id: -1 }] }) });
  await assert.rejects(resolveProfilePlayers('NewExample', invalid), { code: 'INVALID_RESPONSE' });
}));

test('ambiguous names/aliases prevent profile operations and catalog mutations', async () => temporary(async home => {
  const store = new LocalStore(home), service = new PlayerCatalogService(store);
  await service.add(saved[0]!, '共同');
  await service.add(saved[1]!, '共同');
  const before = await readFile(join(home, 'players.json'), 'utf8');
  await assert.rejects(resolveProfilePlayers('共同', offline(), await service.list()), /Ambiguous player/);
  await assert.rejects(service.remove('共同'), /Ambiguous player/);
  await assert.rejects(service.alias('example', '新别名'), /Ambiguous player/);
  assert.equal(await readFile(join(home, 'players.json'), 'utf8'), before);
  await service.remove('123');
  assert.equal((await service.list()).length, 1);
}));

test('corrupt/future catalogs, duplicates, invalid aliases and locks cannot lose saved data', async () => temporary(async home => {
  const store = new LocalStore(home), service = new PlayerCatalogService(store);
  for (const [contents, code] of [
    ['{bad', 'STORAGE_ERROR'], ['null', 'STORAGE_ERROR'],
    ['{"schemaVersion":99}', 'CACHE_VERSION'],
    [JSON.stringify({ schemaVersion: 1, players: [saved[0], saved[0]] }), 'STORAGE_ERROR'],
    [JSON.stringify({ schemaVersion: 1, players: [{ ...saved[0], userId: '../123' }] }), 'STORAGE_ERROR'],
  ]) {
    await writeFile(join(home, 'players.json'), contents!);
    await assert.rejects(service.add(saved[1]!), { code });
    assert.equal(await readFile(join(home, 'players.json'), 'utf8'), contents);
  }
  await writeFile(join(home, 'players.json'), JSON.stringify({ schemaVersion: 1, players: saved }));
  for (const alias of ['', '123', 'a,b', 'bad\nname']) await assert.rejects(service.alias('123', alias), { code: 'ARGUMENT_ERROR' });
  await store.locked(async () => { await assert.rejects(service.remove('123'), { code: 'STORAGE_LOCKED' }); });
  assert.equal((await service.list()).length, 2);
}));

test('compiled player CLI supports offline JSON list/find/alias/remove without credentials', async () => temporary(async home => {
  await new LocalStore(home).savePlayers({ schemaVersion: 1, players: saved });
  const env = { ...process.env }; delete env.ROBLOX_API_KEY;
  const run = (...args: string[]) => {
    const child = spawnSync(process.execPath, [resolve('dist/cli/main.js'), 'player', ...args, '--home', home, '--json'], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout).data;
  };
  assert.equal(run('list').players.length, 2);
  assert.equal(run('find', 'FRIES').players[0].userId, '123');
  assert.equal(run('alias', '水木', '测试号').player.alias, '测试号');
  assert.equal(run('remove', '测试号').removed.userId, '123');
  assert.equal(run('list').players.length, 1);
}));

test('compiled add queries username without credentials and persists canonical username and UID', async () => temporary(async home => {
  const mock = join(home, 'fake-fetch.mjs');
  await writeFile(mock, `globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://users.roblox.com/v1/usernames/users') throw new Error('Unexpected URL');
    if (new Headers(options.headers).has('x-api-key')) throw new Error('Unexpected credential');
    if (JSON.parse(options.body).usernames[0] !== 'examplefries') throw new Error('Unexpected username');
    return Response.json({ data: [{ requestedUsername: 'examplefries', name: 'ExampleFries', id: 123 }] });
  };`);
  const env = { ...process.env }; delete env.ROBLOX_API_KEY;
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve('dist/cli/main.js'), 'player', 'add', 'examplefries', '--alias', '水木', '--home', home, '--json'], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).data.player, saved[0]);
  assert.deepEqual((await new LocalStore(home).players()).players, [saved[0]]);
}));

test('existing ban preview accepts saved aliases and stops on ambiguous fragments offline', async () => temporary(async home => {
  await new LocalStore(home).savePlayers({ schemaVersion: 1, players: saved });
  const mock = join(home, 'no-network.mjs');
  await writeFile(mock, "globalThis.fetch = async () => { process.exit(90); };");
  const run = (player: string) => spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, resolve('dist/cli/main.js'), 'ban', '999', '--player', player, '--duration', '30m', '--reason', 'fixture', '--dry-run', '--home', home, '--json'], { env: { ...process.env, ROBLOX_API_KEY: 'fake-offline-key' }, encoding: 'utf8' });
  const success = run('水木');
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.deepEqual(JSON.parse(success.stdout).data.player, { userId: '123', name: 'ExampleFries' });
  const ambiguous = run('example');
  assert.equal(ambiguous.status, 2);
  assert.match(JSON.parse(ambiguous.stdout).error.message, /Candidates: ExampleFries \(123\).*ExampleCaptain \(456\)/);
}));
