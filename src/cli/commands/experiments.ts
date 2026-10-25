import type { Command } from 'commander';
import { join } from 'node:path';
import { AppError } from '../../core/errors.js';
import { Experiments } from '../../experiments/experiments.js';
import { pageNumber } from '../../cloud/common.js';
import { readJsonFile, type CommandContext } from '../context.js';

export function registerExperiments(program: Command, context: CommandContext): void {
  const experiments = program.command('experiments').description('Manage official in-experience A/B experiments (Experimental)');
  const polling = (command: Command) => command.option('--no-wait', 'Return the operation immediately').option('--timeout <seconds>', 'Maximum polling duration, then return pending', '60');
  const writing = (command: Command) => polling(command).option('--dry-run', 'Validate and preview without submitting');
  const waitOptions = (options: { wait?: boolean; timeout: string }) => {
    const seconds = Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new AppError('ARGUMENT_ERROR', 'Timeout must be 0–3600 seconds.');
    return { wait: options.wait, timeoutMs: seconds * 1000, signal: context.signal };
  };
  experiments.command('list <universe>').option('--limit <count>', 'Page size', '20').option('--skip <count>', 'Offset', '0').option('--search <text>', 'Search key')
    .action(async (input, options) => {
      const limit = pageNumber(Number(options.limit), 1), skip = pageNumber(Number(options.skip));
      const { universeId, http } = await context.universe(input);
      context.output({ universeId, ...await new Experiments(http).list(universeId, { limit, skip, search: options.search }) });
    });
  experiments.command('get <universe> <experimentId>').action(async (input, experimentId) => {
    const { universeId, http } = await context.universe(input);
    context.output({ universeId, experiment: await new Experiments(http).get(universeId, experimentId) });
  });
  polling(experiments.command('operation <universe> <operationId>').description('Query or resume polling a saved operation; does not resubmit the mutation'))
    .action(async (input, operationId, options) => {
      const wait = waitOptions(options), { universeId, http } = await context.universe(input), client = new Experiments(http);
      const initial = await client.getOperation(universeId, operationId);
      const op = options.wait === false ? initial : await client.wait(universeId, initial, wait);
      context.receipt({ universeId, operationId, state: op.error != null ? 'unverified' : op.done ? 'verified' : 'pending', request: { method: 'GET', url: `https://apis.roblox.com/creator-configs-public-api/v1/experimentation/universes/${universeId}/operations/${operationId}` }, response: op });
    });
  for (const action of ['create', 'update'] as const) {
    writing(experiments.command(`${action} <universe>${action === 'update' ? ' <experimentId>' : ''}`)
      .description(action === 'update' ? 'Replace ALL mutable draft experiment fields' : 'Create a draft config experiment')
      .requiredOption('--file <path>', 'JSON experiment definition'))
      .action(async (...args: any[]) => {
        const input = args[0] as string, experimentId = action === 'update' ? args[1] as string : undefined;
        const options = args[action === 'update' ? 2 : 1], wait = waitOptions(options), definition = await readJsonFile(options.file);
        const { universeId, http, local } = await context.universe(input), client = new Experiments(http);
        const settings = { ...wait, dryRun: options.dryRun, backupDirectory: join(local.home, 'experiment-backups') };
        context.receipt(action === 'create' ? await client.create(universeId, definition, settings) : await client.update(universeId, experimentId!, definition, settings));
      });
  }
  writing(experiments.command('start <universe> <experimentId>')).action(async (input, experimentId, options) => {
    const wait = waitOptions(options), { universeId, http, local } = await context.universe(input);
    context.receipt(await new Experiments(http).start(universeId, experimentId, { ...wait, dryRun: options.dryRun, backupDirectory: join(local.home, 'experiment-backups') }));
  });
  writing(experiments.command('schedule <universe> <experimentId>').requiredOption('--at <timestamp>', 'Future ISO-8601 timestamp including Z or UTC offset'))
    .action(async (input, experimentId, options) => {
      const wait = waitOptions(options), { universeId, http, local } = await context.universe(input);
      context.receipt(await new Experiments(http).schedule(universeId, experimentId, options.at, { ...wait, dryRun: options.dryRun, backupDirectory: join(local.home, 'experiment-backups') }));
    });
  writing(experiments.command('complete <universe> <experimentId>').description('End an experiment and optionally publish a winning variant')
    .option('--variant <id>', 'Winning variant ID (not label)')
    .option('--no-winner', 'End without a winner; restore the previous config value'))
    .action(async (input, experimentId, options) => {
      if (Boolean(options.variant) === (options.winner === false)) throw new AppError('ARGUMENT_ERROR', 'Choose exactly one of --variant or --no-winner.');
      const wait = waitOptions(options), { universeId, http, local } = await context.universe(input);
      context.receipt(await new Experiments(http).complete(universeId, experimentId, options.variant, { ...wait, dryRun: options.dryRun, backupDirectory: join(local.home, 'experiment-backups') }));
    });
  polling(experiments.command('stats <universe> <experimentId>').description('Query diagnostic stats; Roblox may need at least 24 hours of experiment data'))
    .action(async (input, experimentId, options) => {
      const wait = waitOptions(options), { universeId, http } = await context.universe(input);
      context.receipt(await new Experiments(http).stats(universeId, experimentId, wait));
    });
}
