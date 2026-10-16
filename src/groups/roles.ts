import { AppError, errorInfo, id } from '../core/errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpClient } from '../transport/http-client.js';
import type { Identity } from '../universes/models.js';

export interface GroupRole { id: string; path: string; name: string; rank?: number; management: 'unknown' }
export interface GroupMember { userId: string; path: string; roles: string[] }
export interface RoleSelector { name?: string; id?: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_RESPONSE', 'Invalid group response.');
  return value as Record<string, unknown>;
}
function resource(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(value.slice(prefix.length))) throw new AppError('INVALID_RESPONSE', 'Invalid group resource path.');
  if (!Number.isSafeInteger(Number(value.slice(prefix.length)))) throw new AppError('INVALID_RESPONSE', 'Invalid group resource ID.');
  return value;
}
function membershipResource(value: unknown, groupId: string): string {
  const prefix = `groups/${groupId}/memberships/`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) {
    throw new AppError('INVALID_RESPONSE', 'Invalid group membership resource path.');
  }
  return value;
}
export function groupPlayerInput(input: string): string {
  return input.split(/[,\r\n]+/).map(value => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('https://')) return trimmed;
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new AppError('ARGUMENT_ERROR', 'Invalid Roblox profile URL.'); }
    const match = /^\/users\/([1-9]\d*)\/profile\/?$/.exec(url.pathname);
    if (!['www.roblox.com', 'roblox.com'].includes(url.host) || url.username || url.password || !match) throw new AppError('ARGUMENT_ERROR', 'Expected a Roblox user profile URL.');
    return id(match[1]!);
  }).join(',');
}

