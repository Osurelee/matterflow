import { randomUUID } from 'node:crypto';
import { codePointLength, prepareBody } from '@/domain/body';
import {
  CHECKLIST_MAX_ITEMS,
  checklistCounts,
  moveId,
  normalizeSortKeys,
  staticChecklistLines,
  stripStaticChecklistLines,
  validateChecklistText,
  type ChecklistItemDto,
} from '@/domain/checklist';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';
import { runIdempotentMutation } from './mutations';
import { assertWritablePath } from './structure-guards';

/**
 * M4-04 结构化小步骤服务（PRD 9.3/9.4、FR-22、技术设计 3.2、AT-37）。
 *
 * - 小步骤与正文、状态、安排完全分开：勾选不改变父事项状态，也不进入任务视图与计数。
 * - 每次写入都校验父事项版本（聚合级并发）与条目版本；事件只保存摘要。
 * - 「转为小步骤」在一个事务内完成：建条目 + 清理正文静态复选框行 + 正文修订 + 摘要事件。
 */

type TaskRow = {
  id: string; version: number; status: string; archived_at: string | null;
  description: string; description_format: string;
  space_archived_at: string | null; project_archived_at: string | null;
};

type ItemRow = {
  id: string; text: string; is_checked: number; sort_key: string; version: number;
  promoted_task_id: string | null; created_at: string; updated_at: string;
};

const TASK_SELECT = `SELECT t.id,t.version,t.status,t.archived_at,t.description,t.description_format,
    s.archived_at AS space_archived_at,p.archived_at AS project_archived_at
  FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
  WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL`;

function loadTask(sql: ReturnType<typeof rawDb>, userId: string, taskId: string): TaskRow {
  const task = sql.prepare(TASK_SELECT).get(taskId, userId) as TaskRow | undefined;
  if (!task) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
  return task;
}

function assertWritable(task: TaskRow) {
  if (task.archived_at) throw new MutationConflict('已归档事项不可修改', 'TASK_ARCHIVED', 409);
  if (task.space_archived_at || task.project_archived_at) throw new MutationConflict('所属空间或项目已归档，不可修改', 'CONTAINER_ARCHIVED', 409);
}

function assertTaskVersion(task: TaskRow, expectedVersion: unknown) {
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
  if (task.version !== expectedVersion) {
    throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, {
      currentVersion: task.version,
      current: { id: task.id, version: task.version, status: task.status },
    });
  }
}

function loadItems(sql: ReturnType<typeof rawDb>, userId: string, taskId: string): ItemRow[] {
  return sql.prepare('SELECT id,text,is_checked,sort_key,version,promoted_task_id,created_at,updated_at FROM checklist_items WHERE task_id=? AND owner_user_id=? ORDER BY sort_key ASC, id ASC')
    .all(taskId, userId) as ItemRow[];
}

