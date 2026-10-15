import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { listTaskReferences } from '@/server/services/task-references';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  const requestId = apiRequestId(); let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const url = new URL(request.url); if ([...url.searchParams.keys()].length) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try { return apiSuccess(listTaskReferences(db, user.id, (await params).id, 'incoming'), requestId); } catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}
