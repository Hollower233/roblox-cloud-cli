import type { Command } from 'commander';
import { CredentialStore } from '../../auth/credentials.js';
import { checkKeyPermissions, permissionFeatures, type PermissionCheckOptions } from '../../auth/permissions.js';
import { AppError, id } from '../../core/errors.js';
import { resolveProfileUniverse } from '../../profiles/copy.js';
import { RobloxApi } from '../../roblox/api.js';
import type { LocalStore } from '../../storage/store.js';
import { HttpClient } from '../../transport/http-client.js';
import { clean, emit } from '../output.js';

const labels = { configured: '已配置', missing: '缺少权限', 'out-of-scope': '资源范围不匹配', unknown: '范围未确认' };
const targetLabels = { none: '无资源筛选；仍需账号实际访问权', universe: '目标游戏', 'universe-datastore': '目标游戏及 DataStore', creator: '素材所属用户或群组' };
const disclaimer = '仅检查 Key 配置；未验证账号/群组角色、素材访问权或真实业务请求。';
const dashboard = 'https://create.roblox.com/dashboard/credentials';

export function registerAuthPermissions(auth: Command, context: { store(): LocalStore; json(): boolean; signal: AbortSignal }): void {
  auth.command('permissions').description('List API key requirements offline, grouped by feature')
    .option('--for <feature>', 'Feature ID (see unfiltered output for all values)')
    .action((options: { for?: string }) => {
      const features = permissionFeatures(options.for);
      const human = features.map(item => `${item.id} — ${item.description}\n  命令：${item.commands.map(command => `rbx ${command}`).join(' / ')}\n` +
        (item.requirements.map(row => `  ${row.scope} | API 系统：${row.system} | 操作：${row.operation} | 范围：${targetLabels[row.target]}`).join('\n') || '  无需 Roblox API 权限。') +
        item.notes.map(note => `\n  注：${note}`).join('')).join('\n\n');
      emit({ features, dashboard, disclaimer }, context.json(), `${human}\n\n配置页面：${dashboard}\n${disclaimer}\nAPI 系统名称为说明性分组，Dashboard 的显示名称可能不同。`);
    });
  auth.command('check').description('Inspect active key configuration without executing business operations')
    .option('--for <feature>', 'Check one feature; defaults to every feature')
    .option('--universe <id-or-name>', 'Target Universe ID or exact cached game name')
    .option('--datastore <name>', 'Exact DataStore name (requires --universe)')
    .action(async (options: { for?: string; universe?: string; datastore?: string }) => {
      permissionFeatures(options.for); // Reject unknown features before reading credentials or contacting Roblox.
      if (options.datastore !== undefined && (!options.datastore.trim() || !options.universe)) throw new AppError('ARGUMENT_ERROR', '--datastore requires a non-empty name and --universe.');
      const local = context.store();
      let universeId: string | undefined;
      if (options.universe !== undefined) {
        const input = options.universe.trim();
        if (/^\d+$/.test(input)) universeId = id(input);
        else {
          const config = await local.config(), catalog = config.currentUserId ? await local.catalog(config.currentUserId) : null;
          universeId = resolveProfileUniverse(input, catalog?.games);
        }
      }
      const key = await new CredentialStore(local.home).get();
      const identity = await new RobloxApi(new HttpClient({ signal: context.signal }), key).inspectKey();
      const selection: PermissionCheckOptions = { feature: options.for, universeId, datastore: options.datastore };
      const result = { ...checkKeyPermissions(identity, selection), source: process.env.ROBLOX_API_KEY !== undefined ? 'environment' : 'Windows DPAPI', dashboard, disclaimer };
      const warnings = [];
      if (result.keyState !== 'active') warnings.push({ code: 'AUTH_INVALID', message: 'Key 已禁用或过期。权限配置不代表 Key 可用。' });
      for (const item of result.features) {
        if (item.state !== 'configured') warnings.push({ code: item.state === 'missing' ? 'MISSING_PERMISSION' : item.state === 'out-of-scope' ? 'RESOURCE_OUT_OF_SCOPE' : 'RESOURCE_SCOPE_UNKNOWN', message: `${item.id}: ${labels[item.state]}`, resource: item.id });
      }
      const human = [`User: ${result.userId}`, `Key: ${result.keyState} (${result.source})`,
        ...(universeId ? [`Universe: ${universeId}`] : []), ...(options.datastore ? [`DataStore: ${clean(options.datastore)}`] : []),
        ...result.features.map(item => `${item.id} — ${labels[item.state]}\n` + item.requirements.map(row => `  ${labels[row.state]} ${row.scope}：${row.reason}`).join('\n')),
        '查看详细配置要求：rbx auth permissions' + (options.for ? ` --for ${options.for}` : ''), `配置页面：${dashboard}`, disclaimer].join('\n');
      emit(result, context.json(), human, warnings);
      if (result.keyState !== 'active') process.exitCode = 4;
    });
}
