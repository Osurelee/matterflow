import { createProjectSectionMutation, listProjectSections } from '@/server/services/project-sections';
import { structureRead, structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';

export const GET = structureRead((db, ownerId, request) => listProjectSections(db, ownerId, new URL(request.url).pathname.split('/').at(-2)!));

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return structureWrite({
    request, resource: `/api/projects/${id}/sections`,
    fields: {
      requestId: { type: 'uuid', required: true },
      name: { type: 'string', required: true },
      expectedProjectVersion: { type: 'number' },
    },
    run: ({ db, userId, requestId, method, resource, semantic }) => createProjectSectionMutation(db, {
      userId, requestId, method, resource, body: semantic, projectId: id,
      name: semantic.name, expectedProjectVersion: semantic.expectedProjectVersion as number | undefined,
    }),
  });
}
