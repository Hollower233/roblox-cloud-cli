import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AppError, errorInfo, id } from '../core/errors.js';
import { LocalStore } from '../storage/store.js';
import { dimensions, sameDeviceConfiguration, StudioDeviceSimulator, type Dimensions, type StudioDeviceState } from './device-simulator.js';
import { listStudioSessions, windowsStudioSystem } from './launch.js';
import { withStudioEditSession } from './mcp.js';

export interface StudioScreenshotOptions {
  placeId: string;
  output: string;
  device?: string;
  signal?: AbortSignal;
}

export interface StudioScreenshotResult {
  placeId: string;
  pid: number;
  path: string;
  deviceId: string;
  deviceName: string;
  orientation: string;
  resolution: Dimensions | null;
  image: Dimensions;
  restored: boolean;
  restoreError?: ReturnType<typeof errorInfo>;
}

const runFile = promisify(execFile);
const requirePackage = createRequire(import.meta.url);

function winappExecutable(): string {
  try {
    const directory = dirname(requirePackage.resolve('@microsoft/winappcli/package.json'));
    const executable = join(directory, 'bin', `win-${process.arch}`, 'winapp.exe');
    if (existsSync(executable)) return executable;
  } catch { /* npm can skip this Windows-only optional dependency. */ }
  throw new AppError('UNSUPPORTED_PLATFORM', 'Studio screenshots require the @microsoft/winappcli optional dependency on Windows x64 or ARM64.');
}

