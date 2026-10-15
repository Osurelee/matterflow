import { updateProjectSectionMutation } from '@/server/services/project-sections';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; sectionId: string }> }) {
  const { id, sectionId } = await params;
  return structureWrite({
    request, resource: `/api/projects/${id}/sections/${sectionId}`,
    fields: { requestId: { type: 'uuid', required: true }, name: { type: 'string', required: true }, expectedVersion: { type: 'number', required: true } },
    run: ({ db, userId, requestId, method, resource, semantic }) => updateProjectSectionMutation(db, {
      userId, requestId, method, resource, body: semantic, projectId: id, sectionId,
      name: semantic.name, expectedVersion: semantic.expectedVersion as number,
    }),
  });
}
