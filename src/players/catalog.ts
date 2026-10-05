import { AppError, id } from '../core/errors.js';
import type { LocalStore } from '../storage/store.js';

export interface SavedPlayer { userId: string; name: string; alias?: string }
export interface PlayerCatalog { schemaVersion: 1; players: SavedPlayer[] }

function aliasValue(value: string): string {
  const alias = value.trim();
  if (!alias || alias.length > 100 || /[,\p{Cc}]/u.test(alias) || /^\d+$/.test(alias)) {
    throw new AppError('ARGUMENT_ERROR', 'Alias must contain 1–100 characters, without commas, control characters or an all-numeric value.');
  }
  return alias;
}

export function validatePlayerCatalog(value: unknown): PlayerCatalog {
  if (!value || typeof value !== 'object') throw new AppError('STORAGE_ERROR', 'Invalid player catalog.');
  const catalog = value as PlayerCatalog;
  if (catalog.schemaVersion !== 1) throw new AppError('CACHE_VERSION', 'Unsupported player catalog version.');
  try {
    if (!Array.isArray(catalog.players)) throw new Error();
    const ids = new Set<string>();
    for (const player of catalog.players) {
      if (!player || typeof player.userId !== 'string' || typeof player.name !== 'string' || !/^[a-zA-Z0-9_]+$/.test(player.name)) throw new Error();
      id(player.userId);
      if (ids.has(player.userId)) throw new Error();
      ids.add(player.userId);
      if (player.alias !== undefined && (typeof player.alias !== 'string' || aliasValue(player.alias) !== player.alias)) throw new Error();
    }
  } catch { throw new AppError('STORAGE_ERROR', 'Invalid player catalog.'); }
  return catalog;
}

export function findPlayers(input: string, players: readonly SavedPlayer[]): SavedPlayer[] {
  const query = input.trim().toLowerCase();
  if (!query) throw new AppError('ARGUMENT_ERROR', 'Provide a player name, alias or User ID.');
  if (/^\d+$/.test(query)) return players.filter(player => player.userId === query);
  const exact = players.filter(player => player.name.toLowerCase() === query || player.alias?.toLowerCase() === query);
  return exact.length ? exact : players.filter(player => player.name.toLowerCase().includes(query));
}

export function selectPlayer(input: string, players: readonly SavedPlayer[]): SavedPlayer | undefined {
  const matches = findPlayers(input, players);
  if (matches.length > 1) throw new AppError('ARGUMENT_ERROR', `Ambiguous player: ${input}. Candidates: ${matches.map(player => `${player.name} (${player.userId})${player.alias ? ` [${player.alias}]` : ''}`).join(', ')}. Use a User ID.`);
  return matches[0];
}

export class PlayerCatalogService {
  constructor(private store: LocalStore) {}
  async list(): Promise<SavedPlayer[]> { return (await this.store.players()).players; }
  async find(input: string): Promise<SavedPlayer[]> { return findPlayers(input, await this.list()); }
  async add(player: Pick<SavedPlayer, 'userId' | 'name'>, alias?: string): Promise<SavedPlayer> {
    const entry = { userId: id(player.userId), name: player.name, ...(alias !== undefined ? { alias: aliasValue(alias) } : {}) };
    validatePlayerCatalog({ schemaVersion: 1, players: [entry] });
    return this.store.locked(async () => {
      const catalog = await this.store.players();
      const old = catalog.players.find(row => row.userId === entry.userId);
      const saved = { ...old, ...entry };
      catalog.players = [...catalog.players.filter(row => row.userId !== entry.userId), saved];
      await this.store.savePlayers(catalog);
      return saved;
    });
  }
  async alias(input: string, value: string): Promise<SavedPlayer> {
    const alias = aliasValue(value);
    return this.store.locked(async () => {
      const catalog = await this.store.players(), player = selectPlayer(input, catalog.players);
      if (!player) throw new AppError('ARGUMENT_ERROR', 'Player not found in local catalog.');
      player.alias = alias;
      await this.store.savePlayers(catalog);
      return player;
    });
  }
  async remove(input: string): Promise<SavedPlayer> {
    return this.store.locked(async () => {
      const catalog = await this.store.players(), player = selectPlayer(input, catalog.players);
      if (!player) throw new AppError('ARGUMENT_ERROR', 'Player not found in local catalog.');
      catalog.players = catalog.players.filter(row => row.userId !== player.userId);
      await this.store.savePlayers(catalog);
      return player;
    });
  }
}
