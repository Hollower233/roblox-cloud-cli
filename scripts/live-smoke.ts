import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { CredentialStore } from '../src/auth/credentials.js';
import { defaultHome } from '../src/storage/store.js';

// Opt-in only. Exercises compiled CLI using read-only Roblox endpoints.
// This isolated temporary catalog never becomes a repository fixture.
const key = process.env.RBX_LIVE_KEY_FILE
  ? (await readFile(process.env.RBX_LIVE_KEY_FILE, 'utf8')).trim()
  : await new CredentialStore(defaultHome()).get();
const home = await mkdtemp(join(tmpdir(), 'rbx-live-'));
async function run(args: string[], withKey = true): Promise<any> {
  const env: NodeJS.ProcessEnv = { ...process.env, RBX_HOME: home };
  if (withKey) env.ROBLOX_API_KEY = key; else delete env.ROBLOX_API_KEY;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli/main.js'), ...args, '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk.replaceAll(key, '[REDACTED]')); });
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.ok(!stdout.includes(key) && !stderr.includes(key), 'Output must not contain credentials');
        assert.ok(code === 0 || code === 3, `CLI failed: ${stdout.replaceAll(key, '[REDACTED]')}`);
        const result = JSON.parse(stdout);
        assert.ok(['success', 'partial'].includes(result.status));
        assert.ok(result.warnings.every((w: any) => w.code === 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE'), 'Unexpected live warning');
        resolvePromise(result);
      } catch (error) { reject(error); }
    });
  });
}
async function runEvents(args: string[]): Promise<any[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli/main.js'), ...args, '--json'], { env: { ...process.env, RBX_HOME: home, ROBLOX_API_KEY: key }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; process.stderr.write(chunk.replaceAll(key, '[REDACTED]')); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { process.stderr.write(chunk.replaceAll(key, '[REDACTED]')); });
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.ok(!stdout.includes(key), 'Output must not contain credentials');
        assert.equal(code, 0, 'icon countdown failed');
        resolvePromise(stdout.trim().split('\n').map(line => JSON.parse(line)));
      } catch (error) { reject(error); }
    });
  });
}
try {
  const status = await run(['auth', 'status']); assert.equal(status.data.enabled, true);
  const scan = await run(['universe', 'scan']);
  assert.ok(scan.data.games.length > 0, 'Smoke account needs at least one discoverable game');
  assert.ok(scan.data.games.every((g: any) => g.errors.length === 0 && typeof g.permissions.canManage === 'boolean'));
  const list = await run(['universe', 'list', '--all'], false); // No credentials: cache-only.
  assert.equal(list.data.games.length, scan.data.games.length);
  const manageable = scan.data.games.find((g: any) => g.permissions.canManage);
  assert.ok(manageable, 'Smoke account needs one manageable universe');
  const add = await run(['universe', 'add', manageable.universeId]);
  assert.equal(add.data.games.length, scan.data.games.length, 'Manual add should deduplicate');
  const refreshed = await run(['universe', 'refresh']);
  assert.equal(refreshed.data.games.length, scan.data.games.length); assert.ok(refreshed.data.refreshedAt);
  const filtered = await run(['universe', 'list', '--visibility', 'private', '--sort', 'ccu'], false);
  assert.ok(filtered.data.games.every((g: any) => g.visibility === 'PRIVATE' && g.permissions.canManage));
  const commands = ['auth status', 'universe scan', 'offline list', 'universe add', 'universe refresh', 'filtered offline list'];
  // Doubly opt-in: this really changes the game icon. Folder needs e.g. 1min.png and now.png.
  const iconUniverse = process.env.RBX_LIVE_ICON_UNIVERSE, iconDir = process.env.RBX_LIVE_ICON_DIR;
  if (iconUniverse && iconDir) {
    await run(['universe', 'add', iconUniverse]);
    const events = await runEvents(['icon', 'countdown', iconUniverse, resolve(iconDir), '--in', process.env.RBX_LIVE_ICON_IN ?? '1m']);
    const planned = events.find(e => e.event === 'planned'), switched = events.filter(e => e.event === 'icon');
    assert.ok(planned && switched.length === planned.nodes.length, 'Every planned icon should be switched');
    assert.equal(events.at(-1).event, 'completed');
    commands.push('icon countdown');
  }
  console.log(JSON.stringify({ passed: true, commands, gameCount: scan.data.games.length, privateCount: filtered.data.games.length }));
} finally { await rm(home, { recursive: true, force: true }); }
