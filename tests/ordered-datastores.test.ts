import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HttpClient, LocalStore, OrderedDataStoreEntries } from '../src/index.js';
import { savedCatalog, savedGame } from './fixtures/fake-api.js';

const address = { universeId: '123', datastore: 'Scores' };
const entriesPath = '/cloud/v2/universes/123/ordered-data-stores/Scores/scopes/global/entries';

test('SDK keeps descending order and page size across pages, stopping at the requested limit', async () => {
  const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: String(i), value: 100 - i }));
  const nextPageToken = 'token+/=';
  const queries: Record<string, string>[] = [];
  const sdk = new OrderedDataStoreEntries(new HttpClient({
    apiKey: 'fictional-key', retries: 0, intervalMs: 0, fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, entriesPath);
      assert.equal(init?.method, 'GET');
      queries.push(Object.fromEntries(url.searchParams));
      return queries.length === 1
        ? Response.json({ orderedDataStoreEntries: firstPage, nextPageToken })
        : Response.json({ orderedDataStoreEntries: [{ id: '100', value: 0 }, { id: '101', value: -1 }], nextPageToken: 'unused' });
    },
  }));

  const entries = await sdk.list(address, 101);
  assert.deepEqual(queries, [
    { orderBy: 'value desc', maxPageSize: '100' },
    { orderBy: 'value desc', maxPageSize: '100', pageToken: nextPageToken },
  ]);
  assert.deepEqual(entries, [...firstPage, { id: '100', value: 0 }].map(row => ({ key: row.id, score: row.value })));
});

test('SDK reports empty and missing results and rejects a repeated page token', async () => {
  const sdk = (respond: () => Response) => new OrderedDataStoreEntries(new HttpClient({
    apiKey: 'fictional-key', intervalMs: 0, fetch: async () => respond(),
  }));
  assert.deepEqual(await sdk(() => Response.json({})).list(address), []);
  assert.equal(await sdk(() => new Response(null, { status: 404 })).get({ ...address, key: 'missing' }), null);
  await assert.rejects(() => sdk(() => Response.json({ nextPageToken: 'repeat' })).list(address), { code: 'INVALID_RESPONSE' });
});

test('CLI resolves the game, reads scores with the configured key, and reports 403 for both commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-ordered-cli-'));
  try {
    const store = new LocalStore(home);
    await store.saveCatalog(savedCatalog([savedGame('123')]));
    await store.saveConfig({ schemaVersion: 1, currentUserId: '100', accounts: { '100': { manualIds: [] } } });
    const mockFetch = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (input, init) => {
        assert.equal(init.method, 'GET');
        assert.equal(init.headers['x-api-key'], 'fictional-key');
        const url = new URL(input);
        if (url.pathname.includes('/ordered-data-stores/Denied/')) return new Response(null, { status: 403 });
        if (url.pathname === ${JSON.stringify(entriesPath)}) {
          assert.equal(url.searchParams.get('maxPageSize'), '50');
          assert.equal(url.searchParams.get('orderBy'), 'value desc');
          return Response.json({ orderedDataStoreEntries: [{ id: '42', value: 15 }, { id: '43', value: 0 }] });
        }
        assert.equal(url.pathname, '/cloud/v2/universes/123/ordered-data-stores/Scores/scopes/season%201/entries/player%2F42');
        return Response.json({ id: 'player/42', value: 0 });
      };
    `;
    const run = (expectedExit: number, ...args: string[]) => {
      const result = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`,
        resolve('dist/cli/main.js'), '--home', home, '--json', 'datastore', 'ordered', ...args,
      ], { encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: 'fictional-key' }, timeout: 5_000 });
      assert.equal(result.status, expectedExit, result.stdout || result.stderr || String(result.error));
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(run(0, 'list', 'Game 123', 'Scores'), {
      schemaVersion: 1, status: 'success', warnings: [],
      data: { ...address, scope: 'global', count: 2, entries: [{ key: '42', score: 15 }, { key: '43', score: 0 }] },
    });
    assert.deepEqual(run(0, 'get', '123', 'Scores', 'player/42', '--scope', 'season 1').data, {
      ...address, scope: 'season 1', key: 'player/42', score: 0,
    });
    for (const args of [['list', '123', 'Denied'], ['get', '123', 'Denied', '42']]) {
      const { status, error } = run(5, ...args);
      assert.equal(status, 'error');
      assert.equal(error.code, 'FORBIDDEN');
      assert.equal(error.httpStatus, 403);
      assert.match(error.message, /universe\.ordered-data-store\.scope\.entry:read for Universe 123/);
    }
    assert.equal(run(2, 'list', '123', 'Scores', '--limit', '0').error.code, 'ARGUMENT_ERROR');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
