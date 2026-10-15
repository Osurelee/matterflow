import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { createChecklistItemMutation, listChecklist } from '@/server/services/checklist';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** M4-04：读取小步骤清单（只读，含已完成/未完成计数）。 */
export async function GET(_request: Request, { params }: Context) {
  const requestId = apiRequestId();
  let user;
  try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  let id: string;
  try { id = (await params).id; } catch (error) { return apiFailure(error, requestId); }
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const list = listChecklist(db, user.id, id);
    if (!list) return apiError(404, 'TASK_NOT_FOUND', '事项不存在', { requestId });
    return apiSuccess(list, requestId);
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}

/** M4-04：新增小步骤（追加到末尾；最多 100 条）。 */
export async function POST(request: Request, { params }: Context) {
  let id: string;
  try { id = (await params).id; } catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
      text: { type: 'string', required: true },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => createChecklistItemMutation(db, {
      userId, requestId, method, resource, body: semantic,
      taskId: id, expectedVersion: semantic.expectedVersion as number, text: semantic.text,
    }),
  });
}
