import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { backup, uncertain, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { getDeveloperProduct, updateDeveloperProduct } from './products.js';

export interface DeveloperProductIconOptions {
  dryRun?: boolean;
  backupDirectory: string;
  sleep?: (ms: number) => Promise<void>;
}

/** Upload a product's default icon once, then poll its configuration (not moderation status). */
export async function uploadDeveloperProductIcon(http: HttpClient, universeId: string, productId: string, imagePath: string, options: DeveloperProductIconOptions): Promise<WriteReceipt> {
  id(universeId); id(productId);
  let png: Buffer;
  try {
    const input = await readFile(resolve(imagePath));
    if (input.length > 20 * 1024 * 1024) throw new Error('Too large');
    const image = sharp(input, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('Invalid format');
    png = await image.rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch { throw new AppError('ARGUMENT_ERROR', 'Cannot read icon: use a static PNG/JPEG image up to 20 MiB and 40 megapixels.'); }
  const before = await getDeveloperProduct(http, universeId, productId);
  if (before.productId !== productId) throw new AppError('INVALID_RESPONSE', 'Roblox returned a different product.');
  if (before.isImmutable) throw new AppError('ARGUMENT_ERROR', 'This developer product is immutable.');
  const request = { method: 'PATCH' as const, url: `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developer-products/${productId}`,
    body: { productId, imageSha256: createHash('sha256').update(png).digest('hex'), imageBytes: png.length } };
  const receipt: WriteReceipt = { universeId, state: 'planned', request };
  if (options.dryRun) return { ...receipt, readback: { ...before } };
  if (!options.backupDirectory) throw new AppError('ARGUMENT_ERROR', 'A backup directory is required.');
  receipt.backupPath = await backup(options.backupDirectory, universeId, request, before);
  try { await writeFile(`${receipt.backupPath}.png`, png, { flag: 'wx', mode: 0o600 }); }
  catch { throw new AppError('STORAGE_ERROR', 'Could not save uploaded icon backup; nothing submitted.'); }
  try {
    await updateDeveloperProduct(http, universeId, productId, { imageFile: new Blob([new Uint8Array(png)], { type: 'image/png' }) });
  } catch (error) {
    if (!uncertain(error)) throw error;
    return { ...receipt, state: 'unverified', error: errorInfo(error) };
  }
  receipt.state = 'unverified';
  const sleep = options.sleep ?? (ms => delay(ms));
  for (const ms of [0, 1000, 2000, 3000, 5000]) {
    try {
      if (ms) await sleep(ms);
      const after = await getDeveloperProduct(http, universeId, productId);
      receipt.readback = { ...after };
      if (after.productId === productId && after.iconStatus === 'configured' && after.iconImageAssetId !== before.iconImageAssetId) {
        receipt.state = 'verified';
        delete receipt.error;
        return receipt;
      }
      receipt.error = after.iconStatus === 'placeholder'
        ? { code: 'ICON_PLACEHOLDER', message: 'Readback references a known placeholder icon; the uploaded icon is not verified. Inspect devproduct list --json before retrying.' }
        : { code: 'ICON_NOT_VERIFIED', message: 'No changed, non-placeholder icon ID was observed; inspect devproduct list --json before retrying. Image moderation and display are not verified.' };
    } catch (error) { receipt.error = errorInfo(error); }
  }
  receipt.error ??= { code: 'ICON_NOT_VERIFIED', message: 'No changed, non-placeholder icon ID was observed; inspect devproduct list --json before retrying. Image moderation and display are not verified.' };
  return receipt;
}