function toDto(row: ItemRow): ChecklistItemDto {
  return {
    id: row.id, text: row.text, isChecked: row.is_checked === 1, sortKey: row.sort_key,
    version: row.version, promotedTaskId: row.promoted_task_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function payloadOf(userId: string, taskId: string, requestId: string, now: string, checklist: Record<string, unknown>) {
  return { userId, taskId, requestId, now, json: JSON.stringify({ schemaVersion: 1, checklist }) };
}

function appendEvent(sql: ReturnType<typeof rawDb>, event: ReturnType<typeof payloadOf>) {
  sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(randomUUID(), event.userId, event.taskId, event.userId, 'task_updated', event.json, event.now, event.requestId);
}

/** 重排：按给定顺序重算定宽排序键（≤100 条，整表重算比分数索引更好推理）。 */
function reindex(sql: ReturnType<typeof rawDb>, userId: string, taskId: string, orderedIds: string[], now: string) {
  const keys = normalizeSortKeys(orderedIds.length);
  orderedIds.forEach((id, index) => {
    sql.prepare('UPDATE checklist_items SET sort_key=?,updated_at=? WHERE id=? AND task_id=? AND owner_user_id=? AND sort_key<>?')
      .run(keys[index], now, id, taskId, userId, keys[index]);
  });
}

function responseOf(sql: ReturnType<typeof rawDb>, userId: string, taskId: string, extra: Record<string, unknown> = {}) {
  const rows = loadItems(sql, userId, taskId);
  return { id: taskId, items: rows.map(toDto), counts: checklistCounts(rows.map((row) => ({ isChecked: row.is_checked === 1 }))), ...extra };
}

/** 读取清单：归档事项仍可读（只追加的历史与清单不是写保护对象）。 */
export function listChecklist(database: AppDatabase, ownerId: string, taskId: string) {
  const sql = rawDb(database);
  const exists = sql.prepare('SELECT 1 FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(taskId, ownerId);
  if (!exists) return null;
  return responseOf(sql, ownerId, taskId);
}

export function createChecklistItemMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; taskId: string; expectedVersion: number; text: unknown }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadTask(sql, input.userId, input.taskId);
    assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    const validated = validateChecklistText(input.text);
    if (!validated.ok) throw new MutationConflict('小步骤文本无效', 'INVALID_INPUT', 400, { fieldErrors: { text: validated.reason === 'TOO_LONG' ? '每条最多500个字符' : '不能为空' } });
    const existing = loadItems(sql, input.userId, input.taskId);
    if (existing.length >= CHECKLIST_MAX_ITEMS) throw new MutationConflict(`每个事项最多${CHECKLIST_MAX_ITEMS}条小步骤`, 'CHECKLIST_LIMIT', 409);
    const id = randomUUID();
    sql.prepare('INSERT INTO checklist_items(id,owner_user_id,task_id,text,is_checked,sort_key,promoted_task_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.userId, input.taskId, validated.text, 0, normalizeSortKeys(existing.length + 1)[existing.length], null, 1, now, now);
    const counts = checklistCounts(loadItems(sql, input.userId, input.taskId).map((entry) => ({ isChecked: entry.is_checked === 1 })));
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: 'created', itemId: id, textLength: codePointLength(validated.text), total: counts.total, checked: counts.checked }));
    return responseOf(sql, input.userId, input.taskId, { changed: true, itemId: id });
  });
}

export function updateChecklistItemMutation(database: AppDatabase, input: {
  userId: string; requestId: string; method: string; resource: string; body: unknown;
  taskId: string; itemId: string; expectedVersion: number; itemVersion: number;
  text?: unknown; isChecked?: unknown;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadTask(sql, input.userId, input.taskId);
    assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    const row = sql.prepare('SELECT id,text,is_checked,sort_key,version,promoted_task_id,created_at,updated_at FROM checklist_items WHERE id=? AND task_id=? AND owner_user_id=?').get(input.itemId, input.taskId, input.userId) as ItemRow | undefined;
    if (!row) throw new MutationConflict('小步骤不存在', 'CHECKLIST_ITEM_NOT_FOUND', 404);
    if (row.version !== input.itemVersion) throw new MutationConflict('小步骤版本已变化，请重新加载', 'ITEM_VERSION_CONFLICT', 409, { currentVersion: row.version, current: { id: row.id, text: row.text, isChecked: row.is_checked === 1, version: row.version } });

    const fieldErrors: Record<string, string> = {};
    let text = row.text;
    if (input.text !== undefined) {
      const validated = validateChecklistText(input.text);
      if (!validated.ok) fieldErrors.text = validated.reason === 'TOO_LONG' ? '每条最多500个字符' : '不能为空';
      else text = validated.text;
    }
    let isChecked = row.is_checked === 1;
    if (input.isChecked !== undefined) {
      if (typeof input.isChecked !== 'boolean') fieldErrors.isChecked = '必须是布尔值';
      else isChecked = input.isChecked;
    }
    if (Object.keys(fieldErrors).length) throw new MutationConflict('小步骤字段无效', 'INVALID_INPUT', 400, { fieldErrors });
    if (text === row.text && isChecked === (row.is_checked === 1)) return responseOf(sql, input.userId, input.taskId, { changed: false, itemId: row.id });

    const updated = sql.prepare('UPDATE checklist_items SET text=?,is_checked=?,updated_at=?,version=version+1 WHERE id=? AND task_id=? AND owner_user_id=? AND version=?')
      .run(text, isChecked ? 1 : 0, now, row.id, input.taskId, input.userId, input.itemVersion);
    if (updated.changes !== 1) throw new MutationConflict('小步骤版本已变化，请重新加载', 'ITEM_VERSION_CONFLICT', 409);
    const counts = checklistCounts(loadItems(sql, input.userId, input.taskId).map((entry) => ({ isChecked: entry.is_checked === 1 })));
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: 'updated', itemId: row.id, textLength: codePointLength(text), checked: isChecked, total: counts.total, checkedTotal: counts.checked }));
    return responseOf(sql, input.userId, input.taskId, { changed: true, itemId: row.id });
  });
}

