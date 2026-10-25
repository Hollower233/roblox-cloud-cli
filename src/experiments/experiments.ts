import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorInfo, id } from '../core/errors.js';
import { HttpClient } from '../transport/http-client.js';
import { backup, nonempty, object, pageNumber, resourceToken, uncertain, type JsonObject, type WriteOptions, type WriteReceipt } from '../cloud/common.js';
import { parseConfigEntries } from '../configs/repository.js';

export interface ExperimentVariant {
  variantMeta: { label: string; isBaseline: boolean; weight: number };
  configEntry: { key: string; entryValue?: unknown };
}
export interface ExperimentDefinition {
  name: string; description?: string; exposurePercent: number; durationSeconds: number;
  universeGoalMetric: string;
  experimentConfiguration: {
    productType: 'EXPERIMENT_PRODUCT_TYPE_IN_GAME_CONFIGS';
    inGameConfigExperimentConfiguration: { variants: ExperimentVariant[] };
  };
}
const metrics = new Set(['AVERAGE_SESSION_TIME', 'PLAYTIME_PER_USER', 'DAY_1_RETENTION', 'DAY_7_RETENTION', 'PAYER_CONVERSION_RATE', 'AVERAGE_REVENUE_PER_USER', 'AVERAGE_REVENUE_PER_PAYING_USER'].map(value => `UNIVERSE_EXPERIMENT_METRIC_${value}`));
export function parseExperimentDefinition(value: unknown): ExperimentDefinition {
  const root = object(value);
  const allowed = ['name', 'description', 'exposurePercent', 'durationSeconds', 'universeGoalMetric', 'experimentConfiguration'];
  if (Object.keys(root).some(key => !allowed.includes(key))) throw new AppError('ARGUMENT_ERROR', 'Provide mutable experiment fields only; read/output envelopes are not accepted.');
  nonempty(root.name);
  if (root.description !== undefined && typeof root.description !== 'string') throw new AppError('ARGUMENT_ERROR', 'Invalid experiment description.');
  if (typeof root.exposurePercent !== 'number' || !Number.isFinite(root.exposurePercent) || root.exposurePercent <= 0 || root.exposurePercent > 100) throw new AppError('ARGUMENT_ERROR', 'Exposure must be greater than 0 and at most 100.');
  if (!Number.isSafeInteger(root.durationSeconds) || Number(root.durationSeconds) < 14 * 86400 || Number(root.durationSeconds) > 60 * 86400) throw new AppError('ARGUMENT_ERROR', 'Experiment duration must be 14–60 days.');
  if (!metrics.has(String(root.universeGoalMetric))) throw new AppError('ARGUMENT_ERROR', 'Unsupported experiment goal metric.');
  const config = object(root.experimentConfiguration);
  if (config.productType !== 'EXPERIMENT_PRODUCT_TYPE_IN_GAME_CONFIGS' || Object.keys(config).some(key => !['productType', 'inGameConfigExperimentConfiguration'].includes(key))) throw new AppError('ARGUMENT_ERROR', 'Only in-experience config experiments are supported.');
  const block = object(config.inGameConfigExperimentConfiguration);
  if (Object.keys(block).some(key => key !== 'variants') || !Array.isArray(block.variants) || block.variants.length < 2 || block.variants.length > 3) throw new AppError('ARGUMENT_ERROR', 'Provide a baseline and 1–2 treatment variants.');
  const variants = block.variants.map(value => {
    const variant = object(value), meta = object(variant.variantMeta), entry = object(variant.configEntry);
    if (Object.keys(variant).some(key => !['variantMeta', 'configEntry'].includes(key)) || Object.keys(meta).some(key => !['label', 'isBaseline', 'weight'].includes(key)) || Object.keys(entry).some(key => !['key', 'entryValue'].includes(key))) throw new AppError('ARGUMENT_ERROR', 'Unknown variant field.');
    nonempty(meta.label); nonempty(entry.key);
    if (typeof meta.isBaseline !== 'boolean' || typeof meta.weight !== 'number' || !Number.isFinite(meta.weight) || meta.weight <= 0 || meta.weight > 100) throw new AppError('ARGUMENT_ERROR', 'Invalid variant baseline or weight.');
    if (meta.isBaseline && Object.hasOwn(entry, 'entryValue')) throw new AppError('ARGUMENT_ERROR', 'Baseline uses the published config value; omit entryValue.');
    if (!meta.isBaseline && (!Object.hasOwn(entry, 'entryValue') || entry.entryValue === null)) throw new AppError('ARGUMENT_ERROR', 'Treatment must provide a non-null entryValue.');
    parseConfigEntries({ [String(entry.key)]: meta.isBaseline ? true : entry.entryValue });
    return variant as unknown as ExperimentVariant;
  });
  if (variants.filter(v => v.variantMeta.isBaseline).length !== 1 || Math.abs(variants.reduce((sum, v) => sum + v.variantMeta.weight, 0) - 100) > 1e-8 || new Set(variants.map(v => v.configEntry.key)).size !== 1 || new Set(variants.map(v => v.variantMeta.label)).size !== variants.length) throw new AppError('ARGUMENT_ERROR', 'Variants need one baseline, distinct labels, a shared config key and weights totaling 100.');
  return root as unknown as ExperimentDefinition;
}
export interface ExperimentWaitOptions { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }
export interface ExperimentWriteOptions extends WriteOptions, ExperimentWaitOptions { wait?: boolean }
function validateWait(options: ExperimentWaitOptions): void {
  const timeout = options.timeoutMs ?? 60_000, interval = options.intervalMs ?? 2000;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isFinite(interval) || interval < 1) throw new AppError('ARGUMENT_ERROR', 'Invalid operation polling duration.');
}
export interface ExperimentOperation extends JsonObject { done: boolean; operationId?: string }
function operation(value: unknown): ExperimentOperation {
  const op = object(object(value, true).operation, true);
  if (typeof op.done !== 'boolean' || !op.done && typeof op.operationId !== 'string') throw new AppError('INVALID_RESPONSE', 'Invalid experiment operation.');
  if (op.operationId !== undefined) {
    try { resourceToken(String(op.operationId)); } catch { throw new AppError('INVALID_RESPONSE', 'Invalid operation ID.'); }
  }
  return op as ExperimentOperation;
}
export class Experiments {
  constructor(private http: HttpClient) {}
  private base(universeId: string): string { return `https://apis.roblox.com/creator-configs-public-api/v1/experimentation/universes/${id(universeId)}`; }
  private experimentUrl(universeId: string, experimentId: string): string { return this.base(universeId) + `/experiments/${resourceToken(experimentId)}`; }
  async list(universeId: string, options: { limit?: number; skip?: number; search?: string } = {}): Promise<JsonObject> {
    const url = new URL(this.base(universeId) + '/experiments');
    url.searchParams.set('maxPageSize', String(pageNumber(options.limit ?? 20, 1)));
    url.searchParams.set('skip', String(pageNumber(options.skip ?? 0)));
    if (options.search) url.searchParams.set('searchKey', options.search);
    const result = object(await this.http.request(url.href, { auth: true }), true);
    if (!Array.isArray(result.experiments) || !Number.isSafeInteger(result.total) || Number(result.total) < 0) throw new AppError('INVALID_RESPONSE', 'Invalid experiments page.');
    return result;
  }
  async get(universeId: string, experimentId: string): Promise<JsonObject> {
    return object(object(await this.http.request(this.experimentUrl(universeId, experimentId), { auth: true }), true).experiment, true);
  }
  async getOperation(universeId: string, operationId: string): Promise<ExperimentOperation> {
    return operation(await this.http.request(this.base(universeId) + `/operations/${resourceToken(operationId)}`, { auth: true }));
  }
  async wait(universeId: string, initial: ExperimentOperation, options: ExperimentWaitOptions = {}): Promise<ExperimentOperation> {
    const timeout = options.timeoutMs ?? 60_000, interval = options.intervalMs ?? 2000;
    validateWait(options);
    let op = initial;
    const deadline = Date.now() + timeout;
    while (!op.done && Date.now() < deadline) {
      if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation polling cancelled.');
      try { await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal }); }
      catch (error) { if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation polling cancelled.'); throw error; }
      if (Date.now() >= deadline) break;
      op = await this.getOperation(universeId, nonempty(op.operationId, true));
    }
    return op;
  }
  private async settle(universeId: string, receipt: WriteReceipt, initial: ExperimentOperation, options: ExperimentWriteOptions): Promise<WriteReceipt> {
    receipt.operationId = initial.operationId;
    receipt.response = initial;
    try {
      const op = options.wait === false ? initial : await this.wait(universeId, initial, options);
      receipt.response = op;
      if (op.error != null) {
        // Preserve the structured failure in response; don't echo its free text into logs.
        return { ...receipt, state: 'unverified', error: { code: 'OPERATION_FAILED', message: 'Roblox experiment operation failed; inspect response and operationId.' } };
      }
      return { ...receipt, state: op.done ? 'verified' : 'pending' };
    } catch (error) { return { ...receipt, state: 'unverified', error: errorInfo(error) }; }
  }
  private async mutate(universeId: string, suffix: string, method: 'POST' | 'PATCH', body: JsonObject | undefined, options: ExperimentWriteOptions, experimentId?: string): Promise<WriteReceipt> {
    validateWait(options);
    if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled before submission.');
    const url = experimentId ? this.experimentUrl(universeId, experimentId) + suffix : this.base(universeId) + '/experiments';
    const request = { url, method, ...(body ? { body } : {}) };
    const before = experimentId ? await this.get(universeId, experimentId) : null;
    const receipt: WriteReceipt = { universeId, state: 'planned', request, ...(before ? { readback: before } : {}) };
    if (options.dryRun) return receipt;
    receipt.backupPath = await backup(options.backupDirectory, universeId, request, before);
    if (options.signal?.aborted) throw new AppError('CANCELLED', 'Operation cancelled before submission.');
    let op: ExperimentOperation;
    try { op = operation(await this.http.request(url, { auth: true, method, body })); }
    catch (error) {
      if (!uncertain(error)) throw error;
      return { ...receipt, state: 'unverified', error: errorInfo(error) };
    }
    return this.settle(universeId, receipt, op, options);
  }
  create(universeId: string, value: unknown, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> {
    return this.mutate(universeId, '', 'POST', parseExperimentDefinition(value) as unknown as JsonObject, options);
  }
  update(universeId: string, experimentId: string, value: unknown, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> {
    return this.mutate(universeId, '', 'PATCH', parseExperimentDefinition(value) as unknown as JsonObject, options, experimentId);
  }
  start(universeId: string, experimentId: string, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> { return this.mutate(universeId, ':start', 'POST', undefined, options, experimentId); }
  schedule(universeId: string, experimentId: string, time: string, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time)) || Date.parse(time) <= Date.now()) throw new AppError('ARGUMENT_ERROR', 'Provide a future ISO-8601 timestamp with Z or a UTC offset.');
    return this.mutate(universeId, ':schedule', 'POST', { scheduledStartTime: new Date(time).toISOString() }, options, experimentId);
  }
  complete(universeId: string, experimentId: string, variantId: string | undefined, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> {
    if (variantId !== undefined) resourceToken(variantId);
    return this.mutate(universeId, ':complete', 'POST', variantId === undefined ? {} : { variantId }, options, experimentId);
  }
  async stats(universeId: string, experimentId: string, options: ExperimentWriteOptions = {}): Promise<WriteReceipt> {
    validateWait(options);
    const url = this.experimentUrl(universeId, experimentId) + '/stats';
    const op = operation(await this.http.request(url, { auth: true }));
    // request is read-only; use its actual method in the returned receipt.
    const receipt: WriteReceipt = { universeId, state: 'pending', request: { method: 'GET', url } };
    return this.settle(universeId, receipt, op, options);
  }
}
