import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, parse } from 'node:path';
import { AppError } from '../core/errors.js';
import type { Warning } from '../universes/models.js';

export const MAX_ICON_BYTES = 20 * 1024 * 1024;
export const RECOMMENDED_ICON_SIZE = 512;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const UNITS: Record<string, number> = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
};

export interface IconImage { format: 'png' | 'jpeg'; width: number; height: number }
export interface IconFrame extends IconImage { label: string; file: string; path: string; offsetMs: number; sha256: string; bytes: number }
export interface PlannedFrame extends IconFrame { fireAt: number }
export interface CountdownPlan { targetMs: number; plannedAt: number; nodes: PlannedFrame[]; skipped: IconFrame[] }

/** Parses `now`/`0` or unit sequences such as `3h`, `1h30m`, `30mins`, `24hrs`; returns null when unrecognized. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value === 'now' || value === '0') return 0;
  if (!/^(?:\d+[a-z]+)+$/.test(value)) return null;
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)([a-z]+)/g)) {
    const size = UNITS[unit!];
    if (size === undefined) return null;
    total += Number(amount) * size;
  }
  return Number.isSafeInteger(total) ? total : null;
}
export function requireDuration(text: string, name: string): number {
  const value = parseDuration(text);
  if (value === null || value <= 0) throw new AppError('ARGUMENT_ERROR', `${name} must be a positive duration such as 3h, 90m or 1h30m.`);
  return value;
}

/** Accepts local `YYYY-MM-DD HH:MM[:SS]` or ISO-8601 with an explicit `Z`/offset. */
export function parseTargetTime(text: string): number {
  const value = text.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [year, month, day, hour, minute, second] = local.slice(1).map(x => Number(x ?? 0)) as [number, number, number, number, number, number];
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute) return date.getTime();
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  throw new AppError('ARGUMENT_ERROR', 'Target time must be "YYYY-MM-DD HH:MM[:SS]" (local time) or ISO-8601 with a timezone.');
}

/** Reads the real format and dimensions from PNG/JPEG headers, ignoring the file extension. */
export function imageInfo(data: Buffer): IconImage | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && data.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (i + 8 >= data.length) return null;
      return { format: 'jpeg', height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Validates every image in a folder; all problems are reported together before any upload. */
export async function scanIconFolder(folder: string): Promise<{ frames: IconFrame[]; warnings: Warning[] }> {
  let names: string[];
  try { names = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name); }
  catch { throw new AppError('ARGUMENT_ERROR', `Cannot read icon folder: ${folder}`); }
  const frames: IconFrame[] = [], problems: string[] = [], warnings: Warning[] = [];
  for (const file of names.sort()) {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const label = parse(file).name, offsetMs = parseDuration(label);
    if (offsetMs === null) { problems.push(`${file}: file name is not a countdown offset (e.g. 3h, 30mins, now)`); continue; }
    const path = join(folder, file), data = await readFile(path);
    if (data.length > MAX_ICON_BYTES) { problems.push(`${file}: larger than 20 MB`); continue; }
    const image = imageInfo(data);
    if (!image) { problems.push(`${file}: not a valid PNG or JPEG image`); continue; }
    if (image.width !== image.height) { problems.push(`${file}: icon must be square, got ${image.width}x${image.height}`); continue; }
    if (image.width < RECOMMENDED_ICON_SIZE) warnings.push({ code: 'ICON_SMALL', resource: file, message: `${image.width}x${image.height} is below ${RECOMMENDED_ICON_SIZE}x${RECOMMENDED_ICON_SIZE} and may look blurry.` });
    frames.push({ label, file, path, offsetMs, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, ...image });
  }
  const seen = new Map<number, string>();
  for (const frame of frames) {
    const other = seen.get(frame.offsetMs);
    if (other) problems.push(`${other} and ${frame.file}: same countdown offset`);
    else seen.set(frame.offsetMs, frame.file);
  }
  if (problems.length) throw new AppError('ARGUMENT_ERROR', `Invalid icon folder: ${problems.join('; ')}`);
  return { frames: frames.sort((a, b) => b.offsetMs - a.offsetMs), warnings };
}

/** Nodes are frames whose offset fits in the time left when the plan was fixed; each fires exactly at target - offset. */
export function planCountdown(frames: IconFrame[], targetMs: number, plannedAt: number): CountdownPlan {
  if (targetMs <= plannedAt) throw new AppError('ARGUMENT_ERROR', 'Target time is not in the future.');
  if (!frames.some(frame => frame.offsetMs === 0)) throw new AppError('ARGUMENT_ERROR', 'Icon folder needs a now image (now.png).');
  const remaining = targetMs - plannedAt;
  const nodes = frames.filter(frame => frame.offsetMs <= remaining).sort((a, b) => b.offsetMs - a.offsetMs).map(frame => ({ ...frame, fireAt: targetMs - frame.offsetMs }));
  if (!nodes.some(frame => frame.offsetMs > 0)) throw new AppError('ARGUMENT_ERROR', 'Icon folder needs at least one countdown image whose offset fits before the target time.');
  return { targetMs, plannedAt, nodes, skipped: frames.filter(frame => frame.offsetMs > remaining) };
}

/** After a completed node, earlier nodes never run; among due nodes only the latest runs, older ones are missed. */
export function selectPending(nodes: PlannedFrame[], completedOffsets: number[], now: number): { toRun: PlannedFrame[]; missed: PlannedFrame[] } {
  const floor = completedOffsets.length ? Math.min(...completedOffsets) : Infinity;
  const pending = nodes.filter(node => node.offsetMs < floor);
  const due = pending.filter(node => node.fireAt <= now);
  return { toRun: [...due.slice(-1), ...pending.filter(node => node.fireAt > now)], missed: due.slice(0, -1) };
}
