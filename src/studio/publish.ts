import { randomUUID } from 'node:crypto';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { listPlaceVersions } from '../universes/place-versions.js';

type Execute = (code: string, timeoutMs?: number) => Promise<unknown>;
type Failure = ReturnType<typeof errorInfo>;
interface Source { placeId: string; universeId: string }

export interface StudioPublishResult {
  placeId: string;
  state: 'published' | 'failed' | 'unknown' | 'not_started';
  baselineVersion?: string;
  version?: string;
  observedPublishedVersion?: string;
  confirmation?: 'studio_log_and_cloud';
  elapsedMs?: number;
  studioEventMs?: number;
  targetLogMs?: number;
  cloudObservedMs?: number;
  error?: Failure;
}

interface PublishOptions {
  sourcePlace: string;
  targetUniverse: string;
  group: string;
  targets: string[];
  timeoutMs: number;
  signal: AbortSignal;
  logDirectory: string;
}

function getSource(value: unknown): Source {
  const result = value as Partial<Source> | null;
  if (typeof result?.placeId !== 'string' || typeof result.universeId !== 'string') {
    throw new AppError('INVALID_RESPONSE', 'Studio did not return its Edit Place and universe IDs.');
  }
  return { placeId: id(result.placeId), universeId: id(result.universeId) };
}

function readSource(execute: Execute, timeoutMs?: number) {
  return execute('return { placeId = tostring(game.PlaceId), universeId = tostring(game.GameId) }', timeoutMs);
}

async function waitForSource(execute: Execute, source: Source, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const actual = await readSource(execute, Math.max(1, deadline - Date.now())) as Partial<Source> | null;
    if (actual?.placeId === source.placeId && actual.universeId === source.universeId) return;
    await delay(150, undefined, { signal });
  } while (Date.now() < deadline);
  throw new AppError('STUDIO_NOT_FOUND', 'The Studio Edit session did not return to the source Place.');
}

class LogTail {
  private decoder = new StringDecoder('utf8');
  private remainder = '';
  constructor(private file: FileHandle, private offset: number) {}

  async readLines(): Promise<string[]> {
    const available = (await this.file.stat()).size - this.offset;
    if (available < 0) throw new AppError('INVALID_RESPONSE', 'Studio log was truncated during publishing.');
    if (available === 0) return [];
    const buffer = Buffer.alloc(Math.min(available, 64 * 1024));
    const { bytesRead } = await this.file.read(buffer, 0, buffer.length, this.offset);
    this.offset += bytesRead;
    const lines = (this.remainder + this.decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/);
    this.remainder = lines.pop()!;
    return lines;
  }

  close() { return this.file.close(); }
}

async function openStudioLog(directory: string, execute: Execute, signal: AbortSignal): Promise<LogTail> {
  const files = (await readdir(directory)).filter(name => /_Studio_.*_last\.log$/i.test(name));
  const offsets = await Promise.all(files.map(async name => {
    const path = join(directory, name);
    return { path, offset: (await stat(path).catch(() => undefined))?.size };
  }));
  const marker = 'RBX_PUBLISH_SESSION_' + randomUUID();
  await execute('print("' + marker + '")\nreturn { ready = true }');
  for (let attempt = 0; attempt < 16; attempt++) {
    for (const { path, offset } of offsets) {
      if (offset === undefined || (await stat(path).catch(() => undefined))?.size === offset) continue;
      const file = await open(path, 'r').catch(() => undefined);
      if (!file) continue;
      const tail = new LogTail(file, offset);
      let found = false;
      try {
        found = (await tail.readLines()).some(line => line.endsWith(marker));
        if (found) return tail;
      } finally {
        if (!found) await tail.close();
      }
    }
    await delay(150, undefined, { signal });
  }
  throw new AppError('STUDIO_NOT_FOUND', 'Could not associate a Studio log with the selected Edit session.');
}

