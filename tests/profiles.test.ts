import test from 'node:test';
import assert from 'node:assert/strict';
import { copyProfiles, resolveProfilePlayers, resolveProfileUniverse } from '../src/profiles/copy.js';
import { HttpClient } from '../src/transport/http-client.js';
import type { EntryAddress } from '../src/datastores/entries.js';
import { AppError } from '../src/core/errors.js';

test('universe resolution accepts IDs and exact names but rejects ambiguous or missing names', () => {
  const games = [{ name: 'Example Game', universeId: '123' }, { name: 'Duplicate', universeId: '456' }, { name: 'Duplicate', universeId: '789' }];
  assert.equal(resolveProfileUniverse('123'), '123');
  assert.equal(resolveProfileUniverse(' example game ', games), '123');
  assert.throws(() => resolveProfileUniverse('Example', games), /not found/);
  assert.throws(() => resolveProfileUniverse('duplicate', games), /Ambiguous/);
  assert.throws(() => resolveProfileUniverse('0'), /positive safe/);
});

test('username lookup sends no API key and deduplicates names and IDs', async () => {
  let calls = 0;
  const http = new HttpClient({ apiKey: 'fake-secret', intervalMs: 0, fetch: (async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://users.roblox.com/v1/usernames/users');
    assert.equal(new Headers(init?.headers).get('x-api-key'), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { usernames: ['example_user'], excludeBannedUsers: false });
    return Response.json({ data: [{ requestedUsername: 'example_user', name: 'Example_User', id: 123 }] });
  }) as typeof fetch });
  const players = await resolveProfilePlayers('Example_User,example_user,123', http);
  assert.equal(players.length, 1);
  assert.equal(players[0]?.userId, '123');
  assert.equal(calls, 1);
  await assert.rejects(http.request('https://users.roblox.com/v1/usernames/users', { auth: true }), /only be sent/);
});

test('missing or malformed username results and invalid input fail before copying', async () => {
  for (const response of [{ data: [] }, { data: [{ requestedUsername: 'example', name: 'Example', id: '123' }] }, null]) {
    const http = new HttpClient({ intervalMs: 0, fetch: (async () => Response.json(response)) as typeof fetch });
    await assert.rejects(resolveProfilePlayers('Example', http));
  }
  const http = new HttpClient({ fetch: (async () => { throw new Error('Unexpected network call'); }) as typeof fetch });
  for (const input of ['', 'Example,', 'has space', '0', '9007199254740992']) await assert.rejects(resolveProfilePlayers(input, http));
  assert.deepEqual(await resolveProfilePlayers('123,456', http), [{ userId: '123', name: '123' }, { userId: '456', name: '456' }]);
});

test('batch copies use uppercase preset, preserve receipts and continue after individual failures', async () => {
  const keys: string[] = [];
  const entries = { copy: async (source: EntryAddress, target: EntryAddress, backup: string) => {
    keys.push(source.key);
    assert.deepEqual(source, { universeId: '123', datastore: 'Default', scope: 'global', key: source.key });
    assert.deepEqual(target, { ...source, universeId: '456' });
    assert.equal(backup, 'backups');
    if (source.key === 'PLAYER_1') throw new AppError('HTTP_ERROR', 'HTTP 409. Backup: backups/old.json. A write may have occurred.', 409);
    return { source, target, sourceVersion: 'v1', targetVersion: 'v2', bytes: 20, sha256: 'fake-hash', verified: true, backupPath: 'backups/new.json' };
  } };
  const players = [{ userId: '1', name: 'ExampleOne' }, { userId: '2', name: 'ExampleTwo' }];
  const result = await copyProfiles(entries, '123', '456', [...players, players[1]!], 'backups');
  assert.deepEqual(keys, ['PLAYER_1', 'PLAYER_2']);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const failed = result.results[0]!;
  assert.equal(failed.status, 'error');
  if (failed.status !== 'error') throw new Error('Expected failure');
  assert.equal(failed.error.httpStatus, 409);
  assert.match(failed.error.message, /Backup:/);
  const success = result.results[1]!;
  assert.equal(success.status, 'success');
  if (success.status !== 'success') throw new Error('Expected success');
  assert.equal(success.result.backupPath, 'backups/new.json');
  await assert.rejects(copyProfiles(entries, '123', '123', players, 'backups'), /must differ/);
  await assert.rejects(copyProfiles(entries, '123', '456', [{ userId: '0', name: 'invalid' }], 'backups'));
  assert.equal(keys.length, 2);
});

test('cancellation preserves completed receipts and skips remaining players', async () => {
  const abort = new AbortController();
  let calls = 0;
  const entries = { copy: async (source: EntryAddress, target: EntryAddress) => {
    calls++; abort.abort();
    return { source, target, sourceVersion: 'v1', targetVersion: 'v2', bytes: 2, sha256: 'fake', verified: true, backupPath: 'backup.json' };
  } };
  const result = await copyProfiles(entries, '123', '456', [1, 2, 3].map(value => ({ userId: String(value), name: `Example${value}` })), 'backups', abort.signal);
  assert.equal(calls, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  const cancelled = result.results[1]!;
  assert.equal(cancelled.status, 'error');
  if (cancelled.status !== 'error') throw new Error('Expected cancellation');
  assert.equal(cancelled.error.code, 'CANCELLED');
});

test('copying to another player rewrites target key and userIds', async () => {
  const calls: unknown[] = [];
  const entries = { copy: async (source: EntryAddress, target: EntryAddress, _dir: string, options?: { userIds?: string }) => {
    calls.push([source.key, target.key, options?.userIds]);
    return { source, target, sourceVersion: 'v1', targetVersion: 'v2', bytes: 2, sha256: 'fake', verified: true, backupPath: 'b.json' };
  } };
  const from = { userId: '1', name: 'ExampleFrom' }, to = { userId: '2', name: 'ExampleTo' };
  const result = await copyProfiles(entries, '123', '123', [from], 'backups', undefined, to);
  assert.deepEqual(calls, [['PLAYER_1', 'PLAYER_2', '[2]']]);
  assert.equal(result.succeeded, 1);
  await assert.rejects(copyProfiles(entries, '123', '456', [from, to], 'backups', undefined, to), /exactly one/);
  await assert.rejects(copyProfiles(entries, '123', '123', [from], 'backups', undefined, from), /must differ/);
});
