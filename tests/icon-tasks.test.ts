import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { DEFAULT_ICON_NODES, generateIconImages, iconNodes, renderIcon } from '../src/icons/render.js';
import { IconTasks, type IconTask } from '../src/icons/tasks.js';
import type { CountdownClock, ModerationState } from '../src/icons/countdown.js';
import { LocalStore } from '../src/storage/store.js';

const M = 60_000;
async function harness(action: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const h = await setup(); try { await action(h); } finally { await rm(h.store.home, { recursive: true, force: true }); }
}
async function setup() {
  const store = new LocalStore(await mkdtemp(join(tmpdir(), 'rbx-icon-task-')));
  const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 100, g: 150, b: 200 } } }).png().toBuffer();
  const clock: CountdownClock & { t: number; onSleep?: () => Promise<void> } = { t: 1_800_000_000_000, now: () => clock.t, sleep: async ms => { clock.t += ms; await clock.onSleep?.(); } };
  const calls: string[] = [], uploads: string[] = [], ids: Record<string, string> = {};
  const moderation: { state: ModerationState; failPatch: boolean } = { state: 'Approved', failPatch: false };
  const assets = {
    rootPlaceId: async () => '99', stablePlaceIcon: async () => '555',
    createImage: async (_data: Buffer, _format: 'png' | 'jpeg', file: string) => { uploads.push(file); const assetId = String(7000 + uploads.length); ids[file] = assetId; return { assetId, moderationState: moderation.state }; },
    moderationState: async () => moderation.state,
    setPlaceIcon: async (_place: string, asset: string) => { if (moderation.failPatch) throw new Error('network fixture'); calls.push(asset); },
  };
  const capture = async () => ({ placeId: '99', originalIconAssetId: '555', data: original });
  const tasks = new IconTasks(store, assets, undefined, { clock, capture });
  const create = (extra: Partial<Parameters<IconTasks['create']>[0]> = {}) => tasks.create({ universeId: '1', creator: { type: 'Group', id: '200' }, target: { at: clock.t + M }, restoreAt: clock.t + 2 * M, nodes: ['1min', '10s'], ...extra });
  const ready = async (task: IconTask) => {
    task.phase = 'countdown'; task.frames.forEach((f, i) => { f.assetId = String(8000 + i); });
    await store.write('icon-countdown/tasks/1.json', task); return task;
  };
  return { store, clock, original, assets, calls, uploads, ids, moderation, tasks, capture, create, ready };
}
test('default generated set contains every hour, five minute nodes, SOON and NOW; ambiguous/custom nodes are rejected', () => {
  const frames = iconNodes(); assert.equal(frames.length, 31); assert.equal(DEFAULT_ICON_NODES.length, 29);
  assert.deepEqual(frames.slice(0, 24).map(f => f.offsetMs), Array.from({ length: 24 }, (_, i) => (24 - i) * 60 * M));
  assert.deepEqual(frames.slice(24).map(f => f.offsetMs), [30*M,15*M,10*M,5*M,M,0,null]);
  for (const nodes of [['1h','60m'],['now'],['25h'],['../../file'],['0s']]) assert.throws(() => iconNodes(nodes), { code: 'ARGUMENT_ERROR' });
});
test('rendering is deterministic, uses the requested background and mask, and emits opaque 512 PNGs with white artwork', async () => harness(async h => {
  const a = await renderIcon(h.original, '30Mins'), b = await renderIcon(h.original, '30Mins'); assert.deepEqual(a, b);
  assert.notDeepEqual(a, await renderIcon(h.original, 'NOW!'));
  const { data, info } = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width,512); assert.equal(info.height,512);
  assert.ok(Math.abs(data[0]! - 65) <= 1); assert.ok(Math.abs(data[1]! - 98) <= 1); assert.equal(data[3],255);
  assert.ok(data.some((v,i) => i % 4 === 0 && v === 255));
  const result = await generateIconImages(h.original, join(h.store.home,'preview'), ['1min']); assert.equal(result.frames.length,3);
  assert.deepEqual(await readFile(join(result.output,result.originalFile)), h.original);
  await assert.rejects(generateIconImages(h.original,result.output),{code:'STORAGE_ERROR'});
}));
test('manual NOW suppresses future countdown/SOON; the fixed restoration deadline still wins', async () => harness(async h => {
  const task = await h.ready(await h.create());
  await h.tasks.step('1'); assert.equal(h.calls.length,1);
  h.clock.t = task.targetMs!; assert.equal((await h.tasks.step('1')).phase,'soon');
  await h.tasks.now('1'); const nowId = task.frames.find(f => f.offsetMs === null)!.assetId;
  assert.equal(h.calls.at(-1),nowId); const count=h.calls.length;
  await h.tasks.now('1'); await h.tasks.step('1'); assert.equal(h.calls.length,count);
  h.clock.t = task.restoreAt; assert.equal((await h.tasks.step('1')).phase,'restored'); assert.equal(h.calls.at(-1),'555');
  await assert.rejects(h.tasks.now('1'),{code:'ARGUMENT_ERROR'});
  await h.tasks.restore('1'); assert.equal(h.calls.length,count+1);
}));
test('manual NOW may bypass an unfinished countdown and never changes restoreAt', async () => harness(async h => {
  const task=await h.ready(await h.create()); const now=await h.tasks.now('1'); assert.equal(now.restoreAt,task.restoreAt);
  h.clock.t=task.targetMs!; await h.tasks.step('1'); assert.deepEqual(h.calls,[task.frames.find(f=>f.offsetMs===null)!.assetId]);
}));
test('resume catches up only the latest node, and expired restoration takes precedence over SOON and NOW', async () => harness(async h => {
  const task=await h.ready(await h.create()); h.clock.t=task.targetMs!+1;
  await h.tasks.step('1'); assert.deepEqual(h.calls,[task.frames.find(f=>f.offsetMs===0)!.assetId]);
  h.clock.t=task.restoreAt+1; await h.tasks.now('1'); assert.equal(h.calls.at(-1),'555');
  const second=await h.ready(await h.create()); h.clock.t=second.restoreAt+1; h.calls.length=0;
  await h.tasks.resume('1'); assert.deepEqual(h.calls,['555']);
}));
test('preparing tasks can be restored manually, cannot switch NOW, and prevent overlapping tasks', async () => harness(async h => {
  await h.create(); await assert.rejects(h.create(),{code:'ARGUMENT_ERROR'}); await assert.rejects(h.tasks.now('1'),{code:'ARGUMENT_ERROR'});
  await h.tasks.restore('1'); await h.tasks.resume('1'); assert.deepEqual(h.calls,['555']);
}));
test('failed switches do not advance persisted progress', async () => harness(async h => {
  await h.ready(await h.create()); h.moderation.failPatch=true;
  await assert.rejects(h.tasks.step('1')); assert.deepEqual((await h.tasks.status('1'))!.completed,[]);
  await assert.rejects(h.tasks.restore('1')); assert.equal((await h.tasks.status('1'))!.phase,'countdown');
  h.moderation.failPatch=false; await h.tasks.restore('1'); assert.equal((await h.tasks.status('1'))!.phase,'restored');
}));
test('approval precedes all switches; relative duration anchors at approval and a second controller can switch NOW/restore', async () => harness(async h => {
  const start=h.clock.t; const task=await h.create({target:{inMs:M}}); h.moderation.state='Reviewing';
  let approved=false, manual=false;
  const other=new IconTasks(h.store,h.assets,undefined,{clock:h.clock});
  h.clock.onSleep=async()=>{
    if(!approved){assert.equal(h.calls.length,0);h.moderation.state='Approved';approved=true;}
    else if(!manual && h.clock.t > start+M+6000){ await other.now('1'); manual=true; }
  };
  const result=await h.tasks.resume('1');
  assert.equal(result.targetMs,start+5000+M); assert.equal(result.phase,'restored'); assert.ok(manual);
  assert.equal(h.uploads.length,task.frames.length); assert.equal(h.calls.at(-1),'555');
  assert.ok(h.calls.includes(h.ids['soon.png']!)); assert.ok(h.calls.includes(h.ids['now.png']!));
}));
test('rejected/timeout uploads survive restart without reupload, and a restoration deadline overrides pending review', async () => harness(async h => {
  const task=await h.create(); h.moderation.state='Reviewing';
  await assert.rejects(h.tasks.resume('1',1000),{code:'MODERATION_TIMEOUT'}); const count=h.uploads.length; assert.equal(h.calls.length,0);
  h.moderation.state='Rejected'; await assert.rejects(h.tasks.resume('1',1000),{code:'MODERATION_REJECTED'}); assert.equal(h.uploads.length,count);
  h.clock.t=task.restoreAt; await h.tasks.resume('1'); assert.deepEqual(h.calls,['555']);
}));
test('an old worker cannot operate a replacement task; malformed state fails closed', async () => harness(async h => {
  const old=await h.create(); await h.tasks.restore('1'); await h.create();
  await assert.rejects(h.tasks.step('1',old.taskId),{code:'ARGUMENT_ERROR'});
  await writeFile(join(h.store.home,'icon-countdown/tasks/1.json'),'{broken'); await assert.rejects(h.tasks.status('1'),{code:'STORAGE_ERROR'});
}));
test('approved images are reused across tasks for the same owner and content, and modified generated files cannot upload', async () => harness(async h => {
  await h.create(); await h.tasks.resume('1'); const count=h.uploads.length;
  await h.create(); await h.tasks.resume('1'); assert.equal(h.uploads.length,count);
  const next=await h.create(); await writeFile(join(next.output,'frames',next.frames[0]!.file),'modified');
  await assert.rejects(h.tasks.resume('1'),{code:'ARGUMENT_ERROR'}); assert.equal(h.uploads.length,count);
}));
test('compiled status and generated dry-run are offline with no credential; invalid nodes fail before requests', async () => harness(async h => {
  const env: NodeJS.ProcessEnv={...process.env,RBX_HOME:h.store.home}; delete env.ROBLOX_API_KEY;
  const cli=(...args:string[])=>spawnSync(process.execPath,['dist/cli/main.js','--json',...args],{env,encoding:'utf8'});
  const status=cli('icon','status','1'); assert.equal(status.status,0,status.stderr); assert.equal(JSON.parse(status.stdout).task,null);
  const dry=cli('icon','countdown','1','--in','3h','--restore-at',new Date(Date.now()+24*60*M).toISOString(),'--dry-run');
  assert.equal(dry.status,0,dry.stdout); assert.equal(JSON.parse(dry.stdout).dryRun,true);
  assert.equal(cli('icon','generate','1','--output',join(h.store.home,'x'),'--nodes','25h').status,2);
}));
