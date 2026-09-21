import test from 'node:test';
import assert from 'node:assert/strict';
import { profileHistory } from '../src/profiles/history.js';
import type { EntryAddress, EntryRevision } from '../src/datastores/entries.js';

const player = { userId: '42', name: 'Example' };
const version = (id: string, createdTime: string, contentLength = 100) => ({ version: id, deleted: false, contentLength, createdTime, objectCreatedTime: '2026-01-01T00:00:00Z' });
function revision(id: string, createdTime: string, data: Record<string, unknown>): EntryRevision {
  return { version: id, createdTime, objectCreatedTime: '2026-01-01T00:00:00Z', value: { Data: data }, attributes: {}, users: ['users/42'] };
}

test('profile history summarizes revisions and deduplicates cumulative fusion events', async () => {
  const event = { type: 'fusion', id: 'fusion-1', at: 100, sequence: 3, consumed: ['rare-1', 'rare-2'], granted: 'epic-1', itemId: 'Epic Ball' };
  const versions = [version('v2', '2026-01-02T00:00:00Z', 200), version('v1', '2026-01-01T00:00:00Z')];
  const entries = {
    listVersions: async (address: EntryAddress, limit: number) => {
      assert.deepEqual(address, { universeId: '123', datastore: 'Default', scope: 'global', key: 'PLAYER_42' });
      assert.equal(limit, 2); return versions;
    },
    getVersion: async (_address: EntryAddress, id: string) => revision(id, versions.find(row => row.version === id)!.createdTime, {
      dataVersion: 7, coins: id === 'v2' ? 20 : 10, diamonds: 1, exp: { total: 30 }, items: { one: {}, two: {} },
      matchStats: { RPS: { matches: 4, wins: 3 } }, winStreak: 2, maxWinStreak: 5, itemLedger: { entries: [event] },
    }),
  };
  const result = await profileHistory(entries, '123', player, 2);
  assert.equal(result.revisions.length, 2);
  assert.equal(result.revisions[0]?.coins, 20);
  assert.equal(result.revisions[0]?.itemCount, 2);
  assert.deepEqual(result.fusionEvents, [{ id: 'fusion-1', at: 100, consumed: ['rare-1', 'rare-2'], granted: 'epic-1', itemId: 'Epic Ball', sequence: 3 }]);
});

test('profile history preserves deleted revisions without trying to read them', async () => {
  let reads = 0;
  const result = await profileHistory({
    listVersions: async () => [{ ...version('deleted', '2026-01-01T00:00:00Z'), deleted: true }],
    getVersion: async () => { reads++; return null; },
  }, '123', player);
  assert.equal(reads, 0);
  assert.equal(result.revisions[0]?.deleted, true);
  assert.equal(result.revisions[0]?.coins, null);
});

test('profile history rejects malformed profile revisions', async () => {
  await assert.rejects(profileHistory({
    listVersions: async () => [version('bad', '2026-01-01T00:00:00Z')],
    getVersion: async () => ({ version: 'bad', createdTime: '2026-01-01T00:00:00Z', objectCreatedTime: '2026-01-01T00:00:00Z', value: {}, attributes: {}, users: [] }),
  }, '123', player), /no Data object/);
});
