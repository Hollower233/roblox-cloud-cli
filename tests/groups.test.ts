import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GroupRoles, groupPlayerInput } from '../src/groups/roles.js';
import { HttpClient } from '../src/transport/http-client.js';
import type { Identity } from '../src/universes/models.js';

const identity: Identity = { userId: '99', enabled: true, expired: false, scopes: [{ name: 'group', operations: ['read', 'write'] }] };
const role = { id: '10', path: 'groups/1/roles/10', displayName: 'Any Role', rank: 50 };
function fixture(options: { denied?: boolean; lost?: boolean; noEffect?: boolean; incomplete?: boolean } = {}) {
  const state = new Map([['2', ['groups/1/roles/20']], ['3', [role.path, 'groups/1/roles/20']]]);
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, retries: 0, fetch: (async (input, init) => {
    const url = new URL(String(input)), method = init!.method!;
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'fake');
    if (url.pathname.endsWith('/roles')) return Response.json({ groupRoles: [role] });
    if (method === 'POST') {
      if (options.denied) return new Response(null, { status: 403 });
      if (options.lost) throw new Error('lost');
      const userId = /memberships\/(\d+):/.exec(url.pathname)![1]!;
      if (!options.noEffect) state.set(userId, url.pathname.endsWith(':assignRole') ? [...state.get(userId)!, role.path] : state.get(userId)!.filter(value => value !== role.path));
      return Response.json({});
    }
    const userId = /users\/(\d+)/.exec(url.searchParams.get('filter')!)![1]!;
    return Response.json({ groupMemberships: state.has(userId) ? [{ path: `groups/1/memberships/${userId}`, user: `users/${userId}`, ...(options.incomplete ? { role: role.path } : { roles: state.get(userId) }) }] : [] });
  }) as typeof fetch });
  return { groups: new GroupRoles(http, identity), http, calls, state };
}

test('grant/revoke preserve other roles, deduplicate players, skip existing roles and nonmembers, and verify reads', async () => {
  const { groups, calls, state } = fixture();
  const result = await groups.change('1', { name: 'Any Role' }, ['2', '3', '4', '2'], 'grant');
  assert.deepEqual(result.results.map(row => row.status), ['success', 'unchanged', 'not-member']);
  assert.deepEqual(state.get('2'), ['groups/1/roles/20', role.path]);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(calls.find(call => call.method === 'POST')!.body, { role: role.path });
  const revoked = await groups.change('1', { id: '10' }, ['2', '3'], 'revoke');
  assert.deepEqual(revoked.results.map(row => row.status), ['success', 'success']);
  assert.deepEqual(state.get('2'), ['groups/1/roles/20']);
});

test('key scope and invalid selectors fail before requests; own roles are blocked; dry-run is read-only', async () => {
  const { http, calls, groups } = fixture();
  const noWrite = new GroupRoles(http, { ...identity, scopes: [{ name: 'group', operations: ['read'] }] });
  await assert.rejects(noWrite.change('1', { id: '10' }, ['2'], 'grant'), /group:write/);
  await assert.rejects(groups.change('1', { id: '10', name: 'Any Role' }, ['2'], 'grant'), /exactly one/);
  assert.equal(calls.length, 0);
  const result = await groups.change('1', { id: '10' }, ['2', '99'], 'grant', true);
  assert.deepEqual(result.results.map(row => row.status), ['planned', 'error']);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('denied mutations continue per player, lost responses and no-op responses remain unverified without retry', async () => {
  for (const options of [{ denied: true }, { lost: true }, { noEffect: true }]) {
    const { groups, calls } = fixture(options);
    const result = await groups.change('1', { id: '10' }, ['2', '4'], 'grant');
    assert.equal(result.results[0]!.status, 'denied' in options ? 'error' : 'unverified');
    assert.equal(result.results[1]!.status, 'not-member');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('incomplete legacy role response cannot be used to change roles', async () => {
  const { groups, calls } = fixture({ incomplete: true });
  const result = await groups.change('1', { id: '10' }, ['2'], 'grant');
  assert.equal(result.results[0]!.status, 'error');
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('pagination rejects repeated tokens and ambiguous role names', async () => {
  let calls = 0;
  const groups = new GroupRoles(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async () => {
    calls++;
    return Response.json({ groupRoles: [role], nextPageToken: 'same' });
  }) as typeof fetch }), identity);
  await assert.rejects(groups.roles('1'), /Repeated/);
  assert.equal(calls, 2);
  const ambiguous = new GroupRoles(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async () => Response.json({ groupRoles: [role, { ...role, id: '11', path: 'groups/1/roles/11' }] })) as typeof fetch }), identity);
  await assert.rejects(ambiguous.change('1', { name: 'Any Role' }, ['2'], 'grant'), /Ambiguous/);
});

test('player files and profile URLs normalize safely; CLI rejects conflicting arguments', () => {
  assert.equal(groupPlayerInput('https://www.roblox.com/users/2/profile\nSomeUser,3'), '2,SomeUser,3');
  assert.throws(() => groupPlayerInput('https://evil.test/users/2/profile'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--json', 'group', 'role', 'grant', '1', '--role', 'X', '--role-id', '10', '--players', '2'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('opaque membership IDs are preserved for writes and unsafe resource paths are rejected', async () => {
  const memberPath = 'groups/1/memberships/MjAw';
  let assigned = false;
  const groups = new GroupRoles(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/roles')) return Response.json({ groupRoles: [role] });
    if (init?.method === 'POST') {
      assert.equal(url.pathname, `/cloud/v2/${memberPath}:assignRole`);
      assigned = true;
      return Response.json({});
    }
    return Response.json({ groupMemberships: [{ path: memberPath, user: 'users/200', roles: assigned ? [role.path] : [] }] });
  }) as typeof fetch }), identity);
  assert.equal((await groups.change('1', { id: '10' }, ['200'], 'grant')).results[0]!.status, 'success');
  for (const path of ['groups/2/memberships/MjAw', 'groups/1/memberships/../roles/10', 'groups/1/memberships/x?redirect=1']) {
    const unsafe = new GroupRoles(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async () => Response.json({ groupMemberships: [{ path, user: 'users/200', roles: [] }] })) as typeof fetch }), identity);
    await assert.rejects(unsafe.member('1', '200'), /Invalid group membership/);
  }
});

test('delayed membership reads converge without repeating the mutation', async () => {
  let writes = 0, readsAfterWrite = 0;
  const groups = new GroupRoles(new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/roles')) return Response.json({ groupRoles: [role] });
    if (init?.method === 'POST') { writes++; return Response.json({}); }
    if (writes) readsAfterWrite++;
    return Response.json({ groupMemberships: [{ path: 'groups/1/memberships/MjAw', user: 'users/200', roles: readsAfterWrite >= 2 ? [role.path] : [] }] });
  }) as typeof fetch }), identity);
  assert.equal((await groups.change('1', { id: '10' }, ['200'], 'grant')).results[0]!.status, 'success');
  assert.equal(writes, 1);
  assert.equal(readsAfterWrite, 2);
});
