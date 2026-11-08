import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CredentialStore, HttpClient, defaultHome, listPlaces } from '../src/index.js';
import { backup } from '../src/cloud/common.js';
import { id } from '../src/core/errors.js';

// Explicit real write test. Keep snapshots in application data, never in this repo.
const universeId = process.env.RBX_LIVE_PLACES_UNIVERSE;
if (!universeId) throw new Error('Set RBX_LIVE_PLACES_UNIVERSE explicitly to opt into temporary live writes and restoration.');
id(universeId);
const http = new HttpClient({ apiKey: await new CredentialStore(defaultHome()).get() });
const before = await listPlaces(http, universeId);
assert.ok(before.length, 'Expected at least one Place');
// Exercise --all without changing limits on Places that have different original values.
function run(args: string[]) {
  const child = spawnSync(process.execPath, ['dist/cli/main.js', '--json', 'places', ...args], { encoding: 'utf8', timeout: 120000 });
  if (child.error) throw child.error;
  const output = JSON.parse(child.stdout);
  if (child.status !== 0) throw new Error(`Live CLI failed: ${JSON.stringify(output)}`);
  return output.data;
}
const first = before[0]!;
const temporary = first.maxPlayers > 1 ? first.maxPlayers - 1 : 2;
const backupPath = await backup(join(defaultHome(), 'place-backups'), universeId, {
  method: 'PATCH', url: `https://apis.roblox.com/cloud/v2/universes/${universeId}/places/${first.placeId}?updateMask=serverSize`,
  body: { serverSize: temporary },
}, before);
let touched = false;
try {
  const listed = run(['list', '--universe', universeId]);
  assert.equal(listed.places.length, before.length);
  if (before.every(p => p.maxPlayers === first.maxPlayers)) {
    touched = true;
    const batch = run(['update', '--universe', universeId, '--all', '--max-players', String(first.maxPlayers)]);
    assert.equal(batch.results.length, before.length);
    assert.ok(batch.results.every((r: { state: string }) => r.state === 'verified'));
  }
  touched = true;
  const changed = run(['update', '--universe', universeId, '--place', first.placeId, '--max-players', String(temporary)]);
  assert.equal(changed.results[0].after, temporary);
} finally {
  if (touched) {
    for (const p of before) run(['update', '--universe', universeId, '--place', p.placeId, '--max-players', String(p.maxPlayers)]);
    const restored = await listPlaces(http, universeId);
    for (const p of before) assert.equal(restored.find(r => r.placeId === p.placeId)?.maxPlayers, p.maxPlayers);
  }
}
console.log(JSON.stringify({ success: true, universeId, placeCount: before.length, temporaryMaxPlayers: temporary, restored: true, backupPath }));
