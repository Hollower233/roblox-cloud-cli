import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { HttpClient, normalizeLabel, pickSession, planPublishTarget, publishAs, publishScriptPath, resolvePublishGame, searchTerm, type PublishAsSystem, type PublishUiArgs, type PublishUiResult } from '../src/index.js';
import { AppError } from '../src/core/errors.js';
import type { Game } from '../src/universes/models.js';

const ME = '1000';
function game(universeId: string, name: string, owner: { id: string; name: string; type: 'User' | 'Group' } = { id: '50', name: 'Studio Group', type: 'Group' }): Game {
  return { universeId, name, owner, visibility: 'PRIVATE', ccu: 0, permissions: { canManage: true, canCloudEdit: true }, discoveredAt: '', lastSeenAt: '', discoveryState: 'seen', errors: [] };
}
const games = [
  game('7', 'Ball Dev'), game('8', '农夫山泉'), game('9', '农夫山泉'), game('10', '⚔️ 球对球 '),
  game('11', 'Ball Dev', { id: '60', name: 'Other Group', type: 'Group' }), game('12', 'Mine', { id: ME, name: 'me', type: 'User' }),
  game('13', 'Theirs', { id: '2000', name: 'someone', type: 'User' }),
];
const places = [{ placeId: '100', name: 'Ball Dev' }, { placeId: '101', name: 'Trade' }];

function fakeHttp(routes: Record<string, unknown[]>) {
  const hits: string[] = [];
  const client = new HttpClient({ apiKey: 'test-key', intervalMs: 0, retries: 0, fetch: (async (url: string | URL) => {
    const key = String(url); hits.push(key);
    const queue = routes[key];
    if (!queue?.length) return new Response('{}', { status: 404 });
    return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
  }) as typeof fetch });
  return { client, hits };
}
function fakeSystem(result: Partial<PublishUiResult>) {
  const calls: PublishUiArgs[] = []; let clock = 0;
  const system: PublishAsSystem = {
    runUi: async args => { calls.push(args); return { ok: true, stage: 'done', clicked: true, elapsedMs: 1234, ...result }; },
    sleep: async ms => { clock += ms; }, now: () => clock,
  };
  return { system, calls };
}
const session = { pid: 42, placeId: '100', universeId: '7', title: 'Ball Dev - Roblox Studio' };
const versionsUrl = 'https://apis.roblox.com/assets/v1/assets/101/versions?maxPageSize=1';
const version = (n: number) => ({ assetVersions: [{ path: `assets/101/versions/${n}`, createTime: `2026-01-0${n}T00:00:00Z`, published: true }] });

