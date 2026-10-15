import { reorderProjectSectionsMutation } from '@/server/services/project-sections';
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
  const value = body as Record<string, unknown>;
  const errors: Record<string, string> = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId });
  if (!isRequestId(value.requestId)) errors.requestId = '必须是UUID';
  if (!Number.isInteger(value.expectedProjectVersion) || Number(value.expectedProjectVersion) < 1) errors.expectedProjectVersion = '必须是正整数';
  if (!Array.isArray(value.sectionIds) || value.sectionIds.some((id) => !isRequestId(id))) errors.sectionIds = '必须是UUID列表';
  if (Object.keys(errors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors: errors });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const { id } = await params;
    const mutation = reorderProjectSectionsMutation(db, { userId: user.id, requestId, method: 'POST', resource: `/api/projects/${id}/sections/reorder`, body: value, projectId: id, expectedProjectVersion: value.expectedProjectVersion as number, sectionIds: value.sectionIds as string[] });
    return apiSuccess(mutation.response, requestId, mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
  } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
