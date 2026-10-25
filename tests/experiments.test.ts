import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Experiments, parseExperimentDefinition } from '../src/experiments/experiments.js';
import { HttpClient } from '../src/transport/http-client.js';

const definition = JSON.parse(await readFile(new URL('./fixtures/config-experiment.json', import.meta.url), 'utf8'));
const experimentId = '9000000000000000123'; // Fictional fixture ID deliberately beyond JS safe integers.
function fixture(options: { lost?: boolean; pending?: boolean; failed?: boolean; pollFails?: boolean; denied?: boolean; invalidOp?: boolean; cancelAfterWrite?: AbortController } = {}) {
  const calls: { url: URL; method: string; body: any }[] = [];
  const client = new Experiments(new HttpClient({ apiKey: 'fictional-key', intervalMs: 0, retries: 0, fetch: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, method, body });
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fictional-key');
    assert.equal(url.host, 'apis.roblox.com');
    assert.ok(url.pathname.startsWith('/creator-configs-public-api/v1/experimentation/universes/1/'));
    if (url.pathname.includes('/operations/')) {
      if (options.pollFails) return new Response(null, { status: 503 });
      return Response.json({ operation: options.pending ? { operationId: 'op_example', done: false } : options.failed ? { operationId: 'op_example', done: true, error: { errorCode: 'EXAMPLE', errorMessage: 'Fictional failure' } } : { operationId: 'op_example', done: true, experiment: { id: experimentId, state: 'EXPERIMENT_STATE_RUNNING' } } });
    }
    if (method === 'GET' && url.pathname.endsWith('/experiments')) return Response.json({ experiments: [{ id: experimentId, name: 'Example' }], total: 1 });
    if (method === 'GET' && !url.pathname.endsWith('/stats')) {
      assert.ok(url.pathname.endsWith(`/experiments/${experimentId}`));
      return Response.json({ experiment: { id: experimentId, state: 'EXPERIMENT_STATE_DRAFT' } });
    }
    if (options.denied) return new Response(null, { status: 403 });
    if (options.lost) throw new Error('Lost response');
    options.cancelAfterWrite?.abort();
    return Response.json({ operation: options.invalidOp ? { done: false } : { operationId: 'op_example', done: false } });
  }) as typeof fetch }));
  return { client, calls };
}
test('creates a draft, saves a credential-free backup and polls the returned operation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-experiment-'));
  try {
    const { client, calls } = fixture();
    const result = await client.create('1', definition, { backupDirectory: home, intervalMs: 1, timeoutMs: 1000 });
    assert.equal(result.state, 'verified'); assert.equal(result.operationId, 'op_example');
    assert.equal((result.response?.experiment as any).id, experimentId);
    assert.deepEqual(calls[0]!.body, definition);
    assert.equal(calls.filter(row => row.method !== 'GET').length, 1);
    const stored = JSON.parse(await readFile(result.backupPath!, 'utf8'));
    assert.equal(stored.before, null); assert.equal(JSON.stringify(stored).includes('fictional-key'), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('list uses offset pagination, encodes searches and preserves large IDs as strings', async () => {
  const { client, calls } = fixture();
  const result = await client.list('1', { limit: 5, skip: 10, search: 'A & B' });
  assert.equal((result.experiments as any[])[0].id, experimentId);
  assert.equal(calls[0]!.url.searchParams.get('searchKey'), 'A & B');
  assert.equal(calls[0]!.url.searchParams.get('maxPageSize'), '5');
  assert.equal(calls[0]!.url.searchParams.get('skip'), '10');
  assert.equal((await client.get('1', experimentId)).id, experimentId);
});
test('update is a full payload replacement and does not start the experiment', async () => {
  const { client, calls } = fixture();
  const result = await client.update('1', experimentId, definition, { wait: false });
  assert.equal(result.state, 'pending'); assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, 'PATCH'); assert.deepEqual(calls[1]!.body, definition);
});
test('dry-run start reads current experiment but never writes', async () => {
  const { client, calls } = fixture();
  const result = await client.start('1', experimentId, { dryRun: true });
  assert.equal(result.state, 'planned'); assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'GET'); assert.ok(result.request.url.endsWith(`${experimentId}:start`));
});
test('schedule normalizes explicit offset to UTC and refuses ambiguous local time', async () => {
  const { client, calls } = fixture();
  const result = await client.schedule('1', experimentId, '2099-10-25T18:00:00+08:00', { wait: false });
  assert.equal(result.state, 'pending'); assert.equal(calls[1]!.body.scheduledStartTime, '2099-10-25T10:00:00.000Z');
  assert.throws(() => client.schedule('1', experimentId, '2099-10-25 18:00:00'));
  assert.throws(() => client.schedule('1', experimentId, '2000-01-01T00:00:00Z'));
});
test('complete supports explicit winner and fallback without silently picking a variant', async () => {
  const { client, calls } = fixture();
  await client.complete('1', experimentId, 'variant_B', { wait: false });
  await client.complete('1', experimentId, undefined, { wait: false });
  assert.deepEqual(calls.filter(row => row.method === 'POST').map(row => row.body), [{ variantId: 'variant_B' }, {}]);
});
test('zero timeout retains operation ID and separate operation query does not resubmit', async () => {
  const { client, calls } = fixture();
  const result = await client.start('1', experimentId, { timeoutMs: 0 });
  assert.equal(result.state, 'pending'); assert.equal(result.operationId, 'op_example');
  const op = await client.getOperation('1', result.operationId!);
  assert.equal(op.done, true); assert.equal(calls.filter(row => row.method === 'POST').length, 1);
});
test('cancelled polling preserves the submitted operation ID and does not repeat the write', async () => {
  const controller = new AbortController(), { client, calls } = fixture({ cancelAfterWrite: controller });
  const result = await client.start('1', experimentId, { signal: controller.signal });
  assert.equal(result.state, 'unverified'); assert.equal(result.error?.code, 'CANCELLED');
  assert.equal(result.operationId, 'op_example'); assert.equal(calls.filter(row => row.method === 'POST').length, 1);
});
test('already cancelled SDK operation sends no request', async () => {
  const { client, calls } = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(() => client.start('1', experimentId, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(calls.length, 0);
});
test('stats follows async operation and records the read-only HTTP method', async () => {
  const { client, calls } = fixture();
  const result = await client.stats('1', experimentId, { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(result.state, 'verified'); assert.equal(result.request.method, 'GET');
  assert.ok(calls.every(row => row.method === 'GET'));
});
for (const option of ['lost', 'failed', 'pollFails', 'invalidOp'] as const) {
  test(`experiment ${option} does not replay mutations or falsely claim completion`, async () => {
    const { client, calls } = fixture({ [option]: true });
    const result = await client.start('1', experimentId, { intervalMs: 1, timeoutMs: 1000 });
    assert.equal(result.state, 'unverified'); assert.ok(result.error);
    assert.equal(calls.filter(row => row.method === 'POST').length, 1);
    if (option === 'failed' || option === 'pollFails') assert.equal(result.operationId, 'op_example');
  });
}
test('authorization failure is surfaced, not retried', async () => {
  const { client, calls } = fixture({ denied: true });
  await assert.rejects(() => client.start('1', experimentId), { code: 'FORBIDDEN' });
  assert.equal(calls.filter(row => row.method === 'POST').length, 1);
});
test('invalid definitions, resource paths and polling settings fail before submitting', async () => {
  const { client, calls } = fixture();
  for (const change of [
    (v: any) => { v.durationSeconds = 1; },
    (v: any) => { v.exposurePercent = 101; },
    (v: any) => { v.experimentConfiguration.inGameConfigExperimentConfiguration.variants[0].variantMeta.isBaseline = false; },
    (v: any) => { v.experimentConfiguration.inGameConfigExperimentConfiguration.variants[0].configEntry.entryValue = 0; },
    (v: any) => { v.experimentConfiguration.inGameConfigExperimentConfiguration.variants[1].variantMeta.weight = 20; },
    (v: any) => { v.experimentConfiguration.inGameConfigExperimentConfiguration.variants[1].configEntry.key = 'other'; },
    (v: any) => { v.extra = true; },
  ]) {
    const value = structuredClone(definition); change(value); assert.throws(() => parseExperimentDefinition(value));
  }
  await assert.rejects(() => client.get('1', '../escape'));
  assert.throws(() => client.complete('1', experimentId, 'id/escape'));
  await assert.rejects(() => client.create('1', definition, { timeoutMs: -1 }));
  assert.equal(calls.length, 0);
});