test('labels normalize like the OCR matcher and search text skips emoji and brackets', () => {
  assert.equal(normalizeLabel('⚔️ 球对球 '), normalizeLabel('球对球'));
  assert.equal(normalizeLabel('Trade'), normalizeLabel('Tra de'));
  assert.equal(normalizeLabel('Ball 1'), normalizeLabel('BaII l'));
  assert.equal(searchTerm('⚔️ 球对球 '), '球对球');
  assert.equal(searchTerm('[TEST SERVER — CLOSED] Play [Ball VS Ball]'), 'Ball VS Ball');
  assert.throws(() => searchTerm('⚔️'), (e: AppError) => e.code === 'ARGUMENT_ERROR');
});
test('source session is the explicit PID or the only open one', () => {
  const a = { pid: 1, placeId: '5' }, b = { pid: 2, placeId: '6' };
  assert.equal(pickSession([a], undefined), a);
  assert.equal(pickSession([a, b], '2'), b);
  assert.throws(() => pickSession([a, b], undefined), (e: AppError) => e.code === 'ARGUMENT_ERROR' && /--pid/.test(e.message));
  assert.throws(() => pickSession([], undefined), (e: AppError) => e.code === 'STUDIO_NOT_FOUND');
  assert.throws(() => pickSession([a], '9'), (e: AppError) => e.code === 'ARGUMENT_ERROR');
});
test('destination game resolves by ID or unique exact name from the catalog', () => {
  assert.equal(resolvePublishGame(games, '7').universeId, '7');
  assert.equal(resolvePublishGame(games, 'mine').universeId, '12');
  assert.throws(() => resolvePublishGame(games, 'Ball Dev'), (e: AppError) => /Ambiguous/.test(e.message) && /Other Group/.test(e.message));
  assert.throws(() => resolvePublishGame(games, '999'), (e: AppError) => /universe add 999/.test(e.message));
  assert.throws(() => resolvePublishGame(games, 'nope'), (e: AppError) => e.code === 'ARGUMENT_ERROR');
});
test('plan maps owners to dialog labels and places by ID or name', () => {
  const { target, warnings } = planPublishTarget(games[0]!, games, places, ME, { value: 'trade' });
  assert.equal(target.ownerLabel, 'Studio Group'); assert.equal(target.experience, 'Ball Dev');
  assert.deepEqual(target.place, { placeId: '101', name: 'Trade' }); assert.equal(target.newPlace, false); assert.deepEqual(warnings, []);
  assert.deepEqual(planPublishTarget(games[0]!, games, places, ME, { value: '100' }).target.place, places[0]);
  const mine = planPublishTarget(games[5]!, games, places, ME, { newPlace: true });
  assert.equal(mine.target.ownerLabel, 'My Experiences'); assert.equal(mine.target.place, undefined);
  assert.equal(mine.warnings[0]?.code, 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE');
  assert.equal(planPublishTarget(games[3]!, games, places, ME, { newPlace: true }).target.experience, '⚔️ 球对球');
});
test('targets the dialog cannot tell apart are refused before any UI work', () => {
  assert.throws(() => planPublishTarget(games[1]!, games, places, ME, { newPlace: true }), (e: AppError) => /cannot tell 8 apart from 9/.test(e.message));
  // the same name under a different owner is fine
  assert.doesNotThrow(() => planPublishTarget(games[0]!, games, places, ME, { newPlace: true }));
  const dupPlaces = [...places, { placeId: '102', name: 'trade ' }];
  assert.throws(() => planPublishTarget(games[0]!, games, dupPlaces, ME, { value: '101' }), (e: AppError) => /place 101 apart from 102/.test(e.message));
  assert.throws(() => planPublishTarget(games[0]!, games, places, ME, { value: '555' }), (e: AppError) => /not in universe 7/.test(e.message));
  assert.throws(() => planPublishTarget(games[6]!, games, places, ME, { newPlace: true }), (e: AppError) => /another user/.test(e.message));
  assert.throws(() => planPublishTarget(games[0]!, games, places, ME, {}), (e: AppError) => /exactly one/.test(e.message));
  assert.throws(() => planPublishTarget(games[0]!, games, places, ME, { value: 'Trade', newPlace: true }), (e: AppError) => /exactly one/.test(e.message));
});
test('overwrite passes dialog labels to the UI and confirms a new place version', async () => {
  const { target } = planPublishTarget(games[0]!, games, places, ME, { value: 'Trade' });
  const { system, calls } = fakeSystem({ button: 'Overwrite', menuPath: 'keyboard+OCR' });
  const { client } = fakeHttp({ [versionsUrl]: [version(4), version(4), version(5)] });
  const { result, warnings } = await publishAs(system, client, session, target, { versions: client, pollMs: 1000 });
  assert.deepEqual(calls, [{ pid: 42, group: 'Studio Group', experience: 'Ball Dev', search: 'Ball Dev', place: 'Trade', newPlace: false, dryRun: false }]);
  assert.equal(result.published, true);
  assert.deepEqual(result.verification, { state: 'verified', before: 4, after: 5, createTime: '2026-01-05T00:00:00Z' });
  assert.equal(result.ui.button, 'Overwrite'); assert.deepEqual(warnings, []);
  assert.equal('places' in result.target, false);
});
test('dry run makes no version calls and reports nothing published', async () => {
  const { target } = planPublishTarget(games[0]!, games, places, ME, { value: 'Trade' });
  const { system, calls } = fakeSystem({ stage: 'dry-run', clicked: false });
  const { client, hits } = fakeHttp({});
  const { result } = await publishAs(system, client, session, target, { dryRun: true, versions: client });
  assert.equal(calls[0]!.dryRun, true); assert.equal(result.published, false); assert.equal(result.verification.state, 'skipped'); assert.deepEqual(hits, []);
});
test('a UI failure before the click is an error that says nothing was published', async () => {
  const { target } = planPublishTarget(games[0]!, games, places, ME, { value: 'Trade' });
  const { system } = fakeSystem({ ok: false, stage: 'choose-group', clicked: false, message: 'Group not found' });
  const { client } = fakeHttp({ [versionsUrl]: [version(4)] });
  await assert.rejects(publishAs(system, client, session, target, { versions: client }), (e: AppError) => e.code === 'STUDIO_UI_ERROR' && /choose-group before publishing/.test(e.message));
});
test('after the click, the API decides: a new version wins over a UI read failure, none is an unknown-state error', async () => {
  const { target } = planPublishTarget(games[0]!, games, places, ME, { value: 'Trade' });
  const failed = fakeSystem({ ok: false, stage: 'publish', clicked: true, message: 'Timed out waiting for publish result.' });
  const won = fakeHttp({ [versionsUrl]: [version(4), version(5)] });
  const { result, warnings } = await publishAs(failed.system, won.client, session, target, { versions: won.client, pollMs: 1000 });
  assert.equal(result.verification.state, 'verified'); assert.equal(warnings[0]?.code, 'PUBLISH_UI_RESULT_UNREAD');
  const none = fakeHttp({ [versionsUrl]: [version(4)] });
  await assert.rejects(publishAs(fakeSystem({ ok: false, stage: 'publish', clicked: true }).system, none.client, session, target, { versions: none.client, pollMs: 1000, verifyTimeoutMs: 3000 }),
    (e: AppError) => e.code === 'STUDIO_UI_ERROR' && /result is unknown/.test(e.message));
});
test('UI success without API confirmation is partial, and a new place is found by its new ID', async () => {
  const { target } = planPublishTarget(games[0]!, games, places, ME, { value: 'Trade' });
  const stale = fakeHttp({ [versionsUrl]: [version(4)] });
  const r1 = await publishAs(fakeSystem({}).system, stale.client, session, target, { versions: stale.client, pollMs: 1000, verifyTimeoutMs: 3000 });
  assert.equal(r1.result.verification.state, 'unverified'); assert.equal(r1.warnings[0]?.code, 'PUBLISH_UNVERIFIED');
  const noKey = await publishAs(fakeSystem({}).system, stale.client, session, target, {});
  assert.equal(noKey.result.verification.state, 'unverified');
  const fresh = planPublishTarget(games[0]!, games, places, ME, { newPlace: true }).target;
  const dir = 'https://develop.roblox.com/v1/universes/7/places?limit=100';
  const row = (id: number, name: string) => ({ id, universeId: 7, name });
  const listing = fakeHttp({ [dir]: [{ data: places.map(p => row(Number(p.placeId), p.name)), nextPageCursor: null }, { data: [...places.map(p => row(Number(p.placeId), p.name)), row(103, 'Ball Dev')], nextPageCursor: null }] });
  const r2 = await publishAs(fakeSystem({ button: 'Create' }).system, listing.client, session, fresh, { pollMs: 1000 });
  assert.deepEqual(r2.result.verification, { state: 'verified', newPlaceId: '103' }); assert.deepEqual(r2.warnings, []);
});
test('the UI script is bundled next to the module and ASCII-only', async () => {
  const path = publishScriptPath();
  assert.ok(existsSync(path));
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  assert.ok(/^[\x00-\x7f]*$/.test(text)); assert.match(text, /@@RESULT/);
});
