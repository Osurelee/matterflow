import { getProjectOverview, listProjectTreeChildren } from '@/server/services/project-views';
import { structureRead } from '@/server/http/structure-route';
import { MutationConflict } from '@/server/services/errors';

export const runtime = 'nodejs';
export const GET = structureRead((db, ownerId, request) => {
  const url = new URL(request.url); const projectId = url.pathname.split('/').at(-2)!; const parentId = url.searchParams.get('parentId');
  if ([...url.searchParams.keys()].some((key) => key !== 'parentId')) throw new MutationConflict('查询参数无效', 'INVALID_INPUT', 400);
  if (parentId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parentId)) throw new MutationConflict('parentId无效', 'INVALID_INPUT', 400);
  return listProjectTreeChildren(db, ownerId, projectId, parentId);
});
