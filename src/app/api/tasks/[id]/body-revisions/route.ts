import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { listTaskBodyRevisions } from '@/server/services/task-queries';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** M4-01/03：读取正文修订历史（只读，时间倒序分页）。 */
export async function GET(request: Request, { params }: Context) {
  const requestId = apiRequestId();
  let user;
  try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? '20');
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
  const before = url.searchParams.get('before') ?? undefined;
  const beforeId = url.searchParams.get('beforeId') ?? undefined;
  const allowed = ['limit', 'before', 'beforeId'];
  const fieldErrors: Record<string, string> = {};
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) fieldErrors[key] = '不支持此查询参数';
  if (before && !Number.isFinite(Date.parse(before))) fieldErrors.before = '必须是时间戳';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId, fieldErrors });
  let id: string;
  try { id = (await params).id; } catch (error) { return apiFailure(error, requestId); }
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const page = listTaskBodyRevisions(db, user.id, id, limit, before, beforeId);
    if (!page) return apiError(404, 'TASK_NOT_FOUND', '事项不存在', { requestId });
    return apiSuccess(page, requestId);
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}
