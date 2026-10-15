import { unarchiveSpaceMutation } from '@/server/services/structure';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return structureWrite({
    request, resource: `/api/spaces/${id}/unarchive`,
    fields: { requestId: { type: 'uuid', required: true }, expectedVersion: { type: 'number', required: true } },
    run: ({ db, userId, requestId, method, resource, semantic }) => unarchiveSpaceMutation(db, { userId, requestId, method, resource, body: semantic, spaceId: id, expectedVersion: semantic.expectedVersion as number }),
  });
}
