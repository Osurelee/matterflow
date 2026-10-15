/**
 * 空间与项目结构服务（M3-01 / M3-02，PRD v0.6 第 9、10.4 节 / 技术设计 3.2、9）。
 *
 * 规则要点：
 * - 名称去空白后 1–80 码点；描述最多 5,000 码点；同一 owner 内空间名唯一，同一空间内项目名唯一。
 * - 默认私人空间不可归档；归档容器拒绝新增、编辑、移入。
 * - 空间归档要求没有未删除事项、没有未归档项目。
 * - 项目归档只计算未删除的活跃事项；取消项目归档要求所属空间未归档。
 * - 首版空间/项目不提供硬删除。
 */
import { randomUUID } from 'node:crypto';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { codePointLength, prepareBody } from '@/domain/body';
import { MutationConflict } from './errors';
import { runIdempotentMutation } from './mutations';

const ACTIVE_STATUSES = "('todo','in_progress','waiting')";

type SpaceRow = { id: string; name: string; description: string; is_default: number; archived_at: string | null; version: number; created_at: string; updated_at: string };
type ProjectRow = {id:string;space_id:string;space_name:string;name:string;description:string;archived_at:string|null;version:number;created_at:string;updated_at:string;root_task_id:string|null;status:string;is_paused:number;target_date:string|null;success_criteria:string;root_status:string|null};

function normaliseName(value: unknown, fieldErrors: Record<string, string>) {
  if (typeof value !== 'string') { fieldErrors.name = '必须是文本'; return ''; }
  const name = value.trim();
  if (!name) fieldErrors.name = '不能为空';
  else if ([...name].length > 80) fieldErrors.name = '最多80个字符';
  return name;
}
function normaliseDescription(value: unknown, fieldErrors: Record<string, string>) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') { fieldErrors.description = '必须是文本'; return ''; }
  const description = value.trim();
  if ([...description].length > 5000) fieldErrors.description = '最多5000个字符';
  return description;
}
function conflictIfErrors(fieldErrors: Record<string, string>) {
  if (Object.keys(fieldErrors).length) throw new MutationConflict('结构字段无效', 'INVALID_INPUT', 400, { fieldErrors });
}
function spacePayload(row: SpaceRow, counts: { projectCount: number; taskCount: number }) {
  return {
    id: row.id, name: row.name, description: row.description, isDefault: Boolean(row.is_default),
    archived: row.archived_at !== null, archivedAt: row.archived_at, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, projectCount: counts.projectCount, taskCount: counts.taskCount,
  };
}
function projectPayload(row: ProjectRow, counts: { active: number; completed: number; cancelled: number; deleted: number }) {
  return {
    id: row.id, spaceId: row.space_id, spaceName: row.space_name, name: row.name, description: row.description,
    rootTaskId:row.root_task_id,status:row.root_task_id?(row.root_status==='done'?'completed':row.root_status==='cancelled'?'cancelled':row.is_paused?'paused':'active'):row.status,isPaused:Boolean(row.is_paused),targetDate:row.target_date,successCriteria:row.success_criteria,
    archived: row.archived_at !== null, archivedAt: row.archived_at, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, counts,
  };
}

const SPACE_SELECT = 'SELECT id,name,description,is_default,archived_at,version,created_at,updated_at FROM spaces WHERE id=? AND owner_user_id=?';
const PROJECT_SELECT = "SELECT p.id,p.space_id,s.name AS space_name,COALESCE(rt.title,p.name) AS name,COALESCE(rt.description,p.description) AS description,p.archived_at,p.version,p.created_at,p.updated_at,p.root_task_id,p.status,p.is_paused,p.target_date,p.success_criteria,rt.status AS root_status FROM projects p INNER JOIN spaces s ON s.id=p.space_id LEFT JOIN tasks rt ON rt.id=p.root_task_id WHERE p.id=? AND p.owner_user_id=?";

