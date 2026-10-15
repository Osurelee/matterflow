import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { REVIEW_KINDS, reviewTasks, type ReviewKind } from '@/server/services/search-review';

export const runtime = 'nodejs';
const aliases: Record<string, ReviewKind> = {
  unprocessed: 'unprocessed', unorganized: 'unprocessed',
  waiting_without_followup: 'waiting_without_followup', waiting_no_follow_up: 'waiting_without_followup',
  waiting: 'waiting_without_followup',
  project_without_next_action: 'project_without_next_action', project_no_next_step: 'project_without_next_action', project_next_action: 'project_without_next_action',
  completed: 'completed', done: 'completed', cancelled: 'cancelled', canceled: 'cancelled',
};

export async function GET(request: Request) {
  const requestId = apiRequestId();
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const url = new URL(request.url); const rawKind = url.searchParams.get('kind') ?? url.searchParams.get('view') ?? 'unprocessed';
  const kind = aliases[rawKind]; const rawLimit = url.searchParams.get('limit'); const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? 50 : Number(rawLimit); const offset = rawOffset === null ? 0 : Number(rawOffset);
  const fieldErrors: Record<string, string> = {};
  if (!kind) fieldErrors.kind = `只支持 ${REVIEW_KINDS.join('/')}`;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fieldErrors.limit = '必须是1–100的整数';
  if (!Number.isInteger(offset) || offset < 0) fieldErrors.offset = '必须是非负整数';
  for (const key of url.searchParams.keys()) if (!['kind', 'view', 'limit', 'offset'].includes(key)) fieldErrors[key] = '不支持此查询参数';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId, fieldErrors });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try { return apiSuccess(reviewTasks(db, user.id, kind!, limit, offset), requestId); }
  catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
