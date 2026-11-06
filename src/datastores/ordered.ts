import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

export interface OrderedDataStoreAddress { universeId: string; datastore: string; scope?: string }
export interface OrderedDataStoreEntry { key: string; score: number }

function segment(value: string): string {
  if (!value || value === '.' || value === '..') {
    throw new AppError('ARGUMENT_ERROR', 'Ordered DataStore name, scope and key must be valid non-empty path segments.');
  }
  return encodeURIComponent(value);
}

function entriesUrl({ universeId, datastore, scope = 'global' }: OrderedDataStoreAddress): string {
  return `https://apis.roblox.com/cloud/v2/universes/${id(universeId)}/ordered-data-stores/${segment(datastore)}/scopes/${segment(scope)}/entries`;
}

function readEntry(row: unknown): OrderedDataStoreEntry {
  const entry = row as { id?: unknown; value?: unknown } | null;
  if (typeof entry?.id !== 'string' || !entry.id || typeof entry.value !== 'number' || !Number.isInteger(entry.value)) {
    throw new AppError('INVALID_RESPONSE', 'Invalid Ordered DataStore entry response.');
  }
  return { key: entry.id, score: entry.value };
}

export class OrderedDataStoreEntries {
  constructor(private http: HttpClient) {}

  private async read<T>(url: string, universeId: string): Promise<T> {
    try {
      return await this.http.request<T>(url, { auth: true });
    } catch (error) {
      if (error instanceof AppError && error.httpStatus === 403) {
        throw new AppError('FORBIDDEN', `Ordered DataStore read denied. In Creator Hub (Open Cloud API Keys), grant universe.ordered-data-store.scope.entry:read for Universe ${universeId}.`, 403);
      }
      throw error;
    }
  }

  async list(address: OrderedDataStoreAddress, limit = 50): Promise<OrderedDataStoreEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AppError('ARGUMENT_ERROR', 'Limit must be a positive integer.');
    const url = new URL(entriesUrl(address));
    url.searchParams.set('orderBy', 'value desc');
    // Roblox requires the same query parameters on subsequent pages, except for pageToken.
    url.searchParams.set('maxPageSize', String(Math.min(100, limit)));
    const entries: OrderedDataStoreEntry[] = [];
    const seenTokens = new Set<string>();
    while (entries.length < limit) {
      const page = await this.read<{ orderedDataStoreEntries?: unknown; nextPageToken?: unknown } | null>(url.toString(), address.universeId);
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new AppError('INVALID_RESPONSE', 'Invalid Ordered DataStore list response.');
      }
      const { orderedDataStoreEntries: rows = [], nextPageToken: token } = page;
      if (!Array.isArray(rows) || (token !== undefined && typeof token !== 'string')) {
        throw new AppError('INVALID_RESPONSE', 'Invalid Ordered DataStore list response.');
      }
      for (const row of rows) {
        if (entries.length === limit) break;
        entries.push(readEntry(row));
      }
      if (!token || entries.length === limit) break;
      if (seenTokens.has(token)) throw new AppError('INVALID_RESPONSE', 'Roblox repeated an Ordered DataStore page token.');
      seenTokens.add(token);
      url.searchParams.set('pageToken', token);
    }
    return entries;
  }

  async get(address: OrderedDataStoreAddress & { key: string }): Promise<OrderedDataStoreEntry | null> {
    const url = `${entriesUrl(address)}/${segment(address.key)}`;
    try {
      return readEntry(await this.read<unknown>(url, address.universeId));
    } catch (error) {
      if (error instanceof AppError && error.httpStatus === 404) return null;
      throw error;
    }
  }
}
