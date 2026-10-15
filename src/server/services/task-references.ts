import { randomUUID } from 'node:crypto';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';
import { runIdempotentMutation } from './mutations';

type ReferenceRow = {
  id: string; owner_user_id: string; source_task_id: string; target_task_id: string;
  sort_key: string; version: number; removed_at: string | null; created_at: string; updated_at: string;
};

function taskExists(sql: ReturnType<typeof rawDb>, ownerId: string, taskId: string, allowDeleted = false) {
  const row = sql.prepare(`SELECT id,title,status,space_id,archived_at,deleted_at,version,structure_version
    FROM tasks WHERE id=? AND owner_user_id=?${allowDeleted ? '' : ' AND deleted_at IS NULL'}`).get(taskId, ownerId) as {
      id: string; title: string; status: string; space_id: string; archived_at: string | null; deleted_at: string | null; version: number; structure_version: number;
    } | undefined;
  return row;
}

function compactTask(sql: ReturnType<typeof rawDb>, ownerId: string, taskId: string) {
  const row = sql.prepare(`SELECT t.id,t.title,t.status,t.space_id,s.name AS space_name,t.archived_at,t.deleted_at,
      p.id AS project_id,p.name AS project_name
    FROM tasks t INNER JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND t.owner_user_id=?`).get(taskId, ownerId) as Record<string, unknown> | undefined;
  if (!row) return { id: taskId, title: '事项已删除', status: 'deleted', spaceId: null, spaceName: null, projectId: null, projectName: null, archived: false, deleted: true };
  return {
    id: row.id as string, title: row.deleted_at ? '事项已删除' : row.title as string, status: row.deleted_at ? 'deleted' : row.status as string,
    spaceId: row.space_id as string, spaceName: row.space_name as string, projectId: (row.project_id as string | null) ?? null,
    projectName: (row.project_name as string | null) ?? null, archived: Boolean(row.archived_at), deleted: Boolean(row.deleted_at),
  };
}

function referencePayload(sql: ReturnType<typeof rawDb>, ownerId: string, row: ReferenceRow, side: 'outgoing' | 'incoming') {
  const taskId = side === 'outgoing' ? row.target_task_id : row.source_task_id;
  return {
    id: row.id, version: row.version, sortKey: row.sort_key, sourceTaskId: row.source_task_id, targetTaskId: row.target_task_id,
    removedAt: row.removed_at, createdAt: row.created_at, updatedAt: row.updated_at, direction: side,
    task: compactTask(sql, ownerId, taskId),
  };
}

function loadReferenceOwnerTask(sql: ReturnType<typeof rawDb>, ownerId: string, taskId: string) {
  const task = taskExists(sql, ownerId, taskId);
  if (!task) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
  if (task.archived_at) throw new MutationConflict('归档事项不可修改引用', 'TASK_ARCHIVED', 409);
  return task;
}

export function listTaskReferences(database: AppDatabase, ownerId: string, taskId: string, side: 'outgoing' | 'incoming') {
  const sql = rawDb(database);
  if (!taskExists(sql, ownerId, taskId, true)) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
  const where = side === 'outgoing' ? 'r.source_task_id=?' : 'r.target_task_id=?';
  const rows = sql.prepare(`SELECT r.id,r.owner_user_id,r.source_task_id,r.target_task_id,r.sort_key,r.version,r.removed_at,r.created_at,r.updated_at
    FROM task_references r WHERE r.owner_user_id=? AND ${where} AND r.removed_at IS NULL ORDER BY r.sort_key,r.id`).all(ownerId, taskId) as ReferenceRow[];
  return { taskId, direction: side, items: rows.map((row) => referencePayload(sql, ownerId, row, side)) };
}

