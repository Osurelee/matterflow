/**
 * tasks 数据库 schema（M1-02，技术设计第 3 节 / 12.1）
 *
 * 约定（技术设计 3）：
 * - ID 使用 UUID 文本；事件时间为 UTC 时间戳；业务日期为 YYYY-MM-DD 文本。
 * - 布尔值在 SQLite 存 0/1；枚举增加 CHECK 约束；外键在连接与迁移时开启。
 * - snake_case 为数据库字段命名；camelCase 为 HTTP 字段命名（服务层转换）。
 * - 为未来成员制保留 owner_user_id / actor_user_id 与空间归属，不提前建成员权限表。
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** 业务日期 YYYY-MM-DD 文本 */
const dateText = (name: string) => text(name);

/** UTC 时间戳（ISO 8601 文本，统一服务端时钟） */
const tsText = (name: string) => text(name);

/* -------------------------------------------------- users */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  /** Argon2id/scrypt 成熟实现哈希（M1-03），不含明文 */
  passwordHash: text('password_hash').notNull(),
  timezone: text('timezone').notNull().default('Asia/Shanghai'),
  /** 改密/重置后递增，用于撤销旧会话（12.1） */
  authVersion: integer('auth_version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
}, (t) => [
  uniqueIndex('users_username_uq').on(t.username),
]);

/* -------------------------------------------------- sessions */

export const sessions = sqliteTable('sessions', {
  /** 仅存令牌哈希（高熵随机值哈希，12.2 会话协议 M1-03） */
  idHash: text('id_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  /** 会话创建时的 auth_version，改密后不一致即失效 */
  authVersion: integer('auth_version').notNull(),
  expiresAt: tsText('expires_at').notNull(),
  createdAt: tsText('created_at').notNull(),
}, (t) => [
  index('sessions_user_idx').on(t.userId),
]);

/* -------------------------------------------------- auth_rate_limits（12.3） */

export const authRateLimits = sqliteTable('auth_rate_limits', {
  /** key_hash：账号桶=用户名哈希；IP 桶=来源 IP 哈希 */
  keyHash: text('key_hash').primaryKey(),
  windowStart: tsText('window_start').notNull(),
  failureCount: integer('failure_count').notNull().default(0),
  blockedUntil: tsText('blocked_until'),
}, (t) => [
  index('auth_rate_limits_window_idx').on(t.windowStart),
]);

/* -------------------------------------------------- spaces */

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  archivedAt: tsText('archived_at'),
  structureVersion: integer('structure_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  check('spaces_structure_version_ck', sql`${t.structureVersion} > 0`),
  uniqueIndex('spaces_owner_name_uq').on(t.ownerUserId, t.name),
  // 默认空间不可归档（PRD 6.3；服务层校验，归档写入唯一入口）
]);

/* -------------------------------------------------- projects */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  spaceId: text('space_id').notNull().references(() => spaces.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  archivedAt: tsText('archived_at'),
  rootTaskId: text('root_task_id'),
  status: text('status').notNull().default('active'),
  isPaused: integer('is_paused',{mode:'boolean'}).notNull().default(false),
  targetDate: dateText('target_date'),
  successCriteria: text('success_criteria').notNull().default(''),
  version: integer('version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  check('projects_status_ck',sql`${t.status} IN ('active','paused','completed','cancelled')`),
  check('projects_is_paused_ck',sql`${t.isPaused} IN (0,1)`),
  uniqueIndex('projects_root_task_uq').on(t.rootTaskId).where(sql`${t.rootTaskId} IS NOT NULL`),
  uniqueIndex('projects_space_name_uq').on(t.spaceId, t.name),
  index('projects_owner_idx').on(t.ownerUserId),
]);

/* -------------------------------------------------- project sections */

