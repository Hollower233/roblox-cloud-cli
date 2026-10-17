import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorInfo, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';

const publicBase = 'https://gameinternationalization.roblox.com/v1';
const cloudBase = 'https://apis.roblox.com/legacy-game-internationalization/v1';
type Field = 'title' | 'description';
export interface GameInfoTranslation { title?: string; description?: string }
export type GameInfoTranslations = Record<string, GameInfoTranslation>;
export interface GameInfoLocale {
  localeCode: string; name: string; targetCode: string; enabled: boolean;
  title: string | null; description: string | null;
}
export interface GameInfoLanguage {
  languageCode: string; name: string; nativeName: string; enabled: boolean;
  title: string | null; description: string | null; locales: GameInfoLocale[];
}
export interface GameInfoSnapshot {
  universeId: string; source: { languageCode: string; title: string; description: string };
  languages: GameInfoLanguage[];
  translations: { languageCode: string; title: string | null; description: string | null }[];
}
export interface GameInfoWriteOptions {
  dryRun?: boolean; backupDirectory?: string; signal?: AbortSignal;
}
export interface GameInfoWriteResult {
  universeId: string; dryRun: boolean; backupPath?: string; addedLanguages: string[];
  results: { languageCode: string; field: Field; value: string;
    status: 'planned' | 'success' | 'error' | 'unverified'; error?: ReturnType<typeof errorInfo> }[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Invalid localization object.');
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Invalid localization list.');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('INVALID_RESPONSE', 'Invalid localization string.');
  return value;
}
function apiCode(value: unknown): string {
  const result = string(value);
  if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/.test(result)) throw new AppError('INVALID_RESPONSE', 'Invalid Roblox language code.');
  return result;
}
function nullable(value: unknown): string | null { return value === null ? null : string(value); }
function code(value: string): string { return value.trim().toLowerCase().replaceAll('-', '_'); }

/** Accept a language-keyed object, never a read-result envelope or implicit deletes. */
export function parseGameInfoTranslations(value: unknown): GameInfoTranslations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('ARGUMENT_ERROR', 'Translations must be a language-keyed JSON object.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 200) throw new AppError('ARGUMENT_ERROR', 'Provide 1–200 language or locale entries.');
  const result: GameInfoTranslations = Object.create(null);
  for (const [language, translation] of entries) {
    if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,4})?$/i.test(language)) throw new AppError('ARGUMENT_ERROR', 'Invalid language or locale code.');
    if (!translation || typeof translation !== 'object' || Array.isArray(translation)) throw new AppError('ARGUMENT_ERROR', `Invalid translation for ${language}.`);
    const fields = Object.entries(translation);
    if (!fields.length || fields.some(([field, text]) => !['title', 'description'].includes(field) || typeof text !== 'string')) {
      throw new AppError('ARGUMENT_ERROR', `Provide only title and/or description strings for ${language}; null is not an update.`);
    }
    if (Object.keys(result).some(existing => code(existing) === code(language))) throw new AppError('ARGUMENT_ERROR', 'Duplicate language aliases.');
    result[language] = Object.fromEntries(fields);
  }
  return result;
}

export class GameInfoLocalization {
  constructor(private http: HttpClient) {}

  private async configured(universeId: string): Promise<Set<string>> {
    const d = object(await this.http.request(`${publicBase}/supported-languages/games/${id(universeId)}`));
    const result = new Set<string>();
    for (const value of rows(d.data)) {
      const row = object(value), language = apiCode(row.languageCode);
      if (!['Language', 'Locale'].includes(string(row.languageCodeType)) || result.has(language)) throw new AppError('INVALID_RESPONSE', 'Invalid supported language.');
      result.add(language);
    }
    return result;
  }

  private async text(universeId: string) {
    const d = object(await this.http.request(`${publicBase}/name-description/games/${id(universeId)}`));
    const seen = new Set<string>();
    return rows(d.data).map(value => {
      const row = object(value), languageCode = apiCode(row.languageCode);
      if (seen.has(languageCode)) throw new AppError('INVALID_RESPONSE', 'Duplicate translation response.');
      seen.add(languageCode);
      return { languageCode, title: nullable(row.name), description: nullable(row.description) };
    });
  }

