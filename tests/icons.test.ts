import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IconAssets, IconCountdown, type CountdownClock, type CountdownEvent } from '../src/icons/countdown.js';
import { imageInfo, parseDuration, parseTargetTime, planCountdown, scanIconFolder, selectPending, type IconFrame } from '../src/icons/frames.js';
import { HttpClient } from '../src/transport/http-client.js';
import { LocalStore } from '../src/storage/store.js';

const H = 3_600_000, M = 60_000;
function png(size: number, height = size, seed = 0): Buffer {
  const data = Buffer.alloc(64, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'ascii'); data.writeUInt32BE(size, 16); data.writeUInt32BE(height, 20);
  return data;
}
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
}
async function folder(files: Record<string, Buffer | string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-icons-test-'));
  for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), data);
  return directory;
}
function frame(label: string, offsetMs: number): IconFrame {
  return { label, file: `${label}.png`, path: '', offsetMs, sha256: label, bytes: 1, format: 'png', width: 512, height: 512 };
}
function clock(start: number): CountdownClock & { t: number } {
  const c = { t: start, now: () => c.t, sleep: async (ms: number) => { c.t += ms; } };
  return c;
}

/** In-memory Roblox: images start Reviewing and become Approved (or Rejected) after `reviewPolls` reads. */
function fakeRoblox(c: { t: number }, options: { reject?: string[]; reviewPolls?: number; failPatchAt?: number; originalIcon?: string | null } = {}) {
  const calls = { uploads: [] as string[], patches: [] as { icon: string; at: number }[], requests: 0 };
  const place = { icon: options.originalIcon === undefined ? 'assets/555' : options.originalIcon, previous: null as string | null };
  const assets = new Map<string, { file: string; polls: number }>();
  let nextId = 7000;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.requests++;
    const url = new URL(String(input));
    // Private games: the public games API only returns placeholders, so the root place must come from Cloud v2.
    if (url.host === 'games.roblox.com') return json({ data: [{ id: 0, rootPlaceId: 0 }] });
    if (url.pathname === '/cloud/v2/universes/1') return json({ path: 'universes/1', rootPlace: 'universes/1/places/999', visibility: 'PRIVATE' });
    if (init?.method === 'POST' && url.pathname === '/assets/v1/assets') {
      const form = init.body as FormData, request = JSON.parse(String(form.get('request')));
      assert.deepEqual(request.creationContext.creator, { groupId: 200 });
      const file = (form.get('fileContent') as File).name, assetId = String(nextId++);
      assets.set(assetId, { file, polls: 0 }); calls.uploads.push(file);
      return json({ path: `operations/op-${assetId}`, done: false });
    }
    const operation = /^\/assets\/v1\/operations\/op-(\d+)$/.exec(url.pathname);
    if (operation) return json({ path: url.pathname.slice(11), done: true, response: { assetId: Number(operation[1]), moderationResult: { moderationState: 'Reviewing' } } });
    if (init?.method === 'PATCH') {
      assert.equal(url.pathname, '/assets/v1/assets/999'); assert.equal(url.searchParams.get('updateMask'), 'icon');
      assert.equal(new Headers(init.headers).get('content-type'), null, 'fetch must set the multipart boundary');
      const request = JSON.parse(String((init.body as FormData).get('request')));
      if (options.failPatchAt !== undefined && calls.patches.length === options.failPatchAt) { options.failPatchAt = undefined; return new Response(null, { status: 500 }); }
      calls.patches.push({ icon: request.icon, at: c.t }); place.previous = place.icon; place.icon = request.icon;
      return json({ path: 'operations/patch', done: true, response: { assetId: 999 } });
    }
    const asset = /^\/assets\/v1\/assets\/(\d+)$/.exec(url.pathname);
    if (asset && url.searchParams.get('readMask') === 'icon') {
      return json({ assetId: 999, ...(place.icon ? { icon: place.icon } : {}) });
    }
    if (asset) {
      const item = assets.get(asset[1]!);
      if (!item) return new Response(null, { status: 404 });
      item.polls++;
      const state = item.polls <= (options.reviewPolls ?? 1) ? 'Reviewing' : options.reject?.includes(item.file) ? 'Rejected' : 'Approved';
      return json({ assetId: Number(asset[1]), moderationResult: { moderationState: state } });
    }
    throw new Error(`Unexpected request ${init?.method} ${url}`);
  }) as typeof fetch;
  return { calls, assets, place, http: new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: fetcher, sleep: async () => {} }) };
}
function countdown(home: string, c: CountdownClock, http: HttpClient, events: CountdownEvent[] = []) {
  return new IconCountdown(new LocalStore(home), new IconAssets(http, c), { clock: c, onEvent: event => events.push(event) });
}
const creator = { type: 'Group' as const, id: '200' };

