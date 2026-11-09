import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import type { Game, Warning } from '../universes/models.js';
import type { StudioProcess } from './launch.js';

/** Label the Publish dialog's owner dropdown shows for games owned by the signed-in user. */
export const PERSONAL_OWNER_LABEL = 'My Experiences';

export interface PlaceEntry { placeId: string; name: string }
export interface PublishTarget {
  universeId: string; experience: string; ownerType: 'User' | 'Group'; ownerId: string; ownerName: string;
  /** Text expected in the dialog's owner dropdown. */
  ownerLabel: string;
  /** Text typed into the experience search box: the longest plain-text run of the name. */
  search: string;
  /** Absent when publishing as a new place. */
  place?: PlaceEntry;
  newPlace: boolean;
  places: PlaceEntry[];
}
export interface PublishUiArgs {
  pid: number; group: string; experience: string; search: string; place: string | null; newPlace: boolean; dryRun: boolean; debugDir?: string;
}
export interface PublishUiResult {
  ok: boolean; stage: string; message?: string; menuPath?: string; clicked: boolean; elapsedMs: number; button?: string;
}
export interface PlaceVersion { version: number; createTime: string; published: boolean }
export interface PublishVerification {
  state: 'verified' | 'unverified' | 'skipped';
  before?: number; after?: number; createTime?: string; newPlaceId?: string; message?: string;
}
export interface PublishAsResult {
  source: { pid: number; placeId: string; universeId?: string; title?: string };
  target: Omit<PublishTarget, 'places' | 'search'>;
  dryRun: boolean; published: boolean;
  ui: Omit<PublishUiResult, 'ok'>;
  verification: PublishVerification;
}

/** OS and network seams so the flow can be tested offline. */
export interface PublishAsSystem {
  runUi(args: PublishUiArgs, progress: (line: string) => void): Promise<PublishUiResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Same normalization as the UI script: case/space/punctuation/emoji-insensitive, OCR-confusable glyphs folded. */
export function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').replace(/[l1|]/g, 'i').replace(/0/g, 'o');
}
/** Longest run of letters/digits/spaces, so emoji or brackets the search box may not match are not typed. */
export function searchTerm(name: string): string {
  const runs = name.match(/[\p{L}\p{N}][\p{L}\p{N} ]*/gu) ?? [];
  const best = runs.map(r => r.trim()).sort((a, b) => b.length - a.length)[0];
  if (!best) throw new AppError('ARGUMENT_ERROR', `Experience name has no searchable text: ${name}.`);
  return best;
}

/** Pick the source edit session: an explicit PID, else the only open one. */
export function pickSession(sessions: StudioProcess[], pid?: string): StudioProcess {
  if (pid) {
    const s = sessions.find(x => String(x.pid) === pid);
    if (!s) throw new AppError('ARGUMENT_ERROR', `No open Studio edit session with pid ${pid}. Run rbx studio list.`);
    return s;
  }
  if (sessions.length === 1) return sessions[0]!;
  if (!sessions.length) throw new AppError('STUDIO_NOT_FOUND', 'No open Studio edit session. Open one with rbx studio open.');
  throw new AppError('ARGUMENT_ERROR', `Several Studio edit sessions are open; pass --pid: ${sessions.map(s => `${s.pid} (place ${s.placeId})`).join(', ')}.`);
}

/** Resolve the destination game from the local catalog by Universe ID or exact name. */
export function resolvePublishGame(games: Game[], value: string): Game {
  const v = value.trim();
  if (!v) throw new AppError('ARGUMENT_ERROR', 'Provide --to <universeId or game name>.');
  if (/^\d+$/.test(v)) {
    const g = games.find(x => x.universeId === id(v));
    if (!g) throw new AppError('ARGUMENT_ERROR', `Universe ${v} is not in the local catalog. Run rbx universe scan or rbx universe add ${v}.`);
    return g;
  }
  const hits = games.filter(g => g.name.trim().toLowerCase() === v.toLowerCase());
  if (hits.length > 1) throw new AppError('ARGUMENT_ERROR', `Ambiguous game name: ${v}. Use one Universe ID: ${hits.map(g => `${g.universeId} (${g.owner.name})`).join(', ')}.`);
  if (!hits[0]) throw new AppError('ARGUMENT_ERROR', `Game not found in local catalog: ${v}. Run rbx universe list, or use a Universe ID.`);
  return hits[0];
}

