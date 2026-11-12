import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.js';

/** Locate a bundled Studio UI script next to this module (dist/studio or src/studio), with its shared helpers. */
export function bundledStudioScript(name: string): string {
  for (const file of [name, 'studio-ui.ps1']) {
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
    if (!existsSync(path)) throw new AppError('STUDIO_NOT_FOUND', `Bundled ${file} is missing: ${path}.`);
  }
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

/**
 * Run a bundled PowerShell UI script: arguments go in as base64 JSON, progress lines stream from stderr,
 * and the result is the last `@@RESULT {json}` line on stdout.
 */
export function runStudioUiScript<T>(name: string, args: object, progress: (line: string) => void, timeoutMs: number, label: string): Promise<T> {
  const script = bundledStudioScript(name);
  const payload = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
  return new Promise((resolvePromise, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ArgsB64', payload],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
        const line = stdout.split(/\r?\n/).reverse().find(l => l.startsWith('@@RESULT '));
        if (line) {
          try { resolvePromise(JSON.parse(line.slice(9)) as T); return; } catch { /* fall through */ }
        }
        reject(new AppError(error?.killed ? 'TIMEOUT' : 'STUDIO_UI_ERROR', error?.killed ? `${label} UI script timed out; the result is unknown.` : `${label} UI script ended without a result.`));
      });
    let buffer = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) progress(l);
    });
  });
}
