import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, errorInfo } from '../core/errors.js';
import { CloudLocalizationTable, requireEnabled, type PushRow } from './cloud-table.js';
import { LANGUAGE_CODE, LocalizationTable, MASTER_LOCALE, SOURCE_LOCALE } from './table.js';
import { translate, type DeepSeekClient, type TranslationCache, type Usage } from '../translation/deepseek.js';

export interface SyncOptions {
  out: string; backupDirectory: string; retranslate?: string[]; dryRun?: boolean;
  translator?: { client: DeepSeekClient; model: string; cache?: TranslationCache; concurrency?: number };
  signal?: AbortSignal; progress?: (message: string) => void;
}
export interface GamePush {
  universeId: string; languages: number; added: number; modified: number; submitted: number;
  backupPath?: string; failed: { source: string; locale?: string; error: string }[]; error?: string;
}
export interface SyncResult {
  dryRun: boolean; entries: number; locales: string[]; out?: string; removedOrphans: number;
  translated: Record<string, number>; translationFailures: { en: string; locale: string; reason: string }[];
  cachedTranslations: number; model?: string; usage?: Usage; games: GamePush[];
}

export async function syncLocalization(table: LocalizationTable, universeIds: string[], cloud: CloudLocalizationTable, options: SyncOptions): Promise<SyncResult> {
  const log = options.progress ?? (() => {});
  if (!universeIds.length) throw new AppError('ARGUMENT_ERROR', 'Provide at least one game.');
  // 1) Every target must already be enabled; stop before translating anything.
  const games: { universeId: string; tableId: string; languages: string[] }[] = [];
  for (const universeId of universeIds) {
    const { settings, languages } = await requireEnabled(cloud, universeId);
    games.push({ universeId, tableId: settings.tableId, languages });
  }
  const locales = [...new Set(games.flatMap(game => game.languages))].filter(code => LANGUAGE_CODE.test(code) && code !== SOURCE_LOCALE && code !== MASTER_LOCALE).sort();

  // 2) Forced re-translation drops stored translations of the named sources.
  for (const source of options.retranslate ?? []) {
    if (!table.rows.some(row => row.en === source)) throw new AppError('ARGUMENT_ERROR', `--retranslate source not in master: ${JSON.stringify(source)}`);
    for (const map of table.languages.values()) map.delete(source);
  }

  // 3) Missing source × locale pairs; rows without a Chinese hint are still translated from English.
  const jobs = table.rows.filter(row => row.en.trim()).map(row => ({ en: row.en, zh: row.zh, locales: locales.filter(locale => !table.get(row.en, locale)) })).filter(job => job.locales.length);
  const missing = jobs.reduce((n, job) => n + job.locales.length, 0);
  const result: SyncResult = { dryRun: Boolean(options.dryRun), entries: table.rows.length, locales, removedOrphans: table.orphans(), translated: {}, translationFailures: [], cachedTranslations: 0, games: [] };
  if (missing && !options.dryRun) {
    if (!options.translator) throw new AppError('AUTH_REQUIRED', `${missing} translations are missing; configure DeepSeek (rbx deepseek auth set).`);
    result.model = options.translator.model;
    log(`翻译 ${jobs.length} 条原文，共 ${missing} 个译文（${options.translator.model}）`);
    let last = 0;
    const outcome = await translate(options.translator.client, jobs, { model: options.translator.model, concurrency: options.translator.concurrency, cache: options.translator.cache, signal: options.signal,
      progress: (done, total) => { if (done - last >= 200 || done === total) { last = done; log(`  已翻译 ${done}/${total}`); } } });
    for (const row of outcome.translations) { table.set(row.en, row.locale, row.text); result.translated[row.locale] = (result.translated[row.locale] ?? 0) + 1; }
    result.translationFailures = outcome.failures;
    result.cachedTranslations = outcome.cached;
    result.usage = options.translator.client.usage;
  } else if (missing) {
    for (const job of jobs) for (const locale of job.locales) result.translated[locale] = (result.translated[locale] ?? 0) + 1;
  }

  // 4) The complete table is written before pushing, so translations are never lost.
  if (!options.dryRun) { result.out = await table.save(options.out); log(`已写出 ${result.out}`); }

  // 5) Push each game's enabled languages; one game's failure does not stop the others.
  const limits = await cloud.limits();
  for (const game of games) {
    const push: GamePush = { universeId: game.universeId, languages: game.languages.length, added: 0, modified: 0, submitted: 0, failed: [] };
    result.games.push(push);
    try {
      log(`拉取游戏 ${game.universeId} 的云端本地化表`);
      const { entries, raw } = await cloud.entries(game.universeId, game.tableId, options.signal);
      const rows: PushRow[] = [];
      for (const row of table.rows) {
        if (!row.en.trim()) continue;
        if ([...row.en].length > limits.maxSourceLength) { push.failed.push({ source: row.en, error: `source longer than ${limits.maxSourceLength}` }); continue; }
        const current = entries.get(row.en);
        for (const locale of game.languages) {
          const text = table.get(row.en, locale);
          if (!text) continue;
          const existing = current?.translations.get(locale);
          if (existing?.text === text) continue;
          if (existing) push.modified++; else push.added++;
          rows.push({ source: row.en, locale, text });
        }
      }
      push.submitted = rows.length;
      if (options.dryRun || !rows.length) continue;
      push.backupPath = join(options.backupDirectory, `table-${game.universeId}-${Date.now()}-${randomUUID()}.json`);
      try { await mkdir(options.backupDirectory, { recursive: true }); await writeFile(push.backupPath, JSON.stringify({ universeId: game.universeId, tableId: game.tableId, entries: raw }), { flag: 'wx', mode: 0o600 }); }
      catch { throw new AppError('STORAGE_ERROR', 'Cannot save localization table backup; nothing pushed to this game.'); }
      log(`推送 ${rows.length} 个译文到游戏 ${game.universeId}`);
      const pushed = await cloud.push(game.universeId, game.tableId, rows, limits.maxEntriesPerUpdate, options.signal);
      push.failed.push(...pushed.failed);
    } catch (error) {
      if (error instanceof AppError && error.code === 'CANCELLED') throw error;
      const info = errorInfo(error); push.error = `${info.code} ${info.message}`;
    }
  }
  return result;
}

