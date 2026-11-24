import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { WriteReceipt } from '../cloud/common.js';
import { AppError, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { createAssetUrl, createImageAsset, readAssetOperation, type AssetOperationOptions } from './operations.js';

const maxBytes = 20_000_000;
const maxDimension = 7999;

export interface AssetUploadOptions extends AssetOperationOptions {
  creator: { type: 'User' | 'Group'; id: string };
  type?: 'image' | 'decal';
  name: string;
  description?: string;
}

function assetResult(assetId: string, moderationState: unknown) {
  return { assetId, assetUri: `rbxassetid://${assetId}`, moderationState: typeof moderationState === 'string' ? moderationState : 'Unknown' };
}

export function getAssetOperation(http: HttpClient, operationId: string): Promise<WriteReceipt> {
  return readAssetOperation(http, operationId, assetResult);
}

export async function readAssetUploadImage(path: string) {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size > maxBytes) throw new Error();
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new Error();
    const image = sharp(bytes, { limitInputPixels: maxDimension ** 2 });
    const { format, width, height, pages } = await image.metadata();
    if ((format !== 'png' && format !== 'jpeg') || !width || !height
      || width > maxDimension || height > maxDimension || (pages ?? 1) !== 1) throw new Error();
    await image.stats();
    return { bytes, format, width, height };
  } catch {
    throw new AppError('ARGUMENT_ERROR', 'Use a readable static PNG/JPEG up to 20 MB with each dimension below 8000 px.');
  }
}

/** Create a creator-owned image asset while preserving the original file bytes. */
export async function uploadAssetImage(http: HttpClient, imagePath: string, options: AssetUploadOptions): Promise<WriteReceipt> {
  const { creator, type = 'image', name, description = '' } = options;
  if (!creator || (creator.type !== 'User' && creator.type !== 'Group')) throw new AppError('ARGUMENT_ERROR', 'Specify a User or Group image creator.');
  const creatorId = id(creator.id);
  if (type !== 'image' && type !== 'decal') throw new AppError('ARGUMENT_ERROR', 'Asset type must be image or decal.');
  if (typeof name !== 'string' || !name.trim()) throw new AppError('ARGUMENT_ERROR', 'An asset name is required.');
  if (typeof description !== 'string' || description.length > 1000) throw new AppError('ARGUMENT_ERROR', 'Asset description must be at most 1000 UTF-16 units.');

  const path = resolve(imagePath);
  const { bytes, format, width, height } = await readAssetUploadImage(path);
  const metadata = {
    assetType: type === 'image' ? 'Image' : 'Decal',
    displayName: name.trim(),
    description,
    creationContext: { creator: creator.type === 'Group' ? { groupId: creatorId } : { userId: creatorId } },
  };
  const receipt: WriteReceipt = {
    universeId: '',
    state: 'planned',
    request: {
      method: 'POST',
      url: createAssetUrl,
      body: { ...metadata, image: { path, format, width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } },
    },
  };
  return createImageAsset(http, {
    metadata, bytes, mimeType: `image/${format}`, filename: `image.${format}`,
    backupLabel: `${type}-${creator.type}-${creatorId}`,
  }, receipt, options, assetResult);
}
