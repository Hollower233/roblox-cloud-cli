import { execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import type { Game } from '../universes/models.js';

/** One running Studio edit session, parsed from its process command line. */
export interface StudioProcess { pid: number; placeId: string; universeId?: string; title?: string }
export interface StudioTarget { placeId: string; universeId: string; name?: string }
export interface OpenResult extends StudioTarget { pid: number; alreadyOpen: boolean; ready: boolean; title?: string; executable?: string; elapsedMs: number }

/** OS seams so the launcher can be tested offline. */
export interface StudioSystem {
  platform: NodeJS.Platform;
  localAppData?: string;
  /** Version directories containing RobloxStudioBeta.exe, with that file's mtime. */
  studioBuilds(versionsDir: string): Promise<{ executable: string; mtimeMs: number }[]>;
  /** Raw processes named RobloxStudioBeta.exe. */
  processes(): Promise<{ pid: number; commandLine: string; title: string }[]>;
  launch(executable: string, args: string[]): Promise<number>;
  focus(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const EXE = 'RobloxStudioBeta.exe';
function argValue(commandLine: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)--?${name}\\s+"?([^\\s"]+)`, 'i').exec(commandLine)?.[1];
}
/** Only edit sessions count; Team Test servers/clients share the place ID but are not the editor. */
export function parseStudioProcess(row: { pid: number; commandLine: string; title: string }): StudioProcess | null {
  if (argValue(row.commandLine, 'task')?.toLowerCase() !== 'editplace') return null;
  const placeId = argValue(row.commandLine, 'placeId');
  if (!placeId || !/^\d+$/.test(placeId)) return null;
  const universeId = argValue(row.commandLine, 'universeId');
  return { pid: row.pid, placeId, ...(universeId && /^\d+$/.test(universeId) ? { universeId } : {}), ...(row.title ? { title: row.title } : {}) };
}
/** The editor window title becomes "<place> - Roblox Studio" once the place has loaded. */
export function isReadyTitle(title: string | undefined): boolean { return Boolean(title && / - Roblox Studio$/.test(title)); }

function requireWindows(system: StudioSystem): void {
  if (system.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Opening Roblox Studio is only supported on Windows.');
}
export async function findStudioExecutable(system: StudioSystem): Promise<string> {
  requireWindows(system);
  if (!system.localAppData) throw new AppError('STUDIO_NOT_FOUND', 'LOCALAPPDATA is not set.');
  const builds = await system.studioBuilds(join(system.localAppData, 'Roblox', 'Versions'));
  const latest = builds.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) throw new AppError('STUDIO_NOT_FOUND', `${EXE} was not found under %LOCALAPPDATA%\\Roblox\\Versions.`);
  return latest.executable;
}
export async function listStudioSessions(system: StudioSystem): Promise<StudioProcess[]> {
  requireWindows(system);
  return (await system.processes()).map(parseStudioProcess).filter((p): p is StudioProcess => p !== null);
}

/**
 * Resolve a game name, Universe ID or (with `place`) Place ID to a Studio target.
 * Prefers the local catalog; otherwise uses public develop/universe endpoints that also answer for private games.
 */
export async function resolveStudioTarget(http: HttpClient, input: { game?: string; place?: string }, games: Pick<Game, 'universeId' | 'name' | 'rootPlaceId'>[] = []): Promise<StudioTarget> {
  if (input.place) {
    const placeId = id(input.place);
    const known = games.find(g => g.rootPlaceId === placeId);
    if (known) return { placeId, universeId: known.universeId, name: known.name };
    const d = await http.request(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`) as { universeId?: unknown } | null;
    const universeId = d && (typeof d.universeId === 'number' || typeof d.universeId === 'string') ? String(d.universeId) : '';
    if (!/^[1-9]\d*$/.test(universeId)) throw new AppError('INVALID_RESPONSE', `Cannot resolve the universe of place ${placeId}.`);
    return { placeId, universeId };
  }
  const value = (input.game ?? '').trim();
  if (!value) throw new AppError('ARGUMENT_ERROR', 'Provide a game name, a Universe ID, or --place <placeId>.');
  let game: Pick<Game, 'universeId' | 'name' | 'rootPlaceId'> | undefined;
  if (/^\d+$/.test(value)) game = games.find(g => g.universeId === id(value)) ?? { universeId: value, name: '' };
  else {
    const matches = games.filter(g => g.name.toLowerCase() === value.toLowerCase());
    if (matches.length > 1) throw new AppError('ARGUMENT_ERROR', `Ambiguous game name: ${value}. Use one Universe ID: ${matches.map(g => g.universeId).join(', ')}.`);
    game = matches[0];
    if (!game) throw new AppError('ARGUMENT_ERROR', `Game not found in local catalog: ${value}. Run universe scan/add, or use a Universe ID.`);
  }
  if (game.rootPlaceId) return { placeId: game.rootPlaceId, universeId: game.universeId, ...(game.name ? { name: game.name } : {}) };
  const d = await http.request(`https://develop.roblox.com/v1/universes/${game.universeId}`) as { rootPlaceId?: unknown; name?: unknown } | null;
  const placeId = d && (typeof d.rootPlaceId === 'number' || typeof d.rootPlaceId === 'string') ? String(d.rootPlaceId) : '';
  if (!/^[1-9]\d*$/.test(placeId)) throw new AppError('INVALID_RESPONSE', `Cannot resolve the root place of universe ${game.universeId}.`);
  const name = game.name || (typeof d?.name === 'string' ? d.name : '');
  return { placeId, universeId: game.universeId, ...(name ? { name } : {}) };
}

