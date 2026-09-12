import { AppError, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import type { RobloxGateway, Identity, Group, Page, Permissions, UniverseMetadata, GameDetails } from '../universes/models.js';

function object(x: unknown): Record<string, any> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new AppError('INVALID_RESPONSE', 'Expected a Roblox JSON object.');
  return x as Record<string, any>;
}
function array(x: unknown): unknown[] { if (!Array.isArray(x)) throw new AppError('INVALID_RESPONSE', 'Expected a Roblox JSON array.'); return x; }
function text(x: unknown): string { if (typeof x !== 'string') throw new AppError('INVALID_RESPONSE', 'Expected a Roblox string.'); return x; }
function bool(x: unknown): boolean { if (typeof x !== 'boolean') throw new AppError('INVALID_RESPONSE', 'Expected a Roblox boolean.'); return x; }
function apiId(x: unknown): string { try { return id(String(x)); } catch { throw new AppError('INVALID_RESPONSE', 'Invalid Roblox ID.'); } }
export class RobloxApi implements RobloxGateway {
  constructor(private http: HttpClient, private apiKey: string) {}
  async identity(): Promise<Identity> {
    const d = object(await this.http.request('https://apis.roblox.com/api-keys/v1/introspect', { body: { apiKey: this.apiKey } }));
    const result = { userId: apiId(d.authorizedUserId), enabled: bool(d.enabled), expired: bool(d.expired), scopes: array(d.scopes).map(s => { const v = object(s); return { name: text(v.name), operations: array(v.operations).map(text) }; }) };
    if (!result.enabled || result.expired) throw new AppError('AUTH_INVALID', 'The API key is disabled or expired.');
    return result;
  }
  async manageableGroups(): Promise<Group[]> {
    const d = object(await this.http.request('https://apis.roblox.com/legacy-develop/v1/user/groups/canmanage', { auth: true }));
    return array(d.data).map(x => { const g = object(x); return { id: apiId(g.id), name: text(g.name) }; });
  }
  private async page(url: string, cursor?: string): Promise<Page> {
    const u = new URL(url); if (cursor) u.searchParams.set('cursor', cursor);
    const d = object(await this.http.request(u.toString()));
    return { games: array(d.data).map(x => { const g = object(x); return { id: apiId(g.id), name: text(g.name) }; }), cursor: d.nextPageCursor == null ? null : text(d.nextPageCursor) };
  }
  userGames(userId: string, cursor?: string): Promise<Page> { return this.page(`https://games.roblox.com/v2/users/${id(userId)}/games?accessFilter=2&limit=50`, cursor); }
  groupGames(groupId: string, cursor?: string): Promise<Page> { return this.page(`https://games.roblox.com/v2/groups/${id(groupId)}/gamesV2?accessFilter=1&limit=50`, cursor); }
  async permissions(universeId: string): Promise<Permissions> {
    const d = object(await this.http.request(`https://apis.roblox.com/legacy-develop/v1/universes/${id(universeId)}/permissions`, { auth: true }));
    return { canManage: bool(d.canManage), canCloudEdit: bool(d.canCloudEdit) };
  }
  async metadata(universeId: string): Promise<UniverseMetadata> {
    const d = object(await this.http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }));
    return { name: text(d.displayName), visibility: d.visibility === 'PUBLIC' || d.visibility === 'PRIVATE' ? d.visibility : 'UNKNOWN' };
  }
  async details(universeIds: string[]): Promise<GameDetails[]> {
    if (!universeIds.length) return [];
    if (universeIds.length > 50) throw new AppError('ARGUMENT_ERROR', 'Details requests accept at most 50 IDs.');
    const d = object(await this.http.request(`https://games.roblox.com/v1/games?universeIds=${universeIds.map(id).join(',')}`));
    return array(d.data).map(x => {
      const g = object(x), owner = object(g.creator);
      if (!['User', 'Group'].includes(owner.type) || !Number.isSafeInteger(g.playing) || g.playing < 0) throw new AppError('INVALID_RESPONSE', 'Invalid game owner or CCU.');
      return { id: apiId(g.id), name: text(g.name), owner: { id: apiId(owner.id), name: text(owner.name), type: owner.type }, ccu: g.playing };
    });
  }
}
