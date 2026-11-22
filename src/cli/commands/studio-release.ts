import { join } from 'node:path';
import type { Command } from 'commander';
import { AppError, id } from '../../core/errors.js';
import { LocalStore } from '../../storage/store.js';
import { withStudioEditSession } from '../../studio/mcp.js';
import { publishStudioPlaces } from '../../studio/publish.js';
import { saveStudioPlace } from '../../studio/save.js';
import { normalizePlaceVersionTitle, writePlaceVersionNotes } from '../../universes/place-versions.js';
import { getUniversePlaceDirectory } from '../../universes/places.js';
import type { CommandContext } from '../context.js';
import { emit } from '../output.js';

function studioDirectory(): string {
  if (process.platform !== 'win32') throw new AppError('UNSUPPORTED_PLATFORM', 'Studio save and publish require Windows.');
  if (!process.env.LOCALAPPDATA) throw new AppError('STUDIO_NOT_FOUND', 'Cannot locate the local Studio installation.');
  return join(process.env.LOCALAPPDATA, 'Roblox');
}

function sourceLock(directory: string, sourcePlace: string): LocalStore {
  return new LocalStore(join(directory, 'rbx-studio-operations', sourcePlace));
}

export function registerStudioRelease(studio: Command, context: CommandContext, json: () => boolean): void {
  studio.command('save')
    .description('Save the selected Studio Edit session to Roblox and optionally label the new version')
    .requiredOption('--source-place <id>', 'Open source Edit Place ID', id)
    .option('--title <title>', 'Title for the newly saved version', normalizePlaceVersionTitle)
    .action(async ({ sourcePlace, title }: { sourcePlace: string; title?: string }) => {
      const directory = studioDirectory();
      const connection = title === undefined ? undefined : await context.connection();
      const result = await sourceLock(directory, sourcePlace).locked(() =>
        withStudioEditSession(sourcePlace, context.signal, session => saveStudioPlace(sourcePlace, session.save,
          connection && title !== undefined ? {
            title,
            write: (version, value) => writePlaceVersionNotes(connection.http, sourcePlace, version, value),
          } : undefined,
        )),
      );
      const ok = result.state === 'not_needed' || (result.state === 'saved' && (!result.titleState || result.titleState === 'accepted'));
      emit(result, json(), `${sourcePlace}\t${result.state}${result.version ? ' v' + result.version : ''}${result.titleState ? '\ttitle ' + result.titleState : ''}`,
        ok ? [] : [{
          code: result.error?.code ?? 'STUDIO_SAVE_' + result.state.toUpperCase(),
          message: result.error?.message ?? 'Studio did not complete a new cloud save. Check the session before retrying.',
          resource: sourcePlace,
        }]);
    });

  studio.command('publish')
    .description('Publish the current Studio Edit contents to explicit Places and verify the batch')
    .requiredOption('--source-place <id>', 'Open source Edit Place ID', id)
    .requiredOption('--universe <id-or-name>', 'Destination universe ID or exact name in the local catalog')
    .requiredOption('--place <ids...>', 'Explicit destination Place IDs')
    .option('--timeout <seconds>', 'Verification deadline per Place (maximum 300 seconds)', (value: string) => Number(id(value)), 300)
    .action(async (options: { sourcePlace: string; universe: string; place: string[]; timeout: number }) => {
      const targets = options.place.map(id);
      if (new Set(targets).size !== targets.length || targets.includes(options.sourcePlace) || options.timeout > 300) {
        throw new AppError('ARGUMENT_ERROR', 'Provide distinct destination Places other than the source and a timeout of at most 300 seconds.');
      }
      const directory = studioDirectory();
      const { universeId, http } = await context.universe(options.universe);
      const { placeIds, rootPlaceId, owner } = await getUniversePlaceDirectory(http, universeId);
      const registered = new Set(placeIds);
      if (targets.some(target => !registered.has(target))) {
        throw new AppError('ARGUMENT_ERROR', 'Every destination Place must belong to the selected universe.');
      }
      if (!owner) throw new AppError('INVALID_RESPONSE', 'Cloud did not confirm the destination universe owner.');
      const ordered = targets.filter(target => target !== rootPlaceId);
      if (targets.includes(rootPlaceId)) ordered.push(rootPlaceId);
      const data = await sourceLock(directory, options.sourcePlace).locked(() =>
        withStudioEditSession(options.sourcePlace, context.signal, session =>
          publishStudioPlaces(http, session.execute, {
            sourcePlace: options.sourcePlace,
            targetUniverse: universeId,
            group: owner.type === 'Group' ? id(owner.id) : '0',
            targets: ordered,
            timeoutMs: options.timeout * 1_000,
            signal: context.signal,
            logDirectory: join(directory, 'logs'),
          }),
        ),
      );
      const warnings = data.results.filter(result => result.state !== 'published').map(result => ({
        code: result.error?.code ?? 'PUBLISH_UNVERIFIED',
        message: result.error?.message ?? 'Could not confirm the requested publish.',
        resource: result.placeId,
      }));
      emit(data, json(), data.results.map(result => `${result.placeId}\t${result.state}${result.version ? ' v' + result.version : ''}`).join('\n'), warnings);
    });
}
