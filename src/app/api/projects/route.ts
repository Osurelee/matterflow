import { createProjectMutation, listProjects } from '@/server/services/structure';
import { structureRead, structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
const RESOURCE = '/api/projects';

export const GET = structureRead((db, ownerId, request) => {
  const search = new URL(request.url).searchParams;
  return listProjects(db, ownerId, { spaceId: search.get('spaceId') ?? undefined, includeArchived: search.get('includeArchived') === 'true' });
});

export async function POST(request: Request) {
  return structureWrite({
    request, resource: RESOURCE,
    fields: { requestId: { type: 'uuid', required: true }, spaceId: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string' } },
    run: ({ db, userId, requestId, method, resource, semantic }) => createProjectMutation(db, { userId, requestId, method, resource, body: semantic, spaceId: semantic.spaceId, name: semantic.name, description: semantic.description }),
  });
}
