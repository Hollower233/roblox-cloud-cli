import { AppError } from '../core/errors.js';

/** Minimal Lua tokenizer for data modules: `return { ... }` with string/identifier fields only. */
type Token = { type: 'string' | 'name' | 'punct' | 'eof'; value: string; at: number };
export const MASTER_NAME = '本地化表';
const bad = (module: string, at: number, message: string) => new AppError('ARGUMENT_ERROR', `${module}: ${message} (offset ${at}).`);

function longBracket(source: string, at: number): { level: number; end: number } | null {
  const m = /^\[(=*)\[/.exec(source.slice(at, at + 64));
  if (!m) return null;
  const close = `]${m[1]}]`, end = source.indexOf(close, at + m[0].length);
  return end < 0 ? { level: -1, end: -1 } : { level: m[1]!.length, end };
}

function tokenize(source: string, module: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('--', i)) {
      const long = longBracket(source, i + 2);
      if (long) { if (long.end < 0) throw bad(module, i, 'unterminated comment'); i = long.end + long.level + 2; }
      else { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl + 1; }
      continue;
    }
    if (c === '"' || c === "'") {
      // Accumulate UTF-8 bytes so \ddd and \x byte escapes compose correctly with literal characters.
      const start = i, bytes: number[] = []; i++;
      const text = (value: string) => { for (const b of Buffer.from(value, 'utf8')) bytes.push(b); };
      for (;;) {
        if (i >= source.length || source[i] === '\n') throw bad(module, start, 'unterminated string');
        const ch = source[i]!;
        if (ch === c) { i++; break; }
        if (ch !== '\\') { const s = String.fromCodePoint(source.codePointAt(i)!); text(s); i += s.length; continue; }
        const e = source[i + 1]; i += 2;
        if (e === undefined) throw bad(module, start, 'bad escape');
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
        if (e in simple) text(simple[e]!);
        else if (/\d/.test(e)) { const m = /^\d{1,3}/.exec(source.slice(i - 1))![0]; i += m.length - 1; if (Number(m) > 255) throw bad(module, i, 'decimal escape too large'); bytes.push(Number(m)); }
        else if (e === 'x') { const h = source.slice(i, i + 2); if (!/^[0-9a-fA-F]{2}$/.test(h)) throw bad(module, i, 'bad \\x escape'); bytes.push(parseInt(h, 16)); i += 2; }
        else if (e === 'u') { const m = /^\{([0-9a-fA-F]+)\}/.exec(source.slice(i)); if (!m) throw bad(module, i, 'bad \\u escape'); text(String.fromCodePoint(parseInt(m[1]!, 16))); i += m[0].length; }
        else if (e === 'z') { while (/\s/.test(source[i] ?? '')) i++; }
        else throw bad(module, i, `unsupported escape \\${e}`);
      }
      tokens.push({ type: 'string', value: Buffer.from(bytes).toString('utf8'), at: start });
      continue;
    }
    if (c === '[') {
      const long = longBracket(source, i);
      if (long) {
        if (long.end < 0) throw bad(module, i, 'unterminated long string');
        let text = source.slice(i + long.level + 2, long.end);
        if (text.startsWith('\r\n')) text = text.slice(2); else if (text.startsWith('\n')) text = text.slice(1);
        tokens.push({ type: 'string', value: text, at: i }); i = long.end + long.level + 2; continue;
      }
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 256));
    if (name) { tokens.push({ type: 'name', value: name[0], at: i }); i += name[0].length; continue; }
    if ('{}[]=,;'.includes(c)) { tokens.push({ type: 'punct', value: c, at: i }); i++; continue; }
    throw bad(module, i, `unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ type: 'eof', value: '', at: source.length });
  return tokens;
}

class Parser {
  private k = 0;
  constructor(private tokens: Token[], private module: string) {}
  peek() { return this.tokens[this.k]!; }
  next() { return this.tokens[this.k++]!; }
  expect(type: Token['type'], value?: string): Token {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) throw bad(this.module, t.at, `expected ${value ?? type}`);
    return t;
  }
  accept(value: string) { const t = this.peek(); if (t.type === 'punct' && t.value === value) { this.k++; return true; } return false; }
  separator() { if (!this.accept(',')) this.accept(';'); }
}

export interface MasterRow { en: string; zh: string }

/** Parse the master module: `return { { en = "...", zh = "..." }, ... }`. */
export function parseMasterSource(source: string, module = MASTER_NAME): MasterRow[] {
  const p = new Parser(tokenize(source, module), module);
  p.expect('name', 'return'); p.expect('punct', '{');
  const rows: MasterRow[] = [], seen = new Set<string>();
  while (!p.accept('}')) {
    const start = p.expect('punct', '{');
    const row: Partial<MasterRow> = {};
    while (!p.accept('}')) {
      const key = p.expect('name').value; p.expect('punct', '=');
      const value = p.expect('string').value;
      if (key === 'en' || key === 'zh') row[key] = value;
      p.separator();
    }
    if (typeof row.en !== 'string' || typeof row.zh !== 'string') throw bad(module, start.at, 'row needs en and zh');
    if (seen.has(row.en)) throw bad(module, start.at, `duplicate source ${JSON.stringify(row.en)}`);
    seen.add(row.en);
    rows.push(row as MasterRow);
    p.separator();
  }
  p.expect('eof');
  return rows;
}

/** Parse a language module: `return { ["source"] = "translation", ... }`. */
export function parseLanguageSource(source: string, module: string): Map<string, string> {
  const p = new Parser(tokenize(source, module), module);
  p.expect('name', 'return'); p.expect('punct', '{');
  const map = new Map<string, string>();
  while (!p.accept('}')) {
    const start = p.expect('punct', '[');
    const key = p.expect('string').value; p.expect('punct', ']'); p.expect('punct', '=');
    const value = p.expect('string').value;
    if (map.has(key)) throw bad(module, start.at, `duplicate source ${JSON.stringify(key)}`);
    map.set(key, value);
    p.separator();
  }
  p.expect('eof');
  return map;
}

export function luaString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c === 127) out += '\\' + String(c).padStart(3, '0');
    else out += ch;
  }
  return out + '"';
}

export function languageModuleSource(locale: string, rows: [string, string][]): string {
  return `--[[\n本地化表.${locale}：英文原文 → ${locale} 译文。由 rbx localization sync 生成，顺序与主表一致。\n- 可直接修改译文，sync 会保留并推送到云端；主表中已删除或改动的原文会被清理。\n- 只新增原文时请改主表，不要在这里加行。\n]]\nreturn {\n${rows.map(([en, text]) => `\t[${luaString(en)}] = ${luaString(text)},\n`).join('')}}\n`;
}

/** Header of the hand-maintained master module; `rbx localization init` writes it with an empty table. */
export const MASTER_HEADER = String.raw`--[[
${MASTER_NAME}：英文原文 → 简体中文，游戏本地化文本的主数据。
- 每条一行 { en = "...", zh = "..." }；en 与界面实际显示的原文逐字一致（含首尾空格、换行、{a:int} 等占位符），不可重复。
- 新条目插在表最前面（return { 之后）；字符串只转义 \\ \" \n \r \t 与控制字符，其余原样写入。
- 读取用 require(本模块:Clone()) 绕过 require 缓存；导出 JSON 用 HttpService:JSONEncode(结果)。
]]`;

export function masterModuleSource(rows: MasterRow[] = []): string {
  return `${MASTER_HEADER}\nreturn {\n${rows.map(row => `\t{ en = ${luaString(row.en)}, zh = ${luaString(row.zh)} },\n`).join('')}}\n`;
}
