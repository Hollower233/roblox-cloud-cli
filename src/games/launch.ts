import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, id } from '../core/errors.js';

const exec = promisify(execFile);

export async function launchRobloxPlayer(input: string): Promise<{ placeId: string; status: 'launch_requested' }> {
  const placeId = id(input);
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Roblox Player launch is currently supported on Windows.');
  try {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath 'roblox://placeId=${placeId}' -ErrorAction Stop`], { windowsHide: true });
  } catch {
    throw new AppError('PLAYER_LAUNCH_FAILED', `Could not open Roblox Player. Open https://www.roblox.com/games/${placeId} in your browser and click Play.`);
  }
  return { placeId, status: 'launch_requested' };
}
