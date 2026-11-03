import { object, uncertain, type CloudRequest, type WriteReceipt } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

export interface ServerRestartOptions {
  all?: boolean;
  countdown?: boolean;
}

export interface ServerCounts {
  activeServers: number;
  outdatedServers: number;
}

export interface UniverseServerStatus extends ServerCounts {
  universeId: string;
  places: (ServerCounts & { placeId: string })[];
}

function serverCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid server count.');
  }
  return value;
}

export async function getUniverseServerStatus(http: HttpClient, universeId: string): Promise<UniverseServerStatus> {
  const url = `https://apis.roblox.com/server-management/v1/universes/${id(universeId)}/restarts:forecast`;
  const response = object(await http.request(url, { auth: true }), true);
  const forecasts = object(response.placeForecasts ?? {}, true);
  const result: UniverseServerStatus = { universeId, activeServers: 0, outdatedServers: 0, places: [] };

  for (const [placeId, value] of Object.entries(forecasts)) {
    const forecast = object(value, true);
    if (forecast.isNotInUniverse === true) continue;
    const activeServers = serverCount(forecast.totalInstances);
    const outdatedServers = serverCount(forecast.instancesImpacted);
    if (outdatedServers > activeServers) {
      throw new AppError('INVALID_RESPONSE', 'Roblox reported more impacted servers than active servers.');
    }
    result.places.push({ placeId, activeServers, outdatedServers });
    result.activeServers += activeServers;
    result.outdatedServers += outdatedServers;
  }
  return result;
}

export async function restartUniverseServers(http: HttpClient, universeId: string, options: ServerRestartOptions = {}): Promise<WriteReceipt> {
  const request = {
    method: 'POST',
    url: `https://apis.roblox.com/cloud/v2/universes/${id(universeId)}:restartServers`,
    body: {
      closeAllVersions: options.all === true,
      bleedOffServers: options.countdown === true,
      ...(options.countdown === true ? { bleedOffDurationMinutes: 1 } : {}),
    },
  } satisfies CloudRequest;

  try {
    const response = object(await http.request(request.url, { ...request, auth: true }), true);
    return { universeId, state: 'submitted', request, response };
  } catch (error) {
    const serverError = error instanceof AppError && (error.httpStatus ?? 0) >= 500;
    if (!uncertain(error) && !serverError) throw error;
    return {
      universeId, state: 'unverified', request,
      error: { ...errorInfo(error), message: 'Restart submission could not be confirmed. Check Creator Hub Server Management before submitting again.' },
    };
  }
}
