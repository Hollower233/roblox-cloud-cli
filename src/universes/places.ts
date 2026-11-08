import { object } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

export interface PlaceInfo {
  universeId: string; placeId: string; name: string; isRootPlace: boolean; maxPlayers: number;
}
export interface PlaceUpdateOptions { placeId?: string; all?: boolean; maxPlayers: number }
export interface PlaceUpdateResult {
  placeId: string; before?: number; requested: number; after?: number;
  state: 'verified' | 'failed' | 'unverified'; error?: ReturnType<typeof errorInfo>;
}
export function maxPlayers(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('ARGUMENT_ERROR', 'Max players must be a positive safe integer.');
  return value;
}
export function validatePlaceUpdate(options: PlaceUpdateOptions): void {
  maxPlayers(options.maxPlayers);
  if (options.all === true ? options.placeId !== undefined : options.placeId === undefined) {
    throw new AppError('ARGUMENT_ERROR', 'Specify exactly one of --place or --all.');
  }
  if (options.placeId !== undefined) id(options.placeId);
}
function url(universeId: string, placeId: string): string {
  return `https://apis.roblox.com/cloud/v2/universes/${id(universeId)}/places/${id(placeId)}`;
}
function responseId(value: unknown): string {
  try { return id(String(value)); } catch { throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Place ID.'); }
}
function parsePlace(value: unknown, universeId: string, placeId: string, rootPlaceId?: string): PlaceInfo {
  const data = object(value, true);
  if (data.path !== `universes/${universeId}/places/${placeId}` || typeof data.displayName !== 'string'
    || !Number.isSafeInteger(data.serverSize) || (data.serverSize as number) < 1) {
    throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Place configuration.');
  }
  return { universeId, placeId, name: data.displayName, isRootPlace: rootPlaceId === placeId || data.root === true, maxPlayers: data.serverSize as number };
}

export async function getPlace(http: HttpClient, universeId: string, placeId: string): Promise<PlaceInfo> {
  return parsePlace(await http.request(url(universeId, placeId), { auth: true }), universeId, placeId);
}

async function placeDirectory(http: HttpClient, universeId: string): Promise<string[]> {
  id(universeId);
  const places = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const endpoint = new URL(`https://develop.roblox.com/v1/universes/${universeId}/places`);
    endpoint.searchParams.set('limit', '100');
    if (cursor) endpoint.searchParams.set('cursor', cursor);
    // Public directory; API keys are sent only to apis.roblox.com.
    const page = object(await http.request(endpoint.toString()), true);
    if (!Array.isArray(page.data)) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Place list.');
    for (const row of page.data) places.add(responseId(object(row, true).id));
    const next = page.nextPageCursor;
    if (next != null && (typeof next !== 'string' || !next || cursors.has(next))) {
      throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid or repeated Place cursor.');
    }
    cursor = next == null ? undefined : next as string;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...places];
}

export async function listPlaces(http: HttpClient, universeId: string): Promise<PlaceInfo[]> {
  const ids = await placeDirectory(http, universeId);
  const universe = object(await http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }), true);
  const root = typeof universe.rootPlace === 'string' ? new RegExp(`^universes/${universeId}/places/([1-9]\\d*)$`).exec(universe.rootPlace)?.[1] : undefined;
  if (!root || !ids.includes(root)) throw new AppError('INVALID_RESPONSE', 'Place directory is missing the universe root Place.');
  const places: PlaceInfo[] = [];
  for (const placeId of ids) places.push(parsePlace(await http.request(url(universeId, placeId), { auth: true }), universeId, placeId, root));
  return places;
}

export async function updatePlaces(http: HttpClient, universeId: string, options: PlaceUpdateOptions): Promise<{ universeId: string; results: PlaceUpdateResult[] }> {
  id(universeId);
  validatePlaceUpdate(options);
  // Finish pagination before any write so a broken directory cannot produce an incomplete --all mutation.
  const ids = options.all ? await placeDirectory(http, universeId) : [options.placeId!];
  if (!ids.length) throw new AppError('INVALID_RESPONSE', 'Roblox returned no Places; no updates submitted.');
  const results: PlaceUpdateResult[] = [];
  for (const placeId of ids) {
    const result: PlaceUpdateResult = { placeId, requested: options.maxPlayers, state: 'failed' };
    results.push(result);
    let submitted = false;
    try {
      result.before = (await getPlace(http, universeId, placeId)).maxPlayers;
      submitted = true;
      await http.request(`${url(universeId, placeId)}?updateMask=serverSize`, {
        method: 'PATCH', auth: true, body: { serverSize: options.maxPlayers },
      });
      result.state = 'unverified';
      result.after = (await getPlace(http, universeId, placeId)).maxPlayers;
      if (result.after !== options.maxPlayers) throw new AppError('INVALID_RESPONSE', 'Place readback does not match requested max players; inspect before retrying.');
      result.state = 'verified';
    } catch (error) {
      const definiteRejection = error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500;
      result.state = result.state === 'unverified' || (submitted && !definiteRejection) ? 'unverified' : 'failed';
      result.error = error instanceof AppError && error.httpStatus === 409
        ? { ...errorInfo(error), message: 'Place update conflicted with an active Team Create session. Close the editing session and retry.' }
        : errorInfo(error);
      if (error instanceof AppError && error.code === 'CANCELLED') break;
    }
  }
  return { universeId, results };
}
