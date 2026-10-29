import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GameInfoLocalization, parseGameInfoTranslations, type GameInfoTranslations } from '../src/localization/game-info.js';
import { HttpClient } from '../src/transport/http-client.js';

function fixture(options: { rejectDescription?: boolean; lost?: boolean; denied?: boolean; noEffect?: boolean; sourceDenied?: boolean; sourceNoEffect?: boolean; rootPlace?: string; addFails?: boolean; nullEmpty?: boolean; malicious?: boolean; delayed?: boolean; extraLanguages?: boolean; cancelAfterAdd?: AbortController } = {}) {
  const locales = [
    ['en', 'English', 'en_us'], ['en', 'English', 'en_gb'], ['ja', 'Japanese', 'ja_jp'],
    ['hi', 'Hindi', 'hi_in'], ['fr', 'French', 'fr_fr'], ['fr', 'French', 'fr_ca'],
  ];
  if (options.extraLanguages) for (const letter of 'abcdefghijklmnopqrstuvwxyz') locales.push([`q${letter}`, `Fictional ${letter}`, `q${letter}_xx`]);
  const supported = new Set(['en', 'ja']);
  const source = { displayName: 'Example', description: 'Source description' };
  const texts = new Map<string, { name: string | null; description: string | null }>([
    ['en', { name: source.displayName, description: source.description }],
    ['ja', { name: 'Original Japanese', description: 'Original description' }],
    ['zh_cjv', { name: 'Extra response', description: null }],
  ]);
  const calls: { url: URL; method: string; body: any }[] = [];
  let textReads = 0;
  const client = new GameInfoLocalization(new HttpClient({ apiKey: 'fake-key', intervalMs: 0, retries: 0, fetch: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    assert.equal(new Headers(init?.headers).get('x-api-key'), url.host === 'apis.roblox.com' ? 'fake-key' : null);
    if (url.host === 'locale.roblox.com') return Response.json({ data: locales.map(([languageCode, name, locale]) => ({ locale: { locale, name, language: { languageCode, name, nativeName: name } } })) });
    if (url.pathname.includes('source-language')) return Response.json({ languageCode: 'en' });
    if (url.pathname === '/cloud/v2/universes/1') {
      assert.equal(method, 'GET', 'source writes must target the root place, not the universe');
      return Response.json({ ...source, rootPlace: options.rootPlace ?? 'universes/1/places/99' });
    }
    if (url.pathname === '/cloud/v2/universes/1/places/99') {
      if (method === 'PATCH') {
        if (options.sourceDenied) return new Response(null, { status: 403 });
        assert.equal(url.searchParams.get('updateMask'), Object.keys(body).join(','));
        if (!options.sourceNoEffect) Object.assign(source, body);
      }
      return Response.json(source);
    }
    if (url.pathname.endsWith('/supported-languages/games/1')) {
      if (method === 'PATCH') {
        if (options.addFails) return new Response(null, { status: 403 });
        for (const row of body) supported.add(row.languageCode);
        options.cancelAfterAdd?.abort();
        return Response.json({});
      }
      return Response.json({ data: [...supported].map(languageCode => ({ languageCode, languageCodeType: languageCode.includes('_') ? 'Locale' : 'Language' })) });
    }
    if (url.pathname.endsWith('/universe-display-info-automatic-translation-settings')) {
      assert.equal(body, false);
      return Response.json({ isUniverseDisplayInfoAutomaticTranslationEnabled: false });
    }
    assert.ok(url.pathname.endsWith('/name-description/games/1'), url.href);
    if (method === 'PATCH') {
      if (options.denied) return new Response(null, { status: 403 });
      const successes = [], failures = [];
      for (const row of body.data) {
        assert.notEqual(row.languageCode, 'en');
        if (row.updateType === 'Description' && options.rejectDescription) { failures.push({ languageCode: row.languageCode, errorCode: 20 }); continue; }
        const previous = texts.get(row.languageCode) ?? { name: null, description: null };
        if (!options.noEffect) {
          if (row.updateType === 'Name') { assert.equal(Object.hasOwn(row, 'description'), false); previous.name = row.name; }
          else { assert.equal(Object.hasOwn(row, 'name'), false); previous.description = options.nullEmpty && row.description === '' ? null : row.description; }
          texts.set(row.languageCode, previous);
        }
        successes.push({ ...row });
      }
      if (options.lost) throw new Error('Lost response');
      return Response.json({ successOperations: successes, failedOperations: failures });
    }
    textReads++;
    const data = [...texts].map(([languageCode, row]) => ({ languageCode, ...row, updateType: null }));
    if (options.malicious) data.push({ languageCode: '../redirect', name: 'X', description: null, updateType: null });
    if (options.delayed && textReads === 2) data.find(row => row.languageCode === 'ja')!.name = 'Original Japanese';
    return Response.json({ data });
  }) as typeof fetch }));
  return { client, calls, texts, source, supported };
}