export function removeChecklistItemMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; taskId: string; itemId: string; expectedVersion: number; itemVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadTask(sql, input.userId, input.taskId);
    assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    const row = sql.prepare('SELECT id,text,is_checked,sort_key,version,promoted_task_id,created_at,updated_at FROM checklist_items WHERE id=? AND task_id=? AND owner_user_id=?').get(input.itemId, input.taskId, input.userId) as ItemRow | undefined;
    if (!row) throw new MutationConflict('小步骤不存在', 'CHECKLIST_ITEM_NOT_FOUND', 404);
    if (row.version !== input.itemVersion) throw new MutationConflict('小步骤版本已变化，请重新加载', 'ITEM_VERSION_CONFLICT', 409, { currentVersion: row.version });
    sql.prepare('DELETE FROM checklist_items WHERE id=? AND task_id=? AND owner_user_id=?').run(row.id, input.taskId, input.userId);
    reindex(sql, input.userId, input.taskId, loadItems(sql, input.userId, input.taskId).map((entry) => entry.id), now);
    const counts = checklistCounts(loadItems(sql, input.userId, input.taskId).map((entry) => ({ isChecked: entry.is_checked === 1 })));
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: 'removed', itemId: row.id, textLength: codePointLength(row.text), total: counts.total, checked: counts.checked }));
    return responseOf(sql, input.userId, input.taskId, { changed: true, itemId: row.id });
  });
}

export function moveChecklistItemMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; taskId: string; itemId: string; expectedVersion: number; itemVersion: number; direction: string }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadTask(sql, input.userId, input.taskId);
    assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    if (input.direction !== 'up' && input.direction !== 'down') throw new MutationConflict('移动方向无效', 'INVALID_INPUT', 400, { fieldErrors: { direction: '只支持 up 或 down' } });
    const rows = loadItems(sql, input.userId, input.taskId);
    const row = rows.find((entry) => entry.id === input.itemId);
    if (!row) throw new MutationConflict('小步骤不存在', 'CHECKLIST_ITEM_NOT_FOUND', 404);
    if (row.version !== input.itemVersion) throw new MutationConflict('小步骤版本已变化，请重新加载', 'ITEM_VERSION_CONFLICT', 409, { currentVersion: row.version });
    const next = moveId(rows.map((entry) => entry.id), row.id, input.direction as 'up' | 'down');
    const moved = next.indexOf(row.id) !== rows.findIndex((entry) => entry.id === row.id);
    if (moved) reindex(sql, input.userId, input.taskId, next, now);
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: moved ? 'moved' : 'move-noop', itemId: row.id, direction: input.direction, index: next.indexOf(row.id) }));
    return responseOf(sql, input.userId, input.taskId, { changed: moved, itemId: row.id });
  });
}

/**
 * 「转为小步骤」（PRD 7.1）：把正文里的静态 `- [ ]` / `- [x]` 行变成结构化条目，
 * 并从正文移除这些行；同一事务内写事件与正文修订，失败即整体回滚，不丢文字。
 */
