import type Database from 'better-sqlite3';
import { MutationConflict } from './errors';

export type Sql = Database.Database;

export type TaskNode = {
  id: string;
  parent_id: string | null;
  space_id: string;
  project_id: string | null;
  section_id: string | null;
  sort_key: string;
  status: string;
  archived_at: string | null;
  deleted_at: string | null;
  deletion_batch_id: string | null;
  version: number;
  structure_version: number;
  depth: number;
};

export function listTaskSubtree(sql: Sql, ownerId: string, rootId: string, includeDeleted = true): TaskNode[] {
  const deletedFilter = includeDeleted ? '' : ' AND t.deleted_at IS NULL';
  return sql.prepare(`WITH RECURSIVE d(id,parent_id,depth) AS (
    SELECT id,parent_id,0 FROM tasks WHERE id=? AND owner_user_id=?
    UNION ALL
    SELECT t.id,t.parent_id,d.depth+1 FROM tasks t JOIN d ON t.parent_id=d.id WHERE t.owner_user_id=?
  )
  SELECT t.id,t.parent_id,t.space_id,t.project_id,t.section_id,t.sort_key,t.status,t.archived_at,t.deleted_at,t.deletion_batch_id,t.version,t.structure_version,d.depth
  FROM d JOIN tasks t ON t.id=d.id WHERE 1=1${deletedFilter} ORDER BY d.depth ASC,t.id ASC`).all(rootId, ownerId, ownerId) as TaskNode[];
}

export function assertWritablePath(sql: Sql, ownerId: string, startId: string, label: '目标' | '来源' = '目标') {
  const bad = sql.prepare(`WITH RECURSIVE a(id,parent_id,status,archived_at,deleted_at) AS (
    SELECT id,parent_id,status,archived_at,deleted_at FROM tasks WHERE id=? AND owner_user_id=?
    UNION ALL
    SELECT p.id,p.parent_id,p.status,p.archived_at,p.deleted_at FROM tasks p JOIN a ON p.id=a.parent_id WHERE p.owner_user_id=?
  ) SELECT id,status,archived_at,deleted_at FROM a
  WHERE status IN ('done','cancelled') OR archived_at IS NOT NULL OR deleted_at IS NOT NULL LIMIT 1`).get(startId, ownerId, ownerId) as { id: string; status: string; archived_at: string | null; deleted_at: string | null } | undefined;
  if (bad) throw new MutationConflict(`${label}路径含已结束、归档或删除事项`, label === '目标' ? 'TARGET_PATH_NOT_WRITABLE' : 'SOURCE_PATH_NOT_WRITABLE', 409, { current: bad });
}

export function assertNoActiveDescendants(sql: Sql, ownerId: string, rootId: string) {
  const active = sql.prepare(`WITH RECURSIVE d(id,depth) AS (
    SELECT id,0 FROM tasks WHERE id=? AND owner_user_id=?
    UNION ALL
    SELECT t.id,d.depth+1 FROM tasks t JOIN d ON t.parent_id=d.id WHERE t.owner_user_id=? AND t.deleted_at IS NULL
  ) SELECT t.id,t.title,t.status,d.depth FROM d JOIN tasks t ON t.id=d.id
  WHERE d.depth>0 AND t.deleted_at IS NULL AND t.status NOT IN ('done','cancelled') LIMIT 1`).get(rootId, ownerId, ownerId) as { id: string; title: string; status: string; depth: number } | undefined;
  if (active) throw new MutationConflict('事项仍有活跃主后代，不能结束或归档', 'ACTIVE_DESCENDANTS', 409, { current: active });
}

export function assertAncestorsActive(sql: Sql, ownerId: string, taskId: string) {
  const bad = sql.prepare(`WITH RECURSIVE a(id,parent_id,status,archived_at,deleted_at) AS (
    SELECT p.id,p.parent_id,p.status,p.archived_at,p.deleted_at FROM tasks child JOIN tasks p ON p.id=child.parent_id WHERE child.id=? AND child.owner_user_id=?
    UNION ALL
    SELECT p.id,p.parent_id,p.status,p.archived_at,p.deleted_at FROM tasks p JOIN a ON p.id=a.parent_id WHERE p.owner_user_id=?
  ) SELECT id,status,archived_at,deleted_at FROM a
  WHERE status IN ('done','cancelled') OR archived_at IS NOT NULL OR deleted_at IS NOT NULL LIMIT 1`).get(taskId, ownerId, ownerId) as { id: string; status: string; archived_at: string | null; deleted_at: string | null } | undefined;
  if (bad) throw new MutationConflict('主父路径未全部保持活跃且可写', 'ANCESTOR_NOT_WRITABLE', 409, { current: bad });
}
