import { AppError, id } from '../core/errors.js';
import type { Identity, KeyScope } from '../universes/models.js';

export type PermissionTarget = 'none' | 'universe' | 'universe-datastore' | 'creator';
export interface PermissionRequirement { scope: string; system: string; operation: string; target: PermissionTarget }
export interface PermissionFeature { id: string; description: string; commands: string[]; requirements: PermissionRequirement[]; notes: string[] }
export interface PermissionCheckOptions { feature?: string; universeId?: string; datastore?: string }
export type PermissionState = 'configured' | 'missing' | 'out-of-scope' | 'unknown';
export interface PermissionCheckRow extends PermissionRequirement { state: PermissionState; reason: string }
export interface FeaturePermissionCheck { id: string; description: string; state: PermissionState; requirements: PermissionCheckRow[] }

// Based on the authenticated calls in src/ and Roblox's feature reference.
// Keep operations separate: grants for different operations may target different resources.
const requirements: Record<string, [string, PermissionTarget]> = {
  'legacy-group': ['Groups (Legacy)', 'none'], 'legacy-universe': ['Universes (Legacy)', 'none'],
  'legacy-asset': ['Assets (Legacy)', 'none'], universe: ['Universes', 'universe'],
  'universe.place': ['Universes / Places', 'universe'],
  'universe.user-restriction': ['User Restrictions', 'universe'],
  'universe.ordered-data-store.scope.entry': ['Ordered Data Stores', 'universe'],
  'universe-datastores.objects': ['Data Stores / Objects', 'universe-datastore'],
  'universe-datastores.versions': ['Data Stores / Versions', 'universe-datastore'],
  'developer-product': ['Developer Products', 'universe'], group: ['Groups', 'none'], asset: ['Assets', 'creator'],
};
function feature(featureId: string, description: string, commands: string[], scopes: string[], notes: string[] = []): PermissionFeature {
  return { id: featureId, description, commands, notes, requirements: scopes.map(scope => {
    const [name, operation] = scope.split(':');
    const [system, target] = requirements[name!]!;
    return { scope, system, operation: operation!, target };
  }) };
}
const read = 'universe-datastores.objects:read';
const copy = [read, 'universe-datastores.objects:create', 'universe-datastores.objects:update'];
const history = ['universe-datastores.versions:list', read];
const rw = ['universe:read', 'universe:write'];
const iconRead = ['universe:read', 'asset:read'];
const iconWrite = [...iconRead, 'asset:write'];
const features: PermissionFeature[] = [
  feature('universe-scan', '扫描游戏目录', ['universe scan'], ['legacy-group:manage', 'legacy-universe:manage', 'universe:read']),
  feature('universe-refresh', '验证并刷新游戏目录', ['universe refresh', 'universe add'], ['legacy-universe:manage', 'universe:read']),
  feature('datastore-get', '读取单条存档', ['datastore get'], [read]),
  feature('datastore-list', '列出存档键', ['datastore list'], ['universe-datastores.objects:list'], ['--with-values 另需 datastore-get 的权限。']),
  feature('datastore-copy', '复制存档（目标游戏）', ['datastore copy'], copy, ['此项检查目标游戏；源游戏请使用 --for datastore-get 单独检查 read。']),
  feature('profile-copy', '复制 ProfileService 玩家存档（目标游戏）', ['profile copy'], copy, ['此项检查目标游戏；源游戏请使用 --for datastore-get 单独检查 read。默认 DataStore 为 Default。']),
  feature('profile-clear', '清除玩家存档', ['profile clear'], [read, 'universe-datastores.objects:delete']),
  feature('profile-history', '读取玩家历史存档', ['profile history'], history, ['历史内容实际通过 Cloud v2 entries 读取，需要 objects:read。']),
  feature('ordered-read', '读取排行榜和分数', ['datastore ordered list', 'datastore ordered get'], ['universe.ordered-data-store.scope.entry:read']),
  feature('devproduct-list', '查询开发者产品', ['devproduct list'], ['developer-product:read']),
  feature('devproduct-sync', '同步开发者产品', ['devproduct sync'], ['developer-product:read', 'developer-product:write']),
  feature('devproduct-icon', '上传开发者产品图标', ['devproduct icon'], ['developer-product:read', 'developer-product:write']),
  feature('configs-read', '读取配置草稿、发布值和历史', ['configs read', 'configs draft read', 'configs history'], ['universe:read']),
  feature('configs-write', '修改、发布和恢复配置', ['configs draft set', 'configs publish', 'configs restore'], rw),
  feature('experiments-read', '查询实验和异步操作', ['experiments list', 'experiments get', 'experiments operation', 'experiments stats'], ['universe:read']),
  feature('experiments-write', '创建和修改实验', ['experiments create', 'experiments update', 'experiments start', 'experiments schedule', 'experiments complete'], rw),
  feature('places-list', '查询 Place 与人数上限', ['places list'], ['universe:read', 'universe.place:read']),
  feature('places-update', '修改 Place 人数上限', ['places update'], ['universe:read', 'universe.place:read', 'universe.place:write']),
  feature('servers-status', '预估服务器重启影响', ['servers status'], ['universe:read']),
  feature('servers-restart', '重启服务器', ['servers restart'], ['universe:write']),
  feature('restriction-get', '查询玩家封禁', ['ban-status'], ['universe.user-restriction:read']),
  feature('restriction-write', '封禁或解封玩家', ['ban', 'unban'], ['universe.user-restriction:write']),
  feature('group-read', '查询群组角色和成员', ['group roles', 'group member'], ['group:read']),
  feature('group-write', '添加或移除群组角色', ['group role grant', 'group role revoke'], ['group:read', 'group:write']),
  feature('asset-download', '下载素材原图', ['asset download'], ['legacy-asset:manage'], ['下载目标素材的实际访问权仍由 Roblox 校验。']),
  feature('icon-generate', '获取当前图标并合成倒计时', ['icon generate'], [...iconRead, 'legacy-asset:manage']),
  feature('icon-countdown', '自动生成并运行图标倒计时', ['icon countdown', 'icon now', 'icon restore', 'icon resume'], [...iconWrite, 'legacy-asset:manage'], ['旧文件夹模式不下载底图，无需 legacy-asset:manage。素材的 Owner 范围需要单独核实。']),
  feature('localization-read', '读取游戏标题和简介', ['localization read'], ['universe:read']),
  feature('localization-write', '修改游戏标题和简介', ['localization write'], ['universe:read', 'legacy-universe:manage', 'universe.place:write'], ['仅修改其他语言时无需 universe.place:write；源语言通过根 Place 修改。']),
  feature('localization-table', '管理云端游戏内本地化表', ['localization enable', 'localization sync', 'localization import'], ['legacy-universe:manage'], ['本地 init/export/show 不需 Roblox 权限；DeepSeek 翻译另需独立 Key。']),
  feature('studio-publish-verify', '复核 Studio 覆盖发布版本', ['studio publish-as'], ['asset:read'], ['仅覆盖后的版本复核需要；此权限不会授权 Studio 发布。']),
  feature('local', '本机及公开查询功能', ['auth permissions', 'universe list', 'player', 'cache clear', 'studio open', 'studio close', 'studio list', 'icon status', 'localization init', 'localization export', 'localization show'], [], ['本地缓存、玩家清单及 Studio 会话操作不需要 Roblox API Key。']),
];