function spaceCounts(sql: ReturnType<typeof rawDb>, spaceId: string) {
  const projectCount = (sql.prepare('SELECT count(*) n FROM projects WHERE space_id=?').get(spaceId) as { n: number }).n;
  const taskCount = (sql.prepare('SELECT count(*) n FROM tasks WHERE space_id=? AND deleted_at IS NULL').get(spaceId) as { n: number }).n;
  return { projectCount, taskCount };
}
function projectCounts(sql: ReturnType<typeof rawDb>, projectId: string) {
  const row = sql.prepare(`SELECT
      sum(CASE WHEN t.status IN ${ACTIVE_STATUSES} THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN t.status='done' THEN 1 ELSE 0 END) AS completed,
      sum(CASE WHEN t.status='cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND t.deleted_at IS NULL AND (p.root_task_id IS NULL OR t.id<>p.root_task_id)`).get(projectId) as { active: number | null; completed: number | null; cancelled: number | null };
  const deleted = (sql.prepare('SELECT count(*) n FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND t.deleted_at IS NOT NULL AND (p.root_task_id IS NULL OR t.id<>p.root_task_id)').get(projectId) as { n: number }).n;
  return { active: row.active ?? 0, completed: row.completed ?? 0, cancelled: row.cancelled ?? 0, deleted };
}

/* ------------------------------------------------------------------ 读取 */

export function listSpaces(database: AppDatabase, ownerId: string, includeArchived = false) {
  const sql = rawDb(database);
  const rows = sql.prepare(`SELECT id,name,description,is_default,archived_at,version,created_at,updated_at FROM spaces WHERE owner_user_id=?${includeArchived ? '' : ' AND archived_at IS NULL'} ORDER BY is_default DESC, name ASC, id ASC`).all(ownerId) as SpaceRow[];
  return { items: rows.map((row) => spacePayload(row, spaceCounts(sql, row.id))), includeArchived };
}

export function listProjects(database: AppDatabase, ownerId: string, options: { spaceId?: string; includeArchived?: boolean } = {}) {
  const sql = rawDb(database);
  const filters = ['p.owner_user_id=?'];
  const args: unknown[] = [ownerId];
  if (options.spaceId) { filters.push('p.space_id=?'); args.push(options.spaceId); }
  if (!options.includeArchived) filters.push('p.archived_at IS NULL');
  const rows = sql.prepare(`SELECT p.id,p.space_id,s.name AS space_name,COALESCE(rt.title,p.name) AS name,COALESCE(rt.description,p.description) AS description,p.archived_at,p.version,p.created_at,p.updated_at,p.root_task_id,p.status,p.is_paused,p.target_date,p.success_criteria,rt.status AS root_status FROM projects p INNER JOIN spaces s ON s.id=p.space_id LEFT JOIN tasks rt ON rt.id=p.root_task_id WHERE ${filters.join(' AND ')} ORDER BY s.name ASC, COALESCE(rt.title,p.name) ASC, p.id ASC`).all(...args) as ProjectRow[];
  return { items: rows.map((row) => projectPayload(row, projectCounts(sql, row.id))), spaceId: options.spaceId ?? null, includeArchived: Boolean(options.includeArchived) };
}

export function getSpace(database: AppDatabase, ownerId: string, spaceId: string) {
  const sql = rawDb(database);
  const row = sql.prepare(SPACE_SELECT).get(spaceId, ownerId) as SpaceRow | undefined;
  return row ? spacePayload(row, spaceCounts(sql, row.id)) : null;
}

export function getProject(database: AppDatabase, ownerId: string, projectId: string) {
  const sql = rawDb(database);
  const row = sql.prepare(PROJECT_SELECT).get(projectId, ownerId) as ProjectRow | undefined;
  return row ? projectPayload(row, projectCounts(sql, row.id)) : null;
}

type EnableProjectTask = {
  id: string; title: string; description: string; status: string; version: number; structure_version: number;
  space_id: string; space_name: string; parent_id: string | null; project_id: string | null; archived_at: string | null; deleted_at: string | null;
};
type StructureMutationInput = { userId: string; requestId: string; method: string; resource: string; body: unknown };

function enableProjectStatus(status: string) {
  return status === 'done' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'active';
}

function validateTargetDate(value: string | undefined) {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MutationConflict('成果日期必须是YYYY-MM-DD有效日期', 'INVALID_DATE', 400, { fieldErrors: { targetDate: '必须是YYYY-MM-DD有效日期' } });
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new MutationConflict('成果日期不是有效日历日期', 'INVALID_DATE', 400, { fieldErrors: { targetDate: '不是有效日历日期' } });
}

