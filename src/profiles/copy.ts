import { AppError, errorInfo, id } from '../core/errors.js';
import { DataStoreEntries } from '../datastores/entries.js';
import { HttpClient } from '../transport/http-client.js';
import type { Game } from '../universes/models.js';

export interface ProfilePlayer { userId: string; name: string }
export const profileServicePreset = Object.freeze({ datastore: 'Default', scope: 'global', keyPrefix: 'PLAYER_' });

export function resolveProfileUniverse(value: string, games: Pick<Game, 'universeId' | 'name'>[] = []): string {
  const input = value.trim();
  if (/^\d+$/.test(input)) return id(input);
  const matches = [...new Set(games.filter(game => game.name.toLowerCase() === input.toLowerCase()).map(game => game.universeId))];
  if (matches.length !== 1) throw new AppError('ARGUMENT_ERROR', matches.length
    ? `Ambiguous universe name: ${input}. Use a Universe ID.`
    : `Universe not found in local catalog: ${input}. Run universe scan/add or use a Universe ID.`);
  return id(matches[0]!);
}

export async function resolveProfilePlayers(input: string, http: HttpClient): Promise<ProfilePlayer[]> {
  const names = [...new Set(input.split(',').map(value => value.trim().toLowerCase()))];
  if (names.some(name => !name || !/^[a-z0-9_]+$/.test(name)) || names.length > 100) {
    throw new AppError('ARGUMENT_ERROR', 'Provide 1–100 comma-separated Roblox usernames or User IDs.');
  }
  const resolved = new Map<string, ProfilePlayer>();
  const usernames = names.filter(name => !/^\d+$/.test(name));
  for (const name of names.filter(name => /^\d+$/.test(name))) resolved.set(name, { userId: id(name), name });
  if (usernames.length) {
    const response = await http.request<{ data?: unknown }>('https://users.roblox.com/v1/usernames/users', {
      body: { usernames, excludeBannedUsers: false },
    });
    if (!response || !Array.isArray(response.data)) throw new AppError('INVALID_RESPONSE', 'Invalid username lookup response.');
    for (const row of response.data) {
      if (!row || typeof row.requestedUsername !== 'string' || typeof row.name !== 'string' || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) {
        throw new AppError('INVALID_RESPONSE', 'Invalid user in username lookup response.');
      }
      const requested = row.requestedUsername.toLowerCase();
      if (!usernames.includes(requested) || resolved.has(requested)) throw new AppError('INVALID_RESPONSE', 'Unexpected or duplicate username lookup result.');
      resolved.set(requested, { userId: String(row.id), name: row.name });
    }
    const missing = usernames.filter(name => !resolved.has(name));
    if (missing.length) throw new AppError('ARGUMENT_ERROR', `Roblox usernames not found: ${missing.join(', ')}. No profiles copied.`);
  }
  return [...new Map(names.map(name => { const player = resolved.get(name)!; return [player.userId, player] as const; })).values()];
}

export async function copyProfiles(entries: Pick<DataStoreEntries, 'copy'>, sourceUniverseId: string, targetUniverseId: string,
  players: ProfilePlayer[], backupDirectory: string, signal?: AbortSignal, targetPlayer?: ProfilePlayer) {
  id(sourceUniverseId); id(targetUniverseId);
  if (!players.length) throw new AppError('ARGUMENT_ERROR', 'At least one player is required.');
  for (const player of players) id(player.userId);
  if (targetPlayer) {
    id(targetPlayer.userId);
    if (new Set(players.map(player => player.userId)).size !== 1) throw new AppError('ARGUMENT_ERROR', 'Copying to another player requires exactly one source player.');
    if (sourceUniverseId === targetUniverseId && players[0]!.userId === targetPlayer.userId) throw new AppError('ARGUMENT_ERROR', 'Source and target profiles must differ.');
  } else if (sourceUniverseId === targetUniverseId) throw new AppError('ARGUMENT_ERROR', 'Source and target universes must differ.');
  const results = [];
  for (const player of [...new Map(players.map(player => [player.userId, player])).values()]) {
    const address = { datastore: profileServicePreset.datastore, scope: profileServicePreset.scope, key: `${profileServicePreset.keyPrefix}${player.userId}` };
    const targetAddress = targetPlayer ? { ...address, key: `${profileServicePreset.keyPrefix}${targetPlayer.userId}` } : address;
    const receipt = { ...player, key: address.key, ...(targetPlayer ? { targetPlayer, targetKey: targetAddress.key } : {}) };
    try {
      if (signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
      const result = await entries.copy({ ...address, universeId: sourceUniverseId }, { ...targetAddress, universeId: targetUniverseId }, backupDirectory,
        targetPlayer ? { userIds: JSON.stringify([Number(targetPlayer.userId)]) } : {});
      results.push({ ...receipt, status: 'success' as const, result });
    } catch (error) {
      results.push({ ...receipt, status: 'error' as const, error: errorInfo(error) });
      if (signal?.aborted || error instanceof AppError && error.code === 'CANCELLED') break;
    }
  }
  return { preset: 'profileservice', sourceUniverseId, targetUniverseId, results,
    succeeded: results.filter(result => result.status === 'success').length,
    failed: results.filter(result => result.status === 'error').length,
    skipped: new Set(players.map(player => player.userId)).size - results.length };
}
