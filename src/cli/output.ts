import type { Catalog, Game, Warning } from '../universes/models.js';
import type { CountdownNodeView } from '../icons/countdown.js';

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

function pad(n: number): string { return String(n).padStart(2, '0'); }
export function localTime(value: string | number): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function remaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000)), days = Math.floor(total / 86400);
  const clock = `${pad(Math.floor(total % 86400 / 3600))}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`;
  return days ? `${days}天 ${clock}` : clock;
}
export function renderIconPlan(target: string, nodes: CountdownNodeView[], skipped: string[], restoreAt: string | null = null): string {
  const status = { done: '已完成', pending: '待执行', missed: '已错过' } as const;
  const rows = [['节点', '切换时间', '文件', '状态'], ...nodes.map(node => [clean(node.label), localTime(node.fireAt), clean(node.file), status[node.status]])];
  if (restoreAt) rows.push(['restore', localTime(restoreAt), '原图标', '待执行']);
  return `目标时刻：${localTime(target)}\n${table(rows)}${skipped.length ? `\n跳过（超出剩余时间）：${skipped.map(clean).join(', ')}` : ''}`;
}