async function studioWindow(pid: number): Promise<string> {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RobloxScreenshotWindow {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
}
'@ -ErrorAction Stop
$studio = Get-Process -Id ${pid} -ErrorAction Stop
$handle = $studio.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { 'missing' }
elseif ([RobloxScreenshotWindow]::IsIconic($handle)) { 'minimized' }
else { $handle.ToInt64() }
`;
  const result = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8_000 }).catch(() => {
    throw new AppError('STUDIO_NOT_FOUND', 'Cannot read the Studio window handle.');
  });
  const hwnd = result.stdout.trim();
  if (hwnd === 'minimized') throw new AppError('STUDIO_NOT_FOUND', 'Restore the minimized Studio window before taking a screenshot.');
  if (!/^[1-9]\d*$/.test(hwnd)) throw new AppError('STUDIO_NOT_FOUND', 'The selected Studio session has no main window.');
  return hwnd;
}

async function captureViewport(executable: string, hwnd: string, pid: number, output: string, signal: AbortSignal): Promise<Dimensions> {
  const { stdout, stderr } = await runFile(executable,
    ['ui', 'screenshot', 'QEngineWidget', '--window', hwnd, '--output', output, '--json'],
    { windowsHide: true, timeout: 12_000, signal, env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1' } },
  ).catch(error => {
    checkCancelled(signal);
    if (error.killed) throw new AppError('TIMEOUT', 'Timed out capturing the Studio game viewport.');
    throw new AppError('INVALID_RESPONSE', 'Could not capture QEngineWidget. Open the game viewport in the selected Studio editor.');
  });
  if (/entirely black|all[- ]black/i.test(stderr)) {
    throw new AppError('INVALID_RESPONSE', 'Windows returned a black frame for the Studio game viewport.');
  }
  let image: unknown;
  try { image = JSON.parse(stdout); } catch { /* Validated below. */ }
  if (!dimensions(image)) throw new AppError('INVALID_RESPONSE', 'Windows did not return a valid Studio viewport image.');
  const receipt = image as Dimensions & { processId?: number; hwnd?: number; elementId?: string };
  if (receipt.processId !== pid || String(receipt.hwnd) !== hwnd || receipt.elementId !== 'QEngineWidget') {
    throw new AppError('INVALID_RESPONSE', 'Windows returned an image for an unexpected window or element.');
  }
  return { width: receipt.width, height: receipt.height };
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED', 'Screenshot cancelled.');
}

function fitsDevice(image: Dimensions, device: StudioDeviceState): boolean {
  if (device.scalingMode !== 'FitToWindow' || !device.resolution) return true;
  const { width, height } = device.resolution;
  const ratio = width / height;
  return Math.abs(image.width - image.height * ratio) <= Math.max(3, image.width * 0.01);
}

/** Takes a screenshot and returns preset captures to Current device. */
export async function captureStudioDevice(
  simulator: Pick<StudioDeviceSimulator, 'read' | 'resolve' | 'select' | 'switchToCurrent'>,
  device: string, signal: AbortSignal,
  capture: () => Promise<Dimensions>,
): Promise<{ state: StudioDeviceState; image: Dimensions; restoreError?: ReturnType<typeof errorInfo> }> {
  checkCancelled(signal);
  const requested = device.toLowerCase() === 'current' ? undefined : await simulator.resolve(device);
  checkCancelled(signal);
  let failure: unknown;
  let restoreError: ReturnType<typeof errorInfo> | undefined;
  let captured: { state: StudioDeviceState; image: Dimensions } | undefined;
  try {
    const state = requested ? await simulator.select(requested) : await simulator.read();
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCancelled(signal);
      const image = await capture();
      if (!sameDeviceConfiguration(await simulator.read(), state)) {
        throw new AppError('INVALID_RESPONSE', 'Studio device settings changed during capture. Retry with a stable viewport.');
      }
      if (!requested || fitsDevice(image, state)) {
        captured = { state, image };
        break;
      }
      if (attempt < 2) await delay(200);
    }
    checkCancelled(signal);
    if (!captured) throw new AppError('INVALID_RESPONSE', 'The captured viewport did not match the selected device aspect ratio.');
  } catch (error) {
    failure = error;
    captured = undefined;
  } finally {
    if (requested) {
      try { await simulator.switchToCurrent(); }
      catch (error) { restoreError = errorInfo(error); }
    }
  }
  if (signal.aborted) failure = new AppError('CANCELLED', 'Screenshot cancelled.');
  if (!captured || failure) {
    if (!restoreError) throw failure;
    const { message } = errorInfo(failure);
    throw new AppError(failure instanceof AppError ? failure.code : 'INVALID_RESPONSE',
      `${message} Could not confirm Current device mode: ${restoreError.message}`);
  }
  return { ...captured, ...(restoreError ? { restoreError } : {}) };
}

export async function screenshotStudio(options: StudioScreenshotOptions): Promise<StudioScreenshotResult> {
  const placeId = id(options.placeId);
  const alias = options.device?.trim() ?? 'i17p';
  const device = alias.toLowerCase() === 'i17p' ? 'iphone_17_pro' : alias;
  const path = resolve(options.output);
  if (!device || extname(path).toLowerCase() !== '.png') throw new AppError('ARGUMENT_ERROR', 'Provide a device name and a PNG output path.');
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Studio viewport screenshots require Windows.');
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new AppError('STUDIO_NOT_FOUND', 'Cannot locate the local Studio installation.');
  const signal = options.signal ?? new AbortController().signal;
  checkCancelled(signal);
  const executable = winappExecutable();
  const outputExists = await lstat(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw new AppError('STORAGE_ERROR', 'Cannot inspect the screenshot output path.');
  });
  if (outputExists) throw new AppError('STORAGE_ERROR', 'Screenshot output already exists. Choose another PNG path.');
  const directory = await mkdtemp(join(dirname(path), '.rbx-screenshot-')).catch(() => {
    throw new AppError('STORAGE_ERROR', 'Cannot write to the screenshot output directory.');
  });
  const stagingFile = join(directory, 'viewport.png');
  try {
    const lock = new LocalStore(join(localAppData, 'Roblox', 'rbx-studio-operations', placeId));
    return await lock.locked(async () => {
      const matches = (await listStudioSessions(windowsStudioSystem())).filter(session => session.placeId === placeId);
      if (matches.length !== 1) throw new AppError('STUDIO_NOT_FOUND', `Expected one Studio edit window for Place ${placeId}, found ${matches.length}.`);
      const { pid } = matches[0]!;
      const hwnd = await studioWindow(pid);
      checkCancelled(signal);
      // Keep MCP available during cleanup when the caller cancels a screenshot.
      const sessionSignal = new AbortController().signal;
      const { state, image, restoreError } = await withStudioEditSession(placeId, sessionSignal, session =>
        captureStudioDevice(new StudioDeviceSimulator(placeId, session.execute), device, signal, async () => {
          await unlink(stagingFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
          return captureViewport(executable, hwnd, pid, stagingFile, signal);
        }),
      );
      await copyFile(stagingFile, path, constants.COPYFILE_EXCL).catch(() => {
        const cleanup = restoreError ? ` Could not confirm Current device mode: ${restoreError.message}` : '';
        throw new AppError('STORAGE_ERROR', `Cannot save the screenshot to the output path.${cleanup}`);
      });
      return {
        placeId, pid, path, deviceId: state.deviceId, deviceName: state.deviceName, orientation: state.orientation,
        resolution: state.resolution, image, restored: !restoreError, ...(restoreError ? { restoreError } : {}),
      };
    });
  } finally {
    await unlink(stagingFile).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