function loadEnableProjectTask(sql: ReturnType<typeof rawDb>, ownerId: string, taskId: string) {
  return sql.prepare(`SELECT t.id,t.title,t.description,t.status,t.version,t.structure_version,t.space_id,s.name AS space_name,t.parent_id,t.project_id,t.archived_at,t.deleted_at
    FROM tasks t INNER JOIN spaces s ON s.id=t.space_id
    WHERE t.id=? AND t.owner_user_id=? AND s.archived_at IS NULL`).get(taskId, ownerId) as EnableProjectTask | undefined;
}

export function previewEnableProject(database: AppDatabase, ownerId: string, taskId: string) {
  const sql = rawDb(database);
  const task = loadEnableProjectTask(sql, ownerId, taskId);
  if (!task || task.deleted_at) return null;
  if (task.archived_at) throw new MutationConflict('已归档事项不能启用项目视图', 'TASK_ARCHIVED', 409);
  const existing = sql.prepare(`${PROJECT_SELECT.replace('WHERE p.id=? AND p.owner_user_id=?', 'WHERE p.root_task_id=? AND p.owner_user_id=?')}`).get(task.id, ownerId) as ProjectRow | undefined;
  const childCount = (sql.prepare(`WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id=? AND owner_user_id=? UNION ALL SELECT c.id FROM tasks c JOIN d ON c.parent_id=d.id WHERE c.owner_user_id=?) SELECT count(*) AS n FROM d`).get(task.id, ownerId, ownerId) as { n: number }).n;
  return {
    task: { id: task.id, title: task.title, description: task.description, status: task.status, version: task.version, structureVersion: task.structure_version, spaceId: task.space_id, spaceName: task.space_name, parentId: task.parent_id, projectId: task.project_id },
    expectedVersion: task.version,
    expectedStructureVersion: task.structure_version,
    childCount,
    alreadyEnabled: Boolean(existing),
    project: existing ? projectPayload(existing, projectCounts(sql, existing.id)) : null,
  };
}