export const projectSections = sqliteTable('project_sections', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  sortKey: text('sort_key').notNull().default('0000000000000000'),
  version: integer('version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  check('project_sections_sort_key_ck', sql`length(${t.sortKey}) > 0`),
  check('project_sections_version_ck', sql`${t.version} > 0`),
  uniqueIndex('project_sections_project_name_uq').on(t.projectId, t.name),
  index('project_sections_project_sort_idx').on(t.projectId, t.sortKey, t.id),
  index('project_sections_owner_idx').on(t.ownerUserId, t.projectId),
]);

/* -------------------------------------------------- contacts */

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  note: text('note').notNull().default(''),
  inactiveAt: tsText('inactive_at'),
  version: integer('version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  index('contacts_owner_idx').on(t.ownerUserId, t.name),
  // 同名允许（PRD 5.2 联系人可同名，用 note 区分），不做唯一约束
]);

/* -------------------------------------------------- tasks */

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'cancelled'] as const;
export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high'] as const;
export const RESPONSIBLE_KINDS = ['self', 'contact'] as const;
export const ACTION_KINDS = ['self', 'contact', 'none'] as const;

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  spaceId: text('space_id').notNull().references(() => spaces.id),
  projectId: text('project_id').references(() => projects.id),
  sectionId: text('section_id').references(() => projectSections.id),
  parentId: text('parent_id'),
  sortKey: text('sort_key').notNull().default('0000000000000000'),
  structureVersion: integer('structure_version').notNull().default(1),
  deletionBatchId: text('deletion_batch_id'),

  // 内容
  title: text('title').notNull(),
  /** 唯一内容源；格式区分旧纯文本与共同子集 Markdown（M4-01） */
  description: text('description').notNull().default(''),
  descriptionFormat: text('description_format').notNull().default('plaintext'),
  /** 搜索派生值，由 src/domain/body.ts 生成，不反向编辑（技术设计 5.1） */
  descriptionPlain: text('description_plain').notNull().default(''),
  sourceUrl: text('source_url'),
  sourceLabel: text('source_label'),
  priority: text('priority').notNull().default('none'),
  nextAction: text('next_action').notNull().default(''),
  resultNote: text('result_note').notNull().default(''),

  // 状态（is_processed=收件箱整理标记；is_watched=我关注）
  status: text('status').notNull().default('todo'),
  isProcessed: integer('is_processed', { mode: 'boolean' }).notNull().default(false),
  isWatched: integer('is_watched', { mode: 'boolean' }).notNull().default(false),

  // 结果责任
  responsibleKind: text('responsible_kind').notNull().default('self'),
  responsibleContactId: text('responsible_contact_id').references(() => contacts.id),

  // 当前行动方
  actionKind: text('action_kind').notNull().default('self'),
  actionContactId: text('action_contact_id').references(() => contacts.id),

  // 时间安排（YYYY-MM-DD，可空）
  plannedDate: dateText('planned_date'),
  dueDate: dateText('due_date'),
  followUpDate: dateText('follow_up_date'),

  // 个人分发记录（M3-03，PRD v0.6 5.2/10.2）：self/other + 交给谁自由文本
  handlingMode: text('handling_mode').notNull().default('self'),
  counterpartName: text('counterpart_name').notNull().default(''),

  // 原因（waiting 必填等待原因由服务层状态机校验）
  waitingReason: text('waiting_reason').notNull().default(''),
  blockedReason: text('blocked_reason').notNull().default(''),
  cancellationReason: text('cancellation_reason').notNull().default(''),

  // 系统字段
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
  completedAt: tsText('completed_at'),
  cancelledAt: tsText('cancelled_at'),
  archivedAt: tsText('archived_at'),
  deletedAt: tsText('deleted_at'),
  version: integer('version').notNull().default(1),
}, (t) => [
  // 枚举 CHECK（技术设计 3）
  check('tasks_status_ck', sql`${t.status} IN ('todo','in_progress','waiting','done','cancelled')`),
  check('tasks_parent_not_self_ck',sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  check('tasks_structure_version_ck',sql`${t.structureVersion} > 0`),
  check('tasks_sort_key_ck',sql`length(${t.sortKey}) > 0`),
  check('tasks_handling_mode_ck', sql`${t.handlingMode} IN ('self','other')`),
  // self 必须为空文本；other 必须有交给谁（M3-03 配对约束，迁移中另有触发器兜底）
  check('tasks_handling_pair_ck', sql`(${t.handlingMode} = 'self' AND ${t.counterpartName} = '') OR (${t.handlingMode} = 'other' AND trim(${t.counterpartName}) <> '')`),
  check('tasks_priority_ck', sql`${t.priority} IN ('none','low','medium','high')`),
  check('tasks_description_format_ck', sql`${t.descriptionFormat} IN ('plaintext','markdown_v1')`),
  check('tasks_responsible_kind_ck', sql`${t.responsibleKind} IN ('self','contact')`),
  check('tasks_action_kind_ck', sql`${t.actionKind} IN ('self','contact','none')`),
  // kind=contact 必须有对应 contact_id；其他 kind 必须为空（3.2）
  check(
    'tasks_responsible_contact_ck',
    sql`(${t.responsibleKind} = 'contact' AND ${t.responsibleContactId} IS NOT NULL) OR (${t.responsibleKind} = 'self' AND ${t.responsibleContactId} IS NULL)`,
  ),
  check(
    'tasks_action_contact_ck',
    sql`(${t.actionKind} = 'contact' AND ${t.actionContactId} IS NOT NULL) OR (${t.actionKind} != 'contact' AND ${t.actionContactId} IS NULL)`,
  ),
  // done/cancelled 必须有对应时间；活跃状态两者为空（3.2 不变量）
  check('tasks_done_ts_ck', sql`(${t.status} = 'done' AND ${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL) OR (${t.status} != 'done' AND ${t.completedAt} IS NULL)`),
  check('tasks_cancelled_ts_ck', sql`(${t.status} = 'cancelled' AND ${t.cancelledAt} IS NOT NULL AND ${t.completedAt} IS NULL) OR (${t.status} != 'cancelled' AND ${t.cancelledAt} IS NULL)`),

  // 索引（3.3）
  index('tasks_owner_status_idx').on(t.ownerUserId, t.deletedAt, t.archivedAt, t.status),
  index('tasks_owner_handling_idx').on(t.ownerUserId, t.handlingMode),
  index('tasks_owner_description_format_idx').on(t.ownerUserId, t.descriptionFormat),
  index('tasks_owner_due_idx').on(t.ownerUserId, t.dueDate),
  index('tasks_owner_followup_idx').on(t.ownerUserId, t.followUpDate),
  index('tasks_owner_planned_idx').on(t.ownerUserId, t.plannedDate),
  index('tasks_project_idx').on(t.projectId),
  index('tasks_project_section_sort_idx').on(t.projectId, t.sectionId, t.sortKey, t.id),
  index('tasks_parent_sort_idx').on(t.parentId,t.sortKey,t.id),
  index('tasks_structure_version_idx').on(t.structureVersion),
  index('tasks_space_idx').on(t.spaceId),
]);