/** Returns independent copies so SDK consumers cannot mutate the built-in catalog. */
export function permissionFeatures(featureId?: string): PermissionFeature[] {
  const selected = featureId === undefined ? features : features.filter(item => item.id === featureId);
  if (!selected.length) throw new AppError('ARGUMENT_ERROR', 'Unknown permission feature. Run rbx auth permissions for valid --for values.');
  return structuredClone(selected);
}
function targetState(scope: KeyScope, requirement: PermissionRequirement, options: PermissionCheckOptions): Pick<PermissionCheckRow, 'state' | 'reason'> {
  const state = (value: PermissionState, reason: string) => ({ state: value, reason });
  if (requirement.target === 'none') return state('configured', '权限已配置；账号实际访问权仍由 Roblox 校验。');
  if (requirement.target === 'creator') return state('unknown', '权限已配置；此检查未核实素材所属用户或群组范围。');
  if (!options.universeId) return state('unknown', '权限已配置；请用 --universe 指定目标游戏以检查资源范围。');
  if (requirement.target === 'universe') {
    // Roblox user-owned keys may omit experience restrictions entirely.
    if (scope.universeIds === undefined || scope.universeIds.includes('*') || scope.universeIds.includes(options.universeId)) return state('configured', '游戏范围覆盖目标；未验证账号实际访问权。');
    return state('out-of-scope', '权限存在，但游戏范围未覆盖目标。');
  }
  if (scope.universeDatastores === undefined) return state('unknown', '响应未提供 DataStore 范围，无法确认。');
  const targets = scope.universeDatastores.filter(item => item.universeId === '*' || item.universeId === options.universeId);
  if (!targets.length) return state('out-of-scope', 'DataStore 权限未覆盖目标游戏。');
  if (targets.some(item => item.datastoreName === '*')) return state('configured', '目标游戏的全部 DataStore 已包含。');
  if (!options.datastore) return state('unknown', '权限限定了 DataStore；请用 --datastore 指定名称。');
  return targets.some(item => item.datastoreName === options.datastore)
    ? state('configured', 'DataStore 范围覆盖目标；未验证账号实际访问权。')
    : state('out-of-scope', '权限存在，但未覆盖目标 DataStore。');
}
export function checkKeyPermissions(identity: Identity, options: PermissionCheckOptions = {}) {
  if (options.universeId !== undefined) id(options.universeId);
  if (options.datastore !== undefined && (!options.datastore.trim() || !options.universeId)) throw new AppError('ARGUMENT_ERROR', '--datastore requires a non-empty name and --universe.');
  const aggregate = (states: PermissionState[]): PermissionState => states.includes('missing') ? 'missing' : states.includes('out-of-scope') ? 'out-of-scope' : states.includes('unknown') ? 'unknown' : 'configured';
  const results: FeaturePermissionCheck[] = permissionFeatures(options.feature).map(item => {
    const rows = item.requirements.map(requirement => {
      const split = requirement.scope.lastIndexOf(':'), name = requirement.scope.slice(0, split);
      const grants = identity.scopes.filter(scope => scope.name === name && scope.operations.includes(requirement.operation));
      if (!grants.length) return { ...requirement, state: 'missing' as const, reason: '缺少此操作权限。' };
      const targets = grants.map(scope => targetState(scope, requirement, options));
      const best = targets.find(row => row.state === 'configured') ?? targets.find(row => row.state === 'unknown') ?? targets[0]!;
      return { ...requirement, ...best };
    });
    return { id: item.id, description: item.description, state: aggregate(rows.map(row => row.state)), requirements: rows };
  });
  return { userId: identity.userId, enabled: identity.enabled, expired: identity.expired,
    keyState: !identity.enabled ? 'disabled' : identity.expired ? 'expired' : 'active',
    configurationState: aggregate(results.map(row => row.state)), universeId: options.universeId ?? null, datastore: options.datastore ?? null,
    features: results, businessAccessVerified: false as const };
}
