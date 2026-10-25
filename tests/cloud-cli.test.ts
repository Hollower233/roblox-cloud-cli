import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerConfigs } from '../src/cli/commands/configs.js';
import { registerExperiments } from '../src/cli/commands/experiments.js';
import { HttpClient } from '../src/transport/http-client.js';
import { LocalStore } from '../src/storage/store.js';
import type { CommandContext } from '../src/cli/context.js';
import type { WriteReceipt } from '../src/cloud/common.js';

async function withCli(action: (fixture: { run: (...args: string[]) => Promise<void>; home: string; results: WriteReceipt[]; calls: { method: string; path: string; body: any }[] }) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'rbx-cloud-cli-'));
  const results: WriteReceipt[] = [], calls: { method: string; path: string; body: any }[] = [];
  const http = new HttpClient({ apiKey: 'fictional-key', intervalMs: 0, retries: 0, fetch: (async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? 'GET', body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path, body });
    if (path.endsWith('/draft')) return Response.json({ draftHash: 'example-hash', entries: {} });
    if (path.includes('/configs/')) return Response.json({ entries: {} });
    if (method === 'GET') return Response.json({ experiment: { id: 'example-experiment' } });
    return Response.json({ operation: { operationId: 'op_example', done: false } });
  }) as typeof fetch });
  const context: CommandContext = {
    signal: new AbortController().signal,
    async universe(input) { assert.equal(input, 'Example Game'); return { local: new LocalStore(home), universeId: '1', http }; },
    output() {}, receipt(result) { results.push(result); },
  };
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr() {} });
    registerConfigs(program, context); registerExperiments(program, context);
    await program.parseAsync(args, { from: 'user' });
  };
  try { await action({ run, home, results, calls }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
test('CLI definition file and --no-wait reach SDK without auto-starting a created experiment', async () => withCli(async ({ run, results, calls }) => {
  await run('experiments', 'create', 'Example Game', '--file', resolve('tests/fixtures/config-experiment.json'), '--no-wait');
  assert.equal(results[0]!.state, 'pending');
  assert.equal(calls.length, 1); assert.equal(calls[0]!.body.name, 'Example wait time');
  assert.ok(results[0]!.backupPath);
}));
test('CLI publish requires a hash and complete requires exactly one explicit outcome', async () => withCli(async ({ run, calls }) => {
  await assert.rejects(() => run('configs', 'publish', 'Example Game', '--message', 'Example'), /draft-hash/);
  await assert.rejects(() => run('experiments', 'complete', 'Example Game', 'example-experiment'), /exactly one/);
  await assert.rejects(() => run('experiments', 'complete', 'Example Game', 'example-experiment', '--variant', 'B', '--no-winner'), /exactly one/);
  assert.equal(calls.length, 0);
}));
test('CLI complete passes winner ID or explicit no-winner and returns pending on no-wait', async () => withCli(async ({ run, results, calls }) => {
  await run('experiments', 'complete', 'Example Game', 'example-experiment', '--variant', 'variant_B', '--no-wait');
  await run('experiments', 'complete', 'Example Game', 'example-experiment', '--no-winner', '--no-wait');
  assert.deepEqual(calls.filter(row => row.method === 'POST').map(row => row.body), [{ variantId: 'variant_B' }, {}]);
  assert.ok(results.every(row => row.state === 'pending'));
}));
test('CLI draft --dry-run reads only; does not wrap input in a second entries envelope', async () => withCli(async ({ run, home, calls, results }) => {
  const path = join(home, 'entries.json'); await writeFile(path, JSON.stringify({ exampleWaitSeconds: 8 }));
  await run('configs', 'draft', 'set', 'Example Game', '--file', path, '--dry-run');
  assert.equal(results[0]!.state, 'planned');
  assert.deepEqual(results[0]!.request.body?.entries, { exampleWaitSeconds: 8 });
  assert.ok(calls.every(row => row.method === 'GET'));
}));
test('CLI invalid polling flags fail before API access', async () => withCli(async ({ run, calls }) => {
  await assert.rejects(() => run('experiments', 'start', 'Example Game', 'example-experiment', '--timeout', '-1'), /Timeout/);
  assert.equal(calls.length, 0);
}));
test('built CLI exposes modules and emits stable JSON argument errors offline', () => {
  for (const command of ['configs', 'experiments']) {
    const help = spawnSync(process.execPath, [resolve('dist/cli/main.js'), command, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr); assert.ok(help.stdout.includes('Commands:'));
  }
  const result = spawnSync(process.execPath, [resolve('dist/cli/main.js'), '--json', 'experiments', 'complete', '1', 'example-experiment'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).error.code, 'ARGUMENT_ERROR');
});
