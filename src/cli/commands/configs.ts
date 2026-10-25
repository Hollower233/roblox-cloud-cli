import type { Command } from 'commander';
import { join } from 'node:path';
import { ConfigRepository } from '../../configs/repository.js';
import { pageNumber } from '../../cloud/common.js';
import { readJsonFile, type CommandContext } from '../context.js';

export function registerConfigs(program: Command, context: CommandContext): void {
  const configs = program.command('configs').description('Manage in-experience configs, drafts, publish and revision history (Beta)');
  configs.command('read <universe>').option('--full', 'Include metadata and conditional rules').action(async (input, options) => {
    const { universeId, http } = await context.universe(input);
    context.output({ universeId, config: await new ConfigRepository(http).read(universeId, Boolean(options.full)) });
  });
  const draft = configs.command('draft').description('Stage changes without publishing them');
  draft.command('read <universe>').action(async input => {
    const { universeId, http } = await context.universe(input);
    context.output({ universeId, draft: await new ConfigRepository(http).draft(universeId) });
  });
  draft.command('set <universe>').requiredOption('--file <path>', 'JSON object of config keys and values; null stages deletion')
    .option('--draft-hash <hash>', 'Expected previous draft hash; defaults to a fresh read')
    .option('--dry-run', 'Read and preview only; does not prove write permission')
    .action(async (input, options) => {
      const entries = await readJsonFile(options.file), { universeId, http, local } = await context.universe(input);
      context.receipt(await new ConfigRepository(http).setDraft(universeId, entries, { previousDraftHash: options.draftHash, dryRun: options.dryRun, backupDirectory: join(local.home, 'config-backups') }));
    });
  configs.command('publish <universe>').requiredOption('--draft-hash <hash>', 'Exact reviewed draft hash; publishes ALL staged changes')
    .requiredOption('--message <text>', 'Revision message')
    .option('--strategy <strategy>', 'Immediate or GradualRollout (15 minutes)', 'Immediate')
    .option('--dry-run', 'Read and preview without publishing')
    .action(async (input, options) => {
      const { universeId, http, local } = await context.universe(input);
      context.receipt(await new ConfigRepository(http).publish(universeId, options.draftHash, { message: options.message, strategy: options.strategy, dryRun: options.dryRun, backupDirectory: join(local.home, 'config-backups') }));
    });
  configs.command('history <universe>').option('--limit <count>', 'Page size', '20').option('--skip <count>', 'Offset', '0')
    .action(async (input, options) => {
      const limit = pageNumber(Number(options.limit), 1), skip = pageNumber(Number(options.skip));
      const { universeId, http } = await context.universe(input);
      context.output({ universeId, history: await new ConfigRepository(http).history(universeId, { limit, skip }) });
    });
  configs.command('restore <universe> <revisionId>').description('Replace the draft with a historical revision; publish separately')
    .option('--dry-run', 'Read and preview without replacing the draft')
    .action(async (input, revisionId, options) => {
      const { universeId, http, local } = await context.universe(input);
      context.receipt(await new ConfigRepository(http).restore(universeId, revisionId, { dryRun: options.dryRun, backupDirectory: join(local.home, 'config-backups') }));
    });
}
