import { randomUUID } from 'node:crypto';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';
import { runIdempotentMutation } from './mutations';

type Input = {
  userId: string; requestId: string; method: string; resource: string; body: unknown;
  taskId: string; expectedVersion: number; expectedStructureVersion?: number;
};

type TaskRow = {
  id: string; owner_user_id: string; space_id: string; project_id: string | null; parent_id: string | null;
  section_id: string | null; sort_key: string; status: string; archived_at: string | null; deleted_at: string | null;
  version: number; structure_version: number; deletion_batch_id: string | null;
};

type BatchMember = {
  task_id: string; depth: number; old_parent_id: string | null; old_space_id: string;
  old_project_id: string | null;
};

function taskById(sql: ReturnType<typeof rawDb>, ownerId: string, taskId: string) {
  return sql.prepare(`SELECT id,owner_user_id,space_id,project_id,section_id,parent_id,sort_key,status,archived_at,deleted_at,version,structure_version,deletion_batch_id
    FROM tasks WHERE id=? AND owner_user_id=?`).get(taskId, ownerId) as TaskRow | undefined;
}

function snapshotBatch(sql: ReturnType<typeof rawDb>, input: { id: string; ownerId: string; rootTaskId: string; sourceParentId: string | null; sourceSpaceId: string; requestId: string; nodes: Array<TaskRow & { depth: number }> }, now: string) {
  sql.prepare(`INSERT INTO structure_batches(id,owner_user_id,operation,root_task_id,source_parent_id,target_parent_id,source_space_id,target_space_id,created_at,request_id,summary_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.ownerId, 'unarchive', input.rootTaskId, input.sourceParentId, null, input.sourceSpaceId, null, now, input.requestId, JSON.stringify({ memberCount: input.nodes.length }));
  const insert = sql.prepare(`INSERT INTO structure_batch_members(batch_id,task_id,depth,old_parent_id,old_space_id,old_project_id,old_sort_key,old_version,old_structure_version,old_archived_at,old_deleted_at,old_deletion_batch_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const node of input.nodes) insert.run(input.id, node.id, node.depth, node.parent_id, node.space_id, node.project_id, node.sort_key, node.version, node.structure_version, node.archived_at, node.deleted_at, node.deletion_batch_id);
}

/** 取消归档恢复整个归档批次，避免子树只恢复根事项而留下归档孤儿。 */
export function unarchiveTaskBatchMutation(database: AppDatabase, input: Input) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = taskById(sql, input.userId, input.taskId);
    if (!task || task.deleted_at) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    if (!task.archived_at) throw new MutationConflict('事项未归档', 'NOT_ARCHIVED', 409);
    if (task.version !== input.expectedVersion) throw new MutationConflict('事项内容版本已变化', 'VERSION_CONFLICT', 409, { currentVersion: task.version });
    if (input.expectedStructureVersion !== undefined && task.structure_version !== input.expectedStructureVersion) throw new MutationConflict('事项结构已变化', 'STRUCTURE_VERSION_CONFLICT', 409, { current: { structureVersion: task.structure_version } });
    const space = sql.prepare('SELECT archived_at FROM spaces WHERE id=? AND owner_user_id=?').get(task.space_id, input.userId) as { archived_at: string | null } | undefined;
    if (!space || space.archived_at) throw new MutationConflict('所属空间已归档，请先取消归档空间', 'SPACE_ARCHIVED', 409);
    if (task.parent_id) {
      const parent = taskById(sql, input.userId, task.parent_id);
      if (!parent || parent.deleted_at || parent.archived_at) throw new MutationConflict('原父事项不可用，不能取消归档', 'ANCESTOR_NOT_WRITABLE', 409);
    }

    const batch = sql.prepare(`SELECT b.id,b.root_task_id,b.source_parent_id,b.source_space_id
      FROM structure_batches b JOIN structure_batch_members m ON m.batch_id=b.id
      WHERE b.owner_user_id=? AND b.operation='archive' AND b.root_task_id=? AND m.task_id=?
      ORDER BY b.created_at DESC,b.id DESC LIMIT 1`).get(input.userId, task.id, task.id) as { id: string; root_task_id: string; source_parent_id: string | null; source_space_id: string } | undefined;
    const members: BatchMember[] = batch
      ? sql.prepare('SELECT task_id,depth,old_parent_id,old_space_id,old_project_id FROM structure_batch_members WHERE batch_id=? ORDER BY depth,task_id').all(batch.id) as BatchMember[]
      : [{ task_id: task.id, depth: 0, old_parent_id: task.parent_id, old_space_id: task.space_id, old_project_id: task.project_id }];
    if (!members.length) throw new MutationConflict('归档批次没有成员', 'ARCHIVE_BATCH_NOT_FOUND', 409);

    const nodes: Array<TaskRow & { depth: number }> = [];
    for (const member of members) {
      const row = taskById(sql, input.userId, member.task_id);
      if (!row || row.deleted_at || !row.archived_at || row.parent_id !== member.old_parent_id || row.space_id !== member.old_space_id || row.project_id !== member.old_project_id) {
        throw new MutationConflict('归档期间结构已变化，不能静默取消归档', 'STRUCTURE_RESTORE_CONFLICT', 409, { current: row });
      }
      nodes.push({ ...row, depth: member.depth });
    }

    const batchId = randomUUID();
    snapshotBatch(sql, { id: batchId, ownerId: input.userId, rootTaskId: task.id, sourceParentId: task.parent_id, sourceSpaceId: task.space_id, requestId: input.requestId, nodes }, now);
    for (const node of nodes) {
      sql.prepare('UPDATE tasks SET archived_at=NULL,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND archived_at IS NOT NULL').run(now, node.id, input.userId);
      sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, node.id, input.userId, 'task_unarchived', JSON.stringify({ schemaVersion: 1, changes: { archivedAt: { from: node.archived_at, to: null } }, structureBatchId: batchId }), now, input.requestId);
    }
    return { id: task.id, archivedAt: null, version: task.version + 1, batchId, unarchivedCount: nodes.length };
  });
}