test('durations accept compact unit spellings used by real icon files', () => {
  for (const [text, ms] of [['3h', 3 * H], ['24hrs', 24 * H], ['1hr', H], ['30mins', 30 * M], ['1min', M], ['1h30m', 90 * M], ['45s', 45_000], ['1d', 24 * H], ['now', 0], ['0', 0], ['NOW', 0]] as const) assert.equal(parseDuration(text), ms, text);
  for (const text of ['', 'soon', '3', 'h3', '3x', '1.5h', '3h-']) assert.equal(parseDuration(text), null, text);
});
test('target times are local wall clock or ISO with an explicit zone', () => {
  assert.equal(parseTargetTime('2026-09-14 23:00'), new Date(2026, 8, 14, 23, 0, 0).getTime());
  assert.equal(parseTargetTime('2026-09-14T23:00:30'), new Date(2026, 8, 14, 23, 0, 30).getTime());
  assert.equal(parseTargetTime('2026-09-14T15:00:00Z'), Date.UTC(2026, 8, 14, 15));
  assert.equal(parseTargetTime('2026-09-14T23:00:00+08:00'), Date.UTC(2026, 8, 14, 15));
  for (const text of ['23:00', '2026-02-30 10:00', '2026-09-14T23:00:00.000', 'tomorrow']) assert.throws(() => parseTargetTime(text), /Target time/);
});
test('image headers decide format and dimensions', () => {
  assert.deepEqual(imageInfo(png(1024)), { format: 'png', width: 1024, height: 1024 });
  assert.deepEqual(imageInfo(jpeg(640, 480)), { format: 'jpeg', width: 640, height: 480 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
});
test('folder scan reports every invalid file together and warns on small icons', async () => {
  const bad = await folder({ '3h.png': png(512), 'soon.png': png(512), '1h.jpg': png(512, 300), '180m.png': png(512), 'now.png': Buffer.from('text'), 'notes.txt': 'ignored' });
  const good = await folder({ '3hrs.png': png(256), 'now.JPG': jpeg(512, 512), 'desktop.ini': 'ignored' });
  try {
    await assert.rejects(scanIconFolder(bad), (error: any) => {
      for (const part of ['soon.png', '1h.jpg: icon must be square', 'now.png: not a valid', 'same countdown offset']) assert.ok(error.message.includes(part), part);
      return error.code === 'ARGUMENT_ERROR';
    });
    const { frames, warnings } = await scanIconFolder(good);
    assert.deepEqual(frames.map(f => [f.label, f.offsetMs, f.format]), [['3hrs', 3 * H, 'png'], ['now', 0, 'jpeg']]);
    assert.deepEqual(warnings.map(w => [w.code, w.resource]), [['ICON_SMALL', '3hrs.png']]);
  } finally { await rm(bad, { recursive: true, force: true }); await rm(good, { recursive: true, force: true }); }
});
test('plan keeps offsets that fit the remaining time, needs now plus one countdown image', () => {
  const frames = [frame('24h', 24 * H), frame('3h', 3 * H), frame('2h', 2 * H), frame('now', 0)];
  const plan = planCountdown(frames, 10 * H, 10 * H - (2 * H + 50 * M));
  assert.deepEqual(plan.nodes.map(n => [n.label, n.fireAt]), [['2h', 8 * H], ['now', 10 * H]]);
  assert.deepEqual(plan.skipped.map(f => f.label), ['24h', '3h']);
  assert.equal(planCountdown(frames, 10 * H, 7 * H).nodes[0]!.label, '3h', 'an exact match is kept');
  assert.throws(() => planCountdown([frame('3h', 3 * H)], 10 * H, 0), /now image/);
  assert.throws(() => planCountdown([frame('3h', 3 * H), frame('now', 0)], 10 * H, 8 * H), /at least one countdown image/);
  assert.throws(() => planCountdown(frames, 10 * H, 10 * H), /not in the future/);
});
test('resuming runs only the latest overdue node and never goes backwards', () => {
  const nodes = planCountdown([frame('3h', 3 * H), frame('1h', H), frame('30m', 30 * M), frame('now', 0)], 10 * H, 7 * H).nodes;
  const late = selectPending(nodes, [3 * H], 10 * H - 20 * M);
  assert.deepEqual(late.toRun.map(n => n.label), ['30m', 'now']);
  assert.deepEqual(late.missed.map(n => n.label), ['1h']);
  assert.deepEqual(selectPending(nodes, [30 * M], 10 * H - 5 * M).toRun.map(n => n.label), ['now'], 'a completed later node skips earlier ones');
  assert.deepEqual(selectPending(nodes, [3 * H, 30 * M], 11 * H).toRun.map(n => n.label), ['now'], 'now still runs after the target passed');
  assert.deepEqual(selectPending(nodes, [0], 11 * H).toRun, []);
});

test('--at uploads first, waits for approval, then switches exactly on schedule and records completion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '24h.png': png(512, 512, 1), '3h.png': png(512, 512, 2), '1hr.png': png(512, 512, 3), 'now.png': png(512, 512, 4) });
  const c = clock(1_000_000), roblox = fakeRoblox(c, { reviewPolls: 2 }), events: CountdownEvent[] = [];
  const target = c.t + 3 * H + 10 * M;
  try {
    const result = await countdown(home, c, roblox.http, events).run({ universeId: '1', folder: icons, creator, target: { at: target } });
    assert.deepEqual(roblox.calls.uploads.sort(), ['1hr.png', '3h.png', 'now.png'], '24h cannot fit and is never uploaded');
    const planned = events.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>;
    const approvedAt = Date.parse(planned.plannedAt);
    assert.ok(events.findIndex(e => e.event === 'moderation') < events.indexOf(planned), 'moderation finishes before the plan');
    assert.ok(roblox.calls.patches.every(p => p.at >= approvedAt));
    const assetFor = (file: string) => [...roblox.assets].find(([, a]) => a.file === file)![0];
    assert.deepEqual(roblox.calls.patches, [
      { icon: `assets/${assetFor('3h.png')}`, at: target - 3 * H },
      { icon: `assets/${assetFor('1hr.png')}`, at: target - H },
      { icon: `assets/${assetFor('now.png')}`, at: target },
    ]);
    assert.equal(result.originalIconAssetId, '555'); assert.equal(result.placeId, '999'); assert.equal(result.alreadyCompleted, false);
    assert.deepEqual(planned.skipped, ['24h.png']);
    const requests = roblox.calls.requests;
    const again = await countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: target } });
    assert.equal(again.alreadyCompleted, true); assert.equal(roblox.calls.requests, requests, 'a finished run makes no requests');
    assert.deepEqual(await readdir(join(home, 'icon-countdown', 'locks')), [], 'lock is released');
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('any rejection aborts before switching; the rejection is cached so a re-run does not upload again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '3h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reject: ['now.png'] });
  const options = { universeId: '1', folder: icons, creator, target: { at: 4 * H } };
  try {
    await assert.rejects(countdown(home, c, roblox.http).run(options), (e: any) => e.code === 'MODERATION_REJECTED' && e.message.includes('now.png') && !e.message.includes('3h.png'));
    assert.equal(roblox.calls.patches.length, 0); assert.equal(roblox.calls.uploads.length, 2);
    await assert.rejects(countdown(home, c, roblox.http).run(options), { code: 'MODERATION_REJECTED' });
    assert.equal(roblox.calls.uploads.length, 2, 'cached assets are reused');
    await assert.rejects(countdown(home, c, roblox.http).run({ ...options, noCache: true }), { code: 'MODERATION_REJECTED' });
    assert.equal(roblox.calls.uploads.length, 4, '--no-cache uploads again');
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('moderation that never finishes times out without switching', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '3h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reviewPolls: 10_000 });
  try {
    await assert.rejects(countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: 4 * H }, moderationTimeoutMs: 10 * M }), (e: any) => e.code === 'MODERATION_TIMEOUT' && e.message.includes('3h.png'));
    assert.equal(roblox.calls.patches.length, 0);
    assert.equal(c.t, 10 * M + 2000 * 2, 'waits until the timeout (plus two upload operation polls)');
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('a failed switch exits; re-running resumes from cache and catches up only the latest overdue node', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '3h.png': png(512, 512, 1), '1h.png': png(512, 512, 2), '30m.png': png(512, 512, 3), 'now.png': png(512, 512, 4) });
  const c = clock(0), roblox = fakeRoblox(c, { failPatchAt: 1 }), target = 3 * H + 5 * M;
  const options = { universeId: '1', folder: icons, creator, target: { at: target } };
  try {
    await assert.rejects(countdown(home, c, roblox.http).run(options), /HTTP 500/);
    assert.equal(roblox.calls.patches.length, 1); assert.equal(c.t, target - H);
    c.t = target - 20 * M;
    const events: CountdownEvent[] = [];
    await countdown(home, c, roblox.http, events).run(options);
    assert.equal(roblox.calls.uploads.length, 4, 'no re-upload on resume');
    assert.deepEqual(roblox.calls.patches.map(p => p.at), [target - 3 * H, target - 20 * M, target]);
    const planned = events.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>;
    assert.equal(planned.resumed, true);
    assert.deepEqual(planned.nodes.map(n => n.status), ['done', 'missed', 'pending', 'pending']);
    assert.deepEqual(events.filter(e => e.event === 'missed'), [{ event: 'missed', labels: ['1h'] }]);
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('--in counts from approval, resumes the same target, and --reset starts over', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '3hrs.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reviewPolls: 3 });
  const options = { universeId: '1', folder: icons, creator, target: { inMs: 3 * H } };
  const controller = new AbortController();
  const interrupted: CountdownClock = { now: () => c.t, sleep: async ms => { c.t += ms; if (c.t > H) { controller.abort(); throw new Error('interrupted'); } } };
  try {
    const events: CountdownEvent[] = [];
    await assert.rejects(new IconCountdown(new LocalStore(home), new IconAssets(roblox.http, c), { clock: interrupted, onEvent: e => events.push(e) }).run(options), /interrupted/);
    const planned = events.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>;
    const target = Date.parse(planned.target);
    assert.equal(target - Date.parse(planned.plannedAt), 3 * H, 'duration starts when moderation passes');
    assert.ok(Date.parse(planned.plannedAt) > 0);
    assert.deepEqual(roblox.calls.patches.map(p => p.at), [Date.parse(planned.plannedAt)], '3h image goes up immediately');
    const preview = await new IconCountdown(new LocalStore(home), null, { clock: c }).preview(options);
    assert.equal(preview.resumed, true); assert.equal(Date.parse(preview.target), target);
    await assert.rejects(countdown(home, c, roblox.http).run({ ...options, target: { inMs: 2 * H } }), /--reset/);
    await countdown(home, c, roblox.http).run(options);
    assert.deepEqual(roblox.calls.patches.map(p => p.at), [Date.parse(planned.plannedAt), target]);
    assert.deepEqual(await readdir(join(home, 'icon-countdown', 'anchors')), [], 'anchor is dropped after completion');
    const fresh = await new IconCountdown(new LocalStore(home), null, { clock: c }).preview(options);
    assert.equal(fresh.resumed, false, 'a completed --in countdown does not block a new one');
    const events2: CountdownEvent[] = [];
    c.t += H;
    const stuck: CountdownClock = { now: () => c.t, sleep: async ms => { c.t += ms; if (c.t > target + 2 * H) throw new Error('stop'); } };
    await assert.rejects(new IconCountdown(new LocalStore(home), new IconAssets(roblox.http, c), { clock: stuck, onEvent: e => events2.push(e) }).run(options), /stop/);
    const reset: CountdownEvent[] = [];
    await countdown(home, c, roblox.http, reset).run({ ...options, reset: true });
    const first = events2.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>, second = reset.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>;
    assert.equal(second.resumed, false); assert.ok(Date.parse(second.target) > Date.parse(first.target));
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('preview is offline and a live lock blocks a second countdown while a dead one is taken over', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '1h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reviewPolls: 0 });
  try {
    const preview = await new IconCountdown(new LocalStore(home), null, { clock: c }).preview({ universeId: '1', folder: icons, creator, target: { at: 90 * M } });
    assert.deepEqual(preview.nodes.map(n => [n.label, n.status]), [['1h', 'pending'], ['now', 'pending']]);
    await assert.rejects(readdir(join(home, 'icon-countdown')), { code: 'ENOENT' });
    await mkdir(join(home, 'icon-countdown', 'locks'), { recursive: true });
    const lock = join(home, 'icon-countdown', 'locks', '1.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    await assert.rejects(countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: 90 * M } }), { code: 'STORAGE_LOCKED' });
    await writeFile(lock, JSON.stringify({ pid: 2 ** 30 }));
    await countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: 90 * M } });
    const state = JSON.parse(await readFile(join(home, 'icon-countdown', 'runs', `1-${90 * M}.json`), 'utf8'));
    assert.ok(state.finishedAt); assert.deepEqual(Object.keys(state.completed).sort(), ['0', String(H)]);
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('PATCH multipart requests are sent once without a JSON content type', async () => {
  let calls = 0;
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, sleep: async () => {}, fetch: (async (_input, init) => {
    calls++; assert.equal(init?.method, 'PATCH'); assert.ok(init.body instanceof FormData);
    assert.equal(new Headers(init.headers).get('content-type'), null);
    return new Response(null, { status: 503 });
  }) as typeof fetch });
  const form = new FormData(); form.append('request', '{}');
  await assert.rejects(http.request('https://apis.roblox.com/assets/v1/assets/1', { auth: true, method: 'PATCH', form }), /HTTP 503/);
  assert.equal(calls, 1);
  await assert.rejects(http.request('https://apis.roblox.com/x', { method: 'GET', body: {} }), { code: 'ARGUMENT_ERROR' });
});

test('--restore-after switches back to the original icon after now, and resumes while waiting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '1h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reviewPolls: 0 }), target = 2 * H;
  const options = { universeId: '1', folder: icons, creator, target: { at: target }, restoreAfterMs: H };
  const events: CountdownEvent[] = [];
  const stopAfterNow: CountdownClock = { now: () => c.t, sleep: async ms => { c.t += ms; if (c.t > target + 10 * M) throw new Error('interrupted'); } };
  try {
    const preview = await new IconCountdown(new LocalStore(home), null, { clock: c }).preview(options);
    assert.equal(Date.parse(preview.restoreAt!), target + H);
    await assert.rejects(new IconCountdown(new LocalStore(home), new IconAssets(roblox.http, c), { clock: stopAfterNow, onEvent: e => events.push(e) }).run(options), /interrupted/);
    const planned = events.find(e => e.event === 'planned') as Extract<CountdownEvent, { event: 'planned' }>;
    assert.equal(Date.parse(planned.restoreAt!), target + H);
    assert.ok(events.some(e => e.event === 'restore-waiting'));
    await assert.rejects(countdown(home, c, roblox.http).run({ ...options, restoreAfterMs: undefined }), /--restore-after/);
    const done: CountdownEvent[] = [];
    const result = await countdown(home, c, roblox.http, done).run(options);
    assert.equal(result.restore, 'restored');
    assert.deepEqual(roblox.calls.patches.map(p => p.at), [target - H, target, target + H]);
    assert.equal(roblox.calls.patches.length, 3);
    assert.equal(roblox.calls.patches.at(-1)!.icon, 'assets/555');
    assert.ok(done.some(e => e.event === 'restored'));
    assert.equal((await countdown(home, c, roblox.http).run(options)).alreadyCompleted, true);
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('restore is skipped when someone else changed the icon, and refused when there is no original icon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '1h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0), roblox = fakeRoblox(c, { reviewPolls: 0 }), target = 2 * H;
  const manual: CountdownClock = { now: () => c.t, sleep: async ms => { c.t += ms; if (c.t > target + M) roblox.place.icon = 'assets/4242'; } };
  try {
    const events: CountdownEvent[] = [];
    const result = await new IconCountdown(new LocalStore(home), new IconAssets(roblox.http, c), { clock: manual, onEvent: e => events.push(e) }).run({ universeId: '1', folder: icons, creator, target: { at: target }, restoreAfterMs: H });
    assert.equal(result.restore, 'skipped'); assert.equal(roblox.calls.patches.length, 2);
    assert.deepEqual(events.find(e => e.event === 'restore-skipped'), { event: 'restore-skipped', currentIconAssetId: '4242', at: new Date(target + H).toISOString() });
    const bare = fakeRoblox(c, { reviewPolls: 0, originalIcon: null });
    await assert.rejects(countdown(home, c, bare.http).run({ universeId: '1', folder: icons, creator, target: { at: c.t + 3 * H }, restoreAfterMs: H }), /no custom icon/);
    assert.equal(bare.calls.uploads.length, 0, 'refused before uploading');
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});

