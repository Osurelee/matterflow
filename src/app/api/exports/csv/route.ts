import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId } from '@/server/http/responses';
import { makeCsv, validateFilters } from '@/server/services/exports';

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
    return new Response(makeCsv(db, user.id, parsed.value), { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tasks-export.csv"' } });
  } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
