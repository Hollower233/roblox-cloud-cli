import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface CacheProcess { name: string; pid: number }
export interface AssetCacheOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  processes?: () => Promise<CacheProcess[]>;
}
export interface CacheTargetResult { path: string; status: 'deleted' | 'absent' | 'failed' | 'remaining'; code?: string }
export interface AssetCacheResult {
  status: 'success' | 'blocked' | 'partial';
  code: string;
  actionRequired?: 'close_studio' | 'close_player';
  processes: CacheProcess[];
  targets: CacheTargetResult[];
}

async function processes(): Promise<CacheProcess[]> {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $items = @(Get-Process | Where-Object { $_.ProcessName -in @('RobloxStudioBeta','RobloxStudio','RobloxPlayerBeta','RobloxPlayer') } | ForEach-Object { @{ name = $_.ProcessName; pid = $_.Id } }); ConvertTo-Json -InputObject $items -Compress"],
  { windowsHide: true, timeout: 15000 });
  const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!Array.isArray(value) || !value.every(p => typeof p.name === 'string' && Number.isInteger(p.pid))) throw new Error('Invalid process response');
  return value;
}

function code(error: unknown): string { return (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'; }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
}

/** Fixed Windows asset-cache allowlist. Never prompts or terminates processes. */
export async function clearAssetCache(options: AssetCacheOptions = {}): Promise<AssetCacheResult> {
  const blocked = (reason: string): AssetCacheResult => ({ status: 'blocked', code: reason, processes: [], targets: [] });
  if ((options.platform ?? process.platform) !== 'win32') return blocked('UNSUPPORTED_PLATFORM');
  const env = options.env ?? process.env;
  if (!env.LOCALAPPDATA || !env.TEMP || !isAbsolute(env.LOCALAPPDATA) || !isAbsolute(env.TEMP)) return blocked('CACHE_PATH_UNAVAILABLE');
  let running: CacheProcess[];
  try { running = await (options.processes ?? processes)(); } catch { return blocked('PROCESS_CHECK_FAILED'); }
  const studio = running.some(p => /^RobloxStudio(?:Beta)?$/i.test(p.name));
  const player = running.some(p => /^RobloxPlayer(?:Beta)?$/i.test(p.name));
  if (studio || player) return { status: 'blocked', code: studio ? 'STUDIO_RUNNING' : 'PLAYER_RUNNING', actionRequired: studio ? 'close_studio' : 'close_player', processes: running, targets: [] };
  const root = join(env.LOCALAPPDATA, 'Roblox'), temp = join(env.TEMP, 'Roblox');
  // Check parent links before any deletion; do not follow a redirected Roblox root.
  try {
    for (const path of [env.LOCALAPPDATA, env.TEMP, root, temp]) {
      if (await exists(path) && (await lstat(path)).isSymbolicLink()) return blocked('CACHE_PATH_LINKED');
    }
  } catch { return blocked('CACHE_PATH_CHECK_FAILED'); }
  const paths = [
    ...['rbx-storage', 'rbx-storage-sc', 'rbx-storage.db', 'rbx-storage.db-wal', 'rbx-storage.db-shm'].map(n => join(root, n)),
    ...['sounds', 'http', 'http-wob'].map(n => join(temp, n)),
  ];
  const targets: CacheTargetResult[] = [];
  for (const path of paths) {
    try {
      if (!await exists(path)) { targets.push({ path, status: 'absent' }); continue; }
      if ((await lstat(path)).isSymbolicLink()) { targets.push({ path, status: 'failed', code: 'CACHE_PATH_LINKED' }); continue; }
      await rm(path, { recursive: true, force: true });
      targets.push({ path, status: 'deleted' });
    } catch (error) { targets.push({ path, status: 'failed', code: code(error) }); }
  }
  for (const target of targets) {
    if (target.status === 'failed') continue;
    try { if (await exists(target.path)) target.status = 'remaining'; }
    catch (error) { target.status = 'failed'; target.code = code(error); }
  }
  const partial = targets.some(t => t.status === 'failed' || t.status === 'remaining');
  return { status: partial ? 'partial' : 'success', code: partial ? 'CACHE_CLEAR_INCOMPLETE' : 'CACHE_CLEARED', processes: [], targets };
}
