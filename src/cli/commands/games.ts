import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { GameCatalogService, type SavedGame } from '../../games/catalog.js';
import { gamePlaceId, lookupPublicGame, searchPublicGames } from '../../games/discovery.js';
import { launchRobloxPlayer } from '../../games/launch.js';
import type { LocalStore } from '../../storage/store.js';
import { HttpClient } from '../../transport/http-client.js';
import { clean, emit } from '../output.js';

interface Context { store(): LocalStore; json(): boolean; signal: AbortSignal }

function renderGames(games: SavedGame[]): string {
  if (!games.length) return 'No games found.';
  return ['#\tPlace ID\tGame\tCreator\tNickname', ...games.map((game, i) =>
    [String(i + 1), game.placeId, game.name, game.creatorName ?? '', game.nickname ?? ''].map(clean).join('\t'))].join('\n');
}

export function registerGames(program: Command, context: Context): void {
  const { json, signal } = context;
  const http = () => new HttpClient({ signal });
  const collection = () => new GameCatalogService(context.store());
  const game = program.command('game').description('Search Roblox and manage your local collection of games');

  async function choose(query: string, matches: SavedGame[], command: string): Promise<SavedGame | undefined> {
    if (!matches.length) throw new AppError('ARGUMENT_ERROR', 'No games found for this search.');
    if (json() || !process.stdin.isTTY || !process.stderr.isTTY) {
      emit({ status: 'selection_required', query, games: matches }, json(),
        `${renderGames(matches)}\nChoose a Place ID and run ${command} <placeId>.`);
      process.exitCode = 3;
      return;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const closed = new AbortController();
    prompt.once('close', () => closed.abort());
    prompt.on('SIGINT', () => prompt.close());
    try {
      const answer = await prompt.question(`${renderGames(matches)}\nSelect a game number (Enter to cancel): `,
        { signal: AbortSignal.any([signal, closed.signal]) });
      if (!answer.trim()) throw new AppError('CANCELLED', 'Game selection cancelled.');
      const selected = /^\d+$/.test(answer.trim()) ? matches[Number(answer) - 1] : undefined;
      if (!selected) throw new AppError('ARGUMENT_ERROR', 'Choose a number from the game list.');
      return selected;
    } catch (error) {
      if (signal.aborted || closed.signal.aborted) {
        throw new AppError('CANCELLED', 'Game selection cancelled.');
      }
      throw error;
    } finally {
      prompt.close();
    }
  }

  game.command('search <query>').description('Search Roblox by title or keyword, including Chinese')
    .action(async (query: string) => {
      const games = await searchPublicGames(http(), query);
      emit({ query: query.trim(), games }, json(), renderGames(games));
    });
  game.command('list').description('List saved games offline').action(async () => {
    const games = await collection().list();
    emit({ games }, json(), renderGames(games));
  });
  game.command('find <query>').description('Find saved games by name, nickname, or Place ID').action(async (query: string) => {
    const games = await collection().find(query);
    emit({ games }, json(), renderGames(games));
  });
  game.command('add <game>').description('Save a game by Place ID, Roblox game page URL, or search term')
    .option('--nickname <nickname>', 'Set a local nickname for the saved game')
    .action(async (input: string, options: { nickname?: string }) => {
      const placeId = gamePlaceId(input);
      const selected = placeId ? await lookupPublicGame(http(), placeId)
        : await choose(input, await searchPublicGames(http(), input), 'rbx game add');
      if (!selected) return;
      const saved = await collection().add(selected, options.nickname);
      emit({ game: saved }, json(), renderGames([saved]));
    });
  game.command('nickname <game> <nickname>').description('Set or replace a saved game nickname')
    .action(async (input: string, nickname: string) => {
      const saved = await collection().nickname(input, nickname);
      emit({ game: saved }, json(), renderGames([saved]));
    });
  game.command('remove <game>').description('Remove one game from the local collection')
    .action(async (input: string) => {
      const removed = await collection().remove(input);
      emit({ removed }, json(), `Removed ${clean(removed.name)} (${removed.placeId}).`);
    });

  program.command('play <game>').description('Launch Roblox Player by Place ID, game URL, saved nickname, or search term')
    .action(async (input: string) => {
      let placeId = gamePlaceId(input);
      let selected: SavedGame | undefined;
      if (!placeId) {
        const saved = await collection().find(input);
        selected = saved.length === 1 ? saved[0] : await choose(input,
          saved.length ? saved : await searchPublicGames(http(), input), 'rbx play');
        if (!selected) return;
        placeId = selected.placeId;
      }
      const launch = await launchRobloxPlayer(placeId);
      emit({ ...launch, ...(selected ? { game: selected } : {}) }, json(),
        `Roblox Player launch requested for ${selected ? clean(selected.name) + ' ' : ''}(Place ${placeId}).`);
    });
}
