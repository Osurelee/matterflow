import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

type ErrorOptions = { requestId?: string; fieldErrors?: Record<string, string>; currentVersion?: number; current?: unknown; headers?: HeadersInit };
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isRequestId = (value: unknown): value is string => typeof value === 'string' && requestIdPattern.test(value);
export function apiRequestId(value?: unknown) { return isRequestId(value) ? value : randomUUID(); }

export function apiSuccess<T>(data: T, requestId?: string, headers?: HeadersInit, status = 200) {
  const merged = new Headers(headers); merged.set('Cache-Control', 'no-store');
  return NextResponse.json({ data, requestId: apiRequestId(requestId) }, { status, headers: merged });
}

export function apiError(status: number, code: string, message: string, options: ErrorOptions = {}) {
  const details: Record<string, unknown> = {};
  if (options.fieldErrors) details.fieldErrors = options.fieldErrors;
  if (options.currentVersion !== undefined) details.currentVersion = options.currentVersion;
  if (options.current !== undefined) details.current = options.current;
  const headers = new Headers(options.headers); headers.set('Cache-Control', 'no-store');
  return NextResponse.json({ error: { code, message, ...details }, requestId: apiRequestId(options.requestId) }, { status, headers });
}

export function apiFailure(error: unknown, requestId?: string) {
  if (error && typeof error === 'object') {
    const value = error as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
    if (typeof value.status === 'number' && typeof value.code === 'string' && typeof value.message === 'string' && value.status >= 400 && value.status < 500) {
      const details = value.details && typeof value.details === 'object' ? value.details as ErrorOptions : {};
      return apiError(value.status, value.code, value.message, { ...details, requestId });
    }
    const code = typeof value.code === 'string' ? value.code : '';
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_CANTOPEN' || code === 'SQLITE_FULL' || code === 'SQLITE_READONLY' || code.startsWith('SQLITE_BUSY_') || code.startsWith('SQLITE_LOCKED_') || code.startsWith('SQLITE_IOERR_') || code.startsWith('SQLITE_CANTOPEN_')) {
      return apiError(503, 'TEMPORARILY_UNAVAILABLE', '服务暂时不可用，请稍后重试', { requestId, headers: { 'Retry-After': '1' } });
    }
  }
  return apiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试', { requestId });
}
