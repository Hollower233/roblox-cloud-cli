import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { backup, object, resourceToken, saveWriteReceipt, type JsonObject, type WriteOptions, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

const assetsApi = 'https://apis.roblox.com/assets/v1';
export const createAssetUrl = `${assetsApi}/assets`;

function operationPath(value: string): string {
  return `operations/${resourceToken(value.replace(/^operations\//, ''))}`;
}

function operationReceipt(operation: JsonObject, receipt: WriteReceipt, formatResult: ResultFormatter): WriteReceipt {
  if (operation.done !== true) return { ...receipt, state: 'pending' };
  if (operation.error) return { ...receipt, state: 'unverified', error: { code: 'UPLOAD_FAILED', message: 'Roblox reported an asset operation failure; inspect before retrying.' } };
  const asset = object(operation.response, true);
  let assetId: string;
  try { assetId = id(String(asset.assetId)); } catch { throw new AppError('INVALID_RESPONSE', 'Upload returned an invalid image asset ID.'); }
  const moderationState = object(asset.moderationResult ?? {}, true).moderationState ?? 'Unknown';
  return { ...receipt, state: 'verified', response: formatResult(assetId, moderationState) };
}

type ResultFormatter = (assetId: string, moderationState: unknown) => JsonObject;

export async function readAssetOperation(http: HttpClient, value: string, formatResult: ResultFormatter): Promise<WriteReceipt> {
  const path = operationPath(value);
  const url = `${assetsApi}/${path}`;
  const operation = object(await http.request(url, { auth: true }), true);
  return operationReceipt(operation, { universeId: '', state: 'pending', operationId: path, request: { method: 'GET', url } }, formatResult);
}

export interface AssetOperationOptions extends WriteOptions {
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

interface AssetUpload {
  metadata: JsonObject;
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  filename: string;
  backupLabel: string;
}

export async function createImageAsset(
  http: HttpClient, upload: AssetUpload, receipt: WriteReceipt, options: AssetOperationOptions, formatResult: ResultFormatter,
): Promise<WriteReceipt> {
  if (options.dryRun) return receipt;
  if (!options.backupDirectory) throw new AppError('ARGUMENT_ERROR', 'An image upload backup directory is required.');
  const backupPath = (await backup(options.backupDirectory, upload.backupLabel, receipt.request, null))!;
  receipt = { ...receipt, backupPath };
  const extension = upload.mimeType === 'image/png' ? '.png' : '.jpeg';
  try { await writeFile(backupPath + extension, upload.bytes, { flag: 'wx', mode: 0o600 }); }
  catch { throw new AppError('STORAGE_ERROR', 'Cannot save image backup; nothing uploaded.'); }

  const form = new FormData();
  form.append('request', JSON.stringify(upload.metadata));
  form.append('fileContent', new Blob([new Uint8Array(upload.bytes)], { type: upload.mimeType }), upload.filename);
  let accepted = false;
  try {
    let operation = object(await http.request(createAssetUrl, { auth: true, method: 'POST', form }), true);
    accepted = true;
    if (typeof operation.path === 'string' && /^operations\/[A-Za-z0-9_-]{1,200}$/.test(operation.path)) receipt.operationId = operation.path;
    if (receipt.operationId) {
      try { await writeFile(`${backupPath}.operation.json`, JSON.stringify({ operationId: receipt.operationId }), { flag: 'wx', mode: 0o600 }); }
      catch { throw new AppError('STORAGE_ERROR', 'Image upload accepted, but its operation ID could not be saved. Inspect the returned operation ID before retrying.'); }
    }
    for (let attempt = 0; operation.done !== true && attempt < 10; attempt++) {
      if (!receipt.operationId) throw new AppError('INVALID_RESPONSE', 'Upload returned no valid operation ID.');
      await (options.sleep ?? (ms => delay(ms, undefined, { signal: options.signal })))(2000);
      operation = object(await http.request(`${assetsApi}/${receipt.operationId}`, { auth: true }), true);
    }
    return saveWriteReceipt(operationReceipt(operation, receipt, formatResult));
  } catch (error) {
    if (!accepted && error instanceof AppError && (error.code === 'AUTH_REQUIRED'
      || (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500))) throw error;
    const failure = options.signal?.aborted ? new AppError('CANCELLED', 'Upload interrupted. Inspect the result before retrying.') : error;
    return saveWriteReceipt({ ...receipt, state: 'unverified', error: errorInfo(failure) });
  }
}
