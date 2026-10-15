import { setTaskSectionMutation } from '@/server/services/project-sections';
import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const fallback = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallback });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, fallback); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallback });
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId });
  const value = body as Record<string, unknown>; const errors: Record<string, string> = {};
  if (!isRequestId(value.requestId)) errors.requestId = '必须是UUID';
  if (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) errors.expectedVersion = '必须是正整数';
  if (value.sectionId !== null && !isRequestId(value.sectionId)) errors.sectionId = '必须是UUID或null';
  if (Object.keys(errors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors: errors });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const { id } = await params;
    const mutation = setTaskSectionMutation(db, { userId: user.id, requestId, method: 'POST', resource: `/api/tasks/${id}/section`, body: value, taskId: id, expectedVersion: value.expectedVersion as number, sectionId: value.sectionId as string | null });
    return apiSuccess(mutation.response, requestId, mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
  } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
