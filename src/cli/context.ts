import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { CredentialStore, robloxCookieCredential } from '../auth/credentials.js';
import { AppError } from '../core/errors.js';
import { resolveProfileUniverse } from '../profiles/copy.js';
import { LocalStore, defaultHome } from '../storage/store.js';
import { HttpClient } from '../transport/http-client.js';
import { clean, emit } from './output.js';
import type { WriteReceipt } from '../cloud/common.js';

export interface CommandContext {
  connection(): Promise<{ local: LocalStore; http: HttpClient }>;
  universe(input: string, auth?: 'apiKey' | 'cookie' | 'both' | 'none'): Promise<{ local: LocalStore; universeId: string; http: HttpClient }>;
  output(data: unknown): void;
  receipt(result: WriteReceipt): void;
  signal: AbortSignal;
}
export async function readJsonFile(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(resolve(path), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new AppError('ARGUMENT_ERROR', 'Cannot read input file as UTF-8 JSON.'); }
}
export function commandContext(program: Command, signal: AbortSignal): CommandContext {
  const json = () => Boolean(program.opts().json);
  const connection = async () => {
    const local = new LocalStore(resolve(program.opts().home ?? defaultHome()));
    return { local, http: new HttpClient({ apiKey: await new CredentialStore(local.home).get(), signal }) };
  };
  return {
    signal,
    connection,
    async universe(input, auth = 'apiKey') {
      const local = new LocalStore(resolve(program.opts().home ?? defaultHome())), config = await local.config();
      const catalog = config.currentUserId ? await local.catalog(config.currentUserId) : null;
      const universeId = resolveProfileUniverse(input, catalog?.games);
      const apiKey = auth === 'apiKey' || auth === 'both' ? await new CredentialStore(local.home).get() : undefined;
      const robloxCookie = auth === 'cookie' || auth === 'both' ? await new CredentialStore(local.home, robloxCookieCredential).get() : undefined;
      return { local, universeId, http: new HttpClient({ apiKey, robloxCookie, signal }) };
    },
    output(data) { emit(data, json(), JSON.stringify(data, null, 2).split('\n').map(clean).join('\n')); },
    receipt(result) {
      const warnings = ['unverified', 'pending'].includes(result.state)
        ? [{ code: result.error?.code ?? result.state.toUpperCase(), message: result.error?.message ?? 'Operation is not confirmed complete; inspect state before retrying.', resource: result.operationId ?? result.universeId }]
        : [];
      const universe = result.universeId ? `Universe: ${result.universeId}\n` : '';
      const human = `${universe}State: ${result.state}${result.operationId ? `\nOperation: ${result.operationId}` : ''}${result.backupPath ? `\nBackup: ${result.backupPath}` : ''}\n${JSON.stringify(result, null, 2).split('\n').map(clean).join('\n')}`;
      emit(result, json(), human, warnings);
    },
  };
}
