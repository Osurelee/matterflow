import { createSpaceMutation, listSpaces } from '@/server/services/structure';
import { structureRead, structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
const RESOURCE = '/api/spaces';

export const GET = structureRead((db, ownerId, request) => listSpaces(db, ownerId, new URL(request.url).searchParams.get('includeArchived') === 'true'));

export async function POST(request: Request) {
  return structureWrite({
    request, resource: RESOURCE,
    fields: { requestId: { type: 'uuid', required: true }, name: { type: 'string', required: true }, description: { type: 'string' } },
    run: ({ db, userId, requestId, method, resource, semantic }) => createSpaceMutation(db, { userId, requestId, method, resource, body: semantic, name: semantic.name, description: semantic.description }),
  });
}
