import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../core/errors.js';
import type { Warning } from '../universes/models.js';
import type { StudioProcess } from './launch.js';
import { bundledStudioScript, runStudioUiScript } from './ui-script.js';

export interface VersionNotes { title: string; details: string }
export interface SaveNotesUiArgs { pid: number; title: string; details: string; dryRun: boolean; debugDir?: string }
export interface SaveNotesUiResult {
  ok: boolean; stage: string; message?: string; menuPath?: string; clicked: boolean; elapsedMs: number;
  /** What OCR read from the fields after typing (diagnostic only; OCR often misses short CJK lines). */
  titleOcr?: string; detailsOcr?: string;
}
export interface SaveNotesResult {
  source: { pid: number; placeId: string; universeId?: string; title?: string };
  notes: VersionNotes;
  dryRun: boolean; saved: boolean;
  ui: Omit<SaveNotesUiResult, 'ok'>;
  /** Local ledger file the save was appended to. */
  ledger?: string;
}
export interface SaveNotesSystem {
  runUi(args: SaveNotesUiArgs, progress: (line: string) => void): Promise<SaveNotesUiResult>;
  now(): number;
}
export interface SaveNotesOptions {
  dryRun?: boolean; debugDir?: string;
  /** Directory for the per-place JSONL ledger; omitted means nothing is recorded. */
  ledgerDirectory?: string;
  signal?: AbortSignal; progress?: (message: string) => void;
}

/**
 * Validate what is typed into the dialog: a one-line non-empty title, optional multi-line details.
 * Control characters other than line breaks are refused because posted Tab/Escape would move focus or close the dialog.
 */
export function normalizeVersionNotes(title: string | undefined, details?: string): VersionNotes {
  const t = (title ?? '').trim();
  if (!t) throw new AppError('ARGUMENT_ERROR', 'Provide --title with the version title.');
  if (/[\r\n]/.test(t)) throw new AppError('ARGUMENT_ERROR', 'The version title must be a single line.');
  const d = (details ?? '').replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t + d)) throw new AppError('ARGUMENT_ERROR', 'Version notes cannot contain tabs or control characters.');
  return { title: t, details: d };
}

/**
 * Drive File > Save to Roblox with Notes in the given Studio session. Success is the UI script's own result
 * (dialog closed after Save); nothing is read back from Roblox.
 */
export async function saveWithNotes(system: SaveNotesSystem, session: StudioProcess, notes: VersionNotes, options: SaveNotesOptions = {}): Promise<{ result: SaveNotesResult; warnings: Warning[] }> {
  const warnings: Warning[] = [], dryRun = Boolean(options.dryRun), progress = options.progress ?? (() => undefined);
  const clean = normalizeVersionNotes(notes.title, notes.details);
  if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
  const ui = await system.runUi({ pid: session.pid, title: clean.title, details: clean.details, dryRun, ...(options.debugDir ? { debugDir: options.debugDir } : {}) }, progress);
  const { ok, ...uiInfo } = ui;
  if (!ok) {
    throw new AppError('STUDIO_UI_ERROR', ui.clicked
      ? `Save was clicked but the dialog did not finish (${ui.stage}: ${ui.message ?? 'no message'}); check the place version history before retrying.`
      : `Save with notes stopped at ${ui.stage} before saving: ${ui.message ?? 'unknown error'}`);
  }
  const base = {
    source: { pid: session.pid, placeId: session.placeId, ...(session.universeId ? { universeId: session.universeId } : {}), ...(session.title ? { title: session.title } : {}) },
    notes: clean, dryRun, ui: uiInfo,
  };
  if (dryRun) return { result: { ...base, saved: false }, warnings };

  let ledger: string | undefined;
  if (options.ledgerDirectory) {
    try { ledger = await appendLedger(options.ledgerDirectory, session, clean, system.now()); }
    catch (error) { warnings.push({ code: 'SAVE_LEDGER_FAILED', message: `Saved, but the local ledger was not written: ${error instanceof Error ? error.message : 'unknown error'}`, resource: session.placeId }); }
  }
  return { result: { ...base, saved: true, ...(ledger ? { ledger } : {}) }, warnings };
}

async function appendLedger(directory: string, session: StudioProcess, notes: VersionNotes, now: number): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${session.placeId}.jsonl`);
  const row = {
    schemaVersion: 1, savedAt: new Date(now).toISOString(), placeId: session.placeId, ...(session.universeId ? { universeId: session.universeId } : {}),
    title: notes.title, details: notes.details,
  };
  await appendFile(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Locate the bundled UI script next to this module (dist/studio or src/studio). */
export function saveNotesScriptPath(): string { return bundledStudioScript('save-notes.ps1'); }

/** Real Windows implementation: runs the bundled PowerShell UI Automation / OCR script. */
export function windowsSaveNotesSystem(timeoutMs = 420_000): SaveNotesSystem {
  return {
    runUi: (args, progress) => runStudioUiScript<SaveNotesUiResult>('save-notes.ps1', args, progress, timeoutMs, 'Save with notes'),
    now: () => Date.now(),
  };
}
