import { join } from 'node:path';
import { Option, type Command } from 'commander';
import { getAssetOperation, uploadAssetImage, type AssetUploadOptions } from '../../assets/upload.js';
import { AppError, id } from '../../core/errors.js';
import { HttpClient } from '../../transport/http-client.js';
import type { CommandContext } from '../context.js';

interface UploadFlags {
  type: AssetUploadOptions['type'];
  name: string;
  description?: string;
  group?: string;
  user?: string;
  dryRun?: boolean;
}

export function registerAssetUploads(asset: Command, context: CommandContext): void {
  asset.command('upload <path>').description('Upload a PNG/JPEG as a creator-owned Image or Decal')
    .addOption(new Option('--type <type>', 'Asset type').choices(['image', 'decal']).default('image'))
    .requiredOption('--name <text>', 'Roblox asset display name')
    .option('--description <text>', 'Roblox asset description')
    .option('--group <id>', 'Creator group ID', id)
    .option('--user <id>', 'Creator user ID', id)
    .option('--dry-run', 'Validate and preview locally without uploading')
    .action(async (path: string, flags: UploadFlags) => {
      const creator = flags.group
        ? { type: 'Group' as const, id: flags.group }
        : flags.user ? { type: 'User' as const, id: flags.user } : undefined;
      if (!creator || (flags.group && flags.user)) throw new AppError('ARGUMENT_ERROR', 'Choose exactly one of --user or --group.');
      const options = { creator, type: flags.type, name: flags.name, description: flags.description, signal: context.signal };
      if (flags.dryRun) {
        context.receipt(await uploadAssetImage(new HttpClient(), path, { ...options, dryRun: true }));
        return;
      }
      const { http, local } = await context.connection();
      context.receipt(await uploadAssetImage(http, path, { ...options, backupDirectory: join(local.home, 'asset-backups') }));
    });

  asset.command('operation <operation-id>').description('Read the result of an asset upload without uploading again')
    .action(async (operationId: string) => {
      const { http } = await context.connection();
      context.receipt(await getAssetOperation(http, operationId));
    });
}