export function importChecklistFromBodyMutation(database: AppDatabase, input: { userId: string; requestId: string; method: string; resource: string; body: unknown; taskId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadTask(sql, input.userId, input.taskId);
    assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    const lines = staticChecklistLines(task.description);
    const existing = loadItems(sql, input.userId, input.taskId);
    const room = CHECKLIST_MAX_ITEMS - existing.length;
    const imported = lines.slice(0, Math.max(0, room));
    const importedLines = imported.map((entry) => entry.line);
    if (imported.length === 0) {
      return responseOf(sql, input.userId, input.taskId, { changed: false, imported: 0, removedLines: 0, version: task.version, skipped: lines.length });
    }
    const keys = normalizeSortKeys(existing.length + imported.length);
    imported.forEach((entry, index) => {
      sql.prepare('INSERT INTO checklist_items(id,owner_user_id,task_id,text,is_checked,sort_key,promoted_task_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), input.userId, input.taskId, entry.text, entry.checked ? 1 : 0, keys[existing.length + index], null, 1, now, now);
    });
    // 正文只移除已成功转成条目的行；未导入的（超限）保持静态文本
    const nextDescription = stripStaticChecklistLines(task.description, importedLines);
    const prepared = prepareBody({ description: nextDescription, format: task.description_format === 'markdown_v1' ? 'markdown_v1' : 'plaintext' });
    const version = task.version + 1;
    const updated = sql.prepare('UPDATE tasks SET description=?,description_plain=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?')
      .run(prepared.description, prepared.descriptionPlain, now, task.id, input.userId, task.version);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: task.version });
    const revisionId = randomUUID();
    sql.prepare('INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(revisionId, input.userId, input.taskId, prepared.descriptionFormat, prepared.description, prepared.descriptionPlain, version, input.requestId, now);
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: 'imported', imported: imported.length, removedLines: importedLines.length, revisionId, total: existing.length + imported.length }));
    return responseOf(sql, input.userId, input.taskId, {
      changed: true, imported: imported.length, removedLines: importedLines.length, skipped: lines.length - imported.length,
      version, description: prepared.description, descriptionFormat: prepared.descriptionFormat, revisionId,
    });
  });
}

/** 未勾完完成事项的确认文案由 domain 层生成；服务端不做拒绝，只提供计数给界面。 */
export function checklistSummaryForTask(database: AppDatabase, ownerId: string, taskId: string) {
  const sql = rawDb(database);
  const rows = loadItems(sql, ownerId, taskId);
  return checklistCounts(rows.map((row) => ({ isChecked: row.is_checked === 1 })));
}

type PromotionTask = TaskRow & { space_id: string; project_id: string | null; parent_id: string | null; structure_version: number };

function loadPromotionTask(sql: ReturnType<typeof rawDb>, userId: string, taskId: string): PromotionTask {
  const row = sql.prepare(`SELECT t.id,t.version,t.status,t.archived_at,t.description,t.description_format,
      t.space_id,t.project_id,t.parent_id,t.structure_version,s.archived_at AS space_archived_at,
      p.archived_at AS project_archived_at
    FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL`).get(taskId, userId) as PromotionTask | undefined;
  if (!row) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
  return row;
}

function promotionItems(sql: ReturnType<typeof rawDb>, userId: string, taskId: string) {
  return loadItems(sql, userId, taskId).map((item) => ({
    id: item.id, text: item.text, isChecked: item.is_checked === 1, version: item.version,
    promotedTaskId: item.promoted_task_id,
  }));
}

/** M5-06：只读预览，确认时仍会在同一事务内重新校验全部条目。 */
export function previewChecklistPromotion(database: AppDatabase, ownerId: string, taskId: string) {
  const sql = rawDb(database); const task = loadPromotionTask(sql, ownerId, taskId);
  const items = promotionItems(sql, ownerId, taskId);
  return {
    taskId, expectedVersion: task.version, expectedStructureVersion: task.structure_version,
    items, pendingCount: items.filter((item) => !item.promotedTaskId).length,
    alreadyPromotedCount: items.filter((item) => Boolean(item.promotedTaskId)).length,
  };
}

/**
 * M5-06：将当前事项的未提升小步骤原子创建为直接主子项。
 * 已提升条目只读关联，不重复创建；勾选状态映射为 done/todo。
 */