/**
 * Turn catalog + place directory into the exact labels the Publish dialog shows, refusing targets the dialog
 * cannot tell apart (same-name games under the same owner, same-name places in the game).
 */
export function planPublishTarget(game: Game, games: Game[], places: PlaceEntry[], currentUserId: string, place: { value?: string; newPlace?: boolean }): { target: PublishTarget; warnings: Warning[] } {
  const warnings: Warning[] = [];
  if (Boolean(place.value) === Boolean(place.newPlace)) throw new AppError('ARGUMENT_ERROR', 'Provide exactly one of --place <placeId or name> or --new.');
  if (game.owner.type === 'User' && game.owner.id !== currentUserId) {
    throw new AppError('ARGUMENT_ERROR', `Universe ${game.universeId} belongs to another user (${game.owner.name}); Publish As can only list your own and your groups' games.`);
  }
  if (game.permissions && !game.permissions.canManage) warnings.push({ code: 'PUBLISH_PERMISSION_UNKNOWN', message: 'Catalog says this account cannot manage the game; Studio may not list it.', resource: game.universeId });
  const experience = game.name.trim(), norm = normalizeLabel(experience);
  if (!norm) throw new AppError('ARGUMENT_ERROR', `Experience name cannot be recognized on screen: ${game.name}.`);
  const twins = games.filter(g => g.universeId !== game.universeId && g.owner.type === game.owner.type && g.owner.id === game.owner.id && normalizeLabel(g.name) === norm);
  if (twins.length) {
    throw new AppError('ARGUMENT_ERROR', `The Publish dialog cannot tell ${game.universeId} apart from ${twins.map(g => g.universeId).join(', ')}: same name "${experience}" under ${game.owner.name}. Rename one first.`);
  }
  if (game.owner.type === 'User') warnings.push({ code: 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE', message: 'Personal private games are not in the catalog, so a same-name private game would only be caught on screen.', resource: game.universeId });
  let chosen: PlaceEntry | undefined;
  if (place.value) {
    const v = place.value.trim();
    chosen = /^\d+$/.test(v) ? places.find(p => p.placeId === v) : undefined;
    if (!chosen && !/^\d+$/.test(v)) {
      const hits = places.filter(p => p.name.trim().toLowerCase() === v.toLowerCase());
      if (hits.length > 1) throw new AppError('ARGUMENT_ERROR', `Ambiguous place name: ${v}. Places: ${hits.map(p => p.placeId).join(', ')}; rename one first.`);
      chosen = hits[0];
    }
    if (!chosen) throw new AppError('ARGUMENT_ERROR', `Place ${v} is not in universe ${game.universeId}: ${places.map(p => `${p.placeId} ${p.name}`).join(', ')}.`);
    const pn = normalizeLabel(chosen.name);
    if (!pn) throw new AppError('ARGUMENT_ERROR', `Place name cannot be recognized on screen: ${chosen.name}.`);
    const dup = places.filter(p => p.placeId !== chosen!.placeId && normalizeLabel(p.name) === pn);
    if (dup.length) throw new AppError('ARGUMENT_ERROR', `The Publish dialog cannot tell place ${chosen.placeId} apart from ${dup.map(p => p.placeId).join(', ')}: same name "${chosen.name}". Rename one first.`);
  }
  const ownerLabel = game.owner.type === 'User' ? PERSONAL_OWNER_LABEL : game.owner.name;
  return {
    target: {
      universeId: game.universeId, experience, ownerType: game.owner.type, ownerId: game.owner.id, ownerName: game.owner.name, ownerLabel,
      search: searchTerm(experience), ...(chosen ? { place: chosen } : {}), newPlace: Boolean(place.newPlace), places,
    },
    warnings,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid response.');
  return value as Record<string, unknown>;
}
/** Public place directory with names (no key). */
export async function placeEntries(http: HttpClient, universeId: string): Promise<PlaceEntry[]> {
  id(universeId);
  const out: PlaceEntry[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const u = new URL(`https://develop.roblox.com/v1/universes/${universeId}/places`);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const page = record(await http.request(u.toString()));
    if (!Array.isArray(page.data)) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Place list.');
    for (const row of page.data) {
      const r = record(row), pid = String(r.id);
      if (!/^[1-9]\d*$/.test(pid) || typeof r.name !== 'string') throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Place entry.');
      out.push({ placeId: pid, name: r.name });
    }
    const next = page.nextPageCursor;
    if (next != null && (typeof next !== 'string' || !next || seen.has(next))) throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid or repeated Place cursor.');
    cursor = next == null ? undefined : next as string;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}
/** Latest saved version of a place asset (Assets API, scope asset:read). */
export async function latestPlaceVersion(http: HttpClient, placeId: string): Promise<PlaceVersion | null> {
  const page = record(await http.request(`https://apis.roblox.com/assets/v1/assets/${id(placeId)}/versions?maxPageSize=1`, { auth: true }));
  const row = Array.isArray(page.assetVersions) ? page.assetVersions[0] : undefined;
  if (row === undefined) return null;
  const r = record(row), m = typeof r.path === 'string' ? /\/versions\/(\d+)$/.exec(r.path) : null;
  if (!m || typeof r.createTime !== 'string') throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid asset version.');
  return { version: Number(m[1]), createTime: r.createTime, published: r.published === true };
}

export interface PublishAsOptions {
  dryRun?: boolean; debugDir?: string; verifyTimeoutMs?: number; pollMs?: number;
  /** Authenticated client for version checks; omitted means verification is skipped. */
  versions?: HttpClient; signal?: AbortSignal; progress?: (message: string) => void;
}

/** Drive File > Publish As in the given Studio session, then confirm through the Assets / place directory APIs. */
export async function publishAs(system: PublishAsSystem, http: HttpClient, session: StudioProcess, target: PublishTarget, options: PublishAsOptions = {}): Promise<{ result: PublishAsResult; warnings: Warning[] }> {
  const warnings: Warning[] = [], dryRun = Boolean(options.dryRun), progress = options.progress ?? (() => undefined);
  let before: PlaceVersion | null | undefined;
  if (!dryRun && target.place && options.versions) {
    try { before = await latestPlaceVersion(options.versions, target.place.placeId); }
    catch (error) { warnings.push({ code: 'PUBLISH_VERIFY_UNAVAILABLE', message: `Cannot read place versions before publishing: ${error instanceof Error ? error.message : 'unknown error'}`, resource: target.place.placeId }); }
  }
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
  const ui = await system.runUi({
    pid: session.pid, group: target.ownerLabel, experience: target.experience, search: target.search,
    place: target.place?.name ?? null, newPlace: target.newPlace, dryRun, ...(options.debugDir ? { debugDir: options.debugDir } : {}),
  }, progress);
  const { ok, ...uiInfo } = ui;
  const base = {
    source: { pid: session.pid, placeId: session.placeId, ...(session.universeId ? { universeId: session.universeId } : {}), ...(session.title ? { title: session.title } : {}) },
    target: (({ places: _p, search: _s, ...t }) => t)(target), dryRun, ui: uiInfo,
  };
  if (!ok && !ui.clicked) throw new AppError('STUDIO_UI_ERROR', `Publish As stopped at ${ui.stage} before publishing: ${ui.message ?? 'unknown error'}`);
  if (dryRun) return { result: { ...base, published: false, verification: { state: 'skipped', message: 'Dry run: dialog closed before Overwrite/Create.' } }, warnings };

  // The click happened (or succeeded): confirm with the APIs; a failed UI read after the click is only a hint.
  const verification = await verify(system, http, target, before, options);
  if (!ok && verification.state !== 'verified') {
    throw new AppError('STUDIO_UI_ERROR', `Publish was clicked but the result is unknown (${ui.stage}: ${ui.message ?? 'no message'}); no new version was seen. Check the place before retrying.`);
  }
  if (!ok) warnings.push({ code: 'PUBLISH_UI_RESULT_UNREAD', message: `Studio reported ${ui.message ?? 'an error'}, but a new place version exists.`, resource: target.place?.placeId ?? verification.newPlaceId });
  if (verification.state !== 'verified') warnings.push({ code: 'PUBLISH_UNVERIFIED', message: verification.message ?? 'Studio reported success but the API did not confirm it.', resource: target.place?.placeId ?? target.universeId });
  return { result: { ...base, published: true, verification }, warnings };
}

async function verify(system: PublishAsSystem, http: HttpClient, target: PublishTarget, before: PlaceVersion | null | undefined, options: PublishAsOptions): Promise<PublishVerification> {
  const timeout = options.verifyTimeoutMs ?? 30_000, poll = options.pollMs ?? 3_000, started = system.now();
  if (target.newPlace) {
    const known = new Set(target.places.map(p => p.placeId));
    for (;;) {
      try {
        const fresh = (await placeEntries(http, target.universeId)).filter(p => !known.has(p.placeId));
        if (fresh.length === 1) return { state: 'verified', newPlaceId: fresh[0]!.placeId };
        if (fresh.length > 1) return { state: 'unverified', message: `Several new places appeared: ${fresh.map(p => p.placeId).join(', ')}.` };
      } catch { /* retry until timeout */ }
      if (system.now() - started >= timeout) return { state: 'unverified', message: 'No new place appeared in the place directory yet.' };
      await system.sleep(poll);
    }
  }
  if (!options.versions || before === undefined) return { state: 'unverified', message: 'Place versions are unavailable (needs an API key with asset:read).' };
  for (;;) {
    try {
      const now = await latestPlaceVersion(options.versions, target.place!.placeId);
      if (now && now.version > (before?.version ?? 0)) {
        return { state: 'verified', ...(before ? { before: before.version } : {}), after: now.version, createTime: now.createTime };
      }
    } catch { /* retry until timeout */ }
    if (system.now() - started >= timeout) return { state: 'unverified', ...(before ? { before: before.version } : {}), message: 'No new place version appeared yet.' };
    await system.sleep(poll);
  }
}

/** Locate the bundled UI script next to this module (dist/studio or src/studio). */
export function publishScriptPath(): string {
  const path = fileURLToPath(new URL('./publish-as.ps1', import.meta.url));
  if (!existsSync(path)) throw new AppError('STUDIO_NOT_FOUND', `Bundled publish-as.ps1 is missing: ${path}.`);
  return path;
}

/** Real Windows implementation: runs the bundled PowerShell UI Automation / OCR script. */
export function windowsPublishAsSystem(timeoutMs = 420_000): PublishAsSystem {
  return {
    runUi(args, progress) {
      const script = publishScriptPath();
      const payload = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
      return new Promise((resolvePromise, reject) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ArgsB64', payload],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
            const line = stdout.split(/\r?\n/).reverse().find(l => l.startsWith('@@RESULT '));
            if (line) {
              try { resolvePromise(JSON.parse(line.slice(9)) as PublishUiResult); return; } catch { /* fall through */ }
            }
            reject(new AppError(error?.killed ? 'TIMEOUT' : 'STUDIO_UI_ERROR', error?.killed ? 'Publish As UI script timed out; the publish state is unknown.' : 'Publish As UI script ended without a result.'));
          });
        let buffer = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
          for (const l of lines) if (l.trim()) progress(l);
        });
      });
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
