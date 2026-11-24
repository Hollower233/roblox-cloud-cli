import { join } from 'node:path';
import type { Command } from 'commander';
import { SubscriptionProducts, subscriptionProductId, subscriptionRobuxPrice,
  type CreateSubscriptionFields, type SubscriptionReceipt, type SubscriptionWriteOptions, type UpdateSubscriptionFields } from '../../subscriptions/products.js';
import type { CommandContext } from '../context.js';

export function registerSubscriptions(program: Command, context: CommandContext): void {
  const subscriptions = program.command('subscription').description('Manage experience subscription products with a Roblox session cookie');
  const write = async (game: string, dryRun: boolean | undefined, action: (products: SubscriptionProducts, universeId: string,
    options: SubscriptionWriteOptions) => Promise<SubscriptionReceipt>, auth: 'cookie' | 'none' = 'cookie') => {
    const { universeId, http, local } = await context.universe(game, auth);
    const run = () => action(new SubscriptionProducts(http), universeId, {
      dryRun, backupDirectory: join(local.home, 'subscription-backups'),
    });
    context.receipt(dryRun ? await run() : await local.locked(run));
  };

  subscriptions.command('list <game>').description('List every subscription product in the experience').action(async (game: string) => {
    const { universeId, http } = await context.universe(game, 'cookie');
    context.output({ universeId, products: await new SubscriptionProducts(http).list(universeId) });
  });
  subscriptions.command('get <game> <product-id>').description('Read a subscription product by EXP ID').action(async (game: string, input: string) => {
    const productId = subscriptionProductId(input);
    const { universeId, http } = await context.universe(game, 'cookie');
    context.output(await new SubscriptionProducts(http).get(universeId, productId));
  });
  subscriptions.command('create <game>').description('Create an inactive monthly Robux subscription and upload its cover')
    .requiredOption('--name <text>', 'Unique subscription name').requiredOption('--description <text>', 'Subscription benefits')
    .requiredOption('--price <robux>', 'Monthly base price (minimum 49)', subscriptionRobuxPrice)
    .requiredOption('--type <type>', 'consumable, currency, or durable').requiredOption('--image <path>', 'PNG or JPEG cover')
    .option('--dry-run', 'Validate and preview locally without contacting Roblox')
    .action((game: string, options: CreateSubscriptionFields & { dryRun?: boolean }) =>
      write(game, options.dryRun, (products, universeId, writeOptions) => products.create(universeId, options, writeOptions),
        options.dryRun ? 'none' : 'cookie'));
  subscriptions.command('update <game> <product-id>').description('Change only the selected fields or upload a cover')
    .option('--description <text>').option('--price <robux>', 'Monthly base price', subscriptionRobuxPrice)
    .option('--image <path>', 'PNG or JPEG cover').option('--dry-run', 'Read current settings and preview the changes')
    .action((game: string, input: string, options: UpdateSubscriptionFields & { dryRun?: boolean }) =>
      write(game, options.dryRun, (products, universeId, writeOptions) => products.update(universeId, input, options, writeOptions)));
  subscriptions.command('activate <game> <product-id>').description('Put a subscription up for sale')
    .option('--short-name <text>', 'Permanent experience short name, only needed for the first activation')
    .option('--dry-run', 'Read the current product and the experience short-name requirement')
    .action((game: string, input: string, options: { dryRun?: boolean; shortName?: string }) =>
      write(game, options.dryRun, (products, universeId, writeOptions) =>
        products.activate(universeId, input, { ...writeOptions, shortName: options.shortName })));
}
