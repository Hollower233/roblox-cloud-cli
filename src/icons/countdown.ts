import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import type { LocalStore } from '../storage/store.js';
import type { Warning } from '../universes/models.js';
import { planCountdown, scanIconFolder, selectPending, type IconFrame, type PlannedFrame } from './frames.js';

const ASSETS = 'https://apis.roblox.com/assets/v1';
const DEFAULT_MODERATION_TIMEOUT_MS = 30 * 60_000;
export type ModerationState = 'Reviewing' | 'Approved' | 'Rejected';
export interface IconCreator { type: 'User' | 'Group'; id: string }
export interface CountdownClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export const systemClock: CountdownClock = { now: () => Date.now(), sleep: (ms, signal) => delay(ms, undefined, { signal }).then(() => undefined) };

function object(value: unknown, what: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RESPONSE', `${what} returned an unexpected response.`);
  return value as Record<string, any>;
}
function moderation(asset: Record<string, any>): ModerationState {
  const state = asset.moderationResult?.moderationState;
  return state === 'Approved' || state === 'Rejected' ? state : 'Reviewing';
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function sha256(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex'); }

/** Open Cloud Assets calls used by the countdown: image upload, moderation reads and the root place icon. */
export class IconAssets {
  constructor(private http: HttpClient, private clock: CountdownClock = systemClock, private signal?: AbortSignal) {}
  /** Cloud v2 works for private games; the public games API returns placeholder IDs (0) for them. */
  async rootPlaceId(universeId: string): Promise<string> {
    const universe = object(await this.http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }), 'Universe');
    const cloud = typeof universe.rootPlace === 'string' ? /\/places\/(\d+)$/.exec(universe.rootPlace)?.[1] : undefined;
    if (cloud) return id(cloud);
    const data = object(await this.http.request(`https://games.roblox.com/v1/games?universeIds=${id(universeId)}`), 'Game details');
    const game = Array.isArray(data.data) ? data.data.find((g: any) => String(g?.id) === universeId) : undefined;
    try { return id(String(game?.rootPlaceId)); } catch { throw new AppError('INVALID_RESPONSE', 'Cannot find the root place of this universe.'); }
  }
  async createImage(data: Buffer, format: 'png' | 'jpeg', fileName: string, displayName: string, creator: IconCreator): Promise<{ assetId: string; moderationState: ModerationState }> {
    const form = new FormData();
    form.append('request', JSON.stringify({
      assetType: 'Image', displayName,
      creationContext: { creator: creator.type === 'User' ? { userId: Number(id(creator.id)) } : { groupId: Number(id(creator.id)) } },
    }));
    form.append('fileContent', new Blob([new Uint8Array(data)], { type: format === 'png' ? 'image/png' : 'image/jpeg' }), fileName);
    const asset = await this.operation(await this.http.request(`${ASSETS}/assets`, { auth: true, method: 'POST', form }), 'Image upload');
    let assetId: string;
    try { assetId = id(String(asset.assetId)); } catch { throw new AppError('INVALID_RESPONSE', 'Image upload returned an invalid asset ID.'); }
    return { assetId, moderationState: moderation(asset) };
  }
  /** Returns null when the asset no longer exists. */
  async moderationState(assetId: string): Promise<ModerationState | null> {
    try { return moderation(object(await this.http.request(`${ASSETS}/assets/${id(assetId)}?readMask=moderationResult`, { auth: true }), 'Asset')); }
    catch (error) { if (error instanceof AppError && error.httpStatus === 404) return null; throw error; }
  }
  async placeIcon(placeId: string): Promise<string | null> {
    const asset = object(await this.http.request(`${ASSETS}/assets/${id(placeId)}?readMask=icon`, { auth: true }), 'Place asset');
    return typeof asset.icon === 'string' ? /^assets\/(\d+)$/.exec(asset.icon)?.[1] ?? null : null;
  }
  /** Icon reads are eventually consistent (stale values reappear minutes after a change); require agreeing reads. */
  async stablePlaceIcon(placeId: string, agree = 3, attempts = 9): Promise<string | null> {
    let last: string | null | undefined, streak = 0;
    for (let i = 0; i < attempts; i++) {
      const icon = await this.placeIcon(placeId);
      streak = icon === last ? streak + 1 : 1; last = icon;
      if (streak >= agree) return icon;
    }
    throw new AppError('INVALID_RESPONSE', 'Roblox returned inconsistent icon reads for this place; try again in a minute.');
  }
  /** Two-step flow verified against Roblox: PATCH only the icon reference, never file content. */
  async setPlaceIcon(placeId: string, imageAssetId: string): Promise<void> {
    const form = new FormData();
    form.append('request', JSON.stringify({ assetId: id(placeId), icon: `assets/${id(imageAssetId)}` }));
    await this.operation(await this.http.request(`${ASSETS}/assets/${id(placeId)}?updateMask=icon`, { auth: true, method: 'PATCH', form }), 'Icon update');
  }
  private async operation(start: unknown, action: string, timeoutMs = 120_000): Promise<Record<string, any>> {
    let operation = object(start, action);
    const deadline = this.clock.now() + timeoutMs;
    while (!operation.done) {
      const path = typeof operation.path === 'string' ? operation.path : '';
      if (!/^operations\/[A-Za-z0-9_-]+$/.test(path)) throw new AppError('INVALID_RESPONSE', `${action} returned an invalid operation.`);
      if (this.clock.now() >= deadline) throw new AppError('TIMEOUT', `${action} did not finish in time.`);
      await this.clock.sleep(2000, this.signal);
      operation = object(await this.http.request(`${ASSETS}/${path}`, { auth: true }), action);
    }
    if (operation.error) throw new AppError('HTTP_ERROR', `${action} failed: ${String(operation.error.message ?? operation.error.code ?? 'unknown error').slice(0, 300)}`);
    return operation.response && typeof operation.response === 'object' ? operation.response : {};
  }
}

