import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppError } from '../src/core/errors.js';
import { publishStudioPlaces } from '../src/studio/publish.js';
import { saveStudioPlace } from '../src/studio/save.js';
import { HttpClient } from '../src/transport/http-client.js';
import { writePlaceVersionNotes } from '../src/universes/place-versions.js';
import { getUniversePlaceDirectory } from '../src/universes/places.js';

test('uses the authenticated universe to resolve the owner of a private publish target', async () => {
  const requests: string[] = [];
  const http = new HttpClient({
    apiKey: 'fixture', retries: 0,
    fetch: async url => {
      const target = new URL(String(url));
      requests.push(target.hostname);
      if (target.hostname === 'develop.roblox.com') {
        return Response.json({ data: [{ id: 101 }], nextPageCursor: null });
      }
      assert.equal(target.hostname, 'apis.roblox.com');
      return Response.json({ path: 'universes/789', rootPlace: 'universes/789/places/101', group: 'groups/987' });
    },
  });
  assert.deepEqual(await getUniversePlaceDirectory(http, '789'), {
    placeIds: ['101'], rootPlaceId: '101', owner: { type: 'Group', id: '987' },
  });
  assert.deepEqual(requests.sort(), ['apis.roblox.com', 'develop.roblox.com']);
});

test('labels only the exact new save version with a single title write and no history read', async () => {
  const requests: { path: string; method?: string; body?: BodyInit | null }[] = [];
  const http = new HttpClient({
    apiKey: 'fixture', retries: 0,
    fetch: async (url, init) => {
      requests.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body });
      return new Response(null, { status: 204 });
    },
  });
  let saves = 0;
  const result = await saveStudioPlace('123', async () => {
    saves++;
    return { status: 'Saved', version: 23, location: 'TeamCreate' };
  }, { title: ' Update 4 ', write: (version, title) => writePlaceVersionNotes(http, '123', version, title) });
  assert.equal(saves, 1);
  assert.deepEqual(result, { placeId: '123', state: 'saved', version: '23', title: 'Update 4', titleState: 'accepted' });
  assert.deepEqual(requests, [{
    path: '/place-version-history-api/v1/123/version/23/notes', method: 'POST',
    body: JSON.stringify({ title: 'Update 4', description: '' }),
  }]);
});

test('skips titles for a clean save and retains the saved version if a title request times out', async () => {
  let writes = 0;
  const notes = {
    title: 'Update 4',
    write: async () => {
      writes++;
      throw new AppError('TIMEOUT', 'Test timeout.');
    },
  };
  assert.deepEqual(await saveStudioPlace('123', async () => ({ status: 'NotNeeded', version: 22 }), notes),
    { placeId: '123', state: 'not_needed' });
  const result = await saveStudioPlace('123', async () => ({ status: 'Saved', version: '23' }), notes);
  assert.equal(result.state, 'saved');
  assert.equal(result.version, '23');
  assert.equal(result.titleState, 'unknown');
  assert.equal(writes, 1);
});

async function publishFixture(outcomes: Record<string, 'failed' | 'completed' | 'pending'>, timeoutMs: number) {
  const logDirectory = await mkdtemp(join(tmpdir(), 'rbx-studio-release-'));
  const log = join(logDirectory, 'fixture_Studio_test_last.log');
  await writeFile(log, 'previous run\n');
  const submissions: string[] = [];
  const verified = new Set<string>();
  let recoveringFrom: string | undefined;
  const http = new HttpClient({
    apiKey: 'fixture', intervalMs: 0, retries: 0,
    fetch: async url => {
      const placeId = new URL(String(url)).pathname.split('/')[3]!;
      return Response.json({
        placeVersions: [{
          version: verified.has(placeId) ? '12' : '11', title: null,
          description: null, isPublished: true, createdTime: '2026-11-22T10:00:00Z',
        }],
        hasMore: false,
      });
    },
  });
  const execute = async (code: string) => {
    if (code.startsWith('return { placeId')) {
      const placeId = recoveringFrom ?? '123';
      recoveringFrom = undefined;
      return { placeId, universeId: placeId === '123' ? '456' : '789' };
    }
    const sessionMarker = /RBX_PUBLISH_SESSION_[\w-]+/.exec(code)?.[0];
    if (sessionMarker) {
      await appendFile(log, `[FLog::Output] ${sessionMarker}\n`);
      return { ready: true };
    }
    const target = /PublishAs\(789, (\d+),/.exec(code)?.[1];
    const marker = /(RBX_PUBLISH_[\w-]+)_BEGIN/.exec(code)?.[1];
    assert.ok(target && marker);
    submissions.push(target);
    if (outcomes[target] === 'failed') return { dispatched: false };
    await appendFile(log, `[FLog::Output] ${marker}_BEGIN\npublishAs: currentUniverse=456 currentPlace=123 -> targetUniverse=789 targetPlace=${target} isPublish=1 (crossUniverse=1)\n`);
    if (outcomes[target] === 'completed') {
      verified.add(target);
      recoveringFrom = target;
      await appendFile(log, `[FLog::Output] ${marker}_EVENT_true\nPublishToDifferentGame srcPlaceId=123, dstPlaceId=${target}, srcUniverse=456, dstUniverse=789\n`);
    }
    return { dispatched: true };
  };
  try {
    const { results } = await publishStudioPlaces(http, execute, {
      sourcePlace: '123', targetUniverse: '789', group: '0', targets: Object.keys(outcomes),
      timeoutMs, signal: new AbortController().signal, logDirectory,
    });
    return { results, submissions };
  } finally {
    await rm(logDirectory, { recursive: true, force: true });
  }
}

test('continues after a confirmed Studio failure and waits for the source to recover between publishes', async () => {
  const { results, submissions } = await publishFixture({ 101: 'failed', 102: 'completed', 103: 'completed' }, 2_000);
  assert.deepEqual(submissions, ['101', '102', '103']);
  assert.deepEqual(results.map(row => [row.state, row.version]), [['failed', undefined], ['published', '12'], ['published', '12']]);
});

test('reports a pending first request and leaves subsequent Places untouched', async () => {
  const { results, submissions } = await publishFixture({ 101: 'pending', 102: 'completed' }, 300);
  assert.deepEqual(submissions, ['101']);
  assert.deepEqual(results.map(row => [row.state, row.error?.code]), [
    ['unknown', 'PUBLISH_UNVERIFIED'], ['not_started', 'STUDIO_PUBLISH_PENDING'],
  ]);
});