function submitCode(source: Source, universe: string, target: string, group: string, marker: string, timeoutMs: number): string {
  return `if game.PlaceId ~= ${source.placeId} or game.GameId ~= ${source.universeId} then
    return { dispatched = false, sourceMismatch = true }
end
local service = game:GetService("StudioPublishService")
local subscription
pcall(function()
    subscription = service.GamePublishFinished:Connect(function(success, universeId)
        if tostring(universeId) ~= "${universe}" then return end
        subscription:Disconnect()
        print("${marker}_EVENT_" .. tostring(success))
    end)
end)
if subscription then
    task.delay(${timeoutMs / 1000}, function() subscription:Disconnect() end)
end
print("${marker}_BEGIN")
local ok = pcall(function()
    service:PublishAs(${universe}, ${target}, ${group}, true, {}, false, false)
end)
if not ok and subscription then subscription:Disconnect() end
return { dispatched = ok }`;
}

async function publishPlace(
  http: HttpClient,
  execute: Execute,
  tail: LogTail,
  source: Source,
  options: PublishOptions,
  result: StudioPublishResult,
): Promise<boolean> {
  const { targetUniverse, group, signal, timeoutMs } = options;
  const { placeId } = result;
  const expires = Date.now() + timeoutMs;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const baseline = await listPlaceVersions(http, placeId, undefined, deadline);
    result.baselineVersion = baseline.versions.reduce((latest, row) =>
      BigInt(row.version) > BigInt(latest) ? row.version : latest, '0');
  } catch (error) {
    result.error = errorInfo(error);
    return true;
  }
  if (deadline.aborted) return !signal.aborted;
  const marker = 'RBX_PUBLISH_' + randomUUID();
  const request = `publishAs: currentUniverse=${source.universeId} currentPlace=${source.placeId} -> targetUniverse=${targetUniverse} targetPlace=${placeId} isPublish=1`;
  const complete = `PublishToDifferentGame srcPlaceId=${source.placeId}, dstPlaceId=${placeId}, srcUniverse=${source.universeId}, dstUniverse=${targetUniverse}`;
  const started = Date.now();
  let dispatched: boolean | undefined;
  let sourceMismatch = false;
  let submitError: Failure | undefined;
  const remaining = Math.max(1, expires - started);
  const submission = execute(submitCode(source, targetUniverse, placeId, group, marker, remaining), Math.min(15_000, remaining))
    .then(value => {
      const reply = value as { dispatched?: boolean; sourceMismatch?: boolean } | null;
      dispatched = reply?.dispatched;
      sourceMismatch = reply?.sourceMismatch === true;
    })
    .catch(error => { submitError = errorInfo(error); });
  result.state = 'unknown';
  const stopReadback = new AbortController();
  const readSignal = AbortSignal.any([deadline, stopReadback.signal]);
  const nextVersion = BigInt(result.baselineVersion) + 1n;
  let readError: Failure | undefined;
  const readback = async () => {
    await delay(750, undefined, { signal: readSignal });
    while (!readSignal.aborted) {
      try {
        const page = await listPlaceVersions(http, placeId, undefined, readSignal);
        const latest = page.versions.find(row => row.isPublished);
        if (latest && BigInt(latest.version) >= nextVersion) {
          result.observedPublishedVersion = latest.version;
          result.cloudObservedMs = Date.now() - started;
          return;
        }
      } catch (error) {
        if (!readSignal.aborted) readError = errorInfo(error);
      }
      await delay(700, undefined, { signal: readSignal });
    }
  };
  const reader = readback().catch(() => {});
  let afterMarker = false;
  let matchingRequests = 0;
  let otherRequest = false;
  let targetComplete = false;
  let event: boolean | undefined;
  try {
    while (!deadline.aborted) {
      for (const line of await tail.readLines()) {
        if (line.endsWith(marker + '_BEGIN')) afterMarker = true;
        if (!afterMarker) continue;
        if (line.includes('publishAs: currentUniverse=')) {
          if (line.includes(request)) matchingRequests++;
          else otherRequest = true;
        }
        if (matchingRequests === 1 && (line.endsWith(complete) || line.includes(complete + ' '))) {
          targetComplete = true;
          result.targetLogMs ??= Date.now() - started;
        }
        if (line.endsWith(marker + '_EVENT_true') || line.endsWith(marker + '_EVENT_false')) {
          event = line.endsWith('_true');
          result.studioEventMs ??= Date.now() - started;
        }
      }
      if (sourceMismatch) {
        result.state = 'not_started';
        result.error = { code: 'STUDIO_SOURCE_CHANGED', message: 'Studio was no longer on the selected source before submission.' };
        break;
      }
      if (dispatched === false || (event === false && matchingRequests === 1 && !otherRequest)) {
        result.state = 'failed';
        result.error = { code: 'STUDIO_PUBLISH_FAILED', message: 'Studio reported that the publish failed.' };
        break;
      }
      if (matchingRequests > 1 || otherRequest) {
        result.error = { code: 'STUDIO_PUBLISH_OVERLAP', message: 'Another publish was observed in the source session.' };
        break;
      }
      if (targetComplete && result.observedPublishedVersion) {
        if (BigInt(result.observedPublishedVersion) === nextVersion) {
          result.state = 'published';
          result.version = result.observedPublishedVersion;
          result.confirmation = 'studio_log_and_cloud';
        } else {
          result.error = { code: 'PUBLISH_VERSION_AMBIGUOUS', message: 'More than one cloud version advanced beyond the baseline.' };
        }
        break;
      }
      await delay(150, undefined, { signal: deadline }).catch(() => {});
    }
  } catch (error) {
    result.error = errorInfo(error);
  } finally {
    stopReadback.abort();
    await Promise.all([reader, submission]);
    result.elapsedMs = Date.now() - started;
  }
  if (result.state === 'unknown') {
    result.error ??= submitError ?? readError ?? {
      code: signal.aborted ? 'CANCELLED' : 'PUBLISH_UNVERIFIED',
      message: 'The requested target and its new published version could not both be confirmed.',
    };
  }
  return !sourceMismatch && !otherRequest && matchingRequests <= 1
    && (dispatched === false || targetComplete || (event !== undefined && matchingRequests === 1));
}

