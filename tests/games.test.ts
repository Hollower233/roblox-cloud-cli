import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { GameCatalogService } from '../src/games/catalog.js';
import { gamePlaceId, lookupPublicGame, searchPublicGames } from '../src/games/discovery.js';
import { launchRobloxPlayer } from '../src/games/launch.js';
import { LocalStore } from '../src/storage/store.js';
import { HttpClient } from '../src/transport/http-client.js';

const garden = { placeId: '123', universeId: '321', name: 'Example Garden', creatorName: 'Example Group' };
const farm = { placeId: '456', universeId: '654', name: 'Example Farm' };

async function temporary(action: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'rbx-games-'));
  try { await action(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('game inputs accept IDs and Roblox details pages but reject lookalike URLs', async () => {
  assert.equal(gamePlaceId('123'), '123');
  assert.equal(gamePlaceId('https://www.roblox.com/zh-cn/games/123/Example?refPageId=1'), '123');
  assert.equal(gamePlaceId('种花种菜'), undefined);
  assert.throws(() => gamePlaceId('https://roblox.com.example.com/games/123'), { code: 'ARGUMENT_ERROR' });
  assert.throws(() => gamePlaceId('9007199254740992'), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(launchRobloxPlayer('123&invalid'), { code: 'ARGUMENT_ERROR' });
});

test('online search keeps Roblox ranking, encodes Chinese, and sends no credentials', async () => {
  const http = new HttpClient({ intervalMs: 0, apiKey: 'example', fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://apis.roblox.com/search-api/omni-search');
    assert.equal(url.searchParams.get('SearchQuery'), '种花 种菜');
    assert.match(url.searchParams.get('SessionId')!, /^[a-f\d-]{36}$/);
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    return Response.json({ searchResults: [
      { contents: [{ userId: 1, name: 'Example User' }] },
      { contents: [
        { rootPlaceId: 123, universeId: 321, name: garden.name, creatorName: garden.creatorName },
        { rootPlaceId: '123' },
        { rootPlaceId: '456', universeId: '654', name: farm.name, creatorName: '' },
      ] },
    ] });
  } });
  assert.deepEqual(await searchPublicGames(http, ' 种花 种菜 '), [garden, farm]);
  const limited = new HttpClient({ retries: 0, fetch: async () => new Response(null, { status: 429 }) });
  await assert.rejects(searchPublicGames(limited, 'Example'), { code: 'HTTP_ERROR', httpStatus: 429, message: /rate limited/ });
});

test('direct collection lookup uses the requested Place ID and public experience metadata', async () => {
  const paths: string[] = [];
  const http = new HttpClient({ fetch: async input => {
    const url = String(input);
    paths.push(url);
    return Response.json(paths.length === 1 ? { universeId: 321 } : { data: [{
      id: 321, rootPlaceId: 999, name: garden.name, creator: { id: 789, name: garden.creatorName, type: 'Group' }, playing: 0,
    }] });
  } });
  assert.deepEqual(await lookupPublicGame(http, '123'), garden);
  assert.deepEqual(paths, [
    'https://apis.roblox.com/universes/v1/places/123/universe',
    'https://games.roblox.com/v1/games?universeIds=321',
  ]);
});

test('saved games reload, preserve nicknames on refresh and reject ambiguous mutations', async () => temporary(async home => {
  const collection = new GameCatalogService(new LocalStore(home));
  await collection.add(garden, '菜园Ａ');
  await collection.add(farm, '农场');
  await collection.add({ ...garden, name: 'Example Garden Updated' });
  const next = new GameCatalogService(new LocalStore(home));
  assert.equal((await next.find('菜园a'))[0]?.name, 'Example Garden Updated');
  assert.equal((await next.find('菜园'))[0]?.placeId, '123');
  assert.equal((await next.find('example')).length, 2);
  await assert.rejects(next.remove('example'), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(next.nickname('456', '菜园a'), { code: 'ARGUMENT_ERROR' });
  const renamed = await next.nickname('456', '农场2');
  assert.equal(renamed.nickname, '农场2');
  assert.equal((await next.remove('农场2')).placeId, '456');
  assert.equal((await next.list()).length, 1);
}));

test('CLI returns online candidates without opening or saving a game in JSON mode', async () => temporary(async home => {
  const preload = join(home, 'fetch.mjs');
  await writeFile(preload, `globalThis.fetch = async () => Response.json({
    searchResults: [{ contents: [{ rootPlaceId: 123, universeId: 321, name: "Example Garden" }] }]
  });`);
  const cli = resolve('src/cli/main.ts');
  for (const command of [['game', 'add'], ['play']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(preload).href,
      cli, '--home', home, '--json', ...command, '菜园'], { encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr || result.stdout);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.status, 'selection_required');
    assert.equal(data.games[0].placeId, '123');
  }
  assert.deepEqual(await new GameCatalogService(new LocalStore(home)).list(), []);
}));