export function enableProjectMutation(database: AppDatabase, input: StructureMutationInput & {
  taskId: string; expectedVersion: number; expectedStructureVersion: number; successCriteria?: unknown; targetDate?: unknown;
}) {
  const projectId = randomUUID();
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
    if (!Number.isInteger(input.expectedStructureVersion) || input.expectedStructureVersion < 1) throw new MutationConflict('expectedStructureVersion无效', 'INVALID_STRUCTURE_VERSION', 400, { fieldErrors: { expectedStructureVersion: '必须是正整数' } });
    const successCriteria = input.successCriteria === undefined ? '' : String(input.successCriteria).trim();
    const targetDate = input.targetDate === undefined ? undefined : String(input.targetDate).trim();
    if ([...successCriteria].length > 5000) throw new MutationConflict('完成标准最多5000个字符', 'INVALID_INPUT', 400, { fieldErrors: { successCriteria: '最多5000个字符' } });
    validateTargetDate(targetDate);
    const current = loadEnableProjectTask(sql, input.userId, input.taskId);
    if (!current || current.deleted_at) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    if (current.archived_at) throw new MutationConflict('已归档事项不能启用项目视图', 'TASK_ARCHIVED', 409);
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version });
    if (current.structure_version !== input.expectedStructureVersion) throw new MutationConflict('事项结构版本已变化，请重新加载', 'STRUCTURE_VERSION_CONFLICT', 409, { currentVersion: current.structure_version });

    const existing = sql.prepare(`${PROJECT_SELECT.replace('WHERE p.id=? AND p.owner_user_id=?', 'WHERE p.root_task_id=? AND p.owner_user_id=?')}`).get(current.id, input.userId) as ProjectRow | undefined;
    if (existing) return { changed: false, taskId: current.id, project: projectPayload(existing, projectCounts(sql, existing.id)), taskVersion: current.version, structureVersion: current.structure_version, affectedCount: 0 };
    const taken = sql.prepare('SELECT id FROM projects WHERE space_id=? AND name=?').get(current.space_id, current.title) as { id: string } | undefined;
    if (taken) throw new MutationConflict('同一空间内已有同名项目，请先调整事项标题', 'NAME_TAKEN', 409, { fieldErrors: { title: '同名项目已存在' } });

    const nodes = sql.prepare(`WITH RECURSIVE tree(id,parent_id,depth) AS (
      SELECT id,parent_id,0 FROM tasks WHERE id=? AND owner_user_id=?
      UNION ALL
      SELECT c.id,c.parent_id,tree.depth+1 FROM tasks c JOIN tree ON c.parent_id=tree.id WHERE c.owner_user_id=?
    ) SELECT t.id,t.parent_id,t.project_id,t.section_id,t.version,t.structure_version,tree.depth FROM tree JOIN tasks t ON t.id=tree.id ORDER BY tree.depth,t.id`).all(current.id, input.userId, input.userId) as Array<{ id: string; parent_id: string | null; project_id: string | null; section_id: string | null; version: number; structure_version: number; depth: number }>;
    if (!nodes.length) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    sql.prepare('INSERT INTO projects(id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at,root_task_id,status,is_paused,target_date,success_criteria) VALUES(?,?,?,?,?,NULL,1,?,?,NULL,?,0,?,?)').run(projectId, input.userId, current.space_id, current.title, current.description, now, now, enableProjectStatus(current.status), targetDate ?? null, successCriteria);

    const nestedRoots = new Map<string, string>();
    const rootRows = sql.prepare('SELECT id,root_task_id FROM projects WHERE owner_user_id=? AND root_task_id IS NOT NULL').all(input.userId) as Array<{ id: string; root_task_id: string }>;
    for (const row of rootRows) nestedRoots.set(row.root_task_id, row.id);
    nestedRoots.set(current.id, projectId);
    const projectByTask = new Map<string, string | null>();
    const changedNodes: Array<{ id: string; from: string | null; to: string; version: number }> = [];
    for (const node of nodes) {
      const nextProject = nestedRoots.get(node.id) ?? (node.parent_id ? projectByTask.get(node.parent_id) ?? null : null);
      projectByTask.set(node.id, nextProject);
      if (node.project_id === nextProject) continue;
      const nextVersion = node.version + 1;
      const nextStructureVersion = node.id === current.id ? node.structure_version + 1 : node.structure_version;
      const updated = sql.prepare('UPDATE tasks SET project_id=?,section_id=NULL,updated_at=?,version=version+1,structure_version=? WHERE id=? AND owner_user_id=? AND version=?').run(nextProject, now, nextStructureVersion, node.id, input.userId, node.version);
      if (updated.changes !== 1) throw new MutationConflict('事项结构已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: node.version });
      changedNodes.push({ id: node.id, from: node.project_id, to: nextProject as string, version: nextVersion });
      sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, node.id, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, action: 'enable_project', changes: { projectId: { from: node.project_id, to: nextProject }, ...(node.id === current.id ? { projectView: { from: false, to: true } } : {}) }, version: nextVersion, sourceTaskId: current.id }), now, input.requestId);
    }
    sql.prepare('UPDATE projects SET root_task_id=? WHERE id=? AND owner_user_id=?').run(current.id, projectId, input.userId);
    sql.prepare('UPDATE spaces SET structure_version=structure_version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, current.space_id, input.userId);
    const row = sql.prepare(PROJECT_SELECT).get(projectId, input.userId) as ProjectRow;
    return { changed: true, taskId: current.id, project: projectPayload(row, projectCounts(sql, projectId)), taskVersion: current.version + 1, structureVersion: current.structure_version + 1, affectedCount: changedNodes.length };
  });
}

/* ------------------------------------------------------------------ 空间写入 */

export function createSpaceMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; name: unknown; description?: unknown }) {
  const spaceId = randomUUID();
  return runIdempotentMutation(database, input, (sql, now) => {
    const fieldErrors: Record<string, string> = {};
    const name = normaliseName(input.name, fieldErrors);
    const description = normaliseDescription(input.description, fieldErrors);
    conflictIfErrors(fieldErrors);
    const taken = sql.prepare('SELECT 1 FROM spaces WHERE owner_user_id=? AND name=?').get(input.userId, name);
    if (taken) throw new MutationConflict('同名空间已存在', 'NAME_TAKEN', 409, { fieldErrors: { name: '同名空间已存在' } });
    sql.prepare('INSERT INTO spaces(id,owner_user_id,name,description,is_default,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,0,NULL,1,?,?)').run(spaceId, input.userId, name, description, now, now);
    const row = sql.prepare(SPACE_SELECT).get(spaceId, input.userId) as SpaceRow;
    return spacePayload(row, spaceCounts(sql, spaceId));
  });
}