export class GroupRoles {
  constructor(private http: HttpClient, private identity: Identity) {}
  private scope(operation: 'read' | 'write'): void {
    if (!this.identity.enabled || this.identity.expired) throw new AppError('AUTH_INVALID', 'The API key is disabled or expired.');
    if (!this.identity.scopes.some(scope => scope.name === 'group' && scope.operations.includes(operation))) {
      throw new AppError('FORBIDDEN', `API key requires group:${operation}. Account and resource permissions are also enforced by Roblox.`);
    }
  }
  private async list(groupId: string, collection: 'roles' | 'memberships', filter?: string): Promise<unknown[]> {
    this.scope('read'); id(groupId);
    const result: unknown[] = [], tokens = new Set<string>();
    let token = '';
    do {
      const url = new URL(`https://apis.roblox.com/cloud/v2/groups/${groupId}/${collection}`);
      url.searchParams.set('maxPageSize', collection === 'roles' ? '20' : '100');
      if (filter) url.searchParams.set('filter', filter);
      if (token) url.searchParams.set('pageToken', token);
      const response = object(await this.http.request(url.toString(), { auth: true }));
      const rows = response[collection === 'roles' ? 'groupRoles' : 'groupMemberships'];
      if (!Array.isArray(rows)) throw new AppError('INVALID_RESPONSE', 'Missing group collection.');
      result.push(...rows);
      if (response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string') throw new AppError('INVALID_RESPONSE', 'Invalid group page token.');
      token = response.nextPageToken as string ?? '';
      if (token && tokens.has(token)) throw new AppError('INVALID_RESPONSE', 'Repeated group page token.');
      tokens.add(token);
    } while (token);
    return result;
  }
  async roles(groupId: string): Promise<GroupRole[]> {
    const rows = await this.list(groupId, 'roles');
    const roles = rows.map(value => {
      const row = object(value), path = resource(row.path, `groups/${groupId}/roles/`);
      const roleId = path.split('/').at(-1)!;
      if (row.id !== roleId || typeof row.displayName !== 'string' || (row.rank !== undefined && (!Number.isInteger(row.rank) || Number(row.rank) < 0 || Number(row.rank) > 255))) throw new AppError('INVALID_RESPONSE', 'Invalid group role.');
      return { id: roleId, path, name: row.displayName, ...(row.rank !== undefined ? { rank: Number(row.rank) } : {}), management: 'unknown' as const };
    });
    if (new Set(roles.map(role => role.id)).size !== roles.length) throw new AppError('INVALID_RESPONSE', 'Duplicate group roles.');
    return roles;
  }
  async member(groupId: string, userId: string): Promise<GroupMember | null> {
    id(userId);
    const rows = await this.list(groupId, 'memberships', `user == 'users/${userId}'`);
    if (!rows.length) return null;
    if (rows.length !== 1) throw new AppError('INVALID_RESPONSE', 'Multiple memberships for one user.');
    const row = object(rows[0]);
    if (row.user !== `users/${userId}` || !Array.isArray(row.roles)) throw new AppError('INVALID_RESPONSE', 'Missing complete member roles or mismatched user.');
    return { userId, path: membershipResource(row.path, groupId), roles: row.roles.map(role => resource(role, `groups/${groupId}/roles/`)) };
  }
  async change(groupId: string, selector: RoleSelector, userIds: string[], action: 'grant' | 'revoke', dryRun = false) {
    id(groupId);
    if (!['grant', 'revoke'].includes(action)) throw new AppError('ARGUMENT_ERROR', 'Invalid role action.');
    if (Boolean(selector.name) === Boolean(selector.id)) throw new AppError('ARGUMENT_ERROR', 'Provide exactly one role name or role ID.');
    if (selector.id) id(selector.id);
    if (!userIds.length || userIds.length > 100) throw new AppError('ARGUMENT_ERROR', 'Provide 1–100 players.');
    userIds.forEach(id);
    this.scope('write'); this.scope('read');
    const matches = (await this.roles(groupId)).filter(role => selector.id ? role.id === selector.id : role.name === selector.name);
    if (matches.length !== 1) throw new AppError('ARGUMENT_ERROR', matches.length ? 'Ambiguous role name; use --role-id.' : 'Role not found or not visible to this account.');
    const role = matches[0]!;
    if (role.id === '0' || role.rank === 0 || role.rank === 255) throw new AppError('FORBIDDEN', 'Guest and owner roles cannot be assigned or removed by this command.');
    const results = [];
    for (const userId of new Set(userIds)) {
      let attempted = false;
      try {
        if (userId === this.identity.userId) throw new AppError('FORBIDDEN', 'Changing your own group roles is not supported.');
        const before = await this.member(groupId, userId);
        if (!before) { results.push({ userId, status: 'not-member' as const }); continue; }
        const wanted = action === 'grant';
        if (before.roles.includes(role.path) === wanted) { results.push({ userId, status: 'unchanged' as const }); continue; }
        if (dryRun) { results.push({ userId, status: 'planned' as const, rolesBefore: before.roles }); continue; }
        attempted = true;
        await this.http.request(`https://apis.roblox.com/cloud/v2/${before.path}:${wanted ? 'assignRole' : 'unassignRole'}`, { auth: true, body: { role: role.path } });
        // Reads may lag behind a successful mutation. Retry verification reads
        // only; never resubmit the mutation.
        let after: GroupMember | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt) await delay(300 * attempt);
          after = await this.member(groupId, userId);
          if (after && after.roles.includes(role.path) === wanted) break;
        }
        if (!after || after.roles.includes(role.path) !== wanted) throw new AppError('INVALID_RESPONSE', 'Role change could not be verified. Re-query this member before retrying.');
        results.push({ userId, status: 'success' as const, rolesBefore: before.roles, rolesAfter: after.roles });
      } catch (error) {
        const info = errorInfo(error);
        if (info.httpStatus === 403) info.message = 'Roblox denied this role change. Check account permissions, role hierarchy and resource access; the exact cause is unavailable.';
        results.push({ userId, status: attempted && ![400, 401, 403, 404, 429].includes(info.httpStatus ?? 0) ? 'unverified' as const : 'error' as const, error: info });
        if (info.code === 'CANCELLED' || info.code === 'AUTH_INVALID') break;
      }
    }
    return { groupId, role, action, dryRun, results, skipped: new Set(userIds).size - results.length };
  }
}
