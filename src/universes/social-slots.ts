import { object } from '../cloud/common.js';
import { AppError, errorInfo, id } from '../core/errors.js';
import type { HttpClient } from '../transport/http-client.js';

export type SocialSlotsMode = 'disabled' | 'automatic' | 'custom';
export type SocialSlotsSettings = { mode: 'disabled' | 'automatic'; count?: never } | { mode: 'custom'; count: number };
export type PlaceSocialSlots = { universeId: string; placeId: string } & SocialSlotsSettings;
export interface SocialSlotsWriteResult {
  universeId: string;
  placeId: string;
  before: SocialSlotsSettings;
  requested: SocialSlotsSettings;
  after?: SocialSlotsSettings;
  state: 'verified' | 'unverified';
  changed?: boolean;
  error?: ReturnType<typeof errorInfo>;
}

const apiModes = { disabled: 'Empty', automatic: 'Automatic', custom: 'Custom' } as const;

export function validateSocialSlots(mode: string, count?: number): SocialSlotsSettings {
  if (mode === 'custom') {
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      throw new AppError('ARGUMENT_ERROR', 'Custom Social Slots requires --count to be a positive safe integer.');
    }
    return { mode, count };
  }
  if (mode !== 'disabled' && mode !== 'automatic') {
    throw new AppError('ARGUMENT_ERROR', 'Social Slots mode must be disabled, automatic, or custom.');
  }
  if (count !== undefined) throw new AppError('ARGUMENT_ERROR', '--count is only valid with custom Social Slots.');
  return { mode };
}

function endpoint(universeId: string, placeId: string): string {
  id(universeId);
  return `https://develop.roblox.com/v2/places/${id(placeId)}`;
}

function matchesId(value: unknown, expected: string): boolean {
  return value === expected || (typeof value === 'number' && Number.isSafeInteger(value) && String(value) === expected);
}

async function readSettings(http: HttpClient, url: string, universeId: string, placeId: string): Promise<SocialSlotsSettings> {
  const data = object(await http.request(url, { cookieAuth: true }), true);
  if (!matchesId(data.id, placeId) || !matchesId(data.universeId, universeId)) {
    throw new AppError('INVALID_RESPONSE', 'Roblox did not confirm that the Place belongs to the requested Universe.');
  }
  if (data.socialSlotType === apiModes.disabled) return { mode: 'disabled' };
  if (data.socialSlotType === apiModes.automatic) return { mode: 'automatic' };
  const count = data.customSocialSlotsCount;
  if (data.socialSlotType === apiModes.custom && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
    return { mode: 'custom', count };
  }
  throw new AppError('INVALID_RESPONSE', 'Roblox returned an invalid Social Slots configuration.');
}

export async function readPlaceSocialSlots(http: HttpClient, universeId: string, placeId: string): Promise<PlaceSocialSlots> {
  const settings = await readSettings(http, endpoint(universeId, placeId), universeId, placeId);
  return { universeId, placeId, ...settings };
}

export async function writePlaceSocialSlots(
  http: HttpClient, universeId: string, placeId: string, settings: SocialSlotsSettings,
): Promise<SocialSlotsWriteResult> {
  const requested = validateSocialSlots(settings.mode, settings.count);
  const url = endpoint(universeId, placeId);
  const before = await readSettings(http, url, universeId, placeId);
  if (before.mode === requested.mode && before.count === requested.count) {
    return { universeId, placeId, before, requested, after: before, state: 'verified', changed: false };
  }
  const result: SocialSlotsWriteResult = { universeId, placeId, before, requested, state: 'unverified' };
  try {
    await http.request(url, {
      cookieAuth: true, method: 'PATCH',
      body: {
        socialSlotType: apiModes[requested.mode],
        ...(requested.mode === 'custom' ? { customSocialSlotsCount: requested.count } : {}),
      },
    });
  } catch (error) {
    if (error instanceof AppError && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500) throw error;
    return { ...result, error: errorInfo(error) };
  }
  try {
    result.after = await readSettings(http, url, universeId, placeId);
    if (result.after.mode !== requested.mode || result.after.count !== requested.count) {
      throw new AppError('INVALID_RESPONSE', 'Social Slots readback did not match the request. Read the current settings before trying again.');
    }
    return { ...result, state: 'verified', changed: true };
  } catch (error) {
    return { ...result, error: errorInfo(error) };
  }
}
