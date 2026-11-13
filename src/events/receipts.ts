import { writeFile } from 'node:fs/promises';
import type { WriteReceipt } from '../cloud/common.js';

/** Preserve assigned IDs and uncertain outcomes beside the pre-write backup. */
export async function saveEventReceipt(receipt: WriteReceipt): Promise<WriteReceipt> {
  if (!receipt.backupPath) return receipt;
  try { await writeFile(`${receipt.backupPath}.result.json`, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch { return { ...receipt, state: 'unverified', error: { code: 'STORAGE_ERROR', message: 'Operation may have completed, but its local result could not be saved. Inspect returned IDs before retrying.' } }; }
  return receipt;
}
