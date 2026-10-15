import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';

type ProjectRoot = { id: string; name: string; root_task_id: string | null; archived_at: string | null; owner_user_id: string };
type TreeRow = { id: string; title: string; status: string; parent_id: string | null; project_id: string | null; section_id: string | null; sort_key: string; version: number; structure_version: number; has_children: number; nested_project_id: string | null };
const ACTIVE = new Set(['todo', 'in_progress', 'waiting']);

function loadProject(sql: ReturnType<typeof rawDb>, ownerId: string, projectId: string) {
  const project = sql.prepare('SELECT p.id,COALESCE(rt.title,p.name) AS name,p.root_task_id,p.archived_at,p.owner_user_id FROM projects p LEFT JOIN tasks rt ON rt.id=p.root_task_id WHERE p.id=? AND p.owner_user_id=?').get(projectId, ownerId) as ProjectRoot | undefined;
  if (!project) throw new MutationConflict('项目不存在', 'PROJECT_NOT_FOUND', 404);
  return project;
}

function loadProjectNodes(sql: ReturnType<typeof rawDb>, ownerId: string, project: ProjectRoot) {
  if (!project.root_task_id) return [] as Array<{ id: string; parent_id: string | null; status: string; project_id: string | null; is_project_root: number; depth: number }>;
  return sql.prepare(`WITH RECURSIVE tree(id,parent_id,status,project_id,depth) AS (
    SELECT t.id,t.parent_id,t.status,t.project_id,0 FROM tasks t WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL
    UNION ALL
    SELECT c.id,c.parent_id,c.status,c.project_id,tree.depth+1 FROM tasks c JOIN tree ON c.parent_id=tree.id
    WHERE c.owner_user_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL
  )
  SELECT tree.id,tree.parent_id,tree.status,tree.project_id,
    CASE WHEN EXISTS (SELECT 1 FROM projects p WHERE p.root_task_id=tree.id AND p.owner_user_id=?) THEN 1 ELSE 0 END AS is_project_root,
    tree.depth
  FROM tree ORDER BY tree.depth,tree.id`).all(project.root_task_id, ownerId, ownerId, ownerId) as Array<{ id: string; parent_id: string | null; status: string; project_id: string | null; is_project_root: number; depth: number }>;
}

export function getProjectOverview(database: AppDatabase, ownerId: string, projectId: string) {
  const sql = rawDb(database); const project = loadProject(sql, ownerId, projectId); const nodes = loadProjectNodes(sql, ownerId, project);
  if (!nodes.length) return { projectId, rootTaskId: project.root_task_id, name: project.name, progress: { active: 0, completed: 0, cancelled: 0, needsReview: 0, leafTotal: 0, completionPercent: null }, empty: true };
  const byParent = new Map<string, typeof nodes>();
  for (const node of nodes) { if (!node.parent_id) continue; const list = byParent.get(node.parent_id) ?? []; list.push(node); byParent.set(node.parent_id, list); }
  let active = 0; let completed = 0; let cancelled = 0; let needsReview = 0;
  const hasActiveDescendant = new Map<string, boolean>();
  for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
    const children = byParent.get(node.id) ?? [];
    hasActiveDescendant.set(node.id, children.some((child) => ACTIVE.has(child.status) || Boolean(hasActiveDescendant.get(child.id))));
  }
  for (const node of nodes) {
    if (node.id === project.root_task_id || node.is_project_root) continue;
    const children = byParent.get(node.id) ?? [];
    if (!children.length) {
      if (ACTIVE.has(node.status)) active += 1; else if (node.status === 'done') completed += 1; else if (node.status === 'cancelled') cancelled += 1;
      continue;
    }
    if (ACTIVE.has(node.status)) {
      if (!hasActiveDescendant.get(node.id)) needsReview += 1;
    }
  }
  const leafTotal = active + completed + cancelled;
  return { projectId, rootTaskId: project.root_task_id, name: project.name, progress: { active, completed, cancelled, needsReview, leafTotal, completionPercent: leafTotal ? Math.round((completed / leafTotal) * 100) : null }, empty: leafTotal === 0 && needsReview === 0 };
}

export function listProjectTreeChildren(database: AppDatabase, ownerId: string, projectId: string, parentId: string | null) {
  const sql = rawDb(database); const project = loadProject(sql, ownerId, projectId);
  if (!project.root_task_id) return { projectId, rootTaskId: null, parentId: null, items: [], hasMore: false, progress: getProjectOverview(database, ownerId, projectId).progress };
  const effectiveParent = parentId ?? project.root_task_id;
  const inTree = sql.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL UNION ALL SELECT c.id FROM tasks c JOIN tree ON c.parent_id=tree.id WHERE c.owner_user_id=? AND c.deleted_at IS NULL) SELECT 1 FROM tree WHERE id=?`).get(project.root_task_id, ownerId, ownerId, effectiveParent);
  if (!inTree) throw new MutationConflict('事项不属于当前项目主树', 'PROJECT_TREE_OUT_OF_SCOPE', 409);
  const items = sql.prepare(`SELECT t.id,t.title,t.status,t.parent_id,t.project_id,t.section_id,t.sort_key,t.version,t.structure_version,
      CASE WHEN EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id=t.id AND c.owner_user_id=? AND c.deleted_at IS NULL AND c.archived_at IS NULL) THEN 1 ELSE 0 END AS has_children,
      (SELECT p.id FROM projects p WHERE p.root_task_id=t.id AND p.owner_user_id=? LIMIT 1) AS nested_project_id
    FROM tasks t WHERE t.parent_id=? AND t.owner_user_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.sort_key,t.id`).all(ownerId, ownerId, effectiveParent, ownerId) as TreeRow[];
  return { projectId, rootTaskId: project.root_task_id, parentId: parentId ?? null, items: items.map((item) => ({ id: item.id, title: item.title, status: item.status, parentId: item.parent_id, projectId: item.project_id, sectionId: item.section_id, sortKey: item.sort_key, version: item.version, structureVersion: item.structure_version, hasChildren: Boolean(item.has_children), nestedProjectId: item.nested_project_id })), hasMore: false, progress: getProjectOverview(database, ownerId, projectId).progress };
}
