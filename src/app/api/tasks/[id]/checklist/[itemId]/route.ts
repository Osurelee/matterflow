import { updateChecklistItemMutation } from '@/server/services/checklist';
import { apiFailure, apiRequestId } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; itemId: string }> };

/** M4-04：修改小步骤文本或勾选状态（勾选不改变父事项状态）。 */
export async function PATCH(request: Request, { params }: Context) {
  let id: string;
  let itemId: string;
  try { const resolved = await params; id = resolved.id; itemId = resolved.itemId; }
  catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist/${itemId}`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
      itemVersion: { type: 'number', required: true },
      text: { type: 'string' },
      isChecked: { type: 'boolean' },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => updateChecklistItemMutation(db, {
      userId, requestId, method, resource, body: semantic,
      taskId: id, itemId,
      expectedVersion: semantic.expectedVersion as number,
      itemVersion: semantic.itemVersion as number,
      text: semantic.text,
      isChecked: semantic.isChecked,
    }),
  });
}
