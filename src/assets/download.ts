import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import { imageInfo } from '../icons/frames.js';

export function parseAssetId(input: string): string {
  return id(input.trim().replace(/^rbxassetid:\/\//i, ''));
}

export interface AssetDownloadOptions {
  output?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Download Roblox's delivered PNG/JPEG bytes, without thumbnail rendering or re-encoding. */
export async function downloadAssetImage(http: HttpClient, input: string, options: AssetDownloadOptions = {}) {
  const assetId = parseAssetId(input);
  const seen = new Set<string>();
  let imageAssetId = assetId;
  for (let depth = 0; depth < 5; depth++) {
    if (seen.has(imageAssetId)) throw new AppError('INVALID_RESPONSE', 'Cyclic Decal texture reference.');
    seen.add(imageAssetId);
    let delivery: { location?: string; errors?: unknown[] };
    try {
      delivery = await http.request(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${imageAssetId}`, { auth: true });
    } catch (error) {
      if (error instanceof AppError && error.code === 'FORBIDDEN') throw new AppError('FORBIDDEN', 'Asset delivery denied. Check the API key legacy-asset:manage scope and access to this asset.', 403);
      throw error;
    }
    if (!delivery || delivery.errors?.length || typeof delivery.location !== 'string') throw new AppError('INVALID_RESPONSE', 'Asset delivery did not return a download location.');
    let url: URL;
    try { url = new URL(delivery.location); } catch { throw new AppError('INVALID_RESPONSE', 'Invalid asset download URL.'); }
    if (url.protocol !== 'https:' || !(url.hostname.endsWith('.rbxcdn.com') || url.hostname === 'contentdelivery.roblox.com') || url.port || url.username || url.password) throw new AppError('INVALID_RESPONSE', 'Unsupported asset CDN destination.');
    let data: Buffer;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      // CDN requests never receive the API key and cannot redirect it elsewhere.
      const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); throw new AppError('HTTP_ERROR', `Asset CDN returned HTTP ${response.status}.`, response.status); }
      if (!response.body) throw new AppError('INVALID_RESPONSE', 'Empty asset response.');
      const reader = response.body.getReader(), chunks: Buffer[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 50 * 1024 * 1024) throw new AppError('INVALID_RESPONSE', 'Asset exceeds the 50 MB download limit.');
          chunks.push(Buffer.from(next.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      data = Buffer.concat(chunks);
    } catch (error) {
      if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
      if (error instanceof AppError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new AppError('TIMEOUT', 'Asset download timed out.');
      throw new AppError('NETWORK_ERROR', 'Could not download the asset from Roblox CDN.');
    }
    const info = imageInfo(data);
    if (info && info.width > 0 && info.height > 0) {
      const path = resolve(options.output ?? `${assetId}.${info.format === 'jpeg' ? 'jpg' : 'png'}`);
      if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
      let created = false;
      try {
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, 'wx');
        created = true;
        try { await file.writeFile(data); } finally { await file.close(); }
      } catch (error) {
        if (created) await rm(path, { force: true }).catch(() => {});
        throw new AppError('STORAGE_ERROR', (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'Output already exists; choose a different --output path.' : 'Cannot save the asset image.');
      }
      return { assetId, imageAssetId, path, ...info, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }
    const xml = data.toString('utf8');
    const texture = /<Content\b[^>]*\bname=["']Texture["'][^>]*>\s*<url>\s*([^<]+)\s*<\/url>\s*<\/Content>/i.exec(xml)?.[1]?.trim();
    if (!xml.includes('<roblox') || !texture) throw new AppError('INVALID_RESPONSE', 'Asset is not a supported PNG/JPEG image or XML Decal.');
    if (/^rbxassetid:\/\//i.test(texture)) imageAssetId = parseAssetId(texture);
    else {
      let reference: URL;
      try { reference = new URL(texture.replaceAll('&amp;', '&')); } catch { throw new AppError('INVALID_RESPONSE', 'Invalid Decal texture reference.'); }
      if (!['http:', 'https:'].includes(reference.protocol) || !['www.roblox.com', 'roblox.com', 'assetdelivery.roblox.com'].includes(reference.hostname) || !/^\/asset\/?$/i.test(reference.pathname)) throw new AppError('INVALID_RESPONSE', 'Unsupported Decal texture reference.');
      imageAssetId = id(reference.searchParams.get('id') ?? '');
    }
  }
  throw new AppError('INVALID_RESPONSE', 'Too many Decal texture references.');
}
