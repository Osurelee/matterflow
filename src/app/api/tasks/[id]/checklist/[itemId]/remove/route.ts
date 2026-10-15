import { removeChecklistItemMutation } from '@/server/services/checklist';
import { apiFailure, apiRequestId } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; itemId: string }> };

/** M4-04：删除小步骤（删除后重排排序键）。 */
export async function POST(request: Request, { params }: Context) {
  let id: string;
  let itemId: string;
  try { const resolved = await params; id = resolved.id; itemId = resolved.itemId; }
  catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist/${itemId}/remove`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
      itemVersion: { type: 'number', required: true },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => removeChecklistItemMutation(db, {
      userId, requestId, method, resource, body: semantic,
      taskId: id, itemId,
      expectedVersion: semantic.expectedVersion as number,
      itemVersion: semantic.itemVersion as number,
    }),
  });
}