/* -------------------------------------------------- delegations */

export const delegations = sqliteTable('delegations', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  delegatedBy: text('delegated_by').notNull().references(() => users.id),
  contactId: text('contact_id').notNull().references(() => contacts.id),
  startedAt: tsText('started_at').notNull(),
  endedAt: tsText('ended_at'),
  /** 结束原因：recalled / contact_changed / task_ended / reopened（事件语义） */
  endReason: text('end_reason'),
}, (t) => [
  // 每个事项最多一条 ended_at IS NULL 的有效委托（3.1 / 3.3 部分唯一索引）
  uniqueIndex('delegations_task_active_uq')
    .on(t.taskId)
    .where(sql`${t.endedAt} IS NULL`),
  index('delegations_task_idx').on(t.taskId),
]);

/* -------------------------------------------------- task_events（只追加） */

export const TASK_EVENT_TYPES = [
  'task_created',
  'task_updated',
  'task_transitioned',
  'task_processed_marked',
  'task_delegated',
  'task_delegation_changed',
  'task_delegation_ended',
  'task_recall_requested',
  'task_archived',
  'task_unarchived',
  'task_deleted',
  'task_restored',
  'task_progress_appended',
] as const;

export const taskEvents = sqliteTable('task_events', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  actorUserId: text('actor_user_id').notNull().references(() => users.id),
  type: text('type').notNull(),
  /** payload 带 schema 版本和变化字段（联系人姓名、旧标题等快照保留在 payload） */
  payloadJson: text('payload_json').notNull(),
  occurredAt: tsText('occurred_at').notNull(),
  requestId: text('request_id'),
}, (t) => [
  check('task_events_type_ck', sql`${t.type} IN ('task_created','task_updated','task_transitioned','task_processed_marked','task_delegated','task_delegation_changed','task_delegation_ended','task_recall_requested','task_archived','task_unarchived','task_deleted','task_restored','task_progress_appended')`),
  index('task_events_task_occurred_idx').on(t.taskId, t.occurredAt, t.id),
  index('task_events_owner_idx').on(t.ownerUserId),
]);

