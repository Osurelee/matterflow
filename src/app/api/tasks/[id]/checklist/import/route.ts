import { importChecklistFromBodyMutation } from '@/server/services/checklist';
import { apiFailure, apiRequestId } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/**
 * M4-04「转为小步骤」（PRD 7.1）：把正文里的静态 `- [ ]` / `- [x]` 行转成结构化条目，
 * 并在同一事务内从正文移除这些行；只能通过本接口产生条目，不做第二套互动状态。
 */
export async function POST(request: Request, { params }: Context) {
  let id: string;
  try { id = (await params).id; } catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist/import`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => importChecklistFromBodyMutation(db, {
      userId, requestId, method, resource, body: semantic,
      taskId: id, expectedVersion: semantic.expectedVersion as number,
    }),
  });
}