  private async source(universeId: string) {
    const d = object(await this.http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }));
    return { title: string(d.displayName), description: string(d.description) };
  }

  async read(universeId: string): Promise<GameInfoSnapshot> {
    id(universeId);
    const [catalog, sourceLanguage, source, configured, translations] = await Promise.all([
      this.http.request('https://locale.roblox.com/v1/locales/supported-locales-for-creators'),
      this.http.request(`${publicBase}/source-language/games/${universeId}`),
      this.source(universeId), this.configured(universeId), this.text(universeId),
    ]);
    const sourceCode = apiCode(object(sourceLanguage).languageCode);
    const languages = new Map<string, GameInfoLanguage>();
    const localeCodes = new Set<string>();
    for (const value of rows(object(catalog).data)) {
      const locale = object(object(value).locale), family = object(locale.language);
      const languageCode = apiCode(family.languageCode), localeCode = apiCode(locale.locale);
      if (localeCodes.has(localeCode)) throw new AppError('INVALID_RESPONSE', 'Duplicate locale response.');
      localeCodes.add(localeCode);
      if (!languages.has(languageCode)) {
        const current = translations.find(row => row.languageCode === languageCode);
        languages.set(languageCode, { languageCode, name: string(family.name), nativeName: string(family.nativeName), enabled: configured.has(languageCode),
          title: languageCode === sourceCode ? source.title : current?.title ?? null,
          description: languageCode === sourceCode ? source.description : current?.description ?? null, locales: [] });
      }
      languages.get(languageCode)!.locales.push({ localeCode, name: string(locale.name), targetCode: localeCode,
        enabled: configured.has(localeCode) || configured.has(languageCode), title: translations.find(row => row.languageCode === localeCode)?.title ?? null,
        description: translations.find(row => row.languageCode === localeCode)?.description ?? null });
    }
    if (!languages.size || !languages.has(sourceCode)) throw new AppError('INVALID_RESPONSE', 'Source language is missing from the creator language catalog.');
    // Only these language families have separate regional game-info overrides.
    for (const language of languages.values()) for (const locale of language.locales) {
      if (!['en', 'fr', 'pt', 'es'].includes(language.languageCode)) {
        locale.targetCode = language.languageCode;
        locale.enabled = language.enabled;
      }
    }
    return { universeId, source: { languageCode: sourceCode, ...source }, languages: [...languages.values()].sort((a,b) => a.languageCode.localeCompare(b.languageCode)), translations };
  }

  async write(universeId: string, input: GameInfoTranslations, options: GameInfoWriteOptions = {}): Promise<GameInfoWriteResult> {
    id(universeId);
    const checkAbort = () => { if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.'); };
    checkAbort();
    const translations = parseGameInfoTranslations(input), before = await this.read(universeId);
    const aliases = new Map<string, string>();
    const parents = new Map<string, string>();
    for (const language of before.languages) {
      aliases.set(code(language.languageCode), language.languageCode);
      parents.set(language.languageCode, language.languageCode);
      for (const locale of language.locales) {
        aliases.set(code(locale.localeCode), locale.targetCode);
        parents.set(locale.targetCode, language.languageCode);
      }
    }
    for (const row of before.translations) if (!aliases.has(code(row.languageCode))) aliases.set(code(row.languageCode), row.languageCode);
    if (aliases.has('zh_cjv') && parents.has('zh-hans')) parents.set('zh_cjv', 'zh-hans');
    const result: GameInfoWriteResult = { universeId, dryRun: Boolean(options.dryRun), addedLanguages: [], results: [] };
    const targets = new Set<string>();
    for (const [alias, fields] of Object.entries(translations)) {
      const languageCode = aliases.get(code(alias));
      if (!languageCode) throw new AppError('ARGUMENT_ERROR', `Language is absent from the Roblox creator catalog: ${alias}.`);
      if (targets.has(languageCode)) throw new AppError('ARGUMENT_ERROR', `Multiple inputs refer to ${languageCode}. Use one entry per target.`);
      targets.add(languageCode);
      const sourceLocale = ({ en: 'en_us', fr: 'fr_fr', pt: 'pt_br', es: 'es_es' } as Record<string, string>)[before.source.languageCode];
      if (languageCode === sourceLocale) throw new AppError('ARGUMENT_ERROR', 'The default locale of the source language cannot override game info. Use the source language code.');
      for (const field of ['title', 'description'] as const) if (Object.hasOwn(fields, field)) {
        if (languageCode === before.source.languageCode && field === 'title' && !fields.title!.trim()) throw new AppError('ARGUMENT_ERROR', 'Source title cannot be blank.');
        result.results.push({ languageCode, field, value: fields[field]!, status: options.dryRun ? 'planned' : 'unverified' });
      }
    }
    const configured = await this.configured(universeId);
    // Regional overrides depend on the parent language; the support API rejects Locale additions.
    const missing = [...new Set([...targets].map(target => parents.get(target) ?? target))].filter(target => target !== before.source.languageCode && !configured.has(target));
    if (options.dryRun) { result.addedLanguages = missing; return result; }
    checkAbort();
    if (options.backupDirectory) {
      result.backupPath = join(options.backupDirectory, `${universeId}-${Date.now()}-${randomUUID()}.json`);
      try { await mkdir(options.backupDirectory, { recursive: true }); await writeFile(result.backupPath, JSON.stringify({ before, requested: translations }, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch { throw new AppError('STORAGE_ERROR', 'Cannot save localization backup; no changes submitted.'); }
    }
    const fail = (target: string, error: unknown) => {
      for (const row of result.results.filter(row => row.languageCode === target || parents.get(row.languageCode) === target)) { row.status = 'error'; row.error = errorInfo(error); }
    };
    const writeError = (batch: GameInfoWriteResult['results'], error: unknown) => {
      for (const row of batch) {
        row.error = errorInfo(error);
        if (error instanceof AppError && ['FORBIDDEN', 'AUTH_INVALID', 'AUTH_REQUIRED', 'CANCELLED'].includes(error.code)) row.status = 'error';
      }
    };
    for (const target of missing) {
      try {
        checkAbort();
        await this.http.request(`${cloudBase}/supported-languages/games/${universeId}`, { auth: true, method: 'PATCH', body: [{ languageCodeType: 'Language', languageCode: target }] });
        if (!(await this.configured(universeId)).has(target)) throw new AppError('INVALID_RESPONSE', 'Added language was not confirmed; translations were not submitted for it.');
        result.addedLanguages.push(target);
        checkAbort();
        // Newly added languages must not activate automatic game-info translation.
        const disabled = object(await this.http.request(`${cloudBase}/supported-languages/games/${universeId}/languages/${target}/universe-display-info-automatic-translation-settings`, { auth: true, method: 'PATCH', body: false }));
        if (disabled.isUniverseDisplayInfoAutomaticTranslationEnabled !== false) throw new AppError('INVALID_RESPONSE', 'Could not confirm automatic translation is disabled for the added language.');
      } catch (error) { fail(target, error); }
    }
    const sourceRows = result.results.filter(row => row.languageCode === before.source.languageCode && row.status !== 'error');
    if (sourceRows.length) {
      const body = Object.fromEntries(sourceRows.map(row => [row.field === 'title' ? 'displayName' : 'description', row.value]));
      try {
        checkAbort();
        await this.http.request(`https://apis.roblox.com/cloud/v2/universes/${universeId}?updateMask=${Object.keys(body).join(',')}`, { auth: true, method: 'PATCH', body });
      } catch (error) {
        if (error instanceof AppError && error.code === 'FORBIDDEN') error = new AppError('FORBIDDEN', 'Source edits require universe:write and access to this universe. Roblox rejected the request.', 403);
        writeError(sourceRows, error);
      }
    }
    // One field per batch keeps failures (which identify only a language) unambiguous.
    for (const field of ['title', 'description'] as const) {
      const pending = result.results.filter(row => row.languageCode !== before.source.languageCode && row.field === field && row.status !== 'error');
      for (let start = 0; start < pending.length; start += 25) {
        const batch = pending.slice(start, start + 25);
        try {
          checkAbort();
          const updateType = field === 'title' ? 'Name' : 'Description';
          const d = object(await this.http.request(`${cloudBase}/name-description/games/${universeId}`, { auth: true, method: 'PATCH', body: { data: batch.map(row => ({ languageCode: row.languageCode, updateType, [field === 'title' ? 'name' : 'description']: row.value })) } }));
          const successes = rows(d.successOperations).map(object), failures = rows(d.failedOperations).map(object);
          for (const row of batch) {
            const failed = failures.filter(item => item.languageCode === row.languageCode), succeeded = successes.filter(item => item.languageCode === row.languageCode && item.updateType === updateType);
            if (failed.length === 1 && succeeded.length === 0) { row.status = 'error'; row.error = { code: 'ROBLOX_LOCALIZATION_REJECTED', message: `Roblox rejected ${row.languageCode} ${field} (error ${Number(failed[0]!.errorCode)}).` }; }
            else if (failed.length || succeeded.length !== 1) row.error = { code: 'INVALID_RESPONSE', message: 'Missing or ambiguous per-field write receipt; inspect current state before retrying.' };
          }
        } catch (error) { writeError(batch, error); }
      }
    }
    // Never repeat a write after a lost response. Read back a few times for propagation.
    let lastReadError: ReturnType<typeof errorInfo> | undefined;
    for (let attempt = 0; attempt < 4 && result.results.some(row => row.status === 'unverified'); attempt++) {
      try {
        if (attempt) await delay(attempt * 300, undefined, { signal: options.signal });
        const localized = await this.text(universeId);
        const source = sourceRows.length ? await this.source(universeId) : null;
        for (const row of result.results.filter(row => row.status === 'unverified')) {
          const current = row.languageCode === before.source.languageCode ? source : localized.find(item => item.languageCode === row.languageCode);
          // A failed/lost receipt cannot be proved successful by an unchanged value.
          if (!row.error && current?.[row.field] === row.value) row.status = 'success';
        }
      } catch (error) { lastReadError = errorInfo(error); }
    }
    for (const row of result.results.filter(row => row.status === 'unverified')) row.error ??= lastReadError ?? { code: 'UNVERIFIED', message: 'Write was attempted but the requested value was not confirmed. Read current state before retrying.' };
    return result;
  }
}
