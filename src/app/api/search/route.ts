import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { searchTasks } from '@/server/services/search-review';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const requestId = apiRequestId();
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const url = new URL(request.url); const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
  const rawLimit = url.searchParams.get('limit'); const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? 50 : Number(rawLimit); const offset = rawOffset === null ? 0 : Number(rawOffset);
  const fieldErrors: Record<string, string> = {};
  if (!q.trim()) fieldErrors.q = '搜索词不能为空';
  if ([...q].length > 200) fieldErrors.q = '最多200个字符';
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fieldErrors.limit = '必须是1–100的整数';
  if (!Number.isInteger(offset) || offset < 0) fieldErrors.offset = '必须是非负整数';
  for (const key of url.searchParams.keys()) if (!['q', 'query', 'limit', 'offset'].includes(key)) fieldErrors[key] = '不支持此查询参数';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId, fieldErrors });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try { return apiSuccess(searchTasks(db, user.id, q, limit, offset), requestId); }
  catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
