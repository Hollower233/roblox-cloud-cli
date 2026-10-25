import { isDeepStrictEqual } from 'node:util';
import { AppError, errorInfo, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import { backup, nonempty, object, pageNumber, resourceToken, uncertain, type JsonObject, type WriteOptions, type WriteReceipt, type CloudRequest } from '../cloud/common.js';

export type ConfigEntries = Record<string, unknown>;
export type DeploymentStrategy = 'Immediate' | 'GradualRollout';
export function parseConfigEntries(value: unknown): ConfigEntries {
  const entries = object(value);
  if (Object.hasOwn(entries, 'schemaVersion') && Object.hasOwn(entries, 'status') && Object.hasOwn(entries, 'data')) throw new AppError('ARGUMENT_ERROR', 'Provide config keys and values, not a CLI output envelope.');
  if (!Object.keys(entries).length || Object.keys(entries).length > 100) throw new AppError('ARGUMENT_ERROR', 'Provide 1–100 config entries.');
  for (const key of Object.keys(entries)) {
    if (!key || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new AppError('ARGUMENT_ERROR', 'Invalid config key.');
  }
  // Reject values JSON would silently drop or alter for SDK callers.
  function check(v: unknown): void {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) { for (const item of v) check(item); return; }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { for (const item of Object.values(v)) check(item); return; }
    throw new AppError('ARGUMENT_ERROR', 'Config values must be JSON values.');
  }
  try { check(entries); } catch (error) { if (error instanceof AppError) throw error; throw new AppError('ARGUMENT_ERROR', 'Config values must not contain cycles.'); }
  return entries;
}

/** In-experience Configs only. Other repository products have different semantics. */
export class ConfigRepository {
  constructor(private http: HttpClient) {}
  private base(universeId: string): string {
    return `https://apis.roblox.com/creator-configs-public-api/v1/configs/universes/${id(universeId)}/repositories/InExperienceConfig`;
  }
  private async get(url: string): Promise<JsonObject> { return object(await this.http.request(url, { auth: true }), true); }
  async read(universeId: string, full = false): Promise<JsonObject> {
    try { return { ...await this.get(this.base(universeId) + (full ? '/full' : '')), exists: true }; }
    catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 404) throw error;
      if (full) {
        const values = await this.read(universeId);
        if (values.exists === false) return values;
        throw error;
      }
      // A new experience may have neither a repository nor a draft yet. Verify
      // access to the universe through an independent official read endpoint.
      // Never infer an empty repository just from a Configs 404.
      const universe = object(await this.http.request(`https://apis.roblox.com/cloud/v2/universes/${id(universeId)}`, { auth: true }), true);
      if (typeof universe.displayName !== 'string') throw new AppError('INVALID_RESPONSE', 'Invalid universe metadata response.');
      return { exists: false, entries: {}, metadata: null, conditionalRules: null };
    }
  }
  async draft(universeId: string): Promise<JsonObject> {
    try { return { ...await this.get(this.base(universeId) + '/draft'), exists: true }; }
    catch (error) {
      if (!(error instanceof AppError) || error.httpStatus !== 404) throw error;
      // Published read also verifies universe access when its repository is new.
      await this.read(universeId);
      return { exists: false, draftHash: null, entries: {} };
    }
  }
  history(universeId: string, options: { limit?: number; skip?: number } = {}): Promise<JsonObject> {
    const url = new URL(this.base(universeId) + '/revisions');
    url.searchParams.set('MaxPageSize', String(pageNumber(options.limit ?? 20, 1)));
    url.searchParams.set('Skip', String(pageNumber(options.skip ?? 0)));
    return this.get(url.href).catch(async error => {
      if (error instanceof AppError && error.httpStatus === 404 && (await this.read(universeId)).exists === false) return { exists: false, revisions: [] };
      throw error;
    });
  }
  private async write(universeId: string, request: CloudRequest, options: WriteOptions, verifyDraft: boolean, creatingDraft = false): Promise<WriteReceipt> {
    const before = { published: await this.read(universeId), draft: await this.draft(universeId) };
    if (creatingDraft && before.draft.exists !== false) throw new AppError('ARGUMENT_ERROR', 'A draft appeared; read and review it before retrying.');
    if (request.url.endsWith('/publish') && before.draft.exists === false) throw new AppError('ARGUMENT_ERROR', 'No draft to publish. Stage changes first.');
    const expected = request.body?.previousDraftHash ?? request.body?.draftHash;
    if (expected !== undefined && expected !== before.draft.draftHash) throw new AppError('ARGUMENT_ERROR', 'Draft hash changed; read and review the current draft before retrying.');
    const receipt: WriteReceipt = { universeId, request, state: 'planned' };
    if (options.dryRun) return { ...receipt, readback: before };
    receipt.backupPath = await backup(options.backupDirectory, universeId, request, before);
    let response: JsonObject;
    try {
      response = object(await this.http.request(request.url, { auth: true, method: request.method, body: request.body }), true);
      if (verifyDraft) nonempty(response.draftHash, true);
      else if (!Number.isSafeInteger(response.configVersion) || Number(response.configVersion) < 0) throw new AppError('INVALID_RESPONSE', 'Missing published config version.');
    } catch (error) {
      if (!uncertain(error)) throw error;
      return { ...receipt, state: 'unverified', error: errorInfo(error) };
    }
    receipt.response = response;
    receipt.state = 'submitted';
    try {
      receipt.readback = verifyDraft ? await this.draft(universeId) : await this.read(universeId);
      // A matching hash confirms the staged revision. A publish read may still show
      // the previous version during rollout, so it is deliberately only submitted.
      if (verifyDraft) receipt.state = isDeepStrictEqual(receipt.readback.draftHash, response.draftHash) ? 'verified' : 'unverified';
    } catch (error) { receipt.state = 'unverified'; receipt.error = errorInfo(error); }
    return receipt;
  }
  async setDraft(universeId: string, value: unknown, options: WriteOptions & { previousDraftHash?: string } = {}): Promise<WriteReceipt> {
    const entries = parseConfigEntries(value), url = this.base(universeId) + '/draft';
    // Read immediately before patching for optimistic concurrency. An explicit
    // expected hash can also guard changes prepared earlier by a caller.
    const current = await this.draft(universeId);
    const creatingDraft = current.exists === false;
    const previousDraftHash = options.previousDraftHash !== undefined ? nonempty(options.previousDraftHash)
      : creatingDraft ? undefined : nonempty(current.draftHash, true);
    return this.write(universeId, { url, method: 'PATCH', body: { entries, ...(previousDraftHash === undefined ? {} : { previousDraftHash }) } }, options, true, creatingDraft);
  }
  publish(universeId: string, draftHash: string, options: WriteOptions & { message?: string; strategy?: DeploymentStrategy } = {}): Promise<WriteReceipt> {
    nonempty(draftHash);
    const strategy = options.strategy ?? 'Immediate';
    if (!['Immediate', 'GradualRollout'].includes(strategy)) throw new AppError('ARGUMENT_ERROR', 'Invalid deployment strategy.');
    return this.write(universeId, { url: this.base(universeId) + '/publish', method: 'POST', body: { draftHash, message: options.message ?? '', deploymentStrategy: strategy } }, options, false);
  }
  restore(universeId: string, revisionId: string, options: WriteOptions = {}): Promise<WriteReceipt> {
    return this.write(universeId, { url: this.base(universeId) + `/revisions/${resourceToken(revisionId)}/restore`, method: 'POST' }, options, true);
  }
}
