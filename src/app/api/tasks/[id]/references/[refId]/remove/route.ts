import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';
import { removeTaskReferenceMutation } from '@/server/services/task-references';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; refId: string }> };
export async function POST(request: Request, { params }: Context) {
  const fallbackId = apiRequestId(); if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response; const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId });
  const value = body as Record<string, unknown>; const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(value)) if (!['requestId', 'expectedVersion', 'expectedStructureVersion'].includes(key)) fieldErrors[key] = '不允许此字段';
  if (!isRequestId(value.requestId)) fieldErrors.requestId = '必须是UUID';
  if (typeof value.expectedVersion !== 'number' || !Number.isInteger(value.expectedVersion) || value.expectedVersion < 1) fieldErrors.expectedVersion = '必须是正整数';
  if (typeof value.expectedStructureVersion !== 'number' || !Number.isInteger(value.expectedStructureVersion) || value.expectedStructureVersion < 1) fieldErrors.expectedStructureVersion = '必须是正整数';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const values = await params;
    const mutation = removeTaskReferenceMutation(db, { userId: user.id, requestId, method: 'POST', resource: `/api/tasks/${values.id}/references/${values.refId}/remove`, body: value, referenceId: values.refId, expectedVersion: value.expectedVersion as number, expectedStructureVersion: value.expectedStructureVersion as number });
    return apiSuccess(mutation.response, requestId, mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
  } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
