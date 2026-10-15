import { rawDb, type AppDatabase } from '@/server/db/client';
import { shanghaiToday } from '@/server/services/task-queries';

export const REVIEW_KINDS = ['unprocessed', 'waiting_without_followup', 'project_without_next_action', 'completed', 'cancelled'] as const;
export type ReviewKind = typeof REVIEW_KINDS[number];

type PathPart = { id: string; title: string };

function parseProgressText(value: unknown) {
  try {
    const payload = JSON.parse(String(value)) as Record<string, unknown>;
    return typeof payload.text === 'string' ? payload.text : '';
  } catch { return ''; }
}

function pathFromRows(rows: Array<Record<string, unknown>>, taskId: string): PathPart[] {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const result: PathPart[] = [];
  const seen = new Set<string>();
  let current = byId.get(taskId);
  while (current && !seen.has(String(current.id))) {
    const id = String(current.id);
    seen.add(id);
    result.unshift({ id, title: String(current.title) });
    const parentId = current.parent_id as string | null;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return result;
}

const BASE_COLUMNS = `t.id,t.title,t.status,t.is_processed,t.space_id,s.name AS space_name,t.project_id,t.parent_id,
  t.priority,t.planned_date,t.due_date,t.follow_up_date,t.handling_mode,t.counterpart_name,
  t.description_plain,t.next_action,t.result_note,t.waiting_reason,t.cancellation_reason,
  t.source_url,t.source_label,t.created_at,t.updated_at,t.completed_at,t.cancelled_at`;

function baseItem(row: Record<string, unknown>, path: PathPart[], matches: Array<Record<string, unknown>> = []) {
  return {
    id: String(row.id), title: String(row.title), status: String(row.status),
    isProcessed: Boolean(row.is_processed), spaceId: String(row.space_id), spaceName: String(row.space_name),
    projectId: (row.project_id as string | null) ?? null, parentId: (row.parent_id as string | null) ?? null,
    priority: String(row.priority), plannedDate: (row.planned_date as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null, followUpDate: (row.follow_up_date as string | null) ?? null,
    handlingMode: String(row.handling_mode), counterpartName: String(row.counterpart_name),
    nextAction: String(row.next_action), resultNote: String(row.result_note),
    waitingReason: String(row.waiting_reason), cancellationReason: String(row.cancellation_reason),
    source: { url: (row.source_url as string | null) ?? null, label: (row.source_label as string | null) ?? null },
    sourceUrl: (row.source_url as string | null) ?? null, sourceLabel: (row.source_label as string | null) ?? null,
    path, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string | null) ?? null, cancelledAt: (row.cancelled_at as string | null) ?? null,
    matches,
  };
}

function validatePage(limit: number, offset: number) {
  return { limit: Math.max(1, Math.min(100, Math.trunc(limit || 50))), offset: Math.max(0, Math.trunc(offset || 0)) };
}

function likePattern(value: string) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export function searchTasks(database: AppDatabase, ownerId: string, query: string, limit = 50, offset = 0) {
  const sql = rawDb(database);
  const page = validatePage(limit, offset);
  const q = query.trim();
  const pattern = likePattern(q);
  const where = `t.owner_user_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL AND (
    t.title LIKE ? ESCAPE '\\' OR t.description_plain LIKE ? ESCAPE '\\' OR t.counterpart_name LIKE ? ESCAPE '\\' OR
    EXISTS (SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.owner_user_id=t.owner_user_id AND e.type='task_progress_appended' AND json_extract(e.payload_json,'$.text') LIKE ? ESCAPE '\\') OR
    EXISTS (SELECT 1 FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.task_id=t.id AND l.owner_user_id=t.owner_user_id AND l.removed_at IS NULL AND a.status='ready' AND a.original_name LIKE ? ESCAPE '\\')
  )`;
  const args = [ownerId, pattern, pattern, pattern, pattern, pattern];
  const count = (sql.prepare(`SELECT count(*) AS total FROM tasks t WHERE ${where}`).get(...args) as { total: number }).total;
  const rows = sql.prepare(`WITH RECURSIVE visible AS (
      SELECT id,title,parent_id FROM tasks WHERE owner_user_id=? AND deleted_at IS NULL AND archived_at IS NULL
      UNION ALL SELECT t.id,t.title,t.parent_id FROM tasks t JOIN visible v ON t.id=v.parent_id WHERE t.owner_user_id=?
    ) SELECT ${BASE_COLUMNS} FROM tasks t JOIN spaces s ON s.id=t.space_id WHERE ${where}
    ORDER BY t.updated_at DESC,t.id ASC LIMIT ? OFFSET ?`).all(ownerId, ownerId, ...args, page.limit, page.offset) as Array<Record<string, unknown>>;
  const visibleRows = sql.prepare(`SELECT id,title,parent_id FROM tasks WHERE owner_user_id=? AND deleted_at IS NULL AND archived_at IS NULL`).all(ownerId) as Array<Record<string, unknown>>;
  const items = rows.map((row) => {
    const matches: Array<Record<string, unknown>> = [];
    if (String(row.title).includes(q)) matches.push({ type: 'title', text: row.title });
    if (String(row.description_plain).includes(q)) matches.push({ type: 'body', text: row.description_plain });
    if (String(row.counterpart_name).includes(q)) matches.push({ type: 'handler', text: row.counterpart_name });
    const progress = sql.prepare(`SELECT id,occurred_at,payload_json FROM task_events WHERE owner_user_id=? AND task_id=? AND type='task_progress_appended' AND json_extract(payload_json,'$.text') LIKE ? ESCAPE '\\' ORDER BY occurred_at DESC,id ASC`).all(ownerId, row.id, pattern) as Array<Record<string, unknown>>;
    for (const event of progress) matches.push({ type: 'progress', id: event.id, occurredAt: event.occurred_at, text: parseProgressText(event.payload_json) });
    const attachments = sql.prepare(`SELECT a.id,a.original_name FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.owner_user_id=? AND l.task_id=? AND l.removed_at IS NULL AND a.status='ready' AND a.original_name LIKE ? ESCAPE '\\' ORDER BY a.original_name,a.id`).all(ownerId, row.id, pattern) as Array<Record<string, unknown>>;
    for (const asset of attachments) matches.push({ type: 'attachment', id: asset.id, name: asset.original_name });
    return baseItem(row, pathFromRows(visibleRows, String(row.id)), matches);
  });
  return { query: q, total: count, limit: page.limit, offset: page.offset, items };
}

function reviewWhere(kind: ReviewKind) {
  const active = `t.status IN ('todo','in_progress','waiting')`;
  if (kind === 'unprocessed') return `${active} AND t.is_processed=0`;
  if (kind === 'waiting_without_followup') return `${active} AND t.status='waiting' AND t.follow_up_date IS NULL`;
  if (kind === 'project_without_next_action') return `${active} AND t.project_id IS NOT NULL AND trim(t.next_action)=''`;
  return kind === 'completed' ? `t.status='done'` : `t.status='cancelled'`;
}

export function reviewTasks(database: AppDatabase, ownerId: string, kind: ReviewKind, limit = 50, offset = 0) {
  const sql = rawDb(database); const page = validatePage(limit, offset);
  const lifecycle = `t.owner_user_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL AND ${reviewWhere(kind)}`;
  const total = (sql.prepare(`SELECT count(*) AS total FROM tasks t WHERE ${lifecycle}`).get(ownerId) as { total: number }).total;
  const rows = sql.prepare(`SELECT ${BASE_COLUMNS} FROM tasks t JOIN spaces s ON s.id=t.space_id WHERE ${lifecycle}
    ORDER BY CASE WHEN t.status='done' AND trim(t.result_note)<>'' THEN 0 WHEN t.status='cancelled' AND trim(t.cancellation_reason)<>'' THEN 0 ELSE 1 END,
    t.updated_at DESC,t.id ASC LIMIT ? OFFSET ?`).all(ownerId, page.limit, page.offset) as Array<Record<string, unknown>>;
  const visibleRows = sql.prepare(`SELECT id,title,parent_id FROM tasks WHERE owner_user_id=? AND deleted_at IS NULL AND archived_at IS NULL`).all(ownerId) as Array<Record<string, unknown>>;
  const today = shanghaiToday();
  return { kind, today, total, limit: page.limit, offset: page.offset, items: rows.map((row) => ({ ...baseItem(row, pathFromRows(visibleRows, String(row.id))), reviewKind: kind })) };
}
