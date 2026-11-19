import { AppError } from '../core/errors.js';
import { checkTranslation, translate, type TranslationJob, type TranslateOptions, type TranslationProvider } from '../translation/deepseek.js';
import { SUPPORTED_LANGUAGE_CODES } from './languages.js';

export const CHINESE_LOCALE = 'zh-hans';
const defaultLocales = SUPPORTED_LANGUAGE_CODES.filter(code => code !== 'en');
const localePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export interface TableTarget { placeId: string; table: string }
interface EntryIdentity { key: string; source: string; context: string }
export interface TableEntry extends EntryIdentity { values: Record<string, string> }
export interface TableSnapshot extends TableTarget {
  sourceLocale: string;
  locales: string[];
  entries: TableEntry[];
}
export interface TableEdit extends TableEntry {
  expected: Record<string, string | null>;
  expectedZh?: string;
}
export interface TablePatch extends TableTarget { entries: TableEdit[] }

function invalid(message: string): never {
  throw new AppError('ARGUMENT_ERROR', message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid('entries must be an array.');
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string.`);
  return value;
}

function nonempty(value: unknown, field: string): string {
  const text = string(value, field);
  if (!text.trim()) invalid(`${field} cannot be blank.`);
  return text;
}

function locale(code: unknown): string {
  const text = string(code, 'locale');
  if (!localePattern.test(text)) invalid(`Use a lowercase language tag such as ja or zh-hans: ${JSON.stringify(text)}.`);
  return text;
}

export function tableLocales(locales?: readonly string[]): string[] {
  if (!locales) return [...defaultLocales];
  if (!locales.length) invalid('Provide at least one locale.');
  return [...new Set(locales.map(locale))];
}

export function tableTarget(placeId: unknown, table: unknown): TableTarget {
  const place = string(placeId, 'placeId');
  if (!/^[1-9]\d*$/.test(place) || !Number.isSafeInteger(Number(place))) invalid('placeId must be a positive safe Roblox Place ID.');
  return { placeId: place, table: nonempty(table, 'table') };
}

function identity(row: Record<string, unknown>): EntryIdentity {
  return {
    key: row.key === undefined ? '' : string(row.key, 'key'),
    source: nonempty(row.source, 'source'),
    context: row.context === undefined ? '' : string(row.context, 'context'),
  };
}

function entryId(entry: EntryIdentity): string {
  return JSON.stringify([entry.key, entry.source, entry.context]);
}

function assertUniqueEntries(entries: EntryIdentity[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (seen.has(id)) invalid(`Duplicate Key/Source/Context: ${id}.`);
    seen.add(id);
  }
}

function values(input: unknown, field: string, allowEmptyArray = false): Record<string, string> {
  if (allowEmptyArray && Array.isArray(input) && !input.length) return {};
  return Object.fromEntries(Object.entries(record(input, field)).map(([code, text]) => [locale(code), string(text, field)]));
}

export function parseTableSnapshot(input: unknown): TableSnapshot {
  const snapshot = record(input, 'snapshot');
  const target = tableTarget(snapshot.placeId, snapshot.table);
  if (!Array.isArray(snapshot.locales)) invalid('snapshot.locales must be an array.');
  const locales = tableLocales(snapshot.locales);
  const sourceLocale = locale(snapshot.sourceLocale);
  const entries = rows(snapshot.entries).map(item => {
    const row = record(item, 'entry');
    return { ...identity(row), values: values(row.values, 'values', true) };
  });
  assertUniqueEntries(entries);
  return { ...target, sourceLocale, locales, entries };
}

export function parseTablePatch(input: unknown, target: TableTarget): TablePatch {
  const patch = record(input, 'patch');
  if (patch.placeId !== undefined && patch.placeId !== target.placeId ||
      patch.table !== undefined && patch.table !== target.table) {
    invalid('The patch was prepared for a different Place or table.');
  }
  const entries = rows(patch.entries).map(item => {
    const row = record(item, 'entry');
    const entry = identity(row);
    const newValues = values(row.values, 'values');
    if (!Object.keys(newValues).length) invalid('Each patch entry must specify at least one translation.');
    const expected = record(row.expected, 'expected');
    for (const [code, text] of Object.entries(newValues)) {
      if (!Object.hasOwn(expected, code) || expected[code] !== null && typeof expected[code] !== 'string') {
        invalid(`expected.${code} must contain the exact old value or null for an absent translation.`);
      }
      const reason = checkTranslation(entry.source, text);
      if (reason) invalid(`${JSON.stringify(entry.source)} (${code}): ${reason}.`);
    }
    if (Object.keys(expected).some(code => !Object.hasOwn(newValues, code))) invalid('expected and values must name the same locales.');
    const expectedZh = row.expectedZh === undefined ? undefined : string(row.expectedZh, 'expectedZh');
    return { ...entry, values: newValues, expected: expected as TableEdit['expected'], expectedZh };
  });
  assertUniqueEntries(entries);
  return { ...target, entries };
}

export interface TableTranslation {
  patch: TablePatch;
  missing: number;
  cached: number;
  failures: (EntryIdentity & { locale: string; reason: string })[];
}

export async function translateTable(
  snapshot: TableSnapshot, provider: TranslationProvider, options: TranslateOptions,
): Promise<TableTranslation> {
  if (!/^en(?:-|$)/.test(snapshot.sourceLocale)) invalid('Table translation requires an English source locale.');
  const locales = snapshot.locales.filter(code => code !== CHINESE_LOCALE && code !== 'en' && code !== snapshot.sourceLocale);
  const { placeId, table } = snapshot;
  const result: TableTranslation = { patch: { placeId, table, entries: [] }, missing: 0, cached: 0, failures: [] };
  const jobs: TranslationJob[] = [];
  const entries = new Map<string, TableEntry>();
  for (const entry of snapshot.entries) {
    const missing = locales.filter(code => !entry.values[code]?.trim());
    result.missing += missing.length;
    if (!missing.length) continue;
    const zh = entry.values[CHINESE_LOCALE];
    if (!zh?.trim()) {
      const { key, source, context } = entry;
      result.failures.push(...missing.map(locale => ({ key, source, context, locale, reason: 'Simplified Chinese is missing' })));
      continue;
    }
    const id = entryId(entry);
    entries.set(id, entry);
    jobs.push({ id, en: entry.source, zh, locales: missing });
  }
  if (!jobs.length) return result;
  const outcome = await translate(provider, jobs, options);
  result.cached = outcome.cached;
  const edits = new Map<string, TableEdit>();
  for (const row of outcome.translations) {
    const id = row.jobId!;
    const { key, source, context, values } = entries.get(id)!;
    let edit = edits.get(id);
    if (!edit) {
      edit = { key, source, context, values: {}, expected: {}, expectedZh: values[CHINESE_LOCALE]! };
      edits.set(id, edit);
    }
    edit.values[row.locale] = row.text;
    edit.expected[row.locale] = values[row.locale] ?? null;
  }
  result.patch.entries = [...edits.values()];
  for (const row of outcome.failures) {
    const { key, source, context } = entries.get(row.jobId!)!;
    result.failures.push({ key, source, context, locale: row.locale, reason: row.reason });
  }
  return result;
}
