import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { getUniverseServerStatus, HttpClient, restartUniverseServers } from '../src/index.js';

const restartUrl = 'https://apis.roblox.com/cloud/v2/universes/123:restartServers';
const forecastUrl = 'https://apis.roblox.com/server-management/v1/universes/123/restarts:forecast';
const mockFetch = `
  import assert from 'node:assert/strict';
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers['x-api-key'], 'fictional-key');
    if (String(url) === ${JSON.stringify(forecastUrl)}) {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      return Response.json({ placeForecasts: {
        '11': { totalInstances: 5, instancesImpacted: 2 },
        '22': { totalInstances: 3, instancesImpacted: 1 },
        '33': { totalInstances: 10, instancesImpacted: 10, isNotInUniverse: true },
      } });
    }
    assert.equal(String(url), ${JSON.stringify(restartUrl)});
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), JSON.parse(process.env.EXPECTED_RESTART_BODY));
    return Response.json({});
  };
`;

function cli(command: 'restart' | 'status', args: string[], expectedBody?: Record<string, unknown>) {
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`,
    resolve('dist/cli/main.js'), '--json', 'servers', command, ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ROBLOX_API_KEY: 'fictional-key', EXPECTED_RESTART_BODY: JSON.stringify(expectedBody ?? null) },
    timeout: 5_000,
  });
}

test('CLI submits all four restart modes for the explicit universe without prompts', () => {
  for (const all of [false, true]) {
    for (const countdown of [false, true]) {
      const flags = [...(all ? ['--all'] : []), ...(countdown ? ['--countdown'] : [])];
      const body = {
        closeAllVersions: all,
        bleedOffServers: countdown,
        ...(countdown ? { bleedOffDurationMinutes: 1 } : {}),
      };
      const result = cli('restart', ['--universe', '123', ...flags], body);
      assert.equal(result.status, 0, result.stdout || result.stderr || String(result.error));
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'success');
      assert.deepEqual(output.data, {
        universeId: '123', state: 'submitted', request: { method: 'POST', url: restartUrl, body }, response: {},
      });
    }
  }
});

test('CLI rejects missing or nonnumeric IDs and rejects a countdown value', () => {
  for (const args of [[], ['--universe', 'Game Alias'], ['--universe', '123', '--countdown', '2']]) {
    const result = cli('restart', args);
    assert.equal(result.status, 2, result.stdout || result.stderr || String(result.error));
    assert.equal(JSON.parse(result.stdout).error.code, 'ARGUMENT_ERROR');
  }
});

test('CLI status reads a forecast and totals only places still in the universe', () => {
  const result = cli('status', ['--universe', '123']);
  assert.equal(result.status, 0, result.stdout || result.stderr || String(result.error));
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'success');
  assert.deepEqual(output.data, {
    universeId: '123', activeServers: 8, outdatedServers: 3,
    places: [
      { placeId: '11', activeServers: 5, outdatedServers: 2 },
      { placeId: '22', activeServers: 3, outdatedServers: 1 },
    ],
  });
});

test('SDK status handles an empty forecast and rejects malformed counts', async () => {
  const forecast = (body: unknown) => getUniverseServerStatus(new HttpClient({
    apiKey: 'fictional-key', fetch: async () => Response.json(body),
  }), '123');
  assert.deepEqual(await forecast({ placeForecasts: null }), {
    universeId: '123', activeServers: 0, outdatedServers: 0, places: [],
  });
  await assert.rejects(() => forecast({ placeForecasts: { '11': { totalInstances: 0, instancesImpacted: 2 } } }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(() => forecast({ placeForecasts: { '11': { totalInstances: 5 } } }), { code: 'INVALID_RESPONSE' });
});

test('SDK reports an uncertain submission without retrying the restart', async () => {
  let calls = 0;
  const http = new HttpClient({ apiKey: 'fictional-key', fetch: async () => {
    calls++;
    throw new DOMException('Timeout', 'TimeoutError');
  } });
  const result = await restartUniverseServers(http, '123');
  assert.equal(calls, 1);
  assert.equal(result.state, 'unverified');
  assert.equal(result.error?.code, 'TIMEOUT');
  assert.match(result.error?.message ?? '', /before submitting again/);
});
