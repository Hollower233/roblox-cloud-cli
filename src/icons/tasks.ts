import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, id } from '../core/errors.js';
import { downloadAssetImage } from '../assets/download.js';
import type { HttpClient } from '../transport/http-client.js';
import type { LocalStore } from '../storage/store.js';
import { type CountdownClock, type IconAssets, type IconCreator, type ModerationState, systemClock } from './countdown.js';
import { generateIconImages, iconNodes, type GeneratedIcon } from './render.js';
import { lockIcon } from './lock.js';

type Assets = Pick<IconAssets, 'rootPlaceId' | 'stablePlaceIcon' | 'createImage' | 'moderationState' | 'setPlaceIcon'>;
export interface IconSnapshot { placeId: string; originalIconAssetId: string; data: Buffer }
export interface IconTaskFrame extends GeneratedIcon { sha256: string; assetId?: string; moderationState?: ModerationState }
export interface IconTask {
  schemaVersion: 1; taskId: string; universeId: string; placeId: string; originalIconAssetId: string; output: string;
  creator: IconCreator; frames: IconTaskFrame[]; targetMs: number | null; durationMs?: number; restoreAt: number;
  phase: 'preparing' | 'countdown' | 'soon' | 'now' | 'restored'; completed: number[]; createdAt: string;
  nowAt?: string; restoredAt?: string;
}
export interface CreateIconTaskOptions {
  universeId: string; creator: IconCreator; target: { at: number } | { inMs: number }; restoreAt: number; nodes?: string[];
}
export interface IconTaskRuntime {
  clock?: CountdownClock; signal?: AbortSignal; onEvent?: (event: { event: string; [key: string]: unknown }) => void;
  capture?: (universeId: string) => Promise<IconSnapshot>;
}
/** Local status projection; does not query Roblox or change a task. */
export function nextIconTaskEvent(task: IconTask | null, now = Date.now()): { event: 'moderation' | 'icon' | 'restore'; at: string | null; label?: string } | null {
  if (!task || task.phase === 'restored') return null;
  const restore = { event: 'restore' as const, at: new Date(task.restoreAt).toISOString() };
  if (now >= task.restoreAt) return restore;
  if (task.phase === 'preparing') return { event: 'moderation', at: null };
  if (task.phase !== 'countdown' || task.targetMs === null) return restore;
  const pending = task.frames.filter(f => f.offsetMs !== null && !task.completed.includes(f.offsetMs)).sort((a,b) => b.offsetMs! - a.offsetMs!);
  const due = pending.filter(f => task.targetMs! - f.offsetMs! <= now);
  const next = due.at(-1) ?? pending[0];
  return next && task.targetMs - next.offsetMs! < task.restoreAt ? { event: 'icon', at: new Date(task.targetMs - next.offsetMs!).toISOString(), label: next.label } : restore;
}
/** Fetches only through existing read-only SDK operations; the original asset reference is preserved. */
export async function captureCurrentIcon(http: HttpClient, assets: Assets, universeId: string): Promise<IconSnapshot> {
  const placeId = await assets.rootPlaceId(id(universeId)), originalIconAssetId = await assets.stablePlaceIcon(placeId);
  if (!originalIconAssetId) throw new AppError('ARGUMENT_ERROR', 'This game has no custom icon to use and restore.');
  const temporary = await mkdtemp(join(tmpdir(), 'rbx-icon-'));
  try {
    const downloaded = await downloadAssetImage(http, originalIconAssetId, { output: join(temporary, 'original.image') });
    return { placeId, originalIconAssetId, data: await readFile(downloaded.path) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function generateCurrentIcons(http: HttpClient, assets: Assets, universeId: string, output: string, nodes?: string[]) {
  iconNodes(nodes); // Reject invalid nodes before reading credentials/API resources.
  const { data, ...source } = await captureCurrentIcon(http, assets, universeId);
  const generated = await generateIconImages(data, output, nodes);
  await writeFile(join(generated.output, 'source.json'), JSON.stringify({ universeId, ...source, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  return { ...generated, ...source };
}
export class IconTasks {
  private clock: CountdownClock;
  constructor(private store: LocalStore, private assets: Assets | null, private http?: HttpClient, private runtime: IconTaskRuntime = {}) { this.clock = runtime.clock ?? systemClock; }
  private name(universeId: string) { return `icon-countdown/tasks/${id(universeId)}.json`; }
  private api(): Assets { if (!this.assets) throw new AppError('AUTH_REQUIRED', 'This action requires Roblox API access.'); return this.assets; }
  private emit(event: string, data: Record<string, unknown> = {}) { this.runtime.onEvent?.({ event, ...data }); }
  async status(universeId: string): Promise<IconTask | null> {
    let value: IconTask;
    try { value = JSON.parse(await readFile(join(this.store.home, this.name(universeId)), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AppError('STORAGE_ERROR', 'Cannot read icon task.'); }
    if (value.schemaVersion !== 1 || value.universeId !== universeId || typeof value.taskId !== 'string' || !Array.isArray(value.frames)
      || !Array.isArray(value.completed) || !Number.isSafeInteger(value.restoreAt) || (value.targetMs !== null && !Number.isSafeInteger(value.targetMs))
      || !['preparing', 'countdown', 'soon', 'now', 'restored'].includes(value.phase) || typeof value.output !== 'string') throw new AppError('STORAGE_ERROR', 'Invalid icon task file.');
    return value;
  }
  private async save(task: IconTask) { await mkdir(join(this.store.home, 'icon-countdown', 'tasks'), { recursive: true }); await this.store.write(this.name(task.universeId), task); }
  private async required(universeId: string) { const task = await this.status(universeId); if (!task) throw new AppError('ARGUMENT_ERROR', 'No generated icon task exists for this game.'); return task; }
  private async locked<T>(universeId: string, action: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; !release; attempt++) {
      this.runtime.signal?.throwIfAborted();
      try { release = await lockIcon(this.store.home, universeId); }
      catch (e) { if (!(e instanceof AppError) || e.code !== 'STORAGE_LOCKED' || attempt >= 100) throw e; await this.clock.sleep(100, this.runtime.signal); }
    }
    try { return await action(); } finally { await release(); }
  }
  async create(options: CreateIconTaskOptions): Promise<IconTask> {
    id(options.universeId); id(options.creator.id);
    const now = this.clock.now(), duration = 'inMs' in options.target ? options.target.inMs : options.target.at - now;
    if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(options.restoreAt) || options.restoreAt <= now + duration) throw new AppError('ARGUMENT_ERROR', 'Target must be in the future and --restore-at must be after the target.');
    const nodes = iconNodes(options.nodes).filter(node => node.offsetMs !== null && node.offsetMs > 0 && node.offsetMs <= duration).map(node => `${node.offsetMs! / 1000}s`);
    return this.locked(options.universeId, async () => {
      const previous = await this.status(options.universeId);
      if (previous && previous.phase !== 'restored') throw new AppError('ARGUMENT_ERROR', 'An unfinished task exists. Use icon resume, now, or restore.');
      const snapshot = this.runtime.capture ? await this.runtime.capture(options.universeId) : await captureCurrentIcon(this.http!, this.api(), options.universeId);
      const taskId = randomUUID(), output = join(this.store.home, 'icon-countdown', 'generated', taskId);
      const generated = await generateIconImages(snapshot.data, output, nodes);
      const frames: IconTaskFrame[] = await Promise.all(generated.frames.map(async frame => ({ ...frame, sha256: createHash('sha256').update(await readFile(join(output, 'frames', frame.file))).digest('hex') })));
      const task: IconTask = { schemaVersion: 1, taskId, universeId: id(options.universeId), placeId: snapshot.placeId, originalIconAssetId: snapshot.originalIconAssetId, output,
        creator: options.creator, frames, targetMs: 'at' in options.target ? options.target.at : null,
        ...('inMs' in options.target ? { durationMs: options.target.inMs } : {}), restoreAt: options.restoreAt, phase: 'preparing', completed: [], createdAt: new Date(now).toISOString() };
      await this.save(task); this.emit('generated', { taskId, output, count: task.frames.length }); return task;
    });
  }
  private async finishRestore(task: IconTask): Promise<IconTask> {
    if (task.phase === 'restored') return task;
    await this.api().setPlaceIcon(task.placeId, task.originalIconAssetId);
    task.phase = 'restored'; task.restoredAt = new Date(this.clock.now()).toISOString();
    await this.save(task); this.emit('restored', { assetId: task.originalIconAssetId, at: task.restoredAt }); return task;
  }
  /** Manual actions share the short action lock with the worker, and always honor the independent deadline first. */
  async now(universeId: string): Promise<IconTask> {
    return this.locked(universeId, async () => {
      const task = await this.required(universeId);
      if (task.phase === 'restored') throw new AppError('ARGUMENT_ERROR', 'This task is already restored; create a new task first.');
      if (this.clock.now() >= task.restoreAt) return this.finishRestore(task);
      if (task.phase === 'preparing') throw new AppError('ARGUMENT_ERROR', 'Images must all pass moderation before switching NOW. Run icon resume.');
      if (task.phase === 'now') return task;
      const frame = task.frames.find(frame => frame.offsetMs === null);
      if (!frame?.assetId) throw new AppError('STORAGE_ERROR', 'The NOW image is missing.');
      await this.api().setPlaceIcon(task.placeId, frame.assetId);
      task.phase = 'now'; task.nowAt = new Date(this.clock.now()).toISOString(); await this.save(task);
      this.emit('now', { assetId: frame.assetId, at: task.nowAt, restoreAt: new Date(task.restoreAt).toISOString() }); return task;
    });
  }
  async restore(universeId: string): Promise<IconTask> { return this.locked(universeId, async () => this.finishRestore(await this.required(universeId))); }
  /** Performs at most one scheduled change. Restoring always wins over missed nodes or preparation. */
  async step(universeId: string, taskId?: string): Promise<IconTask> {
    return this.locked(universeId, async () => {
      const task = await this.required(universeId);
      if (taskId && task.taskId !== taskId) throw new AppError('ARGUMENT_ERROR', 'The active icon task was replaced; this worker must exit.');
      if (task.phase === 'restored') return task;
      const now = this.clock.now();
      if (now >= task.restoreAt) return this.finishRestore(task);
      if (task.phase !== 'countdown' || task.targetMs === null) return task;
      const pending = task.frames.filter(frame => frame.offsetMs !== null && !task.completed.includes(frame.offsetMs) && task.targetMs! - frame.offsetMs <= now)
        .sort((a, b) => a.offsetMs! - b.offsetMs!);
      const next = pending[0];
      if (!next) return task;
      if (!next.assetId) throw new AppError('STORAGE_ERROR', 'A scheduled image has not been prepared.');
      await this.api().setPlaceIcon(task.placeId, next.assetId);
      task.completed.push(...pending.map(frame => frame.offsetMs!));
      if (next.offsetMs === 0) task.phase = 'soon';
      await this.save(task); this.emit('icon', { label: next.label, assetId: next.assetId, at: new Date(this.clock.now()).toISOString() }); return task;
    });
  }
  private async cachedAsset(task: IconTask, frame: IconTaskFrame): Promise<string | null> {
    const name = this.cacheName(task, frame);
    try {
      const value = JSON.parse(await readFile(join(this.store.home, name), 'utf8'));
      if (value.schemaVersion !== 1 || typeof value.assetId !== 'string') throw new Error('Invalid cache');
      return id(value.assetId);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AppError('STORAGE_ERROR', 'Cannot read generated image cache.'); }
  }
  private cacheName(task: IconTask, frame: IconTaskFrame) { return `icon-countdown/generated-assets/${task.creator.type}-${id(task.creator.id)}-${frame.sha256}.json`; }
  private async prepare(universeId: string, taskId: string, timeoutMs: number): Promise<void> {
    const deadline = this.clock.now() + timeoutMs;
    for (;;) {
      this.runtime.signal?.throwIfAborted();
      const task = await this.step(universeId, taskId);
      if (task.phase !== 'preparing') return;
      let reviewing = false;
      for (const [i, frame] of task.frames.entries()) {
        const updated = await this.locked(universeId, async () => {
          const current = await this.required(universeId);
          if (current.taskId !== taskId) throw new AppError('ARGUMENT_ERROR', 'The active icon task changed.');
          if (current.phase !== 'preparing') return false;
          if (this.clock.now() >= current.restoreAt) { await this.finishRestore(current); return false; }
          const actual = current.frames[i]!;
          if (!actual.assetId) {
            const data = await readFile(join(current.output, 'frames', frame.file));
            if (createHash('sha256').update(data).digest('hex') !== actual.sha256) throw new AppError('ARGUMENT_ERROR', `Generated image was modified: ${frame.file}. Restore this task and create another.`);
            const cached = await this.cachedAsset(current, actual);
            const reuse = cached && await this.api().moderationState(cached);
            if (reuse) actual.assetId = cached;
            else {
              const created = await this.api().createImage(data, 'png', frame.file, `countdown-${frame.label}`, current.creator);
              actual.assetId = created.assetId;
              await mkdir(join(this.store.home, 'icon-countdown', 'generated-assets'), { recursive: true });
              await this.store.write(this.cacheName(current, actual), { schemaVersion: 1, assetId: actual.assetId });
            }
            await this.save(current);
            this.emit(reuse ? 'cached' : 'uploaded', { file: frame.file, assetId: actual.assetId });
          }
          const state = await this.api().moderationState(actual.assetId!);
          if (state && actual.moderationState !== state) { actual.moderationState = state; await this.save(current); }
          if (state === 'Rejected') throw new AppError('MODERATION_REJECTED', `Image rejected: ${frame.file}. Restore this task before starting a new one.`);
          if (!state) throw new AppError('INVALID_RESPONSE', `Image no longer exists: ${frame.file}. Restore this task before starting a new one.`);
          return state !== 'Approved';
        });
        reviewing ||= updated;
      }
      if (!reviewing) {
        await this.locked(universeId, async () => {
          const current = await this.required(universeId);
          if (current.taskId !== taskId) throw new AppError('ARGUMENT_ERROR', 'The active icon task changed.');
          if (current.phase !== 'preparing') return;
          if (this.clock.now() >= current.restoreAt) { await this.finishRestore(current); return; }
          current.targetMs ??= this.clock.now() + current.durationMs!;
          current.phase = 'countdown'; await this.save(current);
          this.emit('approved', { target: new Date(current.targetMs).toISOString(), restoreAt: new Date(current.restoreAt).toISOString() });
        }); return;
      }
      if (this.clock.now() >= deadline) throw new AppError('MODERATION_TIMEOUT', 'Images are still reviewing. Use icon resume later; existing uploads are retained.');
      this.emit('moderation', { message: 'Waiting for image approval' });
      await this.clock.sleep(Math.min(5000, deadline - this.clock.now(), Math.max(1, task.restoreAt - this.clock.now())), this.runtime.signal);
    }
  }
  /** Foreground scheduler. A separate process may execute NOW/restore while this worker waits. */
  async resume(universeId: string, moderationTimeoutMs = 30 * 60_000): Promise<IconTask> {
    if (!Number.isSafeInteger(moderationTimeoutMs) || moderationTimeoutMs <= 0) throw new AppError('ARGUMENT_ERROR', 'Moderation timeout must be positive.');
    const release = await lockIcon(this.store.home, universeId, true);
    try {
      const initial = await this.required(universeId);
      await this.prepare(universeId, initial.taskId, moderationTimeoutMs);
      for (;;) {
        this.runtime.signal?.throwIfAborted();
        let task: IconTask;
        try { task = await this.step(universeId, initial.taskId); }
        catch (e) { if (!(e instanceof AppError) || e.code !== 'STORAGE_LOCKED') throw e; await this.clock.sleep(250, this.runtime.signal); continue; }
        if (task.phase === 'restored') return task;
        await this.clock.sleep(Math.min(1000, Math.max(1, task.restoreAt - this.clock.now())), this.runtime.signal);
      }
    } finally { await release(); }
  }
}
