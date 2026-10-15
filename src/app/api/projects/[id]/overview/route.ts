import { getProjectOverview } from '@/server/services/project-views';
import { structureRead } from '@/server/http/structure-route';

export const runtime = 'nodejs';
export const GET = structureRead((db, ownerId, request) => getProjectOverview(db, ownerId, new URL(request.url).pathname.split('/').at(-2)!));
