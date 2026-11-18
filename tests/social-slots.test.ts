import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CredentialStore, HttpClient, readPlaceSocialSlots, writePlaceSocialSlots } from '../src/index.js';
import type { SocialSlotsSettings } from '../src/index.js';
import { robloxCookieCredential } from '../src/auth/credentials.js';

const url = 'https://develop.roblox.com/v2/places/22';
const place = { id: 22, universeId: 123, socialSlotType: 'Automatic', customSocialSlotsCount: 2, maxPlayerCount: 30 };
function mock(handler: (url: URL, init: RequestInit) => Response) {
  return new HttpClient({
    apiKey: 'fake-key', robloxCookie: '.ROBLOSECURITY=fake-cookie', intervalMs: 0, retries: 0,
    fetch: async (input, init) => handler(new URL(String(input)), init!),
  });
}

test('reads all documented modes and sends only the session cookie to the Place endpoint', async () => {
  for (const [socialSlotType, expected] of [
    ['Empty', { mode: 'disabled' }], ['Automatic', { mode: 'automatic' }], ['Custom', { mode: 'custom', count: 2 }],
  ] as const) {
    const settings = await readPlaceSocialSlots(mock((target, init) => {
      assert.equal(target.href, url);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('cookie'), '.ROBLOSECURITY=fake-cookie');
      assert.equal(headers.get('x-api-key'), null);
      return Response.json({ ...place, socialSlotType, id: '22' });
    }), '123', '22');
    assert.deepEqual(settings, { universeId: '123', placeId: '22', ...expected });
  }
});

test('writes only explicit Social Slots fields and verifies the resulting state', async () => {
  const cases: [SocialSlotsSettings, Record<string, unknown>][] = [
    [{ mode: 'disabled' }, { socialSlotType: 'Empty' }],
    [{ mode: 'automatic' }, { socialSlotType: 'Automatic' }],
    [{ mode: 'custom', count: 3 }, { socialSlotType: 'Custom', customSocialSlotsCount: 3 }],
  ];
  for (const [settings, fields] of cases) {
    const methods: string[] = [];
    let current = { ...place, socialSlotType: 'Custom' };
    const result = await writePlaceSocialSlots(mock((_target, init) => {
      methods.push(init.method!);
      if (init.method === 'PATCH') {
        assert.deepEqual(JSON.parse(String(init.body)), fields);
        current = { ...current, ...fields };
      }
      return Response.json(current);
    }), '123', '22', settings);
    assert.deepEqual(methods, ['GET', 'PATCH', 'GET']);
    assert.deepEqual(result, { universeId: '123', placeId: '22', before: { mode: 'custom', count: 2 }, requested: settings, after: settings, state: 'verified', changed: true });
  }
});

test('preflights identity and settings before mutation and skips redundant changes', async () => {
  for (const invalid of [{ universeId: 999 }, { id: [22] }, { socialSlotType: 'Other' }, { socialSlotType: 'Custom', customSocialSlotsCount: -1 }]) {
    await assert.rejects(writePlaceSocialSlots(mock((_target, init) => {
      assert.equal(init.method, 'GET');
      return Response.json({ ...place, ...invalid });
    }), '123', '22', { mode: 'disabled' }), { code: 'INVALID_RESPONSE' });
  }
  const noRequest = mock(() => { assert.fail('unexpected request'); });
  for (const invalid of [{ mode: 'disabled', count: 2 }, { mode: 'custom' }, { mode: 'custom', count: 1.5 }]) {
    await assert.rejects(writePlaceSocialSlots(noRequest, '123', '22', invalid as SocialSlotsSettings), { code: 'ARGUMENT_ERROR' });
  }
  const result = await writePlaceSocialSlots(mock((_target, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(place);
  }), '123', '22', { mode: 'automatic' });
  assert.equal(result.state, 'verified');
  assert.equal(result.changed, false);
});

