import type { RobloxGateway, Identity, Catalog, Page, GameDetails, Game } from '../../src/universes/models.js';
export const identity: Identity = { userId: '100', enabled: true, expired: false, scopes: [{ name: 'legacy-group', operations: ['manage'] }, { name: 'legacy-universe', operations: ['manage'] }] };
export function savedGame(universeId = '1'): Game {
  return { universeId, name: `Game ${universeId}`, owner: { id: '200', name: 'Studio', type: 'Group' }, visibility: 'PRIVATE', ccu: 42, permissions: { canManage: true, canCloudEdit: true }, discoveredAt: '2020-01-01', lastSeenAt: '2020-01-01', permissionsAt: '2020-01-01', detailsAt: '2020-01-01', metadataAt: '2020-01-01', discoveryState: 'seen', errors: [] };
}
export function savedCatalog(games = [savedGame()]): Catalog { return { schemaVersion: 1, userId: '100', coverage: 'test fixture', games, warnings: [] }; }
export function fakeApi(overrides: Partial<RobloxGateway> = {}): RobloxGateway {
  return {
    identity: async () => identity,
    manageableGroups: async () => [{ id: '200', name: 'Studio' }],
    userGames: async (): Promise<Page> => ({ games: [], cursor: null }),
    groupGames: async (): Promise<Page> => ({ games: [{ id: '1', name: 'Game 1' }], cursor: null }),
    permissions: async () => ({ canManage: true, canCloudEdit: false }),
    metadata: async universeId => ({ name: `Game ${universeId}`, visibility: 'PRIVATE' }),
    details: async ids => ids.map((id): GameDetails => ({ id, name: `Game ${id}`, owner: { id: '200', name: 'Studio', type: 'Group' }, ccu: 10 })),
    ...overrides,
  };
}
