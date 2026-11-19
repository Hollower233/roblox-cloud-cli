import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../core/errors.js';

export const STOCK_EXE = 'RobloxStudioBeta.exe';
export const INTERNAL_EXE = 'RobloxStudioBeta_INTERNAL.exe';
export const STUDIO_PROCESS_NAMES = ['RobloxStudioBeta', 'RobloxStudioBeta_INTERNAL'] as const;

/** cmp byte ptr [rip+disp32], 0 / je fail — the Internal helper prologue. */
function isInternalHelper(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes[0] === 0x80 && bytes[1] === 0x3d && bytes[6] === 0x00 && bytes[7] === 0x74;
}
/** mov al,1 / nop*5 / ret — always return Internal=true. */
const PATCHED = Buffer.from('b0019090909090c3', 'hex');

export interface PeSection {
  name: string;
  virtualAddress: number;
  rawOffset: number;
  rawSize: number;
}
export interface StudioPe {
  imageBase: bigint;
  sections: PeSection[];
}
export interface InternalPatchPlan {
  markerRva: number;
  functionRva: number;
  fileOffset: number;
  originalBytes: string;
  patchedBytes: string;
}
export interface InternalPatchInspection {
  ok: boolean;
  reason?: string;
  markerOffset?: number;
  markerRva?: number;
  leaOffset?: number;
  callOffset?: number;
  helperOffset?: number;
  helperBytes?: string;
  helperLooksKnown?: boolean;
  plan?: InternalPatchPlan;
}
export interface EnsureInternalResult {
  stock: string;
  executable: string;
  reused: boolean;
  sourceSha256: string;
  outputSha256: string;
  plan: InternalPatchPlan;
}

export function parsePe32Plus(data: Buffer): StudioPe {
  if (data.length < 0x40) throw new AppError('STUDIO_PATCH_FAILED', 'Studio executable is too small to be a PE image.');
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 >= data.length || data.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new AppError('STUDIO_PATCH_FAILED', 'Studio executable is not a PE image.');
  const sectionCount = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (data.readUInt16LE(opt) !== 0x20b) throw new AppError('STUDIO_PATCH_FAILED', 'Studio executable is not PE32+.');
  const imageBase = data.readBigUInt64LE(opt + 24);
  const secOff = opt + optionalSize;
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const o = secOff + i * 40;
    if (o + 40 > data.length) throw new AppError('STUDIO_PATCH_FAILED', 'Studio PE section table is truncated.');
    sections.push({
      name: data.toString('ascii', o, o + 8).replace(/\0.*$/, ''),
      virtualAddress: data.readUInt32LE(o + 12),
      rawSize: data.readUInt32LE(o + 16),
      rawOffset: data.readUInt32LE(o + 20),
    });
  }
  return { imageBase, sections };
}

function fileOffsetToVa(pe: StudioPe, offset: number): bigint | undefined {
  for (const section of pe.sections) {
    if (offset >= section.rawOffset && offset < section.rawOffset + section.rawSize) {
      return pe.imageBase + BigInt(section.virtualAddress + (offset - section.rawOffset));
    }
  }
}

function vaToFileOffset(pe: StudioPe, va: bigint): number | undefined {
  const rva = Number(va - pe.imageBase);
  for (const section of pe.sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + section.rawSize) {
      return section.rawOffset + (rva - section.virtualAddress);
    }
  }
}

