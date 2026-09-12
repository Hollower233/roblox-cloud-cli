import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';

// Windows DPAPI binds encrypted key material to the current OS user. Plaintext is
// sent on stdin, never in process arguments, logs, config files, or shell history.
async function protect(value: string, decrypt: boolean): Promise<string> {
  if (process.platform !== 'win32') throw new AppError('CREDENTIAL_STORE_UNAVAILABLE', 'Persistent key storage currently supports Windows. Set ROBLOX_API_KEY on other platforms.');
  const setup = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $s=[Console]::In.ReadToEnd(); ";
  const script = setup + (decrypt
    ? "$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($b))"
    : "$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($b))");
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let result = ''; const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { result += chunk; });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new AppError('CREDENTIAL_STORE_UNAVAILABLE', 'Windows credential encryption is unavailable.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && result.trim() ? resolve(result.trim()) : reject(new AppError('CREDENTIAL_STORE_UNAVAILABLE', 'Cannot access the Windows encrypted credential.')); });
    child.stdin.end(value);
  });
}
export function validateKey(value: string): string {
  const key = value.trim();
  if (!key || /\s/.test(key)) throw new AppError('AUTH_INVALID', 'Expected a non-empty API key without whitespace.');
  return key;
}
export class CredentialStore {
  constructor(private home: string) {}
  async get(): Promise<string> {
    if (process.env.ROBLOX_API_KEY !== undefined) return validateKey(process.env.ROBLOX_API_KEY);
    try { return validateKey(await protect(await readFile(join(this.home, 'credential.dpapi'), 'utf8'), true)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('AUTH_REQUIRED', 'Run rbx auth set or set ROBLOX_API_KEY.');
      if (e instanceof AppError) throw e;
      throw new AppError('STORAGE_ERROR', 'Cannot read the credential file.');
    }
  }
  async set(key: string): Promise<void> {
    const encrypted = await protect(validateKey(key), false);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = join(this.home, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }); await rename(temporary, join(this.home, 'credential.dpapi')); }
    catch { throw new AppError('STORAGE_ERROR', 'Cannot save the encrypted credential.'); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async clear(): Promise<void> { await rm(join(this.home, 'credential.dpapi'), { force: true }); }
}
