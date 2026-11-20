import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import password from '@inquirer/password';
import { CredentialStore, deepseekCredential, validateKey } from '../../auth/credentials.js';
import { AppError } from '../../core/errors.js';
import { studioTableReadLuau, studioTableWriteLuau } from '../../localization/studio-table.js';
import { CHINESE_LOCALE, parseTablePatch, parseTableSnapshot, tableLocales, tableTarget, translateTable, type TablePatch } from '../../localization/table.js';
import { checkTranslation, DeepSeekClient, TranslationCache, readDeepSeekConfig, writeDeepSeekConfig } from '../../translation/deepseek.js';
import { withStudioEdit } from '../../studio/mcp.js';
import { LocalStore, defaultHome } from '../../storage/store.js';
import { clean, emit } from '../output.js';

const TABLE_NAME = 'GameTranslations';

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(resolve(path), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new AppError('ARGUMENT_ERROR', 'Cannot read the input file as UTF-8 JSON.'); }
}

function receipt(value: unknown) {
  if (!value || typeof value !== 'object' || !('status' in value) ||
      !['preview', 'verified', 'conflict'].includes(String(value.status))) {
    throw new AppError('INVALID_RESPONSE', 'Studio returned no write receipt.');
  }
  return value as { status: string; updatedValues?: number; conflicts?: unknown[]; readbackOnly?: boolean };
}

async function readback(patch: TablePatch, signal: AbortSignal): Promise<boolean> {
  return withStudioEdit(patch.placeId, signal, async execute => {
    const current = parseTableSnapshot(await execute(studioTableReadLuau(patch, {
      sources: [...new Set(patch.entries.map(row => row.source))],
    })));
    return patch.entries.every(row => {
      const observed = current.entries.find(entry => entry.key === row.key && entry.source === row.source && entry.context === row.context);
      return Object.entries(row.values).every(([code, text]) => observed?.values[code] === text);
    });
  });
}