test('read includes all creator languages/locales, missing values, source and extra translations', async () => {
  const { client } = fixture();
  const result = await client.read('1');
  assert.equal(result.languages.length, 4);
  assert.equal(result.languages.reduce((n, language) => n + language.locales.length, 0), 6);
  assert.deepEqual(result.source, { languageCode: 'en', title: 'Example', description: 'Source description' });
  assert.equal(result.languages.find(row => row.languageCode === 'hi')!.title, null);
  assert.equal(result.languages.find(row => row.languageCode === 'hi')!.enabled, false);
  assert.equal(result.languages.find(row => row.languageCode === 'ja')!.locales[0]!.targetCode, 'ja');
  assert.ok(result.translations.some(row => row.languageCode === 'zh_cjv'));
});

test('write targets only provided fields and adds missing languages without enabling automatic translation', async () => {
  const { client, calls, texts } = fixture();
  const result = await client.write('1', { 'ja-jp': { title: 'New Japanese' }, hi: { title: 'New Hindi', description: 'Hindi description' } });
  assert.ok(result.results.every(row => row.status === 'success'));
  assert.deepEqual(result.addedLanguages, ['hi']);
  assert.equal(texts.get('ja')!.description, 'Original description');
  const add = calls.find(row => row.method === 'PATCH' && row.url.pathname.endsWith('/supported-languages/games/1'))!;
  assert.deepEqual(add.body, [{ languageCodeType: 'Language', languageCode: 'hi' }]);
  const disable = calls.find(row => row.url.pathname.endsWith('/universe-display-info-automatic-translation-settings'))!;
  assert.equal(disable.body, false);
  assert.ok(calls.indexOf(add) < calls.indexOf(disable));
  assert.equal(calls.filter(row => row.method === 'PATCH' && row.url.pathname.includes('name-description')).length, 2);
});

test('source description edits target the discovered root place and regional overrides retain distinct targets', async () => {
  const { client, source, calls } = fixture();
  const result = await client.write('1', { en: { description: 'New source' }, 'en-gb': { title: 'British title' } });
  assert.ok(result.results.every(row => row.status === 'success'));
  assert.equal(source.displayName, 'Example');
  assert.equal(source.description, 'New source');
  assert.deepEqual(calls.find(row => row.method === 'PATCH' && row.url.pathname === '/cloud/v2/universes/1/places/99')!.body, { description: 'New source' });
  assert.deepEqual(result.addedLanguages, []);
  assert.ok(!calls.some(row => row.method === 'PATCH' && row.url.pathname.includes('supported-languages')));
});

test('source title edits update the root place while preserving the description', async () => {
  const { client, source, calls } = fixture();
  const result = await client.write('1', { en: { title: '[RANKED] Example' } });
  assert.equal(result.results[0]!.status, 'success');
  assert.equal(source.displayName, '[RANKED] Example');
  assert.equal(source.description, 'Source description');
  const writes = calls.filter(row => row.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.url.pathname, '/cloud/v2/universes/1/places/99');
  assert.equal(writes[0]!.url.searchParams.get('updateMask'), 'displayName');
  assert.deepEqual(writes[0]!.body, { displayName: '[RANKED] Example' });
});

test('source title and description can be updated together on the root place', async () => {
  const { client, source, calls } = fixture();
  const result = await client.write('1', { en: { title: 'New title', description: 'New description' } });
  assert.ok(result.results.every(row => row.status === 'success'));
  assert.deepEqual(source, { displayName: 'New title', description: 'New description' });
  const writes = calls.filter(row => row.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.url.searchParams.get('updateMask'), 'displayName,description');
});

test('invalid or foreign root place paths cannot cause mutations', async () => {
  for (const rootPlace of ['', 'universes/2/places/99', 'universes/1/places/99?redirect=1', 'https://example.com/places/99']) {
    const { client, calls } = fixture({ rootPlace });
    const result = await client.write('1', { en: { title: 'New title' } });
    assert.equal(result.results[0]!.error!.code, 'INVALID_RESPONSE');
    assert.notEqual(result.results[0]!.status, 'success');
    assert.equal(calls.some(row => row.method !== 'GET'), false);
  }
});

test('source writes require permission and a matching readback, without retrying mutations', async () => {
  for (const options of [{ sourceDenied: true }, { sourceNoEffect: true }]) {
    const { client, calls } = fixture(options);
    const result = await client.write('1', { en: { title: 'New title' } });
    assert.equal(result.results[0]!.status, 'sourceDenied' in options ? 'error' : 'unverified');
    assert.equal(calls.filter(row => row.method === 'PATCH').length, 1);
  }
});

test('a regional override adds its parent language instead of an unsupported Locale entry', async () => {
  const { client, calls } = fixture();
  const result = await client.write('1', { 'fr-ca': { title: 'Canadian French' }, fr: { description: 'French description' } });
  assert.ok(result.results.every(row => row.status === 'success'));
  assert.deepEqual(result.addedLanguages, ['fr']);
  assert.deepEqual(calls.find(row => row.method === 'PATCH' && row.url.pathname.endsWith('/supported-languages/games/1'))!.body, [{ languageCodeType: 'Language', languageCode: 'fr' }]);
});

