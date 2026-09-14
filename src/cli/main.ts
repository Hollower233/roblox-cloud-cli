#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import password from '@inquirer/password';
import { downloadAssetImage, parseAssetId } from '../assets/download.js';
import { clearAssetCache } from '../cache/assets.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataStoreEntries } from '../datastores/entries.js';
import { copyProfiles, resolveProfilePlayers, resolveProfileUniverse } from '../profiles/copy.js';
import { CredentialStore, validateKey } from '../auth/credentials.js';
import { AppError, errorInfo, exitCode, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import { RobloxApi } from '../roblox/api.js';
import { LocalStore, defaultHome } from '../storage/store.js';
import { CatalogService, selectGames } from '../universes/catalog.js';
import { emit, renderCatalog, renderIconPlan, localTime, remaining, clean } from './output.js';
import { IconAssets, IconCountdown, type CountdownEvent, type CountdownOptions } from '../icons/countdown.js';
import { parseTargetTime, requireDuration } from '../icons/frames.js';
import type { Catalog, Warning } from '../universes/models.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const program = new Command().name('rbx').description('Roblox Cloud CLI: credentials and verified local universe catalogs.').version('0.1.0')
  .option('--home <directory>', 'Override the local application data directory')
  .option('--json', 'Emit one JSON object on stdout; partial result exits with 3')
  .exitOverride().configureOutput({ outputError: () => {} });
function store(): LocalStore { return new LocalStore(resolve(program.opts().home ?? defaultHome())); }
function json(): boolean { return Boolean(program.opts().json); }
function api(key: string): RobloxApi { return new RobloxApi(new HttpClient({ apiKey: key, signal: abort.signal }), key); }
function service(client: RobloxApi): CatalogService { return new CatalogService(client, { signal: abort.signal, progress: message => { process.stderr.write(clean(message) + '\n'); } }); }
function envWarning(): Warning[] { return process.env.ROBLOX_API_KEY !== undefined ? [{ code: 'ENV_KEY_OVERRIDES_STORED_KEY', message: 'ROBLOX_API_KEY takes precedence over the saved credential.' }] : []; }

program.command('asset').description('Download original Roblox images')
  .command('download <assetId>').description('Download delivered PNG/JPEG bytes, resolving XML Decal textures')
  .option('-o, --output <path>', 'Output file path (default: <assetId>.<detected extension>); never overwrites')
  .action(async (input: string, options) => {
    const assetId = parseAssetId(input);
    const key = await new CredentialStore(store().home).get();
    const result = await downloadAssetImage(new HttpClient({ apiKey: key, signal: abort.signal }), assetId, { output: options.output, signal: abort.signal });
    emit(result, json(), `Saved original image: ${result.path}\n${result.width}x${result.height} ${result.format}, ${result.bytes} bytes\nSHA-256: ${result.sha256}`);
  });

const auth = program.command('auth').description('Configure and validate API credentials');
auth.command('set').description('Validate and securely save a key (Windows DPAPI)')
  .option('--key-file <path>', 'Read an existing local key file instead of prompting')
  .action(async options => {
    let key: string;
    if (options.keyFile) {
      try { key = validateKey(await readFile(resolve(options.keyFile), 'utf8')); }
      catch (e) { if (e instanceof AppError) throw e; throw new AppError('ARGUMENT_ERROR', 'Cannot read the key file.'); }
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('ARGUMENT_ERROR', 'Use --key-file when no interactive terminal is available.');
      key = validateKey(await password({ message: 'Roblox API Key', mask: '*' }));
    }
    const identity = await api(key).identity(), local = store();
    await local.locked(async () => {
      const config = await local.config();
      await new CredentialStore(local.home).set(key);
      config.currentUserId = identity.userId; config.accounts[identity.userId] ??= { manualIds: [] };
      await local.saveConfig(config);
    });
    emit({ userId: identity.userId, storage: 'Windows DPAPI' }, json(), `Saved encrypted API key for user ${identity.userId}.`, envWarning());
  });
auth.command('status').description('Validate the active key and show its scopes').action(async () => {
  const local = store(), identity = await api(await new CredentialStore(local.home).get()).identity();
  emit({ ...identity, source: process.env.ROBLOX_API_KEY !== undefined ? 'environment' : 'Windows DPAPI' }, json(), `User: ${identity.userId}\nEnabled: ${identity.enabled}\nExpired: ${identity.expired}\nScopes:\n${identity.scopes.map(s => `  ${s.name}: ${s.operations.join(', ')}`).join('\n')}`);
});
auth.command('clear').description('Remove the saved key; retain local catalogs').action(async () => {
  const local = store(); await local.locked(() => new CredentialStore(local.home).clear());
  emit({ cleared: true }, json(), 'Removed the saved credential. Local catalogs were retained.', envWarning());
});

const universe = program.command('universe').description('Discover, refresh and inspect local game catalogs');
async function mutate(mode: 'scan' | 'refresh' | 'add', universeId?: string): Promise<void> {
  if (universeId) id(universeId);
  const local = store(), client = api(await new CredentialStore(local.home).get()), identity = await client.identity();
  const result = await local.locked(async () => {
    const config = await local.config(), old = await local.catalog(identity.userId), business = service(client);
    const account = config.accounts[identity.userId] ?? { manualIds: [] };
    let catalog: Catalog;
    if (mode === 'scan') catalog = await business.scan(identity, old, account.manualIds);
    else if (mode === 'refresh') {
      if (!old) throw new AppError('ARGUMENT_ERROR', 'No cached catalog; run universe scan first.');
      catalog = await business.refresh(identity, old);
    } else {
      catalog = await business.add(identity, old, universeId!);
      account.manualIds = [...new Set([...account.manualIds, universeId!])];
    }
    // Config first preserves manual intent if a later cache write is interrupted.
    config.currentUserId = identity.userId; config.accounts[identity.userId] = account;
    await local.saveConfig(config); await local.saveCatalog(catalog); return catalog;
  });
  emit(result, json(), renderCatalog(result, selectGames(result)), result.warnings);
}
universe.command('scan').description('Discover personal public and manageable group games, then save').action(() => mutate('scan'));
universe.command('refresh').description('Refresh metadata and permissions of cached games').action(() => mutate('refresh'));
universe.command('add <universeId>').description('Verify and persist a manually registered universe').action((universeId: string) => mutate('add', universeId));
universe.command('list').description('Read the local cache only; never calls Roblox')
  .option('--owner <name-or-id>', 'Filter by owner name or ID')
  .option('--visibility <visibility>', 'public, private or unknown')
  .option('--sort <field>', 'name or ccu', 'name')
  .option('--all', 'Include entries whose management permission is false or unknown')
  .option('--user-id <id>', 'Read another locally cached account')
  .action(async options => {
    if (options.visibility && !['public', 'private', 'unknown'].includes(options.visibility)) throw new AppError('ARGUMENT_ERROR', 'Visibility must be public, private or unknown.');
    if (!['name', 'ccu'].includes(options.sort)) throw new AppError('ARGUMENT_ERROR', 'Sort must be name or ccu.');
    const local = store(), config = await local.config(), userId = options.userId ? id(options.userId) : config.currentUserId;
    if (!userId) throw new AppError('ARGUMENT_ERROR', 'No active cached account; run universe scan first.');
    const catalog = await local.catalog(userId);
    if (!catalog) throw new AppError('ARGUMENT_ERROR', 'No cached catalog; run universe scan first.');
    const games = selectGames(catalog, options);
    emit({ ...catalog, games }, json(), renderCatalog(catalog, games), catalog.warnings);
  });

const datastore = program.command('datastore').description('Read and copy standard DataStore entries');
datastore.command('get <universeId> <datastore> <key>').option('--scope <scope>', 'DataStore scope', 'global')
  .action(async (universeId, name, key, options) => {
    const local = store(), apiKey = await new CredentialStore(local.home).get();
    const entry = await new DataStoreEntries(new HttpClient({ apiKey, signal: abort.signal })).get({ universeId, datastore: name, key, scope: options.scope });
    emit({ entry }, json(), entry ? entry.raw : 'Entry does not exist.');
  });
datastore.command('copy <sourceUniverseId> <targetUniverseId> <datastore> <key>').option('--scope <scope>', 'DataStore scope', 'global')
  .description('Copy one entry, backing up locally and conditionally replacing the target, then verify')
  .action(async (sourceUniverseId, targetUniverseId, name, key, options) => {
    const local = store(), apiKey = await new CredentialStore(local.home).get();
    const entries = new DataStoreEntries(new HttpClient({ apiKey, signal: abort.signal }));
    const address = { datastore: name, key, scope: options.scope };
    const result = await entries.copy({ ...address, universeId: sourceUniverseId }, { ...address, universeId: targetUniverseId }, resolve(local.home, 'datastore-backups'));
    emit(result, json(), `Copied and verified ${result.bytes} bytes. Backup: ${result.backupPath}`);
  });

program.command('profile').description('Player profile presets')
  .command('copy <sourceUniverse> <targetUniverse>')
  .description('Copy player profiles with local backups; replaces existing targets and verifies each copy')
  .requiredOption('--players <usernames-or-ids>', 'Comma-separated Roblox usernames or User IDs')
  .option('--preset <preset>', 'Storage preset: profileservice (Default / PLAYER_{uid} / global)', 'profileservice')
  .action(async (source: string, target: string, options) => {
    if (options.preset !== 'profileservice') throw new AppError('ARGUMENT_ERROR', 'Supported preset: profileservice.');
    const local = store();
    const needsCatalog = !/^\d+$/.test(source.trim()) || !/^\d+$/.test(target.trim());
    const config = needsCatalog ? await local.config() : undefined;
    const catalog = config?.currentUserId ? await local.catalog(config.currentUserId) : null;
    const sourceId = resolveProfileUniverse(source, catalog?.games), targetId = resolveProfileUniverse(target, catalog?.games);
    if (sourceId === targetId) throw new AppError('ARGUMENT_ERROR', 'Source and target universes must differ.');
    const http = new HttpClient({ apiKey: await new CredentialStore(local.home).get(), signal: abort.signal });
    const players = await resolveProfilePlayers(options.players, http);
    const result = await copyProfiles(new DataStoreEntries(http), sourceId, targetId, players, resolve(local.home, 'datastore-backups'), abort.signal);
    const warnings = result.results.filter(item => item.status === 'error').map(item => ({ code: 'PROFILE_COPY_FAILED', resource: item.userId, message: item.error!.message }));
    const human = result.results.map(item => item.status === 'success'
      ? `${clean(item.name)} (${item.userId}): copied and verified ${item.result!.bytes} bytes. Backup: ${item.result!.backupPath}`
      : `${clean(item.name)} (${item.userId}): FAILED [${item.error!.code}] ${clean(item.error!.message)}`).join('\n');
    emit(result, json(), `${human}\nSucceeded: ${result.succeeded}; failed: ${result.failed}; skipped: ${result.skipped}`, warnings);
    if (abort.signal.aborted || result.results.some(item => item.status === 'error' && item.error.code === 'CANCELLED')) process.exitCode = 130;
    else if (result.failed && !result.succeeded) process.exitCode = 1;
  });

program.command('cache').description('Manage local Roblox asset caches')
  .command('clear').description('Clear Windows asset caches; always returns JSON, never prompts or stops processes')
  .action(async () => {
    const result = await clearAssetCache();
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ...result }) + '\n');
    process.exitCode = result.status === 'success' ? 0 : result.status === 'partial' ? 3 : 1;
  });

