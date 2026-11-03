import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CredentialStore } from '../src/auth/credentials.js';
import { LocalStore } from '../src/storage/store.js';
import { HttpClient } from '../src/transport/http-client.js';
import { IconAssets } from '../src/icons/countdown.js';
import { IconTasks } from '../src/icons/tasks.js';

// Explicit opt-in: uploads images and really changes this universe's icon; restores the saved original.
const universeId = process.env.RBX_LIVE_GENERATED_ICON_UNIVERSE;
if (!universeId) throw new Error('Set RBX_LIVE_GENERATED_ICON_UNIVERSE explicitly. This test uploads and switches real icons.');
const store = new LocalStore(), http = new HttpClient({ apiKey: await new CredentialStore(store.home).get() });
const assets = new IconAssets(http), tasks = new IconTasks(store, assets, http);
const before = await tasks.status(universeId);
if (before && before.phase !== 'restored') throw new Error('An unfinished icon task exists; refusing to take it over.');
const placeId = await assets.rootPlaceId(universeId), original = await assets.stablePlaceIcon(placeId);
assert.ok(original, 'Test game requires an original icon');
const logs = join(store.home, 'icon-countdown', 'live-smoke'); await mkdir(logs, { recursive: true });
const logPath = join(logs, `${universeId}-${Date.now()}.json`);
const output: { command: string[]; exitCode: number | null; stdout: string; stderr: string }[] = [];
function command(args: string[]) {
  const child = spawn(process.execPath, [resolve('dist/cli/main.js'), '--json', ...args], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  const row = { command: args, exitCode: null as number | null, stdout: '', stderr: '' }; output.push(row);
  child.stdout.on('data', data => { row.stdout += String(data); }); child.stderr.on('data', data => { row.stderr += String(data); });
  const done = new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('close', code => { row.exitCode = code; resolve(code ?? 1); }); });
  return { child, done, row };
}
const restoreAt = Date.now() + 150_000;
let worker: ReturnType<typeof command> | undefined, ownsTask = false;
try {
  worker = command(['icon','countdown',universeId,'--in','12s','--nodes','6s,2s','--restore-at',new Date(restoreAt).toISOString(),'--moderation-timeout','2m']);
  let switchedNow = false;
  for (;;) {
    const task = await tasks.status(universeId);
    if (task && task.taskId !== before?.taskId) {
      ownsTask = true; assert.equal(task.originalIconAssetId, original);
      if (task.phase === 'soon' && !switchedNow) {
        const manual = command(['icon','now',universeId]); assert.equal(await manual.done,0,manual.row.stdout + manual.row.stderr);
        assert.equal((await tasks.status(universeId))!.phase,'now'); switchedNow = true;
      }
      if (task.phase === 'restored') break;
    }
    if (worker.row.exitCode !== null) throw new Error(`Countdown exited before restoring: ${worker.row.stdout} ${worker.row.stderr}`);
    if (Date.now() > restoreAt + 30_000) throw new Error('Live countdown did not restore on schedule.');
    await sleep(500);
  }
  assert.ok(switchedNow, 'SOON and manual NOW must both execute');
  assert.equal(await worker.done,0,worker.row.stdout + worker.row.stderr);
  const restored = await tasks.status(universeId); assert.equal(restored!.phase,'restored');
  // Exercise the public manual restore command after automatic restoration; it must be idempotent.
  const manual = command(['icon','restore',universeId]); assert.equal(await manual.done,0,manual.row.stdout + manual.row.stderr);
  console.log(JSON.stringify({ success:true, universeId, generated:true, uploaded:true, soon:true, manualNow:true, automaticRestore:true, manualRestoreIdempotent:true, originalIconAssetId:original, logPath }));
} finally {
  if (ownsTask && (await tasks.status(universeId))?.phase !== 'restored') await tasks.restore(universeId);
  if (worker && worker.row.exitCode === null) { worker.child.kill(); await worker.done; }
  await writeFile(logPath, JSON.stringify({ universeId, originalIconAssetId:original, output },null,2) + '\n');
}
