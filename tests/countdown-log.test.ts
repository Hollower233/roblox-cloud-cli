import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('countdown diagnostics survive failed child exit without logging secrets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-diagnostics-'));
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { countdownLog } from './src/cli/countdown-log.ts';
      const log = countdownLog(process.env.TEST_LOG_HOME, '123');
      log.event({event:'waiting',label:'1hr',fireAt:'fixture'});
      log.error('NETWORK_ERROR');
      process.exitCode=5;
    `], { env: { ...process.env, TEST_LOG_HOME: home, ROBLOX_API_KEY: 'secret-fixture-do-not-log' }, encoding: 'utf8' });
    assert.equal(child.status, 5, child.stderr);
    const directory = join(home, 'icon-countdown', 'logs');
    const raw = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8');
    const events = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.event), ['process-start', 'countdown-event', 'command-error', 'process-exit']);
    assert.equal(events.at(-1).exitCode, 5);
    assert.equal(events.at(-1).phase, 'failed');
    assert.ok(!raw.includes('secret-fixture'));
  } finally { await rm(home, { recursive: true, force: true }); }
});
