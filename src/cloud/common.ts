import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, errorInfo } from '../core/errors.js';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown, response = false): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(response ? 'INVALID_RESPONSE' : 'ARGUMENT_ERROR', 'Expected a JSON object.');
  }
  return value as JsonObject;
}
export function nonempty(value: unknown, response = false): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(response ? 'INVALID_RESPONSE' : 'ARGUMENT_ERROR', 'Expected a non-empty string.');
  return value;
}
// Experiment IDs can exceed Number.MAX_SAFE_INTEGER. Never convert them to numbers.
export function resourceToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new AppError('ARGUMENT_ERROR', 'Invalid resource ID.');
  return value;
}
export function pageNumber(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new AppError('ARGUMENT_ERROR', 'Invalid pagination value.');
  return value;
}
export interface WriteOptions { dryRun?: boolean; backupDirectory?: string }
export interface CloudRequest { method: 'GET' | 'POST' | 'PATCH'; url: string; body?: JsonObject }
export interface WriteReceipt {
  universeId: string; state: 'planned' | 'submitted' | 'verified' | 'pending' | 'unverified';
  request: CloudRequest; backupPath?: string; response?: JsonObject; readback?: JsonObject;
  operationId?: string; error?: ReturnType<typeof errorInfo>;
}
export async function backup(directory: string | undefined, universeId: string, request: CloudRequest, before: unknown): Promise<string | undefined> {
  if (!directory) return undefined;
  const path = join(directory, `${universeId}-${Date.now()}-${randomUUID()}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, universeId, at: new Date().toISOString(), request, before }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch { throw new AppError('STORAGE_ERROR', 'Could not save cloud operation backup; no mutation submitted.'); }
  return path;
}
export function uncertain(error: unknown): boolean {
  return error instanceof AppError && ['NETWORK_ERROR', 'TIMEOUT', 'CANCELLED', 'INVALID_RESPONSE'].includes(error.code);
}
