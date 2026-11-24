import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { HttpClient, SubscriptionProducts } from '../src/index.js';

const universeId = '123';
const collection = 'https://apis.roblox.com/experience-subscriptions/v1/experiences/123/experience-subscriptions';
const actorUrl = 'https://users.roblox.com/v1/users/authenticated';
const productId = 'EXP-1234567890123456789';
const productUrl = `${collection}/${productId.slice(4)}`;
const description = 'Claim currency daily and gain extra choices.';
const product = { id: productId, universeId: 123, name: 'VIP', description, productType: 1, productStatusType: 1,
  currencyType: 1, priceInRobux: 299, isRegionalPricingEnabled: true, imageAssetId: 0 };
const instant = { sleep: async () => {} };

function mock(handler: (target: URL, init: RequestInit) => Response) {
  return new HttpClient({ apiKey: 'unused-key', robloxCookie: 'fake-cookie', intervalMs: 0, retries: 0, fetch: async (target, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('cookie'), '.ROBLOSECURITY=fake-cookie');
    assert.equal(headers.has('x-api-key'), false);
    assert.equal(init?.redirect, 'error');
    return handler(new URL(String(target)), init!);
  } });
}
function list(products: unknown[] = [], nextCursor?: string) {
  return Response.json({ developerSubscriptions: products, hasMoreResults: !!nextCursor, nextCursor });
}
async function withCover(action: (image: string, temporary: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'rbx-subscriptions-'));
  try {
    const image = join(temporary, 'cover.png');
    await sharp({ create: { width: 3, height: 3, channels: 4, background: 'gold' } }).png().toFile(image);
    await action(image, temporary);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

test('subscription list paginates, decodes states and preserves decimal product IDs', async () => {
  const secondId = '1234567890123456790';
  let calls = 0;
  const sdk = new SubscriptionProducts(mock((target, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(target.origin + target.pathname, collection);
    assert.equal(target.searchParams.get('ResultsPerPage'), '50');
    calls++;
    if (calls === 1) {
      assert.equal(target.searchParams.has('Cursor'), false);
      return list([product], 'next+/=');
    }
    assert.equal(target.searchParams.get('Cursor'), 'next+/=');
    return list([{ ...product, id: secondId, currencyType: 2, priceInRobux: null, productStatusType: 2 }]);
  }));
  const rows = await sdk.list(universeId);
  assert.equal(calls, 2);
  assert.deepEqual(rows.map(row => [row.productId, row.status, row.currency, row.priceInRobux]),
    [[productId, 'inactive', 'robux', 299], [`EXP-${secondId}`, 'active', 'local', null]]);
  let loopCalls = 0;
  const loop = new SubscriptionProducts(mock(() => { loopCalls++; return list([], 'same'); }));
  await assert.rejects(loop.list(universeId), { code: 'INVALID_RESPONSE' });
  assert.equal(loopCalls, 2);
});

test('subscription update refuses mismatched identities and Cookie destinations', async () => {
  let calls = 0;
  const http = mock((_target, init) => {
    assert.equal(init.method, 'GET');
    calls++;
    return Response.json({ ...product, universeId: 999 });
  });
  await assert.rejects(new SubscriptionProducts(http).update(universeId, productId, { price: 300 }), { code: 'INVALID_RESPONSE' });
  for (const target of [`${collection}?other=1`, `${collection}?Cursor=a&Cursor=b`, `${productUrl}?Cursor=a`,
    `${collection}/permission`, `${collection}/shortened-name/activate`, `${actorUrl}/roles`]) {
    await assert.rejects(http.request(target, { cookieAuth: true }), { code: 'ARGUMENT_ERROR' });
  }
  await assert.rejects(http.request(productUrl, { cookieAuth: true, method: 'DELETE' }), { code: 'ARGUMENT_ERROR' });
  await assert.rejects(http.request(productUrl, { cookieAuth: true, auth: true }), { code: 'ARGUMENT_ERROR' });
  assert.equal(calls, 1);
});

test('subscription create validates locally, creates once, uploads the cover and verifies the inactive product', async () => {
  await withCover(async (image, temporary) => {
    const fields = { name: 'VIP', description, price: 299, type: 'consumable' as const, image };
    const offline = new SubscriptionProducts(mock(() => { assert.fail('dry-run sent a request'); }));
    assert.equal((await offline.create(universeId, fields, { dryRun: true })).state, 'planned');
    await assert.rejects(offline.create(universeId, { ...fields, price: 48 }), { code: 'ARGUMENT_ERROR' });
    const calls: string[] = [];
    let coverAssetId = 0;
    const sdk = new SubscriptionProducts(mock((target, init) => {
      const route = target.origin + target.pathname;
      calls.push(`${init.method} ${route}`);
      if (route === actorUrl) return Response.json({ id: 99 });
      if (route === collection && init.method === 'GET') return list();
      if (route === collection && init.method === 'POST') {
        assert.equal(new Headers(init.headers).get('content-type'), 'application/json-patch+json');
        assert.deepEqual(JSON.parse(String(init.body)), { productName: 'VIP', productDescription: description, productType: 1,
          currencyType: 1, basePriceId: null, priceInRobux: 299, isRegionalPricingEnabled: true });
        return Response.json({ developerSubscription: product });
      }
      if (route === `${productUrl}/upload-image`) {
        assert.equal(init.method, 'POST');
        assert.equal(new Headers(init.headers).has('content-type'), false);
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get('ActingUserId'), '99');
        assert.ok(init.body.get('ImageFile') instanceof Blob);
        coverAssetId = 22;
        return Response.json({ status: 'Success' });
      }
      assert.equal(route, productUrl);
      return Response.json({ ...product, imageAssetId: coverAssetId });
    }));
    const result = await sdk.create(universeId, fields, { ...instant, backupDirectory: temporary });
    assert.deepEqual(calls, [`GET ${collection}`, `GET ${actorUrl}`, `POST ${collection}`, `GET ${productUrl}`,
      `POST ${productUrl}/upload-image`, `GET ${productUrl}`]);
    assert.equal(result.state, 'verified');
    assert.equal(result.productId, productId);
    assert.equal(result.readback?.coverAssetId, '22');
    assert.equal(JSON.parse(await readFile(`${result.backupPath}.created.json`, 'utf8')).productId, productId);
    assert.equal(JSON.parse(await readFile(`${result.backupPath}.result.json`, 'utf8')).state, 'verified');
  });
});

