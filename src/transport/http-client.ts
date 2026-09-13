import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';

const hosts = new Set(['apis.roblox.com', 'games.roblox.com', 'groups.roblox.com', 'users.roblox.com']);
export interface HttpOptions {
  apiKey?: string; fetch?: typeof fetch; intervalMs?: number; timeoutMs?: number;
  retries?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>;
}
export class HttpClient {
  private next = new Map<string, number>();
  private queues = new Map<string, Promise<unknown>>();
  private fetcher: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private options: HttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (ms => delay(ms, undefined, { signal: options.signal }).then(() => undefined));
  }
  private async pace(host: string): Promise<void> {
    const previous = this.queues.get(host) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const wait = Math.max(0, (this.next.get(host) ?? 0) - Date.now());
      if (wait) await this.sleep(wait);
      this.next.set(host, Date.now() + (this.options.intervalMs ?? 700));
    });
    this.queues.set(host, task);
    await task;
  }
  async request<T>(url: string, options: { auth?: boolean; body?: unknown; rawBody?: string; headers?: Record<string, string>; rawResponse?: boolean } = {}): Promise<T> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !hosts.has(target.host) || target.username || target.password) throw new AppError('ARGUMENT_ERROR', 'Unsupported Roblox API destination.');
    if (options.auth && target.host !== 'apis.roblox.com') throw new AppError('ARGUMENT_ERROR', 'API keys may only be sent to apis.roblox.com.');
    if (options.auth && !this.options.apiKey) throw new AppError('AUTH_REQUIRED', 'Configure an API key first.');
    const retryable = options.body === undefined && options.rawBody === undefined;
    for (const name of Object.keys(options.headers ?? {})) {
      if (!['content-md5', 'roblox-entry-attributes', 'roblox-entry-userids'].includes(name)) throw new AppError('ARGUMENT_ERROR', 'Unsupported request header.');
    }
    for (let attempt = 0; ; attempt++) {
      try {
        this.options.signal?.throwIfAborted();
        await this.pace(target.host);
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 25_000);
        const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
        const response = await this.fetcher(target, {
          method: retryable ? 'GET' : 'POST',
          headers: { Accept: 'application/json', ...options.headers, ...(options.auth ? { 'x-api-key': this.options.apiKey! } : {}), ...(retryable ? {} : { 'Content-Type': 'application/json' }) },
          body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          redirect: 'error', signal,
        });
        if (!response.ok) {
          // Never include an untrusted response body, request headers or key in errors.
          await response.body?.cancel();
          if (retryable && [429, 500, 502, 503, 504].includes(response.status) && attempt < (this.options.retries ?? 3)) {
            const header = response.headers.get('retry-after');
            const requested = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
            if (Number.isFinite(requested) && requested > 30_000) throw new AppError('HTTP_ERROR', 'Rate limited; retry after the server cooldown.', response.status);
            await this.sleep(Math.max(0, Number.isFinite(requested) ? requested : Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 250)));
            continue;
          }
          const code = response.status === 401 ? 'AUTH_INVALID' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR';
          throw new AppError(code, `Roblox ${target.pathname} returned HTTP ${response.status}.`, response.status);
        }
        if (options.rawResponse) return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) } as T;
        try { return await response.json() as T; }
        catch { throw new AppError('INVALID_RESPONSE', 'Roblox returned invalid JSON.'); }
      } catch (error) {
        if (this.options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
        if (error instanceof AppError) throw error;
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new AppError('TIMEOUT', 'Roblox request timed out.');
        if (retryable && attempt < (this.options.retries ?? 3)) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new AppError('NETWORK_ERROR', 'Could not connect to Roblox.');
      }
    }
  }
}
