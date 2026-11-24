import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';
import { validateRobloxCookie } from '../auth/credentials.js';

const hosts = new Set(['apis.roblox.com', 'games.roblox.com', 'groups.roblox.com', 'users.roblox.com', 'develop.roblox.com','locale.roblox.com', 'gameinternationalization.roblox.com']);
export interface HttpOptions {
  apiKey?: string; robloxCookie?: string; fetch?: typeof fetch; intervalMs?: number; timeoutMs?: number;
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
  async request<T>(url: string, options: { auth?: boolean; cookieAuth?: boolean; method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; rawBody?: string; form?: FormData; headers?: Record<string, string>; rawResponse?: boolean; validationDetails?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !hosts.has(target.host) || target.username || target.password) throw new AppError('ARGUMENT_ERROR', 'Unsupported Roblox API destination.');
    if (options.auth && target.host !== 'apis.roblox.com') throw new AppError('ARGUMENT_ERROR', 'API keys may only be sent to apis.roblox.com.');
    if (options.auth && !this.options.apiKey) throw new AppError('AUTH_REQUIRED', 'Configure an API key first.');
    const hasBody = options.body !== undefined || options.rawBody !== undefined || options.form !== undefined;
    const method = options.method ?? (hasBody ? 'POST' : 'GET');
    if (method === 'GET' && hasBody) throw new AppError('ARGUMENT_ERROR', 'GET requests cannot carry a body.');
    let cookie: string | undefined;
    const removePlace = options.cookieAuth && target.host === 'apis.roblox.com' && method === 'POST'
      && /^\/universes\/v1\/universes\/[1-9]\d*\/places\/[1-9]\d*\/remove-place$/.test(target.pathname) && !hasBody;
    const subscription = options.cookieAuth && target.host === 'apis.roblox.com'
      ? /^\/experience-subscriptions\/v1\/experiences\/[1-9]\d*\/experience-subscriptions(?:\/([1-9]\d{0,127}|shortened-name)(?:\/(activate|upload-image))?)?$/.exec(target.pathname)
      : null;
    const confirmShortName = subscription?.[1] === 'shortened-name' && !subscription[2] && method === 'POST';
    const subscriptionList = subscription !== null && !subscription[1] && method === 'GET';
    const subscriptionProduct = !!subscription?.[1] && subscription[1] !== 'shortened-name';
    if (options.cookieAuth) {
      const placeConfiguration = target.host === 'develop.roblox.com' && /^\/v2\/places\/[1-9]\d*$/.test(target.pathname)
        && (method === 'GET' || method === 'PATCH');
      const createPlace = target.host === 'apis.roblox.com' && method === 'POST'
        && /^\/universes\/v1\/user\/universes\/[1-9]\d*\/places$/.test(target.pathname)
        && options.body !== undefined && options.rawBody === undefined && options.form === undefined;
      const subscriptionUser = target.host === 'users.roblox.com' && target.pathname === '/v1/users/authenticated' && method === 'GET';
      const jsonBody = options.body !== undefined && options.rawBody === undefined && options.form === undefined;
      const subscriptionOperation = subscription !== null && (
        (!subscription[2] && method === 'GET' && (!subscription[1] || subscriptionProduct || subscription[1] === 'shortened-name'))
        || ((!subscription[1] && method === 'POST' || confirmShortName
          || subscriptionProduct && !subscription[2] && method === 'PATCH') && jsonBody)
        || (subscriptionProduct && subscription[2] === 'activate' && method === 'POST' && !hasBody)
        || (subscriptionProduct && subscription[2] === 'upload-image' && method === 'POST' && options.form !== undefined
          && options.body === undefined && options.rawBody === undefined)
      );
      if ((!placeConfiguration && !createPlace && !removePlace && !subscriptionUser && !subscriptionOperation)
        || (target.search && (!subscriptionList || !validSubscriptionListQuery(target.searchParams)))
        || target.hash || options.auth || options.rawResponse || options.validationDetails) {
        throw new AppError('ARGUMENT_ERROR', 'Cookie authentication is limited to supported Roblox endpoints.');
      }
      if (this.options.robloxCookie === undefined) throw new AppError('AUTH_REQUIRED', 'Run rbx auth cookie set.');
      cookie = `.ROBLOSECURITY=${validateRobloxCookie(this.options.robloxCookie)}`;
    }
    // Only idempotent GETs are retried; writes may already have taken effect.
    const retryable = method === 'GET';
    for (const name of Object.keys(options.headers ?? {})) {
      if (!['content-md5', 'roblox-entry-attributes', 'roblox-entry-userids'].includes(name)) throw new AppError('ARGUMENT_ERROR', 'Unsupported request header.');
    }
    let csrfToken: string | undefined;
    const cancellation = options.signal && this.options.signal
      ? AbortSignal.any([options.signal, this.options.signal]) : options.signal ?? this.options.signal;
    const wait = (ms: number) => options.signal ? delay(ms, undefined, { signal: cancellation }) : this.sleep(ms);
    for (let attempt = 0; ; attempt++) {
      try {
        cancellation?.throwIfAborted();
        await this.pace(target.host);
        cancellation?.throwIfAborted();
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 25_000);
        const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
        const response = await this.fetcher(target, {
          method,
          headers: {
            Accept: 'application/json', ...options.headers,
            ...(options.auth ? { 'x-api-key': this.options.apiKey! } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            ...(hasBody && !options.form ? { 'Content-Type': subscription
              ? 'application/json-patch+json' : 'application/json' } : {}),
          },
          body: options.form ?? options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
          redirect: 'error', signal,
        });
        if (!response.ok) {
          const challenge = cookie && method !== 'GET' && response.status === 403 && !csrfToken
            ? response.headers.get('x-csrf-token') : null;
          if (challenge && await isCsrfChallenge(response)) {
            // Roblox rejected the first request before applying it. Answer the challenge once.
            csrfToken = challenge;
            continue;
          }
          // Response bodies stay hidden by default. Event validation can opt into bounded,
          // credential-redacted ProblemDetails text; never include request headers.
          let validation = '';
          if (options.validationDetails && response.status === 400) {
            try {
              const problem = await response.json() as Record<string, unknown>;
              const messages = [problem.title, problem.detail];
              if (problem.errors && typeof problem.errors === 'object' && !Array.isArray(problem.errors)) {
                for (const [field, errors] of Object.entries(problem.errors)) {
                  if (Array.isArray(errors)) for (const message of errors) if (typeof message === 'string') messages.push(`${field}: ${message}`);
                }
              }
              let detail = messages.filter((value): value is string => typeof value === 'string').join(' ');
              if (this.options.apiKey) detail = detail.split(this.options.apiKey).join('[REDACTED]');
              detail = detail.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 600);
              if (detail) validation = ` ${detail}`;
            } catch { /* Keep the generic error if this is not ProblemDetails JSON. */ }
          } else if (!response.bodyUsed) await response.body?.cancel();
          if (retryable && [429, 500, 502, 503, 504].includes(response.status) && attempt < (this.options.retries ?? 3)) {
            const header = response.headers.get('retry-after');
            const requested = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
            if (Number.isFinite(requested) && requested > 30_000) throw new AppError('HTTP_ERROR', 'Rate limited; retry after the server cooldown.', response.status);
            await wait(Math.max(0, Number.isFinite(requested) ? requested : Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 250)));
            continue;
          }
          const code = response.status === 401 ? 'AUTH_INVALID' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR';
          if (cookie && response.status === 401) throw new AppError(code, 'Roblox rejected the session cookie. Run rbx auth cookie set again.', 401);
          throw new AppError(code, `Roblox ${target.pathname} returned HTTP ${response.status}.${validation}`, response.status);
        }
        if (options.rawResponse) return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) } as T;
        if (removePlace || confirmShortName) {
          await response.body?.cancel();
          return undefined as T;
        }
        try { return await response.json() as T; }
        catch { throw new AppError('INVALID_RESPONSE', 'Roblox returned invalid JSON.'); }
      } catch (error) {
        if (cancellation?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
        if (error instanceof AppError) throw error;
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new AppError('TIMEOUT', 'Roblox request timed out.');
        if (retryable && attempt < (this.options.retries ?? 3)) { await wait(1000 * 2 ** attempt); continue; }
        throw new AppError('NETWORK_ERROR', 'Could not connect to Roblox.');
      }
    }
  }
}

function validSubscriptionListQuery(query: URLSearchParams): boolean {
  const cursors = query.getAll('Cursor'), sizes = query.getAll('ResultsPerPage');
  return query.size === cursors.length + sizes.length && cursors.length <= 1 && sizes.length <= 1
    && cursors.every(cursor => cursor.length > 0 && cursor.length <= 4096)
    && sizes.every(size => /^[1-9]\d?$/.test(size) && Number(size) <= 50);
}

async function isCsrfChallenge(response: Response): Promise<boolean> {
  try {
    const body = await response.json() as { errors?: { code?: number; message?: string }[] };
    return Array.isArray(body?.errors) && body.errors.some(error =>
      error?.code === 9001 || (error?.code === 0 && typeof error.message === 'string'
        && /^(?:(?:[xc]srf )?token validation failed|[xc]srf token (?:is )?invalid)\.?$/i.test(error.message.trim())));
  } catch {
    return false;
  }
}