test('answers only a confirmed CSRF challenge and does so once', async () => {
  for (const error of [
    { code: 0, message: 'Token Validation Failed' },
    { code: 0, message: 'XSRF token invalid' },
    { code: 9001, message: 'XSRF Token Validation Failed' },
    { code: 2, message: 'No permission' },
  ]) {
    let writes = 0;
    const operation = writePlaceSocialSlots(mock((_target, init) => {
      if (init.method === 'PATCH') {
        assert.equal(new Headers(init.headers).get('x-csrf-token'), writes === 0 ? null : 'fake-csrf');
        writes++;
        return Response.json({ errors: [error] }, { status: 403, headers: { 'x-csrf-token': 'fake-csrf' } });
      }
      return Response.json(place);
    }), '123', '22', { mode: 'disabled' });
    await assert.rejects(operation, { code: 'FORBIDDEN' });
    assert.equal(writes, error.code === 2 ? 1 : 2);
  }
});

test('reports an uncertain mutation or mismatched readback without retrying writes', async () => {
  for (const failure of ['timeout', 'mismatch']) {
    let writes = 0;
    const result = await writePlaceSocialSlots(mock((_target, init) => {
      if (init.method === 'PATCH') {
        writes++;
        if (failure === 'timeout') throw new DOMException('Timeout', 'TimeoutError');
      }
      return Response.json(place);
    }), '123', '22', { mode: 'disabled' });
    assert.equal(writes, 1);
    assert.equal(result.state, 'unverified');
    assert.equal(result.error?.code, failure === 'timeout' ? 'TIMEOUT' : 'INVALID_RESPONSE');
  }
});

test('rejects cookie destinations, mixed credentials, and injected cookie headers before any fetch', async () => {
  const http = mock(() => { assert.fail('unexpected request'); });
  for (const target of ['https://apis.roblox.com/v2/places/22', 'https://develop.roblox.com/v2/places/22/other']) {
    await assert.rejects(http.request(target, { cookieAuth: true }), { code: 'ARGUMENT_ERROR' });
  }
  await assert.rejects(http.request(url, { cookieAuth: true, auth: true }), { code: 'ARGUMENT_ERROR' });
  const injected = new HttpClient({
    robloxCookie: 'fake-cookie; other=value',
    fetch: async () => { assert.fail('unexpected request'); },
  });
  await assert.rejects(readPlaceSocialSlots(injected, '123', '22'), { code: 'AUTH_INVALID' });
});

test('CLI validates selectors and arguments and directs users to manual cookie setup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-slots-'));
  try {
    const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/cli/main.js'), '--home', home, '--json', ...args], {
      encoding: 'utf8', timeout: 10_000,
    });
    const prefix = ['places', 'social-slots'];
    const invalid = cli(...prefix, 'write', '--universe', '123', '--place', '22', '--mode', 'custom');
    assert.equal(invalid.status, 2, invalid.stderr);
    const noCookie = cli(...prefix, 'read', '--universe', '123', '--place', '22');
    assert.equal(noCookie.status, 4, noCookie.stderr);
    assert.match(JSON.parse(noCookie.stdout).error.message, /rbx auth cookie set/);
    const cleared = cli('auth', 'cookie', 'clear');
    assert.equal(cleared.status, 0, cleared.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('compiled CLI reads the encrypted cookie and writes with a confirmed readback', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-slots-'));
  try {
    await new CredentialStore(home, robloxCookieCredential).set('.ROBLOSECURITY=fake-cookie');
    assert.doesNotMatch(await readFile(join(home, 'cookie.dpapi'), 'utf8'), /fake-cookie/);
    const fixture = `
      let changed = false;
      globalThis.fetch = async (target, options) => {
        const headers = new Headers(options.headers);
        if (String(target) !== ${JSON.stringify(url)} || headers.get('cookie') !== '.ROBLOSECURITY=fake-cookie'
          || headers.has('x-api-key')) return new Response(null, { status: 403 });
        if (options.method === 'PATCH') {
          if (options.body !== '{"socialSlotType":"Empty"}') return new Response(null, { status: 400 });
          changed = true;
        }
        return Response.json({ id: 22, universeId: 123, socialSlotType: changed ? 'Empty' : 'Automatic' });
      };
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(fixture)}`, resolve('dist/cli/main.js'),
      '--home', home, '--json', 'places', 'social-slots', 'write', '--universe', '123', '--place', '22', '--mode', 'disabled',
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /fake-cookie/);
    const { data } = JSON.parse(result.stdout);
    assert.deepEqual([data.before.mode, data.after.mode, data.state, data.changed], ['automatic', 'disabled', 'verified', true]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
