import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';

export interface EntryAddress { universeId: string; datastore: string; key: string; scope: string }
export interface EntrySnapshot { raw: string; version: string; attributes: string; userIds: string }
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
  async copy(source: EntryAddress, target: EntryAddress, backupDirectory: string) {
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
        'roblox-entry-attributes': value.attributes, 'roblox-entry-userids': value.userIds,
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
