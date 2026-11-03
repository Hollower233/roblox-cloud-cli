import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, id } from '../core/errors.js';

/** Shared with legacy countdowns; action locks are brief so manual commands can interrupt a worker. */
export async function lockIcon(home: string, universeId: string, worker = false): Promise<() => Promise<void>> {
  const directory = join(home, 'icon-countdown', 'locks');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${id(universeId)}${worker ? '.worker' : ''}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid })); } finally { await file.close(); }
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppError('STORAGE_ERROR', 'Cannot acquire icon task lock.');
      let pid: number | undefined;
      try { pid = JSON.parse(await readFile(path, 'utf8')).pid; } catch { /* An incomplete lock must not be stolen. */ }
      let alive = true;
      if (Number.isSafeInteger(pid) && pid! > 0) { try { process.kill(pid!, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
      if (!alive && attempt === 0) { await rm(path, { force: true }); continue; }
      throw new AppError('STORAGE_LOCKED', 'Another icon command is running for this universe; retry shortly.');
    }
  }
  throw new AppError('STORAGE_LOCKED', 'Cannot acquire icon task lock.');
}
