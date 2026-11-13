import { isDeepStrictEqual } from 'node:util';
import { backup, object, type JsonObject, type WriteOptions, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { saveEventReceipt } from './receipts.js';
import { validateEventText, type EventTextField } from './rules.js';

const BASE = 'https://apis.roblox.com/virtual-events/v3';
export const eventCategories = ['contentUpdate', 'locationUpdate', 'systemUpdate', 'activity', 'newContent', 'itemDrop', 'newSeason', 'newLocation', 'newMap', 'moreLevels', 'newFeature', 'earlyAccess', 'expansion', 'challenge', 'quest', 'festival'] as const;
export type EventCategory = typeof eventCategories[number];
export interface EventFields {
  title: string; subtitle: string; description?: string; startTime: string; endTime: string;
  visibility: 'public' | 'private'; placeId?: number;
  categories?: { category: EventCategory; rank: number }[];
  thumbnails?: { mediaId: number; rank: number }[];
}
export interface CreateEventFields extends EventFields { groupId?: number }
export interface GameEvent extends JsonObject { id: string; universeId: number }
export interface EventListOptions {
  all?: boolean; visibility?: 'public' | 'private' | 'moderated';
  startsBefore?: string; startsAfter?: string; endsBefore?: string; endsAfter?: string;
}
/** Event IDs exceed 2^53; never pass them through Number or the ordinary id() helper. */
export function eventId(value: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new AppError('ARGUMENT_ERROR', 'Expected a positive decimal event ID string (up to 20 digits).');
  return value;
}
export function eventTime(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AppError('ARGUMENT_ERROR', 'Use an ISO timestamp including seconds and timezone, such as 2026-12-01T18:00:00-08:00.');
  }
  // Date.parse normalizes impossible calendar dates; reject those before submitting.
  const day = Number(value.slice(8, 10)), month = Number(value.slice(5, 7)), year = Number(value.slice(0, 4));
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new AppError('ARGUMENT_ERROR', 'Invalid calendar date or time.');
  return new Date(value).toISOString();
}
function numericId(value: unknown): number {
  if (typeof value !== 'number') throw new AppError('ARGUMENT_ERROR', 'Place, group and media IDs must be positive safe integers.');
  id(String(value)); return value;
}
export function validateEventFields(input: unknown, create = false): JsonObject {
  const data = object(input), out: JsonObject = {};
  const allowed = ['title', 'subtitle', 'description', 'startTime', 'endTime', 'visibility', 'placeId', 'categories', 'thumbnails', ...(create ? ['groupId'] : [])];
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) throw new AppError('ARGUMENT_ERROR', `Unsupported event field: ${key}.`);
    const value = data[key];
    if (value === undefined) continue;
    if (['title', 'subtitle', 'description'].includes(key)) {
      out[key] = validateEventText(key as EventTextField, value);
    } else if (key === 'startTime' || key === 'endTime') out[key] = eventTime(value as string);
    else if (key === 'visibility') {
      if (value !== 'public' && value !== 'private') throw new AppError('ARGUMENT_ERROR', 'Writable visibility must be public or private.');
      out[key] = value;
    } else if (key === 'placeId' || key === 'groupId') out[key] = numericId(value);
    else {
      if (!Array.isArray(value)) throw new AppError('ARGUMENT_ERROR', `${key} must be an array.`);
      const ranks = new Set<number>(), entries = new Set<string>();
      out[key] = value.map(item => {
        const row = object(item), rank = row.rank;
        const field = key === 'categories' ? 'category' : 'mediaId';
        if (Object.keys(row).some(k => k !== field && k !== 'rank') || !Number.isSafeInteger(rank) || (rank as number) < 0 || ranks.has(rank as number)) throw new AppError('ARGUMENT_ERROR', 'Ranks must be unique non-negative safe integers.');
        const content = field === 'category' ? row.category : numericId(row.mediaId);
        if (field === 'category' && !eventCategories.includes(content as EventCategory)) throw new AppError('ARGUMENT_ERROR', 'Unknown event category; run rbx events categories.');
        if (entries.has(String(content))) throw new AppError('ARGUMENT_ERROR', `Duplicate ${field}.`);
        ranks.add(rank as number); entries.add(String(content));
        return { [field]: content, rank };
      });
    }
  }
  if (create) for (const key of ['title', 'subtitle', 'startTime', 'endTime', 'visibility']) {
    if (out[key] === undefined) throw new AppError('ARGUMENT_ERROR', `Missing event field: ${key}.`);
  }
  if (!Object.keys(out).length) throw new AppError('ARGUMENT_ERROR', 'Specify at least one event field to update.');
  if (out.startTime && out.endTime && Date.parse(out.endTime as string) <= Date.parse(out.startTime as string)) throw new AppError('ARGUMENT_ERROR', 'Event end must be after its start.');
  return out;
}
function parseEvent(value: unknown, expectedId?: string, universeId?: string): GameEvent {
  const data = object(value, true);
  try { eventId(data.id as string); numericId(data.universeId); }
  catch { throw new AppError('INVALID_RESPONSE', 'Roblox returned invalid event or universe IDs.'); }
  if ((expectedId && data.id !== expectedId) || (universeId && String(data.universeId) !== universeId)) throw new AppError('INVALID_RESPONSE', 'Roblox returned a different event or universe.');
  return data as GameEvent;
}
function matches(event: GameEvent, body: JsonObject): boolean {
  return Object.entries(body).every(([key, value]) => {
    if (key === 'groupId') {
      const host = event.host;
      return host !== null && typeof host === 'object' && !Array.isArray(host) && (host as JsonObject).hostType === 'group' && (host as JsonObject).hostId === value;
    }
    if (key === 'startTime' || key === 'endTime') return typeof event[key] === 'string' && Date.parse(event[key] as string) === Date.parse(value as string);
    if (key === 'categories' || key === 'thumbnails') {
      const normalize = (rows: unknown) => Array.isArray(rows) ? [...rows].sort((a, b) => a.rank - b.rank) : rows;
      return isDeepStrictEqual(normalize(event[key]), normalize(value));
    }
    return isDeepStrictEqual(event[key], value);
  });
}
function ambiguous(error: unknown): boolean {
  return !(error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500);
}