export interface CountdownOptions {
  universeId: string; folder: string; creator: IconCreator;
  target: { at: number } | { inMs: number };
  moderationTimeoutMs?: number; noCache?: boolean; reset?: boolean;
  /** Switch back to the original icon this long after `now`, unless the icon was changed by someone else meanwhile. */
  restoreAfterMs?: number;
}
export interface CountdownNodeView { label: string; file: string; offsetMs: number; fireAt: string; status: 'done' | 'pending' | 'missed'; assetId?: string }
export type CountdownEvent =
  | { event: 'scanned'; frames: { label: string; file: string; offsetMs: number; width: number; height: number }[]; warnings: Warning[] }
  | { event: 'asset'; label: string; file: string; assetId: string; moderationState: ModerationState; source: 'cache' | 'upload' }
  | { event: 'moderation'; reviewing: string[] }
  | { event: 'planned'; universeId: string; placeId: string; target: string; plannedAt: string; resumed: boolean; originalIconAssetId: string | null; restoreAt: string | null; nodes: CountdownNodeView[]; skipped: string[] }
  | { event: 'waiting'; label: string; file: string; fireAt: string }
  | { event: 'missed'; labels: string[] }
  | { event: 'icon'; label: string; file: string; assetId: string; at: string }
  | { event: 'restore-waiting'; assetId: string; at: string }
  | { event: 'restored'; assetId: string; at: string }
  | { event: 'restore-skipped'; currentIconAssetId: string | null; at: string }
  | { event: 'completed'; target: string; alreadyCompleted: boolean };
export interface CountdownPreview { target: string; plannedAt: string; resumed: boolean; alreadyCompleted: boolean; nodes: CountdownNodeView[]; skipped: string[]; restoreAt: string | null; warnings: Warning[] }
export interface CountdownResult { target: string; alreadyCompleted: boolean; placeId: string; originalIconAssetId: string | null; completed: RunState['completed']; restore: 'restored' | 'skipped' | null }
interface RunState {
  schemaVersion: 1; universeId: string; placeId: string; folder: string; targetMs: number; plannedAt: number;
  originalIconAssetId: string | null; completed: Record<string, { label: string; file: string; assetId: string; at: string }>; finishedAt?: string;
  restoreAfterMs?: number; restore?: { status: 'restored' | 'skipped'; at: string; currentIconAssetId?: string | null };
}
interface CachedAsset { assetId: string; moderationState: ModerationState; file: string; checkedAt: string }
export interface CountdownRuntime {
  clock?: CountdownClock; signal?: AbortSignal;
  onEvent?: (event: CountdownEvent) => void;
  onTick?: (next: { label: string; file: string }, remainingMs: number) => void;
}

function fsCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (fsCode(error) === 'ENOENT') return null; throw new AppError('STORAGE_ERROR', `Cannot read ${path}; the file may be invalid.`); }
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return fsCode(error) === 'EPERM'; } }

/**
 * Pre-uploads every needed icon, waits until all pass moderation, then switches the root place icon exactly
 * at each `target - offset`. Progress lives under `icon-countdown/` so re-running the same command resumes.
 */
export class IconCountdown {
  private clock: CountdownClock;
  constructor(private store: LocalStore, private assets: IconAssets | null, private runtime: CountdownRuntime = {}) { this.clock = runtime.clock ?? systemClock; }
  private path(...parts: string[]): string { return join(this.store.home, 'icon-countdown', ...parts); }
  private async save(relative: string, value: unknown): Promise<void> {
    await mkdir(dirname(join(this.store.home, relative)), { recursive: true, mode: 0o700 });
    await this.store.write(relative, value);
  }
  private emit(event: CountdownEvent): void { this.runtime.onEvent?.(event); }
  private runName(universeId: string, targetMs: number): string { return `icon-countdown/runs/${universeId}-${targetMs}.json`; }
  private anchorName(universeId: string, folder: string): string {
    const key = process.platform === 'win32' ? resolve(folder).toLowerCase() : resolve(folder);
    return `icon-countdown/anchors/${universeId}-${sha256(key).slice(0, 16)}.json`;
  }
  private async readRun(universeId: string, targetMs: number): Promise<RunState | null> {
    const state = await readJson(join(this.store.home, this.runName(universeId, targetMs)));
    if (state === null) return null;
    if (state.schemaVersion !== 1 || state.universeId !== universeId || state.targetMs !== targetMs || !Number.isSafeInteger(state.plannedAt)
      || typeof state.placeId !== 'string' || !state.completed || typeof state.completed !== 'object') throw new AppError('STORAGE_ERROR', 'Invalid icon countdown state file.');
    return state;
  }
  private async locate(options: CountdownOptions, mutate: boolean): Promise<{ state: RunState | null; targetMs: number | null }> {
    if ('at' in options.target) return { state: await this.readRun(options.universeId, options.target.at), targetMs: options.target.at };
    const anchorPath = join(this.store.home, this.anchorName(options.universeId, options.folder));
    const forget = async () => { if (mutate) await rm(anchorPath, { force: true }); return { state: null, targetMs: null }; };
    if (options.reset) return forget();
    const anchor = await readJson(anchorPath);
    if (anchor === null) return { state: null, targetMs: null };
    if (anchor.schemaVersion !== 1 || !Number.isSafeInteger(anchor.targetMs) || !Number.isSafeInteger(anchor.durationMs)) throw new AppError('STORAGE_ERROR', 'Invalid icon countdown anchor file.');
    const state = await this.readRun(options.universeId, anchor.targetMs);
    if (!state || state.finishedAt) return forget();
    if (anchor.durationMs !== options.target.inMs) throw new AppError('ARGUMENT_ERROR', `An unfinished --in countdown for this folder targets ${iso(anchor.targetMs)}; re-run with the same --in to resume, or add --reset to start over.`);
    return { state, targetMs: anchor.targetMs };
  }
  private views(nodes: PlannedFrame[], state: RunState | null, now: number): CountdownNodeView[] {
    const completed = state?.completed ?? {}, { toRun } = selectPending(nodes, Object.keys(completed).map(Number), now);
    return nodes.map(node => {
      const done = completed[String(node.offsetMs)];
      return { label: node.label, file: node.file, offsetMs: node.offsetMs, fireAt: iso(node.fireAt), status: done ? 'done' : toRun.includes(node) ? 'pending' : 'missed', ...(done ? { assetId: done.assetId } : {}) };
    });
  }