export interface ImportResult { universeId: string; imported: Record<string, number>; skippedAutomatic: number; skippedLocales: Record<string, number>; out: string }

/** First-time seeding: copy cloud translations of master sources into empty local slots. */
export async function importFromCloud(table: LocalizationTable, universeId: string, cloud: CloudLocalizationTable, options: { out: string; humanOnly?: boolean; signal?: AbortSignal }): Promise<ImportResult> {
  const settings = await cloud.settings(universeId);
  const { entries } = await cloud.entries(universeId, settings.tableId, options.signal);
  const result: ImportResult = { universeId, imported: {}, skippedAutomatic: 0, skippedLocales: {}, out: '' };
  for (const row of table.rows) {
    const entry = entries.get(row.en);
    if (!entry) continue;
    for (const t of entry.translations.values()) {
      // Regional locales (e.g. zh_cjv) are outside the per-language table model.
      if (!LANGUAGE_CODE.test(t.locale) || t.locale === SOURCE_LOCALE || t.locale === MASTER_LOCALE || !t.text || table.get(row.en, t.locale)) { if (!LANGUAGE_CODE.test(t.locale)) result.skippedLocales[t.locale] = (result.skippedLocales[t.locale] ?? 0) + 1; continue; }
      if (options.humanOnly && t.agentType !== 'User') { result.skippedAutomatic++; continue; }
      table.set(row.en, t.locale, t.text);
      result.imported[t.locale] = (result.imported[t.locale] ?? 0) + 1;
    }
  }
  result.out = await table.save(options.out);
  return result;
}