/* -------------------------------------------------- task_body_revisions（M4-01，只追加） */

export const TASK_BODY_FORMATS = ['plaintext', 'markdown_v1'] as const;

export const taskBodyRevisions = sqliteTable('task_body_revisions', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  format: text('format').notNull(),
  content: text('content').notNull(),
  contentPlain: text('content_plain').notNull().default(''),
  /** 修订来源的事项版本；修订只追加，后续正文改写不改写历史（技术设计 5.2、AT-31） */
  taskVersion: integer('task_version').notNull(),
  requestId: tsText('request_id'),
  createdAt: tsText('created_at').notNull(),
}, (t) => [
  check('task_body_revisions_format_ck', sql`${t.format} IN ('plaintext','markdown_v1')`),
  uniqueIndex('task_body_revisions_task_version_uq').on(t.taskId, t.taskVersion),
  index('task_body_revisions_task_created_idx').on(t.taskId, t.createdAt, t.id),
]);

/* -------------------------------------------------- checklist_items（M4-04） */

export const checklistItems = sqliteTable('checklist_items', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  text: text('text').notNull(),
  isChecked: integer('is_checked', { mode: 'boolean' }).notNull().default(false),
  /** 定宽零填充排序键；字典序即顺序，重排时整表重算（≤100 条） */
  sortKey: text('sort_key').notNull(),
  /** 预留给 M5 提升为子事项；M4 不开放该入口，恒为 NULL */
  promotedTaskId: text('promoted_task_id'),
  version: integer('version').notNull().default(1),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  check('checklist_items_checked_ck', sql`${t.isChecked} IN (0,1)`),
  check('checklist_items_text_ck', sql`length(trim(${t.text})) > 0`),
  check('checklist_items_sort_key_ck', sql`length(${t.sortKey}) > 0`),
  index('checklist_items_task_sort_idx').on(t.taskId, t.sortKey),
  index('checklist_items_owner_idx').on(t.ownerUserId),
]);

/* -------------------------------------------------- mutation_requests（12.1） */

export const mutationRequests = sqliteTable('mutation_requests', {
  userId: text('user_id').notNull(),
  requestId: text('request_id').notNull(),
  /** 哈希包含 HTTP 方法、规范化资源路径与校验后的正文（技术设计 4） */
  payloadHash: text('payload_hash').notNull(),
  /** 成功写请求的重放结果（完整 JSON 响应） */
  responseJson: text('response_json').notNull(),
  createdAt: tsText('created_at').notNull(),
}, (t) => [
  uniqueIndex('mutation_requests_user_request_uq').on(t.userId, t.requestId),
]);


/* -------------------------------------------------- capture_batches（M4-07） */