test('dry-run performs reads only and lists additions without creating backups', async () => {
  const { client, calls } = fixture();
  const result = await client.write('1', { hi: { title: 'Hindi' } }, { dryRun: true, backupDirectory: 'not-created' });
  assert.equal(result.results[0]!.status, 'planned');
  assert.deepEqual(result.addedLanguages, ['hi']);
  assert.equal(result.backupPath, undefined);
  assert.equal(calls.some(row => row.method !== 'GET'), false);
});

test('HTTP 200 with per-operation failures is partial, preserving successful fields', async () => {
  const { client, texts } = fixture({ rejectDescription: true });
  const result = await client.write('1', { ja: { title: 'New', description: 'Rejected' } });
  assert.deepEqual(result.results.map(row => row.status), ['success', 'error']);
  assert.match(result.results[1]!.error!.message, /error 20/);
  assert.equal(texts.get('ja')!.description, 'Original description');
});

test('language addition failures do not submit translations for that language', async () => {
  const { client, calls } = fixture({ addFails: true });
  const result = await client.write('1', { hi: { title: 'Hindi' }, ja: { title: 'New' } });
  assert.deepEqual(result.results.map(row => row.status), ['error', 'success']);
  assert.ok(calls.filter(row => row.url.pathname.includes('name-description') && row.method === 'PATCH').every(row => row.body.data.every((entry: any) => entry.languageCode === 'ja')));
});

test('lost responses are never retried; denied writes and uncertain readbacks are distinguished', async () => {
  for (const options of [{ lost: true }, { denied: true }, { noEffect: true }, { nullEmpty: true }]) {
    const { client, calls } = fixture(options);
    const result = await client.write('1', { ja: { description: 'nullEmpty' in options ? '' : 'New description' } });
    assert.equal(result.results[0]!.status, 'denied' in options ? 'error' : 'unverified');
    assert.equal(calls.filter(row => row.method === 'PATCH').length, 1);
  }
});

test('read propagation is retried without repeating the write', async () => {
  const { client, calls } = fixture({ delayed: true });
  const result = await client.write('1', { ja: { title: 'New' } });
  assert.equal(result.results[0]!.status, 'success');
  assert.equal(calls.filter(row => row.method === 'PATCH').length, 1);
});

test('backups precede writes and contain the original values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-localization-test-'));
  try {
    const { client } = fixture();
    const result = await client.write('1', { ja: { title: 'New' } }, { backupDirectory: directory });
    const backup = JSON.parse(await readFile(result.backupPath!, 'utf8'));
    assert.equal(backup.before.languages.find((row: any) => row.languageCode === 'ja').title, 'Original Japanese');
    assert.deepEqual(backup.requested, { ja: { title: 'New' } });
    assert.equal((await readdir(directory)).length, 1);
    const occupied = join(directory, 'occupied');
    await writeFile(occupied, 'not a directory');
    const blocked = fixture();
    await assert.rejects(blocked.client.write('1', { ja: { title: 'New' } }, { backupDirectory: occupied }), /Cannot save localization backup/);
    assert.equal(blocked.calls.some(row => row.method !== 'GET'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('batches split at 25 unique languages per field', async () => {
  const { client, calls } = fixture({ extraLanguages: true });
  const input = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map(letter => [`q${letter}`, { title: `Title ${letter}`, description: `Description ${letter}` }]));
  const result = await client.write('1', input);
  assert.ok(result.results.every(row => row.status === 'success'));
  const batches = calls.filter(row => row.method === 'PATCH' && row.url.pathname.includes('name-description'));
  assert.deepEqual(batches.map(row => row.body.data.length), [25, 1, 25, 1]);
});

test('SDK cancellation after adding a language prevents subsequent field mutations', async () => {
  const controller = new AbortController();
  const { client, calls } = fixture({ cancelAfterAdd: controller });
  const result = await client.write('1', { hi: { title: 'Hindi' }, en: { description: 'Source' }, ja: { title: 'Japanese' } }, { signal: controller.signal });
  assert.ok(result.results.every(row => row.status === 'error' && row.error?.code === 'CANCELLED'));
  assert.equal(calls.filter(row => row.method !== 'GET').length, 1);
});

test('bad input, aliases and malformed upstream codes cannot cause writes', async () => {
  for (const input of [null, [], {}, { ja: { title: null } }, { ja: { title: 1 } }, { ja: {} }, { ja: { name: 'X' } }, { 'en-gb': { title: 'X' }, en_gb: { title: 'Y' } }]) assert.throws(() => parseGameInfoTranslations(input));
  const badTargets: GameInfoTranslations[] = [{ unknown: { title: 'X' } }, { ja: { title: 'X' }, 'ja-jp': { title: 'Y' } }, { 'en-us': { title: 'X' } }];
  for (const input of badTargets) {
    const { client, calls } = fixture();
    await assert.rejects(client.write('1', input));
    assert.equal(calls.some(row => row.method !== 'GET'), false);
  }
  await assert.rejects(fixture({ malicious: true }).client.read('1'), /Invalid Roblox language code/);
});

test('CLI rejects missing files and malformed JSON before needing credentials', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--json', 'localization', 'write', '1', '--file', 'missing-localization-test.json'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'ARGUMENT_ERROR');
});