export function updateSpaceMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; spaceId: string; name?: unknown; description?: unknown; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
    const current = sql.prepare(SPACE_SELECT).get(input.spaceId, input.userId) as SpaceRow | undefined;
    if (!current) throw new MutationConflict('空间不存在', 'SPACE_NOT_FOUND', 404);
    if (current.archived_at) throw new MutationConflict('已归档空间不可修改', 'SPACE_ARCHIVED', 409);
    if (current.version !== input.expectedVersion) throw new MutationConflict('空间版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: spacePayload(current, spaceCounts(sql, current.id)) });
    const fieldErrors: Record<string, string> = {};
    const name = input.name === undefined ? current.name : normaliseName(input.name, fieldErrors);
    const description = input.description === undefined ? current.description : normaliseDescription(input.description, fieldErrors);
    conflictIfErrors(fieldErrors);
    if (name !== current.name) {
      const taken = sql.prepare('SELECT 1 FROM spaces WHERE owner_user_id=? AND name=? AND id<>?').get(input.userId, name, current.id);
      if (taken) throw new MutationConflict('同名空间已存在', 'NAME_TAKEN', 409, { fieldErrors: { name: '同名空间已存在' } });
    }
    sql.prepare('UPDATE spaces SET name=?,description=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(name, description, now, current.id, input.userId, input.expectedVersion);
    const row = sql.prepare(SPACE_SELECT).get(current.id, input.userId) as SpaceRow;
    return spacePayload(row, spaceCounts(sql, current.id));
  });
}

function loadSpaceForWrite(sql: ReturnType<typeof rawDb>, ownerId: string, spaceId: string, expectedVersion: number) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
  const current = sql.prepare(SPACE_SELECT).get(spaceId, ownerId) as SpaceRow | undefined;
  if (!current) throw new MutationConflict('空间不存在', 'SPACE_NOT_FOUND', 404);
  if (current.version !== expectedVersion) throw new MutationConflict('空间版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: spacePayload(current, spaceCounts(sql, current.id)) });
  return current;
}

export function archiveSpaceMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; spaceId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const current = loadSpaceForWrite(sql, input.userId, input.spaceId, input.expectedVersion);
    if (current.is_default) throw new MutationConflict('默认私人空间不可归档', 'SPACE_DEFAULT_ARCHIVE', 409);
    if (current.archived_at) throw new MutationConflict('空间已归档', 'ALREADY_ARCHIVED', 409);
    const unarchivedProjects = (sql.prepare('SELECT count(*) n FROM projects WHERE space_id=? AND archived_at IS NULL').get(current.id) as { n: number }).n;
    if (unarchivedProjects > 0) throw new MutationConflict('空间内仍有未归档项目，不能归档', 'SPACE_HAS_PROJECTS', 409);
    const liveTasks = (sql.prepare('SELECT count(*) n FROM tasks WHERE space_id=? AND deleted_at IS NULL').get(current.id) as { n: number }).n;
    if (liveTasks > 0) throw new MutationConflict('空间内仍有未删除事项，不能归档', 'SPACE_HAS_TASKS', 409);
    sql.prepare('UPDATE spaces SET archived_at=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(now, now, current.id, input.userId, input.expectedVersion);
    const row = sql.prepare(SPACE_SELECT).get(current.id, input.userId) as SpaceRow;
    return spacePayload(row, spaceCounts(sql, current.id));
  });
}

export function unarchiveSpaceMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; spaceId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const current = loadSpaceForWrite(sql, input.userId, input.spaceId, input.expectedVersion);
    if (!current.archived_at) throw new MutationConflict('空间未归档', 'NOT_ARCHIVED', 409);
    sql.prepare('UPDATE spaces SET archived_at=NULL,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(now, current.id, input.userId, input.expectedVersion);
    const row = sql.prepare(SPACE_SELECT).get(current.id, input.userId) as SpaceRow;
    return spacePayload(row, spaceCounts(sql, current.id));
  });
}

/* ------------------------------------------------------------------ 项目写入 */

