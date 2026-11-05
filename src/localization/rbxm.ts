import * as zlib from 'node:zlib';
import { AppError } from '../core/errors.js';

/** A ModuleScript tree read from or written to a binary .rbxm. Only Name/Source are kept. */
export interface ScriptNode { className: string; name: string; source: string | null; children: ScriptNode[] }

const MAGIC = Buffer.from('<roblox!\x89\xff\r\n\x1a\n', 'latin1');
const invalid = (message: string) => new AppError('ARGUMENT_ERROR', `Invalid .rbxm: ${message}`);

function lz4(input: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  let i = 0, o = 0;
  while (i < input.length) {
    const token = input[i++]!;
    let literal = token >> 4;
    if (literal === 15) { let b; do { b = input[i++]!; literal += b; } while (b === 255); }
    if (o + literal > size || i + literal > input.length) throw invalid('corrupt LZ4 block.');
    input.copy(out, o, i, i + literal); i += literal; o += literal;
    if (i >= input.length) break;
    const offset = input[i]! | (input[i + 1]! << 8); i += 2;
    let match = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = input[i++]!; match += b; } while (b === 255); }
    if (!offset || offset > o || o + match > size) throw invalid('corrupt LZ4 match.');
    for (let k = 0; k < match; k++, o++) out[o] = out[o - offset]!;
  }
  if (o !== size) throw invalid('LZ4 size mismatch.');
  return out;
}

function decompress(data: Buffer, size: number): Buffer {
  if (data.length >= 4 && data.readUInt32LE(0) === 0xfd2fb528) {
    const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (!zstd) throw invalid('ZSTD chunks require Node.js with zlib zstd support.');
    return zstd(data);
  }
  return lz4(data, size);
}

class Reader {
  constructor(private b: Buffer, public p = 0) {}
  u8() { this.need(1); return this.b[this.p++]!; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  string() { return this.bytes(this.u32()).toString('utf8'); }
  ints(count: number): number[] {
    const raw = this.bytes(count * 4), out: number[] = [];
    for (let k = 0; k < count; k++) {
      const v = ((raw[k]! << 24) | (raw[k + count]! << 16) | (raw[k + 2 * count]! << 8) | raw[k + 3 * count]!) >>> 0;
      out.push((v >>> 1) ^ -(v & 1));
    }
    return out;
  }
  refs(count: number): number[] { let acc = 0; return this.ints(count).map(v => (acc += v)); }
  private need(n: number) { if (this.p + n > this.b.length) throw invalid('truncated chunk.'); }
}

export function readRbxm(file: Buffer): ScriptNode[] {
  if (file.length < 32 || !file.subarray(0, 14).equals(MAGIC)) throw invalid('not a binary Roblox model.');
  const classes = new Map<number, { className: string; refs: number[] }>();
  const nodes = new Map<number, ScriptNode>();
  const shared: string[] = [];
  const parents: [number, number][] = [];
  let p = 32;
  for (;;) {
    if (p + 16 > file.length) throw invalid('missing END chunk.');
    const name = file.subarray(p, p + 4).toString('latin1').replace(/\0+$/, '');
    const compressed = file.readUInt32LE(p + 4), size = file.readUInt32LE(p + 8);
    p += 16;
    const raw = file.subarray(p, p + (compressed || size));
    p += compressed || size;
    if (name === 'END') break;
    const r = new Reader(compressed ? decompress(raw, size) : raw);
    if (name === 'INST') {
      const classId = r.u32(), className = r.string(); r.u8();
      const refs = r.refs(r.u32());
      classes.set(classId, { className, refs });
      for (const ref of refs) nodes.set(ref, { className, name: '', source: null, children: [] });
    } else if (name === 'SSTR') {
      r.u32();
      for (let n = r.u32(); n > 0; n--) { r.bytes(16); shared.push(r.string()); }
    } else if (name === 'PROP') {
      const cls = classes.get(r.u32());
      const prop = r.string(), type = r.u8();
      if (!cls || (prop !== 'Name' && prop !== 'Source')) continue;
      let values: string[];
      if (type === 0x01) values = cls.refs.map(() => r.string());
      else if (type === 0x1c) values = r.ints(cls.refs.length).map(i => shared[i >>> 0] ?? '');
      else continue;
      cls.refs.forEach((ref, k) => { const node = nodes.get(ref)!; if (prop === 'Name') node.name = values[k]!; else node.source = values[k]!; });
    } else if (name === 'PRNT') {
      r.u8();
      const count = r.u32(), child = r.refs(count), parent = r.refs(count);
      child.forEach((c, k) => parents.push([c, parent[k]!]));
    }
  }
  const roots: ScriptNode[] = [];
  const parented = new Set<number>();
  for (const [c, parent] of parents) {
    const node = nodes.get(c), owner = nodes.get(parent);
    if (!node) continue;
    parented.add(c);
    if (owner) owner.children.push(node); else roots.push(node);
  }
  for (const [ref, node] of nodes) if (!parented.has(ref)) roots.push(node);
  return roots;
}

class Writer {
  parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); }
  string(v: string) { const b = Buffer.from(v, 'utf8'); this.u32(b.length); this.parts.push(b); }
  ints(values: number[]) {
    const n = values.length, b = Buffer.alloc(n * 4);
    values.forEach((x, k) => {
      const v = ((x << 1) ^ (x >> 31)) >>> 0;
      b[k] = v >>> 24; b[k + n] = (v >>> 16) & 255; b[k + 2 * n] = (v >>> 8) & 255; b[k + 3 * n] = v & 255;
    });
    this.parts.push(b);
  }
  refs(values: number[]) { let prev = 0; this.ints(values.map(v => { const d = v - prev; prev = v; return d; })); }
  done() { return Buffer.concat(this.parts); }
}

