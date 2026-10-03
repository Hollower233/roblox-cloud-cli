import { AppError, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';

export interface BanOptions {
  duration?: string; permanent?: boolean; reason: string; privateReason?: string; includeAlts?: boolean;
}
export function banBody(options: BanOptions) {
  if (Boolean(options.duration) === Boolean(options.permanent))
    throw new AppError('ARGUMENT_ERROR', 'Specify exactly one of --duration or --permanent.');
  if (!options.reason?.trim() || [...options.reason].length > 400)
    throw new AppError('ARGUMENT_ERROR', 'Reason must contain 1–400 characters.');
  if (options.privateReason !== undefined && [...options.privateReason].length > 1000)
    throw new AppError('ARGUMENT_ERROR', 'Private reason must not exceed 1000 characters.');
  let duration: string | undefined;
  if (options.duration) {
    const match = /^(\d+)(s|m|h|d)$/.exec(options.duration);
    const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[match[2]!] ?? 0) : NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 315576000000)
      throw new AppError('ARGUMENT_ERROR', 'Duration must be a positive integer with s/m/h/d, at most 315576000000 seconds.');
    duration = `${seconds}s`;
  }
  return { gameJoinRestriction: { active: true, ...(duration ? { duration } : {}),
    displayReason: options.reason, privateReason: options.privateReason ?? options.reason,
    excludeAltAccounts: !options.includeAlts } };
}

export class UserRestrictions {
  constructor(private http: HttpClient) {}
  private url(universeId: string, userId: string) {
    return `https://apis.roblox.com/cloud/v2/universes/${id(universeId)}/user-restrictions/${id(userId)}`;
  }
  async get(universeId: string, userId: string): Promise<unknown> {
    return this.http.request(this.url(universeId, userId), { auth: true });
  }
  async ban(universeId: string, userId: string, options: BanOptions, dryRun = false) {
    return this.update(universeId, userId, banBody(options), dryRun);
  }
  async unban(universeId: string, userId: string, dryRun = false) {
    return this.update(universeId, userId, { gameJoinRestriction: { active: false } }, dryRun);
  }
  private async update(universeId: string, userId: string, body: object, dryRun: boolean) {
    const url = this.url(universeId, userId) + '?updateMask=gameJoinRestriction';
    if (dryRun) return { dryRun: true, universeId, userId, method: 'PATCH', url, body };
    try {
      const restriction = await this.http.request(url, { auth: true, method: 'PATCH', body });
      return { dryRun: false, universeId, userId, restriction };
    } catch (error) {
      if (error instanceof AppError && error.code === 'FORBIDDEN')
        throw new AppError('FORBIDDEN', 'User restriction update denied. Check universe.user-restriction:write scope and access to this universe.', 403);
      // A lost response can follow a successful write. Never automatically repeat a moderation action.
      if (error instanceof AppError)
        throw new AppError(error.code, `${error.message} Update outcome may be unknown; use ban-status before retrying.`, error.httpStatus);
      throw error;
    }
  }
}