export function createProjectMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; spaceId: unknown; name: unknown; description?: unknown }) {
  const projectId = randomUUID();
  return runIdempotentMutation(database, input, (sql, now) => {
    const fieldErrors: Record<string, string> = {};
    if (typeof input.spaceId !== 'string') fieldErrors.spaceId = '必须是文本';
    const name = normaliseName(input.name, fieldErrors);
    const description = normaliseDescription(input.description, fieldErrors);
    conflictIfErrors(fieldErrors);
    const space = sql.prepare('SELECT id,name,archived_at FROM spaces WHERE id=? AND owner_user_id=?').get(input.spaceId as string, input.userId) as { id: string; name: string; archived_at: string | null } | undefined;
    if (!space) throw new MutationConflict('空间不存在', 'SPACE_NOT_FOUND', 404, { fieldErrors: { spaceId: '空间不存在' } });
    if (space.archived_at) throw new MutationConflict('已归档空间不能新建项目', 'SPACE_ARCHIVED', 409);
    const taken = sql.prepare('SELECT 1 FROM projects WHERE space_id=? AND name=?').get(space.id, name);
    if (taken) throw new MutationConflict('同一空间内已有同名项目', 'NAME_TAKEN', 409, { fieldErrors: { name: '同一空间内已有同名项目' } });
    sql.prepare('INSERT INTO projects(id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,?,NULL,1,?,?)').run(projectId, input.userId, space.id, name, description, now, now);
    const row = sql.prepare(PROJECT_SELECT).get(projectId, input.userId) as ProjectRow;
    return projectPayload(row, projectCounts(sql, projectId));
  });
}

export function updateProjectMutation(database:AppDatabase,input:{userId:string;requestId:string;method:string;resource:string;body:unknown;projectId:string;name?:unknown;description?:unknown;expectedVersion:number}){
  return runIdempotentMutation(database,input,(sql,now)=>{
    if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1)throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    const current=sql.prepare(PROJECT_SELECT).get(input.projectId,input.userId) as ProjectRow|undefined;
    if(!current)throw new MutationConflict('项目不存在','PROJECT_NOT_FOUND',404);
    if(current.archived_at)throw new MutationConflict('已归档项目不可修改','PROJECT_ARCHIVED',409);
    if(current.version!==input.expectedVersion)throw new MutationConflict('项目版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:projectPayload(current,projectCounts(sql,current.id))});
    const fieldErrors:Record<string,string>={};const name=input.name===undefined?current.name:normaliseName(input.name,fieldErrors);const description=input.description===undefined?current.description:normaliseDescription(input.description,fieldErrors);conflictIfErrors(fieldErrors);
    if(name!==current.name){const taken=sql.prepare('SELECT 1 FROM projects WHERE space_id=? AND name=? AND id<>?').get(current.space_id,name,current.id);if(taken)throw new MutationConflict('同一空间内已有同名项目','NAME_TAKEN',409,{fieldErrors:{name:'同一空间内已有同名项目'}})}
    let root:Record<string,unknown>|undefined;let bodyUpdate:{description:string;descriptionPlain:string;format:string}|null=null;const rootChanges:Record<string,{from:unknown;to:unknown}>={};
    if(current.root_task_id){root=sql.prepare('SELECT id,title,description,description_plain,description_format,status,version,archived_at,deleted_at FROM tasks WHERE id=? AND owner_user_id=?').get(current.root_task_id,input.userId) as Record<string,unknown>|undefined;if(!root||root.deleted_at)throw new MutationConflict('项目根事项不存在或已删除','PROJECT_ROOT_NOT_FOUND',409);if(root.archived_at)throw new MutationConflict('项目根事项已归档，不能修改项目内容','PROJECT_ARCHIVED',409);
      if(name!==String(root.title))rootChanges.title={from:root.title,to:name};
      const nextFormat=String(root.description_format||'plaintext');const prepared=prepareBody({description,format:nextFormat as 'plaintext'|'markdown_v1'});
      if(prepared.description!==String(root.description)){bodyUpdate={description:prepared.description,descriptionPlain:prepared.descriptionPlain,format:nextFormat};rootChanges.description={from:{format:nextFormat,length:codePointLength(String(root.description))},to:{format:nextFormat,length:codePointLength(prepared.description)}}}
      if(Object.keys(rootChanges).length){const rootVersion=Number(root.version)+1;const update=sql.prepare('UPDATE tasks SET title=?,description=?,description_plain=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(name,bodyUpdate?.description??root.description,bodyUpdate?.descriptionPlain??root.description_plain,now,root.id,input.userId,Number(root.version));if(update.changes!==1)throw new MutationConflict('项目根事项已更新，请刷新后重试','VERSION_CONFLICT',409,{currentVersion:Number(root.version)});
        if(bodyUpdate)sql.prepare('INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,root.id,bodyUpdate.format,bodyUpdate.description,bodyUpdate.descriptionPlain,rootVersion,input.requestId,now);
        sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,root.id,input.userId,'task_updated',JSON.stringify({schemaVersion:1,changes:rootChanges,version:rootVersion,sourceProjectId:current.id}),now,input.requestId);
      }
    }
    const nextProjectStatus=root?(root.status==='done'?'completed':root.status==='cancelled'?'cancelled':current.is_paused?'paused':'active'):current.status;
    sql.prepare('UPDATE projects SET name=?,description=?,status=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(name,description,nextProjectStatus,now,current.id,input.userId,input.expectedVersion);
    const row=sql.prepare(PROJECT_SELECT).get(current.id,input.userId) as ProjectRow;return projectPayload(row,projectCounts(sql,current.id));
  });
}

function loadProjectForWrite(sql: ReturnType<typeof rawDb>, ownerId: string, projectId: string, expectedVersion: number) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
  const current = sql.prepare(PROJECT_SELECT).get(projectId, ownerId) as ProjectRow | undefined;
  if (!current) throw new MutationConflict('项目不存在', 'PROJECT_NOT_FOUND', 404);
  if (current.version !== expectedVersion) throw new MutationConflict('项目版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: projectPayload(current, projectCounts(sql, current.id)) });
  return current;
}

export function archiveProjectMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; projectId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const current = loadProjectForWrite(sql, input.userId, input.projectId, input.expectedVersion);
    if (current.archived_at) throw new MutationConflict('项目已归档', 'ALREADY_ARCHIVED', 409);
    const active = projectCounts(sql, current.id).active;
    if (active > 0) throw new MutationConflict('项目内仍有活跃事项，不能归档', 'PROJECT_HAS_ACTIVE_TASKS', 409);
    sql.prepare('UPDATE projects SET archived_at=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(now, now, current.id, input.userId, input.expectedVersion);
    if(current.root_task_id){const root=sql.prepare('SELECT id,version,archived_at FROM tasks WHERE id=? AND owner_user_id=?').get(current.root_task_id,input.userId) as {id:string;version:number;archived_at:string|null}|undefined;if(!root)throw new MutationConflict('项目根事项不存在','PROJECT_ROOT_NOT_FOUND',409);if(!root.archived_at){sql.prepare('UPDATE tasks SET archived_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?').run(now,now,root.id,root.version);sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,root.id,input.userId,'task_archived',JSON.stringify({schemaVersion:1,changes:{archivedAt:{from:null,to:now},sourceProjectId:current.id}}),now,input.requestId)}}
    const row = sql.prepare(PROJECT_SELECT).get(current.id, input.userId) as ProjectRow;
    return projectPayload(row, projectCounts(sql, current.id));
  });
}

