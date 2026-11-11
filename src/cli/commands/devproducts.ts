import type { Command } from 'commander';
import { uploadDeveloperProductIcon } from '../../devproducts/icon.js';
import { join } from 'node:path';
import { listDeveloperProducts, loadDeveloperProductTable, type DeveloperProduct } from '../../devproducts/products.js';
import { CONFIRM_INSTRUCTION, STALE_INSTRUCTION, syncDeveloperProducts, syncWarnings, type DeveloperProductSyncResult, type UniverseResult } from '../../devproducts/sync.js';
import type { CommandContext } from '../context.js';
import { clean, emit } from '../output.js';

/** Exit code when sync stopped to wait for a human-approved --confirm; nothing was written. */
export const CONFIRMATION_EXIT_CODE = 6;

const price = (value: number | null | undefined) => value === null || value === undefined ? '?' : String(value);

function duplicateNames(products: DeveloperProduct[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

function renderUniverse(universe: UniverseResult): string {
  const lines = [`宇宙 ${universe.universeId}`];
  if (universe.rejected) {
    lines.push(`  ✗ 拒绝同步：${clean(universe.rejected.message)}`);
    for (const d of universe.rejected.duplicates ?? []) lines.push(`    重名 ${JSON.stringify(clean(d.name))}：${d.productIds.join(', ')}`);
    if (universe.error) lines.push(`    ${clean(universe.error.code)} ${clean(universe.error.message)}`);
    return lines.join('\n');
  }
  for (const action of universe.actions) {
    const state = 'state' in action ? `  [${action.state}${action.error ? ` ${clean(action.error.code)}: ${clean(action.error.message)}` : ''}]` : '';
    const name = JSON.stringify(clean(action.name));
    if (action.kind === 'update') lines.push(`  update  #${action.productId} ${name}  价格 ${price(action.fromPrice)} → ${action.price}${state}`);
    else if (action.kind === 'reuse') lines.push(`  reuse   #${action.productId} ${JSON.stringify(clean(action.fromName ?? ''))}（${price(action.fromPrice)}）→ ${name}（${action.price}）${state}`);
    else lines.push(`  create  ${name}  价格 ${action.price}${'resultProductId' in action && action.resultProductId ? `  → #${action.resultProductId}` : ''}${state}`);
  }
  lines.push(`  unchanged ${universe.unchanged}`);
  if (universe.idle.length) lines.push(`  闲置未用（不改动）：${universe.idle.map(p => `#${p.productId} ${JSON.stringify(clean(p.name))}`).join(', ')}`);
  if (universe.immutable.length) lines.push(`  不可修改、不参与复用：${universe.immutable.map(p => `#${p.productId} ${JSON.stringify(clean(p.name))}`).join(', ')}`);
  if (universe.backupPath) lines.push(`  备份：${universe.backupPath}`);
  return lines.join('\n');
}

export function renderSync(result: DeveloperProductSyncResult): string {
  const body = result.universes.map(renderUniverse).join('\n');
  if (result.state === 'synced') return body;
  return `${body}\n\n⚠ ${result.stale ? STALE_INSTRUCTION : CONFIRM_INSTRUCTION}\nconfirmToken: ${result.confirmToken}`;
}

export function registerDeveloperProducts(program: Command, context: CommandContext): void {
  const json = () => Boolean(program.opts().json);
  const root = program.command('devproduct').description('List developer products and sync the Studio developer product table to universes');

  root.command('icon <game> <productId>').description('Upload a default product icon (PNG/JPEG; fits within 512x512)')
    .requiredOption('--image <path>', 'Local image file')
    .option('--dry-run', 'Validate image and product without uploading')
    .action(async (input: string, productId: string, options: { image: string; dryRun?: boolean }) => {
      const { universeId, http, local } = await context.universe(input);
      context.receipt(await uploadDeveloperProductIcon(http, universeId, productId, options.image, {
        dryRun: options.dryRun, backupDirectory: join(local.home, 'devproduct-backups'),
      }));
    });

  root.command('list <game>').description('List every developer product of a universe (read-only; pages to the end)')
    .action(async (input: string) => {
      const { universeId, http } = await context.universe(input);
      const products = await listDeveloperProducts(http, universeId, (page, total) => { if (!json()) process.stderr.write(`page ${page}: ${total}\r`); });
      if (!json()) process.stderr.write('\n');
      const duplicates = duplicateNames(products);
      const warnings = [...duplicates].map(name => ({ code: 'DUPLICATE_PRODUCT_NAME', message: `Duplicated name ${JSON.stringify(name)}; devproduct sync refuses this universe.`, resource: universeId }));
      const rows = products.map(p => `${p.productId}\t${p.price ?? '?'}\t${p.isForSale ? 'yes' : 'no'}\t${p.regionalPricing ? 'yes' : 'no'}\t${duplicates.has(p.name) ? '⚠重名 ' : ''}${clean(p.name)}`);
      emit({ universeId, count: products.length, products }, json(),
        `Universe: ${universeId}  (${products.length} products)\nPRODUCT ID\tPRICE\tFOR SALE\tREGIONAL\tNAME\n${rows.join('\n')}`, warnings);
    });

  root.command('sync <games...>').description('Push the developer product table (match by English name: update price, reuse products not in the table, create the rest)')
    .requiredOption('--source <rbxm>', 'Developer product table exported from Studio (export_rbxm of 项目文档/开发者产品)')
    .option('--confirm <token>', 'Confirm token from a previous run, only after a human approved its reuse diff')
    .action(async (inputs: string[], options: { source: string; confirm?: string }) => {
      const rows = await loadDeveloperProductTable(options.source);
      const targets = [];
      let home = '';
      for (const input of inputs) {
        const { universeId, http, local } = await context.universe(input);
        targets.push({ universeId, http });
        home = local.home;
      }
      const result = await syncDeveloperProducts(targets, rows, {
        confirm: options.confirm, backupDirectory: join(home, 'devproduct-backups'),
        onProgress: message => { if (!json()) process.stderr.write(`${clean(message)}\n`); },
      });
      if (result.state === 'confirmation_required') {
        const agentInstruction = result.stale ? STALE_INSTRUCTION : CONFIRM_INSTRUCTION;
        if (json()) process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'confirmation_required', data: { ...result, agentInstruction }, warnings: [] }) + '\n');
        else process.stdout.write(renderSync(result) + '\n');
        process.exitCode = CONFIRMATION_EXIT_CODE;
        return;
      }
      emit(result, json(), renderSync(result), syncWarnings(result));
    });
}