async function applyPatch(execute: (code: string) => Promise<unknown>, patch: TablePatch, dryRun: boolean, signal: AbortSignal) {
  try { return receipt(await execute(studioTableWriteLuau(patch, dryRun))); }
  catch (error) {
    if (dryRun || !(error instanceof AppError) || !['TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code)) throw error;
    try {
      if (await readback(patch, signal)) return { status: 'verified', readbackOnly: true };
    } catch (recovery) {
      if (recovery instanceof AppError && recovery.code === 'CANCELLED') throw recovery;
    }
    throw new AppError(error.code, `Studio write could not be confirmed. Read the table before retrying. ${error.message}`);
  }
}

const conflictWarning = [{ code: 'STUDIO_CONFLICT', message: 'A translation changed in Studio. Refresh the affected entries before retrying.' }];

export function registerLocalizationTable(program: Command, localization: Command, signal: AbortSignal): void {
  const json = () => Boolean(program.opts().json);
  const home = () => resolve(program.opts().home ?? defaultHome());
  const table = localization.command('table').description('Manage Studio LocalizationService.GameTranslations through official Studio MCP');
  const studioCommand = (name: string) => table.command(name).requiredOption('--place <id>', 'Studio edit Place ID');

  studioCommand('read').description('Read translations or coverage from Studio')
    .option('--source <text...>', 'Match exact English sources and include their entries')
    .option('--locale <code>', 'Return only one translation language for exact-source matches')
    .option('--missing', 'Include entries with missing translations')
    .option('--locales <code...>', 'Locales to check (defaults to the 17 supported translation languages)')
    .action(async options => {
      if (options.locale && (!options.source || options.missing || options.locales)) {
        throw new AppError('ARGUMENT_ERROR', '--locale requires --source and cannot be combined with --missing or --locales.');
      }
      const target = tableTarget(options.place, TABLE_NAME);
      const code = studioTableReadLuau(target, { sources: options.source, missing: options.missing, locales: options.locale ? [options.locale] : options.locales });
      const result = await withStudioEdit(target.placeId, signal, async execute => {
        const response = await execute(code);
        const snapshot = parseTableSnapshot(response);
        return {
          ...(response as object), ...snapshot,
          entries: snapshot.entries.map(entry => options.locale ? {
            ...entry, values: entry.values[options.locale] === undefined ? {} : { [options.locale]: entry.values[options.locale] },
          } : entry),
        } as typeof snapshot & { total: number; matching: number; missingEntries: number; notFound: string[]; missingByLocale: Record<string, number> };
      });
      const lines = [`${result.matching}/${result.total} entries. ${result.missingEntries} with missing translations.`];
      for (const row of result.entries) {
        const values = Object.entries(row.values).map(([code, text]) => `${code} ${clean(text)}`);
        lines.push(`${clean(row.source)}${row.key || row.context ? ` [${clean(row.key)} / ${clean(row.context)}]` : ''}${values.length ? `\n  ${values.join('\n  ')}` : ''}`);
      }
      if (result.notFound.length) lines.push(`Not found: ${result.notFound.map(clean).join(', ')}`);
      const missing = Object.entries(result.missingByLocale).filter(([, count]) => count);
      if (missing.length) lines.push(`Missing by locale: ${missing.map(([code, count]) => `${code} ${count}`).join(', ')}`);
      emit(result, json(), lines.join('\n'));
    });

  studioCommand('write').description('Apply a guarded translation update and verify it in Studio')
    .option('--file <json>', 'Batch patch with source, values and expected old values')
    .option('--source <text>', 'Exact English source for a single translation update')
    .option('--locale <code>', 'Language for a single translation update')
    .option('--text <text>', 'New translation for a single update')
    .option('--dry-run', 'Check conflicts and count changes in Studio')
    .action(async options => {
      const target = tableTarget(options.place, TABLE_NAME);
      const single = [options.source, options.locale, options.text];
      if (options.file ? single.some(value => value !== undefined) : single.some(value => value === undefined)) {
        throw new AppError('ARGUMENT_ERROR', 'Use either --file or all of --source, --locale and --text.');
      }
      const batch = options.file ? parseTablePatch(await readJson(options.file), target) : undefined;
      if (!batch) parseTablePatch({ entries: [{ source: options.source, values: { [options.locale]: options.text }, expected: { [options.locale]: null } }] }, target);
      const dryRun = Boolean(options.dryRun);
      const result = await withStudioEdit(target.placeId, signal, async execute => {
        let patch = batch;
        if (!patch) {
          const snapshot = parseTableSnapshot(await execute(studioTableReadLuau(target, { sources: [options.source] })));
          const row = snapshot.entries.find(entry => !entry.key && !entry.context);
          patch = parseTablePatch({
            entries: [{ source: options.source, values: { [options.locale]: options.text }, expected: { [options.locale]: row?.values[options.locale] ?? null } }],
          }, target);
        }
        return applyPatch(execute, patch, dryRun, signal);
      });
      emit(result, json(), `Studio: ${result.status}${result.updatedValues === undefined ? '' : `, ${result.updatedValues} translation changes`}.`,
        result.status === 'conflict' ? conflictWarning : []);
    });

  studioCommand('translate').description('Find missing translations, use cache or DeepSeek, and write them back to Studio')
    .option('--source <text...>', 'Restrict to these exact English sources')
    .option('--locales <code...>', 'Locales to fill (defaults to the 17 supported translation languages)')
    .option('--dry-run', 'Count missing translations and cached results without writing')
    .option('--concurrency <n>', 'Parallel requests (1–32)', '8')
    .action(async options => {
      const target = tableTarget(options.place, TABLE_NAME);
      const locales = tableLocales(options.locales);
      const concurrency = Number(options.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new AppError('ARGUMENT_ERROR', '--concurrency must be 1–32.');
      await withStudioEdit(target.placeId, signal, async execute => {
        const response = await execute(studioTableReadLuau(target, { sources: options.source, locales, missing: true })) as {
          missingByLocale: Record<string, number>; notFound?: string[];
        };
        const snapshot = parseTableSnapshot(response);
        const cache = snapshot.entries.length ? await new TranslationCache(join(home(), 'localization-cache', 'translations.jsonl')).load() : undefined;
        if (options.dryRun) {
          let cached = 0;
          for (const row of snapshot.entries) {
            const zh = row.values[CHINESE_LOCALE];
            if (!zh?.trim()) continue;
            for (const code of snapshot.locales) {
              if (code === CHINESE_LOCALE || row.values[code]?.trim()) continue;
              const hit = cache?.get(row.source, zh, code);
              if (hit !== undefined && !checkTranslation(row.source, hit)) cached++;
            }
          }
          const missing = Object.values(response.missingByLocale).reduce((sum, count) => sum + count, 0);
          emit({ status: 'preview', missing, cached, missingByLocale: response.missingByLocale }, json(), `Missing: ${missing}, cached: ${cached}.`);
          return;
        }
        const result = await translateTable(snapshot, async () => {
          const client = new DeepSeekClient(await new CredentialStore(home(), deepseekCredential).get(), { signal });
          return { client, model: await client.resolveModel((await readDeepSeekConfig(home())).model) };
        }, { cache, concurrency, signal, progress: (done, total) => {
          if (!json()) process.stderr.write(`Translated ${done}/${total}\n`);
        } });
        const unapplied = response.missingByLocale[CHINESE_LOCALE] ?? 0;
        const write = result.patch.entries.length ? await applyPatch(execute, result.patch, false, signal) : { status: 'no_changes' };
        const warnings = result.failures.map(failure => ({
          code: 'TRANSLATION_FAILED', message: `${failure.locale}: ${failure.reason}`, resource: failure.source,
        }));
        if (unapplied) warnings.push({ code: 'CHINESE_MISSING', message: `${unapplied} entries need hand-written Simplified Chinese.`, resource: TABLE_NAME });
        if (response.notFound?.length) warnings.push({ code: 'SOURCE_NOT_FOUND', message: 'Some requested sources were not found.', resource: response.notFound.join(', ') });
        emit({ missing: result.missing + unapplied, cached: result.cached, failures: result.failures.length, write }, json(),
          `Studio: ${write.status}. Missing before translation: ${result.missing + unapplied}, cached: ${result.cached}.`,
          write.status === 'conflict' ? [...warnings, ...conflictWarning] : warnings);
      });
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
