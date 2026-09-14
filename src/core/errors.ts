export type ErrorCode = 'ARGUMENT_ERROR' | 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'FORBIDDEN' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'STORAGE_ERROR' | 'STORAGE_LOCKED' | 'CACHE_VERSION' | 'CREDENTIAL_STORE_UNAVAILABLE' | 'MODERATION_REJECTED' | 'MODERATION_TIMEOUT';
export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public httpStatus?: number) { super(message); }
}
export function errorInfo(error: unknown): { code: string; message: string; httpStatus?: number } {
  return error instanceof AppError
    ? { code: error.code, message: error.message, httpStatus: error.httpStatus }
    : { code: 'INTERNAL_ERROR', message: 'Unexpected internal error.' };
}
export function exitCode(error: unknown): number {
  if (!(error instanceof AppError)) return 1;
  if (error.code === 'ARGUMENT_ERROR') return 2;
  if (error.code === 'AUTH_REQUIRED' || error.code === 'AUTH_INVALID') return 4;
  if (error.code === 'FORBIDDEN') return 5;
  if (error.code === 'CANCELLED') return 130;
  return 1;
}
export function id(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError('ARGUMENT_ERROR', 'Expected a positive safe integer ID.');
  return value;
}