export interface OpenOptions { wait?: boolean; timeoutMs?: number; pollMs?: number; signal?: AbortSignal; progress?: (message: string) => void }
/** Open the place for editing, reusing an existing edit session of the same place. */
export async function openStudio(system: StudioSystem, target: StudioTarget, options: OpenOptions = {}): Promise<OpenResult> {
  requireWindows(system);
  const started = system.now(), wait = options.wait ?? true, timeoutMs = options.timeoutMs ?? 120_000, pollMs = options.pollMs ?? 2_000;
  const existing = (await listStudioSessions(system)).find(p => p.placeId === target.placeId);
  if (existing) {
    await system.focus(existing.pid).catch(() => undefined);
    return { ...target, pid: existing.pid, alreadyOpen: true, ready: isReadyTitle(existing.title), ...(existing.title ? { title: existing.title } : {}), elapsedMs: system.now() - started };
  }
  const executable = await findStudioExecutable(system);
  let pid = await system.launch(executable, ['-task', 'EditPlace', '-placeId', target.placeId, '-universeId', target.universeId]);
  const result = (ready: boolean, title?: string): OpenResult => ({ ...target, pid, alreadyOpen: false, ready, ...(title ? { title } : {}), executable, elapsedMs: system.now() - started });
  if (!wait) return result(false);
  options.progress?.(`Waiting for Studio to load place ${target.placeId}`);
  while (system.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
    await system.sleep(pollMs);
    // The launched process may hand off to another one, so match by place rather than PID.
    const session = (await listStudioSessions(system)).find(p => p.placeId === target.placeId);
    if (session) { pid = session.pid; if (isReadyTitle(session.title)) return result(true, session.title); }
  }
  throw new AppError('TIMEOUT', `Studio started (pid ${pid}) but place ${target.placeId} did not finish loading within ${Math.round(timeoutMs / 1000)}s.`);
}

function powershell(script: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new AppError('STUDIO_NOT_FOUND', 'Cannot query Windows processes.')); else resolvePromise(stdout);
    });
  });
}
/** Real Windows implementation. */
export function windowsStudioSystem(): StudioSystem {
  return {
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
    async studioBuilds(versionsDir) {
      let names: string[];
      try { names = await readdir(versionsDir); } catch { return []; }
      const builds: { executable: string; mtimeMs: number }[] = [];
      for (const name of names) {
        const executable = join(versionsDir, name, EXE);
        try { builds.push({ executable, mtimeMs: (await stat(executable)).mtimeMs }); } catch { /* not a Studio build */ }
      }
      return builds;
    },
    async processes() {
      const out = await powershell(`$t=@{}; Get-Process -Name RobloxStudioBeta -ErrorAction SilentlyContinue | ForEach-Object { $t[$_.Id]=$_.MainWindowTitle }; @(Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; commandLine=[string]$_.CommandLine; title=[string]$t[[int]$_.ProcessId] } }) | ConvertTo-Json -Compress -Depth 2`);
      const text = out.trim();
      if (!text) return [];
      const parsed = JSON.parse(text) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]).map(row => {
        const r = row as { pid: number; commandLine?: string; title?: string };
        return { pid: r.pid, commandLine: r.commandLine ?? '', title: r.title ?? '' };
      });
    },
    async launch(executable, args) {
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
      const pid = await new Promise<number>((resolvePromise, reject) => {
        child.once('error', () => reject(new AppError('STUDIO_NOT_FOUND', `Cannot start ${executable}.`)));
        child.once('spawn', () => resolvePromise(child.pid ?? 0));
      });
      child.unref();
      return pid;
    },
    async focus(pid) { await powershell(`$null=(New-Object -ComObject WScript.Shell).AppActivate(${Math.trunc(pid)})`); },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
