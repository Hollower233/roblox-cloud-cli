import { AppError, id } from '../core/errors.js';
import type { LocalStore } from '../storage/store.js';
import { gamePlaceId, type PublicGame } from './discovery.js';

export interface SavedGame extends PublicGame { nickname?: string }
export interface GameCatalog { schemaVersion: 1; games: SavedGame[] }

function normalized(value: string): string { return value.normalize('NFKC').toLowerCase(); }

function nicknameValue(value: string): string {
  const nickname = value.trim();
  if (!nickname || nickname.length > 100 || /\p{Cc}/u.test(nickname) || /^\d+$/.test(normalized(nickname)) || /^[a-z][a-z\d+.-]*:\/\//i.test(nickname)) {
    throw new AppError('ARGUMENT_ERROR', 'Use a nickname of 1–100 characters without control characters. It cannot be an ID or URL.');
  }
  return nickname;
}

export function validateGameCatalog(value: unknown): GameCatalog {
  if (!value || typeof value !== 'object') throw new AppError('STORAGE_ERROR', 'Invalid saved game catalog.');
  const catalog = value as GameCatalog;
  if (catalog.schemaVersion !== 1) throw new AppError('CACHE_VERSION', 'Unsupported saved game catalog version.');
  try {
    if (!Array.isArray(catalog.games)) throw new Error();
    const ids = new Set<string>();
    const nicknames = new Set<string>();
    for (const game of catalog.games) {
      if (!game || typeof game.placeId !== 'string' || typeof game.universeId !== 'string' ||
        typeof game.name !== 'string' || !game.name.trim() || (game.creatorName !== undefined && typeof game.creatorName !== 'string')) throw new Error();
      id(game.placeId);
      id(game.universeId);
      if (ids.has(game.placeId)) throw new Error();
      ids.add(game.placeId);
      if (game.nickname !== undefined) {
        if (typeof game.nickname !== 'string' || nicknameValue(game.nickname) !== game.nickname || nicknames.has(normalized(game.nickname))) throw new Error();
        nicknames.add(normalized(game.nickname));
      }
    }
  } catch { throw new AppError('STORAGE_ERROR', 'Invalid saved game catalog.'); }
  return catalog;
}

export function findSavedGames(input: string, games: readonly SavedGame[]): SavedGame[] {
  const placeId = gamePlaceId(input);
  if (placeId) return games.filter(game => game.placeId === placeId);
  const query = normalized(input.trim());
  if (!query) throw new AppError('ARGUMENT_ERROR', 'Provide a game name, nickname, or Place ID.');
  const nickname = games.find(game => game.nickname !== undefined && normalized(game.nickname) === query);
  if (nickname) return [nickname];
  const exact = games.filter(game => normalized(game.name) === query);
  return exact.length ? exact : games.filter(game => normalized(game.name).includes(query) ||
    (game.nickname !== undefined && normalized(game.nickname).includes(query)));
}

function updateNickname(game: SavedGame, nickname: string, games: readonly SavedGame[]): void {
  if (games.some(row => row.placeId !== game.placeId && row.nickname !== undefined && normalized(row.nickname) === normalized(nickname))) {
    throw new AppError('ARGUMENT_ERROR', 'This nickname already belongs to another saved game.');
  }
  game.nickname = nickname;
}

export class GameCatalogService {
  constructor(private store: LocalStore) {}
  async list(): Promise<SavedGame[]> { return (await this.store.savedGames()).games; }
  async find(input: string): Promise<SavedGame[]> { return findSavedGames(input, await this.list()); }

  async add(game: PublicGame, value?: string): Promise<SavedGame> {
    const nickname = value === undefined ? undefined : nicknameValue(value);
    return this.store.locked(async () => {
      const catalog = await this.store.savedGames();
      const old = catalog.games.find(row => row.placeId === game.placeId);
      const saved: SavedGame = { ...old, ...game };
      if (nickname !== undefined) updateNickname(saved, nickname, catalog.games);
      catalog.games = [...catalog.games.filter(row => row.placeId !== saved.placeId), saved];
      await this.store.saveGames(catalog);
      return saved;
    });
  }

  async nickname(input: string, value: string): Promise<SavedGame> {
    const nickname = nicknameValue(value);
    return this.edit(input, (catalog, game) => updateNickname(game, nickname, catalog.games));
  }

  async remove(input: string): Promise<SavedGame> {
    return this.edit(input, (catalog, game) => {
      catalog.games = catalog.games.filter(row => row.placeId !== game.placeId);
    });
  }

  private async edit(input: string, change: (catalog: GameCatalog, game: SavedGame) => void): Promise<SavedGame> {
    return this.store.locked(async () => {
      const catalog = await this.store.savedGames();
      const matches = findSavedGames(input, catalog.games);
      if (matches.length > 1) throw new AppError('ARGUMENT_ERROR', 'Multiple saved games match. Use the Place ID from rbx game find.');
      const game = matches[0];
      if (!game) throw new AppError('ARGUMENT_ERROR', 'Game not found in local collection.');
      change(catalog, game);
      await this.store.saveGames(catalog);
      return game;
    });
  }
}