function chunk(name: string, data: Buffer, compress: boolean): Buffer {
  const header = Buffer.alloc(16);
  header.write(name.padEnd(4, '\0'), 0, 'latin1');
  const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  const packed = compress && zstd && data.length > 64 ? zstd(data) : null;
  header.writeUInt32LE(packed ? packed.length : 0, 4);
  header.writeUInt32LE(data.length, 8);
  return Buffer.concat([header, packed ?? data]);
}

/** Serialize script trees (ModuleScript/Script/Folder) with only Name and Source properties. */
export function writeRbxm(roots: ScriptNode[], options: { compress?: boolean } = {}): Buffer {
  const flat: { node: ScriptNode; ref: number; parent: number }[] = [];
  const visit = (node: ScriptNode, parent: number) => { const ref = flat.length; flat.push({ node, ref, parent }); node.children.forEach(c => visit(c, ref)); };
  roots.forEach(root => visit(root, -1));
  const classNames = [...new Set(flat.map(x => x.node.className))].sort();
  const compress = options.compress ?? true;
  const chunks: Buffer[] = [];
  classNames.forEach((className, classId) => {
    const members = flat.filter(x => x.node.className === className);
    const inst = new Writer();
    inst.u32(classId); inst.string(className); inst.u8(0); inst.u32(members.length); inst.refs(members.map(x => x.ref));
    chunks.push(chunk('INST', inst.done(), compress));
  });
  classNames.forEach((className, classId) => {
    const members = flat.filter(x => x.node.className === className);
    const names = new Writer();
    names.u32(classId); names.string('Name'); names.u8(0x01); members.forEach(x => names.string(x.node.name));
    chunks.push(chunk('PROP', names.done(), compress));
    if (members.every(x => x.node.source !== null)) {
      const sources = new Writer();
      sources.u32(classId); sources.string('Source'); sources.u8(0x01); members.forEach(x => sources.string(x.node.source!));
      chunks.push(chunk('PROP', sources.done(), compress));
    }
  });
  const prnt = new Writer();
  prnt.u8(0); prnt.u32(flat.length); prnt.refs(flat.map(x => x.ref)); prnt.refs(flat.map(x => x.parent));
  chunks.push(chunk('PRNT', prnt.done(), compress));
  chunks.push(chunk('END', Buffer.from('</roblox>', 'latin1'), false));
  const header = Buffer.alloc(32);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(classNames.length, 16);
  header.writeUInt32LE(flat.length, 20);
  return Buffer.concat([header, ...chunks]);
}
