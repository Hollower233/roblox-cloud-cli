import { AppError, errorInfo, id } from '../core/errors.js';
import { normalizePlaceVersionTitle } from '../universes/place-versions.js';

export interface StudioSaveResult {
  placeId: string;
  state: 'saved' | 'not_needed' | 'busy' | 'needs_user_action' | 'failed' | 'unknown';
  version?: string;
  title?: string;
  titleState?: 'accepted' | 'failed' | 'unknown';
  error?: ReturnType<typeof errorInfo>;
}

export async function saveStudioPlace(
  placeId: string,
  save: () => Promise<unknown>,
  notes?: { title: string; write: (version: string, title: string) => Promise<void> },
): Promise<StudioSaveResult> {
  id(placeId);
  const title = notes && normalizePlaceVersionTitle(notes.title);
  let receipt: unknown;
  try {
    receipt = await save();
  } catch (error) {
    return { placeId, state: 'unknown', error: errorInfo(error) };
  }
  const result = receipt as { status?: unknown; version?: unknown; filePath?: unknown } | null;
  switch (result?.status) {
    case 'NotNeeded': return { placeId, state: 'not_needed' };
    case 'Busy': return { placeId, state: 'busy' };
    case 'NeedsUserAction': return { placeId, state: 'needs_user_action' };
    case 'Failed': return { placeId, state: 'failed' };
  }
  let version: string;
  try {
    if (result?.status !== 'Saved' || result.filePath
      || !['string', 'number'].includes(typeof result.version)) throw new Error();
    version = id(String(result.version));
  } catch {
    return { placeId, state: 'unknown', error: { code: 'INVALID_RESPONSE', message: 'Studio did not return a new Roblox save version.' } };
  }
  if (!notes || title === undefined) return { placeId, state: 'saved', version };
  try {
    await notes.write(version, title);
    return { placeId, state: 'saved', version, title, titleState: 'accepted' };
  } catch (error) {
    const failure = errorInfo(error);
    const rejected = error instanceof AppError && (error.code === 'AUTH_REQUIRED'
      || (error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408));
    return { placeId, state: 'saved', version, title, titleState: rejected ? 'failed' : 'unknown', error: failure };
  }
}
