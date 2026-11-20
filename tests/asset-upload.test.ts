import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { getAssetOperation, HttpClient, uploadAssetImage } from '../src/index.js';

async function withImage(run: (image: string, directory: string, original: Buffer) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-asset-upload-'));
  try {
    const image = join(directory, '封面.jpeg');
    const original = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#ffaa33' } }).jpeg().toBuffer();
    await writeFile(image, original);
    await run(image, directory, original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const creator = { type: 'Group', id: '123' } as const;
const sleep = async () => {};

test('default Image upload preserves bytes and reports the ID and moderation separately', () => withImage(async (image, directory, original) => {
  const backupDirectory = join(directory, 'backups');
  const methods: string[] = [];
  let submitted: unknown;
  let uploaded: File | undefined;
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, retries: 0, fetch: async (_url, request) => {
    methods.push(request!.method!);
    if (request!.method === 'POST') {
      const form = request!.body as FormData;
      submitted = JSON.parse(String(form.get('request')));
      uploaded = form.get('fileContent') as File;
      return Response.json({ path: 'operations/one' });
    }
    const operationFile = (await readdir(backupDirectory)).find(file => file.endsWith('.operation.json'));
    assert.ok(operationFile);
    assert.deepEqual(JSON.parse(await readFile(join(backupDirectory, operationFile), 'utf8')), { operationId: 'operations/one' });
    return Response.json({ done: true, response: { assetId: '42', moderationResult: { moderationState: 'Reviewing' } } });
  } });

  const options = { creator, name: 'Seasonal cover', backupDirectory, sleep };
  const plan = await uploadAssetImage(http, image, { ...options, dryRun: true });
  assert.equal(plan.state, 'planned');
  assert.deepEqual(plan.request.body!.image, {
    path: image, format: 'jpeg', width: 16, height: 9, bytes: original.length,
    sha256: createHash('sha256').update(original).digest('hex'),
  });
  assert.deepEqual(await readdir(directory), ['封面.jpeg']);
  assert.deepEqual(methods, []);

  const result = await uploadAssetImage(http, image, options);
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.deepEqual(submitted, { assetType: 'Image', displayName: 'Seasonal cover', description: '', creationContext: { creator: { groupId: '123' } } });
  assert.equal(uploaded?.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await uploaded!.arrayBuffer()), original);
  assert.deepEqual(await readFile(`${result.backupPath}.jpeg`), original);
  assert.equal(result.state, 'verified');
  assert.deepEqual(result.response, { assetId: '42', assetUri: 'rbxassetid://42', moderationState: 'Reviewing' });
}));

test('pending Decal keeps its operation ID and can be queried without a second POST', () => withImage(async (image, directory) => {
  let writes = 0;
  let done = false;
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, retries: 0, fetch: async (url, request) => {
    if (request!.method === 'POST') {
      writes++;
      const form = request!.body as FormData;
      assert.deepEqual(JSON.parse(String(form.get('request'))), { assetType: 'Decal', displayName: 'Sticker', description: 'Example', creationContext: { creator: { userId: '456' } } });
      return Response.json({ path: 'operations/two' });
    }
    assert.equal(new URL(String(url)).pathname, '/assets/v1/operations/two');
    return Response.json(done ? { done: true, response: { assetId: '78' } } : { done: false });
  } });
  const pending = await uploadAssetImage(http, image, {
    creator: { type: 'User', id: '456' }, type: 'decal', name: 'Sticker', description: 'Example', backupDirectory: directory, sleep,
  });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.operationId, 'operations/two');
  done = true;
  const result = await getAssetOperation(http, 'two');
  assert.equal(result.response?.assetUri, 'rbxassetid://78');
  assert.equal(result.response?.moderationState, 'Unknown');
  assert.equal(writes, 1);
  await assert.rejects(getAssetOperation(http, '../assets'), { code: 'ARGUMENT_ERROR' });
}));

test('invalid input stays local and an ambiguous POST is recorded without retry', () => withImage(async (image, directory) => {
  let writes = 0;
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, fetch: async (_url, request) => {
    assert.equal(request!.method, 'POST');
    writes++;
    return new Response(null, { status: 503 });
  } });
  const options = { creator, name: 'Cover', backupDirectory: directory };
  const invalid = join(directory, 'invalid.png');
  await writeFile(invalid, 'not an image');
  await assert.rejects(uploadAssetImage(http, invalid, options), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(uploadAssetImage(http, image, { ...options, name: '  ' }), { code: 'ARGUMENT_ERROR' });
  assert.equal(writes, 0);
  const result = await uploadAssetImage(http, image, options);
  assert.equal(result.state, 'unverified');
  assert.equal(result.error?.httpStatus, 503);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await readFile(`${result.backupPath}.result.json`, 'utf8')).state, 'unverified');
}));