export class GameEvents {
  constructor(private http: HttpClient) {}
  async get(value: string): Promise<GameEvent> {
    return parseEvent(await this.http.request(`${BASE}/game-events/${eventId(value)}`, { auth: true }), value);
  }
  async list(universeId: string, options: EventListOptions = {}): Promise<GameEvent[]> {
    const endpoint = new URL(`${BASE}/universes/${id(universeId)}/game-events`);
    endpoint.searchParams.set('pageSize', '100');
    if (options.visibility !== undefined) {
      if (!['public', 'private', 'moderated'].includes(options.visibility)) throw new AppError('ARGUMENT_ERROR', 'Invalid visibility filter.');
      endpoint.searchParams.set('visibility', options.visibility);
    }
    for (const key of ['startsBefore', 'startsAfter', 'endsBefore', 'endsAfter'] as const) if (options[key] !== undefined) endpoint.searchParams.set(key, eventTime(options[key]!));
    if (options.all && !options.endsBefore && !options.endsAfter) endpoint.searchParams.set('endsAfter', '1970-01-01T00:00:00.000Z');
    const rows = new Map<string, GameEvent>(), tokens = new Set<string>();
    for (;;) {
      const page = object(await this.http.request(endpoint.toString(), { auth: true }), true);
      if (!Array.isArray(page.gameEvents)) throw new AppError('INVALID_RESPONSE', 'Invalid event list.');
      for (const value of page.gameEvents) { const row = parseEvent(value, undefined, universeId); rows.set(row.id, row); }
      const next = page.nextPageToken;
      if (next === undefined || next === null || next === '') break;
      if (typeof next !== 'string' || tokens.has(next)) throw new AppError('INVALID_RESPONSE', 'Invalid or repeated event pagination token.');
      tokens.add(next); endpoint.searchParams.set('pageToken', next);
    }
    return [...rows.values()];
  }
  async create(universeId: string, fields: CreateEventFields, options: WriteOptions = {}): Promise<WriteReceipt> {
    const body = validateEventFields(fields, true);
    const request = { method: 'POST' as const, url: `${BASE}/universes/${id(universeId)}/game-events`, body };
    const receipt: WriteReceipt = { universeId, state: 'planned', request };
    if (options.dryRun) return receipt;
    receipt.backupPath = await backup(options.backupDirectory, universeId, request, null);
    return saveEventReceipt(await this.write(receipt));
  }
  async update(value: string, fields: Partial<EventFields>, options: WriteOptions = {}): Promise<WriteReceipt> {
    eventId(value);
    const body = validateEventFields(fields), before = await this.get(value);
    // Validate one-sided schedule edits against the unchanged endpoint.
    if (body.startTime !== undefined || body.endTime !== undefined) {
      const start = body.startTime ?? before.startTime, end = body.endTime ?? before.endTime;
      if (typeof start !== 'string' || typeof end !== 'string' || Date.parse(eventTime(end)) <= Date.parse(eventTime(start))) throw new AppError('ARGUMENT_ERROR', 'Event end must be after its start.');
    }
    const request = { method: 'PATCH' as const, url: `${BASE}/game-events/${value}`, body };
    const receipt: WriteReceipt = { universeId: String(before.universeId), state: 'planned', request };
    if (options.dryRun) return { ...receipt, readback: before };
    receipt.backupPath = await backup(options.backupDirectory, receipt.universeId, request, before);
    return saveEventReceipt(await this.write(receipt, value));
  }
  async delete(value: string, options: WriteOptions = {}): Promise<WriteReceipt> {
    const before = await this.get(eventId(value));
    const request = { method: 'DELETE' as const, url: `${BASE}/game-events/${value}` };
    const receipt: WriteReceipt = { universeId: String(before.universeId), state: 'planned', request };
    if (options.dryRun) return { ...receipt, readback: before };
    receipt.backupPath = await backup(options.backupDirectory, receipt.universeId, request, before);
    try {
      const result = await this.http.request<{ status: number }>(request.url, { auth: true, method: 'DELETE', rawResponse: true });
      if (result.status !== 204) throw new AppError('INVALID_RESPONSE', 'Event deletion did not return the documented 204 response.');
      return saveEventReceipt({ ...receipt, state: 'verified' });
    } catch (error) {
      if (!ambiguous(error)) throw error;
      return saveEventReceipt({ ...receipt, state: 'unverified', error: errorInfo(error) });
    }
  }
  private async write(receipt: WriteReceipt, expectedId?: string): Promise<WriteReceipt> {
    try {
      const response = parseEvent(await this.http.request(receipt.request.url, { ...receipt.request, auth: true, validationDetails: true }), expectedId, receipt.universeId);
      receipt.response = response;
      receipt.readback = await this.get(response.id);
      if (String(receipt.readback.universeId) !== receipt.universeId || !matches(receipt.readback as GameEvent, receipt.request.body!) || response.allThumbnailsCreated === false) throw new AppError('INVALID_RESPONSE', 'Event readback or thumbnail persistence is incomplete; inspect before retrying.');
      return { ...receipt, state: 'verified' };
    } catch (error) {
      if (!receipt.response && error instanceof AppError && error.httpStatus === 400 && error.message.includes('InvalidTitleOrDescriptionException')) {
        throw new AppError(error.code, `${error.message} Roblox rejected event text; check rbx events rules. Local length checks cannot verify text moderation or other server rules.`, error.httpStatus);
      }
      if (!receipt.response && !ambiguous(error)) throw error;
      return { ...receipt, state: 'unverified', error: errorInfo(error) };
    }
  }
}
