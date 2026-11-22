import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';

export async function withStudioEdit<T>(
  placeId: string, signal: AbortSignal, run: (execute: (code: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  return withStudioEditSession(placeId, signal, session => run(session.execute));
}

export interface StudioEditSession {
  execute(code: string, timeoutMs?: number): Promise<unknown>;
  save(): Promise<unknown>;
}

export async function withStudioEditSession<T>(
  placeId: string, signal: AbortSignal, run: (session: StudioEditSession) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Official Studio MCP integration currently supports Windows.');
  const local = process.env.LOCALAPPDATA;
  const launcher = local && join(local, 'Roblox', 'mcp.bat');
  if (!launcher || !existsSync(launcher)) throw new AppError('STUDIO_NOT_FOUND', 'Enable the official MCP server in Roblox Studio and check that mcp.bat is installed.');
  if (signal.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
  // Pass the launcher via an environment variable and quote its expansion for cmd.
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '""%RBX_STUDIO_MCP_LAUNCHER%""'], {
    env: { ...process.env, RBX_STUDIO_MCP_LAUNCHER: launcher },
    windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  let closed: AppError | undefined;
  let receive: ((message: unknown) => void) | undefined;
  let rejectCurrent: ((error: AppError) => void) | undefined;
  const close = (error: AppError) => {
    closed ??= error;
    rejectCurrent?.(closed);
  };
  const abort = () => close(new AppError('CANCELLED', 'Operation cancelled.'));
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => close(new AppError('NETWORK_ERROR', 'Could not start the official Studio MCP launcher.')));
  child.on('exit', () => close(new AppError('NETWORK_ERROR', 'The official Studio MCP connection closed.')));
  child.stdin.on('error', () => close(new AppError('NETWORK_ERROR', 'Could not send a request to Studio MCP.')));
  lines.on('line', line => {
    try { receive?.(JSON.parse(line)); } catch { /* Ignore launcher diagnostics. */ }
  });
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = async (method: string, params: object, timeoutMs = 15_000): Promise<unknown> => {
    if (closed) throw closed;
    const requestId = ++id;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        rejectCurrent = reject;
        timer = setTimeout(() => close(new AppError('TIMEOUT', `Studio MCP timed out during ${method}.`)), timeoutMs);
        receive = message => {
          if (!message || typeof message !== 'object' || !('id' in message) || message.id !== requestId) return;
          if ('result' in message) resolve(message.result);
          else reject(new AppError('INVALID_RESPONSE', `Studio MCP rejected ${method}.`));
        };
        send({ id: requestId, method, params });
      });
    } finally {
      clearTimeout(timer);
      receive = undefined;
      rejectCurrent = undefined;
    }
  };
  const tool = async (name: string, args: object, timeoutMs?: number): Promise<unknown> => {
    const result = await request('tools/call', { name, arguments: args }, timeoutMs) as {
      isError?: boolean; structuredContent?: unknown; content?: { text?: string }[];
    } | null;
    if (result?.isError) throw new AppError('INVALID_RESPONSE', `Studio MCP ${name} failed: ${(result.content?.[0]?.text ?? '').slice(0, 350)}`);
    if (result?.structuredContent !== undefined) return result.structuredContent;
    for (const block of result?.content ?? []) {
      try { return JSON.parse(block.text ?? ''); } catch { /* Some tools put a human summary before their JSON. */ }
    }
    throw new AppError('INVALID_RESPONSE', `Studio MCP returned no JSON for ${name}.`);
  };
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'roblox-cloud-cli', version: '0.1.0' } });
    send({ method: 'notifications/initialized' });
    for (let attempt = 0; attempt < 20; attempt++) {
      const list = await tool('list_roblox_studios', {}) as { studios?: { id?: string; placeId?: number | string; mode?: string }[] };
      if (!Array.isArray(list?.studios)) throw new AppError('INVALID_RESPONSE', 'Studio MCP returned no Studio list.');
      const matches = list.studios.filter(studio => String(studio.placeId) === placeId && studio.mode === 'Edit');
      if (matches.length > 1) throw new AppError('STUDIO_NOT_FOUND', `Multiple Studio edit sessions for Place ${placeId}.`);
      const studioId = matches[0]?.id;
      if (studioId) return await run({
        execute: (code, timeoutMs) => tool('execute_luau', { studio_id: studioId, datamodel_type: 'Edit', code }, timeoutMs),
        save: () => tool('save_place', { studio_id: studioId }, 30_000),
      });
      if (attempt < 19) await delay(250);
    }
    throw new AppError('STUDIO_NOT_FOUND', `No Studio edit session for Place ${placeId}.`);
  } finally {
    signal.removeEventListener('abort', abort);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