export function promoteChecklistMutation(database: AppDatabase, input: {
  userId: string; requestId: string; method: string; resource: string; body: unknown;
  taskId: string; expectedVersion: number; expectedStructureVersion: number;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    const task = loadPromotionTask(sql, input.userId, input.taskId); assertWritable(task);
    assertTaskVersion(task, input.expectedVersion);
    if (!Number.isInteger(input.expectedStructureVersion) || input.expectedStructureVersion < 1) throw new MutationConflict('expectedStructureVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedStructureVersion: '必须是正整数' } });
    if (task.structure_version !== input.expectedStructureVersion) throw new MutationConflict('事项结构已变化，请重新加载', 'STRUCTURE_VERSION_CONFLICT', 409, { current: { structureVersion: task.structure_version } });
    if (task.status === 'done' || task.status === 'cancelled') throw new MutationConflict('已结束事项不能提升小步骤，请先重开', 'TASK_ENDED', 409);
    assertWritablePath(sql, input.userId, task.id, '目标');
    const rows = loadItems(sql, input.userId, input.taskId);
    const pending = rows.filter((item) => !item.promoted_task_id);
    if (!pending.length) return { taskId: task.id, changed: false, items: promotionItems(sql, input.userId, task.id), structureVersion: task.structure_version };
    const childCount = (sql.prepare('SELECT count(*) AS n FROM tasks WHERE parent_id=? AND owner_user_id=?').get(task.id, input.userId) as { n: number }).n;
    const create = sql.prepare(`INSERT INTO tasks(
      id,owner_user_id,space_id,project_id,parent_id,sort_key,title,description,description_plain,description_format,
      status,is_processed,created_at,updated_at,completed_at,version,structure_version
    ) VALUES(?,?,?,?,?,?,?,?,?,'plaintext',?,?,?, ?,?,1,1)`);
    const childRows: Array<{ itemId: string; taskId: string; title: string; status: string }> = [];
    pending.forEach((item, index) => {
      const childId = randomUUID(); const status = item.is_checked ? 'done' : 'todo'; const completedAt = item.is_checked ? now : null;
      const prepared = prepareBody({ description: '', format: 'plaintext' });
      create.run(childId, input.userId, task.space_id, task.project_id, task.id, String((childCount + index + 1) * 1024).padStart(16, '0'), item.text, prepared.description, prepared.descriptionPlain, status, 1, now, now, completedAt);
      sql.prepare('UPDATE checklist_items SET promoted_task_id=?,version=version+1,updated_at=? WHERE id=? AND task_id=? AND owner_user_id=? AND promoted_task_id IS NULL').run(childId, now, item.id, task.id, input.userId);
      sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, childId, input.userId, 'task_created', JSON.stringify({ schemaVersion: 1, changes: { title: { from: null, to: item.text }, parentId: { from: null, to: task.id }, status: { from: null, to: status } }, promotedFromChecklistItemId: item.id }), now, input.requestId);
      childRows.push({ itemId: item.id, taskId: childId, title: item.text, status });
    });
    sql.prepare('UPDATE tasks SET structure_version=structure_version+1 WHERE id=? AND owner_user_id=?').run(task.id, input.userId);
    let ancestor = task.parent_id;
    while (ancestor) {
      sql.prepare('UPDATE tasks SET structure_version=structure_version+1 WHERE id=? AND owner_user_id=?').run(ancestor, input.userId);
      ancestor = (sql.prepare('SELECT parent_id FROM tasks WHERE id=? AND owner_user_id=?').get(ancestor, input.userId) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
    appendEvent(sql, payloadOf(input.userId, input.taskId, input.requestId, now, { action: 'promoted', count: childRows.length, itemIds: childRows.map((row) => row.itemId), taskIds: childRows.map((row) => row.taskId), structureVersion: input.expectedStructureVersion + 1 }));
    return { taskId: task.id, changed: true, created: childRows, items: promotionItems(sql, input.userId, task.id), structureVersion: input.expectedStructureVersion + 1 };
  });
}

