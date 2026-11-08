import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { AppError, HttpClient, getPlace, listPlaces, updatePlaces } from '../src/index.js';

const place = (id: string, size = 20) => ({ path: `universes/123/places/${id}`, displayName: `Place ${id}`, serverSize: size });
function mock(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return new HttpClient({ apiKey: 'fictional-key', intervalMs: 0, retries: 0, fetch: async (url, init) => handler(new URL(String(url)), init!) });
}
test('list paginates and deduplicates all Places, reads sizes and identifies root, without leaking keys', async () => {
  const http = mock((url, init) => {
    const key = (init.headers as Record<string, string>)['x-api-key'];
    if (url.host === 'develop.roblox.com') {
      assert.equal(key, undefined);
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json(url.searchParams.has('cursor') ? { data: [{ id: 22 }, { id: 11 }] } : { data: [{ id: 11 }], nextPageCursor: 'next/+' });
    }
    assert.equal(key, 'fictional-key');
    if (url.pathname.endsWith('/universes/123')) return Response.json({ rootPlace: 'universes/123/places/11' });
    return Response.json(place(url.pathname.split('/').at(-1)!));
  });
  const rows = await listPlaces(http, '123');
  assert.deepEqual(rows.map(p => [p.placeId, p.isRootPlace, p.maxPlayers]), [['11', true, 20], ['22', false, 20]]);
});
test('single update touches only selected Place, patches only serverSize and verifies readback', async () => {
  let size = 20, writes = 0;
  const result = await updatePlaces(mock((url, init) => {
    assert.equal(url.pathname, '/cloud/v2/universes/123/places/22');
    if (init.method === 'PATCH') {
      assert.equal(url.searchParams.get('updateMask'), 'serverSize');
      assert.deepEqual(JSON.parse(String(init.body)), { serverSize: 21 });
      writes++; size = 21;
    }
    return Response.json(place('22', size));
  }), '123', { placeId: '22', maxPlayers: 21 });
  assert.equal(writes, 1);
  assert.deepEqual(result.results, [{ placeId: '22', before: 20, requested: 21, after: 21, state: 'verified' }]);
});
test('all continues after conflict, reports partial results and preserves successful writes', async () => {
  const sizes = new Map([['11', 20], ['22', 30]]);
  const result = await updatePlaces(mock((url, init) => {
    if (url.host === 'develop.roblox.com') return Response.json({ data: [{ id: 11 }, { id: 22 }] });
    const pid = url.pathname.split('/').at(-1)!;
    if (init.method === 'PATCH') {
      if (pid === '11') return new Response(null, { status: 409 });
      sizes.set(pid, 25);
    }
    return Response.json(place(pid, sizes.get(pid)));
  }), '123', { all: true, maxPlayers: 25 });
  assert.deepEqual(result.results.map(r => r.state), ['failed', 'verified']);
  assert.match(result.results[0]!.error!.message, /Team Create/);
  assert.equal(sizes.get('22'), 25);
});
test('SDK rejects invalid selectors, counts and IDs before any request', async () => {
  const http = mock(() => { throw new Error('must not request'); });
  for (const options of [
    { maxPlayers: 20 }, { placeId: '11', all: true, maxPlayers: 20 }, { placeId: '11', maxPlayers: 0 },
    { placeId: '11', maxPlayers: 1.2 }, { placeId: 'bad', maxPlayers: 20 }, { all: true, maxPlayers: Infinity },
  ]) await assert.rejects(updatePlaces(http, '123', options), { code: 'ARGUMENT_ERROR' });
});
test('failed pagination prevents all writes; repeated cursor and malformed responses are rejected', async () => {
  let writes = 0;
  await assert.rejects(updatePlaces(mock((_url, init) => {
    if (init.method === 'PATCH') writes++;
    return Response.json({ data: [{ id: 11 }], nextPageCursor: 'repeat' });
  }), '123', { all: true, maxPlayers: 20 }), { code: 'INVALID_RESPONSE' });
  assert.equal(writes, 0);
  await assert.rejects(updatePlaces(mock(() => Response.json({ data: [] })), '123', { all: true, maxPlayers: 20 }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(getPlace(mock(() => Response.json(place('99'))), '123', '11'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(getPlace(mock(() => Response.json(place('11', 0))), '123', '11'), { code: 'INVALID_RESPONSE' });
});
test('uncertain writes and readback failures are not retried or reported as successful', async () => {
  for (const failure of ['timeout', '500', 'mismatch', 'readback'] as const) {
    let writes = 0;
    const result = await updatePlaces(mock((_url, init) => {
      if (init.method === 'PATCH') {
        writes++;
        if (failure === 'timeout') throw new DOMException('Timeout', 'TimeoutError');
        if (failure === '500') return new Response(null, { status: 500 });
      } else if (writes && failure === 'readback') throw new AppError('FORBIDDEN', 'Denied', 403);
      return Response.json(place('11'));
    }), '123', { placeId: '11', maxPlayers: 21 });
    assert.equal(writes, 1);
    assert.equal(result.results[0]!.state, 'unverified');
  }
});

const preload = `globalThis.fetch = async (url, init) => {
  if (String(url).includes('develop.roblox.com')) return Response.json({ data: [{id:11},{id:22}] });
  if (String(url).endsWith('/universes/123')) return Response.json({rootPlace:'universes/123/places/11'});
  const pid = new URL(url).pathname.split('/').at(-1);
  if (init.method === 'PATCH' && pid === '11') return new Response(null,{status:409});
  return Response.json({path:'universes/123/places/'+pid,displayName:'Place '+pid,serverSize:20});
};`;
function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve('dist/cli/main.js'), '--json', 'places', ...args], {
    encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: 'fictional-key' }, timeout: 10000,
  });
}
test('CLI lists all Places and batch failure emits partial status with exit code 3', () => {
  const listed = cli(['list', '--universe', '123']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.equal(JSON.parse(listed.stdout).data.places.length, 2);
  const result = cli(['update', '--universe', '123', '--all', '--max-players', '20']);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'partial');
  assert.deepEqual(JSON.parse(result.stdout).data.results.map((r: { state: string }) => r.state), ['failed', 'verified']);
});
test('CLI rejects missing/conflicting selection and invalid counts', () => {
  for (const args of [[], ['--place', '11', '--all'], ['--place', '11', '--max-players', '1.5'], ['--all', '--max-players', '0']]) {
    const result = cli(['update', '--universe', '123', '--max-players', '20', ...args]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'ARGUMENT_ERROR');
  }
});
