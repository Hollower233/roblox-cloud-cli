import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { banBody, UserRestrictions } from '../src/moderation/restrictions.js';
import { HttpClient } from '../src/transport/http-client.js';

test('explicit duration, reasons and alt propagation are validated before requests', () => {
  for (const options of [{ reason: 'x' }, { reason: 'x', duration: '1d', permanent: true },
    ...['0s', '-1s', '1.5h', '1', '315576000001s'].map(duration => ({ reason: 'x', duration })),
    { reason: ' ', permanent: true }, { reason: 'x'.repeat(401), permanent: true },
    { reason: 'x', privateReason: 'x'.repeat(1001), permanent: true }]) assert.throws(() => banBody(options));
  assert.deepEqual(banBody({ duration: '30m', reason: 'maintenance' }), { gameJoinRestriction: {
    active: true, duration: '1800s', displayReason: 'maintenance', privateReason: 'maintenance', excludeAltAccounts: true,
  } });
  const permanent = banBody({ permanent: true, reason: 'x', includeAlts: true }).gameJoinRestriction;
  assert.equal(permanent.excludeAltAccounts, false); assert.equal('duration' in permanent, false);
});

test('preview sends no requests; PATCH uses atomic mask; unban and status target same player', async () => {
  const calls: { method: string; body: unknown }[] = [];
  const api = new UserRestrictions(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/cloud/v2/universes/123/user-restrictions/456');
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fake');
    if (init?.method === 'PATCH') assert.equal(url.searchParams.get('updateMask'), 'gameJoinRestriction');
    calls.push({ method: init!.method!, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ gameJoinRestriction: { active: calls.length === 1 } });
  }) as typeof fetch }));
  await api.ban('123', '456', { duration: '1d', reason: 'x' }, true);
  await api.unban('123', '456', true); assert.equal(calls.length, 0);
  await assert.rejects(api.unban('../123', '456', true));
  await api.ban('123', '456', { duration: '1d', reason: 'x' });
  await api.unban('123', '456'); await api.get('123', '456');
  assert.deepEqual(calls.map(c => c.method), ['PATCH', 'PATCH', 'GET']);
  assert.deepEqual(calls[1]!.body, { gameJoinRestriction: { active: false } });
});

test('denied, throttled and lost mutation responses never repeat PATCH', async () => {
  for (const status of [403, 429, 500, 0]) {
    let calls = 0;
    const api = new UserRestrictions(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async () => {
      calls++; if (!status) throw new Error('network'); return new Response(null, { status });
    }) as typeof fetch }));
    await assert.rejects(api.unban('123', '456'), status === 403 ? /universe.user-restriction:write/ : /ban-status/);
    assert.equal(calls, 1);
  }
});

test('CLI preview resolves numeric targets offline and rejects ambiguous permanent duration', () => {
  const env = { ...process.env, ROBLOX_API_KEY: 'fake-offline-key' };
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--json', ...args], { encoding: 'utf8', env });
  const result = run('ban', '123', '--player', '456', '--duration', '30m', '--reason', 'test', '--dry-run');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.result.body.gameJoinRestriction.excludeAltAccounts, true);
  assert.equal(run('ban', '123', '--player', '456', '--reason', 'test', '--dry-run').status, 2);
  assert.equal(run('unban', '123', '--player', '456', '--dry-run').status, 0);
});
