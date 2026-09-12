import type { Catalog, Game, Warning } from '../universes/models.js';

export function clean(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' '); }
function width(value: string): number { return [...value].reduce((n, c) => n + (/\p{Mark}/u.test(c) ? 0 : c.codePointAt(0)! > 0xff ? 2 : 1), 0); }
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map(row => width(row[col] ?? ''))));
  return rows.map(row => row.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - width(cell)))).join('  ').trimEnd()).join('\n');
}
export function renderCatalog(catalog: Catalog, games: Game[]): string {
  const rows = [['游戏名', 'OWNER', '状态', 'CCU', 'UNIVERSE ID', '记录状态']];
  for (const game of games) rows.push([
    clean(game.name), clean(`${game.owner.name}（${game.owner.type === 'User' ? '个人' : '群组'}）`),
    game.visibility === 'PUBLIC' ? '公开' : game.visibility === 'PRIVATE' ? '私密' : '未知',
    game.ccu === null ? '—' : game.ccu >= 1000 ? `${(game.ccu / 1000).toFixed(1)}k` : String(game.ccu),
    game.universeId,
    game.errors.length ? '部分信息未刷新' : game.discoveryState === 'stale' ? '扫描未刷新' : game.discoveryState === 'not-seen' ? '本次未发现' : game.permissions === null ? '权限未知' : game.permissions.canManage ? '已验证' : '无管理权限',
  ]);
  return `${table(rows)}\n\n${games.length} 个游戏；账号 ${catalog.userId}\n上次扫描：${catalog.scannedAt ?? '尚未扫描'}\n上次信息刷新：${catalog.refreshedAt ?? catalog.scannedAt ?? '—'}\n覆盖范围：${catalog.coverage}`;
}
export function emit(data: unknown, json: boolean, human: string, warnings: Warning[] = []): void {
  const status = warnings.length ? 'partial' : 'success';
  if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, status, data, warnings }) + '\n');
  else {
    process.stdout.write(human + '\n');
    for (const w of warnings) process.stderr.write(`Warning [${clean(w.code)}] ${clean(w.resource ?? '')} ${clean(w.message)}\n`);
  }
  if (warnings.length) process.exitCode = 3;
}
