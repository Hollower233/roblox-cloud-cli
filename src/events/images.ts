import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { backup, object, type WriteOptions, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { saveEventReceipt } from './receipts.js';

function operationPath(value: string): string {
  const path = value.startsWith('operations/') ? value : `operations/${value}`;
  if (!/^operations\/[A-Za-z0-9_-]{1,200}$/.test(path)) throw new AppError('ARGUMENT_ERROR', 'Invalid asset operation ID.');
  return path;
}
function operationReceipt(operation: Record<string, unknown>, receipt: WriteReceipt): WriteReceipt {
  if (operation.done !== true) return { ...receipt, state: 'pending' };
  if (operation.error) return { ...receipt, state: 'unverified', error: { code: 'UPLOAD_FAILED', message: 'Roblox reported an asset operation failure; inspect before retrying.' } };
  const asset = object(operation.response, true);
  let mediaId: string;
  try { mediaId = id(String(asset.assetId)); } catch { throw new AppError('INVALID_RESPONSE', 'Upload returned an invalid image asset ID.'); }
  return { ...receipt, state: 'verified', response: { mediaId, moderationState: object(asset.moderationResult ?? {}, true).moderationState ?? 'Unknown' } };
}
export async function getEventImageOperation(http: HttpClient, value: string): Promise<WriteReceipt> {
  const path = operationPath(value), url = `https://apis.roblox.com/assets/v1/${path}`;
  return operationReceipt(object(await http.request(url, { auth: true }), true), { universeId: '', state: 'pending', operationId: path, request: { method: 'GET', url } });
}

export interface EventImageOptions extends WriteOptions {
  creator: { type: 'User' | 'Group'; id: string };
  sleep?: (ms: number) => Promise<void>;
}
/** Upload separately so its returned mediaId can be reused after any event submission failure. */
export async function uploadEventImage(http: HttpClient, imagePath: string, options: EventImageOptions): Promise<WriteReceipt> {
  const creator = options.creator;
  if (!creator || !['User', 'Group'].includes(creator.type)) throw new AppError('ARGUMENT_ERROR', 'Specify a User or Group image creator.');
  id(creator.id);
  let png: Buffer;
  try {
    const input = await readFile(resolve(imagePath));
    if (input.length > 20 * 1024 * 1024) throw new Error('Too large');
    const image = sharp(input, { limitInputPixels: 40_000_000 }), metadata = await image.metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('Invalid format');
    png = await image.rotate().png().toBuffer();
  } catch { throw new AppError('ARGUMENT_ERROR', 'Use a static PNG/JPEG image up to 20 MiB and 40 megapixels.'); }
  const body = { assetType: 'Image', displayName: 'event-thumbnail', creationContext: { creator: creator.type === 'User' ? { userId: Number(creator.id) } : { groupId: Number(creator.id) } } };
  const request = { method: 'POST' as const, url: 'https://apis.roblox.com/assets/v1/assets', body: { ...body, imageSha256: createHash('sha256').update(png).digest('hex'), imageBytes: png.length } };
  // This receipt has no universe target; image assets belong to a creator.
  const receipt: WriteReceipt = { universeId: '', state: 'planned', request };
  if (options.dryRun) return receipt;
  if (!options.backupDirectory) throw new AppError('ARGUMENT_ERROR', 'An image upload backup directory is required.');
  receipt.backupPath = await backup(options.backupDirectory, `image-${creator.type}-${creator.id}`, request, null);
  try { await writeFile(`${receipt.backupPath}.png`, png, { flag: 'wx', mode: 0o600 }); }
  catch { throw new AppError('STORAGE_ERROR', 'Cannot save image backup; nothing uploaded.'); }
  const form = new FormData();
  form.append('request', JSON.stringify(body));
  form.append('fileContent', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'event-thumbnail.png');
  let accepted = false;
  try {
    let operation = object(await http.request(request.url, { auth: true, method: 'POST', form }), true);
    accepted = true;
    if (typeof operation.path === 'string' && /^operations\/[A-Za-z0-9_-]+$/.test(operation.path)) receipt.operationId = operation.path;
    // Save the accepted operation before polling, so interruption cannot lose its ID.
    if (receipt.operationId && receipt.backupPath) {
      try { await writeFile(`${receipt.backupPath}.operation.json`, JSON.stringify({ operationId: receipt.operationId }), { flag: 'wx', mode: 0o600 }); }
      catch { throw new AppError('STORAGE_ERROR', 'Image upload accepted, but its operation ID could not be saved. Inspect the returned operation ID before retrying.'); }
    }
    for (let attempt = 0; operation.done !== true && attempt < 10; attempt++) {
      if (!receipt.operationId) throw new AppError('INVALID_RESPONSE', 'Upload returned no valid operation ID.');
      await (options.sleep ?? (ms => delay(ms)))(2000);
      operation = object(await http.request(`https://apis.roblox.com/assets/v1/${receipt.operationId}`, { auth: true }), true);
    }
    return saveEventReceipt(operationReceipt(operation, receipt));
  } catch (error) {
    if (!accepted && error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500) throw error;
    return saveEventReceipt({ ...receipt, state: 'unverified', error: errorInfo(error) });
  }
}