export const captureBatches = sqliteTable('capture_batches', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  requestId: text('request_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  responseJson: text('response_json').notNull(),
  createdAt: tsText('created_at').notNull(),
}, (t) => [
  uniqueIndex('capture_batches_owner_request_uq').on(t.ownerUserId,t.requestId),
  index('capture_batches_owner_created_idx').on(t.ownerUserId,t.createdAt),
]);

export const captureBatchItems = sqliteTable('capture_batch_items', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull().references(() => captureBatches.id),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  sequence: integer('sequence').notNull(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  title: text('title').notNull(),
}, (t) => [
  check('capture_batch_items_sequence_ck', sql`${t.sequence} >= 0`),
  uniqueIndex('capture_batch_items_batch_sequence_uq').on(t.batchId,t.sequence),
  uniqueIndex('capture_batch_items_batch_task_uq').on(t.batchId,t.taskId),
  index('capture_batch_items_task_idx').on(t.taskId),
]);


/* -------------------------------------------------- m5_migration_reports（M5-01） */

export const m5MigrationReports = sqliteTable('m5_migration_reports', {
  id: text('id').primaryKey(),
  createdAt: tsText('created_at').notNull(),
  projectsMigrated: integer('projects_migrated').notNull(),
  legacyTasksPreserved: integer('legacy_tasks_preserved').notNull(),
  rootTasksCreated: integer('root_tasks_created').notNull(),
  eventsBefore: integer('events_before').notNull(),
  eventsAfter: integer('events_after').notNull(),
  assetsBefore: integer('assets_before').notNull(),
  assetsAfter: integer('assets_after').notNull(),
  linksBefore: integer('links_before').notNull(),
  linksAfter: integer('links_after').notNull(),
  reportJson: text('report_json').notNull(),
});

/* -------------------------------------------------- structure_batches（M5-04） */

export const structureBatches = sqliteTable('structure_batches', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  operation: text('operation').notNull(),
  rootTaskId: text('root_task_id').notNull().references(() => tasks.id),
  sourceParentId: text('source_parent_id'),
  targetParentId: text('target_parent_id'),
  sourceSpaceId: text('source_space_id').notNull().references(() => spaces.id),
  targetSpaceId: text('target_space_id'),
  createdAt: tsText('created_at').notNull(),
  requestId: text('request_id').notNull(),
  summaryJson: text('summary_json').notNull(),
}, (t) => [
  check('structure_batches_operation_ck', sql`${t.operation} IN ('move','delete','restore','archive','unarchive')`),
  index('structure_batches_owner_created_idx').on(t.ownerUserId, t.createdAt, t.id),
  index('structure_batches_root_idx').on(t.rootTaskId, t.createdAt, t.id),
]);

export const structureBatchMembers = sqliteTable('structure_batch_members', {
  batchId: text('batch_id').notNull().references(() => structureBatches.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  depth: integer('depth').notNull(),
  oldParentId: text('old_parent_id'),
  oldSpaceId: text('old_space_id').notNull().references(() => spaces.id),
  oldProjectId: text('old_project_id'),
  oldSortKey: text('old_sort_key').notNull(),
  oldVersion: integer('old_version').notNull(),
  oldStructureVersion: integer('old_structure_version').notNull(),
  oldArchivedAt: tsText('old_archived_at'),
  oldDeletedAt: tsText('old_deleted_at'),
  oldDeletionBatchId: text('old_deletion_batch_id'),
}, (t) => [
  primaryKey({ columns: [t.batchId, t.taskId] }),
  check('structure_batch_members_depth_ck', sql`${t.depth} >= 0`),
  index('structure_batch_members_task_idx').on(t.taskId, t.batchId),
]);

/* -------------------------------------------------- task_references（M5-09） */

export const taskReferences = sqliteTable('task_references', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  sourceTaskId: text('source_task_id').notNull().references(() => tasks.id),
  targetTaskId: text('target_task_id').notNull().references(() => tasks.id),
  sortKey: text('sort_key').notNull().default('0000000000000000'),
  version: integer('version').notNull().default(1),
  removedAt: tsText('removed_at'),
  createdAt: tsText('created_at').notNull(),
  updatedAt: tsText('updated_at').notNull(),
}, (t) => [
  check('task_references_source_target_ck', sql`${t.sourceTaskId} <> ${t.targetTaskId}`),
  check('task_references_sort_key_ck', sql`length(${t.sortKey}) > 0`),
  check('task_references_version_ck', sql`${t.version} > 0`),
  uniqueIndex('task_references_active_pair_uq').on(t.sourceTaskId, t.targetTaskId).where(sql`${t.removedAt} IS NULL`),
  index('task_references_source_idx').on(t.ownerUserId, t.sourceTaskId, t.removedAt, t.sortKey, t.id),
  index('task_references_target_idx').on(t.ownerUserId, t.targetTaskId, t.removedAt, t.sortKey, t.id),
]);

