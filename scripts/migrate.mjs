#!/usr/bin/env node
/**
 * 迁移执行脚本（M1-02）。
 *
 * 设计依据（技术设计 9 / 12.1）；2026-10-12 验收后修复 ACC-01 / ACC-02 / ACC-03 / R-01 / R-02：
 * - ACC-01：迁移前备份改用 SQLite 一致性快照（`VACUUM INTO`，包含 WAL 中已提交但未 checkpoint 的数据），
 *           并在备份后**校验**（integrity_check + 关键表与行数一致）；备份或校验失败即中止迁移，
 *           绝不带着不可靠备份继续。旧的 `copyFileSync` 只复制主文件，会丢失 WAL 中的已提交数据。
 * - ACC-02：迁移清单（_journal.json）中每个 tag 必须有对应 SQL 文件；缺失即非零退出且不改库。
 *           同时校验"已应用迁移"与当前清单一致，避免旧代码把更新的数据库当作兼容版本。
 * - ACC-03 / R-01：数据库路径统一为 TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db；
 *           环境加载改用应用同款 `@next/env`（不再自制解析器），脚本与应用读到同一组值。
 * - R-02：**任何写入之前先预检**。清单完整性校验（journal 存在、每个 tag 有 SQL 文件）
 *           发生在 mkdirSync / Database 构造 / 任何 DDL 之前：预检失败时既有的库与目录
 *           一字不改，新目标路径不被创建。"已应用迁移是清单前缀"检查同样先只读完成
 *           （只读打开已有库；库不存在时跳过该检查），之后才进入必要写入。
 *
 * 用法：
 *   node scripts/migrate.mjs                     # 应用全部未执行迁移
 *   TASKS_DB_PATH=/tmp/test.db node scripts/migrate.mjs
 *   TASKS_DATA_DIR=/tmp/tasks-data node scripts/migrate.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';

import { PROJECT_ROOT, loadEnvFiles, resolveDbPath } from './lib/env.mjs';

loadEnvFiles();

const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');
const DB_PATH = resolveDbPath();

function fail(message) {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

/** 应用元数据表：记录迁移历史与 schema 版本 */
const ENSURE_META_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS __drizzle_migrations_applied (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  tag TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
`;

/**
 * 读取迁移清单并校验（ACC-02 / R-02）：清单中的每个 tag 都必须有 SQL 文件。
 * 纯只读（只碰 db/migrations 下的文件），必须在任何数据库写入之前调用。
 * 返回按数字顺序排序的 tag 列表。
 */
function readMigrationTags() {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
  if (!existsSync(journalPath)) fail(`迁移清单缺失: ${journalPath}`);
  let entries;
  try {
    entries = JSON.parse(readFileSync(journalPath, 'utf8')).entries ?? [];
  } catch (err) {
    fail(`迁移清单解析失败: ${err.message}`);
  }
  const tags = entries.map((e) => e.tag);
  const missing = tags.filter((tag) => !existsSync(path.join(MIGRATIONS_DIR, `${tag}.sql`)));
  if (missing.length > 0) {
    fail(`迁移清单中的 SQL 文件缺失: ${missing.join(', ')}；拒绝在缺文件的情况下继续（数据库未被修改）`);
  }
  return tags.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * R-02：只读读取已应用迁移（若库已存在且已有迁移记录表）。
 * 库不存在或表未建时返回 null（新库场景）。不执行任何写入。
 */
function readAppliedTags() {
  if (!existsSync(DB_PATH)) return null;
  let ro;
  try {
    ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    fail(`数据库无法只读打开: ${err.message}`);
  }
  try {
    const hasTable = ro
      .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations_applied'")
      .get().c;
    if (hasTable === 0) return [];
    return ro.prepare('SELECT tag FROM __drizzle_migrations_applied ORDER BY id').all().map((r) => r.tag);
  } finally {
    ro.close();
  }
}

const M3_HANDLING_TAG = '0002_m3_handling';
const M5_ROOT_MIGRATION_TAG = '0009_m5_01_independent_items';

function tableExists(db, name) {
  return db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0;
}
function tableColumns(db, name) {
  return new Set(db.pragma(`table_info(\`${name}\`)`).map((row) => row.name));
}