program.command('icon').description('Game icon tools')
  .command('countdown <universeId> <folder>')
  .description('Pre-upload countdown icons, wait for moderation, then switch the root place icon on schedule')
  .option('--at <time>', 'Target time: "YYYY-MM-DD HH:MM[:SS]" local time, or ISO-8601 with timezone')
  .option('--in <duration>', 'Target this long after all icons pass moderation, e.g. 3h or 1h30m')
  .option('--moderation-timeout <duration>', 'Maximum wait for moderation', '30m')
  .option('--no-cache', 'Upload again instead of reusing cached image asset IDs')
  .option('--reset', 'With --in: discard the unfinished countdown for this folder and start over')
  .option('--restore-after <duration>', 'Switch back to the original icon this long after now, e.g. 1h')
  .option('--dry-run', 'Show the plan from local files only; no API calls or writes')
  .action(async (universeId: string, folder: string, options) => {
    id(universeId);
    if (Boolean(options.at) === Boolean(options.in)) throw new AppError('ARGUMENT_ERROR', 'Specify exactly one of --at or --in.');
    if (options.reset && !options.in) throw new AppError('ARGUMENT_ERROR', '--reset only applies to --in.');
    const local = store(), config = await local.config();
    const catalog = config.currentUserId ? await local.catalog(config.currentUserId) : null;
    const game = catalog?.games.find(item => item.universeId === universeId);
    if (!game) throw new AppError('ARGUMENT_ERROR', `Universe ${universeId} is not in the local catalog; run rbx universe add ${universeId} first.`);
    const countdownOptions: CountdownOptions = {
      universeId, folder: resolve(folder), creator: { type: game.owner.type, id: game.owner.id },
      target: options.at ? { at: parseTargetTime(options.at) } : { inMs: requireDuration(options.in, '--in') },
      moderationTimeoutMs: requireDuration(options.moderationTimeout, '--moderation-timeout'), noCache: options.cache === false, reset: Boolean(options.reset),
      ...(options.restoreAfter ? { restoreAfterMs: requireDuration(options.restoreAfter, '--restore-after') } : {}),
    };
    if (options.dryRun) {
      const preview = await new IconCountdown(local, null).preview(countdownOptions);
      emit(preview, json(), preview.alreadyCompleted ? `该倒计时已完成（目标时刻 ${localTime(preview.target)}）。` : `${preview.resumed ? '续跑已有倒计时。\n' : ''}${renderIconPlan(preview.target, preview.nodes, preview.skipped, preview.restoreAt)}\n[dry-run] 未调用 API，也未写入文件。`, preview.warnings);
      return;
    }
    const apiKey = await new CredentialStore(local.home).get(), identity = await api(apiKey).identity();
    const scope = identity.scopes.find(item => item.name === 'asset');
    if (!scope || !['read', 'write'].every(operation => scope.operations.includes(operation))) throw new AppError('FORBIDDEN', 'The API key needs the asset:read and asset:write scopes.');
    // --json streams one JSON event per line (NDJSON) because the command runs until the target time.
    let ticking = false, reviewing = '';
    const say = (text: string) => { if (ticking) { process.stderr.write('\n'); ticking = false; } process.stderr.write(text + '\n'); };
    const onEvent = (event: CountdownEvent) => {
      if (json()) { process.stdout.write(JSON.stringify({ schemaVersion: 1, ...event }) + '\n'); return; }
      if (event.event === 'scanned') {
        say(`找到 ${event.frames.length} 张图标：${event.frames.map(frame => clean(frame.label)).join(', ')}`);
        for (const w of event.warnings) say(`Warning [${clean(w.code)}] ${clean(w.resource ?? '')} ${clean(w.message)}`);
      } else if (event.event === 'asset') say(`${clean(event.file)} → 素材 ${event.assetId}（${event.source === 'cache' ? '缓存' : '已上传'}，审核：${event.moderationState}）`);
      else if (event.event === 'moderation') { const names = event.reviewing.map(clean).join(', '); if (names !== reviewing) say(`等待审核：${names}`); reviewing = names; }
      else if (event.event === 'planned') say(`${event.resumed ? '续跑已有倒计时。' : '全部审核通过，开始倒计时。'}原图标素材：${event.originalIconAssetId ?? '无'}\n${renderIconPlan(event.target, event.nodes, event.skipped, event.restoreAt)}`);
      else if (event.event === 'missed') say(`已错过：${event.labels.map(clean).join(', ')}`);
      else if (event.event === 'restore-waiting') say(`等待恢复原图标（素材 ${event.assetId}），时间 ${localTime(event.at)}`);
      else if (event.event === 'restored') say(`[${localTime(event.at)}] 已恢复原图标（素材 ${event.assetId}）`);
      else if (event.event === 'restore-skipped') say(`[${localTime(event.at)}] 图标已被他人修改（当前素材 ${event.currentIconAssetId ?? '无'}），跳过恢复`);
      else if (event.event === 'icon') say(`[${localTime(event.at)}] 图标已切换为 ${clean(event.file)}（素材 ${event.assetId}）`);
    };
    const onTick = !json() && process.stderr.isTTY
      ? (next: { file: string }, left: number) => { process.stderr.write(`\r下一个：${clean(next.file)}  剩余 ${remaining(left)}   `); ticking = true; }
      : undefined;
    const http = new HttpClient({ apiKey, signal: abort.signal });
    const result = await new IconCountdown(local, new IconAssets(http, undefined, abort.signal), { signal: abort.signal, onEvent, onTick }).run(countdownOptions);
    if (!json()) {
      if (ticking) process.stderr.write('\n');
      process.stdout.write(result.alreadyCompleted ? `该倒计时已完成（目标时刻 ${localTime(result.target)}）。\n` : `倒计时完成，目标时刻 ${localTime(result.target)}。原图标素材：${result.originalIconAssetId ?? '无'}${result.restore === 'restored' ? '（已恢复）' : result.restore === 'skipped' ? '（图标被他人修改，未恢复）' : ''}\n`);
    }
  });

try { await program.parseAsync(process.argv); }
catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    if (error instanceof CommanderError) error = new AppError('ARGUMENT_ERROR', 'Invalid command or arguments. Run rbx --help.');
    if (abort.signal.aborted) error = new AppError('CANCELLED', 'Operation cancelled.');
    const info = errorInfo(error);
    if (json() || process.argv.includes('--json')) process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'error', error: info }) + '\n');
    else process.stderr.write(`Error [${info.code}] ${clean(info.message)}\n`);
    process.exitCode = exitCode(error);
  }
}