export async function publishStudioPlaces(http: HttpClient, execute: Execute, options: PublishOptions) {
  id(options.targetUniverse);
  if (options.group !== '0') id(options.group);
  options.targets.forEach(id);
  if (!options.targets.length || new Set(options.targets).size !== options.targets.length
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    throw new AppError('ARGUMENT_ERROR', 'Provide distinct target Places and a valid per-Place timeout.');
  }
  const source = getSource(await readSource(execute));
  if (source.placeId !== id(options.sourcePlace)) throw new AppError('STUDIO_NOT_FOUND', 'The selected Studio session has a different source Place.');
  if (options.targets.includes(source.placeId)) throw new AppError('ARGUMENT_ERROR', 'Choose destination Places other than the source Place.');
  const results = options.targets.map<StudioPublishResult>(placeId => ({ placeId, state: 'not_started' }));
  const started = Date.now();
  const tail = await openStudioLog(options.logDirectory, execute, options.signal);
  try {
    let blocked: Failure | undefined;
    for (const result of results) {
      if (options.signal.aborted) blocked ??= { code: 'CANCELLED', message: 'The command was cancelled.' };
      if (blocked) {
        result.error = blocked;
        continue;
      }
      try {
        await waitForSource(execute, source, options.signal);
      } catch (error) {
        blocked = errorInfo(error);
        result.error = blocked;
        continue;
      }
      const settled = await publishPlace(http, execute, tail, source, options, result);
      if (!settled) {
        blocked = { code: 'STUDIO_PUBLISH_PENDING', message: 'The prior Studio request could not be confirmed finished.' };
      }
    }
    return { sourcePlace: source.placeId, sourceUniverse: source.universeId, targetUniverse: options.targetUniverse, results, elapsedMs: Date.now() - started };
  } finally {
    await tail.close();
  }
}