test('stale icon reads: original needs agreeing reads, a countdown image as original is refused, restore still switches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rbx-icons-home-')), icons = await folder({ '1h.png': png(512, 512, 1), 'now.png': png(512, 512, 2) });
  const c = clock(0);
  try {
    const flaky = fakeRoblox(c, { reviewPolls: 0 });
    const flip = new IconAssets(flaky.http, c);
    let reads = 0;
    const original = flip.placeIcon.bind(flip);
    flip.placeIcon = async placeId => (reads++ === 1 ? '111' : original(placeId));
    assert.equal(await flip.stablePlaceIcon('999'), '555');
    assert.equal(reads, 5, 'one stale read restarts the agreement streak');
    const always = new IconAssets(flaky.http, c);
    let toggle = false;
    always.placeIcon = async () => ((toggle = !toggle) ? '1' : '2');
    await assert.rejects(always.stablePlaceIcon('999'), /inconsistent/);

    // First countdown leaves now.png on the place; reusing it with --restore-after must be refused before switching.
    const roblox = fakeRoblox(c, { reviewPolls: 0 });
    await countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: c.t + 2 * H } });
    const patches = roblox.calls.patches.length;
    await assert.rejects(countdown(home, c, roblox.http).run({ universeId: '1', folder: icons, creator, target: { at: c.t + 2 * H }, restoreAfterMs: H }), /one of the countdown images/);
    assert.equal(roblox.calls.patches.length, patches);

    // A stale read showing an earlier countdown image at restore time still restores (and always sends the switch).
    const home2 = await mkdtemp(join(tmpdir(), 'rbx-icons-home-'));
    try {
      const stale = fakeRoblox(c, { reviewPolls: 0 }), t = c.t + 2 * H;
      // After now, reads keep showing the earlier 1h image (or the original) instead of now.png.
      const lagging: CountdownClock = { now: () => c.t, sleep: async ms => { c.t += ms; if (c.t > t + M && stale.place.previous) stale.place.icon = stale.place.previous; } };
      const result = await new IconCountdown(new LocalStore(home2), new IconAssets(stale.http, c), { clock: lagging }).run({ universeId: '1', folder: icons, creator, target: { at: t }, restoreAfterMs: H });
      assert.equal(result.restore, 'restored');
      assert.equal(stale.calls.patches.length, 3, 'the restore switch is sent even though the read looked like ours');
      assert.equal(stale.calls.patches.at(-1)!.icon, 'assets/555');
    } finally { await rm(home2, { recursive: true, force: true }); }
  } finally { await rm(home, { recursive: true, force: true }); await rm(icons, { recursive: true, force: true }); }
});
