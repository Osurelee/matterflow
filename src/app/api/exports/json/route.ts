import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId } from '@/server/http/responses';
import { makeJson, validateFilters } from '@/server/services/exports';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const requestId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const parsed = validateFilters(new URL(request.url));
  if (!parsed.ok) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId, fieldErrors: parsed.fields });
  const db = createDatabase();
  try {
    // 无筛选参数时保留“全量业务快照”语义，包含归档/回收站历史；
    // 一旦用户显式传入筛选条件，再导出当前筛选范围。
    const hasScope = ['view', 'spaceId', 'projectId', 'status', 'q', 'query', 'includeEnded']
      .some((key) => new URL(request.url).searchParams.has(key));
    const body = JSON.stringify(makeJson(db, user.id, hasScope ? parsed.value : undefined), null, 2);
    return new Response(body, { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="tasks-export.json"' } });
  } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