  /** Offline plan: reads the folder and local progress only, never calls Roblox or writes files. */
  async preview(options: CountdownOptions): Promise<CountdownPreview> {
    const { frames, warnings } = await scanIconFolder(options.folder);
    const { state, targetMs } = await this.locate(options, false), now = this.clock.now();
    const target = state?.targetMs ?? targetMs ?? now + (options.target as { inMs: number }).inMs;
    if (state?.finishedAt) return { target: iso(target), plannedAt: iso(state.plannedAt), resumed: true, alreadyCompleted: true, nodes: [], skipped: [], restoreAt: null, warnings };
    if (state) this.checkRestoreOption(state, options);
    const plan = planCountdown(frames, target, state?.plannedAt ?? now);
    return { target: iso(target), plannedAt: iso(plan.plannedAt), resumed: Boolean(state), alreadyCompleted: false, nodes: this.views(plan.nodes, state, now), skipped: plan.skipped.map(frame => frame.file), restoreAt: options.restoreAfterMs ? iso(target + options.restoreAfterMs) : null, warnings };
  }
  private checkRestoreOption(state: RunState, options: CountdownOptions): void {
    if ((state.restoreAfterMs ?? 0) !== (options.restoreAfterMs ?? 0)) throw new AppError('ARGUMENT_ERROR', `This unfinished countdown was started ${state.restoreAfterMs ? `with --restore-after ${Math.round(state.restoreAfterMs / 60_000)}m` : 'without --restore-after'}; re-run with the same option to resume.`);
  }