function readDisp32(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

/** Decode a RIP-relative E8 call; returns the callee VA. */
function callTarget(data: Buffer, pe: StudioPe, callOffset: number): bigint | undefined {
  if (data[callOffset] !== 0xe8 || callOffset + 5 > data.length) return;
  const va = fileOffsetToVa(pe, callOffset);
  if (va === undefined) return;
  return va + 5n + BigInt(readDisp32(data, callOffset + 1));
}

/**
 * Locate the Internal-permission helper used by the `[Internal]` window title.
 * The helper is eight bytes: cmp [flag],0 / je fail.
 */
export function inspectInternalPatch(data: Buffer): InternalPatchInspection {
  let pe: StudioPe;
  try { pe = parsePe32Plus(data); }
  catch (error) {
    if (error instanceof AppError && error.code === 'STUDIO_PATCH_FAILED') return { ok: false, reason: error.message };
    throw error;
  }
  const marker = data.indexOf(Buffer.from('[Internal]'));
  if (marker < 0) return { ok: false, reason: 'Could not find the [Internal] window-title marker.' };
  const markerVa = fileOffsetToVa(pe, marker);
  if (markerVa === undefined) return { ok: false, reason: 'The [Internal] marker is outside a mapped PE section.', markerOffset: marker };

  const text = pe.sections.find(s => s.name === '.text');
  if (!text) return { ok: false, reason: 'Studio PE has no .text section.', markerOffset: marker, markerRva: Number(markerVa - pe.imageBase) };
  const textEnd = text.rawOffset + text.rawSize;

  let leaOffset = -1;
  for (let i = text.rawOffset; i + 7 <= textEnd; i++) {
    if (data[i] !== 0x48 || data[i + 1] !== 0x8d) continue;
    const modrm = data[i + 2] ?? 0;
    if ((modrm & 0xc7) !== 0x05) continue; // RIP-relative lea r64,[rip+disp32]
    const disp = readDisp32(data, i + 3);
    const va = fileOffsetToVa(pe, i);
    if (va === undefined) continue;
    if (va + 7n + BigInt(disp) === markerVa) { leaOffset = i; break; }
  }
  if (leaOffset < 0) return { ok: false, reason: 'Could not find a RIP-relative load of the [Internal] marker.', markerOffset: marker, markerRva: Number(markerVa - pe.imageBase) };

  let callOffset = -1;
  let helperOffset: number | undefined;
  let helperBytes: string | undefined;
  for (let i = leaOffset - 5; i >= Math.max(text.rawOffset, leaOffset - 32); i--) {
    if (data[i] !== 0xe8) continue;
    const target = callTarget(data, pe, i);
    if (target === undefined) continue;
    const fnOff = vaToFileOffset(pe, target);
    if (fnOff === undefined || fnOff + 8 > data.length) continue;
    const bytes = data.subarray(fnOff, fnOff + 8);
    helperOffset = fnOff;
    helperBytes = bytes.toString('hex');
    if (isInternalHelper(bytes)) { callOffset = i; break; }
  }
  if (callOffset < 0) {
    return {
      ok: false,
      reason: 'Could not find the Internal permission helper ahead of the [Internal] title.',
      markerOffset: marker,
      markerRva: Number(markerVa - pe.imageBase),
      leaOffset,
      ...(helperOffset !== undefined ? { helperOffset } : {}),
      ...(helperBytes ? { helperBytes, helperLooksKnown: isInternalHelper(Buffer.from(helperBytes, 'hex')) } : {}),
    };
  }

  const functionVa = callTarget(data, pe, callOffset)!;
  const fileOffset = vaToFileOffset(pe, functionVa)!;
  const originalBytes = data.subarray(fileOffset, fileOffset + 8);
  const plan: InternalPatchPlan = {
    markerRva: Number(markerVa - pe.imageBase),
    functionRva: Number(functionVa - pe.imageBase),
    fileOffset,
    originalBytes: originalBytes.toString('hex'),
    patchedBytes: PATCHED.toString('hex'),
  };
  return {
    ok: true,
    markerOffset: marker,
    markerRva: plan.markerRva,
    leaOffset,
    callOffset,
    helperOffset: fileOffset,
    helperBytes: plan.originalBytes,
    helperLooksKnown: isInternalHelper(originalBytes),
    plan,
  };
}

export function planInternalPatch(data: Buffer): InternalPatchPlan {
  const inspection = inspectInternalPatch(data);
  if (!inspection.ok || !inspection.plan) throw new AppError('STUDIO_PATCH_FAILED', inspection.reason ?? 'Could not locate the Internal permission helper.');
  return inspection.plan;
}

export function applyInternalPatch(data: Buffer, plan = planInternalPatch(data)): Buffer {
  const current = data.subarray(plan.fileOffset, plan.fileOffset + 8);
  if (current.equals(PATCHED)) return data;
  if (!isInternalHelper(current)) {
    throw new AppError('STUDIO_PATCH_FAILED', `Internal helper bytes were ${current.toString('hex')}; expected cmp [rip],0 / je.`);
  }
  const out = Buffer.from(data);
  PATCHED.copy(out, plan.fileOffset);
  return out;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function internalPathFor(stock: string): string {
  return join(dirname(stock), INTERNAL_EXE);
}

export async function ensureInternalStudio(stock: string): Promise<EnsureInternalResult> {
  if (!stock.toLowerCase().endsWith(STOCK_EXE.toLowerCase())) {
    throw new AppError('STUDIO_PATCH_FAILED', `Refusing to patch ${stock}; expected ${STOCK_EXE}.`);
  }
  const source = await readFile(stock);
  const sourceSha256 = sha256(source);
  const plan = planInternalPatch(source);
  const patched = applyInternalPatch(source, plan);
  const outputSha256 = sha256(patched);
  const output = internalPathFor(stock);
  try {
    const existing = await readFile(output);
    if (sha256(existing) === outputSha256) {
      return { stock, executable: output, reused: true, sourceSha256, outputSha256, plan };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tmp = `${output}.${process.pid}.tmp`;
  await writeFile(tmp, patched);
  try { await rename(tmp, output); }
  catch {
    await copyFile(tmp, output);
    await unlink(tmp).catch(() => undefined);
  }
  return { stock, executable: output, reused: false, sourceSha256, outputSha256, plan };
}

export async function enableElevatedCapabilities(localAppData: string): Promise<string | undefined> {
  const root = join(localAppData, 'Roblox', 'AssistantSettings');
  let names: string[];
  try { names = await readdir(root); } catch { return; }
  const files = (await Promise.all(names.filter(n => n.endsWith('.json') && !n.endsWith('.rbx-backup')).map(async name => {
    const path = join(root, name);
    try { return { path, mtimeMs: (await stat(path)).mtimeMs }; } catch { return; }
  }))).filter((row): row is { path: string; mtimeMs: number } => Boolean(row)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = files[0];
  if (!latest) return;
  const backup = `${latest.path}.rbx-backup`;
  try { await stat(backup); } catch { await copyFile(latest.path, backup); }
  const settings = JSON.parse(await readFile(latest.path, 'utf8')) as Record<string, unknown>;
  if (settings.UseElevatedCapabilities === true) return latest.path;
  settings.UseElevatedCapabilities = true;
  await writeFile(latest.path, `${JSON.stringify(settings, null, 2)}\n`);
  return latest.path;
}

export async function recordPatchReceipt(home: string, result: EnsureInternalResult): Promise<void> {
  const dir = join(home, 'studio-internal');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'latest.json'), `${JSON.stringify({
    stock: result.stock,
    executable: result.executable,
    reused: result.reused,
    sourceSha256: result.sourceSha256,
    outputSha256: result.outputSha256,
    plan: result.plan,
    patchedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}
