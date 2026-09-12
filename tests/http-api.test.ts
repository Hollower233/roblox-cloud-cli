import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/transport/http-client.js';
import { RobloxApi } from '../src/roblox/api.js';
const key = 'fictional-test-key';
function fetchMock(fn: (url: string, options: RequestInit) => Response | Promise<Response>): typeof fetch { return ((url: any, options: any) => Promise.resolve(fn(String(url), options))) as typeof fetch; }
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('auth is only sent to explicit Roblox Cloud destinations, with redirects disabled', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const http = new HttpClient({ apiKey: key, intervalMs: 0, fetch: fetchMock((url, options) => { calls.push({ url, options }); return ok({}); }) });
  await http.request('https://games.roblox.com/v1/games'); await http.request('https://apis.roblox.com/cloud/v2/universes/1', { auth: true });
  assert.equal((calls[0]!.options.headers as any)['x-api-key'], undefined);
  assert.equal((calls[1]!.options.headers as any)['x-api-key'], key); assert.equal(calls[1]!.options.redirect, 'error');
  await assert.rejects(http.request('https://games.roblox.com/v1/games', { auth: true }), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(http.request('https://example.com', { auth: true }), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(http.request('https://apis.roblox.com.evil.example/', { auth: true }), { code: 'ARGUMENT_ERROR' });
});
test('429 retries honor Retry-After and are bounded', async () => {
  let calls = 0; const sleeps: number[] = [];
  const http = new HttpClient({ intervalMs: 0, retries: 2, sleep: async ms => { sleeps.push(ms); }, fetch: fetchMock(() => { calls++; return new Response('do not log', { status: 429, headers: { 'Retry-After': '2' } }); }) });
  await assert.rejects(http.request('https://games.roblox.com/v1/games'), { httpStatus: 429 });
  assert.equal(calls, 3); assert.deepEqual(sleeps, [2000, 2000]);
});
test('long server cooldown is not retried prematurely', async () => {
  let calls = 0;
  const http = new HttpClient({ intervalMs: 0, fetch: fetchMock(() => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); }) });
  await assert.rejects(http.request('https://games.roblox.com/v1/games'), { httpStatus: 429 }); assert.equal(calls, 1);
});
test('POST is never blindly retried and response bodies containing secrets are not exposed', async () => {
  let calls = 0;
  const http = new HttpClient({ intervalMs: 0, fetch: fetchMock(() => { calls++; return new Response(key, { status: 503 }); }) });
  await assert.rejects(http.request('https://apis.roblox.com/api-keys/v1/introspect', { body: { apiKey: key } }), (e: any) => !e.message.includes(key));
  assert.equal(calls, 1);
});
test('403 is not retried and cancellation is classified', async () => {
  let calls = 0;
  const http = new HttpClient({ intervalMs: 0, fetch: fetchMock(() => { calls++; return new Response('', { status: 403 }); }) });
  await assert.rejects(http.request('https://games.roblox.com/v1/games'), { code: 'FORBIDDEN' }); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new HttpClient({ signal: controller.signal }).request('https://games.roblox.com/v1/games'), { code: 'CANCELLED' });
});
test('HTTP adapters use verified numeric filters, encode cursors and validate responses', async () => {
  const urls: string[] = [];
  const api = new RobloxApi(new HttpClient({ apiKey: key, intervalMs: 0, fetch: fetchMock(url => { urls.push(url); return ok({ data: [{ id: 1, name: 'Fixture' }], nextPageCursor: null }); }) }), key);
  await api.groupGames('200', 'a+/='); await api.userGames('100');
  assert.equal(new URL(urls[0]!).searchParams.get('accessFilter'), '1'); assert.equal(new URL(urls[0]!).searchParams.get('cursor'), 'a+/=');
  assert.equal(new URL(urls[1]!).searchParams.get('accessFilter'), '2');
  await assert.rejects(api.permissions('1'), { code: 'INVALID_RESPONSE' });
  assert.throws(() => api.groupGames('../1'), { code: 'ARGUMENT_ERROR' });
});
test('identity rejects expired keys and preserves scope names without returning the key', async () => {
  let expired = false;
  const api = new RobloxApi(new HttpClient({ intervalMs: 0, fetch: fetchMock(() => ok({ authorizedUserId: 100, enabled: true, expired, scopes: [{ name: 'legacy-group', operations: ['manage'] }] })) }), key);
  const result = await api.identity(); assert.equal(result.userId, '100'); assert.ok(!JSON.stringify(result).includes(key));
  expired = true; await assert.rejects(api.identity(), { code: 'AUTH_INVALID' });
});
test('network exceptions cannot leak credential text', async () => {
  const http = new HttpClient({ retries: 0, fetch: fetchMock(() => { throw new Error(key); }) });
  await assert.rejects(http.request('https://games.roblox.com/v1/games'), (e: any) => e.code === 'NETWORK_ERROR' && !e.message.includes(key));
});
