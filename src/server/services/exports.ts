import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { TASK_VIEWS, TASK_STATUS_VALUES, type TaskView, shanghaiToday } from '@/server/services/task-queries';
import { MutationConflict } from '@/server/services/errors';

const MEDIA_ROOT = process.env.TASKS_MEDIA_DIR || path.join(process.env.TASKS_DATA_DIR || path.join(homedir(), 'tasks', 'data'), 'media');
const APP_VERSION = '0.1.0';
const EXCLUDED = ['users.password_hash', 'sessions', 'auth_rate_limits', 'mutation_requests', 'local drafts', 'upload staging'];

export type ExportFilters = { view: TaskView; spaceId?: string; projectId?: string; status?: string; query?: string; includeEnded: boolean };
export type ExportSnapshot = {
  schemaVersion: string;
  generatedAt: string;
  format: 'json' | 'bundle';
  scope: { kind: 'all' | 'filtered'; filters?: ExportFilters; taskIds: string[] };
  exclusions: string[];
  entities: Record<string, unknown[]>;
};

function camel(value: string) { return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()); }
function mapRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value])));
}
function ids(values: string[]) { return values.length ? values.map(() => '?').join(',') : "''"; }

function taskWhere(filters: ExportFilters) {
  const active = "t.status IN ('todo','in_progress','waiting')";
  const activeLeaf = `${active} AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.owner_user_id=t.owner_user_id AND child.parent_id=t.id AND child.deleted_at IS NULL AND child.archived_at IS NULL AND child.status IN ('todo','in_progress','waiting'))`;
  let view = '1=1';
  if (filters.view === 'inbox') view = `${activeLeaf} AND t.is_processed=0`;
  else if (filters.view === 'today') view = `${activeLeaf} AND (t.planned_date<=? OR t.due_date<=? OR t.follow_up_date<=?)`;
  else if (filters.view === 'overdue') view = `${activeLeaf} AND t.due_date<?`;
  else if (filters.view === 'followup') view = `${activeLeaf} AND t.follow_up_date<=?`;
  else if (filters.view === 'doing') view = `${activeLeaf} AND t.handling_mode='self'`;
  else if (filters.view === 'delegated') view = `${activeLeaf} AND t.handling_mode='other'`;
  else if (filters.view === 'waiting') view = `${activeLeaf} AND t.status='waiting'`;
  else if (filters.view === 'watched') view = `${activeLeaf} AND t.is_watched=1`;
  else if (filters.view !== 'archived' && filters.view !== 'trash' && !filters.includeEnded) view = active;
  const life = filters.view === 'archived'
    ? `t.deleted_at IS NULL AND t.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM structure_batches b WHERE b.owner_user_id=t.owner_user_id AND b.operation='archive' AND b.root_task_id=t.id AND EXISTS (SELECT 1 FROM structure_batch_members bm WHERE bm.batch_id=b.id AND bm.task_id=t.id))`
    : filters.view === 'trash'
      ? `t.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM structure_batches b WHERE b.owner_user_id=t.owner_user_id AND b.operation='delete' AND b.id=t.deletion_batch_id AND b.root_task_id=t.id)`
      : 't.deleted_at IS NULL AND t.archived_at IS NULL';
  const query = filters.query?.trim();
  const pattern = query ? `%${query}%` : '';
  const search = query ? ` AND (t.title LIKE ? OR t.description_plain LIKE ? OR t.counterpart_name LIKE ? OR EXISTS (SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.owner_user_id=t.owner_user_id AND e.type='task_progress_appended' AND json_extract(e.payload_json,'$.text') LIKE ?) OR EXISTS (SELECT 1 FROM task_asset_links l JOIN assets a ON a.id=l.asset_id WHERE l.task_id=t.id AND l.owner_user_id=t.owner_user_id AND l.removed_at IS NULL AND a.status='ready' AND a.original_name LIKE ?))` : '';
  const today = shanghaiToday();
  const dateArgs = filters.view === 'today' ? [today, today, today] : filters.view === 'overdue' || filters.view === 'followup' ? [today] : [];
  return { sql: `t.owner_user_id=? AND ${life} AND ${view}${search}${filters.spaceId ? ' AND t.space_id=?' : ''}${filters.projectId ? ' AND t.project_id=?' : ''}${filters.status ? ' AND t.status=?' : ''}`, args: [...dateArgs, ...(query ? [pattern, pattern, pattern, pattern, pattern] : [])] };
}

