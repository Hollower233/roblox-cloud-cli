import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStoreEntries } from '../src/datastores/entries.js';
import { HttpClient } from '../src/transport/http-client.js';
import { clearProfiles } from '../src/profiles/clear.js';
import { AppError } from '../src/core/errors.js';

const target = { universeId: '123', datastore: 'Default', scope: 'global', key: 'PLAYER_42' };
const raw = '{"Data":{"Coins":9007199254740993},"MetaData":{"ActiveSession":null}}';
const entry = (value = raw, version = 'v1') => new Response(value, { headers: {
  'roblox-entry-version': version, 'roblox-entry-attributes': '{"tag":1}', 'roblox-entry-userids': '[42]',
} });
async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-clear-test-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('clear backs up exact bytes and metadata before DELETE, accepts 204 and verifies absence', () => temporary(async directory => {
  let calls = 0;
  const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('entryKey'), target.key);
    assert.equal(url.searchParams.get('scope'), 'global');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fake');
    calls++;
    if (calls <= 2) { assert.equal(init?.method, 'GET'); return entry(); }
    if (calls === 3) {
      assert.equal(init?.method, 'DELETE');
      assert.equal(url.searchParams.has('matchVersion'), false);
      const backup = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'));
      assert.deepEqual(backup.target, target);
      assert.equal(backup.targetSnapshot.raw, raw);
      assert.equal(backup.targetSnapshot.version, 'v1');
      assert.equal(backup.targetSnapshot.attributes, '{"tag":1}');
      assert.equal(backup.targetSnapshot.userIds, '[42]');
      return new Response(null, { status: 204 });
    }
    assert.equal(init?.method, 'GET');
    return new Response(null, { status: 404 });
  }) as typeof fetch }));
  const result = await api.clear(target, directory, { requireReleasedProfile: true });
  assert.equal(result.outcome, 'cleared'); assert.equal(result.verified, true); assert.equal(calls, 4);
}));

test('missing, preview, locked and denied profiles never delete or write backups', () => temporary(async directory => {
  for (const mode of ['missing', 'preview', 'active', 'force', 'denied']) {
    let calls = 0;
    const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (_input, init) => {
      calls++; assert.equal(init?.method, 'GET');
      if (mode === 'missing' || mode === 'denied') return new Response(null, { status: mode === 'missing' ? 404 : 403 });
      return mode === 'preview' ? entry() : entry(JSON.stringify({ MetaData: { [mode === 'active' ? 'ActiveSession' : 'ForceLoadSession']: [1, 'job'] } }));
    }) as typeof fetch }));
    const action = api.clear(target, directory, { dryRun: mode === 'preview', requireReleasedProfile: true });
    if (mode === 'missing' || mode === 'preview') assert.equal((await action).outcome, mode === 'missing' ? 'missing' : 'would-clear');
    else await assert.rejects(action);
    assert.equal(calls, 1); assert.deepEqual(await readdir(directory), []);
  }
}));

test('failed backups and changes after backup prevent deletion', () => temporary(async directory => {
  const blockedPath = join(directory, 'file'); await writeFile(blockedPath, 'fixture');
  for (const mode of ['backup', 'changed']) {
    let calls = 0;
    const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (_input, init) => {
      assert.equal(init?.method, 'GET'); calls++; return entry(raw, calls === 1 ? 'v1' : 'v2');
    }) as typeof fetch }));
    await assert.rejects(api.clear(target, mode === 'backup' ? blockedPath : directory), mode === 'backup' ? /no delete attempted/ : /changed after backup/);
    assert.equal(calls, mode === 'backup' ? 1 : 2);
  }
}));

test('DELETE errors are never retried; failed readback retains backup and reports uncertain deletion', () => temporary(async directory => {
  for (const mode of ['http', 'network', 'recreated']) {
    let deletes = 0;
    const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (_input, init) => {
      if (init?.method !== 'DELETE') return entry();
      deletes++;
      if (mode === 'network') throw new Error('network');
      return new Response(null, { status: mode === 'http' ? 503 : 204 });
    }) as typeof fetch }));
    await assert.rejects(api.clear(target, directory), /Backup:.*A delete may have occurred/);
    assert.equal(deletes, 1);
  }
  assert.equal((await readdir(directory)).length, 3);
}));

test('batch clear deduplicates, uses preset, preserves individual failures and supports cancellation', async () => {
  const players = [1, 2, 2, 3].map(n => ({ userId: String(n), name: `Example${n}` }));
  const keys: string[] = [];
  const entries = { clear: async (address: typeof target, directory: string, options: { dryRun?: boolean; requireReleasedProfile?: boolean } = {}) => {
    keys.push(address.key);
    assert.equal(address.datastore, 'Default'); assert.equal(address.scope, 'global');
    assert.equal(directory, 'backups'); assert.equal(options.requireReleasedProfile, true); assert.equal(options.dryRun, true);
    if (address.key === 'PLAYER_2') throw new AppError('FORBIDDEN', 'denied');
    return { target: address, previousVersion: null, bytes: 0, outcome: 'missing' as const, verified: true, backupPath: null };
  } };
  const result = await clearProfiles(entries, '123', players, 'backups', { dryRun: true });
  assert.deepEqual(keys, ['PLAYER_1', 'PLAYER_2', 'PLAYER_3']);
  assert.equal(result.succeeded, 2); assert.equal(result.failed, 1);
  await assert.rejects(clearProfiles(entries, '123', [...players, { userId: '0', name: 'bad' }], 'backups'));
  assert.equal(keys.length, 3);
  const signal = AbortSignal.abort();
  const cancelled = await clearProfiles(entries, '123', players, 'backups', { signal });
  assert.equal(cancelled.failed, 1); assert.equal(cancelled.skipped, 2); assert.equal(keys.length, 3);
});