  async run(options: CountdownOptions): Promise<CountdownResult> {
    if (!this.assets) throw new AppError('ARGUMENT_ERROR', 'Running a countdown requires Roblox API access.');
    const assets = this.assets, { frames, warnings } = await scanIconFolder(options.folder);
    this.emit({ event: 'scanned', frames: frames.map(({ label, file, offsetMs, width, height }) => ({ label, file, offsetMs, width, height })), warnings });
    const release = await this.lock(options.universeId);
    try {
      let { state, targetMs } = await this.locate(options, true);
      const resumed = state !== null;
      if (state?.finishedAt) {
        this.emit({ event: 'completed', target: iso(state.targetMs), alreadyCompleted: true });
        return { target: iso(state.targetMs), alreadyCompleted: true, placeId: state.placeId, originalIconAssetId: state.originalIconAssetId, completed: state.completed, restore: state.restore?.status ?? null };
      }
      if (state) this.checkRestoreOption(state, options);
      // Validate early and upload only images that can still be shown; the set only shrinks while moderation waits.
      const started = this.clock.now();
      const provisional = state
        ? planCountdown(frames, state.targetMs, state.plannedAt)
        : planCountdown(frames, targetMs ?? started + (options.target as { inMs: number }).inMs, started);
      const needed = selectPending(provisional.nodes, Object.keys(state?.completed ?? {}).map(Number), started).toRun;
      // The original icon is read before anything is uploaded or switched, so a restore always has the true original.
      const placeId = state?.placeId ?? await assets.rootPlaceId(options.universeId);
      const originalIconAssetId = state ? state.originalIconAssetId : await assets.stablePlaceIcon(placeId);
      if (options.restoreAfterMs && !originalIconAssetId) throw new AppError('ARGUMENT_ERROR', 'This place has no custom icon to restore; remove --restore-after.');
      const assetIds = await this.prepare(needed, options);
      if (!state && options.restoreAfterMs && [...assetIds.values()].includes(originalIconAssetId!)) {
        throw new AppError('ARGUMENT_ERROR', `The current icon (${originalIconAssetId}) is one of the countdown images; set the real icon back before using --restore-after.`);
      }
      if (!state) {
        const plannedAt = this.clock.now();
        const target = 'at' in options.target ? options.target.at : plannedAt + options.target.inMs;
        planCountdown(frames, target, plannedAt);
        state = { schemaVersion: 1, universeId: options.universeId, placeId, folder: resolve(options.folder), targetMs: target, plannedAt, originalIconAssetId, completed: {}, ...(options.restoreAfterMs ? { restoreAfterMs: options.restoreAfterMs } : {}) };
        await this.save(this.runName(options.universeId, target), state);
        if ('inMs' in options.target) await this.save(this.anchorName(options.universeId, options.folder), { schemaVersion: 1, universeId: options.universeId, folder: state.folder, durationMs: options.target.inMs, targetMs: target });
      }
      const run = state, plan = planCountdown(frames, run.targetMs, run.plannedAt);
      this.emit({ event: 'planned', universeId: run.universeId, placeId: run.placeId, target: iso(run.targetMs), plannedAt: iso(run.plannedAt), resumed, originalIconAssetId: run.originalIconAssetId, restoreAt: run.restoreAfterMs ? iso(run.targetMs + run.restoreAfterMs) : null, nodes: this.views(plan.nodes, run, this.clock.now()), skipped: plan.skipped.map(frame => frame.file) });
      let waitingFor: PlannedFrame | undefined;
      for (;;) {
        const now = this.clock.now(), { toRun, missed } = selectPending(plan.nodes, Object.keys(run.completed).map(Number), now), next = toRun[0];
        if (!next) break;
        if (next.fireAt > now) {
          if (waitingFor !== next) { waitingFor = next; this.emit({ event: 'waiting', label: next.label, file: next.file, fireAt: iso(next.fireAt) }); }
          this.runtime.onTick?.(next, next.fireAt - now);
          await this.clock.sleep(Math.min(1000, next.fireAt - now), this.runtime.signal);
          continue;
        }
        if (missed.length) this.emit({ event: 'missed', labels: missed.map(node => node.label) });
        const assetId = assetIds.get(next.sha256);
        if (!assetId) throw new AppError('ARGUMENT_ERROR', `${next.file} was not prepared; run the command again.`);
        await assets.setPlaceIcon(run.placeId, assetId);
        const at = iso(this.clock.now());
        run.completed[String(next.offsetMs)] = { label: next.label, file: next.file, assetId, at };
        await this.save(this.runName(run.universeId, run.targetMs), run);
        this.emit({ event: 'icon', label: next.label, file: next.file, assetId, at });
      }
      if (run.restoreAfterMs && !run.restore) await this.restore(run);
      run.finishedAt = iso(this.clock.now());
      await this.save(this.runName(run.universeId, run.targetMs), run);
      if ('inMs' in options.target) await rm(join(this.store.home, this.anchorName(options.universeId, options.folder)), { force: true });
      this.emit({ event: 'completed', target: iso(run.targetMs), alreadyCompleted: false });
      return { target: iso(run.targetMs), alreadyCompleted: false, placeId: run.placeId, originalIconAssetId: run.originalIconAssetId, completed: run.completed, restore: run.restore?.status ?? null };
    } finally { await release(); }
  }
  private async restore(run: RunState): Promise<void> {
    const assets = this.assets!, original = run.originalIconAssetId!, restoreAt = run.targetMs + run.restoreAfterMs!;
    this.emit({ event: 'restore-waiting', assetId: original, at: iso(restoreAt) });
    for (let now = this.clock.now(); now < restoreAt; now = this.clock.now()) {
      this.runtime.onTick?.({ label: 'restore', file: `原图标 ${original}` }, restoreAt - now);
      await this.clock.sleep(Math.min(1000, restoreAt - now), this.runtime.signal);
    }
    // Only undo our own change. Reads may be stale, so any countdown image (or the original) counts as ours,
    // and the switch is always sent rather than trusting a read that already shows the original.
    const ours = new Set([original, ...Object.values(run.completed).map(done => done.assetId)]);
    const current = await assets.stablePlaceIcon(run.placeId), at = iso(this.clock.now());
    if (current !== null && ours.has(current)) {
      await assets.setPlaceIcon(run.placeId, original);
      run.restore = { status: 'restored', at };
      this.emit({ event: 'restored', assetId: original, at });
    } else {
      run.restore = { status: 'skipped', at, currentIconAssetId: current };
      this.emit({ event: 'restore-skipped', currentIconAssetId: current, at });
    }
    await this.save(this.runName(run.universeId, run.targetMs), run);
  }

