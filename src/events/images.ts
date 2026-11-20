import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createAssetUrl, createImageAsset, readAssetOperation, type AssetOperationOptions } from '../assets/operations.js';
import type { WriteReceipt } from '../cloud/common.js';
import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

function eventImageResult(mediaId: string, moderationState: unknown) {
  return { mediaId, moderationState };
}

export function getEventImageOperation(http: HttpClient, value: string): Promise<WriteReceipt> {
  return readAssetOperation(http, value, eventImageResult);
}

export interface EventImageOptions extends AssetOperationOptions {
  creator: { type: 'User' | 'Group'; id: string };
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
  const request = { method: 'POST' as const, url: createAssetUrl, body: { ...body, imageSha256: createHash('sha256').update(png).digest('hex'), imageBytes: png.length } };
  // This receipt has no universe target; image assets belong to a creator.
  const receipt: WriteReceipt = { universeId: '', state: 'planned', request };
  return createImageAsset(http, {
    metadata: body, bytes: png, mimeType: 'image/png',
    filename: 'event-thumbnail.png', backupLabel: `image-${creator.type}-${creator.id}`,
  }, receipt, options, eventImageResult);
}
