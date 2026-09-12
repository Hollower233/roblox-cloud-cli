import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogService, selectGames } from '../src/universes/catalog.js';
import { AppError } from '../src/core/errors.js';
import { fakeApi, identity, savedCatalog, savedGame } from './fixtures/fake-api.js';

test('scan paginates, deduplicates and preserves independent management and edit permissions', async () => {
  const calls: (string | undefined)[] = [];
  const api = fakeApi({ groupGames: async (_, cursor) => { calls.push(cursor); return cursor ? { games: [{ id: '1', name: 'duplicate' }, { id: '2', name: 'second' }], cursor: null } : { games: [{ id: '1', name: 'first' }], cursor: 'next+/=' }; } });
  const result = await new CatalogService(api).scan(identity, null);
  assert.deepEqual(calls, [undefined, 'next+/=']); assert.equal(result.games.length, 2);
  assert.equal(result.games[0]!.permissions!.canManage, true); assert.equal(result.games[0]!.permissions!.canCloudEdit, false);
  assert.ok(result.warnings.some(w => w.code === 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE'));
});
test('failed group discovery preserves prior records and does not mutate the input', async () => {
  const old = savedCatalog();
  const result = await new CatalogService(fakeApi({ groupGames: async () => { throw new AppError('HTTP_ERROR', 'Unavailable', 503); } })).scan(identity, old);
  assert.equal(result.games[0]!.ccu, 42); assert.equal(result.games[0]!.discoveryState, 'stale');
  assert.equal(old.games[0]!.discoveryState, 'seen'); assert.ok(result.warnings.some(w => w.httpStatus === 503));
});
test('failed manageable-groups request retains all old group entries as stale', async () => {
  const result = await new CatalogService(fakeApi({ manageableGroups: async () => { throw new AppError('FORBIDDEN', 'Missing scope', 403); } })).scan(identity, savedCatalog());
  assert.equal(result.games[0]!.discoveryState, 'stale');
});
test('partial pagination keeps rows received before failure and preserves unvisited old rows', async () => {
  const api = fakeApi({ groupGames: async (_, cursor) => { if (cursor) throw new AppError('HTTP_ERROR', 'Busy', 429); return { games: [{ id: '2', name: 'new' }], cursor: 'next' }; } });
  const result = await new CatalogService(api).scan(identity, savedCatalog());
  assert.equal(result.games.find(g => g.universeId === '1')!.discoveryState, 'stale');
  assert.equal(result.games.find(g => g.universeId === '2')!.discoveryState, 'seen');
});
test('repeated cursor terminates with a warning instead of looping', async () => {
  let count = 0;
  const api = fakeApi({ groupGames: async () => { count++; return { games: [], cursor: 'same' }; } });
  const result = await new CatalogService(api).scan(identity, null);
  assert.equal(count, 2); assert.ok(result.warnings.some(w => w.code === 'INVALID_RESPONSE'));
});
test('missing records are marked not-seen, and manually registered entries survive discovery', async () => {
  const api = fakeApi({ groupGames: async () => ({ games: [], cursor: null }) });
  const result = await new CatalogService(api).scan(identity, savedCatalog([savedGame('1'), savedGame('2')]), ['2']);
  assert.equal(result.games[0]!.discoveryState, 'not-seen'); assert.equal(result.games[1]!.discoveryState, 'seen');
});
test('failed detail or permission calls keep values AND their old timestamps', async () => {
  const api = fakeApi({ permissions: async () => { throw new AppError('FORBIDDEN', 'No scope', 403); }, details: async () => { throw new AppError('HTTP_ERROR', 'Unavailable', 503); } });
  const result = await new CatalogService(api, { now: () => '2026-01-01' }).refresh(identity, savedCatalog());
  const game = result.games[0]!;
  assert.equal(game.ccu, 42); assert.equal(game.detailsAt, '2020-01-01');
  assert.equal(game.permissions!.canManage, true); assert.equal(game.permissionsAt, '2020-01-01');
  assert.equal(game.metadataAt, '2026-01-01'); assert.equal(game.errors.length, 2);
});
test('omitted details remain unknown on new entries and are explicitly marked', async () => {
  const result = await new CatalogService(fakeApi({ details: async () => [] })).scan(identity, null);
  assert.equal(result.games[0]!.ccu, null); assert.ok(result.games[0]!.errors.some(e => e.code === 'DETAILS_UNAVAILABLE'));
});
test('false permission is distinct from unknown and excluded by default', async () => {
  const result = await new CatalogService(fakeApi({ permissions: async () => ({ canManage: false, canCloudEdit: false }) })).scan(identity, null);
  assert.equal(selectGames(result).length, 0); assert.equal(selectGames(result, { all: true }).length, 1);
});
test('manual add rejects unmanaged universe', async () => {
  const service = new CatalogService(fakeApi({ permissions: async () => ({ canManage: false, canCloudEdit: false }) }));
  await assert.rejects(service.add(identity, null, '9'), { code: 'FORBIDDEN' });
});
test('manual add verifies and enriches new entry; rejects another account cache', async () => {
  const service = new CatalogService(fakeApi());
  const result = await service.add(identity, null, '9'); assert.equal(result.games[0]!.owner.name, 'Studio');
  await assert.rejects(service.scan(identity, { ...savedCatalog(), userId: '999' }), { code: 'STORAGE_ERROR' });
});
test('refresh never discovers groups and preserves discovery warnings', async () => {
  const old = savedCatalog(); old.warnings = [{ code: 'FORBIDDEN', message: 'groups failed', resource: 'manageable-groups' }];
  const service = new CatalogService(fakeApi({ manageableGroups: async () => { throw new Error('must not call'); } }));
  const result = await service.refresh(identity, old); assert.equal(result.warnings[0]!.resource, 'manageable-groups');
});
test('cancel aborts scan without turning cancellation into partial success', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new CatalogService(fakeApi(), { signal: controller.signal }).scan(identity, null), { code: 'CANCELLED' });
});
test('filters support owner ID and name, visibility and exact numeric CCU sorting', () => {
  const a = savedGame('1'), b = savedGame('2'); a.ccu = null; b.ccu = 1500; b.visibility = 'PUBLIC';
  assert.deepEqual(selectGames(savedCatalog([a, b]), { owner: 'stud', visibility: 'public', sort: 'ccu' }).map(g => g.universeId), ['2']);
  assert.equal(selectGames(savedCatalog([a, b]), { owner: '200', sort: 'ccu' })[0]!.universeId, '2');
});
