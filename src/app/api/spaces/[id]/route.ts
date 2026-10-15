import { getSpace, updateSpaceMutation } from '@/server/services/structure';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { currentUser } from '@/server/auth/session';
import { createDatabase } from '@/server/db/client';
import { structureWrite } from '@/server/http/structure-route';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  void request;
  const requestId = apiRequestId();
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const { id } = await params;
  let db: ReturnType<typeof createDatabase>; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const space = getSpace(db, user.id, id);
    if (!space) return apiError(404, 'SPACE_NOT_FOUND', '空间不存在', { requestId });
    return apiSuccess(space, requestId);
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}

export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  return structureWrite({
    request, resource: `/api/spaces/${id}`,
    fields: { requestId: { type: 'uuid', required: true }, expectedVersion: { type: 'number', required: true }, name: { type: 'string' }, description: { type: 'string' } },
    run: ({ db, userId, requestId, method, resource, semantic }) => updateSpaceMutation(db, { userId, requestId, method, resource, body: semantic, spaceId: id, name: semantic.name, description: semantic.description, expectedVersion: semantic.expectedVersion as number }),
  });
}
