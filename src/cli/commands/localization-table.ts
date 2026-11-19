import type { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import password from '@inquirer/password';
import { CredentialStore, deepseekCredential, validateKey } from '../../auth/credentials.js';
import { AppError } from '../../core/errors.js';
import { studioTableReadLuau, studioTableWriteLuau } from '../../localization/studio-table.js';
import { parseTablePatch, parseTableSnapshot, tableTarget, translateTable } from '../../localization/table.js';
import { DeepSeekClient, TranslationCache, readDeepSeekConfig, writeDeepSeekConfig } from '../../translation/deepseek.js';
import { LocalStore, defaultHome } from '../../storage/store.js';
import { clean, emit } from '../output.js';

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(resolve(path), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new AppError('ARGUMENT_ERROR', 'Cannot read the input file as UTF-8 JSON.'); }
}

export function registerLocalizationTable(program: Command, localization: Command, signal: AbortSignal): void {
  const json = () => Boolean(program.opts().json);
  const home = () => resolve(program.opts().home ?? defaultHome());
  const table = localization.command('table').description('Manage native game text in a Studio LocalizationTable');
  const studioCommand = (name: string) => table.command(name)
    .requiredOption('--place <id>', 'Studio edit Place ID')
    .requiredOption('--table <name>', 'LocalizationTable directly under LocalizationService');

  studioCommand('read').description('Generate Studio Luau to query native entries and count missing translations')
    .option('--source <text...>', 'Match exact English sources and include their entries')
    .option('--missing', 'Include only entries with missing translations')
    .option('--locales <code...>', 'Locales to check (defaults to the 17 supported translation languages)')
    .action(options => {
      const target = tableTarget(options.place, options.table);
      const studioLuau = studioTableReadLuau(target, { sources: options.source, missing: options.missing, locales: options.locales });
      emit({ ...target, studioLuau }, json(), studioLuau);
    });

  studioCommand('write').description('Validate a translation patch and generate guarded Studio Luau to apply it')
    .requiredOption('--file <json>', 'Patch with entries containing source, values and expected old values')
    .option('--dry-run', 'Generate Studio Luau to check conflicts and count changes')
    .action(async options => {
      const patch = parseTablePatch(await readJson(options.file), tableTarget(options.place, options.table));
      const dryRun = Boolean(options.dryRun);
      const studioLuau = studioTableWriteLuau(patch, dryRun);
      emit({ placeId: patch.placeId, table: patch.table, entries: patch.entries.length, dryRun, studioLuau }, json(), studioLuau);
    });

  table.command('translate').description('Use DeepSeek to fill missing locales from a Studio read result')
    .requiredOption('--file <json>', 'Studio JSON from table read --missing or --source')
    .option('--out <json>', 'Save the guarded patch to a new JSON file')
    .option('--concurrency <n>', 'Parallel requests (1–32)', '8')
    .action(async options => {
      const snapshot = parseTableSnapshot(await readJson(options.file));
      const concurrency = Number(options.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new AppError('ARGUMENT_ERROR', '--concurrency must be 1–32.');
      const cache = await new TranslationCache(join(home(), 'localization-cache', 'translations.jsonl')).load();
      const result = await translateTable(snapshot, async () => {
        const client = new DeepSeekClient(await new CredentialStore(home(), deepseekCredential).get(), { signal });
        return { client, model: await client.resolveModel((await readDeepSeekConfig(home())).model) };
      }, { cache, concurrency, signal, progress: (done, total) => {
        if (!json()) process.stderr.write(`Translated ${done}/${total}\n`);
      } });
      const out = options.out ? resolve(options.out) : undefined;
      if (out) {
        try { await writeFile(out, JSON.stringify(result.patch, null, 2) + '\n', { flag: 'wx' }); }
        catch { throw new AppError('STORAGE_ERROR', 'Cannot create the patch file. Choose a path that does not already exist.'); }
      }
      const warnings = result.failures.map(failure => ({
        code: 'TRANSLATION_FAILED', message: `${failure.locale}: ${failure.reason}`, resource: failure.source,
      }));
      const count = result.patch.entries.reduce((sum, entry) => sum + Object.keys(entry.values).length, 0);
      emit({ ...result, out }, json(), `Prepared ${count}/${result.missing} missing translations (${result.cached} cached).${out ? `\nPatch: ${clean(out)}` : '\nUse --json for the patch or --out to save it.'}`, warnings);
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
    const models = await new DeepSeekClient(key, { signal: signal }).models();
    const local = new LocalStore(home());
    await local.locked(() => new CredentialStore(local.home, deepseekCredential).set(key));
    emit({ storage: 'Windows DPAPI', models }, json(), `已保存 DeepSeek Key。可用模型：${models.join(', ')}`);
  });
  auth.command('clear').action(async () => {
    const local = new LocalStore(home());
    await local.locked(() => new CredentialStore(local.home, deepseekCredential).clear());
    emit({ cleared: true }, json(), '已删除保存的 DeepSeek Key。');
  });
  deepseek.command('models').description('List models currently offered and the one table translate would use').action(async () => {
    const client = new DeepSeekClient(await new CredentialStore(home(), deepseekCredential).get(), { signal: signal });
    const configured = (await readDeepSeekConfig(home())).model;
    const models = await client.models();
    let selected: string | null = null;
    try { selected = await client.resolveModel(configured); } catch { /* reported below */ }
    emit({ models, configured: configured ?? null, selected }, json(), `可用模型：${models.join(', ')}\n配置：${configured ?? '（未设置）'}\n补译将使用：${selected ?? '无可用模型'}`);
  });
  deepseek.command('config').description('Set the preferred model').option('--model <id>', 'Model ID from rbx deepseek models').action(async options => {
    const config = await readDeepSeekConfig(home());
    if (options.model !== undefined) config.model = String(options.model);
    await writeDeepSeekConfig(home(), config);
    emit(config, json(), `模型：${config.model ?? '（未设置，默认 deepseek-flash）'}`);
  });
}