/** M5-01 legacy precheck: read-only and before database mkdir/backup/DDL. */
function legacyProjectPrecheck(pending) {
  if (!pending.includes(M5_ROOT_MIGRATION_TAG)) return null;
  if (!existsSync(DB_PATH)) return { projects: [], projectCount: 0, tasksBefore: 0, eventsBefore: 0, assetsBefore: 0, linksBefore: 0 };
  let ro;
  try { ro = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
  catch (err) { fail(`M5-01项目迁移预检无法只读打开数据库: ${err.message}`); }
  try {
    const hasProjects=tableExists(ro,'projects');const hasTasks=tableExists(ro,'tasks');
    if(!hasProjects&&!hasTasks)return {projects:[],projectCount:0,tasksBefore:0,eventsBefore:0,assetsBefore:0,linksBefore:0};
    if(!hasProjects||!hasTasks)fail('M5-01预检缺少projects或tasks表，拒绝猜测迁移（数据库未被修改）');
    const projectColumns=tableColumns(ro,'projects');const taskColumns=tableColumns(ro,'tasks');
    if (projectColumns.has('root_task_id') || taskColumns.has('parent_id')) fail('M5-01字段已存在但迁移版本未登记，检测到未知/半迁移状态，拒绝覆盖（数据库未被修改）');
    const projectRequired=['id','owner_user_id','space_id','name','description','archived_at','version','created_at','updated_at'];
    const taskRequired=['id','owner_user_id','space_id','project_id','title','description','description_format','description_plain','status','version','created_at','updated_at'];
    for(const c of projectRequired)if(!projectColumns.has(c))fail(`M5-01旧projects缺少必需列${c}，拒绝猜测迁移（数据库未被修改）`);
    for(const c of taskRequired)if(!taskColumns.has(c))fail(`M5-01旧tasks缺少必需列${c}，拒绝猜测迁移（数据库未被修改）`);
    const fk=ro.pragma('foreign_key_check');if(fk.length)fail(`M5-01旧库存在${fk.length}条外键问题，先修复后再迁移（数据库未被修改）`);
    const mismatch=ro.prepare('SELECT count(*) c FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.owner_user_id<>p.owner_user_id OR t.space_id<>p.space_id').get().c;
    if(mismatch)fail(`M5-01发现${mismatch}条项目事项owner/space与项目不一致，拒绝猜测修复（数据库未被修改）`);
    const archivedActive=ro.prepare("SELECT count(*) c FROM projects p WHERE p.archived_at IS NOT NULL AND EXISTS(SELECT 1 FROM tasks t WHERE t.project_id=p.id AND t.deleted_at IS NULL AND t.status IN ('todo','in_progress','waiting'))").get().c;
    if(archivedActive)fail(`M5-01发现${archivedActive}个已归档项目仍含活跃事项，需人工确认后再迁移（数据库未被修改）`);
    const projects=ro.prepare('SELECT id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at FROM projects ORDER BY space_id,created_at,id').all();
    for(const p of projects){if([...p.name].length<1||[...p.name].length>200)fail(`M5-01项目${p.id}名称超出Task标题长度，需人工整理（数据库未被修改）`);if([...p.description].length>20000)fail(`M5-01项目${p.id}正文超过Task正文限额，需人工整理（数据库未被修改）`)}
    const count=(table)=>tableExists(ro,table)?ro.prepare(`SELECT count(*) c FROM ${table}`).get().c:0;
    return {projects,projectCount:projects.length,tasksBefore:count('tasks'),eventsBefore:count('task_events'),assetsBefore:count('assets'),linksBefore:count('task_asset_links')};
  } finally { ro.close(); }
}

/** Applies the one-time project-to-root migration inside the migration transaction. */
function migrateLegacyProjects(db, precheck) {
  const now=new Date().toISOString();const roots=[];const rootOrder=new Map();
  for(const project of precheck.projects){
    const rootId=randomUUID();const nextRootOrder=rootOrder.get(project.space_id)??0;rootOrder.set(project.space_id,nextRootOrder+1);
    const rootSort=String(nextRootOrder).padStart(16,'0');
    db.prepare(`INSERT INTO tasks(id,owner_user_id,space_id,project_id,parent_id,sort_key,structure_version,title,description,description_format,description_plain,status,is_processed,archived_at,created_at,updated_at,version)
      VALUES(?,?,?,?,NULL,?,1,?,?,'plaintext',?,'todo',1,?,?,?,1)`).run(rootId,project.owner_user_id,project.space_id,project.id,rootSort,project.name,project.description,project.description,project.archived_at,now,now);
    const migrationRequestId=`m5-01:${project.id}`;const rootEventId=randomUUID();
    db.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(rootEventId,project.owner_user_id,rootId,project.owner_user_id,'task_created',JSON.stringify({schemaVersion:1,migration:{kind:'legacy_project_root',sourceProjectId:project.id},changes:{title:{from:null,to:project.name},...(project.description?{description:{format:'plaintext',length:[...project.description].length}}:{})}}),now,migrationRequestId);
    if(project.description)db.prepare("INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,'plaintext',?,?,1,?,?)").run(randomUUID(),project.owner_user_id,rootId,project.description,project.description,migrationRequestId,now);
    const children=db.prepare('SELECT id,owner_user_id,space_id FROM tasks WHERE project_id=? AND id<>? ORDER BY created_at,id').all(project.id,rootId);
    const rootCheck=db.prepare('SELECT owner_user_id,space_id FROM tasks WHERE id=?').get(rootId);
    const mismatch=children.find(child=>child.owner_user_id!==rootCheck.owner_user_id||child.space_id!==rootCheck.space_id);
    if(mismatch)throw new Error(`M5-01 internal owner/space precondition mismatch project=${project.id} root=${JSON.stringify(rootCheck)} child=${JSON.stringify(mismatch)}`);
    const updateChild=db.prepare('UPDATE tasks SET parent_id=?,sort_key=?,structure_version=1 WHERE id=? AND project_id=?');
    children.forEach((child,index)=>updateChild.run(rootId,String(index).padStart(16,'0'),child.id,project.id));
    db.prepare("UPDATE projects SET root_task_id=?,status='active',is_paused=0,target_date=NULL,success_criteria='',updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND root_task_id IS NULL").run(rootId,now,project.id,project.owner_user_id);
    roots.push({projectId:project.id,rootTaskId:rootId,childCount:children.length,archivedAt:project.archived_at});
  }
  const tasksAfter=db.prepare('SELECT count(*) c FROM tasks').get().c;const eventsAfter=db.prepare('SELECT count(*) c FROM task_events').get().c;
  const assetsAfter=tableExists(db,'assets')?db.prepare('SELECT count(*) c FROM assets').get().c:0;const linksAfter=tableExists(db,'task_asset_links')?db.prepare('SELECT count(*) c FROM task_asset_links').get().c:0;
  const report={migration:M5_ROOT_MIGRATION_TAG,projects:roots,legacyTasksBefore:precheck.tasksBefore,legacyTasksAfter:tasksAfter-roots.length,eventsBefore:precheck.eventsBefore,eventsAfter,assetsBefore:precheck.assetsBefore,assetsAfter,linksBefore:precheck.linksBefore,linksAfter};
  if(report.legacyTasksBefore!==report.legacyTasksAfter)throw new Error('M5-01迁移验证失败：原Task行数变化');
  if(report.eventsAfter-report.eventsBefore!==roots.length)throw new Error('M5-01迁移验证失败：事件增量与新根Task数量不符');
  if(report.assetsBefore!==report.assetsAfter||report.linksBefore!==report.linksAfter)throw new Error('M5-01迁移验证失败：媒体或关联数量变化');
  const rootMismatch=db.prepare('SELECT count(*) c FROM projects p LEFT JOIN tasks t ON t.id=p.root_task_id WHERE t.id IS NULL OR t.project_id<>p.id OR t.owner_user_id<>p.owner_user_id OR t.space_id<>p.space_id').get().c;
  if(rootMismatch)throw new Error(`M5-01迁移验证失败：${rootMismatch}个Project root关系无效`);
  db.prepare('INSERT INTO m5_migration_reports(id,created_at,projects_migrated,legacy_tasks_preserved,root_tasks_created,events_before,events_after,assets_before,assets_after,links_before,links_after,report_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('m5-01-project-roots-v1',now,roots.length,report.legacyTasksAfter,roots.length,precheck.eventsBefore,eventsAfter,precheck.assetsBefore,assetsAfter,precheck.linksBefore,linksAfter,JSON.stringify(report));
  console.log(`migrate: M5-01 project roots: projects=${roots.length}, legacyTasks=${report.legacyTasksAfter}, rootTasks=${roots.length}, assets=${assetsAfter}, links=${linksAfter}`);
  return report;
}


/**
 * M3-03 旧数据预检（技术设计 3.3 / 13）：只读，不写库。
 * 普通 M2 self/none 事项可直接回填 self/空文本；一旦发现历史 contact 关联或有效委托，
 * 说明存在需要人工映射的旧分发数据，必须先输出报告并显式授权再迁移，不能按同名静默合并。
 */
function legacyContactPrecheck(pending) {
  if (!pending.includes(M3_HANDLING_TAG)) return;
  if (!existsSync(DB_PATH)) return;
  let ro;
  try {
    ro = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    fail(`旧数据预检无法只读打开数据库: ${err.message}`);
  }
  try {
    const hasTasks = ro.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='tasks'").get().c;
    if (hasTasks === 0) return;
    const linked = ro.prepare("SELECT count(*) c FROM tasks WHERE responsible_kind='contact' OR action_kind='contact'").get().c;
    const uniqueCounterparts = ro.prepare("SELECT count(DISTINCT responsible_contact_id) c FROM tasks WHERE responsible_contact_id IS NOT NULL").get().c;
    const hasDelegations = ro.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='delegations'").get().c;
    const delegations = hasDelegations ? ro.prepare('SELECT count(*) c FROM delegations').get().c : 0;
    if (linked === 0 && delegations === 0) return;
    console.error('migrate: 检测到历史联系人/委托数据，已停止自动迁移（数据库未被修改）');
    console.error(`migrate: 关联 contact 的事项=${linked}，不同 result 联系人=${uniqueCounterparts}，delegations 记录=${delegations}`);
    console.error('migrate: 请先人工审阅并确定“交给谁”文本映射，再设置 TASKS_ALLOW_LEGACY_CONTACT_MIGRATION=1 显式授权迁移');
    if (process.env.TASKS_ALLOW_LEGACY_CONTACT_MIGRATION !== '1') process.exit(1);
    console.warn('migrate: 已显式授权，按“交给谁”留空文本回填，历史留存在旧字段与备份中');
  } finally { ro.close(); }
}

function splitStatements(sqlText) {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * ACC-01：一致性备份 + 校验。
 * `VACUUM INTO` 读取的是包含 WAL 已提交数据的当前快照；校验通过才返回备份路径。
 */
function createVerifiedBackup(db) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.pre-migration-${stamp}.bak`;
  if (existsSync(backupPath)) fail(`备份目标已存在，拒绝覆盖: ${backupPath}`);

  try {
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } catch (err) {
    fail(`迁移前备份失败，已中止迁移（数据库未被修改）: ${err.message}`);
  }

  const check = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`备份 integrity_check 未通过: ${integrity}`);

    const tables = ['users', 'spaces', 'tasks', 'task_events'];
    for (const table of tables) {
      const existsInSource = db
        .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table).c;
      const existsInBackup = check
        .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table).c;
      if (existsInSource !== existsInBackup) throw new Error(`备份与源库的表结构不一致: ${table}`);
      if (existsInSource === 0) continue;
      const src = db.prepare(`SELECT count(*) c FROM ${table}`).get().c;
      const dst = check.prepare(`SELECT count(*) c FROM ${table}`).get().c;
      if (src !== dst) throw new Error(`备份表 ${table} 行数不一致: 备份 ${dst} != 源库 ${src}`);
    }
  } catch (err) {
    check.close();
    rmSync(backupPath, { force: true });
    fail(`备份校验失败，已中止迁移并删除不可靠备份（数据库未被修改）: ${err.message}`);
  }
  check.close();
  return backupPath;
}

function main() {
  // ============================================================
  // R-02：预检阶段——只读，无任何 mkdir / Database(写) / DDL。
  // 失败时新目标文件与目录不会被创建，已有库与 schema 不变。
  // ============================================================
  const tags = readMigrationTags();
  const dbExistedBefore = existsSync(DB_PATH);
  const appliedOrNull = readAppliedTags();

  if (appliedOrNull !== null) {
    const applied = appliedOrNull;
    // ACC-02：数据库不能比代码更新；已应用迁移必须是清单的前缀
    const unknown = applied.filter((tag) => !tags.includes(tag));
    if (unknown.length > 0) {
      fail(`数据库已应用当前代码未知的迁移: ${unknown.join(', ')}；数据库比代码新，拒绝继续（数据库未被修改）`);
    }
    const expectedPrefix = tags.slice(0, applied.length);
    if (expectedPrefix.join('|') !== applied.join('|')) {
      fail(`已应用迁移与清单顺序不一致（已应用: ${applied.join(', ')}；清单前缀: ${expectedPrefix.join(', ')}）（数据库未被修改）`);
    }
  }

  const applied = appliedOrNull ?? [];
  const pending = tags.filter((tag) => !applied.includes(tag));


  // M3-03：旧联系人/委托数据预检（仍属只读预检阶段，失败不创建目录也不改库）
  legacyContactPrecheck(pending);
  const m5ProjectSnapshot=legacyProjectPrecheck(pending);

  // 预检通过，进入写入阶段
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // 1) 基础表（幂等）
  db.exec(ENSURE_META_SQL);
  db.exec(MIGRATION_TABLE_SQL);

  if (pending.length === 0) {
    console.log('migrate: nothing to apply (already at latest)');
    const version = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
    console.log(`migrate: schema_version=${version?.value ?? '(unset)'}`);
    db.close();
    return;
  }

  // 2) 迁移前一致性备份（技术设计 9：数据库升级前备份；失败停止发布）
  if (dbExistedBefore) {
    const backupPath = createVerifiedBackup(db);
    console.log(`migrate: pre-migration backup (verified) -> ${backupPath}`);
  } else {
    console.log('migrate: 新数据库（此前不存在），跳过迁移前备份');
  }

  // 3) 逐迁移单事务应用；失败中止不落半套
  for (const tag of pending) {
    const sqlText = readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
    const statements = splitStatements(sqlText);
    const apply = db.transaction(() => {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      if(tag===M5_ROOT_MIGRATION_TAG)migrateLegacyProjects(db,m5ProjectSnapshot??{projects:[],projectCount:0,tasksBefore:0,eventsBefore:0,assetsBefore:0,linksBefore:0});
      if(db.pragma('foreign_key_check').length)throw new Error(`迁移${tag}后foreign_key_check失败`);
      db.prepare('INSERT INTO __drizzle_migrations_applied (tag, applied_at) VALUES (?, ?)').run(
        tag,
        new Date().toISOString(),
      );
    });
    apply();
    console.log(`migrate: applied ${tag} (${statements.length} statements)`);
  }

  // 4) 记录 schema 版本（与 db/migrations 清单同步计数）
  const total = tags.length;
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(total));
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`${total}:${pending[pending.length - 1]}`);

  // 5) 完整性检查
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    console.error('migrate: integrity_check FAILED', integrity);
    process.exit(1);
  }
  console.log('migrate: integrity_check ok');
  console.log(`migrate: done -> ${DB_PATH} (schema_version=${total})`);
  db.close();
}

main();
