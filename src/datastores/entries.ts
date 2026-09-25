import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';

export interface EntryAddress { universeId: string; datastore: string; key: string; scope: string }
export interface EntrySnapshot { raw: string; version: string; attributes: string; userIds: string }
export interface EntryVersion { version: string; deleted: boolean; contentLength: number; createdTime: string; objectCreatedTime: string }
export interface EntryRevision { version: string; createdTime: string; objectCreatedTime: string; value: unknown; attributes: unknown; users: string[] }
export interface ClearEntryOptions { dryRun?: boolean; requireReleasedProfile?: boolean }
interface RawResponse { status: number; text: string; headers: Record<string, string> }
export class DataStoreEntries {
  constructor(private http: HttpClient) {}
  private url(address: EntryAddress): URL {
    if (![address.datastore, address.key, address.scope].every(x => typeof x === 'string' && x.length > 0)) throw new AppError('ARGUMENT_ERROR', 'DataStore, key and scope must be non-empty.');
    const url = new URL(`https://apis.roblox.com/datastores/v1/universes/${id(address.universeId)}/standard-datastores/datastore/entries/entry`);
    url.search = new URLSearchParams({ datastoreName: address.datastore, entryKey: address.key, scope: address.scope }).toString();
    return url;
  }
  async get(address: EntryAddress): Promise<EntrySnapshot | null> {
    let response: RawResponse;
    try { response = await this.http.request<RawResponse>(this.url(address).toString(), { auth: true, rawResponse: true }); }
    catch (error) { if (error instanceof AppError && error.httpStatus === 404) return null; throw error; }
    if (response.status === 204) return null;
    try { JSON.parse(response.text); } catch { throw new AppError('INVALID_RESPONSE', 'DataStore value is not valid JSON.'); }
    const version = response.headers['roblox-entry-version'];
    if (!version) throw new AppError('INVALID_RESPONSE', 'DataStore response is missing its version.');
    return { raw: response.text, version, attributes: response.headers['roblox-entry-attributes'] ?? '{}', userIds: response.headers['roblox-entry-userids'] ?? '[]' };
  }
  async listVersions(address: EntryAddress, limit = 10): Promise<EntryVersion[]> {
    this.url(address);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('ARGUMENT_ERROR', 'Version limit must be an integer from 1 to 100.');
    const versions: EntryVersion[] = [];
    let cursor: string | undefined;
    while (versions.length < limit) {
      const url = new URL(`https://apis.roblox.com/datastores/v1/universes/${id(address.universeId)}/standard-datastores/datastore/entries/entry/versions`);
      url.search = new URLSearchParams({ datastoreName: address.datastore, entryKey: address.key, scope: address.scope,
        sortOrder: 'Descending', limit: String(Math.min(10, limit - versions.length)), ...(cursor ? { cursor } : {}) }).toString();
      const response = await this.http.request<{ versions?: unknown; nextPageCursor?: unknown }>(url.toString(), { auth: true });
      if (!response || !Array.isArray(response.versions)) throw new AppError('INVALID_RESPONSE', 'Invalid DataStore versions response.');
      for (const row of response.versions) {
        if (!row || typeof row !== 'object') throw new AppError('INVALID_RESPONSE', 'Invalid DataStore version.');
        const value = row as Record<string, unknown>;
        if (typeof value.version !== 'string' || typeof value.deleted !== 'boolean' || typeof value.contentLength !== 'number'
          || typeof value.createdTime !== 'string' || typeof value.objectCreatedTime !== 'string') throw new AppError('INVALID_RESPONSE', 'Invalid DataStore version.');
        versions.push({ version: value.version, deleted: value.deleted, contentLength: value.contentLength,
          createdTime: value.createdTime, objectCreatedTime: value.objectCreatedTime });
      }
      if (typeof response.nextPageCursor !== 'string' || !response.nextPageCursor || response.versions.length === 0) break;
      cursor = response.nextPageCursor;
    }
    return versions.slice(0, limit);
  }
  async getVersion(address: EntryAddress, version: string): Promise<EntryRevision | null> {
    this.url(address);
    if (!version || version.length > 256 || /[\x00-\x1f\x7f]/.test(version)) throw new AppError('ARGUMENT_ERROR', 'Invalid DataStore version ID.');
    const segments = [address.datastore, address.scope, `${address.key}@${version}`].map(encodeURIComponent);
    const url = `https://apis.roblox.com/cloud/v2/universes/${id(address.universeId)}/data-stores/${segments[0]}/scopes/${segments[1]}/entries/${segments[2]}`;
    let response: unknown;
    try { response = await this.http.request(url, { auth: true }); }
    catch (error) { if (error instanceof AppError && error.httpStatus === 404) return null; throw error; }
    if (!response || typeof response !== 'object') throw new AppError('INVALID_RESPONSE', 'Invalid DataStore revision response.');
    const value = response as Record<string, unknown>;
    if (typeof value.revisionId !== 'string' || typeof value.revisionCreateTime !== 'string' || typeof value.createTime !== 'string'
      || !('value' in value) || !Array.isArray(value.users)) throw new AppError('INVALID_RESPONSE', 'Invalid DataStore revision response.');
    if (!value.users.every(user => typeof user === 'string')) throw new AppError('INVALID_RESPONSE', 'Invalid DataStore revision users.');
    return { version: value.revisionId, createdTime: value.revisionCreateTime, objectCreatedTime: value.createTime,
      value: value.value, attributes: value.attributes ?? {}, users: value.users as string[] };
  }
  async clear(target: EntryAddress, backupDirectory: string, options: ClearEntryOptions = {}) {
    const previous = await this.get(target);
    const receipt = { target, previousVersion: previous?.version ?? null, bytes: previous ? Buffer.byteLength(previous.raw) : 0 };
    if (!previous) return { ...receipt, outcome: 'missing' as const, verified: true, backupPath: null };
    if (options.requireReleasedProfile) {
      const profile = JSON.parse(previous.raw);
      if (profile?.MetaData?.ActiveSession != null || profile?.MetaData?.ForceLoadSession != null) {
        throw new AppError('ARGUMENT_ERROR', 'Profile has an active or force-load session. Release the player profile before clearing.');
      }
    }
    if (options.dryRun) return { ...receipt, outcome: 'would-clear' as const, verified: false, backupPath: null };
    const backupPath = join(backupDirectory, `${Date.now()}-${randomUUID()}.json`);
    try {
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await writeFile(backupPath, JSON.stringify({ schemaVersion: 1, operation: 'clear', createdAt: new Date().toISOString(), target, targetSnapshot: previous }, null, 2), { flag: 'wx', mode: 0o600 });
    } catch { throw new AppError('STORAGE_ERROR', 'Cannot save DataStore backup; no delete attempted.'); }
    // DELETE has no matchVersion parameter. Recheck before deleting, but callers must prevent concurrent saves.
    const current = await this.get(target);
    if (!current || current.version !== previous.version || current.raw !== previous.raw
      || current.attributes !== previous.attributes || current.userIds !== previous.userIds) {
      throw new AppError('ARGUMENT_ERROR', `Entry changed after backup; no delete attempted. Backup: ${backupPath}.`);
    }
    try {
      await this.http.request(this.url(target).toString(), { auth: true, method: 'DELETE', rawResponse: true });
      if (await this.get(target)) throw new AppError('INVALID_RESPONSE', 'Target still exists after deletion; it may have been recreated by a game server.');
      return { ...receipt, outcome: 'cleared' as const, verified: true, backupPath };
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError('NETWORK_ERROR', 'Deletion failed.');
      throw new AppError(failure.code, `${failure.message} Backup: ${backupPath}. A delete may have occurred; inspect target before retrying.`, failure.httpStatus);
    }
  }
  async copy(source: EntryAddress, target: EntryAddress, backupDirectory: string, options: { userIds?: string } = {}) {
    this.url(source); this.url(target);
    if (source.universeId === target.universeId && source.datastore === target.datastore && source.scope === target.scope && source.key === target.key) throw new AppError('ARGUMENT_ERROR', 'Source and target must differ.');
    const value = await this.get(source);
    if (!value) throw new AppError('ARGUMENT_ERROR', 'Source DataStore entry does not exist.');
    const previous = await this.get(target);
    const backupPath = join(backupDirectory, `${Date.now()}-${randomUUID()}.json`);
    try {
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await writeFile(backupPath, JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), source, target, sourceSnapshot: value, targetSnapshot: previous }, null, 2), { flag: 'wx', mode: 0o600 });
    } catch { throw new AppError('STORAGE_ERROR', 'Cannot save DataStore backup; no write attempted.'); }
    const url = this.url(target);
    url.searchParams.set(previous ? 'matchVersion' : 'exclusiveCreate', previous ? previous.version : 'true');
    try {
      await this.http.request(url.toString(), { auth: true, rawBody: value.raw, headers: {
        'content-md5': createHash('md5').update(value.raw).digest('base64'),
        'roblox-entry-attributes': value.attributes, 'roblox-entry-userids': options.userIds ?? value.userIds,
      } });
      const actual = await this.get(target);
      if (!actual || actual.raw !== value.raw) throw new AppError('INVALID_RESPONSE', 'Target readback does not exactly match source bytes.');
      return { source, target, sourceVersion: value.version, targetVersion: actual.version, bytes: Buffer.byteLength(value.raw), sha256: createHash('sha256').update(value.raw).digest('hex'), verified: true, backupPath };
    } catch (error) {
      if (error instanceof AppError) throw new AppError(error.code, `${error.message} Backup: ${backupPath}. A write may have occurred; inspect target before retrying.`, error.httpStatus);
      throw error;
    }
  }
}