test('subscription create keeps the ID on cover failure and rejects duplicate names before posting', async () => {
  await withCover(async image => {
    let creates = 0, uploads = 0;
    const sdk = new SubscriptionProducts(mock((target, init) => {
      const route = target.origin + target.pathname;
      if (route === actorUrl) return Response.json({ id: 99 });
      if (route === collection && init.method === 'GET') return list(creates ? [product] : []);
      if (route === collection) {
        creates++;
        return Response.json({ developerSubscription: product });
      }
      if (route === productUrl) return Response.json(product);
      uploads++;
      return new Response(null, { status: 500 });
    }));
    const fields = { name: 'VIP', description, price: 299, type: 'consumable' as const, image };
    const result = await sdk.create(universeId, fields, instant);
    assert.equal(result.state, 'unverified');
    assert.equal(result.productId, productId);
    assert.equal(result.error?.httpStatus, 500);
    await assert.rejects(sdk.create(universeId, fields, instant), { code: 'ARGUMENT_ERROR' });
    assert.equal(creates, 1);
    assert.equal(uploads, 1);
  });
});

test('subscription update patches only changed fields and answers a rejected CSRF challenge once', async () => {
  let patches = 0, updated = false;
  const sdk = new SubscriptionProducts(mock((target, init) => {
    assert.equal(target.href, productUrl);
    if (init.method === 'PATCH') {
      assert.deepEqual(JSON.parse(String(init.body)), { priceInRobux: 349 });
      const token = new Headers(init.headers).get('x-csrf-token');
      if (++patches === 1) {
        assert.equal(token, null);
        return Response.json({ errors: [{ code: 0, message: 'Token Validation Failed' }] },
          { status: 403, headers: { 'x-csrf-token': 'challenge' } });
      }
      assert.equal(token, 'challenge');
      updated = true;
      return Response.json({ success: true });
    }
    return Response.json({ ...product, priceInRobux: updated ? 349 : 299 });
  }));
  const renamed = { name: 'VIP Renamed', price: 349 };
  await assert.rejects(sdk.update(universeId, productId, renamed), { code: 'ARGUMENT_ERROR' });
  const plan = await sdk.update(universeId, productId, { description, price: 349 }, { dryRun: true });
  assert.deepEqual(plan.request.body, { priceInRobux: 349 });
  assert.equal(patches, 0);
  const result = await sdk.update(universeId, productId, { description, price: 349 }, instant);
  assert.equal(patches, 2);
  assert.equal(result.state, 'verified');
  assert.equal(result.readback?.priceInRobux, 349);
});

test('subscription activate requires explicit permanent short name and verifies ordering', async () => {
  let active = false, name: string | undefined;
  const writes: string[] = [];
  const sdk = new SubscriptionProducts(mock((target, init) => {
    if (target.href === productUrl) return Response.json({ ...product, productStatusType: active ? 2 : 1 });
    if (init.method === 'GET') {
      assert.equal(target.href, `${collection}/shortened-name`);
      return Response.json({ shortenedName: name, suggestedShortenedName: 'Example Game' });
    }
    writes.push(target.href);
    if (target.href === `${collection}/shortened-name`) {
      name = JSON.parse(String(init.body)).shortenedName;
      return new Response(null, { status: 204 });
    }
    assert.equal(target.href, `${productUrl}/activate`);
    assert.equal(init.body, undefined);
    assert.equal(name, 'Example Game');
    active = true;
    return Response.json({ success: true });
  }));
  const preview = await sdk.activate(universeId, productId, { dryRun: true });
  assert.equal(preview.suggestedShortName, 'Example Game');
  await assert.rejects(sdk.activate(universeId, productId), { code: 'ARGUMENT_ERROR' });
  assert.deepEqual(writes, []);
  const result = await sdk.activate(universeId, productId, { ...instant, shortName: 'Example Game' });
  assert.equal(result.state, 'verified');
  assert.equal(result.readback?.status, 'active');
  assert.deepEqual(writes, [`${collection}/shortened-name`, `${productUrl}/activate`]);
});

test('compiled CLI accepts subscription IDs and previews create without a cookie', async () => {
  await withCover(async (image, home) => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/cli/main.js'), '--home', home, '--json', 'subscription', ...args],
      { encoding: 'utf8', timeout: 10_000 });
    const plan = cli('create', universeId, '--name', 'VIP', '--description', description, '--price', '299', '--type', 'consumable', '--image', image, '--dry-run');
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.equal(JSON.parse(plan.stdout).data.request.body.priceInRobux, 299);
    const query = cli('get', universeId, productId);
    assert.equal(query.status, 4, query.stderr + query.stdout);
    assert.match(JSON.parse(query.stdout).error.message, /rbx auth cookie set/);
    const rename = cli('update', universeId, productId, '--name', 'VIP Renamed');
    assert.equal(rename.status, 2, rename.stderr + rename.stdout);
  });
});