  /** Uploads (or reuses cached) images and blocks until every one is approved; any rejection or timeout aborts. */
  private async prepare(frames: IconFrame[], options: CountdownOptions): Promise<Map<string, string>> {
    const assets = this.assets!, creator = options.creator;
    const key = (frame: IconFrame) => `${creator.type}:${creator.id}:${frame.sha256}`;
    const cache: Record<string, CachedAsset> = options.noCache ? {} : (await this.readAssetCache());
    const known = new Map<string, { frame: IconFrame; assetId: string; state: ModerationState }>();
    const remember = async (frame: IconFrame, assetId: string, state: ModerationState, source: 'cache' | 'upload') => {
      known.set(frame.sha256, { frame, assetId, state });
      await this.cacheAsset(key(frame), { assetId, moderationState: state, file: frame.file, checkedAt: iso(this.clock.now()) });
      this.emit({ event: 'asset', label: frame.label, file: frame.file, assetId, moderationState: state, source });
    };
    for (const frame of new Map(frames.map(frame => [frame.sha256, frame])).values()) {
      const cached = cache[key(frame)];
      if (cached?.moderationState === 'Rejected') { await remember(frame, cached.assetId, 'Rejected', 'cache'); continue; }
      const state = cached ? await assets.moderationState(cached.assetId) : null;
      if (cached && state) { await remember(frame, cached.assetId, state, 'cache'); continue; }
      const data = await readFile(frame.path);
      if (sha256(data) !== frame.sha256) throw new AppError('ARGUMENT_ERROR', `${frame.file} changed while preparing; run the command again.`);
      const created = await assets.createImage(data, frame.format, frame.file, `icon-${frame.label}`, creator);
      await remember(frame, created.assetId, created.moderationState, 'upload');
    }
    const timeout = options.moderationTimeoutMs ?? DEFAULT_MODERATION_TIMEOUT_MS, deadline = this.clock.now() + timeout;
    for (;;) {
      const items = [...known.values()], rejected = items.filter(item => item.state === 'Rejected'), reviewing = items.filter(item => item.state === 'Reviewing');
      if (rejected.length) throw new AppError('MODERATION_REJECTED', `Roblox moderation rejected: ${rejected.map(item => item.frame.file).join(', ')}. Replace these images and run again.`);
      if (!reviewing.length) break;
      const now = this.clock.now();
      if (now >= deadline) throw new AppError('MODERATION_TIMEOUT', `Still under review after ${Math.round(timeout / 60_000)} min: ${reviewing.map(item => item.frame.file).join(', ')}. Run again later; uploads are cached.`);
      this.emit({ event: 'moderation', reviewing: reviewing.map(item => item.frame.file) });
      await this.clock.sleep(Math.min(5000, deadline - now), this.runtime.signal);
      for (const item of reviewing) {
        const state = await assets.moderationState(item.assetId);
        if (!state) throw new AppError('INVALID_RESPONSE', `Uploaded image ${item.assetId} for ${item.frame.file} no longer exists; run again with --no-cache.`);
        if (state !== item.state) { item.state = state; await this.cacheAsset(key(item.frame), { assetId: item.assetId, moderationState: state, file: item.frame.file, checkedAt: iso(this.clock.now()) }); }
      }
    }
    return new Map([...known].map(([hash, item]) => [hash, item.assetId]));
  }
  private async readAssetCache(): Promise<Record<string, CachedAsset>> {
    const cache = await readJson(this.path('assets.json'));
    if (cache === null) return {};
    if (cache.schemaVersion !== 1 || !cache.assets || typeof cache.assets !== 'object') throw new AppError('STORAGE_ERROR', 'Invalid icon asset cache.');
    return cache.assets;
  }
  /** Re-reads before writing so concurrent countdowns on other universes keep each other's entries. */
  private async cacheAsset(cacheKey: string, entry: CachedAsset): Promise<void> {
    const assets = await this.readAssetCache().catch(() => ({}));
    await this.save('icon-countdown/assets.json', { schemaVersion: 1, assets: { ...assets, [cacheKey]: entry } });
  }
  private async lock(universeId: string): Promise<() => Promise<void>> {
    const path = this.path('locks', `${id(universeId)}.lock`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: iso(this.clock.now()) })); } finally { await file.close(); }
        return () => rm(path, { force: true });
      } catch (error) {
        if (fsCode(error) !== 'EEXIST') throw new AppError('STORAGE_ERROR', 'Cannot lock the icon countdown.');
        const holder = await readJson(path).catch(() => null);
        // A crashed run leaves its lock behind; take it over once its process is gone.
        if (attempt === 0 && Number.isSafeInteger(holder?.pid) && !pidAlive(holder.pid)) { await rm(path, { force: true }); continue; }
        throw new AppError('STORAGE_LOCKED', `Another icon countdown for universe ${universeId} is running${holder?.pid ? ` (pid ${holder.pid})` : ''}.`);
      }
    }
  }
}
