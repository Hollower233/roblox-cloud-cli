import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from '../core/errors.js';
import { readRbxm, writeRbxm, type ScriptNode } from './rbxm.js';
import { languageModuleSource, luaString, parseLanguageSource, parseMasterSource, type MasterRow } from './lua-table.js';

export const SOURCE_LOCALE = 'en';
export const MASTER_LOCALE = 'zh-hans';
export const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/;

/**
 * The Studio localization table: master rows (en → zh-hans) plus one child module per
 * other locale. The master is read-only for the CLI; child modules are fully regenerated.
 */
export class LocalizationTable {
  constructor(public name: string, public masterSource: string, public rows: MasterRow[], public languages: Map<string, Map<string, string>>) {}

  static fromRbxm(file: Buffer): LocalizationTable {
    const roots = readRbxm(file).filter(node => node.className === 'ModuleScript');
    if (roots.length !== 1) throw new AppError('ARGUMENT_ERROR', 'The .rbxm must contain exactly one root ModuleScript (the localization table).');
    const root = roots[0]!;
    if (root.source === null) throw new AppError('ARGUMENT_ERROR', 'The localization table ModuleScript has no Source.');
    const rows = parseMasterSource(root.source, root.name);
    const languages = new Map<string, Map<string, string>>();
    for (const child of root.children) {
      if (child.className !== 'ModuleScript' || child.source === null) continue;
      if (!LANGUAGE_CODE.test(child.name) || child.name === SOURCE_LOCALE || child.name === MASTER_LOCALE) {
        throw new AppError('ARGUMENT_ERROR', `Unexpected child module ${JSON.stringify(child.name)}; children must be Roblox language codes other than en/zh-hans.`);
      }
      if (languages.has(child.name)) throw new AppError('ARGUMENT_ERROR', `Duplicate language module ${child.name}.`);
      languages.set(child.name, parseLanguageSource(child.source, `${root.name}.${child.name}`));
    }
    // A previous sync output carries the import suffix; the table's real name is without it.
    const name = root.name.endsWith(IMPORT_SUFFIX) ? root.name.slice(0, -IMPORT_SUFFIX.length) : root.name;
    return new LocalizationTable(name, root.source, rows, languages);
  }

  static async load(path: string): Promise<LocalizationTable> {
    let file: Buffer;
    try { file = await readFile(resolve(path)); } catch { throw new AppError('ARGUMENT_ERROR', `Cannot read ${path}.`); }
    return LocalizationTable.fromRbxm(file);
  }

  /** Translation for a source in a locale; zh-hans comes from the master. Empty strings count as missing. */
  get(source: string, locale: string): string | undefined {
    if (locale === MASTER_LOCALE) return this.rows.find(row => row.en === source)?.zh || undefined;
    return this.languages.get(locale)?.get(source) || undefined;
  }

  set(source: string, locale: string, text: string): void {
    if (locale === SOURCE_LOCALE || locale === MASTER_LOCALE) throw new AppError('ARGUMENT_ERROR', 'The CLI never writes en or zh-hans.');
    if (!this.languages.has(locale)) this.languages.set(locale, new Map());
    this.languages.get(locale)!.set(source, text);
  }

  /** Child locales sorted; entries follow master order and drop sources the master no longer has. */
  toRbxm(rootName = this.name): Buffer {
    const children: ScriptNode[] = [...this.languages.keys()].sort().map(locale => {
      const map = this.languages.get(locale)!;
      const rows = this.rows.filter(row => map.get(row.en)).map(row => [row.en, map.get(row.en)!] as [string, string]);
      return { className: 'ModuleScript', name: locale, source: languageModuleSource(locale, rows), children: [] };
    });
    return writeRbxm([{ className: 'ModuleScript', name: rootName, source: this.masterSource, children }]);
  }

  /** Saved under IMPORT_SUFFIX so it can sit beside the live table until studioSwapLuau verifies it. */
  async save(path: string): Promise<string> {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    try { await writeFile(target, this.toRbxm(this.name + IMPORT_SUFFIX)); } catch { throw new AppError('STORAGE_ERROR', `Cannot write ${path}.`); }
    return target;
  }

  /** Number of stored translations no longer referenced by the master (removed on save). */
  orphans(): number {
    const sources = new Set(this.rows.map(row => row.en));
    let count = 0;
    for (const map of this.languages.values()) for (const key of map.keys()) if (!sources.has(key)) count++;
    return count;
  }
}

export const IMPORT_SUFFIX = '__sync';

/** Luau for the agent: after import_rbxm, swap only if the Studio master is unchanged. */
export function studioSwapLuau(parentPath: string, name: string): string {
  return [
    `local parent = ${parentPath}`,
    `local old, new = parent:FindFirstChild(${luaString(name)}), parent:FindFirstChild(${luaString(name + IMPORT_SUFFIX)})`,
    `assert(old and new, "找不到旧表或新导入的表")`,
    `if new.Source ~= old.Source then new:Destroy() return "ABORT: 主表已在 Studio 中改动，已丢弃导入；请重新导出并 sync" end`,
    `old:Destroy()`,
    `new.Name = ${luaString(name)}`,
    `return "OK: 已替换 " .. new:GetFullName() .. "，语言模块 " .. #new:GetChildren()`,
  ].join('\n');
}