export function unarchiveProjectMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; projectId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const current = loadProjectForWrite(sql, input.userId, input.projectId, input.expectedVersion);
    if (!current.archived_at) throw new MutationConflict('项目未归档', 'NOT_ARCHIVED', 409);
    const space = sql.prepare('SELECT archived_at FROM spaces WHERE id=?').get(current.space_id) as { archived_at: string | null } | undefined;
    if (!space || space.archived_at) throw new MutationConflict('所属空间已归档，请先取消空间归档', 'SPACE_ARCHIVED', 409);
    sql.prepare('UPDATE projects SET archived_at=NULL,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(now, current.id, input.userId, input.expectedVersion);
    if(current.root_task_id){const root=sql.prepare('SELECT id,version,archived_at FROM tasks WHERE id=? AND owner_user_id=?').get(current.root_task_id,input.userId) as {id:string;version:number;archived_at:string|null}|undefined;if(!root)throw new MutationConflict('项目根事项不存在','PROJECT_ROOT_NOT_FOUND',409);if(root.archived_at){sql.prepare('UPDATE tasks SET archived_at=NULL,updated_at=?,version=version+1 WHERE id=? AND version=?').run(now,root.id,root.version);sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,root.id,input.userId,'task_unarchived',JSON.stringify({schemaVersion:1,changes:{archivedAt:{from:root.archived_at,to:null},sourceProjectId:current.id}}),now,input.requestId)}}
    const row = sql.prepare(PROJECT_SELECT).get(current.id, input.userId) as ProjectRow;
    return projectPayload(row, projectCounts(sql, current.id));
  });
}
