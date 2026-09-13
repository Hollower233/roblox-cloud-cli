#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import password from '@inquirer/password';
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
import { emit, renderCatalog, clean } from './output.js';
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