/* -------------------------------------------------- backup_runs（12.4） */

export const backupRuns = sqliteTable('backup_runs', {
  id: text('id').primaryKey(),
  startedAt: tsText('started_at').notNull(),
  finishedAt: tsText('finished_at'),
  /** running / success / failed */
  status: text('status').notNull(),
  artifactName: text('artifact_name'),
  checksum: text('checksum'),
  errorCode: text('error_code'),
  localStatus: text('local_status'),
  /** unverified / verified / failed；未独立取回时不得显示异机成功 */
  remoteStatus: text('remote_status'),
  localVerifiedAt: tsText('local_verified_at'),
  remoteVerifiedAt: tsText('remote_verified_at'),
  remoteObjectId: text('remote_object_id'),
}, (t) => [
  check('backup_runs_status_ck', sql`${t.status} IN ('running','success','failed')`),
  check('backup_runs_remote_status_ck', sql`${t.remoteStatus} IS NULL OR ${t.remoteStatus} IN ('unverified','verified','failed')`),
]);

/* -------------------------------------------------- assets / task_asset_links（M4-05） */

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  uploadRequestId: text('upload_request_id').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  durationMs: integer('duration_ms'),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  status: text('status').notNull().default('ready'),
  createdAt: tsText('created_at').notNull(),
  removedAt: tsText('removed_at'),
}, (t) => [
  check('assets_size_ck', sql`${t.byteSize} > 0 AND ${t.byteSize} <= 26214400`),
  check('assets_status_ck', sql`${t.status} IN ('ready','failed')`),
  uniqueIndex('assets_storage_key_uq').on(t.storageKey),
  uniqueIndex('assets_owner_request_uq').on(t.ownerUserId,t.uploadRequestId),
  index('assets_owner_status_idx').on(t.ownerUserId,t.status),
]);

export const taskAssetLinks = sqliteTable('task_asset_links', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  assetId: text('asset_id').notNull().references(() => assets.id),
  progressEventId: text('progress_event_id').references(() => taskEvents.id),
  role: text('role').notNull().default('attachment'),
  createdAt: tsText('created_at').notNull(),
  removedAt: tsText('removed_at'),
}, (t) => [
  check('task_asset_links_role_ck', sql`${t.role} IN ('attachment','body','progress')`),
  uniqueIndex('task_asset_links_task_asset_role_uq').on(t.taskId,t.assetId,t.role),
  index('task_asset_links_task_idx').on(t.taskId,t.removedAt),
  index('task_asset_links_asset_idx').on(t.assetId,t.removedAt),
  index('task_asset_links_progress_event_idx').on(t.progressEventId,t.removedAt),
]);

/**
 * schema 版本（导出/迁移校验用）。
 *
 * 必须与数据库 `app_meta.schema_version`（= db/migrations 清单条数）保持一致：
 * 每次新增迁移后同步更新此常量（当前：0000～0013 = 14）。
 */
export const SCHEMA_VERSION = '14';
