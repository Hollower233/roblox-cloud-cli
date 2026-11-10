import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpClient, closeStudio, findStudioExecutable, openStudio, parseStudioProcess, resolveStudioTarget, type StudioSystem } from '../src/index.js';
import { AppError } from '../src/core/errors.js';

type Row = { pid: number; commandLine: string; title: string };
function fakeSystem(overrides: Partial<StudioSystem> & { rows?: Row[][] } = {}) {
  const launched: string[][] = [], focused: number[] = [], closed: number[] = [], killed: number[][] = [];
  let clock = 0, call = 0;
  const frames = overrides.rows ?? [[]];
  const system: StudioSystem = {
    platform: 'win32', localAppData: 'C:\\L',
    studioBuilds: async () => [{ executable: 'C:\\L\\old\\RobloxStudioBeta.exe', mtimeMs: 1 }, { executable: 'C:\\L\\new\\RobloxStudioBeta.exe', mtimeMs: 9 }],
    processes: async () => frames[Math.min(call++, frames.length - 1)]!,
    launch: async (exe, args) => { launched.push([exe, ...args]); return 500; },
    focus: async pid => { focused.push(pid); },
    closeWindow: async pid => { closed.push(pid); return true; },
    kill: async pids => { killed.push(pids); },
    sleep: async ms => { clock += ms; },
    now: () => clock,
    ...overrides,
  };
  return { system, launched, focused, closed, killed };
}
const edit = (pid: number, placeId: string, title = ''): Row => ({ pid, commandLine: `"C:\\x\\RobloxStudioBeta.exe" -task EditPlace -universeId 7 -placeId ${placeId}`, title });
const http = (routes: Record<string, unknown>) => new HttpClient({ intervalMs: 0, fetch: (async (url: string | URL) => {
  const body = routes[String(url)];
  return body === undefined ? new Response('{}', { status: 404 }) : Response.json(body);
}) as typeof fetch });

