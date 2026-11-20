import { randomUUID } from 'node:crypto';
import { AppError, id } from '../core/errors.js';
import { publicGameDetails } from '../roblox/api.js';
import type { HttpClient } from '../transport/http-client.js';

export interface PublicGame {
  placeId: string;
  universeId: string;
  name: string;
  creatorName?: string;
}

/** Recognize a Place ID or a Roblox experience page. Other text is a search term. */
export function gamePlaceId(input: string): string | undefined {
  const value = input.trim();
  if (/^\d+$/.test(value)) return id(value);
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return undefined;
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* Report the same input error for all unsupported URLs. */ }
  if (url?.protocol === 'https:' && ['www.roblox.com', 'roblox.com'].includes(url.host) && !url.username && !url.password) {
    const match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?games\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (match) return id(match[1]!);
  }
  throw new AppError('ARGUMENT_ERROR', 'Provide a Roblox game page URL or a Place ID.');
}

function responseId(value: unknown): string {
  try { return id(typeof value === 'number' || typeof value === 'string' ? String(value) : ''); }
  catch { throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid game ID.'); }
}

export async function lookupPublicGame(http: HttpClient, place: string): Promise<PublicGame> {
  const placeId = id(place);
  const result = await http.request<{ universeId?: unknown } | null>(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  if (result?.universeId == null) throw new AppError('ARGUMENT_ERROR', 'No experience was found for this Place ID.');
  const universeId = responseId(result.universeId);
  const game = (await publicGameDetails(http, [universeId])).find(row => row.id === universeId);
  if (!game) throw new AppError('ARGUMENT_ERROR', 'Roblox did not return public metadata for this experience.');
  return { placeId, universeId, name: game.name, creatorName: game.owner.name };
}

export async function searchPublicGames(http: HttpClient, input: string): Promise<PublicGame[]> {
  const query = input.trim();
  if (!query || query.length > 150) throw new AppError('ARGUMENT_ERROR', 'Provide a game search term of 1–150 characters.');
  const url = new URL('https://apis.roblox.com/search-api/omni-search');
  url.searchParams.set('SearchQuery', query);
  url.searchParams.set('SessionId', randomUUID());
  const result = await http.request<{
    searchResults?: { contents?: { rootPlaceId?: unknown; universeId?: unknown; name?: unknown; creatorName?: unknown }[] }[];
  } | null>(url.href).catch(error => {
    if (error instanceof AppError && error.httpStatus === 429) {
      throw new AppError('HTTP_ERROR', 'Roblox game search is rate limited. Wait and retry.', 429);
    }
    throw error;
  });
  if (!Array.isArray(result?.searchResults)) throw new AppError('INVALID_RESPONSE', 'Roblox did not return game search results.');
  const games = new Map<string, PublicGame>();
  for (const group of result.searchResults) {
    if (!Array.isArray(group?.contents)) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid search result group.');
    for (const row of group.contents) {
      if (row?.rootPlaceId == null) continue;
      const placeId = responseId(row.rootPlaceId);
      if (games.has(placeId)) continue;
      const universeId = responseId(row.universeId);
      if (typeof row.name !== 'string' || !row.name.trim()) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid game title.');
      const creatorName = typeof row.creatorName === 'string' ? row.creatorName.trim() : '';
      games.set(placeId, { placeId, universeId, name: row.name, ...(creatorName ? { creatorName } : {}) });
    }
  }
  return [...games.values()];
}
