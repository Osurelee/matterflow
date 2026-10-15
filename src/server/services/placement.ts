/** 事项归属校验（M3-02）：空间/项目必须属于当前 owner、互相匹配且未归档。 */
import type { rawDb } from '@/server/db/client';
import { MutationConflict } from './errors';

export function resolveTaskPlacement(sql: ReturnType<typeof rawDb>, ownerId: string, spaceId: string, projectId: string | null) {
  const space = sql.prepare('SELECT id,archived_at FROM spaces WHERE id=? AND owner_user_id=?').get(spaceId, ownerId) as { id: string; archived_at: string | null } | undefined;
  if (!space) throw new MutationConflict('空间不存在或不可用', 'SPACE_NOT_FOUND', 404, { fieldErrors: { spaceId: '空间不存在' } });
  if (space.archived_at) throw new MutationConflict('已归档空间不能新增或移入事项', 'SPACE_ARCHIVED', 409);
  if (!projectId) return { spaceId: space.id, projectId: null };
  const project = sql.prepare('SELECT id,space_id,archived_at FROM projects WHERE id=? AND owner_user_id=?').get(projectId, ownerId) as { id: string; space_id: string; archived_at: string | null } | undefined;
  if (!project) throw new MutationConflict('项目不存在', 'PROJECT_NOT_FOUND', 404, { fieldErrors: { projectId: '项目不存在' } });
  if (project.space_id !== space.id) throw new MutationConflict('项目必须与事项同空间', 'PROJECT_SPACE_MISMATCH', 409, { fieldErrors: { projectId: '项目必须与事项同空间' } });
  if (project.archived_at) throw new MutationConflict('已归档项目不能新增或移入事项', 'PROJECT_ARCHIVED', 409);
  return { spaceId: space.id, projectId: project.id };
}
