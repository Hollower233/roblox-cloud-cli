import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';

const BASE = 'https://api.deepseek.com';
export const FALLBACK_MODEL = 'deepseek-flash';

export interface DeepSeekConfig { model?: string }
export async function readDeepSeekConfig(home: string): Promise<DeepSeekConfig> {
  try { return JSON.parse(await readFile(join(home, 'deepseek.json'), 'utf8')) as DeepSeekConfig; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new AppError('STORAGE_ERROR', 'Cannot read deepseek.json.'); }
}
export async function writeDeepSeekConfig(home: string, config: DeepSeekConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'deepseek.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export interface Usage { requests: number; promptTokens: number; cacheHitTokens: number; completionTokens: number }

export class DeepSeekClient {
  usage: Usage = { requests: 0, promptTokens: 0, cacheHitTokens: 0, completionTokens: 0 };
  constructor(private apiKey: string, private options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; retries?: number; sleep?: (ms: number) => Promise<void> } = {}) {}

  private async call(path: string, body?: unknown): Promise<any> {
    const fetcher = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => delay(ms, undefined, { signal: this.options.signal }).then(() => undefined));
    for (let attempt = 0; ; attempt++) {
      this.options.signal?.throwIfAborted();
      let status = 0;
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 240_000);
        const response = await fetcher(BASE + path, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          signal: this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout,
          headers: { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = response.status;
        if (response.ok) return await response.json();
        await response.body?.cancel();
        if (status === 401) throw new AppError('AUTH_INVALID', 'DeepSeek rejected the API key.', 401);
        if (status === 402) throw new AppError('HTTP_ERROR', 'DeepSeek account balance is insufficient.', 402);
        if (![429, 500, 502, 503, 504].includes(status)) throw new AppError('HTTP_ERROR', `DeepSeek ${path} returned HTTP ${status}.`, status);
      } catch (error) {
        if (this.options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
        if (error instanceof AppError) throw error;
      }
      // Translation requests are idempotent, so transient failures are retried.
      if (attempt >= (this.options.retries ?? 4)) throw new AppError(status ? 'HTTP_ERROR' : 'NETWORK_ERROR', `DeepSeek ${path} failed${status ? ` with HTTP ${status}` : ''} after retries.`, status || undefined);
      await sleep(Math.min(30_000, 1500 * 2 ** attempt + Math.random() * 500));
    }
  }

  async models(): Promise<string[]> {
    const d = await this.call('/models');
    if (!Array.isArray(d?.data)) throw new AppError('INVALID_RESPONSE', 'DeepSeek returned an invalid model list.');
    return d.data.map((row: any) => String(row.id)).sort();
  }

  /** Configured model if offered, else deepseek-flash, else an error listing what is available. */
  async resolveModel(configured?: string): Promise<string> {
    const models = await this.models();
    if (configured && models.includes(configured)) return configured;
    if (models.includes(FALLBACK_MODEL)) return FALLBACK_MODEL;
    throw new AppError('ARGUMENT_ERROR', `${configured ? `Model ${configured} is not offered` : 'No model configured'} and ${FALLBACK_MODEL} is unavailable. Available: ${models.join(', ')}. Run rbx deepseek config --model <id>.`);
  }

  async chatJson(model: string, system: string, user: string): Promise<unknown> {
    const d = await this.call('/chat/completions', {
      // Thinking would spend most tokens on reasoning and truncate large batches.
      model, stream: false, temperature: 1.0, max_tokens: 32768, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    this.usage.requests++;
    this.usage.promptTokens += Number(d?.usage?.prompt_tokens ?? 0);
    this.usage.cacheHitTokens += Number(d?.usage?.prompt_cache_hit_tokens ?? 0);
    this.usage.completionTokens += Number(d?.usage?.completion_tokens ?? 0);
    const content = d?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AppError('INVALID_RESPONSE', 'DeepSeek returned no message content.');
    try { return JSON.parse(content); } catch { throw new AppError('INVALID_RESPONSE', 'DeepSeek returned invalid JSON content.'); }
  }
}

// ---- Translation ----

export interface TranslationJob { en: string; zh: string; locales: string[] }
export interface TranslationOutcome {
  translations: { en: string; locale: string; text: string }[];
  failures: { en: string; locale: string; reason: string }[];
  cached: number;
}

const SYSTEM = `You are a professional localizer for a Roblox game UI.
Each item has "en" (the authoritative English source) and "zh" (a Simplified Chinese translation, only a hint for meaning).
Translate "en" into every locale listed in that item's "to".
Rules:
- Keep placeholders such as {a:int}, {number1}, {a} exactly as written, untranslated.
- Keep rich-text tags such as <font color="#FFFFFF">, </font>, <b>, <br/> exactly, wrapping the corresponding words.
- Keep line breaks (\\n) and the meaning of numbers; do not add explanations, quotes, or extra punctuation.
- Use short, natural game-UI wording; keep proper names, ball names and ALL-CAPS labels consistent within the batch.
Return only JSON: {"t": {"<item id>": {"<locale>": "<translation>"}}}.`;

const names = new Intl.DisplayNames(['en'], { type: 'language' });
function languageName(code: string): string { try { return names.of(code) ?? code; } catch { return code; } }

function multiset(values: string[]): string { return values.sort().join('\u0000'); }
/** Placeholders and markup tags must survive exactly; returns a reason when they do not. */
export function checkTranslation(en: string, text: string): string | null {
  if (!text.trim() && en.trim()) return 'empty translation';
  const holders = (s: string) => s.match(/\{[^{}]*\}/g) ?? [];
  const tags = (s: string) => s.match(/<\/?[A-Za-z][^<>]*>/g) ?? [];
  if (multiset(holders(en)) !== multiset(holders(text))) return 'placeholders differ';
  if (multiset(tags(en)) !== multiset(tags(text))) return 'markup tags differ';
  return null;
}
/** Restore the source's exact leading/trailing whitespace. */
function edges(en: string, text: string): string {
  const lead = /^\s*/.exec(en)![0], trail = /\s*$/.exec(en)![0];
  return lead + text.trim() + trail;
}

export class TranslationCache {
  private map = new Map<string, string>();
  constructor(private path: string) {}
  static key(en: string, zh: string, locale: string) { return createHash('sha256').update(`${locale}\u0000${en}\u0000${zh}`).digest('base64url'); }
  async load(): Promise<this> {
    try {
      for (const line of (await readFile(this.path, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try { const row = JSON.parse(line); if (typeof row.k === 'string' && typeof row.t === 'string') this.map.set(row.k, row.t); } catch { /* skip torn line */ }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('STORAGE_ERROR', 'Cannot read translation cache.'); }
    return this;
  }
  get(en: string, zh: string, locale: string) { return this.map.get(TranslationCache.key(en, zh, locale)); }
  async put(rows: { en: string; zh: string; locale: string; text: string }[]): Promise<void> {
    if (!rows.length) return;
    await mkdir(dirname(this.path), { recursive: true });
    const lines = rows.map(row => { const k = TranslationCache.key(row.en, row.zh, row.locale); this.map.set(k, row.text); return JSON.stringify({ k, t: row.text }); });
    await appendFile(this.path, lines.join('\n') + '\n', 'utf8');
  }
}

export interface TranslateOptions {
  model: string; concurrency?: number; batchPairs?: number; languageGroup?: number;
  cache?: TranslationCache; signal?: AbortSignal; progress?: (done: number, total: number) => void;
}

/** Batches consecutive entries × a group of languages per request and runs requests in parallel. */
export async function translate(client: DeepSeekClient, jobs: TranslationJob[], options: TranslateOptions): Promise<TranslationOutcome> {
  const outcome: TranslationOutcome = { translations: [], failures: [], cached: 0 };
  const pending: { job: TranslationJob; locales: string[] }[] = [];
  for (const job of jobs) {
    const need: string[] = [];
    for (const locale of job.locales) {
      const hit = options.cache?.get(job.en, job.zh, locale);
      if (hit !== undefined && !checkTranslation(job.en, hit)) { outcome.translations.push({ en: job.en, locale, text: hit }); outcome.cached++; }
      else need.push(locale);
    }
    if (need.length) pending.push({ job, locales: need });
  }
  const allLocales = [...new Set(pending.flatMap(row => row.locales))].sort();
  const groupSize = options.languageGroup ?? 12, maxPairs = options.batchPairs ?? 120;
  type Batch = { job: TranslationJob; locales: string[] }[];
  const batches: Batch[] = [];
  for (let g = 0; g < allLocales.length; g += groupSize) {
    const group = new Set(allLocales.slice(g, g + groupSize));
    let current: Batch = [], pairs = 0;
    for (const row of pending) {
      const locales = row.locales.filter(code => group.has(code));
      if (!locales.length) continue;
      if (pairs + locales.length > maxPairs && current.length) { batches.push(current); current = []; pairs = 0; }
      current.push({ job: row.job, locales }); pairs += locales.length;
    }
    if (current.length) batches.push(current);
  }
  const total = pending.reduce((n, row) => n + row.locales.length, 0);
  let done = 0;

  const request = async (batch: Batch): Promise<Map<string, string>[]> => {
    const locales = [...new Set(batch.flatMap(row => row.locales))].sort();
    const user = JSON.stringify({ locales: Object.fromEntries(locales.map(code => [code, languageName(code)])), items: batch.map((row, i) => ({ id: String(i + 1), en: row.job.en, zh: row.job.zh, to: row.locales })) });
    const d = await client.chatJson(options.model, SYSTEM, user) as any;
    const table = d && typeof d === 'object' && d.t && typeof d.t === 'object' ? d.t : {};
    return batch.map((_, i) => {
      const got = table[String(i + 1)], map = new Map<string, string>();
      if (got && typeof got === 'object') for (const [k, v] of Object.entries(got)) if (typeof v === 'string') map.set(k, v);
      return map;
    });
  };

  const accept = async (batch: Batch, results: Map<string, string>[] | null, retry: { job: TranslationJob; locale: string; reason: string }[]) => {
    const fresh: { en: string; zh: string; locale: string; text: string }[] = [];
    batch.forEach((row, i) => {
      for (const locale of row.locales) {
        const raw = results?.[i]?.get(locale);
        const reason = raw === undefined ? 'missing in response' : checkTranslation(row.job.en, raw);
        if (reason) { retry.push({ job: row.job, locale, reason }); continue; }
        const text = edges(row.job.en, raw!);
        outcome.translations.push({ en: row.job.en, locale, text });
        fresh.push({ en: row.job.en, zh: row.job.zh, locale, text });
      }
    });
    done += fresh.length;
    await options.cache?.put(fresh);
    options.progress?.(done, total);
  };

  const queue = [...batches];
  const retries: { job: TranslationJob; locale: string; reason: string }[] = [];
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      let results: Map<string, string>[] | null = null;
      try { results = await request(batch); }
      catch (error) { if (error instanceof AppError && ['AUTH_INVALID', 'CANCELLED'].includes(error.code) || (error as AppError)?.httpStatus === 402) throw error; }
      await accept(batch, results, retries);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, worker));

  // Failed pairs are retried one entry × one locale at a time, twice.
  for (let round = 0; round < 2 && retries.length; round++) {
    const again = retries.splice(0);
    const single = again.map(row => [{ job: row.job, locales: [row.locale] }] as Batch);
    const next: typeof retries = [];
    const singleWorker = async () => {
      for (let batch = single.shift(); batch; batch = single.shift()) {
        let results: Map<string, string>[] | null = null;
        try { results = await request(batch); } catch (error) { if (error instanceof AppError && ['AUTH_INVALID', 'CANCELLED'].includes(error.code)) throw error; }
        await accept(batch, results, next);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, singleWorker));
    retries.push(...next);
  }
  for (const row of retries) outcome.failures.push({ en: row.job.en, locale: row.locale, reason: row.reason });
  return outcome;
}
