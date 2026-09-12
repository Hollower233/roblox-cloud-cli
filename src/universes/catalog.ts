import { AppError, errorInfo, id } from '../core/errors.js';
import type { Catalog, Game, Identity, Owner, Page, RobloxGateway, Warning } from './models.js';

export const coverage = 'Personal public games; manageable group games; manually registered universes. Personal private discovery is unavailable.';
const coverageWarning = (): Warning => ({ code: 'PERSONAL_PRIVATE_DISCOVERY_UNAVAILABLE', message: 'Personal private games are not included automatically; use universe add.' });
function warning(error: unknown, resource: string): Warning { return { ...errorInfo(error), resource }; }
function propagateCancel(error: unknown): void { if (error instanceof AppError && error.code === 'CANCELLED') throw error; }
export interface CatalogOptions { now?: () => string; progress?: (message: string) => void; signal?: AbortSignal }
export class CatalogService {
  private now: () => string;
  constructor(private api: RobloxGateway, private options: CatalogOptions = {}) { this.now = options.now ?? (() => new Date().toISOString()); }
  private check(): void { if (this.options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.'); }
  private base(identity: Identity, old: Catalog | null): Catalog {
    if (old && old.userId !== identity.userId) throw new AppError('STORAGE_ERROR', 'Catalog belongs to a different account.');
    return old ? structuredClone(old) : { schemaVersion: 1, userId: identity.userId, coverage, games: [], warnings: [] };
  }
  private game(universeId: string, name: string, owner: Owner, at: string): Game {
    return { universeId, name, owner, visibility: 'UNKNOWN', ccu: null, permissions: null, discoveredAt: at, lastSeenAt: at, discoveryState: 'seen', errors: [] };
  }
  async scan(identity: Identity, old: Catalog | null, manualIds: string[] = []): Promise<Catalog> {
    const catalog = this.base(identity, old), at = this.now();
    const games = new Map(catalog.games.map(g => [g.universeId, g]));
    const seen = new Set<string>(), failedOwners = new Set<string>();
    catalog.warnings = [coverageWarning()];
    let groupsFailed = false;
    const discover = async (owner: Owner, request: (cursor?: string) => Promise<Page>) => {
      const cursors = new Set<string>(); let cursor: string | undefined;
      try {
        do {
          this.check(); const page = await request(cursor);
          for (const row of page.games) {
            seen.add(row.id);
            const g = games.get(row.id) ?? this.game(row.id, row.name, owner, at);
            g.name = row.name; g.owner = owner; g.lastSeenAt = at; g.discoveryState = 'seen'; g.errors = [];
            games.set(row.id, g);
          }
          cursor = page.cursor ?? undefined;
          if (cursor && cursors.has(cursor)) throw new AppError('INVALID_RESPONSE', 'Pagination repeated a cursor.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      } catch (e) { propagateCancel(e); failedOwners.add(`${owner.type}:${owner.id}`); catalog.warnings.push(warning(e, `${owner.type}:${owner.id}`)); }
    };
    await discover({ id: identity.userId, name: `User ${identity.userId}`, type: 'User' }, cursor => this.api.userGames(identity.userId, cursor));
    try {
      this.check(); const groups = await this.api.manageableGroups();
      for (const group of groups) {
        this.options.progress?.(`Scanning ${group.name} (${group.id})`);
        await discover({ ...group, type: 'Group' }, cursor => this.api.groupGames(group.id, cursor));
      }
    } catch (e) { propagateCancel(e); groupsFailed = true; catalog.warnings.push(warning(e, 'manageable-groups')); }
    for (const universeId of manualIds) {
      id(universeId); seen.add(universeId);
      if (!games.has(universeId)) games.set(universeId, this.game(universeId, universeId, { id: identity.userId, name: 'Unknown', type: 'User' }, at));
      games.get(universeId)!.discoveryState = 'seen';
    }
    for (const game of games.values()) {
      if (!seen.has(game.universeId)) game.discoveryState = (groupsFailed && game.owner.type === 'Group') || failedOwners.has(`${game.owner.type}:${game.owner.id}`) ? 'stale' : 'not-seen';
    }
    catalog.games = [...games.values()];
    await this.enrich(catalog, catalog.games.filter(g => seen.has(g.universeId)));
    catalog.scannedAt = this.now(); return catalog;
  }
  async refresh(identity: Identity, old: Catalog): Promise<Catalog> {
    const catalog = this.base(identity, old);
    // Refresh metadata cannot repair a failed discovery; preserve discovery warnings.
    catalog.warnings = catalog.warnings.filter(w => !w.resource?.startsWith('universe:'));
    await this.enrich(catalog, catalog.games); catalog.refreshedAt = this.now(); return catalog;
  }
  async add(identity: Identity, old: Catalog | null, universeId: string): Promise<Catalog> {
    id(universeId); this.check();
    const permissions = await this.api.permissions(universeId);
    if (!permissions.canManage) throw new AppError('FORBIDDEN', 'This account cannot manage the requested universe.');
    const catalog = this.base(identity, old), at = this.now();
    const game = catalog.games.find(g => g.universeId === universeId) ?? this.game(universeId, universeId, { id: identity.userId, name: 'Unknown', type: 'User' }, at);
    if (!catalog.games.includes(game)) catalog.games.push(game);
    game.permissions = permissions; game.permissionsAt = at; game.discoveryState = 'seen'; game.lastSeenAt = at;
    catalog.warnings = catalog.warnings.filter(w => w.resource !== `universe:${universeId}`);
    await this.enrich(catalog, [game]); catalog.refreshedAt = this.now(); return catalog;
  }
  private async enrich(catalog: Catalog, games: Game[]): Promise<void> {
    for (const game of games) game.errors = [];
    for (let start = 0; start < games.length; start += 50) {
      const batch = games.slice(start, start + 50);
      try {
        this.check(); const details = await this.api.details(batch.map(g => g.universeId));
        const byId = new Map(details.map(d => [d.id, d]));
        for (const game of batch) {
          const d = byId.get(game.universeId);
          if (!d) { game.errors.push({ code: 'DETAILS_UNAVAILABLE', message: 'Game details were omitted by Roblox.', resource: `universe:${game.universeId}` }); continue; }
          game.owner = d.owner; game.ccu = d.ccu; game.name = d.name; game.detailsAt = this.now();
        }
      } catch (e) { propagateCancel(e); for (const game of batch) game.errors.push(warning(e, `universe:${game.universeId}`)); }
    }
    for (const game of games) {
      this.check(); this.options.progress?.(`Checking ${game.name} (${game.universeId})`);
      try { game.permissions = await this.api.permissions(game.universeId); game.permissionsAt = this.now(); }
      catch (e) { propagateCancel(e); game.errors.push(warning(e, `universe:${game.universeId}`)); /* Keep last known permissions and their timestamp. */ }
      try { const d = await this.api.metadata(game.universeId); game.name = d.name; game.visibility = d.visibility; game.metadataAt = this.now(); }
      catch (e) { propagateCancel(e); game.errors.push(warning(e, `universe:${game.universeId}`)); }
      catalog.warnings.push(...game.errors);
    }
  }
}
export function selectGames(catalog: Catalog, filters: { owner?: string; visibility?: string; sort?: string; all?: boolean } = {}): Game[] {
  let games = catalog.games.filter(g => filters.all || g.permissions?.canManage === true);
  if (filters.owner) games = games.filter(g => g.owner.id === filters.owner || g.owner.name.toLowerCase().includes(filters.owner!.toLowerCase()));
  if (filters.visibility) games = games.filter(g => g.visibility === filters.visibility!.toUpperCase());
  return games.sort(filters.sort === 'ccu' ? (a, b) => (b.ccu ?? -1) - (a.ccu ?? -1) || a.universeId.localeCompare(b.universeId) : (a, b) => a.name.localeCompare(b.name));
}
