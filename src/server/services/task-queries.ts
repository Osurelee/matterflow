import { rawDb, type AppDatabase } from '@/server/db/client';

/** PRD v0.6 10.3 视图口径；M3-05 只落地查询与排序，父子（叶子/待核实父）规则在 M5 加入。 */
export type TaskView = 'inbox' | 'all' | 'today' | 'overdue' | 'followup' | 'doing' | 'delegated' | 'waiting' | 'watched' | 'archived' | 'trash';
export const TASK_VIEWS: TaskView[] = ['inbox', 'all', 'today', 'overdue', 'followup', 'doing', 'delegated', 'waiting', 'watched', 'archived', 'trash'];
export const TASK_STATUS_VALUES = ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] as const;

/** 产品时区固定 Asia/Shanghai，日期为日精度（PRD 4.3 / 10.2）。 */
export function shanghaiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}

const PRIORITY_RANK = "CASE t.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
const EARLIEST_DATE = "MIN(COALESCE(t.planned_date,'9999-12-31'),COALESCE(t.due_date,'9999-12-31'),COALESCE(t.follow_up_date,'9999-12-31'))";

const TASK_COLUMNS = `t.id,t.title,t.status,t.is_processed,t.space_id,s.name AS space_name,s.structure_version AS space_structure_version,t.parent_id,t.structure_version,t.project_id,t.section_id,p.root_task_id AS project_root_task_id,t.priority,t.planned_date,t.due_date,t.follow_up_date,t.handling_mode,t.counterpart_name,t.archived_at,t.deleted_at,t.deletion_batch_id,t.created_at,t.updated_at,t.version`;

function viewFilter(view: TaskView, includeEnded: boolean) {
  const active = "t.status IN ('todo','in_progress','waiting')";
  const activeLeaf = `${active} AND NOT EXISTS (
    SELECT 1 FROM tasks child
    WHERE child.owner_user_id=t.owner_user_id AND child.parent_id=t.id
      AND child.deleted_at IS NULL AND child.archived_at IS NULL
      AND child.status IN ('todo','in_progress','waiting')
  )`;
  if (view === 'inbox') return `${activeLeaf} AND t.is_processed=0`;
  if (view === 'today') return `${activeLeaf} AND (t.planned_date<=? OR t.due_date<=? OR t.follow_up_date<=?)`;
  if (view === 'overdue') return `${activeLeaf} AND t.due_date<?`;
  if (view === 'followup') return `${activeLeaf} AND t.follow_up_date<=?`;
  if (view === 'doing') return `${activeLeaf} AND t.handling_mode='self'`;
  if (view === 'delegated') return `${activeLeaf} AND t.handling_mode='other'`;
  if (view === 'waiting') return `${activeLeaf} AND t.status='waiting'`;
  if (view === 'watched') return `${activeLeaf} AND t.is_watched=1`;
  if (view === 'archived' || view === 'trash') return '1=1';
  return includeEnded ? '1=1' : active;
}

function mapRow(row: Record<string, unknown>, today: string) {
  const due = row.due_date as string | null;
  const followUp = row.follow_up_date as string | null;
  const planned = row.planned_date as string | null;
  const active = row.status === 'todo' || row.status === 'in_progress' || row.status === 'waiting';
  return {
    id: row.id as string, title: row.title as string, status: row.status as string,
    isProcessed: Boolean(row.is_processed), spaceId: row.space_id as string, spaceName: row.space_name as string,
    projectId: (row.project_id as string | null) ?? null, sectionId:(row.section_id as string|null)??null, parentId:(row.parent_id as string|null)??null,structureVersion:(row.structure_version as number)??1,spaceStructureVersion:(row.space_structure_version as number)??1, projectRootTaskId:(row.project_root_task_id as string|null)??null,isProjectRoot:Boolean(row.project_root_task_id&&row.project_root_task_id===row.id), priority: row.priority as string,
    plannedDate: planned, dueDate: due, followUpDate: followUp,
    handlingMode: row.handling_mode as string, counterpartName: row.counterpart_name as string,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string, version: row.version as number,
    archivedAt: (row.archived_at as string | null) ?? null,
    deletedAt: (row.deleted_at as string | null) ?? null,
    deletionBatchId: (row.deletion_batch_id as string | null) ?? null,
    risk: {
      overdue: Boolean(active && due && due < today),
      followUpDue: Boolean(active && followUp && followUp <= today),
      plannedDue: Boolean(active && planned && planned <= today),
    },
  };
}

