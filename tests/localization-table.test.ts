import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRbxm, writeRbxm } from '../src/localization/rbxm.js';
import { languageModuleSource, luaString, parseLanguageSource, parseMasterSource } from '../src/localization/lua-table.js';
import { LocalizationTable, studioSwapLuau } from '../src/localization/table.js';
import { CloudLocalizationTable, enableLocalization } from '../src/localization/cloud-table.js';
import { syncLocalization, importFromCloud } from '../src/localization/sync.js';
import { DeepSeekClient, checkTranslation, translate, TranslationCache } from '../src/translation/deepseek.js';
import { HttpClient } from '../src/transport/http-client.js';

const master = (rows: [string, string][]) => `--[[ header ]]\nreturn {\n${rows.map(([en, zh]) => `\t{ en = ${luaString(en)}, zh = ${luaString(zh)} },\n`).join('')}}\n`;
function tableFile(rows: [string, string][], languages: Record<string, [string, string][]> = {}): Buffer {
  return writeRbxm([{ className: 'ModuleScript', name: '本地化表', source: master(rows), children: Object.entries(languages).map(([code, list]) => ({ className: 'ModuleScript', name: code, source: languageModuleSource(code, list), children: [] })) }]);
}

test('lua parser handles escapes, byte escapes and non-ASCII literals', () => {
  const rows = parseMasterSource('return {\n\t{ en = "Say \\"hi\\"\\n", zh = "Códigos \\226\\128\\148 é" },\n\t{ en = [[long]], zh = \'x\' }; -- c\n}');
  assert.deepEqual(rows, [{ en: 'Say "hi"\n', zh: 'Códigos — é' }, { en: 'long', zh: 'x' }]);
  assert.throws(() => parseMasterSource('return { { en = "a", zh = "1" }, { en = "a", zh = "2" } }'), /duplicate/);
  const text = ' {a:int} <font color="#fff">ó</font>\t"\\ ';
  assert.equal(parseLanguageSource(languageModuleSource('es', [[text, text]]), 'es').get(text), text);
});

test('rbxm round-trips nested ModuleScripts compressed and uncompressed', () => {
  const tree = [{ className: 'ModuleScript', name: '表', source: 'return {}', children: [{ className: 'ModuleScript', name: 'ja', source: 'x'.repeat(5000) + 'é', children: [] }] }];
  for (const compress of [true, false]) {
    const [root] = readRbxm(writeRbxm(tree, { compress }));
    assert.equal(root!.name, '表'); assert.equal(root!.children[0]!.source, 'x'.repeat(5000) + 'é');
  }
});

test('table keeps master order, drops orphans and is saved under the import name', async () => {
  const table = LocalizationTable.fromRbxm(tableFile([['B', '乙'], ['A', '甲']], { ja: [['A', 'あ'], ['gone', '消']] }));
  assert.equal(table.orphans(), 1);
  table.set('B', 'ja', 'び');
  const [root] = readRbxm(table.toRbxm('x__sync'));
  assert.equal(root!.name, 'x__sync');
  assert.deepEqual([...parseLanguageSource(root!.children[0]!.source!, 'ja')], [['B', 'び'], ['A', 'あ']]);
  assert.throws(() => LocalizationTable.fromRbxm(tableFile([['A', '甲']], { 'zh-hans': [] })), /Unexpected child/);
  assert.match(studioSwapLuau('game.ServerStorage', '本地化表'), /new.Source ~= old.Source/);
});