test('only edit sessions are parsed; Team Test servers and clients are ignored', () => {
  assert.deepEqual(parseStudioProcess({ pid: 1, commandLine: 'RobloxStudioBeta.exe --task EditPlace --placeId 11 --universeId 22', title: 'A - Roblox Studio' }), { pid: 1, placeId: '11', universeId: '22', title: 'A - Roblox Studio' });
  assert.equal(parseStudioProcess({ pid: 2, commandLine: 'RobloxStudioBeta.exe -task StartServer -placeId 11', title: '' }), null);
  assert.equal(parseStudioProcess({ pid: 3, commandLine: 'RobloxStudioBeta.exe -task StartClient -placeId 11', title: '' }), null);
  assert.equal(parseStudioProcess({ pid: 4, commandLine: 'RobloxStudioBeta.exe', title: 'Roblox Studio' }), null);
});
test('the newest Studio build is chosen and non-Windows is rejected', async () => {
  assert.equal(await findStudioExecutable(fakeSystem().system), 'C:\\L\\new\\RobloxStudioBeta.exe');
  await assert.rejects(findStudioExecutable(fakeSystem({ studioBuilds: async () => [] }).system), (e: AppError) => e.code === 'STUDIO_NOT_FOUND');
  await assert.rejects(findStudioExecutable(fakeSystem({ platform: 'linux' }).system), (e: AppError) => e.code === 'UNSUPPORTED_PLATFORM');
});
test('an already open place is focused instead of launched again', async () => {
  const { system, launched, focused } = fakeSystem({ rows: [[edit(42, '100', 'X - Roblox Studio')]] });
  const result = await openStudio(system, { placeId: '100', universeId: '7' });
  assert.equal(result.alreadyOpen, true); assert.equal(result.pid, 42); assert.equal(result.ready, true);
  assert.deepEqual(launched, []); assert.deepEqual(focused, [42]);
});
test('launch passes EditPlace arguments and waits for the loaded title, following PID hand-off', async () => {
  const { system, launched } = fakeSystem({ rows: [[], [edit(77, '100', 'Roblox Studio')], [edit(77, '100', 'Example Test - Roblox Studio')]] });
  const result = await openStudio(system, { placeId: '100', universeId: '7' }, { pollMs: 1000 });
  assert.deepEqual(launched, [['C:\\L\\new\\RobloxStudioBeta.exe', '-task', 'EditPlace', '-placeId', '100', '-universeId', '7']]);
  assert.equal(result.ready, true); assert.equal(result.pid, 77); assert.equal(result.title, 'Example Test - Roblox Studio');
});
test('no-wait returns immediately and a stuck load times out', async () => {
  const quick = await openStudio(fakeSystem().system, { placeId: '100', universeId: '7' }, { wait: false });
  assert.equal(quick.ready, false); assert.equal(quick.pid, 500);
  await assert.rejects(openStudio(fakeSystem().system, { placeId: '100', universeId: '7' }, { timeoutMs: 5000, pollMs: 1000 }), (e: AppError) => e.code === 'TIMEOUT');
});
test('targets resolve from the catalog first, then public endpoints', async () => {
  const games = [{ universeId: '7', name: 'Example Test', rootPlaceId: '100' }, { universeId: '8', name: 'Dup' }, { universeId: '9', name: 'dup' }];
  const none = http({});
  assert.deepEqual(await resolveStudioTarget(none, { game: 'example test' }, games), { placeId: '100', universeId: '7', name: 'Example Test' });
  assert.deepEqual(await resolveStudioTarget(none, { game: '7' }, games), { placeId: '100', universeId: '7', name: 'Example Test' });
  assert.deepEqual(await resolveStudioTarget(none, { place: '100' }, games), { placeId: '100', universeId: '7', name: 'Example Test' });
  await assert.rejects(resolveStudioTarget(none, { game: 'DUP' }, games), (e: AppError) => e.code === 'ARGUMENT_ERROR' && e.message.includes('8, 9'));
  await assert.rejects(resolveStudioTarget(none, { game: 'missing' }, games), (e: AppError) => e.code === 'ARGUMENT_ERROR');
  const remote = http({ 'https://develop.roblox.com/v1/universes/55': { id: 55, rootPlaceId: 555, name: 'Remote' }, 'https://apis.roblox.com/universes/v1/places/666/universe': { universeId: 66 } });
  assert.deepEqual(await resolveStudioTarget(remote, { game: '55' }), { placeId: '555', universeId: '55', name: 'Remote' });
  assert.deepEqual(await resolveStudioTarget(remote, { place: '666' }), { placeId: '666', universeId: '66' });
});
test('soft close asks windows to close and waits; a window left open (save prompt) stays pending', async () => {
  const a = { pid: 1, placeId: '100' }, b = { pid: 2, placeId: '200' };
  const { system, closed, killed } = fakeSystem({ rows: [[edit(1, '100'), edit(2, '200')], [edit(2, '200')]] });
  const results = await closeStudio(system, [a, b], { timeoutMs: 3000, pollMs: 1000 });
  assert.deepEqual(closed, [1, 2]); assert.deepEqual(killed, []);
  assert.deepEqual(results.map(r => [r.pid, r.state, r.forced]), [[1, 'closed', false], [2, 'pending', false]]);
});
test('force close terminates the editor together with its Team Test processes only', async () => {
  const rows = [edit(1, '100'),
    { pid: 5, commandLine: 'RobloxStudioBeta.exe -task StartServer -placeId 100 -editpid 1', title: '' },
    { pid: 6, commandLine: 'RobloxStudioBeta.exe -task StartClient -placeId 100 -editpid 1', title: '' },
    { pid: 7, commandLine: 'RobloxStudioBeta.exe -task StartClient -placeId 300 -editpid 9', title: '' }];
  const { system, closed, killed } = fakeSystem({ rows: [rows, []] });
  const [result] = await closeStudio(system, [{ pid: 1, placeId: '100' }], { force: true, pollMs: 1000 });
  assert.deepEqual(closed, []); assert.deepEqual(killed, [[1, 5, 6]]);
  assert.equal(result!.state, 'closed'); assert.deepEqual(result!.killedChildren, [5, 6]);
});
