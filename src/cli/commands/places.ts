import type { Command } from 'commander';
import { id } from '../../core/errors.js';
import { listPlaces, maxPlayers, updatePlaces, validatePlaceUpdate } from '../../universes/places.js';
import type { CommandContext } from '../context.js';
import { clean, emit } from '../output.js';

export function registerPlaces(program: Command, context: CommandContext): void {
  const places = program.command('places').description('List Places and configure per-server player limits');
  places.command('list').requiredOption('--universe <id-or-name>', 'Universe ID or exact local game name')
    .action(async options => {
      const { universeId, http } = await context.universe(options.universe);
      const rows = await listPlaces(http, universeId);
      emit({ universeId, places: rows }, Boolean(program.opts().json),
        `Universe: ${universeId}\nPLACE ID\tROOT\tMAX PLAYERS\tNAME\n${rows.map(p => `${p.placeId}\t${p.isRootPlace ? 'yes' : 'no'}\t${p.maxPlayers}\t${clean(p.name)}`).join('\n')}`);
    });
  places.command('update').requiredOption('--universe <id-or-name>', 'Universe ID or exact local game name')
    .option('--place <id>', 'Update only this Place', id).option('--all', 'Update every Place in this universe')
    .requiredOption('--max-players <count>', 'Positive integer player limit', value => /^\d+$/.test(value) ? maxPlayers(Number(value)) : maxPlayers(NaN))
    .action(async options => {
      const update = { placeId: options.place, all: options.all, maxPlayers: options.maxPlayers };
      validatePlaceUpdate(update);
      const { universeId, http } = await context.universe(options.universe);
      const result = await updatePlaces(http, universeId, update);
      const warnings = result.results.filter(row => row.state !== 'verified').map(row => ({
        resource: row.placeId, code: row.error?.code ?? 'UNVERIFIED', message: row.error?.message ?? 'Update not verified.',
      }));
      emit(result, Boolean(program.opts().json), `Universe: ${universeId}\n${result.results.map(row =>
        `${row.placeId}\t${row.before ?? '?'} -> ${row.after ?? '?'} (requested ${row.requested})\t${row.state}`).join('\n')}`, warnings);
    });
}
