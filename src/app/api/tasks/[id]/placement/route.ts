import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { moveTaskPlacementMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** M3-02 归属移动：spaceId 与 projectId 一次提交，项目必须与空间一致；可同时修改整理标记。 */
export async function POST(request: Request, { params }: Context) {
  const fallbackId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId, fieldErrors: { body: '必须是JSON对象' } });
  const value = body as Record<string, unknown>; const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(value)) if (!['requestId','expectedVersion','spaceId','projectId','isProcessed'].includes(key)) fieldErrors[key] = '不允许此字段';
  if (!isRequestId(value.requestId)) fieldErrors.requestId = '必须是UUID';
  if (typeof value.expectedVersion !== 'number') fieldErrors.expectedVersion = '必须是数字';
  if (value.spaceId !== undefined && typeof value.spaceId !== 'string') fieldErrors.spaceId = '必须是文本';
  if (value.projectId !== undefined && value.projectId !== null && typeof value.projectId !== 'string') fieldErrors.projectId = '必须是文本或null';
  if (value.isProcessed !== undefined && typeof value.isProcessed !== 'boolean') fieldErrors.isProcessed = '必须是布尔值';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors });
  if (value.spaceId === undefined && value.projectId === undefined && value.isProcessed === undefined) return apiError(400, 'INVALID_INPUT', '没有可更新字段', { requestId, fieldErrors: { body: '至少提供 spaceId、projectId 或 isProcessed' } });
  const mutationRequestId = value.requestId as string;
  let id: string; try { id = (await params).id; } catch (error) { return apiFailure(error, mutationRequestId); }
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, mutationRequestId); }
  try {
    const mutation = moveTaskPlacementMutation(db, {
      userId: user.id, requestId: mutationRequestId, method: 'POST', resource: `/api/tasks/${id}/placement`,
      body: { expectedVersion: value.expectedVersion, spaceId: value.spaceId ?? null, projectId: value.projectId ?? null, isProcessed: value.isProcessed ?? null },
      taskId: id, expectedVersion: value.expectedVersion as number, spaceId: value.spaceId as string | undefined,
      projectId: value.projectId === undefined ? undefined : (value.projectId as string | null), isProcessed: value.isProcessed as boolean | undefined,
    });
    const headers = mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined;
    return apiSuccess(mutation.response, mutationRequestId, headers);
  } catch (error) { return apiFailure(error, mutationRequestId); }
  finally { db.$client.close(); }
}
