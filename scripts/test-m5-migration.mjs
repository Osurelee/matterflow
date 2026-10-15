#!/usr/bin/env node
/** M5-01 isolated legacy-project migration proof. Never opens the user's normal DB. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migrationDir=path.join(ROOT,'db','migrations');
const journal=JSON.parse(readFileSync(path.join(migrationDir,'meta','_journal.json'),'utf8'));
const M5_TAG='0009_m5_01_independent_items';
const legacyTags=journal.entries.map(e=>e.tag).filter(tag=>tag!==M5_TAG&&tag!=='0010_m5_03_tree_guards'&&tag!=='0011_m5_04_structure_batches'&&tag!=='0012_m5_02_project_sections'&&tag!=='0013_m5_09_task_references');
function hash(file){return createHash('sha256').update(readFileSync(file)).digest('hex')}
function seedLegacy(file,{archivedActive=false}={}){
 const db=new Database(file);db.pragma('foreign_keys=ON');
 db.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
 CREATE TABLE __drizzle_migrations_applied(id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,tag TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL);`);
 for(const tag of legacyTags){const text=readFileSync(path.join(migrationDir,`${tag}.sql`),'utf8');for(const part of text.split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))db.exec(part);db.prepare('INSERT INTO __drizzle_migrations_applied(tag,applied_at) VALUES(?,?)').run(tag,new Date().toISOString())}
 db.prepare("INSERT INTO app_meta(key,value) VALUES('schema_version',?)").run(String(legacyTags.length));
 const now='2026-10-13T00:00:00.000Z';const owner=randomUUID();const space=randomUUID();const p1=randomUUID();const p2=randomUUID();
 db.prepare('INSERT INTO users(id,username,password_hash,timezone,auth_version,created_at) VALUES(?,?,?,?,1,?)').run(owner,'m5test','not-a-login-hash','Asia/Shanghai',now);
 db.prepare('INSERT INTO spaces(id,owner_user_id,name,description,is_default,archived_at,version,created_at,updated_at) VALUES(?,?,?,\'\',1,NULL,1,?,?)').run(space,owner,'private',now,now);
 db.prepare('INSERT INTO projects(id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(p1,owner,space,'Active project','目标正文\n验收条件',null,3,now,now);
 db.prepare('INSERT INTO projects(id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(p2,owner,space,'Archived project','历史项目说明','2026-10-12T00:00:00.000Z',2,now,now);
 const insertTask=db.prepare(`INSERT INTO tasks(id,owner_user_id,space_id,project_id,title,description,description_format,description_plain,status,is_processed,handling_mode,counterpart_name,created_at,updated_at,version,completed_at,cancelled_at)
 VALUES(?,?,?,?,?,?,'plaintext',?, ?,1,'self','',?,?,?, ?,NULL)`);
 const taskRows=[
  {id:randomUUID(),project:p1,title:'Legacy todo',description:'子事项正文',status:'todo',completed:null},
  {id:randomUUID(),project:p1,title:'Legacy done',description:'完成记录',status:'done',completed:now},
  {id:randomUUID(),project:p2,title:'Archived child',description:'归档子项',status:archivedActive?'todo':'done',completed:archivedActive?null:now},
  {id:randomUUID(),project:null,title:'Unprojected task',description:'不挂项目',status:'todo',completed:null},
 ];
 for(const row of taskRows)insertTask.run(row.id,owner,space,row.project,row.title,row.description,row.description, row.status,now,now,7,row.completed);
 const eventInsert=db.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)');
 const revisionInsert=db.prepare("INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,'plaintext',?,?,1,?,?)");
 for(const row of taskRows){eventInsert.run(randomUUID(),owner,row.id,owner,'task_created',JSON.stringify({schemaVersion:1,title:row.title}),now,randomUUID());if(row.description)revisionInsert.run(randomUUID(),owner,row.id,row.description,row.description,randomUUID(),now)}
 const imageAsset=randomUUID();db.prepare('INSERT INTO assets(id,owner_user_id,upload_request_id,original_name,mime_type,byte_size,sha256,storage_key,status,created_at,duration_ms) VALUES(?,?,?,?,?,8,?,?,?,?,NULL)').run(imageAsset,owner,randomUUID(),'legacy.png','image/png','a'.repeat(64),randomUUID(),'ready',now);
 const linkId=randomUUID();db.prepare("INSERT INTO task_asset_links(id,owner_user_id,task_id,asset_id,role,created_at) VALUES(?,?,?,?,'attachment',?)").run(linkId,owner,taskRows[0].id,imageAsset,now);
 const snapshot={owner,space,projects:[p1,p2],tasks:taskRows,assetId:imageAsset,linkId};db.close();return snapshot;
}
function runMigration(dbPath){return spawnSync(process.execPath,[path.join(ROOT,'scripts/migrate.mjs')],{cwd:ROOT,encoding:'utf8',timeout:120000,env:{...process.env,NODE_ENV:'production',TASKS_DB_PATH:dbPath}})}
const temp=mkdtempSync(path.join(tmpdir(),'tasks-m5-01-'));
try{
 const goodPath=path.join(temp,'legacy-good.db');const fixture=seedLegacy(goodPath);const before=new Database(goodPath,{readonly:true});
 const beforeTaskRows=before.prepare('SELECT id,title,description,status,version,project_id FROM tasks ORDER BY id').all();const eventsBefore=before.prepare('SELECT count(*) n FROM task_events').get().n;const revisionsBefore=before.prepare('SELECT count(*) n FROM task_body_revisions').get().n;const assetsBefore=before.prepare('SELECT count(*) n FROM assets').get().n;const linksBefore=before.prepare('SELECT id,task_id,asset_id,role FROM task_asset_links').all();before.close();
 const migrated=runMigration(goodPath);assert.equal(migrated.status,0,`${migrated.stdout}\n${migrated.stderr}`);assert.match(migrated.stdout,/M5-01 project roots: projects=2/);
 const db=new Database(goodPath,{readonly:true});db.pragma('foreign_keys=ON');
 const projects=db.prepare('SELECT id,name,description,archived_at,root_task_id,status,is_paused,version FROM projects ORDER BY id').all();assert.equal(projects.length,2);assert.ok(projects.every(p=>p.root_task_id&&p.status==='active'&&p.is_paused===0));
 const tasksAfter=db.prepare('SELECT id,title,description,status,version,project_id,parent_id,space_id,structure_version FROM tasks ORDER BY id').all();assert.equal(tasksAfter.length,beforeTaskRows.length+projects.length);
 for(const old of beforeTaskRows){const current=tasksAfter.find(t=>t.id===old.id);assert.ok(current,`legacy task ID preserved ${old.id}`);assert.equal(current.title,old.title);assert.equal(current.description,old.description);assert.equal(current.status,old.status);assert.equal(current.version,old.version);assert.equal(current.project_id,old.project_id);if(old.project_id){const project=projects.find(p=>p.id===old.project_id);assert.equal(current.parent_id,project.root_task_id)}else assert.equal(current.parent_id,null)}
 for(const project of projects){const root=tasksAfter.find(t=>t.id===project.root_task_id);assert.ok(root);assert.equal(root.title,project.name);assert.equal(root.description,project.description);assert.equal(root.project_id,project.id);assert.equal(root.version,1);assert.equal(root.structure_version,1);assert.equal(root.parent_id,null);assert.equal(root.status,'todo');}
 const archivedProject=projects.find(p=>p.name==='Archived project');const archivedRoot=db.prepare('SELECT archived_at FROM tasks WHERE id=?').get(archivedProject.root_task_id);assert.equal(archivedRoot.archived_at,'2026-10-12T00:00:00.000Z');
 assert.equal(db.prepare('SELECT count(*) n FROM task_events').get().n,eventsBefore+projects.length,'only new roots get migration-tagged creation events');assert.equal(db.prepare('SELECT count(*) n FROM task_body_revisions').get().n,revisionsBefore+projects.filter(p=>p.description).length);
 assert.equal(db.prepare('SELECT count(*) n FROM assets').get().n,assetsBefore);assert.deepEqual(db.prepare('SELECT id,task_id,asset_id,role FROM task_asset_links').all(),linksBefore);
 const report=db.prepare('SELECT projects_migrated,legacy_tasks_preserved,root_tasks_created,events_before,events_after,assets_before,assets_after,links_before,links_after,report_json FROM m5_migration_reports WHERE id=?').get('m5-01-project-roots-v1');assert.equal(report.projects_migrated,2);assert.equal(report.legacy_tasks_preserved,beforeTaskRows.length);assert.equal(report.root_tasks_created,2);assert.equal(report.assets_before,report.assets_after);assert.equal(report.links_before,report.links_after);
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.equal(db.pragma('foreign_key_check').length,0);assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get().value,'14');db.close();

 const badPath=path.join(temp,'legacy-conflict.db');seedLegacy(badPath,{archivedActive:true});const badHash=hash(badPath);const bad=runMigration(badPath);assert.notEqual(bad.status,0,'archived project with active child must stop precheck');assert.match(`${bad.stdout}${bad.stderr}`,/归档项目仍含活跃事项/);assert.equal(hash(badPath),badHash,'precheck failure must leave database bytes unchanged');assert.deepEqual(readdirSync(temp).filter(name=>name.startsWith('legacy-conflict.db.pre-migration-')),[],'precheck failure must not create backup or mutate filesystem');
 console.log('M5-01 isolated legacy project migration: PASS (IDs/body/status/events/assets/FKs/precheck rollback)');
}finally{rmSync(temp,{recursive:true,force:true})}
