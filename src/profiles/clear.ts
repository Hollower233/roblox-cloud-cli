import { AppError, errorInfo, id } from '../core/errors.js';
import type { DataStoreEntries } from '../datastores/entries.js';
import { profileServicePreset, type ProfilePlayer } from './copy.js';

export async function clearProfiles(entries: Pick<DataStoreEntries, 'clear'>, universeId: string,
  players: ProfilePlayer[], backupDirectory: string, options: { dryRun?: boolean; signal?: AbortSignal } = {}) {
  id(universeId);
  if (!players.length) throw new AppError('ARGUMENT_ERROR', 'At least one player is required.');
  for (const player of players) id(player.userId);
  const unique = [...new Map(players.map(player => [player.userId, player])).values()];
  const results = [];
  for (const player of unique) {
    const target = { universeId, datastore: profileServicePreset.datastore, scope: profileServicePreset.scope, key: `${profileServicePreset.keyPrefix}${player.userId}` };
    try {
      if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
      const result = await entries.clear(target, backupDirectory, { dryRun: options.dryRun, requireReleasedProfile: true });
      results.push({ ...player, key: target.key, status: 'success' as const, result });
    } catch (error) {
      results.push({ ...player, key: target.key, status: 'error' as const, error: errorInfo(error) });
      if (options.signal?.aborted || error instanceof AppError && error.code === 'CANCELLED') break;
    }
  }
  return { preset: 'profileservice', universeId, dryRun: Boolean(options.dryRun), results,
    succeeded: results.filter(row => row.status === 'success').length,
    failed: results.filter(row => row.status === 'error').length, skipped: unique.length - results.length };
}
