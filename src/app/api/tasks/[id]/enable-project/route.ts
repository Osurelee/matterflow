import { previewEnableProject, enableProjectMutation } from '@/server/services/structure';
import { MutationConflict } from '@/server/services/errors';
import { structureRead, structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  return structureRead((db, ownerId) => {
    const preview = previewEnableProject(db, ownerId, id);
    if (!preview) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    return preview;
  })(_request);
}

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return structureWrite({
    request, resource: `/api/tasks/${id}/enable-project`,
    fields: { requestId: { type: 'uuid', required: true }, expectedVersion: { type: 'number', required: true }, expectedStructureVersion: { type: 'number', required: true }, successCriteria: { type: 'string' }, targetDate: { type: 'string' } },
    run: ({ db, userId, requestId, method, resource, semantic }) => enableProjectMutation(db, { userId, requestId, method, resource, body: semantic, taskId: id, expectedVersion: semantic.expectedVersion as number, expectedStructureVersion: semantic.expectedStructureVersion as number, successCriteria: semantic.successCriteria, targetDate: semantic.targetDate }),
  });
}
