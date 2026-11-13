import type { Command } from 'commander';
import { join } from 'node:path';
import { AppError, id } from '../../core/errors.js';
import { GameEvents, eventCategories, eventId, validateEventFields, type CreateEventFields, type EventFields } from '../../events/events.js';
import { getEventImageOperation, uploadEventImage } from '../../events/images.js';
import { type CommandContext, readJsonFile } from '../context.js';
import { eventRules, eventTextSummary } from '../../events/rules.js';
import type { WriteReceipt } from '../../cloud/common.js';

function withTextRules(receipt: WriteReceipt) {
  return { ...receipt, validation: eventTextSummary(receipt.request.body ?? {}) };
}

function fields(command: Command): Command {
  return command.option('--file <path>', 'UTF-8 JSON event fields (cannot combine with field flags)')
    .option('--title <text>', 'Event name: max 25 UTF-16 units; see events rules').option('--subtitle <text>', 'Subtitle: max 25 UTF-16 units')
    .option('--description <text>', 'Description: max 1000 UTF-16 units; empty string clears it')
    .option('--start <iso>', 'Start with explicit timezone').option('--end <iso>', 'End with explicit timezone')
    .option('--visibility <level>', 'public or private')
    .option('--place <id>', 'Venue Place ID; create defaults to root Place', id)
    .option('--category <name...>', 'Ranked categories; see events categories')
    .option('--thumbnail <id...>', 'Ranked existing Image asset IDs')
    .option('--dry-run', 'Validate and preview with character counts; no server acceptance check');
}
async function body(options: Record<string, any>, create = false) {
  const keys = ['title', 'subtitle', 'description', 'start', 'end', 'visibility', 'place', 'category', 'thumbnail', 'group'];
  if (options.file) {
    if (keys.some(key => options[key] !== undefined)) throw new AppError('ARGUMENT_ERROR', '--file cannot be combined with event field flags.');
    return validateEventFields(await readJsonFile(options.file), create);
  }
  return validateEventFields({ title: options.title, subtitle: options.subtitle, description: options.description,
    startTime: options.start, endTime: options.end, visibility: options.visibility,
    placeId: options.place === undefined ? undefined : Number(id(options.place)),
    ...(create ? { groupId: options.group === undefined ? undefined : Number(id(options.group)) } : {}),
    categories: options.category?.map((category: string, rank: number) => ({ category, rank })),
    thumbnails: options.thumbnail?.map((value: string, rank: number) => ({ mediaId: Number(id(value)), rank })),
  }, create);
}
export function registerEvents(program: Command, context: CommandContext): void {
  const events = program.command('events').description('Manage experience events (experimental Open Cloud API)');
  events.command('rules').description('Show offline text limits, emoji counting, schedule rules and server checks').action(() => context.output(eventRules()));
  events.command('categories').description('List supported event category values').action(() => context.output({ categories: eventCategories }));
  events.command('image-operation <operation-id>').description('Read a saved upload operation without uploading again').action(async value => {
    const { http } = await context.connection();
    context.receipt(await getEventImageOperation(http, value));
  });
  events.command('list <game>').option('--all', 'Include finished events (default: ongoing and upcoming)')
    .option('--visibility <level>', 'public, private or moderated')
    .option('--starts-before <iso>').option('--starts-after <iso>').option('--ends-before <iso>').option('--ends-after <iso>')
    .action(async (game, options) => {
      const { universeId, http } = await context.universe(game);
      context.output({ universeId, events: await new GameEvents(http).list(universeId, options) });
    });
  events.command('get <event-id>').action(async value => {
    eventId(value);
    const { http } = await context.connection();
    context.output(await new GameEvents(http).get(value));
  });
  fields(events.command('create <game>').option('--group <id>', 'Group host ID; omitted uses authenticated user', id))
    .action(async (game, options) => {
      const data = await body(options, true);
      const { universeId, http, local } = await context.universe(game);
      context.receipt(withTextRules(await new GameEvents(http).create(universeId, data as unknown as CreateEventFields, { dryRun: options.dryRun, backupDirectory: join(local.home, 'event-backups') })));
    });
  fields(events.command('update <event-id>')).action(async (value, options) => {
    eventId(value); const data = await body(options);
    const { http, local } = await context.connection();
    context.receipt(withTextRules(await new GameEvents(http).update(value, data as Partial<EventFields>, { dryRun: options.dryRun, backupDirectory: join(local.home, 'event-backups') })));
  });
  events.command('delete <event-id>').description('Permanently delete an event; back up its current metadata first')
    .option('--dry-run', 'Read and preview without deleting').action(async (value, options) => {
      eventId(value);
      const { http, local } = await context.connection();
      context.receipt(await new GameEvents(http).delete(value, { dryRun: options.dryRun, backupDirectory: join(local.home, 'event-backups') }));
    });
  events.command('upload-image <path>').description('Upload PNG/JPEG; reuse returned mediaId with --thumbnail (moderation/display not verified)')
    .option('--user <id>', 'Image creator user ID', id).option('--group <id>', 'Image creator group ID', id)
    .option('--dry-run', 'Validate image without uploading').action(async (path, options) => {
      if (Boolean(options.user) === Boolean(options.group)) throw new AppError('ARGUMENT_ERROR', 'Choose exactly one of --user or --group.');
      const { http, local } = await context.connection();
      context.receipt(await uploadEventImage(http, path, { creator: { type: options.group ? 'Group' : 'User', id: options.group ?? options.user }, dryRun: options.dryRun, backupDirectory: join(local.home, 'event-backups') }));
    });
}
