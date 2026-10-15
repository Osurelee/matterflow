import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { promoteChecklistMutation, previewChecklistPromotion } from '@/server/services/checklist';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const requestId = apiRequestId(); let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  if (new URL(request.url).search) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId });
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try { const data = previewChecklistPromotion(db, user.id, (await params).id); return apiSuccess(data, requestId); }
  catch (error) { return apiFailure(error, requestId); } finally { db.$client.close(); }
}

export async function POST(request: Request, { params }: Context) {
  let id: string; try { id = (await params).id; } catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist/promote`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
      expectedStructureVersion: { type: 'number', required: true },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => promoteChecklistMutation(db, {
      userId, requestId, method, resource, body: semantic, taskId: id,
      expectedVersion: semantic.expectedVersion as number,
      expectedStructureVersion: semantic.expectedStructureVersion as number,
    }),
  });
}
