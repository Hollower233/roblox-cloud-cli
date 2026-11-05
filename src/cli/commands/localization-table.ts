import type { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import password from '@inquirer/password';
import { CredentialStore, deepseekCredential, validateKey } from '../../auth/credentials.js';
import { AppError } from '../../core/errors.js';
import { CloudLocalizationTable, enableLocalization } from '../../localization/cloud-table.js';
import { importFromCloud, syncLocalization } from '../../localization/sync.js';
import { MASTER_NAME } from '../../localization/lua-table.js';
import { LocalizationTable, MASTER_LOCALE, SOURCE_LOCALE, studioSwapLuau } from '../../localization/table.js';
import { DeepSeekClient, TranslationCache, readDeepSeekConfig, writeDeepSeekConfig } from '../../translation/deepseek.js';
import { LocalStore, defaultHome } from '../../storage/store.js';
import type { CommandContext } from '../context.js';
import { clean, emit } from '../output.js';
import type { Warning } from '../../universes/models.js';

const STUDIO_PARENT = 'game.ServerStorage["项目文档"]';

export function registerLocalizationTable(program: Command, localization: Command, context: CommandContext): void {
  const json = () => Boolean(program.opts().json);
  const home = () => resolve(program.opts().home ?? defaultHome());
  const cloud = async (input: string) => { const { universeId, http } = await context.universe(input); return { universeId, cloud: new CloudLocalizationTable(http) }; };
  const defaultOut = (source: string) => join(dirname(resolve(source)), `${basename(source, extname(source))}.synced.rbxm`);
  const swapHint = (name: string, parent: string) => `\n导入 Studio：import_rbxm 到 ${parent}，再用 execute_luau 执行：\n${studioSwapLuau(parent, name)}`;

  localization.command('init').description('Write an empty master table .rbxm (standard header) to import into Studio for a new project')
    .option('--out <rbxm>', 'Output .rbxm', `${MASTER_NAME}.rbxm`)
    .option('--force', 'Overwrite an existing file')
    .option('--parent <path>', 'Studio parent of the table, used in the import hint', STUDIO_PARENT)
    .action(async options => {
      const table = LocalizationTable.empty();
      const out = await table.create(options.out, { force: Boolean(options.force) });
      emit({ out, name: table.name, parent: options.parent }, json(), `空本地化表：${out}\n导入 Studio：import_rbxm 到 ${options.parent}（不存在先建 Folder），得到 ${options.parent}[${JSON.stringify(table.name)}]；按表头在 return { 之后逐条写入 { en = "...", zh = "..." }，语言子模块由 sync 生成。`);
    });

  localization.command('enable <games...>').description('Turn on game localization: source en, all languages + auto-translation, table in use, ATC on, auto-deletion off (idempotent)')
    .option('--dry-run', 'Show what would change without writing')
    .action(async (inputs: string[], options) => {
      const results = [];
      for (const input of inputs) {
        const { universeId, cloud: client } = await cloud(input);
        results.push(await enableLocalization(client, universeId, { dryRun: Boolean(options.dryRun) }));
      }
      const warnings: Warning[] = results.flatMap(r => r.failures.map(f => ({ code: 'ENABLE_STEP_FAILED', message: `${f.step}: ${f.error}`, resource: r.universeId })));
      emit(results, json(), results.map(r => `游戏 ${r.universeId}${r.dryRun ? '（预览）' : ''}：${r.changes.length ? '\n  ' + r.changes.map(clean).join('\n  ') : '已全部符合，无改动'}${r.warnings.map(w => `\n  ⚠ ${clean(w)}`).join('')}`).join('\n'), warnings);
    });

  localization.command('sync <games...>').description('Translate missing locales with DeepSeek, write the full table .rbxm, then push add/modify to each game')
    .requiredOption('--source <rbxm>', 'Localization table exported from Studio (export_rbxm)')
    .option('--out <rbxm>', 'Output .rbxm (default: <source>.synced.rbxm)')
    .option('--retranslate <source...>', 'Exact English sources to translate again for all locales')
    .option('--concurrency <n>', 'Parallel DeepSeek requests', '8')
    .option('--parent <path>', 'Studio parent of the table, used in the import hint', STUDIO_PARENT)
    .option('--dry-run', 'Count missing translations and pending pushes; no DeepSeek calls or writes')
    .action(async (inputs: string[], options) => {
      const table = await LocalizationTable.load(options.source);
      const concurrency = Number(options.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new AppError('ARGUMENT_ERROR', '--concurrency must be 1–32.');
      const targets = [];
      for (const input of inputs) targets.push(await cloud(input));
      let translator;
      if (!options.dryRun) {
        try {
          const client = new DeepSeekClient(await new CredentialStore(home(), deepseekCredential).get(), { signal: context.signal });
          const model = await client.resolveModel((await readDeepSeekConfig(home())).model);
          translator = { client, model, concurrency, cache: await new TranslationCache(join(home(), 'localization-cache', 'translations.jsonl')).load() };
        } catch (error) { if (!(error instanceof AppError && error.code === 'AUTH_REQUIRED')) throw error; }
      }
      const result = await syncLocalization(table, targets.map(t => t.universeId), targets[0]!.cloud, {
        out: options.out ?? defaultOut(options.source), backupDirectory: join(home(), 'localization-backups'),
        retranslate: options.retranslate, dryRun: Boolean(options.dryRun), translator, signal: context.signal,
        progress: message => { if (!json()) process.stderr.write(clean(message) + '\n'); },
      });
      const warnings: Warning[] = [
        ...result.translationFailures.map(f => ({ code: 'TRANSLATION_FAILED', message: `${f.locale}: ${f.reason}`, resource: f.en })),
        ...result.games.flatMap(g => [...(g.error ? [{ code: 'PUSH_FAILED', message: g.error, resource: g.universeId }] : []),
          ...g.failed.map(f => ({ code: 'ENTRY_REJECTED', message: `${f.locale ?? ''} ${f.error}`.trim(), resource: `${g.universeId}: ${f.source}` }))]),
      ];
      const translatedTotal = Object.values(result.translated).reduce((a, b) => a + b, 0);
      const lines = [
        `${result.dryRun ? '预览' : '完成'}：${result.entries} 条原文，${result.locales.length} 种待翻译语言`,
        `${result.dryRun ? '缺失译文' : '新译文'}：${translatedTotal}${result.cachedTranslations ? `（其中缓存 ${result.cachedTranslations}）` : ''}${translatedTotal ? `；${Object.entries(result.translated).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`,
        ...(result.model ? [`模型：${result.model}；请求 ${result.usage!.requests} 次，输入 ${result.usage!.promptTokens} tokens（缓存命中 ${result.usage!.cacheHitTokens}），输出 ${result.usage!.completionTokens} tokens`] : []),
        ...(result.translationFailures.length ? [`翻译失败：${result.translationFailures.length}（未写入）`] : []),
        ...(result.removedOrphans ? [`清理已不在主表中的旧译文：${result.removedOrphans}`] : []),
        ...result.games.map(g => `游戏 ${g.universeId}：${g.error ? `失败 ${clean(g.error)}` : `新增 ${g.added}，修改 ${g.modified}${g.failed.length ? `，被拒 ${g.failed.length}` : ''}${g.backupPath ? `；备份 ${g.backupPath}` : ''}`}`),
        ...(result.out ? [`本地化表：${result.out}${swapHint(table.name, options.parent)}`] : []),
      ];
      emit({ ...result, studioSwapLuau: result.out ? studioSwapLuau(options.parent, table.name) : undefined }, json(), lines.join('\n'), warnings);
    });

  localization.command('import <game>').description('First-time seeding: copy a game\'s existing cloud translations into empty local slots')
    .requiredOption('--source <rbxm>', 'Localization table exported from Studio')
    .option('--out <rbxm>', 'Output .rbxm (default: <source>.synced.rbxm)')
    .option('--human-only', 'Import only translations whose translator is a user, skipping automatic ones')
    .option('--parent <path>', 'Studio parent of the table, used in the import hint', STUDIO_PARENT)
    .action(async (input: string, options) => {
      const table = await LocalizationTable.load(options.source);
      const { universeId, cloud: client } = await cloud(input);
      const result = await importFromCloud(table, universeId, client, { out: options.out ?? defaultOut(options.source), humanOnly: Boolean(options.humanOnly), signal: context.signal });
      const total = Object.values(result.imported).reduce((a, b) => a + b, 0);
      emit({ ...result, studioSwapLuau: studioSwapLuau(options.parent, table.name) }, json(), `从游戏 ${universeId} 导入 ${total} 个译文${result.skippedAutomatic ? `，跳过自动译文 ${result.skippedAutomatic}` : ''}${Object.keys(result.skippedLocales).length ? `，跳过地区代码 ${Object.entries(result.skippedLocales).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}\n${Object.entries(result.imported).map(([k, v]) => `${k} ${v}`).join(', ')}\n本地化表：${result.out}${swapHint(table.name, options.parent)}`);
    });

  localization.command('export').description('Export the local table .rbxm as JSON (en, zh-hans and every locale)')
    .requiredOption('--source <rbxm>', 'Localization table exported from Studio')
    .option('--out <json>', 'Write to a file instead of stdout')
    .action(async options => {
      const table = await LocalizationTable.load(options.source);
      const locales = [...table.languages.keys()].sort();
      const data = { sourceLocale: SOURCE_LOCALE, locales: [MASTER_LOCALE, ...locales], entries: table.rows.map(row => {
        const entry: Record<string, string> = { [SOURCE_LOCALE]: row.en, [MASTER_LOCALE]: row.zh };
        for (const locale of locales) { const text = table.get(row.en, locale); if (text) entry[locale] = text; }
        return entry;
      }) };
      if (options.out) {
        await writeFile(resolve(options.out), JSON.stringify(data, null, 2) + '\n', 'utf8');
        emit({ out: resolve(options.out), entries: data.entries.length, locales: data.locales }, json(), `已导出 ${data.entries.length} 条、${data.locales.length} 种语言到 ${resolve(options.out)}`);
      } else process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    });

  localization.command('show <source>').description('Show every translation of one exact English source')
    .requiredOption('--source-file <rbxm>', 'Localization table exported from Studio')
    .action(async (source: string, options) => {
      const table = await LocalizationTable.load(options.sourceFile);
      const row = table.rows.find(r => r.en === source);
      if (!row) throw new AppError('ARGUMENT_ERROR', `Not in master: ${JSON.stringify(source)}`);
      const translations: Record<string, string | null> = { [MASTER_LOCALE]: row.zh };
      for (const locale of [...table.languages.keys()].sort()) translations[locale] = table.get(source, locale) ?? null;
      emit({ en: source, translations }, json(), `${JSON.stringify(clean(source))}\n${Object.entries(translations).map(([k, v]) => `  ${k}\t${v === null ? '（缺失）' : clean(v)}`).join('\n')}`);
    });

  const deepseek = program.command('deepseek').description('DeepSeek translation settings');
  const auth = deepseek.command('auth').description('DeepSeek API key (DEEPSEEK_API_KEY overrides the saved key)');
  auth.command('set').option('--key-file <path>', 'Read the key from a file instead of prompting').action(async options => {
    let key: string;
    if (options.keyFile) {
      try { key = validateKey(await readFile(resolve(options.keyFile), 'utf8')); }
      catch (e) { if (e instanceof AppError) throw e; throw new AppError('ARGUMENT_ERROR', 'Cannot read the key file.'); }
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('ARGUMENT_ERROR', 'Use --key-file when no interactive terminal is available.');
      key = validateKey(await password({ message: 'DeepSeek API Key', mask: '*' }));
    }
    const models = await new DeepSeekClient(key, { signal: context.signal }).models();
    const local = new LocalStore(home());
    await local.locked(() => new CredentialStore(local.home, deepseekCredential).set(key));
    emit({ storage: 'Windows DPAPI', models }, json(), `已保存 DeepSeek Key。可用模型：${models.join(', ')}`);
  });
  auth.command('clear').action(async () => {
    const local = new LocalStore(home());
    await local.locked(() => new CredentialStore(local.home, deepseekCredential).clear());
    emit({ cleared: true }, json(), '已删除保存的 DeepSeek Key。');
  });
  deepseek.command('models').description('List models currently offered and the one sync would use').action(async () => {
    const client = new DeepSeekClient(await new CredentialStore(home(), deepseekCredential).get(), { signal: context.signal });
    const configured = (await readDeepSeekConfig(home())).model;
    const models = await client.models();
    let selected: string | null = null;
    try { selected = await client.resolveModel(configured); } catch { /* reported below */ }
    emit({ models, configured: configured ?? null, selected }, json(), `可用模型：${models.join(', ')}\n配置：${configured ?? '（未设置）'}\nsync 将使用：${selected ?? '无可用模型'}`);
  });
  deepseek.command('config').description('Set the preferred model').option('--model <id>', 'Model ID from rbx deepseek models').action(async options => {
    const config = await readDeepSeekConfig(home());
    if (options.model !== undefined) config.model = String(options.model);
    await writeDeepSeekConfig(home(), config);
    emit(config, json(), `模型：${config.model ?? '（未设置，默认 deepseek-flash）'}`);
  });
}
