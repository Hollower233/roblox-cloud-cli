import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import opentype from 'opentype.js';
import { AppError } from '../core/errors.js';
import { parseDuration } from './frames.js';

export const DEFAULT_ICON_NODES = [...Array.from({ length: 24 }, (_, i) => `${24 - i}h`), '30mins', '15mins', '10mins', '5mins', '1min'];
export const HOURGLASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<g fill="none" stroke="#fff" stroke-width="28" stroke-linecap="round" stroke-linejoin="miter">
<path d="M136 72C126 154 147 217 196 256C147 295 126 358 136 440"/>
<path d="M376 72C386 154 365 217 316 256C365 295 386 358 376 440"/></g>
<g fill="#fff"><rect x="90" y="46" width="332" height="49" rx="17"/><rect x="90" y="417" width="332" height="49" rx="17"/>
<path d="M180 168H332C324 205 292 233 256 246C220 233 188 205 180 168Z"/>
<path d="M179 403C188 359 218 328 256 312C294 328 324 359 333 403Z"/></g></svg>`;

export interface GeneratedIcon { label: string; file: string; offsetMs: number | null }
export function iconNodes(nodes: string[] = DEFAULT_ICON_NODES): GeneratedIcon[] {
  const seen = new Set<number>();
  const frames = nodes.map(value => {
    const offsetMs = parseDuration(value);
    if (!offsetMs || offsetMs > 24 * 3_600_000 || offsetMs % 1000 !== 0 || seen.has(offsetMs)) throw new AppError('ARGUMENT_ERROR', 'Nodes must be unique positive durations up to 24h (e.g. 3h,30mins,1min).');
    seen.add(offsetMs);
    const label = offsetMs % 3_600_000 === 0 ? `${offsetMs / 3_600_000}${offsetMs === 3_600_000 ? 'hr' : 'hrs'}`
      : offsetMs % 60_000 === 0 ? `${offsetMs / 60_000}${offsetMs === 60_000 ? 'Min' : 'Mins'}` : `${offsetMs / 1000}s`;
    return { label, file: `${label.toLowerCase()}.png`, offsetMs };
  }).sort((a, b) => b.offsetMs - a.offsetMs);
  return [...frames, { label: 'SOON!', file: 'soon.png', offsetMs: 0 }, { label: 'NOW!', file: 'now.png', offsetMs: null }];
}
const require = createRequire(import.meta.url);
let fontPromise: Promise<opentype.Font> | undefined;
function font(): Promise<opentype.Font> {
  return fontPromise ??= readFile(require.resolve('@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff')).then(data => opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
}
async function textPath(label: string, maxWidth: number, maxHeight: number, cx: number, cy: number): Promise<string> {
  const p = (await font()).getPath(label, 0, 0, 110), b = p.getBoundingBox();
  const scale = Math.min(1, maxWidth / (b.x2 - b.x1), maxHeight / (b.y2 - b.y1));
  return `<g fill="white" transform="translate(${cx - (b.x1 + b.x2) * scale / 2} ${cy - (b.y1 + b.y2) * scale / 2}) scale(${scale})"><path d="${p.toPathData(3)}"/></g>`;
}
export async function renderIcon(original: Buffer, label: string): Promise<Buffer> {
  const hg = HOURGLASS_SVG.replace('<svg ', '<svg x="81" y="15" ').replace('width="512" height="512"', 'width="350" height="350"');
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="black" opacity="0.35"/>${hg}${await textPath(label, 394, 94, 256, 417)}</svg>`;
  return sharp(original, { limitInputPixels: 40_000_000 }).rotate().resize(512, 512, { fit: 'cover' }).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
}
/** Exclusive output directory: original image and generated files can never overwrite an earlier preview. */
export async function generateIconImages(original: Buffer, output: string, nodes?: string[]): Promise<{ output: string; frames: GeneratedIcon[]; originalFile: string }> {
  const frames = iconNodes(nodes), folder = resolve(output);
  const metadata = await sharp(original, { limitInputPixels: 40_000_000 }).metadata();
  if (!['png', 'jpeg'].includes(metadata.format ?? '') || metadata.width !== metadata.height) throw new AppError('ARGUMENT_ERROR', 'The current icon must be a square PNG/JPEG image.');
  await mkdir(dirname(folder), { recursive: true });
  try { await mkdir(folder); } catch (e) { throw new AppError('STORAGE_ERROR', (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'Output already exists; choose a new folder.' : 'Cannot create output folder.'); }
  await mkdir(join(folder, 'frames'));
  const originalFile = metadata.format === 'jpeg' ? 'original.jpg' : 'original.png';
  await writeFile(join(folder, originalFile), original, { flag: 'wx' });
  await writeFile(join(folder, 'hourglass.svg'), HOURGLASS_SVG, { flag: 'wx' });
  const previews: OverlayOptions[] = [];
  for (const [i, frame] of frames.entries()) {
    const data = await renderIcon(original, frame.label);
    await writeFile(join(folder, 'frames', frame.file), data, { flag: 'wx' });
    previews.push({ input: await sharp(data).resize(256, 256).toBuffer(), left: 16 + i % 4 * 272, top: 16 + Math.floor(i / 4) * 272 });
  }
  await sharp({ create: { width: 1104, height: 16 + Math.ceil(frames.length / 4) * 272, channels: 4, background: '#18212d' } }).composite(previews).png().toFile(join(folder, 'overview.png'));
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, size: 512, maskOpacity: 0.35, font: 'Archivo Black (OFL-1.1)', originalFile, frames }, null, 2) + '\n', { flag: 'wx' });
  return { output: folder, frames, originalFile };
}
