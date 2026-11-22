import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

export interface PlaceVersion {
  version: string;
  title: string | null;
  description: string | null;
  createdTime: string;
  isPublished: boolean;
}
export interface PlaceVersionPage {
  placeId: string;
  versions: PlaceVersion[];
  nextCursor: string | null;
}

function versionHistoryUrl(placeId: string): string {
  return `https://apis.roblox.com/place-version-history-api/v1/${id(placeId)}`;
}

function parseVersion(value: unknown): PlaceVersion {
  if (!value || typeof value !== 'object') throw new AppError('INVALID_RESPONSE', 'Invalid Place version.');
  const row = value as Record<string, unknown>;
  if (typeof row.version !== 'string' || !/^[1-9]\d*$/.test(row.version)
    || (row.title !== null && typeof row.title !== 'string')
    || (row.description !== null && typeof row.description !== 'string')
    || typeof row.createdTime !== 'string' || typeof row.isPublished !== 'boolean') {
    throw new AppError('INVALID_RESPONSE', 'Invalid Place version.');
  }
  return { version: row.version, title: row.title, description: row.description, createdTime: row.createdTime, isPublished: row.isPublished };
}

/** Read one page of version history, starting with the latest versions. */
export async function listPlaceVersions(http: HttpClient, placeId: string, cursor?: string, signal?: AbortSignal): Promise<PlaceVersionPage> {
  const query = new URLSearchParams({ pageSize: '50' });
  if (cursor) query.set('cursor', cursor);
  const page = await http.request<{ placeVersions?: unknown; nextCursor?: unknown; hasMore?: unknown } | null>(
    `${versionHistoryUrl(placeId)}/history?${query}`, { auth: true, ...(signal ? { signal } : {}) },
  );
  if (!page || !Array.isArray(page.placeVersions) || typeof page.hasMore !== 'boolean'
    || (page.hasMore && (typeof page.nextCursor !== 'string' || !page.nextCursor))) {
    throw new AppError('INVALID_RESPONSE', 'Invalid Place version history page.');
  }
  const nextCursor = page.hasMore && typeof page.nextCursor === 'string' ? page.nextCursor : null;
  return { placeId, versions: page.placeVersions.map(parseVersion), nextCursor };
}

export function normalizePlaceVersionTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new AppError('ARGUMENT_ERROR', 'Provide a non-empty single-line version title.');
  }
  return normalized;
}

/** Submit notes for a specific version. The HTTP receipt confirms acceptance. */
export async function writePlaceVersionNotes(http: HttpClient, placeId: string, version: string, title: string, details = ''): Promise<void> {
  const url = `${versionHistoryUrl(placeId)}/version/${id(version)}/notes`;
  await http.request(url, {
    auth: true, method: 'POST', rawResponse: true,
    body: { title: normalizePlaceVersionTitle(title), description: details.replace(/\r\n?/g, '\n').trim() },
  });
}

/** Update exactly one version, then verify the title and description through version history. */
export async function setPlaceVersionNotes(http: HttpClient, placeId: string, version: string, title: string, details = ''): Promise<PlaceVersion> {
  const normalizedTitle = normalizePlaceVersionTitle(title);
  const description = details.replace(/\r\n?/g, '\n').trim();
  await writePlaceVersionNotes(http, placeId, version, normalizedTitle, description);

  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listPlaceVersions(http, placeId, cursor);
    const saved = page.versions.find(row => row.version === version);
    if (saved) {
      if (saved.title === normalizedTitle && (saved.description ?? '') === description) return saved;
      break;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new AppError('INVALID_RESPONSE', 'Repeated Place version history cursor after writing notes.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new AppError('INVALID_RESPONSE', `Roblox accepted the notes for Place ${placeId} version ${version}, but the readback did not match. Inspect version history before retrying.`);
}
