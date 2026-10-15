import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { updateTaskHandlingMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** M3-04 处理安排：一次提交 handlingMode 与 counterpartName；改回自己时清空文本。 */
export async function POST(request: Request, { params }: Context) {
  const fallbackId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(request); if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId, fieldErrors: { body: '必须是JSON对象' } });
  const value = body as Record<string, unknown>; const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(value)) if (!['requestId','expectedVersion','handlingMode','counterpartName'].includes(key)) fieldErrors[key] = '不允许此字段';
  if (!isRequestId(value.requestId)) fieldErrors.requestId = '必须是UUID';
  if (typeof value.expectedVersion !== 'number') fieldErrors.expectedVersion = '必须是数字';
  if (typeof value.handlingMode !== 'string') fieldErrors.handlingMode = '必须是文本';
  if (value.counterpartName !== undefined && typeof value.counterpartName !== 'string') fieldErrors.counterpartName = '必须是文本';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors });
  const mutationRequestId = value.requestId as string;
  let id: string; try { id = (await params).id; } catch (error) { return apiFailure(error, mutationRequestId); }
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, mutationRequestId); }
  try {
    const mutation = updateTaskHandlingMutation(db, {
      userId: user.id, requestId: mutationRequestId, method: 'POST', resource: `/api/tasks/${id}/handling`,
      body: { expectedVersion: value.expectedVersion, handlingMode: value.handlingMode, counterpartName: value.counterpartName ?? null },
      taskId: id, expectedVersion: value.expectedVersion as number, handlingMode: value.handlingMode as string, counterpartName: value.counterpartName as string | undefined,
    });
    return apiSuccess(mutation.response, mutationRequestId, mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
  } catch (error) { return apiFailure(error, mutationRequestId); }
  finally { db.$client.close(); }
}
