import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';

// Windows DPAPI binds encrypted key material to the current OS user. Plaintext is
// sent on stdin, never in process arguments, logs, config files, or shell history.
async function protect(value: string, decrypt: boolean): Promise<string> {
  if (process.platform !== 'win32') throw new AppError('CREDENTIAL_STORE_UNAVAILABLE', 'Persistent credential storage currently supports Windows.');
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
export function validateRobloxCookie(value: string): string {
  const cookie = value.trim().replace(/^\.ROBLOSECURITY=/, '');
  if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(cookie)) {
    throw new AppError('AUTH_INVALID', 'Expected one Roblox .ROBLOSECURITY cookie value.');
  }
  return cookie;
}
export interface CredentialSlot { file: string; env?: string; setCommand: string; validate?: (value: string) => string }
export const robloxCredential: CredentialSlot = { file: 'credential.dpapi', env: 'ROBLOX_API_KEY', setCommand: 'rbx auth set' };
export const deepseekCredential: CredentialSlot = { file: 'deepseek.dpapi', env: 'DEEPSEEK_API_KEY', setCommand: 'rbx deepseek auth set' };
export const robloxCookieCredential: CredentialSlot = {
  file: 'cookie.dpapi', setCommand: 'rbx auth cookie set', validate: validateRobloxCookie,
};
export class CredentialStore {
  constructor(private home: string, private slot: CredentialSlot = robloxCredential) {}
  async get(): Promise<string> {
    const validate = this.slot.validate ?? validateKey;
    const env = this.slot.env === undefined ? undefined : process.env[this.slot.env];
    if (env !== undefined) return validate(env);
    try { return validate(await protect(await readFile(join(this.home, this.slot.file), 'utf8'), true)); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const alternative = this.slot.env ? ` or set ${this.slot.env}` : '';
        throw new AppError('AUTH_REQUIRED', `Run ${this.slot.setCommand}${alternative}.`);
      }
      if (e instanceof AppError) throw e;
      throw new AppError('STORAGE_ERROR', 'Cannot read the credential file.');
    }
  }
  async set(key: string): Promise<void> {
    const encrypted = await protect((this.slot.validate ?? validateKey)(key), false);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = join(this.home, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }); await rename(temporary, join(this.home, this.slot.file)); }
    catch { throw new AppError('STORAGE_ERROR', 'Cannot save the encrypted credential.'); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async clear(): Promise<void> { await rm(join(this.home, this.slot.file), { force: true }); }
}
