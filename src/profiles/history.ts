import { AppError, id } from '../core/errors.js';
import type { DataStoreEntries, EntryRevision } from '../datastores/entries.js';
import { profileServicePreset, type ProfilePlayer } from './copy.js';

export interface ProfileRevisionSummary {
  version: string; createdTime: string; bytes: number; deleted: boolean; dataVersion: number | null;
  coins: number | null; diamonds: number | null; experience: number | null; itemCount: number | null;
  matches: number | null; wins: number | null; winStreak: number | null; maxWinStreak: number | null;
}
export interface FusionEvent {
  id: string; at: number | null; consumed: string[]; granted: string | null; itemId: string | null; sequence: number | null;
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function profileData(revision: EntryRevision): Record<string, unknown> {
  const root = record(revision.value), data = record(root?.Data);
  if (!root || !data) throw new AppError('INVALID_RESPONSE', `Profile revision ${revision.version} has no Data object.`);
  return data;
}
function summary(revision: EntryRevision, bytes: number, deleted: boolean): ProfileRevisionSummary {
  const data = profileData(revision), exp = record(data.exp), stats = record(record(data.matchStats)?.RPS), items = record(data.items);
  return { version: revision.version, createdTime: revision.createdTime, bytes, deleted, dataVersion: number(data.dataVersion),
    coins: number(data.coins), diamonds: number(data.diamonds), experience: number(exp?.total),
    itemCount: items ? Object.keys(items).length : Array.isArray(data.balls) ? data.balls.length : null,
    matches: number(stats?.matches), wins: number(stats?.wins), winStreak: number(data.winStreak), maxWinStreak: number(data.maxWinStreak) };
}
function fusions(revision: EntryRevision): FusionEvent[] {
  const ledger = record(profileData(revision).itemLedger), entries = ledger?.entries;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new AppError('INVALID_RESPONSE', `Profile revision ${revision.version} has an invalid item ledger.`);
  return entries.flatMap(value => {
    const event = record(value);
    if (!event || event.type !== 'fusion') return [];
    if (typeof event.id !== 'string' || !Array.isArray(event.consumed) || !event.consumed.every(item => typeof item === 'string')) {
      throw new AppError('INVALID_RESPONSE', `Profile revision ${revision.version} has an invalid fusion event.`);
    }
    return [{ id: event.id, at: number(event.at), consumed: event.consumed as string[], granted: typeof event.granted === 'string' ? event.granted : null,
      itemId: typeof event.itemId === 'string' ? event.itemId : null, sequence: number(event.sequence) }];
  });
}

export async function profileHistory(entries: Pick<DataStoreEntries, 'listVersions' | 'getVersion'>, universeId: string,
  player: ProfilePlayer, limit = 10, signal?: AbortSignal) {
  id(universeId); id(player.userId);
  const address = { universeId, datastore: profileServicePreset.datastore, scope: profileServicePreset.scope, key: `${profileServicePreset.keyPrefix}${player.userId}` };
  const versions = await entries.listVersions(address, limit), revisions: ProfileRevisionSummary[] = [], fusionMap = new Map<string, FusionEvent>();
  for (const version of versions) {
    if (signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled.');
    if (version.deleted) { revisions.push({ version: version.version, createdTime: version.createdTime, bytes: version.contentLength, deleted: true,
      dataVersion: null, coins: null, diamonds: null, experience: null, itemCount: null, matches: null, wins: null, winStreak: null, maxWinStreak: null }); continue; }
    const revision = await entries.getVersion(address, version.version);
    if (!revision) throw new AppError('INVALID_RESPONSE', `Listed profile revision ${version.version} no longer exists.`);
    revisions.push(summary(revision, version.contentLength, false));
    for (const event of fusions(revision)) fusionMap.set(event.id, event);
  }
  return { preset: 'profileservice', universeId, player, key: address.key, revisions,
    fusionEvents: [...fusionMap.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) };
}
