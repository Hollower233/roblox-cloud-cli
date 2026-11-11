import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkKeyPermissions, permissionFeatures, HttpClient, RobloxApi, LocalStore, type Identity, type KeyScope } from '../src/index.js';
import { savedCatalog, savedGame } from './fixtures/fake-api.js';

const identity = (scopes: KeyScope[], state = {}): Identity => ({ userId: '100', enabled: true, expired: false, scopes, ...state });
const product = (scopes: KeyScope[], universeId?: string) => checkKeyPermissions(identity(scopes), { feature: 'devproduct-sync', universeId });

test('requirements catalog has stable unique features, copies, and exact business scopes', () => {
  const all = permissionFeatures();
  assert.equal(new Set(all.map(row => row.id)).size, all.length);
  assert.deepEqual(permissionFeatures('devproduct-sync')[0]!.requirements.map(row => row.scope), ['developer-product:read', 'developer-product:write']);
  assert.deepEqual(permissionFeatures('profile-history')[0]!.requirements.map(row => row.scope), ['universe-datastores.versions:list', 'universe-datastores.objects:read']);
  all[0]!.requirements.length = 0;
  assert.ok(permissionFeatures()[0]!.requirements.length);
  assert.throws(() => permissionFeatures('invalid'), { code: 'ARGUMENT_ERROR' });
});
test('missing operations and operation-specific game grants cannot mask each other', () => {
  const result = product([
    { name: 'developer-product', operations: ['read'], universeIds: ['123'] },
    { name: 'developer-product', operations: ['write'], universeIds: ['456'] },
  ], '123');
  assert.deepEqual(result.features[0]!.requirements.map(row => row.state), ['configured', 'out-of-scope']);
  assert.equal(result.configurationState, 'out-of-scope');
  assert.equal(product([{ name: 'developer-product', operations: ['read'] }], '123').configurationState, 'missing');
});
test('wildcards, unfiltered user keys, empty restrictions and absent target are distinguished', () => {
  for (const universeIds of [undefined, ['*'], ['123']]) {
    assert.equal(product([{ name: 'developer-product', operations: ['read', 'write'], universeIds }], '123').configurationState, 'configured');
  }
  assert.equal(product([{ name: 'developer-product', operations: ['read', 'write'], universeIds: [] }], '123').configurationState, 'out-of-scope');
  assert.equal(product([{ name: 'developer-product', operations: ['read', 'write'] }]).configurationState, 'unknown');
  assert.equal(product([
    { name: 'developer-product', operations: ['read', 'write'], universeIds: [] },
    { name: 'developer-product', operations: ['read', 'write'], universeIds: ['123'] },
  ], '123').configurationState, 'configured');
});
test('DataStore targets require a matching universe and datastore, without cross-target mixing', () => {
  const scope = { name: 'universe-datastores.objects', operations: ['read'], universeDatastores: [
    { universeId: '123', datastoreName: 'Default' }, { universeId: '456', datastoreName: '*' },
  ] };
  const check = (universeId: string, datastore?: string) => checkKeyPermissions(identity([scope]), { feature: 'datastore-get', universeId, datastore }).configurationState;
  assert.equal(check('123'), 'unknown'); assert.equal(check('123', 'Default'), 'configured');
  assert.equal(check('123', 'Other'), 'out-of-scope'); assert.equal(check('789', 'Default'), 'out-of-scope');
  assert.equal(check('456'), 'configured');
  assert.equal(checkKeyPermissions(identity([{ name: scope.name, operations: ['read'] }]), { feature: 'datastore-get', universeId: '123' }).configurationState, 'unknown');
});
test('creator access stays unknown, inactive key stays inactive, and argument validation is strict', () => {
  const result = checkKeyPermissions(identity([{ name: 'asset', operations: ['read'], userIds: ['100'] }], { enabled: false }), { feature: 'studio-publish-verify', universeId: '123' });
  assert.equal(result.configurationState, 'unknown'); assert.equal(result.keyState, 'disabled'); assert.equal(result.businessAccessVerified, false);
  assert.equal(checkKeyPermissions(identity([], { expired: true }), { feature: 'local' }).keyState, 'expired');
  for (const options of [{ universeId: '../123' }, { datastore: 'Default' }, { universeId: '123', datastore: ' ' }]) {
    assert.throws(() => checkKeyPermissions(identity([]), options), { code: 'ARGUMENT_ERROR' });
  }
});
test('inspectKey retains resource bounds and accepts inactive keys while identity rejects them', async () => {
  const calls: string[] = [];
  const payload = { authorizedUserId: 100, enabled: false, expired: true, scopes: [
    { name: 'asset', operations: ['read'], userIds: [100], groupIds: ['*'] },
    { name: 'developer-product', operations: ['read'], universeIds: ['123'] },
    { name: 'universe-datastores.objects', operations: ['read'], universeDatastores: [{ universeId: 123, datastoreName: 'Default' }] },
  ] };
  const api = new RobloxApi(new HttpClient({ intervalMs: 0, fetch: async (url, init) => {
    calls.push(String(url)); assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { apiKey: 'fictional' });
    return Response.json(payload);
  } }), 'fictional');
  const inspected = await api.inspectKey();
  assert.deepEqual(inspected.scopes[0]!.userIds, ['100']);
  assert.deepEqual(inspected.scopes[1]!.universeIds, ['123']);
  assert.deepEqual(inspected.scopes[2]!.universeDatastores, [{ universeId: '123', datastoreName: 'Default' }]);
  assert.equal(inspected.enabled, false); assert.ok(!JSON.stringify(inspected).includes('fictional'));
  await assert.rejects(api.identity(), { code: 'AUTH_INVALID' });
  assert.ok(calls.every(url => url === 'https://apis.roblox.com/api-keys/v1/introspect'));
});
test('malformed introspection resources fail closed', async () => {
  for (const resources of [{ universeIds: '123' }, { groupIds: [null] }, { universeDatastores: [{ universeId: 123, datastoreName: 12 }] }]) {
    const api = new RobloxApi(new HttpClient({ fetch: async () => Response.json({ authorizedUserId: 100, enabled: true, expired: false,
      scopes: [{ name: 'developer-product', operations: ['read'], ...resources }] }) }), 'fictional');
    await assert.rejects(api.inspectKey(), { code: 'INVALID_RESPONSE' });
  }
});
test('introspection accepts unrestricted DataStore targets with omitted optional datastoreName', async () => {
  for (const universeId of ['*', '123']) {
    const api = new RobloxApi(new HttpClient({ fetch: async () => Response.json({ authorizedUserId: 100, enabled: true, expired: false,
      scopes: [{ name: 'universe-datastores.objects', operations: ['read'], universeDatastores: [{ universeId }] }] }) }), 'fictional');
    const inspected = await api.inspectKey();
    assert.deepEqual(inspected.scopes[0]!.universeDatastores, [{ universeId, datastoreName: '*' }]);
    assert.equal(checkKeyPermissions(inspected, { feature: 'datastore-get', universeId: '123', datastore: 'Default' }).configurationState, 'configured');
    if (universeId !== '*') assert.equal(checkKeyPermissions(inspected, { feature: 'datastore-get', universeId: '456' }).configurationState, 'out-of-scope');
  }
});
test('compiled auth commands stay offline in fixtures, redact keys, return stable JSON and exit codes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-auth-permissions-'));
  try {
    const cli = (args: string[], mode = '') => spawnSync(process.execPath, ['--import', pathToFileURL(resolve('tests/fixtures/key-introspection.mjs')).href,
      resolve('dist/cli/main.js'), 'auth', ...args, '--home', home, '--json'], {
      encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: 'fictional-permission-key', RBX_TEST_KEY_STATE: mode },
    });
    const requirements = cli(['permissions', '--for', 'devproduct-sync']);
    assert.equal(requirements.status, 0, requirements.stderr);
    assert.equal(JSON.parse(requirements.stdout).data.features[0].id, 'devproduct-sync');
    for (const [mode, universe, status, state] of [
      ['', '123', 0, 'configured'], ['missing', '123', 3, 'missing'], ['', '456', 3, 'out-of-scope'], ['', undefined, 3, 'unknown'],
      ['disabled', '123', 4, 'configured'], ['expired', '123', 4, 'configured'],
    ] as const) {
      const child = cli(['check', '--for', 'devproduct-sync', ...(universe ? ['--universe', universe] : [])], mode);
      assert.equal(child.status, status, child.stdout + child.stderr); assert.equal(child.stderr, '');
      assert.equal(JSON.parse(child.stdout).data.configurationState, state);
      assert.ok(!child.stdout.includes('fictional-permission-key'));
    }
    for (const args of [['check', '--for', 'bad'], ['check', '--datastore', 'Default'], ['check', '--universe', '0']]) {
      assert.equal(cli(args).status, 2);
    }
    assert.equal(cli(['check'], 'denied').status, 5);
    assert.deepEqual(await readdir(home), []);
    const noKeyEnv = { ...process.env }; delete noKeyEnv.ROBLOX_API_KEY;
    for (const [args, status] of [[['permissions'], 0], [['check'], 4], [['check', '--for', 'bad'], 2]] as const) {
      const child = spawnSync(process.execPath, [resolve('dist/cli/main.js'), 'auth', ...args, '--home', home, '--json'], { encoding: 'utf8', env: noKeyEnv });
      assert.equal(child.status, status, child.stdout + child.stderr);
    }
    const local = new LocalStore(home), game = { ...savedGame(), universeId: '123', name: 'Fictional Game' };
    await local.saveConfig({ schemaVersion: 1, currentUserId: '100', accounts: { '100': { manualIds: [] } } });
    await local.saveCatalog(savedCatalog([game]));
    const named = cli(['check', '--for', 'devproduct-sync', '--universe', 'Fictional Game']);
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.equal(JSON.parse(named.stdout).data.universeId, '123');
  } finally { await rm(home, { recursive: true, force: true }); }
});
