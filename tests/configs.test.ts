import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigRepository, parseConfigEntries } from '../src/configs/repository.js';
import { HttpClient } from '../src/transport/http-client.js';

function fixture(options: { lost?: boolean; conflict?: boolean; failedReadback?: boolean; missingHash?: boolean; denied?: boolean } = {}) {
  const calls: { url: URL; method: string; body: any }[] = [];
  let hash = 'draft-old', draft: Record<string, unknown> = { untouched: true }, wrote = false;
  const client = new ConfigRepository(new HttpClient({ apiKey: 'fictional-key', retries: 0, intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method, body });
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fictional-key');
    assert.equal(url.host, 'apis.roblox.com');
    assert.ok(url.pathname.startsWith('/creator-configs-public-api/v1/configs/universes/1/repositories/InExperienceConfig'));
    if (method === 'GET') {
      if (options.failedReadback && wrote) return new Response(null, { status: 503 });
      if (url.pathname.endsWith('/draft')) return Response.json({ draftHash: options.conflict && wrote ? 'other-writer' : hash, entries: draft });
      if (url.pathname.endsWith('/revisions')) return Response.json({ revisions: [{ revisionId: 'rev-old', version: 1 }] });
      return Response.json({ entries: { untouched: true, waitSeconds: 0 }, metadata: { version: 1 } });
    }
    if (options.denied) return new Response(null, { status: 403 });
    wrote = true;
    if (options.lost) throw new Error('Lost response');
    if (url.pathname.endsWith('/draft')) {
      assert.equal(method, 'PATCH'); assert.equal(body.previousDraftHash, hash);
      draft = { ...draft, ...body.entries }; hash = 'draft-new';
    } else if (url.pathname.endsWith('/publish')) {
      assert.equal(body.draftHash, hash); return Response.json({ configVersion: 2 });
    } else {
      assert.equal(method, 'POST'); assert.ok(url.pathname.endsWith('/revisions/rev-old/restore')); hash = 'draft-restored';
    }
    return Response.json(options.missingHash ? {} : { draftHash: hash });
  }) as typeof fetch }));
  return { client, calls };
}
test('configs partial staging preserves omitted keys, null deletion and nested JSON; backs up before mutation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-config-'));
  try {
    const { client, calls } = fixture();
    const result = await client.setDraft('1', { waitSeconds: 8, obsolete: null, nested: { values: [false, 1] } }, { backupDirectory: home });
    assert.equal(result.state, 'verified');
    assert.equal(result.response?.draftHash, 'draft-new');
    assert.equal((result.readback?.entries as any).untouched, true);
    const stored = JSON.parse(await readFile(result.backupPath!, 'utf8'));
    assert.equal(stored.before.draft.draftHash, 'draft-old');
    assert.equal(JSON.stringify(stored).includes('fictional-key'), false);
    const write = calls.find(row => row.method !== 'GET')!;
    assert.deepEqual(write.body.entries, { waitSeconds: 8, obsolete: null, nested: { values: [false, 1] } });
    assert.equal(calls.filter(row => row.method !== 'GET').length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('configs dry-run never writes or creates backups', async () => {
  const { client, calls } = fixture();
  const result = await client.setDraft('1', { waitSeconds: 8 }, { dryRun: true, backupDirectory: 'invalid-directory-unused' });
  assert.equal(result.state, 'planned'); assert.equal(result.backupPath, undefined);
  assert.ok(calls.every(row => row.method === 'GET'));
});
test('publish requires the reviewed hash and acknowledges rollout without claiming player delivery', async () => {
  const { client, calls } = fixture();
  await assert.rejects(() => client.publish('1', 'stale-hash'), /hash changed/);
  assert.ok(calls.every(row => row.method === 'GET'));
  const result = await client.publish('1', 'draft-old', { message: 'Example', strategy: 'GradualRollout' });
  assert.equal(result.state, 'submitted'); assert.equal(result.response?.configVersion, 2);
  assert.deepEqual(calls.find(row => row.method === 'POST')!.body, { draftHash: 'draft-old', message: 'Example', deploymentStrategy: 'GradualRollout' });
});
test('restore only stages historical revision and never publishes automatically', async () => {
  const { client, calls } = fixture();
  const result = await client.restore('1', 'rev-old');
  assert.equal(result.state, 'verified'); assert.equal(result.response?.draftHash, 'draft-restored');
  assert.equal(calls.some(row => row.url.pathname.endsWith('/publish')), false);
});
test('read full and history preserve pagination parameter casing', async () => {
  const { client, calls } = fixture();
  await client.read('1', true); await client.history('1', { limit: 7, skip: 14 });
  assert.ok(calls[0]!.url.pathname.endsWith('/full'));
  assert.equal(calls[1]!.url.searchParams.get('MaxPageSize'), '7');
  assert.equal(calls[1]!.url.searchParams.get('Skip'), '14');
  assert.throws(() => client.history('1', { skip: -1 }), /pagination/);
});
for (const option of ['lost', 'conflict', 'failedReadback', 'missingHash'] as const) {
  test(`configs ${option} reports unverified and never replays mutation`, async () => {
    const { client, calls } = fixture({ [option]: true });
    const result = await client.setDraft('1', { waitSeconds: 8 });
    assert.equal(result.state, 'unverified');
    assert.equal(calls.filter(row => row.method !== 'GET').length, 1);
  });
}
test('backup failure prevents write; authorization failures remain errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-config-'));
  try {
    const path = join(home, 'file'); await writeFile(path, 'block directory');
    const { client, calls } = fixture();
    await assert.rejects(() => client.setDraft('1', { value: 1 }, { backupDirectory: path }), /backup/);
    assert.ok(calls.every(row => row.method === 'GET'));
    await assert.rejects(() => fixture({ denied: true }).client.setDraft('1', { value: 1 }), { code: 'FORBIDDEN' });
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('invalid JSON values, key names and resource IDs are rejected locally', async () => {
  const { client, calls } = fixture();
  for (const input of [[], {}, { a: undefined }, { a: NaN }, { a: new Date() }, { schemaVersion: 1, status: 'success', data: {} }, JSON.parse('{"__proto__":true}')]) assert.throws(() => parseConfigEntries(input));
  await assert.rejects(() => client.setDraft('1', {}));
  assert.throws(() => client.restore('1', '../other'));
  assert.throws(() => client.read('0'));
  assert.equal(calls.length, 0);
});
