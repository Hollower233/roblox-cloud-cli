import { setTimeout as delay } from 'node:timers/promises';
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
export const defaultPlaceTemplateId = '95206881';
export interface PlaceCreateOptions { name: string; templatePlaceId?: string; maxPlayers?: number }
export interface PlaceCreateResult {
  universeId: string; templatePlaceId: string; name: string; placeId?: string; place?: PlaceInfo;
  state: 'verified' | 'configuration_unverified' | 'creation_unverified';
  newPlaceCandidates?: string[]; error?: ReturnType<typeof errorInfo>;
}
export interface PlaceRemoveResult {
  universeId: string; placeId: string; state: 'verified' | 'already_absent' | 'unverified';
  error?: ReturnType<typeof errorInfo>;
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

export async function getUniversePlaceDirectory(http: HttpClient, universeId: string) {
  const [ids, response] = await Promise.all([
    placeDirectory(http, universeId),
    http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }),
  ]);
  const universe = object(response, true);
  const root = typeof universe.rootPlace === 'string' ? new RegExp(`^universes/${universeId}/places/([1-9]\\d*)$`).exec(universe.rootPlace)?.[1] : undefined;
  if (!root || !ids.includes(root)) throw new AppError('INVALID_RESPONSE', 'Place directory is missing the universe root Place.');
  const group = typeof universe.group === 'string' ? /^groups\/([1-9]\d*)$/.exec(universe.group)?.[1] : undefined;
  const user = typeof universe.user === 'string' ? /^users\/([1-9]\d*)$/.exec(universe.user)?.[1] : undefined;
  const owner = universe.path === `universes/${universeId}`
    ? group && !user ? { type: 'Group' as const, id: responseId(group) }
      : user && !group ? { type: 'User' as const, id: responseId(user) } : undefined
    : undefined;
  return { placeIds: ids, rootPlaceId: root, owner };
}

export async function listPlaces(http: HttpClient, universeId: string): Promise<PlaceInfo[]> {
  const { placeIds, rootPlaceId } = await getUniversePlaceDirectory(http, universeId);
  const places: PlaceInfo[] = [];
  for (const placeId of placeIds) places.push(parsePlace(await http.request(url(universeId, placeId), { auth: true }), universeId, placeId, rootPlaceId));
  return places;
}

function definitelyRejected(error: unknown): boolean {
  return error instanceof AppError && (
    ['ARGUMENT_ERROR', 'AUTH_REQUIRED'].includes(error.code)
    || (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408)
  );
}

export async function createPlace(http: HttpClient, universeId: string, options: PlaceCreateOptions): Promise<PlaceCreateResult> {
  id(universeId);
  const name = options.name.trim();
  if (!name) throw new AppError('ARGUMENT_ERROR', 'Place name must not be blank.');
  const templatePlaceId = id(options.templatePlaceId ?? defaultPlaceTemplateId);
  const serverSize = options.maxPlayers === undefined ? undefined : maxPlayers(options.maxPlayers);
  const before = await listPlaces(http, universeId);
  if (before.some(place => place.name.toLowerCase() === name.toLowerCase())) {
    throw new AppError('ARGUMENT_ERROR', 'A Place with that name already exists in the target universe.');
  }

  const result = { universeId, templatePlaceId, name };
  let placeId: string;
  try {
    const created = object(await http.request(`https://apis.roblox.com/universes/v1/user/universes/${universeId}/places`, {
      cookieAuth: true, method: 'POST', body: { templatePlaceId: Number(templatePlaceId) },
    }), true);
    placeId = responseId(created.placeId);
    if (before.some(place => place.placeId === placeId)) {
      throw new AppError('INVALID_RESPONSE', 'Roblox returned a Place ID that was already in the target universe.');
    }
  } catch (error) {
    if (definitelyRejected(error)) throw error;
    const beforeIds = new Set(before.map(place => place.placeId));
    const after = await placeDirectory(http, universeId).catch(() => undefined);
    return {
      ...result, state: 'creation_unverified', error: errorInfo(error),
      newPlaceCandidates: after?.filter(candidate => !beforeIds.has(candidate)),
    };
  }

  try {
    const configuration = serverSize === undefined ? { displayName: name } : { displayName: name, serverSize };
    const query = new URLSearchParams({ updateMask: Object.keys(configuration).join(',') });
    await http.request(`${url(universeId, placeId)}?${query}`, { method: 'PATCH', auth: true, body: configuration });
    const place = await getPlace(http, universeId, placeId);
    if (place.name !== name || (serverSize !== undefined && place.maxPlayers !== serverSize)) {
      throw new AppError('INVALID_RESPONSE', 'Place readback does not match its requested configuration.');
    }
    return { ...result, placeId, place, state: 'verified' };
  } catch (error) {
    return { ...result, placeId, state: 'configuration_unverified', error: errorInfo(error) };
  }
}

export async function removePlace(http: HttpClient, universeId: string, placeId: string): Promise<PlaceRemoveResult> {
  id(universeId);
  id(placeId);
  const result = { universeId, placeId };
  const before = await listPlaces(http, universeId);
  const place = before.find(row => row.placeId === placeId);
  if (!place) return { ...result, state: 'already_absent' };
  if (place.isRootPlace) throw new AppError('ARGUMENT_ERROR', 'The root Place cannot be removed.');

  let requestError: unknown;
  try {
    await http.request(`https://apis.roblox.com/universes/v1/universes/${universeId}/places/${placeId}/remove-place`, {
      cookieAuth: true, method: 'POST',
    });
  } catch (error) {
    if (definitelyRejected(error)) throw error;
    requestError = error;
  }

  try {
    for (const wait of [0, 1000, 2000]) {
      if (wait) await delay(wait);
      const ids = await placeDirectory(http, universeId);
      if (!ids.includes(placeId) && before.some(row => row.isRootPlace && ids.includes(row.placeId))) {
        return { ...result, state: 'verified' };
      }
    }
    throw new AppError('INVALID_RESPONSE', 'The directory has not confirmed removal. Check it before retrying.');
  } catch (error) {
    return { ...result, state: 'unverified', error: errorInfo(requestError ?? error) };
  }
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
