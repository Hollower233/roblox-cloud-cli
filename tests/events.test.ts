import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { GameEvents, HttpClient, eventId, eventTime, eventRules, eventTextSummary, getEventImageOperation, permissionFeatures, checkKeyPermissions, uploadEventImage, validateEventFields, type CreateEventFields } from '../src/index.js';

const eid = '9007199254740993123';
const fields: CreateEventFields = { title: 'Example festival', subtitle: 'Example subtitle', description: 'Fictional event', startTime: '2026-12-01T18:00:00Z', endTime: '2026-12-01T19:00:00Z', visibility: 'private', categories: [{ category: 'festival', rank: 0 }], thumbnails: [{ mediaId: 42, rank: 0 }] };
const event = (extra = {}) => ({ ...fields, id: eid, universeId: 123, placeId: 11, ...extra });
function mock(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, retries = 0) {
  return new HttpClient({ apiKey: 'fictional-key', intervalMs: 0, retries, sleep: async () => {}, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.host, 'apis.roblox.com');
    assert.equal((init!.headers as Record<string, string>)['x-api-key'], 'fictional-key');
    return handler(url, init!);
  } });
}
async function temporary(action: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'rbx-events-'));
  try { await action(home); } finally { await rm(home, { recursive: true, force: true }); }
}
test('event IDs preserve precision; writable fields, dates, timezone and ranked arrays are validated', () => {
  assert.equal(eventId(eid), eid);
  assert.equal(eventTime('2026-12-01T10:00:00-08:00'), fields.startTime.replace('Z', '.000Z'));
  for (const value of ['0', '01', '../1', '1?fields=id', '123456789012345678901', 9007199254740992]) assert.throws(() => eventId(value as string), { code: 'ARGUMENT_ERROR' });
  for (const value of ['2026-12-01T18:00:00', '2026-02-30T00:00:00Z', '2026-12-01T24:00:00Z', '2026-13-01T00:00:00Z']) assert.throws(() => eventTime(value), { code: 'ARGUMENT_ERROR' });
  for (const patch of [{ visibility: 'moderated' }, { title: '' }, { startTime: null }, { description: 'x'.repeat(1001) }, { placeId: 1.5 }, { categories: [{ category: 'bad', rank: 0 }] }, { categories: [{ category: 'quest', rank: 0 }, { category: 'quest', rank: 1 }] }, { thumbnails: [{ mediaId: 42, rank: 0 }, { mediaId: 43, rank: 0 }] }, { groupId: 10 }, { unexpected: true }, {}]) {
    assert.throws(() => validateEventFields(patch), { code: 'ARGUMENT_ERROR' });
  }
  assert.throws(() => validateEventFields({ ...fields, endTime: fields.startTime }, true), { code: 'ARGUMENT_ERROR' });
  assert.throws(() => validateEventFields({ title: 'Incomplete' }, true), { code: 'ARGUMENT_ERROR' });
  assert.deepEqual(validateEventFields({ description: '', thumbnails: [], categories: [] }), { description: '', thumbnails: [], categories: [] });
});
test('text limits match Creator Dashboard: 25/25/1000 UTF-16 units, including emoji components', () => {
  for (const field of ['title', 'subtitle', 'description'] as const) {
    const limit = field === 'description' ? 1000 : 25;
    for (const value of ['a'.repeat(limit), '中'.repeat(limit)]) assert.equal(validateEventFields({ [field]: value })[field], value);
    assert.throws(() => validateEventFields({ [field]: 'a'.repeat(limit + 1) }), error => {
      assert.match((error as Error).message, new RegExp(`${field}.*${limit + 1}/${limit}.*1 over.*events rules`)); return true;
    });
  }
  // The visually similar title with VS16 is 26 units; without it, 25.
  assert.throws(() => validateEventFields({ title: '🛍️ Trading Plaza Is Here!' }), /26\/25/);
  const title = '🛍 Trading Plaza Is Here!';
  assert.equal(validateEventFields({ title }).title, title);
  assert.equal(validateEventFields({ title: '😀'.repeat(12) + 'a' }).title, '😀'.repeat(12) + 'a');
  assert.throws(() => validateEventFields({ title: '😀'.repeat(13) }), /26\/25/);
  assert.throws(() => validateEventFields({ subtitle: '🤝 Trade items & check prices!' }), /30\/25/);
  const joined = '👩‍💻'; // 2 + 1 (joiner) + 2 units, one visible emoji.
  assert.equal(eventTextSummary({ title: joined.repeat(5) }).text[0]!.length, 25);
  assert.throws(() => validateEventFields({ title: joined.repeat(5) + '!' }), /26\/25/);
  assert.equal(eventTextSummary({ title: 'e\u0301' }).text[0]!.length, 2);
  assert.equal(validateEventFields({ title: '  Example  ' }).title, '  Example  ');
  assert.throws(() => validateEventFields({ subtitle: '  ' }), /must not be empty/);
  assert.deepEqual(eventTextSummary({ description: '' }).text, [{ field: 'description', length: 0, maxLength: 1000, remaining: 1000 }]);
  const rules = eventRules(); rules.source.note = 'modified copy';
  assert.notEqual(eventRules().source.note, 'modified copy');
});
test('oversized text is rejected by SDK before any request, including create/update previews', async () => {
  let calls = 0;
  const client = new GameEvents(mock(() => { calls++; throw new Error('Must not request'); }));
  for (const dryRun of [true, false]) {
    await assert.rejects(client.create('123', { ...fields, title: 'x'.repeat(26) }, { dryRun }), /title.*26\/25/);
    await assert.rejects(client.update(eid, { subtitle: 'x'.repeat(26) }, { dryRun }), /subtitle.*26\/25/);
  }
  assert.equal(calls, 0);
});
test('ambiguous Roblox text rejection gives rules guidance without claiming a length failure', async () => {
  const client = new GameEvents(mock(() => Response.json({ title: 'Invalid request.', detail: 'InvalidTitleOrDescriptionException' }, { status: 400 })));
  await assert.rejects(client.create('123', fields), error => {
    assert.match((error as Error).message, /events rules.*moderation/);
    assert.doesNotMatch((error as Error).message, /too long/); return true;
  });
});
test('list aggregates pages, encodes cursors, preserves IDs, and --all includes finished events', async () => {
  let calls = 0;
  const rows = await new GameEvents(mock((url, init) => {
    calls++; assert.equal(init.method, 'GET');
    assert.equal(url.searchParams.get('endsAfter'), '1970-01-01T00:00:00.000Z');
    assert.equal(url.searchParams.get('visibility'), 'private');
    assert.equal(url.searchParams.get('pageSize'), '100');
    if (calls === 1) return Response.json({ gameEvents: [event()], nextPageToken: 'a/+?' });
    assert.equal(url.searchParams.get('pageToken'), 'a/+?');
    return Response.json({ gameEvents: [event(), event({ id: '9007199254740993124' })], nextPageToken: null });
  })).list('123', { all: true, visibility: 'private' });
  assert.equal(calls, 2); assert.deepEqual(rows.map(row => row.id), [eid, '9007199254740993124']);
});
test('malformed resources, mismatched universes and cyclic pagination are rejected', async () => {
  for (const value of [{ gameEvents: [event()], nextPageToken: 'again' }, { gameEvents: {} }, { gameEvents: [event({ universeId: 456 })] }, { gameEvents: [event({ id: 9007199254740992 })] }]) {
    await assert.rejects(new GameEvents(mock(() => Response.json(value))).list('123'), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(new GameEvents(mock(() => Response.json(event({ id: '7' })))).get(eid), { code: 'INVALID_RESPONSE' });
});
test('create dry-run never requests; submitted create backs up, posts once and verifies requested fields', async () => temporary(async home => {
  let writes = 0;
  const client = new GameEvents(mock((url, init) => {
    if (init.method === 'POST') {
      writes++; assert.equal(url.pathname, '/virtual-events/v3/universes/123/game-events');
      const body = JSON.parse(String(init.body));
      assert.equal(body.startTime, '2026-12-01T18:00:00.000Z');
      assert.equal(body.universeId, undefined);
    } else assert.equal(url.pathname, `/virtual-events/v3/game-events/${eid}`);
    return Response.json(event({ allThumbnailsCreated: true }));
  }));
  assert.equal((await client.create('123', fields, { dryRun: true, backupDirectory: home })).state, 'planned');
  assert.equal(writes, 0); assert.deepEqual(await readdir(home), []);
  const result = await client.create('123', fields, { backupDirectory: home });
  assert.equal(writes, 1); assert.equal(result.state, 'verified'); assert.equal(result.response!.id, eid);
  assert.equal(JSON.parse(await readFile(result.backupPath!, 'utf8')).before, null);
  assert.equal(JSON.parse(await readFile(`${result.backupPath}.result.json`, 'utf8')).response.id, eid);
}));
test('partial updates back up original metadata and only patch supplied fields; one-sided time edits are checked', async () => temporary(async home => {
  const methods: string[] = []; let changed = false;
  const client = new GameEvents(mock((_url, init) => {
    methods.push(init.method!);
    if (init.method === 'PATCH') { assert.deepEqual(JSON.parse(String(init.body)), { description: '' }); changed = true; }
    return Response.json(event(changed ? { description: '' } : {}));
  }));
  const result = await client.update(eid, { description: '' }, { backupDirectory: home });
  assert.equal(result.state, 'verified'); assert.deepEqual(methods, ['GET', 'PATCH', 'GET']);
  assert.equal(JSON.parse(await readFile(result.backupPath!, 'utf8')).before.description, fields.description);
  await assert.rejects(client.update(eid, { startTime: '2026-12-02T18:00:00Z' }), { code: 'ARGUMENT_ERROR' });
  assert.equal(methods.filter(method => method === 'PATCH').length, 1);
}));
test('create with a group host verifies host ownership rather than ignoring groupId', async () => {
  for (const hostId of [456, 789]) {
    const result = await new GameEvents(mock(() => Response.json(event({ host: { hostType: 'group', hostId } })))).create('123', { ...fields, groupId: 456 });
    assert.equal(result.state, hostId === 456 ? 'verified' : 'unverified');
  }
});
test('uncertain submissions, readback errors, thumbnail partial success and mismatches never auto-retry writes', async () => {
  for (const failure of ['network', '500', 'malformed', 'readback', 'mismatch', 'thumbnails', 'wrong-universe']) {
    let writes = 0;
    const client = new GameEvents(mock((_url, init) => {
      if (init.method === 'POST') {
        writes++;
        if (failure === 'network') throw new Error('Disconnected');
        if (failure === '500') return new Response(null, { status: 500 });
        if (failure === 'malformed') return Response.json({});
        return Response.json(event({ allThumbnailsCreated: failure !== 'thumbnails' }));
      }
      if (failure === 'readback') return new Response(null, { status: 403 });
      return Response.json(event({ ...(failure === 'mismatch' ? { title: 'Different' } : {}), ...(failure === 'wrong-universe' ? { universeId: 456 } : {}) }));
    }, 2));
    const result = await client.create('123', fields);
    assert.equal(writes, 1, failure); assert.equal(result.state, 'unverified', failure); assert.ok(result.error);
  }
  await assert.rejects(new GameEvents(mock(() => new Response(null, { status: 403 }))).create('123', fields), { code: 'FORBIDDEN' });
});
test('delete dry-run reads only; real deletion backs up and handles 204; ambiguous responses remain unverified', async () => temporary(async home => {
  for (const status of [204, 200, 500]) {
    let deletes = 0;
    const client = new GameEvents(mock((_url, init) => {
      if (init.method === 'DELETE') { deletes++; return new Response(null, { status }); }
      return Response.json(event());
    }, 2));
    assert.equal((await client.delete(eid, { dryRun: true })).state, 'planned'); assert.equal(deletes, 0);
    const result = await client.delete(eid, { backupDirectory: home });
    assert.equal(result.state, status === 204 ? 'verified' : 'unverified'); assert.equal(deletes, 1);
    assert.equal(JSON.parse(await readFile(result.backupPath!, 'utf8')).before.id, eid);
  }
}));
test('backup failure and invalid input prevent mutation', async () => temporary(async home => {
  const file = join(home, 'not-a-directory'); await writeFile(file, 'example');
  const client = new GameEvents(mock(() => { throw new Error('Must not request'); }));
  await assert.rejects(client.create('123', fields, { backupDirectory: file }), { code: 'STORAGE_ERROR' });
  await assert.rejects(client.create('bad', fields), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(client.update(eid, {}), { code: 'ARGUMENT_ERROR' });
}));
test('image upload validates locally, uses explicit creator, persists operation and returns reusable media ID', async () => temporary(async home => {
  const image = join(home, 'example.png');
  await sharp({ create: { width: 16, height: 9, channels: 4, background: '#12345678' } }).png().toFile(image);
  let writes = 0;
  const http = mock((_url, init) => {
    if (init.method === 'POST') {
      writes++;
      const form = init.body as FormData, request = JSON.parse(String(form.get('request')));
      assert.deepEqual(request.creationContext.creator, { groupId: 123 }); assert.equal(request.assetType, 'Image');
      assert.ok(form.get('fileContent') instanceof Blob);
      return Response.json({ path: 'operations/example_op', done: false });
    }
    return Response.json({ done: true, response: { assetId: '42', moderationResult: { moderationState: 'Reviewing' } } });
  });
  const options = { creator: { type: 'Group' as const, id: '123' }, backupDirectory: join(home, 'backups'), sleep: async () => {} };
  assert.equal((await uploadEventImage(http, image, { ...options, dryRun: true })).state, 'planned'); assert.equal(writes, 0);
  const result = await uploadEventImage(http, image, options);
  assert.equal(writes, 1); assert.equal(result.state, 'verified'); assert.equal(result.response!.mediaId, '42'); assert.equal(result.response!.moderationState, 'Reviewing');
  assert.equal(JSON.parse(await readFile(`${result.backupPath}.result.json`, 'utf8')).operationId, 'operations/example_op');
  assert.ok((await readFile(`${result.backupPath}.png`)).length > 0);
  assert.equal(JSON.parse(await readFile(`${result.backupPath}.operation.json`, 'utf8')).operationId, 'operations/example_op');
  await assert.rejects(uploadEventImage(http, join(home, 'missing'), options), { code: 'ARGUMENT_ERROR' }); assert.equal(writes, 1);
}));
test('image upload network ambiguity and 5xx preserve uncertainty without repeating upload', async () => temporary(async home => {
  const image = join(home, 'example.png'); await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toFile(image);
  for (const failure of ['network', 'server']) {
    let writes = 0;
    const result = await uploadEventImage(mock((_url, init) => {
      assert.equal(init.method, 'POST'); writes++;
      if (failure === 'network') throw new Error('Connection lost');
      return new Response(null, { status: 500 });
    }, 2), image, { creator: { type: 'User', id: '123' }, backupDirectory: home });
    assert.equal(writes, 1); assert.equal(result.state, 'unverified'); assert.ok(result.error);
  }
}));
test('pending image upload retains operation for read-only follow-up; failures are not resubmitted', async () => temporary(async home => {
  const image = join(home, 'example.png'); await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toFile(image);
  let writes = 0;
  const pending = await uploadEventImage(mock((_url, init) => {
    if (init.method === 'POST') writes++;
    return Response.json({ path: 'operations/still_pending', done: false });
  }), image, { creator: { type: 'User', id: '123' }, backupDirectory: home, sleep: async () => {} });
  assert.equal(writes, 1); assert.equal(pending.state, 'pending'); assert.equal(pending.operationId, 'operations/still_pending');
  const result = await getEventImageOperation(mock((url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(url.pathname, '/assets/v1/operations/still_pending');
    return Response.json({ done: true, response: { assetId: '42' } });
  }), pending.operationId!);
  assert.equal(result.response!.mediaId, '42');
  const failed = await getEventImageOperation(mock(() => Response.json({ done: true, error: { message: 'untrusted body' } })), 'failed');
  assert.equal(failed.state, 'unverified'); assert.doesNotMatch(JSON.stringify(failed), /untrusted body/);
  await assert.rejects(getEventImageOperation(mock(() => { throw new Error(); }), '../escape'), { code: 'ARGUMENT_ERROR' });
}));
test('permission catalog separates event reads, writes, uploads and asset operation reads', () => {
  assert.deepEqual(permissionFeatures('events-write')[0]!.requirements.map(row => row.scope), ['universe.event:read', 'universe.event:write']);
  assert.deepEqual(permissionFeatures('events-image-read')[0]!.requirements.map(row => row.scope), ['asset:read']);
  const checked = checkKeyPermissions({ userId: '1', enabled: true, expired: false, scopes: [{ name: 'universe.event', operations: ['read'], universeIds: ['123'] }] }, { feature: 'events-read', universeId: '456' });
  assert.equal(checked.configurationState, 'out-of-scope');
});

const preload = `globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const row = ${JSON.stringify(event())};
  if (url.pathname.includes('/universes/')) return Response.json({gameEvents:[row]});
  if (init.method === 'DELETE') return new Response(null,{status:204});
  return Response.json(row);
};`;
function cli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve('dist/cli/main.js'), '--home', home, '--json', 'events', ...args], { encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: 'fictional-key' }, timeout: 10000 });
}
test('CLI exposes categories, filters, JSON files, dry-run and partial exit code 3', async () => temporary(async home => {
  const listed = cli(home, 'list', '123', '--all');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr); assert.equal(JSON.parse(listed.stdout).data.events[0].id, eid);
  const got = cli(home, 'get', eid); assert.equal(got.status, 0, got.stdout + got.stderr);
  const file = join(home, 'event.json'); await writeFile(file, JSON.stringify(fields));
  const preview = cli(home, 'create', '123', '--file', file, '--dry-run');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr); assert.equal(JSON.parse(preview.stdout).data.state, 'planned');
  assert.deepEqual(JSON.parse(preview.stdout).data.validation.text[0], { field: 'title', length: fields.title.length, maxLength: 25, remaining: 25 - fields.title.length });
  const flags = cli(home, 'create', '123', '--title', 'Example', '--subtitle', 'Example', '--start', fields.startTime, '--end', fields.endTime, '--visibility', 'private', '--category', 'festival', '--thumbnail', '42', '--dry-run');
  assert.equal(flags.status, 0, flags.stdout + flags.stderr); assert.equal(JSON.parse(flags.stdout).data.request.body.thumbnails[0].mediaId, 42);
  const categories = cli(home, 'categories'); assert.equal(categories.status, 0); assert.ok(JSON.parse(categories.stdout).data.categories.includes('festival'));
  const update = cli(home, 'update', eid, '--title', 'Different title');
  assert.equal(update.status, 3, update.stdout + update.stderr); assert.equal(JSON.parse(update.stdout).data.state, 'unverified');
  const deletion = cli(home, 'delete', eid); assert.equal(deletion.status, 0, deletion.stdout + deletion.stderr);
  for (const args of [['create', '123', '--file', file, '--title', 'conflict'], ['create', '123', '--title', 'incomplete'], ['update', eid], ['get', '../bad'], ['upload-image', 'missing.png']]) {
    const result = cli(home, ...args); assert.equal(result.status, 2, result.stdout + result.stderr);
  }
}));

test('CLI rules is offline and invalid text fails before credentials for flags and JSON files', async () => temporary(async home => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw Error("No network allowed")}', resolve('dist/cli/main.js'), '--home', home, '--json', 'events', ...args], { encoding: 'utf8', env: { ...process.env, ROBLOX_API_KEY: '' }, timeout: 10000 });
  const rules = run('rules'); assert.equal(rules.status, 0, rules.stdout + rules.stderr);
  const data = JSON.parse(rules.stdout).data;
  assert.equal(data.counting, 'utf16-code-units'); assert.equal(data.text.title.maxLength, 25); assert.equal(data.text.subtitle.maxLength, 25); assert.equal(data.text.description.maxLength, 1000);
  const file = join(home, 'oversized.json'); await writeFile(file, JSON.stringify({ ...fields, subtitle: '🤝 Trade items & check prices!' }));
  for (const args of [['create', '123', '--title', '🛍️ Trading Plaza Is Here!', '--dry-run'], ['create', '123', '--file', file, '--dry-run'], ['update', eid, '--subtitle', 'x'.repeat(26)]]) {
    const result = run(...args); assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).error.message, /UTF-16.*events rules/);
  }
}));
