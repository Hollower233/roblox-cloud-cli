import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DataStoreEntries } from '../src/datastores/entries.js';
import { HttpClient } from '../src/transport/http-client.js';

const source = { universeId: '123', datastore: 'cloud & config', key: 'config/中文', scope: 'global' };
const target = { ...source, universeId: '456' };
const raw = '{"large":9007199254740993,"text":"中文"}';
function entry(value: string, version: string) { return new Response(value, { headers: { 'roblox-entry-version': version } }); }
test('copy preserves raw JSON, backs up before writing, matches target version and verifies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-datastore-test-'));
  let calls = 0;
  const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('datastoreName'), source.datastore);
    assert.equal(url.searchParams.get('entryKey'), source.key);
    calls++;
    if (calls === 1) return entry(raw, 'source-v1');
    if (calls === 2) return entry('false', 'target-v1');
    if (calls === 3) {
      assert.equal(init?.method, 'POST');
      assert.equal(init.body, raw);
      assert.equal(url.searchParams.get('matchVersion'), 'target-v1');
      assert.equal(new Headers(init.headers).get('content-md5'), createHash('md5').update(raw).digest('base64'));
      const { readdir } = await import('node:fs/promises');
      const backup = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'));
      assert.equal(backup.targetSnapshot.raw, 'false');
      assert.equal(backup.sourceSnapshot.raw, raw);
      return Response.json({ version: 'target-v2' });
    }
    return entry(raw, 'target-v2');
  }) as typeof fetch }));
  try { const result = await api.copy(source, target, directory); assert.equal(result.verified, true); assert.equal(calls, 4); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('missing target uses exclusive create; rejected writes are never retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-datastore-test-'));
  let calls = 0;
  const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    calls++;
    if (calls === 1) return entry('"string value"', 'v1');
    if (calls === 2) return new Response(null, { status: 404 });
    assert.equal(init?.method, 'POST');
    assert.equal(new URL(String(input)).searchParams.get('exclusiveCreate'), 'true');
    return new Response(null, { status: 409 });
  }) as typeof fetch }));
  try { await assert.rejects(api.copy(source, target, directory), /HTTP 409.*Backup:/); assert.equal(calls, 3); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('missing source and denied target never write', async () => {
  for (const status of [404, 403]) {
    let calls = 0;
    const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (_input, init) => {
      assert.equal(init?.method, 'GET'); calls++;
      if (status === 403 && calls === 1) return entry('null', 'v1');
      return new Response(null, { status });
    }) as typeof fetch }));
    await assert.rejects(api.copy(source, target, join(tmpdir(), 'unused-backup')));
    assert.equal(calls, status === 404 ? 1 : 2);
  }
});

test('version history paginates and reads a v2 revision without writes', async () => {
  const calls: URL[] = [];
  const api = new DataStoreEntries(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith('/versions')) {
      assert.equal(url.searchParams.get('datastoreName'), source.datastore);
      assert.equal(url.searchParams.get('entryKey'), source.key);
      if (!url.searchParams.get('cursor')) return Response.json({ versions: [{ version: 'v2', deleted: false, contentLength: 20, createdTime: '2026-01-02', objectCreatedTime: '2026-01-01' }], nextPageCursor: 'next' });
      return Response.json({ versions: [{ version: 'v1', deleted: false, contentLength: 10, createdTime: '2026-01-01', objectCreatedTime: '2026-01-01' }] });
    }
    assert.equal(url.pathname, '/cloud/v2/universes/123/data-stores/cloud%20%26%20config/scopes/global/entries/config%2F%E4%B8%AD%E6%96%87%40v1');
    return Response.json({ revisionId: 'v1', revisionCreateTime: '2026-01-01', createTime: '2026-01-01', value: { ok: true }, users: ['users/1'], attributes: {} });
  }) as typeof fetch }));
  const versions = await api.listVersions(source, 2);
  assert.deepEqual(versions.map(row => row.version), ['v2', 'v1']);
  const revision = await api.getVersion(source, 'v1');
  assert.deepEqual(revision?.value, { ok: true });
  assert.equal(calls.length, 3);
  await assert.rejects(api.listVersions(source, 0), /1 to 100/);
});