function selectTaskIds(sql: ReturnType<typeof rawDb>, ownerId: string, filters: ExportFilters) {
  const built = taskWhere(filters); const args: unknown[] = [ownerId, ...built.args];
  if (filters.spaceId) args.push(filters.spaceId);
  if (filters.projectId) args.push(filters.projectId);
  if (filters.status) args.push(filters.status);
  return (sql.prepare(`SELECT t.id FROM tasks t WHERE ${built.sql} ORDER BY t.updated_at ASC,t.id ASC`).all(...args) as Array<{ id: string }>).map((row) => row.id);
}

function rowsFor(sql: ReturnType<typeof rawDb>, table: string, ownerId: string, taskIds?: string[]) {
  if (table === 'structure_batch_members') return sql.prepare(`SELECT bm.* FROM structure_batch_members bm JOIN structure_batches b ON b.id=bm.batch_id WHERE b.owner_user_id=? ${taskIds ? `AND bm.task_id IN (${ids(taskIds)})` : ''} ORDER BY bm.batch_id,bm.depth,bm.task_id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'capture_batch_items') return sql.prepare(`SELECT c.* FROM capture_batch_items c WHERE c.owner_user_id=? ${taskIds ? `AND c.task_id IN (${ids(taskIds)})` : ''} ORDER BY c.batch_id,c.sequence`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'task_asset_links') return sql.prepare(`SELECT l.* FROM task_asset_links l WHERE l.owner_user_id=? ${taskIds ? `AND l.task_id IN (${ids(taskIds)})` : ''} ORDER BY l.task_id,l.created_at,l.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'structure_batches') return sql.prepare(`SELECT b.* FROM structure_batches b WHERE b.owner_user_id=? ${taskIds ? `AND (b.root_task_id IN (${ids(taskIds)}) OR EXISTS (SELECT 1 FROM structure_batch_members bm WHERE bm.batch_id=b.id AND bm.task_id IN (${ids(taskIds)})))` : ''} ORDER BY b.created_at,b.id`).all(ownerId, ...(taskIds ?? []), ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'capture_batches') return sql.prepare(`SELECT b.* FROM capture_batches b WHERE b.owner_user_id=? ${taskIds ? `AND EXISTS (SELECT 1 FROM capture_batch_items i WHERE i.batch_id=b.id AND i.task_id IN (${ids(taskIds)}))` : ''} ORDER BY b.created_at,b.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'task_references') return sql.prepare(`SELECT r.* FROM task_references r WHERE r.owner_user_id=? ${taskIds ? `AND (r.source_task_id IN (${ids(taskIds)}) OR r.target_task_id IN (${ids(taskIds)}))` : ''} ORDER BY r.created_at,r.id`).all(ownerId, ...(taskIds ?? []), ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'task_events') return sql.prepare(`SELECT x.* FROM task_events x WHERE x.owner_user_id=? ${taskIds ? `AND x.task_id IN (${ids(taskIds)})` : ''} ORDER BY x.task_id,x.occurred_at,x.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'delegations') return sql.prepare(`SELECT x.* FROM delegations x WHERE x.owner_user_id=? ${taskIds ? `AND x.task_id IN (${ids(taskIds)})` : ''} ORDER BY x.task_id,x.started_at,x.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'task_body_revisions') return sql.prepare(`SELECT x.* FROM task_body_revisions x WHERE x.owner_user_id=? ${taskIds ? `AND x.task_id IN (${ids(taskIds)})` : ''} ORDER BY x.task_id,x.created_at,x.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'checklist_items') return sql.prepare(`SELECT x.* FROM checklist_items x WHERE x.owner_user_id=? ${taskIds ? `AND x.task_id IN (${ids(taskIds)})` : ''} ORDER BY x.task_id,x.sort_key,x.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'assets') return sql.prepare(`SELECT a.* FROM assets a WHERE a.owner_user_id=? ${taskIds ? `AND EXISTS (SELECT 1 FROM task_asset_links l WHERE l.asset_id=a.id AND l.task_id IN (${ids(taskIds)}))` : ''} ORDER BY a.created_at,a.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'spaces') return sql.prepare(`SELECT s.* FROM spaces s WHERE s.owner_user_id=? ${taskIds ? `AND s.id IN (SELECT space_id FROM tasks WHERE id IN (${ids(taskIds)}))` : ''} ORDER BY s.created_at,s.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'projects') return sql.prepare(`SELECT p.* FROM projects p WHERE p.owner_user_id=? ${taskIds ? `AND p.id IN (SELECT project_id FROM tasks WHERE id IN (${ids(taskIds)}) AND project_id IS NOT NULL)` : ''} ORDER BY p.created_at,p.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'project_sections') return sql.prepare(`SELECT s.* FROM project_sections s WHERE s.owner_user_id=? ${taskIds ? `AND s.id IN (SELECT section_id FROM tasks WHERE id IN (${ids(taskIds)}) AND section_id IS NOT NULL)` : ''} ORDER BY s.project_id,s.sort_key,s.id`).all(ownerId, ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  if (table === 'contacts') return sql.prepare(`SELECT c.* FROM contacts c WHERE c.owner_user_id=? ${taskIds ? `AND c.id IN (SELECT responsible_contact_id FROM tasks WHERE id IN (${ids(taskIds)}) UNION SELECT action_contact_id FROM tasks WHERE id IN (${ids(taskIds)}))` : ''} ORDER BY c.name,c.id`).all(ownerId, ...(taskIds ?? []), ...(taskIds ?? [])) as Array<Record<string, unknown>>;
  return [];
}

function buildSnapshot(database: AppDatabase, ownerId: string, filters?: ExportFilters, format: 'json' | 'bundle' = 'json'): ExportSnapshot {
  const sql = rawDb(database);
  return sql.transaction(() => {
    const taskIds = filters ? selectTaskIds(sql, ownerId, filters) : (sql.prepare('SELECT id FROM tasks WHERE owner_user_id=? ORDER BY updated_at,id').all(ownerId) as Array<{ id: string }>).map((r) => r.id);
    const scoped = filters ? taskIds : undefined;
    const entities: Record<string, unknown[]> = {};
    const tables = ['spaces','projects','project_sections','contacts','tasks','delegations','task_events','task_body_revisions','checklist_items','capture_batches','capture_batch_items','structure_batches','structure_batch_members','task_references','assets','task_asset_links'];
    for (const table of tables) {
      let rows = rowsFor(sql, table, ownerId, scoped);
      if (table === 'tasks') rows = sql.prepare(`SELECT t.* FROM tasks t WHERE t.owner_user_id=?${scoped ? ` AND t.id IN (${ids(scoped)})` : ''} ORDER BY t.updated_at,t.id`).all(ownerId, ...(scoped ?? [])) as Array<Record<string, unknown>>;
      entities[table] = mapRows(rows);
    }
    const schemaVersion = (sql.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value ?? 'unknown';
    return { schemaVersion, generatedAt: new Date().toISOString(), format, scope: { kind: filters ? ('filtered' as const) : ('all' as const), ...(filters ? { filters } : {}), taskIds }, exclusions: EXCLUDED, entities };
  })();
}

export function makeJson(database: AppDatabase, ownerId: string, filters?: ExportFilters) { return buildSnapshot(database, ownerId, filters); }

function csvValue(value: unknown) {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@]/.test(text.trimStart())) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvFromSnapshot(snapshot: ExportSnapshot) {
  const columns = ['id','title','description','descriptionFormat','status','priority','spaceId','projectId','sectionId','parentId','sortKey','structureVersion','nextAction','resultNote','isProcessed','isWatched','handlingMode','counterpartName','plannedDate','dueDate','followUpDate','waitingReason','blockedReason','cancellationReason','createdAt','updatedAt','completedAt','cancelledAt','archivedAt','deletedAt','deletionBatchId','version'];
  const rows = snapshot.entities.tasks as Array<Record<string, unknown>>;
  return `${columns.join(',')}\r\n${rows.map((row) => columns.map((column) => csvValue(row[column])).join(',')).join('\r\n')}\r\n`;
}

export function makeCsv(database: AppDatabase, ownerId: string, filters: ExportFilters) { return csvFromSnapshot(buildSnapshot(database, ownerId, filters)); }

function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: Array<{ name: string; data: Buffer }>) {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) { const name = Buffer.from(entry.name); const crc = crc32(entry.data); const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); locals.push(local, entry.data); const dir = Buffer.alloc(46 + name.length); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(entry.data.length, 20); dir.writeUInt32LE(entry.data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42); name.copy(dir, 46); central.push(dir); offset += local.length + entry.data.length; }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}

