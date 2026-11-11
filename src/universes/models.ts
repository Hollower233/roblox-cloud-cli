export interface Owner { id: string; name: string; type: 'User' | 'Group' }
export interface KeyScope {
  name: string; operations: string[];
  universeIds?: string[]; userIds?: string[]; groupIds?: string[];
  universeDatastores?: { universeId: string; datastoreName: string }[];
}
export interface Identity { userId: string; enabled: boolean; expired: boolean; scopes: KeyScope[] }
export interface Group { id: string; name: string }
export interface DiscoveredGame { id: string; name: string }
export interface Page { games: DiscoveredGame[]; cursor: string | null }
export interface Permissions { canManage: boolean; canCloudEdit: boolean }
export interface GameDetails { id: string; name: string; owner: Owner; ccu: number }
export interface UniverseMetadata { name: string; visibility: 'PUBLIC' | 'PRIVATE' | 'UNKNOWN'; rootPlaceId?: string }
export interface Warning { code: string; message: string; resource?: string; httpStatus?: number }
export interface Game {
  universeId: string; name: string; owner: Owner; visibility: 'PUBLIC' | 'PRIVATE' | 'UNKNOWN';
  /** Root place, read from Cloud v2 universe metadata; absent until the first successful metadata read. */
  rootPlaceId?: string;
  ccu: number | null; permissions: Permissions | null;
  discoveredAt: string; lastSeenAt: string; metadataAt?: string; detailsAt?: string; permissionsAt?: string;
  discoveryState: 'seen' | 'stale' | 'not-seen'; errors: Warning[];
}
export interface Catalog {
  schemaVersion: 1; userId: string; scannedAt?: string; refreshedAt?: string;
  coverage: string; games: Game[]; warnings: Warning[];
}
export interface RobloxGateway {
  identity(): Promise<Identity>;
  manageableGroups(): Promise<Group[]>;
  userGames(userId: string, cursor?: string): Promise<Page>;
  groupGames(groupId: string, cursor?: string): Promise<Page>;
  permissions(universeId: string): Promise<Permissions>;
  metadata(universeId: string): Promise<UniverseMetadata>;
  details(universeIds: string[]): Promise<GameDetails[]>;
}
