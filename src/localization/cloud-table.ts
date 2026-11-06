import { AppError, errorInfo, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import { SUPPORTED_LANGUAGE_CODES, isSupportedLanguage } from './languages.js';

const tables = 'https://apis.roblox.com/legacy-localization-tables/v1';
const intl = 'https://apis.roblox.com/legacy-game-internationalization/v1';
const publicIntl = 'https://gameinternationalization.roblox.com/v1';

export interface TableSettings {
  tableId: string; sourceLanguage: string; isAutolocalizationEnabled: boolean; shouldUseLocalizationTable: boolean;
  isAutomaticEntriesSettingEnabled: boolean; isAutomaticEntriesDeletionEnabled: boolean;
  shouldUseImageLocalizationTable: boolean; isAutoLocalizationForImageEnabled: boolean;
}
export interface CloudTranslation { locale: string; text: string; agentType: string | null }
/** Generic entries only: no key and no context. Context/key entries are ignored entirely. */
export interface CloudEntry { source: string; translations: Map<string, CloudTranslation> }
export interface PushRow { source: string; locale: string; text: string }
export interface PushResult { submitted: number; modified: number; failed: { source: string; locale?: string; error: string }[] }

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Invalid localization response object.');
  return value as Record<string, any>;
}
function array(value: unknown): any[] { if (!Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Invalid localization response list.'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new AppError('INVALID_RESPONSE', 'Invalid localization setting.'); return value; }

export class CloudLocalizationTable {
  constructor(private http: HttpClient) {}

  async sourceLanguage(universeId: string): Promise<string> {
    return String(object(await this.http.request(`${publicIntl}/source-language/games/${id(universeId)}`)).languageCode);
  }

  /** Enabled languages (Language type only), including the source language. */
  async supportedLanguages(universeId: string): Promise<string[]> {
    const d = object(await this.http.request(`${publicIntl}/supported-languages/games/${id(universeId)}`));
    return array(d.data).filter(row => object(row).languageCodeType === 'Language').map(row => String(row.languageCode));
  }

  async automaticTranslation(universeId: string): Promise<Map<string, boolean>> {
    const d = object(await this.http.request(`${intl}/supported-languages/games/${id(universeId)}/automatic-translation-status`, { auth: true }));
    return new Map(array(d.data).filter(row => object(row).languageCodeType === 'Language').map(row => [String(row.languageCode), bool(row.isAutomaticTranslationEnabled)]));
  }

  /** Returns the game's auto-localization table, creating it if the game has none (verified idempotent). */
  async settings(universeId: string): Promise<TableSettings> {
    const d = object(await this.http.request(`${tables}/autolocalization/games/${id(universeId)}/autolocalizationtable`, { auth: true, method: 'POST' }));
    if (typeof d.autoLocalizationTableId !== 'string' || !d.autoLocalizationTableId) throw new AppError('INVALID_RESPONSE', 'Roblox returned no localization table ID.');
    return {
      tableId: d.autoLocalizationTableId, sourceLanguage: String(d.sourceLanguage),
      isAutolocalizationEnabled: bool(d.isAutolocalizationEnabled), shouldUseLocalizationTable: bool(d.shouldUseLocalizationTable),
      isAutomaticEntriesSettingEnabled: bool(d.isAutomaticEntriesSettingEnabled), isAutomaticEntriesDeletionEnabled: bool(d.isAutomaticEntriesDeletionEnabled),
      shouldUseImageLocalizationTable: Boolean(d.shouldUseImageLocalizationTable), isAutoLocalizationForImageEnabled: Boolean(d.isAutoLocalizationForImageEnabled),
    };
  }

  async limits(): Promise<{ maxEntriesPerUpdate: number; maxSourceLength: number }> {
    const d = object(await this.http.request(`${tables}/localization-table/limits`, { auth: true }));
    const maxEntriesPerUpdate = Number(object(d.tableOperationLimits).maxEntriesPerUpdate), maxSourceLength = Number(object(d.entryOperationLimits).maxSourceLength);
    if (!(maxEntriesPerUpdate > 0) || !(maxSourceLength > 0)) throw new AppError('INVALID_RESPONSE', 'Invalid localization limits.');
    return { maxEntriesPerUpdate, maxSourceLength };
  }

  /** All generic entries (empty key and context); raw pages are returned for backups. */
  async entries(universeId: string, tableId: string, signal?: AbortSignal): Promise<{ entries: Map<string, CloudEntry>; raw: unknown[] }> {
    const entries = new Map<string, CloudEntry>(), raw: unknown[] = [];
    let cursor: string | null = null;
    do {
      if (signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
      const url = new URL(`${tables}/localization-table/tables/${encodeURIComponent(tableId)}/entries`);
      url.searchParams.set('gameId', id(universeId));
      if (cursor) url.searchParams.set('cursor', cursor);
      const d = object(await this.http.request(url.toString(), { auth: true }));
      for (const value of array(d.data)) {
        raw.push(value);
        const identifier = object(object(value).identifier);
        if (identifier.key || identifier.context || typeof identifier.source !== 'string') continue;
        const translations = new Map<string, CloudTranslation>();
        for (const t of array(value.translations ?? [])) {
          const row = object(t);
          if (typeof row.locale === 'string' && typeof row.translationText === 'string') translations.set(row.locale, { locale: row.locale, text: row.translationText, agentType: row.translator?.agentType ?? null });
        }
        entries.set(identifier.source, { source: identifier.source, translations });
      }
      cursor = typeof d.nextPageCursor === 'string' && d.nextPageCursor ? d.nextPageCursor : null;
    } while (cursor);
    return { entries, raw };
  }

  /** Add/modify only. Never sends delete flags. Rows are grouped per source and batched. */
  async push(universeId: string, tableId: string, rows: PushRow[], maxEntries: number, signal?: AbortSignal): Promise<PushResult> {
    const grouped = new Map<string, PushRow[]>();
    for (const row of rows) { if (!grouped.has(row.source)) grouped.set(row.source, []); grouped.get(row.source)!.push(row); }
    const sources = [...grouped.keys()];
    const result: PushResult = { submitted: rows.length, modified: 0, failed: [] };
    const send = async (batch: string[]): Promise<void> => {
      try {
        if (signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
        const body = { entries: batch.map(source => ({ identifier: { key: '', context: '', source }, translations: grouped.get(source)!.map(row => ({ locale: row.locale, translationText: row.text })) })) };
        const d = object(await this.http.request(`${tables}/localization-table/tables/${encodeURIComponent(tableId)}?gameId=${id(universeId)}`, { auth: true, method: 'PATCH', body }));
        for (const entry of array(d.modifiedEntriesAndTranslations ?? [])) result.modified += array(object(entry).translations ?? []).length;
        for (const entry of array(d.failedEntriesAndTranslations ?? [])) {
          const row = object(entry), source = String(object(row.identifier ?? {}).source ?? '');
          const reason = row.error && typeof row.error === 'object' ? row.error : row;
          const message = String(reason.errorMessage ?? 'rejected');
          const failures = array(row.translations ?? []);
          if (!failures.length) result.failed.push({ source, error: message });
          for (const t of failures) result.failed.push({ source, locale: t.locale, error: String(t.errorMessage ?? message) });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'CANCELLED') throw error;
        // A 400 rejects the whole batch for one bad entry; split until it is isolated.
        if (error instanceof AppError && error.httpStatus === 400 && batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          await send(batch.slice(0, half)); await send(batch.slice(half));
          return;
        }
        const info = errorInfo(error);
        for (const source of batch) result.failed.push({ source, error: `${info.code} ${info.message}` });
      }
    };
    for (let start = 0; start < sources.length; start += maxEntries) await send(sources.slice(start, start + maxEntries));
    return result;
  }

  async setSourceLanguage(universeId: string, languageCode: string): Promise<void> {
    await this.http.request(`${intl}/source-language/games/${id(universeId)}?languageCode=${encodeURIComponent(languageCode)}`, { auth: true, method: 'PATCH' });
  }
  async addLanguages(universeId: string, languages: string[]): Promise<void> {
    await this.http.request(`${intl}/supported-languages/games/${id(universeId)}`, { auth: true, method: 'PATCH', body: languages.map(languageCode => ({ languageCodeType: 'Language', languageCode, delete: false })) });
  }
  async setAutomaticTranslation(universeId: string, language: string, enabled: boolean): Promise<void> {
    const d = object(await this.http.request(`${intl}/supported-languages/games/${id(universeId)}/languages/${encodeURIComponent(language)}/automatic-translation-status`, { auth: true, method: 'PATCH', body: enabled }));
    if (d.isAutomaticTranslationEnabled !== enabled) throw new AppError('INVALID_RESPONSE', `Automatic translation for ${language} was not confirmed.`);
  }
  async updateSettings(universeId: string, settings: TableSettings): Promise<void> {
    await this.http.request(`${tables}/autolocalization/games/${id(universeId)}/settings`, { auth: true, method: 'PATCH', body: {
      isAutolocalizationEnabled: settings.isAutolocalizationEnabled, isAutomaticEntriesSettingEnabled: settings.isAutomaticEntriesSettingEnabled,
      isAutomaticEntriesDeletionsEnabled: settings.isAutomaticEntriesDeletionEnabled, shouldUseLocalizationTable: settings.shouldUseLocalizationTable,
      shouldUseImageLocalizationTable: settings.shouldUseImageLocalizationTable, isAutoLocalizationForImageEnabled: settings.isAutoLocalizationForImageEnabled,
    } });
  }
}

export interface EnableResult {
  universeId: string; dryRun: boolean; changes: string[]; warnings: string[];
  failures: { step: string; error: string }[];
}

/** Idempotent: source=en, the fixed languages enabled + auto-translated, table used, ATC on, auto-deletion off. Other enabled languages stay untouched. */
export async function enableLocalization(cloud: CloudLocalizationTable, universeId: string, options: { dryRun?: boolean } = {}): Promise<EnableResult> {
  const result: EnableResult = { universeId, dryRun: Boolean(options.dryRun), changes: [], warnings: [], failures: [] };
  const step = async (name: string, action: () => Promise<void>) => {
    result.changes.push(name);
    if (options.dryRun) return;
    try { await action(); } catch (error) { result.changes.pop(); const info = errorInfo(error); result.failures.push({ step: name, error: `${info.code} ${info.message}` }); }
  };
  const source = await cloud.sourceLanguage(universeId);
  if (source !== 'en') {
    const existing = (await cloud.supportedLanguages(universeId)).filter(code => code !== source);
    if (existing.length) result.warnings.push(`源语言原为 ${source}，且已启用 ${existing.length} 种其他语言；改为 en 后，原有译文可能需要复查。`);
    await step(`源语言 ${source} → en`, () => cloud.setSourceLanguage(universeId, 'en'));
  }
  const supported = await cloud.supportedLanguages(universeId);
  const missing = SUPPORTED_LANGUAGE_CODES.filter(code => !supported.includes(code));
  if (missing.length) await step(`启用 ${missing.length} 种语言：${missing.join(', ')}`, () => cloud.addLanguages(universeId, missing));
  const automatic = options.dryRun ? new Map<string, boolean>() : await cloud.automaticTranslation(universeId);
  const targets = SUPPORTED_LANGUAGE_CODES.filter(code => code !== 'en' && automatic.get(code) !== true);
  const turnedOn: string[] = [];
  for (const code of targets) {
    if (options.dryRun) { turnedOn.push(code); continue; }
    try { await cloud.setAutomaticTranslation(universeId, code, true); turnedOn.push(code); }
    catch (error) { const info = errorInfo(error); result.failures.push({ step: `自动翻译 ${code}`, error: `${info.code} ${info.message}` }); }
  }
  if (turnedOn.length && !options.dryRun) result.changes.push(`开启 ${turnedOn.length} 种语言的自动翻译：${turnedOn.join(', ')}`);
  if (options.dryRun) result.changes.push('开启尚未开启的语言的自动翻译（dry-run 不查询具体语言）');
  const settings = await cloud.settings(universeId);
  const wanted = { ...settings, isAutolocalizationEnabled: true, shouldUseLocalizationTable: true, isAutomaticEntriesSettingEnabled: true, isAutomaticEntriesDeletionEnabled: false };
  const diff = (['isAutolocalizationEnabled', 'shouldUseLocalizationTable', 'isAutomaticEntriesSettingEnabled', 'isAutomaticEntriesDeletionEnabled'] as const).filter(key => settings[key] !== wanted[key]);
  if (diff.length) await step(`表设置：${diff.map(key => `${key}=${wanted[key]}`).join(', ')}`, async () => {
    await cloud.updateSettings(universeId, wanted);
    const after = await cloud.settings(universeId);
    if (diff.some(key => after[key] !== wanted[key])) throw new AppError('INVALID_RESPONSE', 'Settings were not confirmed after update.');
  });
  return result;
}

/** sync requires `enable` to have run: source en and the table in use. */
export async function requireEnabled(cloud: CloudLocalizationTable, universeId: string): Promise<{ settings: TableSettings; languages: string[] }> {
  const source = await cloud.sourceLanguage(universeId);
  if (source !== 'en') throw new AppError('ARGUMENT_ERROR', `Game ${universeId} source language is ${source}; run rbx localization enable ${universeId} first.`);
  const settings = await cloud.settings(universeId);
  if (!settings.shouldUseLocalizationTable) throw new AppError('ARGUMENT_ERROR', `Game ${universeId} does not use its localization table; run rbx localization enable ${universeId} first.`);
  return { settings, languages: (await cloud.supportedLanguages(universeId)).filter(code => code !== 'en' && isSupportedLanguage(code)) };
}
