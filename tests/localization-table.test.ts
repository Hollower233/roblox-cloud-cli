import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTablePatch, parseTableSnapshot, tableTarget, translateTable } from '../src/localization/table.js';
import { readRbxm, writeRbxm } from '../src/localization/rbxm.js';
import { DeepSeekClient, checkTranslation, translate, TranslationCache } from '../src/translation/deepseek.js';

test('rbxm round-trips nested ModuleScripts compressed and uncompressed', () => {
  const tree = [{ className: 'ModuleScript', name: '表', source: 'return {}', children: [{ className: 'ModuleScript', name: 'ja', source: 'x'.repeat(5000) + 'é', children: [] }] }];
  for (const compress of [true, false]) {
    const [root] = readRbxm(writeRbxm(tree, { compress }));
    assert.equal(root!.name, '表'); assert.equal(root!.children[0]!.source, 'x'.repeat(5000) + 'é');
  }
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

test('native patch validates guarded writes and preserves exact originals', () => {
  const target = tableTarget('123', 'GameTranslations');
  const source = '  Hi "hi"\n{a:int}  ';
  const input = { entries: [{ source, values: { ja: 'やあ\n{a:int}' }, expected: { ja: null } }] };
  const patch = parseTablePatch(input, target);
  assert.deepEqual(patch.entries[0], { key: '', source, context: '', values: input.entries[0]!.values, expected: { ja: null }, expectedZh: undefined });
  assert.throws(() => parseTablePatch({ placeId: '456', ...input }, target), /different Place/);
  assert.throws(() => parseTablePatch({ entries: [{ ...input.entries[0]!, expected: {} }] }, target), /exact old value/);
  assert.throws(() => parseTablePatch({ entries: [{ ...input.entries[0]!, values: { ja: 'やあ {a:int}' } }] }, target), /line breaks differ/);
  assert.throws(() => parseTablePatch({ entries: [...input.entries, ...input.entries] }, target), /Duplicate Key\/Source\/Context/);
});

test('native table translation preserves contexts and can fill a patch from cache without credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rbx-ds-native-'));
  try {
    const cache = await new TranslationCache(join(dir, 'c.jsonl')).load();
    await cache.put([{ en: 'Shop', zh: '商店', locale: 'ja', text: 'ショップ' }, { en: 'Shop', zh: '买东西', locale: 'ja', text: '買い物' }]);
    const snapshot = parseTableSnapshot({
      placeId: '123', table: 'GameTranslations', sourceLocale: 'en-us', locales: ['ja', 'zh-hans'],
      entries: [
        { source: 'Shop', context: 'menu', values: { 'zh-hans': '商店' } },
        { source: 'Shop', context: 'verb', values: { 'zh-hans': '买东西', ja: '' } },
        { source: 'Back', values: { 'zh-hans': '返回', ja: '戻る' } },
        { source: 'Leave', values: [] },
      ],
    });
    const never = async () => { throw new Error('provider should not be initialized'); };
    const result = await translateTable(snapshot, never, { cache });
    assert.equal(result.cached, 2);
    assert.equal(result.missing, 3);
    assert.deepEqual(result.patch.entries.map(entry => [entry.context, entry.expectedZh, entry.expected.ja, entry.values.ja]), [
      ['menu', '商店', null, 'ショップ'], ['verb', '买东西', '', '買い物'],
    ]);
    assert.deepEqual(result.failures.map(failure => [failure.source, failure.locale]), [['Leave', 'ja']]);
    assert.deepEqual((await translateTable({ ...snapshot, entries: [] }, never, {})).patch.entries, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
