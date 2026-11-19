import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpClient } from '../src/transport/http-client.js';
import { listPlaceVersions, setPlaceVersionNotes } from '../src/universes/place-versions.js';

function row(version: string, title: string | null = null, description: string | null = null) {
  return { version, title, description, isPublished: false, createdTime: '2026-11-19T06:43:26.935Z' };
}

function fakeHttp(responses: unknown[]) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const http = new HttpClient({
    apiKey: 'test-key', intervalMs: 0, retries: 0,
    fetch: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      assert.ok(responses.length, 'Unexpected HTTP request');
      return Response.json(responses.shift());
    },
  });
  return { http, requests };
}

test('reads authenticated Place version history and preserves its cursor', async () => {
  const { http, requests } = fakeHttp([{ placeVersions: [row('6515')], hasMore: true, nextCursor: 'next' }]);
  assert.deepEqual(await listPlaceVersions(http, '123', 'previous/='),
    { placeId: '123', versions: [row('6515')], nextCursor: 'next' });
  assert.equal(requests[0]?.url.pathname, '/place-version-history-api/v1/123/history');
  assert.equal(requests[0]?.url.searchParams.get('cursor'), 'previous/=');
  assert.equal(new Headers(requests[0]?.init?.headers).get('x-api-key'), 'test-key');
});

test('writes notes once and verifies exactly the requested version even on a later page', async () => {
  const updated = row('6515', 'Update 4', 'First\nSecond');
  const { http, requests } = fakeHttp([
    { placeVersion: updated },
    { placeVersions: [row('6516')], hasMore: true, nextCursor: 'next' },
    { placeVersions: [updated], hasMore: false },
  ]);
  assert.deepEqual(await setPlaceVersionNotes(http, '123', '6515', 'Update 4', 'First\r\nSecond'), updated);
  assert.equal(requests[0]?.url.pathname, '/place-version-history-api/v1/123/version/6515/notes');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { title: 'Update 4', description: 'First\nSecond' });
  assert.deepEqual(requests.map(request => request.init?.method), ['POST', 'GET', 'GET']);
});

test('rejects invalid inputs before writing and rejects mismatched readback without retrying', async () => {
  const { http, requests } = fakeHttp([{}, { placeVersions: [row('6515', 'Other')], hasMore: false }]);
  await assert.rejects(setPlaceVersionNotes(http, '123', '6515', ''), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(setPlaceVersionNotes(http, '123', '6515', 'Update 4'), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(requests.map(request => request.init?.method), ['POST', 'GET']);
});
