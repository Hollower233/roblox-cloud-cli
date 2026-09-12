import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { AppError, id } from '../core/errors.js';
import type { Catalog } from '../universes/models.js';

export interface Config { schemaVersion: 1; currentUserId?: string; accounts: Record<string, { manualIds: string[] }> }
export function defaultHome(): string { return process.env.RBX_HOME ?? join(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? homedir() : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'roblox-cloud-cli'); }
function fsCode(e: unknown): string | undefined { return (e as NodeJS.ErrnoException)?.code; }
export class LocalStore {
  constructor(public home: string = defaultHome()) {}
  private async read(name: string): Promise<any | null> {
    try { return JSON.parse(await readFile(join(this.home, name), 'utf8')); }
    catch (e) { if (fsCode(e) === 'ENOENT') return null; throw new AppError('STORAGE_ERROR', `Cannot read ${name}; the file may be invalid.`); }
  }
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = join(this.home, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.home, name));
    } catch { throw new AppError('STORAGE_ERROR', `Cannot save ${name}.`); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const path = join(this.home, '.write.lock');
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (e) { if (fsCode(e) === 'EEXIST') throw new AppError('STORAGE_LOCKED', 'Another operation holds .write.lock. If its process has exited, remove that lock file and retry.'); throw new AppError('STORAGE_ERROR', 'Cannot lock local storage.'); }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action(); }
    finally { await file.close(); await rm(path, { force: true }); }
  }
  async config(): Promise<Config> {
    const c = await this.read('config.json');
    if (c === null) return { schemaVersion: 1, accounts: {} };
    if (c.schemaVersion !== 1) throw new AppError('CACHE_VERSION', 'Unsupported config version.');
    if (!c.accounts || typeof c.accounts !== 'object' || Array.isArray(c.accounts)) throw new AppError('STORAGE_ERROR', 'Invalid account config.');
    try {
      if (c.currentUserId) id(c.currentUserId);
      for (const [userId, account] of Object.entries(c.accounts)) {
        id(userId);
        if (!account || typeof account !== 'object' || !Array.isArray((account as any).manualIds)) throw new Error();
        for (const value of (account as any).manualIds) id(value);
      }
    } catch { throw new AppError('STORAGE_ERROR', 'Invalid account config.'); }
    return c;
  }
  saveConfig(config: Config): Promise<void> { return this.write('config.json', config); }
  async catalog(userId: string): Promise<Catalog | null> {
    const c = await this.read(`catalog-${id(userId)}.json`);
    if (c === null) return null;
    if (c.schemaVersion !== 1) throw new AppError('CACHE_VERSION', 'Unsupported catalog version; use a compatible CLI before updating this cache.');
    if (c.userId !== userId || !Array.isArray(c.games) || !Array.isArray(c.warnings) || typeof c.coverage !== 'string') throw new AppError('STORAGE_ERROR', 'Invalid catalog.');
    for (const game of c.games) {
      if (!game || typeof game.universeId !== 'string' || typeof game.name !== 'string' || !game.owner || !['User', 'Group'].includes(game.owner.type) || typeof game.owner.name !== 'string' || !Array.isArray(game.errors) || !['seen', 'stale', 'not-seen'].includes(game.discoveryState)) throw new AppError('STORAGE_ERROR', 'Invalid game in catalog.');
    }
    return c;
  }
  saveCatalog(catalog: Catalog): Promise<void> { return this.write(`catalog-${id(catalog.userId)}.json`, catalog); }
}