export function createTaskReferenceMutation(database: AppDatabase, input: {
  userId: string; requestId: string; method: string; resource: string; body: unknown;
  sourceTaskId: string; targetTaskId: string; expectedStructureVersion: number;
}) {
  const referenceId = randomUUID();
  return runIdempotentMutation(database, input, (sql, now) => {
    const source = loadReferenceOwnerTask(sql, input.userId, input.sourceTaskId);
    if (!Number.isInteger(input.expectedStructureVersion) || input.expectedStructureVersion < 1) throw new MutationConflict('expectedStructureVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedStructureVersion: '必须是正整数' } });
    if (source.structure_version !== input.expectedStructureVersion) throw new MutationConflict('事项结构已变化，请重新加载', 'STRUCTURE_VERSION_CONFLICT', 409, { current: { structureVersion: source.structure_version } });
    if (input.sourceTaskId === input.targetTaskId) throw new MutationConflict('事项不能引用自己', 'SELF_REFERENCE', 409);
    const target = taskExists(sql, input.userId, input.targetTaskId, true);
    if (!target) throw new MutationConflict('引用目标不存在', 'TARGET_NOT_FOUND', 404);
    if (target.deleted_at) throw new MutationConflict('已删除事项不能作为引用目标', 'TARGET_DELETED', 409);
    const existing = sql.prepare(`SELECT id,owner_user_id,source_task_id,target_task_id,sort_key,version,removed_at,created_at,updated_at
      FROM task_references WHERE owner_user_id=? AND source_task_id=? AND target_task_id=? AND removed_at IS NULL`).get(input.userId, input.sourceTaskId, input.targetTaskId) as ReferenceRow | undefined;
    if (existing) return { ...referencePayload(sql, input.userId, existing, 'outgoing'), changed: false };
    const count = (sql.prepare('SELECT count(*) AS n FROM task_references WHERE source_task_id=? AND removed_at IS NULL').get(input.sourceTaskId) as { n: number }).n;
    sql.prepare(`INSERT INTO task_references(id,owner_user_id,source_task_id,target_task_id,sort_key,version,removed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,1,NULL,?,?)`).run(referenceId, input.userId, input.sourceTaskId, input.targetTaskId, String((count + 1) * 1024).padStart(16, '0'), now, now);
    sql.prepare('UPDATE tasks SET structure_version=structure_version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, input.sourceTaskId, input.userId);
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, input.sourceTaskId, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, changes: { referenceAdded: { referenceId, targetTaskId: input.targetTaskId } }, structureVersion: input.expectedStructureVersion + 1 }), now, input.requestId);
    const row = sql.prepare('SELECT id,owner_user_id,source_task_id,target_task_id,sort_key,version,removed_at,created_at,updated_at FROM task_references WHERE id=?').get(referenceId) as ReferenceRow;
    return { ...referencePayload(sql, input.userId, row, 'outgoing'), changed: true, sourceStructureVersion: input.expectedStructureVersion + 1 };
  });
}

export function removeTaskReferenceMutation(database: AppDatabase, input: {
  userId: string; requestId: string; method: string; resource: string; body: unknown;
  referenceId: string; expectedVersion: number; expectedStructureVersion: number;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const row = sql.prepare(`SELECT id,owner_user_id,source_task_id,target_task_id,sort_key,version,removed_at,created_at,updated_at
      FROM task_references WHERE id=? AND owner_user_id=?`).get(input.referenceId, input.userId) as ReferenceRow | undefined;
    if (!row || row.removed_at) throw new MutationConflict('引用不存在', 'REFERENCE_NOT_FOUND', 404);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400);
    if (row.version !== input.expectedVersion) throw new MutationConflict('引用版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: row.version });
    const source = loadReferenceOwnerTask(sql, input.userId, row.source_task_id);
    if (!Number.isInteger(input.expectedStructureVersion) || input.expectedStructureVersion < 1) throw new MutationConflict('expectedStructureVersion无效', 'INVALID_VERSION', 400);
    if (source.structure_version !== input.expectedStructureVersion) throw new MutationConflict('事项结构已变化，请重新加载', 'STRUCTURE_VERSION_CONFLICT', 409, { current: { structureVersion: source.structure_version } });
    sql.prepare('UPDATE task_references SET removed_at=?,version=version+1,updated_at=? WHERE id=? AND owner_user_id=? AND version=? AND removed_at IS NULL').run(now, now, row.id, input.userId, input.expectedVersion);
    sql.prepare('UPDATE tasks SET structure_version=structure_version+1,updated_at=? WHERE id=? AND owner_user_id=?').run(now, row.source_task_id, input.userId);
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, row.source_task_id, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, changes: { referenceRemoved: { referenceId: row.id, targetTaskId: row.target_task_id } }, structureVersion: input.expectedStructureVersion + 1 }), now, input.requestId);
    return { id: row.id, sourceTaskId: row.source_task_id, targetTaskId: row.target_task_id, removedAt: now, version: input.expectedVersion + 1, sourceStructureVersion: input.expectedStructureVersion + 1, changed: true };
  });
}