test('empty table is written under its own name, parses back and refuses to overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-init-'));
  try {
    const path = join(dir, 'x.rbxm'), table = LocalizationTable.empty();
    await table.create(path);
    const [root, ...rest] = readRbxm(await readFile(path));
    assert.equal(rest.length, 0); assert.equal(root!.name, '本地化表'); assert.equal(root!.children.length, 0);
    assert.match(root!.source!, /^--\[\[\n本地化表：[^]*新条目插在表最前面[^]*\\\\ \\" \\n[^]*\]\]\nreturn \{\n\}\n$/);
    const loaded = await LocalizationTable.load(path);
    assert.equal(loaded.name, '本地化表'); assert.equal(loaded.rows.length, 0); assert.equal(loaded.languages.size, 0);
    await assert.rejects(table.create(path), /already exists/);
    await table.create(path, { force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('translation check guards placeholders and tags', () => {
  assert.equal(checkTranslation('Win {a:int} <b>now</b>', 'Gagne {a:int} <b>maintenant</b>'), null);
  assert.equal(checkTranslation('Win {a:int}', 'Gagne {a}'), 'placeholders differ');
  assert.equal(checkTranslation('<b>x</b>', 'x'), 'markup tags differ');
});

function deepseekFake(handler: (items: any[]) => Record<string, Record<string, string>>) {
  const requests: any[] = [];
  const client = new DeepSeekClient('k', { retries: 0, sleep: async () => {}, fetch: (async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer k');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
    const body = JSON.parse(String(init!.body)), payload = JSON.parse(body.messages[1].content);
    requests.push(payload);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ t: handler(payload.items) }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 } });
  }) as typeof fetch });
  return { client, requests };
}

test('translate batches, validates, retries singly and caches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-ds-'));
  try {
    let broken = true;
    const { client, requests } = deepseekFake(items => Object.fromEntries(items.map((item: any) => [item.id, Object.fromEntries(item.to.map((l: string) => [l, item.en === 'Win {a}' && broken ? (broken = false, 'Gagne') : `${l}:${item.en}`]))])));
    assert.equal(await client.resolveModel('nope'), 'deepseek-flash');
    assert.equal(await client.resolveModel('deepseek-v4-pro'), 'deepseek-v4-pro');
    const cache = await new TranslationCache(join(dir, 'c.jsonl')).load();
    const jobs = [{ en: ' Hi ', zh: '嗨', locales: ['ja', 'fr'] }, { en: 'Win {a}', zh: '赢', locales: ['fr'] }];
    const first = await translate(client, jobs, { model: 'deepseek-chat', cache, batchPairs: 2 });
    assert.equal(first.failures.length, 0);
    assert.deepEqual(first.translations.map(t => t.text).sort(), [' fr: Hi ', ' ja: Hi ', 'fr:Win {a}']);
    assert.ok(requests.some(r => r.items.length === 1 && r.items[0].en === 'Win {a}'), 'invalid pair retried alone');
    const before = requests.length;
    const second = await translate(client, jobs, { model: 'deepseek-chat', cache: await new TranslationCache(join(dir, 'c.jsonl')).load() });
    assert.equal(second.cached, 3); assert.equal(requests.length, before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function robloxFake(options: { source?: string; useTable?: boolean } = {}) {
  const state = {
    source: options.source ?? 'en', supported: new Set(['en', 'zh-hans', 'ja']), auto: new Map([['ja', false], ['zh-hans', true]]),
    settings: { isAutolocalizationEnabled: true, isAutomaticEntriesSettingEnabled: false, isAutomaticEntriesDeletionEnabled: true, shouldUseLocalizationTable: options.useTable ?? true },
    entries: [
      { identifier: { key: '', context: '', source: 'A' }, translations: [{ locale: 'zh-hans', translationText: '旧甲', translator: { agentType: 'Automation' } }, { locale: 'ja', translationText: 'あ', translator: { agentType: 'User' } }] },
      { identifier: { key: '', context: 'ctx', source: 'B' }, translations: [{ locale: 'ja', translationText: 'ctx-b' }] },
    ] as any[],
    patches: [] as any[], writes: [] as string[],
  };
  const http = new HttpClient({ apiKey: 'fake', intervalMs: 0, retries: 0, fetch: (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET' && !url.pathname.endsWith('/autolocalizationtable')) state.writes.push(`${method} ${url.pathname}`);
    if (url.host === 'locale.roblox.com') return Response.json({ data: ['en', 'ja', 'zh-hans', 'fr'].map(code => ({ locale: { locale: code + '_x', language: { languageCode: code } } })) });
    if (url.pathname.endsWith('/source-language/games/1')) { if (method === 'PATCH') state.source = url.searchParams.get('languageCode')!; return Response.json({ languageCode: state.source }); }
    if (url.pathname.endsWith('/supported-languages/games/1')) { if (method === 'PATCH') for (const row of body) state.supported.add(row.languageCode); return Response.json({ data: [...state.supported].map(languageCode => ({ languageCode, languageCodeType: 'Language' })) }); }
    if (url.pathname.endsWith('/automatic-translation-status') && method === 'GET') return Response.json({ data: [...state.supported].map(languageCode => ({ languageCode, languageCodeType: 'Language', isAutomaticTranslationEnabled: state.auto.get(languageCode) ?? false })) });
    if (url.pathname.endsWith('/automatic-translation-status')) { const code = url.pathname.split('/').at(-2)!; state.auto.set(code, body); return Response.json({ isAutomaticTranslationEnabled: body }); }
    if (url.pathname.endsWith('/autolocalizationtable')) return Response.json({ ...state.settings, autoLocalizationTableId: 't1', sourceLanguage: state.source });
    if (url.pathname.endsWith('/settings')) { state.settings = { isAutolocalizationEnabled: body.isAutolocalizationEnabled, isAutomaticEntriesSettingEnabled: body.isAutomaticEntriesSettingEnabled, isAutomaticEntriesDeletionEnabled: body.isAutomaticEntriesDeletionsEnabled, shouldUseLocalizationTable: body.shouldUseLocalizationTable }; return Response.json({}); }
    if (url.pathname.endsWith('/localization-table/limits')) return Response.json({ entryOperationLimits: { maxSourceLength: 300 }, tableOperationLimits: { maxEntriesPerUpdate: 1 } });
    if (url.pathname.endsWith('/tables/t1/entries')) return Response.json({ data: state.entries, nextPageCursor: null });
    if (url.pathname.endsWith('/tables/t1') && method === 'PATCH') {
      state.patches.push(body);
      if (body.entries.some((e: any) => e.identifier.source === 'BAD')) return new Response(null, { status: 400 });
      const hiRows = body.entries.filter((e: any) => e.translations.some((t: any) => t.locale === 'hi'));
      if (hiRows.length) return Response.json({ modifiedEntriesAndTranslations: body.entries.filter((e: any) => !hiRows.includes(e)).map((e: any) => ({ identifier: e.identifier, translations: e.translations })), failedEntriesAndTranslations: hiRows.map((e: any) => ({ error: { errorCode: 0, errorMessage: 'LocalizationTargetNotSupported' }, identifier: e.identifier, translations: e.translations.filter((t: any) => t.locale === 'hi') })) });
      return Response.json({ modifiedEntriesAndTranslations: body.entries.map((e: any) => ({ identifier: e.identifier, translations: e.translations })), failedEntriesAndTranslations: [] });
    }
    throw new Error(`unexpected ${method} ${url.href}`);
  }) as typeof fetch });
  return { state, cloud: new CloudLocalizationTable(http) };
}

test('enable is idempotent and fixes source, languages, auto-translation and settings', async () => {
  const { state, cloud } = robloxFake({ source: 'zh-hans' });
  const first = await enableLocalization(cloud, '1');
  assert.equal(state.source, 'en');
  assert.ok(state.supported.has('fr'));
  assert.equal(state.auto.get('ja'), true); assert.equal(state.auto.get('fr'), true);
  assert.deepEqual(state.settings, { isAutolocalizationEnabled: true, isAutomaticEntriesSettingEnabled: true, isAutomaticEntriesDeletionEnabled: false, shouldUseLocalizationTable: true });
  assert.equal(first.warnings.length, 1); assert.equal(first.failures.length, 0);
  const writes = state.writes.length;
  const second = await enableLocalization(cloud, '1');
  assert.deepEqual(second.changes, []); assert.equal(state.writes.length, writes);
});

test('sync refuses games that are not enabled', async () => {
  const { cloud } = robloxFake({ useTable: false });
  await assert.rejects(syncLocalization(LocalizationTable.fromRbxm(tableFile([['A', '甲']])), ['1'], cloud, { out: 'x', backupDirectory: 'y' }), /localization enable/);
});

test('sync translates missing locales, writes the table and pushes add/modify only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-sync-'));
  try {
    const { state, cloud } = robloxFake();
    const { client } = deepseekFake(items => Object.fromEntries(items.map((item: any) => [item.id, Object.fromEntries(item.to.map((l: string) => [l, `${l}-${item.en}`]))])));
    const table = LocalizationTable.fromRbxm(tableFile([['A', '甲'], ['B', '乙']], { ja: [['A', 'あ']] }));
    const result = await syncLocalization(table, ['1'], cloud, { out: join(dir, 'out.rbxm'), backupDirectory: join(dir, 'b'), translator: { client, model: 'deepseek-chat' } });
    assert.deepEqual(result.translated, { ja: 1 });
    const saved = readRbxm(await readFile(result.out!))[0]!;
    assert.equal(saved.name, '本地化表__sync');
    assert.equal(parseLanguageSource(saved.children[0]!.source!, 'ja').get('B'), 'ja-B');
    const game = result.games[0]!;
    // A/zh-hans modified (cloud 旧甲); B/zh-hans and B/ja added; A/ja unchanged; context entry ignored.
    assert.deepEqual({ added: game.added, modified: game.modified, failed: game.failed.length }, { added: 2, modified: 1, failed: 0 });
    assert.equal(state.patches.length, 2, 'batched by maxEntriesPerUpdate');
    assert.ok(state.patches.every(p => p.entries.every((e: any) => e.delete === undefined && e.identifier.context === '' && e.translations.every((t: any) => t.delete === undefined))));
    assert.ok(game.backupPath);
    const dry = await syncLocalization(LocalizationTable.fromRbxm(tableFile([['A', '甲']])), ['1'], cloud, { out: join(dir, 'dry.rbxm'), backupDirectory: join(dir, 'b'), dryRun: true });
    assert.equal(dry.out, undefined); assert.equal(state.patches.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('import seeds only empty slots and can skip automatic translations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-imp-'));
  try {
    const { cloud, state } = robloxFake();
    state.entries[0].translations.push({ locale: 'fr', translationText: 'auto-fr', translator: { agentType: 'Automation' } });
    const table = LocalizationTable.fromRbxm(tableFile([['A', '甲'], ['B', '乙']]));
    const result = await importFromCloud(table, '1', cloud, { out: join(dir, 'o.rbxm'), humanOnly: true });
    assert.deepEqual(result.imported, { ja: 1 }); assert.equal(result.skippedAutomatic, 1);
    assert.equal(table.get('B', 'ja'), undefined, 'context entries are never imported');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('push isolates a 400 entry by splitting and reads nested per-entry errors', async () => {
  const { cloud } = robloxFake();
  const rows = ['a', 'b', 'BAD', 'c', 'd'].map(source => ({ source, locale: 'ja', text: 'x' }));
  const result = await cloud.push('1', 't1', [...rows, { source: 'e', locale: 'hi', text: 'y' }], 10);
  assert.deepEqual(result.failed.map(f => [f.source, f.error.startsWith('HTTP_ERROR')]), [['BAD', true], ['e', false]]);
  assert.equal(result.failed[1]!.error, 'LocalizationTargetNotSupported');
  assert.equal(result.modified, 4);
});

test('loading a previous sync output strips the import suffix', () => {
  const file = writeRbxm([{ className: 'ModuleScript', name: '本地化表__sync', source: master([['A', '甲']]), children: [] }]);
  assert.equal(LocalizationTable.fromRbxm(file).name, '本地化表');
});
