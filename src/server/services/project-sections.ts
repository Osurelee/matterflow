import { randomUUID } from 'node:crypto';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';
import { runIdempotentMutation } from './mutations';

type SectionRow = {
  id: string; owner_user_id: string; project_id: string; name: string;
  sort_key: string; version: number; created_at: string; updated_at: string;
};

function sectionPayload(sql: ReturnType<typeof rawDb>, row: SectionRow) {
  const count = (sql.prepare('SELECT count(*) AS n FROM tasks WHERE section_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(row.id) as { n: number }).n;
  return {
    id: row.id, projectId: row.project_id, name: row.name, sortKey: row.sort_key,
    version: row.version, taskCount: count, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function projectForRead(sql: ReturnType<typeof rawDb>, ownerId: string, projectId: string) {
  return sql.prepare('SELECT id,space_id,archived_at,owner_user_id FROM projects WHERE id=? AND owner_user_id=?').get(projectId, ownerId) as { id: string; space_id: string; archived_at: string | null; owner_user_id: string } | undefined;
}

function sectionName(value: unknown) {
  if (typeof value !== 'string') throw new MutationConflict('分组名称必须是文本', 'INVALID_INPUT', 400, { fieldErrors: { name: '必须是文本' } });
  const name = value.trim();
  if (!name) throw new MutationConflict('分组名称不能为空', 'INVALID_INPUT', 400, { fieldErrors: { name: '不能为空' } });
  if ([...name].length > 80) throw new MutationConflict('分组名称最多80个字符', 'INVALID_INPUT', 400, { fieldErrors: { name: '最多80个字符' } });
  return name;
}

function assertExpectedVersion(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
}

function loadProject(sql: ReturnType<typeof rawDb>, ownerId: string, projectId: string, expectedVersion?: number) {
  const project = projectForRead(sql, ownerId, projectId);
  if (!project) throw new MutationConflict('项目不存在', 'PROJECT_NOT_FOUND', 404);
  if (project.archived_at) throw new MutationConflict('已归档项目不可修改', 'PROJECT_ARCHIVED', 409);
  if (expectedVersion !== undefined) {
    assertExpectedVersion(expectedVersion);
    const version = (sql.prepare('SELECT version FROM projects WHERE id=?').get(projectId) as { version: number }).version;
    if (version !== expectedVersion) throw new MutationConflict('项目版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: version });
  }
  return project;
}

function nextSortKey(sql: ReturnType<typeof rawDb>, projectId: string) {
  const count = (sql.prepare('SELECT count(*) AS n FROM project_sections WHERE project_id=?').get(projectId) as { n: number }).n;
  return String((count + 1) * 1024).padStart(16, '0');
}

export function listProjectSections(database: AppDatabase, ownerId: string, projectId: string) {
  const sql = rawDb(database);
  const project = projectForRead(sql, ownerId, projectId);
  if (!project) return null;
  const rows = sql.prepare('SELECT id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at FROM project_sections WHERE project_id=? AND owner_user_id=? ORDER BY sort_key,id').all(projectId, ownerId) as SectionRow[];
  return { projectId, items: rows.map((row) => sectionPayload(sql, row)), ungroupedLabel: '未分组' };
}

export function createProjectSectionMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; projectId: string; name: unknown; expectedProjectVersion?: number }) {
  const sectionId = randomUUID();
  return runIdempotentMutation(database, input, (sql, now) => {
    const project = loadProject(sql, input.userId, input.projectId, input.expectedProjectVersion);
    const name = sectionName(input.name);
    const taken = sql.prepare('SELECT 1 FROM project_sections WHERE project_id=? AND name=?').get(project.id, name);
    if (taken) throw new MutationConflict('同一项目内已有同名分组', 'NAME_TAKEN', 409, { fieldErrors: { name: '同名分组已存在' } });
    sql.prepare('INSERT INTO project_sections(id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(sectionId, input.userId, project.id, name, nextSortKey(sql, project.id), now, now);
    sql.prepare('UPDATE projects SET version=version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, project.id, input.userId);
    const row = sql.prepare('SELECT id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at FROM project_sections WHERE id=?').get(sectionId) as SectionRow;
    return sectionPayload(sql, row);
  });
}

export function updateProjectSectionMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; projectId: string; sectionId: string; name: unknown; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    loadProject(sql, input.userId, input.projectId);
    assertExpectedVersion(input.expectedVersion);
    const current = sql.prepare('SELECT id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at FROM project_sections WHERE id=? AND project_id=? AND owner_user_id=?').get(input.sectionId, input.projectId, input.userId) as SectionRow | undefined;
    if (!current) throw new MutationConflict('分组不存在', 'SECTION_NOT_FOUND', 404);
    if (current.version !== input.expectedVersion) throw new MutationConflict('分组版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version });
    const name = sectionName(input.name);
    if (name !== current.name && sql.prepare('SELECT 1 FROM project_sections WHERE project_id=? AND name=? AND id<>?').get(input.projectId, name, current.id)) throw new MutationConflict('同一项目内已有同名分组', 'NAME_TAKEN', 409, { fieldErrors: { name: '同名分组已存在' } });
    sql.prepare('UPDATE project_sections SET name=?,version=version+1,updated_at=? WHERE id=? AND project_id=? AND owner_user_id=? AND version=?').run(name, now, current.id, input.projectId, input.userId, input.expectedVersion);
    sql.prepare('UPDATE projects SET version=version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, input.projectId, input.userId);
    const row = sql.prepare('SELECT id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at FROM project_sections WHERE id=?').get(current.id) as SectionRow;
    return sectionPayload(sql, row);
  });
}

export function reorderProjectSectionsMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; projectId: string; expectedProjectVersion: number; sectionIds: string[] }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    loadProject(sql, input.userId, input.projectId, input.expectedProjectVersion);
    if (!Array.isArray(input.sectionIds) || new Set(input.sectionIds).size !== input.sectionIds.length) throw new MutationConflict('分组顺序无效', 'INVALID_INPUT', 400, { fieldErrors: { sectionIds: '必须是不重复的UUID列表' } });
    const rows = sql.prepare('SELECT id FROM project_sections WHERE project_id=? AND owner_user_id=?').all(input.projectId, input.userId) as Array<{ id: string }>;
    const existing = new Set(rows.map((row) => row.id));
    if (existing.size !== input.sectionIds.length || input.sectionIds.some((id) => !existing.has(id))) throw new MutationConflict('分组顺序必须包含该项目的全部分组', 'INVALID_INPUT', 400, { fieldErrors: { sectionIds: '列表与项目分组不匹配' } });
    const update = sql.prepare('UPDATE project_sections SET sort_key=?,version=version+1,updated_at=? WHERE id=? AND project_id=? AND owner_user_id=?');
    input.sectionIds.forEach((id, index) => update.run(String((index + 1) * 1024).padStart(16, '0'), now, id, input.projectId, input.userId));
    sql.prepare('UPDATE projects SET version=version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, input.projectId, input.userId);
    const ordered = sql.prepare('SELECT id,owner_user_id,project_id,name,sort_key,version,created_at,updated_at FROM project_sections WHERE project_id=? AND owner_user_id=? ORDER BY sort_key,id').all(input.projectId, input.userId) as SectionRow[];
    return { projectId: input.projectId, items: ordered.map((row) => sectionPayload(sql, row)) };
  });
}

export function setTaskSectionMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; taskId: string; expectedVersion: number; sectionId: string | null }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    assertExpectedVersion(input.expectedVersion);
    const task = sql.prepare('SELECT t.id,t.title,t.project_id,t.parent_id,t.section_id,t.version,t.updated_at,t.archived_at,p.root_task_id AS project_root_task_id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL').get(input.taskId, input.userId) as { id: string; title: string; project_id: string | null; parent_id: string | null; section_id: string | null; version: number; updated_at: string; archived_at: string | null; project_root_task_id: string | null } | undefined;
    if (!task) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    if (task.archived_at) throw new MutationConflict('已归档事项不可修改', 'TASK_ARCHIVED', 409);
    if (task.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: task.version });
    if (!task.project_id || task.parent_id === null || task.parent_id !== task.project_root_task_id) {
      if (input.sectionId !== null) throw new MutationConflict('只有项目根的直接子项可以加入分组', 'SECTION_NOT_APPLICABLE', 409);
      if (task.section_id === null) return { id: task.id, sectionId: null, version: task.version, updatedAt: task.updated_at, changed: false };
    }
    if (input.sectionId !== null) {
      const section = sql.prepare('SELECT id FROM project_sections WHERE id=? AND project_id=? AND owner_user_id=?').get(input.sectionId, task.project_id, input.userId);
      if (!section) throw new MutationConflict('分组不存在或不属于当前项目', 'SECTION_NOT_FOUND', 404);
    }
    const updated = sql.prepare('UPDATE tasks SET section_id=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(input.sectionId, now, task.id, input.userId, input.expectedVersion);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409);
    if (task.project_id) sql.prepare('UPDATE projects SET version=version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, task.project_id, input.userId);
    const changes = { sectionId: { from: task.section_id, to: input.sectionId } };
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, task.id, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, changes, version: input.expectedVersion + 1 }), now, input.requestId);
    return { id: task.id, sectionId: input.sectionId, version: input.expectedVersion + 1, updatedAt: now, changed: true };
  });
}