export type ListTaskOptions = { view: TaskView; spaceId?: string; projectId?: string; status?: string; includeEnded?: boolean; limit: number; offset: number };

export function listTasks(database: AppDatabase, ownerId: string, options: ListTaskOptions) {
  const sql = rawDb(database);
  const today = shanghaiToday();
  const lifecycleFilter = options.view === 'archived'
    ? `t.deleted_at IS NULL AND t.archived_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM structure_batches b
        WHERE b.owner_user_id=t.owner_user_id AND b.operation='archive' AND b.root_task_id=t.id
          AND EXISTS (SELECT 1 FROM structure_batch_members bm WHERE bm.batch_id=b.id AND bm.task_id=t.id)
      )`
    : options.view === 'trash'
      ? `t.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM structure_batches b
          WHERE b.owner_user_id=t.owner_user_id AND b.operation='delete' AND b.id=t.deletion_batch_id AND b.root_task_id=t.id
        )`
      : 't.deleted_at IS NULL AND t.archived_at IS NULL';
  const filters = ['t.owner_user_id=?', lifecycleFilter, viewFilter(options.view, Boolean(options.includeEnded))];
  const args: unknown[] = [ownerId];
  if (options.view === 'today') args.push(today, today, today);
  if (options.view === 'overdue' || options.view === 'followup') args.push(today);
  if (options.spaceId) { filters.push('t.space_id=?'); args.push(options.spaceId); }
  if (options.projectId) { filters.push('t.project_id=?'); args.push(options.projectId); }
  if (options.status) { filters.push('t.status=?'); args.push(options.status); }
  const where = filters.join(' AND ');
  const order = options.view === 'archived'
    ? 't.archived_at DESC, t.updated_at DESC, t.id ASC'
    : options.view === 'trash'
      ? 't.deleted_at DESC, t.updated_at DESC, t.id ASC'
      : options.view === 'inbox'
    ? 't.created_at DESC, t.id ASC'
    : `${PRIORITY_RANK} DESC, ${EARLIEST_DATE} ASC, t.created_at ASC, t.id ASC`;
  const items = sql.prepare(`SELECT ${TASK_COLUMNS} FROM tasks t INNER JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, options.limit, options.offset) as Array<Record<string, unknown>>;
  const total = (sql.prepare(`SELECT count(*) AS total FROM tasks t WHERE ${where}`).get(...args) as { total: number }).total;
  return {
    view: options.view, today, includeEnded: Boolean(options.includeEnded), total, limit: options.limit, offset: options.offset,
    items: items.map((row) => mapRow(row, today)),
  };
}

export function getTask(database: AppDatabase, ownerId: string, taskId: string) {
  const row = rawDb(database).prepare(`SELECT t.id,t.title,t.description,t.description_format,t.source_url,t.source_label,t.status,t.is_processed,t.space_id,s.name AS space_name,s.structure_version AS space_structure_version,t.parent_id,t.structure_version,t.project_id,t.section_id,p.name AS project_name,p.root_task_id AS project_root_task_id,t.priority,t.planned_date,t.due_date,t.follow_up_date,t.next_action,t.blocked_reason,t.result_note,t.waiting_reason,t.cancellation_reason,t.completed_at,t.cancelled_at,t.handling_mode,t.counterpart_name,t.created_at,t.updated_at,t.version
    FROM tasks t INNER JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL AND t.archived_at IS NULL`).get(taskId, ownerId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const today = shanghaiToday();
  return {
    ...mapRow(row, today),
    description: row.description as string,
    descriptionFormat: (row.description_format as string | null) ?? 'plaintext',
    sourceUrl:(row.source_url as string|null)??null,sourceLabel:(row.source_label as string|null)??null,
    projectName: (row.project_name as string | null) ?? null,
    nextAction: row.next_action as string, blockedReason: row.blocked_reason as string,
    resultNote: row.result_note as string,
    waitingReason: row.waiting_reason as string, cancellationReason: row.cancellation_reason as string,
    completedAt: (row.completed_at as string | null) ?? null, cancelledAt: (row.cancelled_at as string | null) ?? null,
  };
}

export type TaskEventRow = {
  id: string; type: string; actorUserId: string; occurredAt: string; requestId: string | null; payload: Record<string, unknown>;
};

/** Newest-first page of older events, returned in chronological order for display. */
export function listTaskEvents(database: AppDatabase, ownerId: string, taskId: string, limit: number, before?: string, beforeId?: string, includeDeleted = false) {
  const sql = rawDb(database);
  const exists = sql.prepare(`SELECT 1 FROM tasks WHERE id=? AND owner_user_id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(taskId, ownerId);
  if (!exists) return null;
  const args: unknown[] = [taskId, ownerId, limit + 1];
  let cursor = '';
  if (before) {
    cursor = ' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
    args.splice(2, 0, before, before, beforeId ?? '');
  }
  const rows = sql.prepare(`SELECT id,type,actor_user_id,occurred_at,request_id,payload_json FROM task_events WHERE task_id=? AND owner_user_id=?${cursor} ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(...args) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const progressIds=page.filter(row=>row.type==='task_progress_appended').map(row=>row.id as string);
  const mediaByEvent=new Map<string,Array<Record<string,unknown>>>();
  if(progressIds.length){
    const marks=progressIds.map(()=>'?').join(',');
    const media=sql.prepare(`SELECT l.id AS link_id,l.progress_event_id,l.removed_at,a.id,a.original_name,a.mime_type,a.byte_size,a.duration_ms FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.owner_user_id=? AND l.task_id=? AND l.role='progress' AND l.progress_event_id IN (${marks}) ORDER BY l.created_at,l.id`).all(ownerId,taskId,...progressIds) as Array<Record<string,unknown>>;
    for(const item of media){const eventId=String(item.progress_event_id);const list=mediaByEvent.get(eventId)??[];list.push({id:item.id,linkId:item.link_id,removedAt:item.removed_at,originalName:item.original_name,mimeType:item.mime_type,byteSize:item.byte_size,durationMs:item.duration_ms,contentUrl:`/api/assets/${item.id}/content`});mediaByEvent.set(eventId,list)}
  }
  return {
    items: page.map((row) => {
      const payload=JSON.parse(row.payload_json as string) as Record<string,unknown>;
      const attachments=mediaByEvent.get(row.id as string);
      return {id:row.id as string,type:row.type as string,actorUserId:row.actor_user_id as string,occurredAt:row.occurred_at as string,requestId:(row.request_id as string|null)??null,payload:attachments?{...payload,mediaAttachments:attachments}:payload};
    }) as TaskEventRow[],
    hasMore, limit,
  };
}

/**
 * M4-01/03 正文修订读取（技术设计 5.2、AT-31）：只读、游标分页、时间倒序取页后正序返回。
 * 修订是历史证据，读取本身不改变任何对象的 version。
 */
export function listTaskBodyRevisions(database: AppDatabase, ownerId: string, taskId: string, limit: number, before?: string, beforeId?: string) {
  const sql = rawDb(database);
  const exists = sql.prepare('SELECT 1 FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(taskId, ownerId);
  if (!exists) return null;
  const args: unknown[] = [taskId, ownerId, limit + 1];
  let cursor = '';
  if (before) {
    cursor = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    args.splice(2, 0, before, before, beforeId ?? '');
  }
  const rows = sql.prepare(`SELECT id,format,content,task_version,request_id,created_at FROM task_body_revisions WHERE task_id=? AND owner_user_id=?${cursor} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...args) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((row) => ({
      id: row.id as string, format: row.format as string, content: row.content as string,
      taskVersion: row.task_version as number, requestId: (row.request_id as string | null) ?? null,
      createdAt: row.created_at as string,
    })),
    hasMore, limit,
  };
}