export async function makeBundle(database: AppDatabase, ownerId: string, filters: ExportFilters) {
  const snapshot = buildSnapshot(database, ownerId, filters, 'bundle');
  const json = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8'); const csv = Buffer.from(csvFromSnapshot(snapshot), 'utf8');
  const assets = snapshot.entities.assets as Array<Record<string, unknown>>; const entries: Array<{ name: string; data: Buffer }> = [{ name: 'export.json', data: json }, { name: 'tasks.csv', data: csv }, { name: 'README.txt', data: Buffer.from('本包为同一筛选快照的 JSON、CSV 与引用媒体；JSON 不含密码、session、mutation_requests、草稿或 staging。\n', 'utf8') }];
  const manifest: Array<Record<string, unknown>> = [];
  for (const asset of assets.filter((row) => row.status === 'ready')) { const storageKey = String(asset.storageKey); let data: Buffer; try { data = await readFile(path.join(MEDIA_ROOT, storageKey)); } catch { throw new MutationConflict('导出引用的媒体文件缺失，已拒绝生成完整 bundle','EXPORT_MEDIA_MISSING',409,{ current: { assetId: asset.id } }); } if (data.length !== Number(asset.byteSize) || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new MutationConflict('导出引用的媒体文件校验失败，已拒绝生成完整 bundle','EXPORT_MEDIA_MISMATCH',409,{ current: { assetId: asset.id } }); const safeName = storageKey.replace(/[^a-zA-Z0-9._-]/g, '_'); entries.push({ name: `media/${safeName}`, data }); manifest.push({ assetId: asset.id, path: `media/${safeName}`, storageKey, byteSize: data.length, sha256: asset.sha256, originalName: asset.originalName, mimeType: asset.mimeType }); }
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ schemaVersion: snapshot.schemaVersion, appVersion: APP_VERSION, generatedAt: snapshot.generatedAt, scope: snapshot.scope, files: manifest }, null, 2), 'utf8') });
  return zip(entries);
}

export function validateFilters(url: URL): { ok: true; value: ExportFilters } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {}; const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined; const value = { view: (url.searchParams.get('view') ?? 'all') as TaskView, spaceId: url.searchParams.get('spaceId') ?? undefined, projectId: url.searchParams.get('projectId') ?? undefined, status: url.searchParams.get('status') ?? undefined, query: query?.trim() || undefined, includeEnded: url.searchParams.get('includeEnded') === 'true' };
  if (!TASK_VIEWS.includes(value.view)) fields.view = `只支持 ${TASK_VIEWS.join('/')}`;
  if (value.status && !(TASK_STATUS_VALUES as readonly string[]).includes(value.status)) fields.status = `只支持 ${TASK_STATUS_VALUES.join('/')}`;
  if (query !== undefined && (!query.trim() || [...query].length > 200)) fields.q = '搜索词必须为1–200个字符';
  if (url.searchParams.has('includeEnded') && !['true','false'].includes(url.searchParams.get('includeEnded')!)) fields.includeEnded = '只支持 true 或 false';
  const allowed = new Set(['view','spaceId','projectId','status','q','query','includeEnded']); for (const key of url.searchParams.keys()) if (!allowed.has(key)) fields[key] = '不支持此查询参数';
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value };
}
