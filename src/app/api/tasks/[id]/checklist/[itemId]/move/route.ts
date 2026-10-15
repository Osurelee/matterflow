import { moveChecklistItemMutation } from '@/server/services/checklist';
import { apiFailure, apiRequestId } from '@/server/http/responses';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; itemId: string }> };

/** M4-04：上/下移动一位（菜单与键盘等价动作；拖动排序属 M5 体验增强）。 */
export async function POST(request: Request, { params }: Context) {
  let id: string;
  let itemId: string;
  try { const resolved = await params; id = resolved.id; itemId = resolved.itemId; }
  catch (error) { return apiFailure(error, apiRequestId()); }
  return structureWrite({
    request,
    resource: `/api/tasks/${id}/checklist/${itemId}/move`,
    fields: {
      requestId: { type: 'uuid', required: true },
      expectedVersion: { type: 'number', required: true },
      itemVersion: { type: 'number', required: true },
      direction: { type: 'string', required: true },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => moveChecklistItemMutation(db, {
      userId, requestId, method, resource, body: semantic,
      taskId: id, itemId,
      expectedVersion: semantic.expectedVersion as number,
      itemVersion: semantic.itemVersion as number,
      direction: semantic.direction as string,
    }),
  });
}
