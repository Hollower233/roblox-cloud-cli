import type { Command } from 'commander';
import { CredentialStore } from '../../auth/credentials.js';
import { AppError, id } from '../../core/errors.js';
import { IconAssets } from '../../icons/countdown.js';
import { iconNodes } from '../../icons/render.js';
import { generateCurrentIcons, IconTasks, nextIconTaskEvent } from '../../icons/tasks.js';
import { parseTargetTime, requireDuration } from '../../icons/frames.js';
import type { LocalStore } from '../../storage/store.js';
import { HttpClient } from '../../transport/http-client.js';
import { countdownLog } from '../countdown-log.js';

interface Context { store(): LocalStore; json(): boolean; signal: AbortSignal }
function nodes(text?: string) { const result = text?.split(',').map(x => x.trim()); iconNodes(result); return result; }
async function client(context: Context, universeId: string) {
  id(universeId);
  const store = context.store(), http = new HttpClient({ apiKey: await new CredentialStore(store.home).get(), signal: context.signal });
  const diagnostics = countdownLog(store.home, universeId);
  process.stderr.write(`Countdown diagnostics: ${diagnostics.path}\n`);
  const assets = new IconAssets(http, undefined, context.signal);
  const tasks = new IconTasks(store, assets, http, { signal: context.signal, onEvent: event => {
    diagnostics.event(event);
    if (context.json()) process.stdout.write(JSON.stringify({ schemaVersion: 1, ...event }) + '\n');
    else process.stderr.write(JSON.stringify(event) + '\n');
  } });
  return { store, http, assets, tasks };
}
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
export async function generatedCountdown(universeId: string, options: { at?: string; in?: string; restoreAt?: string; nodes?: string; restoreAfter?: string; reset?: boolean; cache?: boolean; dryRun?: boolean; moderationTimeout: string }, context: Context) {
  const moderationTimeout = requireDuration(options.moderationTimeout, '--moderation-timeout');
  if (!options.restoreAt) throw new AppError('ARGUMENT_ERROR', 'Generated countdowns require --restore-at "YYYY-MM-DD HH:MM".');
  if (options.restoreAfter || options.reset || options.cache === false) throw new AppError('ARGUMENT_ERROR', 'Generated tasks use --restore-at and saved uploads; --restore-after, --reset, --no-cache apply only to folder countdowns.');
  const target: { at: number } | { inMs: number } = options.at ? { at: parseTargetTime(options.at) } : { inMs: requireDuration(options.in!, '--in') };
  const restoreAt = parseTargetTime(options.restoreAt), selected = nodes(options.nodes);
  const duration = 'inMs' in target ? target.inMs : target.at - Date.now();
  if (duration <= 0 || restoreAt <= Date.now() + duration) throw new AppError('ARGUMENT_ERROR', 'Target must be in the future and restore time must be after target.');
  if (options.dryRun) {
    const local = context.store(), existing = await new IconTasks(local, null).status(universeId);
    emit({ dryRun: true, universeId, target, restoreAt: new Date(restoreAt).toISOString(), frames: iconNodes(selected).filter(frame => frame.offsetMs === null || frame.offsetMs <= duration), existingTask: existing }); return;
  }
  const { store, tasks } = await client(context, universeId), config = await store.config();
  const game = config.currentUserId ? (await store.catalog(config.currentUserId))?.games.find(game => game.universeId === universeId) : undefined;
  if (!game) throw new AppError('ARGUMENT_ERROR', `Universe is not in the local catalog. Run rbx universe add ${universeId}.`);
  const task = await tasks.create({ universeId, target, restoreAt, creator: { type: game.owner.type, id: game.owner.id }, nodes: selected });
  process.stderr.write(`Task ${task.taskId}; preview: ${task.output}\nKeep this process running for automatic switches. After interruption use: rbx icon resume ${universeId}\n`);
  const result = await tasks.resume(universeId, moderationTimeout); emit(result);
}
export function registerIconTasks(icon: Command, context: Context) {
  icon.command('generate <universeId>').description('Download the current icon and generate local countdown/SOON/NOW previews; no uploads')
    .requiredOption('--output <folder>', 'New output folder (must not already exist)')
    .option('--nodes <durations>', 'Comma-separated nodes; default every hour 24h..1h,30mins,15mins,10mins,5mins,1min')
    .action(async (universeId: string, options) => { const selected = nodes(options.nodes); const { http, assets } = await client(context, universeId); emit(await generateCurrentIcons(http, assets, universeId, options.output, selected)); });
  icon.command('status <universeId>').description('Read saved generated-task state offline')
    .action(async (universeId: string) => { const task = await new IconTasks(context.store(), null).status(universeId); emit({ task, nextEvent: nextIconTaskEvent(task), target: task?.targetMs ? new Date(task.targetMs).toISOString() : null, restoreAt: task ? new Date(task.restoreAt).toISOString() : null }); });
  icon.command('now <universeId>').description('Manually switch the active task to its approved NOW image; restore deadline stays fixed')
    .action(async (universeId: string) => emit(await (await client(context, universeId)).tasks.now(universeId)));
  icon.command('restore <universeId>').description('Restore the saved original icon and finish the generated task')
    .action(async (universeId: string) => emit(await (await client(context, universeId)).tasks.restore(universeId)));
  icon.command('resume <universeId>').description('Resume preparation and scheduled switches from saved state; keep this process running')
    .option('--moderation-timeout <duration>', 'Maximum moderation wait for this run', '30m')
    .action(async (universeId: string, options) => { const timeout = requireDuration(options.moderationTimeout, '--moderation-timeout'); emit(await (await client(context, universeId)).tasks.resume(universeId, timeout)); });
}
