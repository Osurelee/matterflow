#!/usr/bin/env node
/** Reproducible M1 isolated integration suite. Never points at the user's normal DB. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import Database from 'better-sqlite3';
import { loadEnvFiles, resolveDbPath } from './lib/env.mjs';
import { resetOwnerPassword, validatePasswordLength, verifyPassword } from './lib/account-password.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const TEST_PASSWORD = 'M1-isolated-test-password-3581!';
const NEXT_BIN = path.join(ROOT, 'node_modules/next/dist/bin/next');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'tasks-m1-suite-'));
const dbPath = path.join(tempRoot, 'tasks.db');
const backupDir = path.join(tempRoot, 'backups');
let server;
let secondServer;
let serverLog;
let cookie;
let taskId;

function command(args, env = process.env, cwd = ROOT) {
  const result = spawnSync(NODE, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
}
function assertCommandOk(result, label) {
  assert.equal(result.status, 0, `${label} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
}
function envFor(port, publicOrigin = `http://localhost:${port}`, databasePath = dbPath) {
  return { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: databasePath, TASKS_MEDIA_DIR:path.join(tempRoot,'media'), TASKS_PUBLIC_ORIGIN: publicOrigin, TASKS_BACKUP_DIR: backupDir };
}
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  return port;
}
async function launch(port, withOrigin = true, databasePath = dbPath) {
  const env = envFor(port, withOrigin ? `http://localhost:${port}` : '', databasePath);
  if (!withOrigin) delete env.TASKS_PUBLIC_ORIGIN;
  serverLog = path.join(tempRoot, `next-${port}.log`);
  const out = (await import('node:fs')).createWriteStream(serverLog, { flags: 'a' });
  const child = spawn(NODE, [NEXT_BIN, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out); child.stderr.pipe(out);
  const base = `http://127.0.0.1:${port}/tasks/api`;
  let ready = false;
  for (let i=0;i<80;i++) {
    if (child.exitCode !== null) throw new Error(`next server exited: ${readFileSync(serverLog,'utf8')}`);
    try { const response = await fetch(`${base}/healthz`); if (response.ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  assert.ok(ready, `server not ready: ${readFileSync(serverLog,'utf8')}`);
  return { child, base, origin: `http://localhost:${port}` };
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function call(serverInfo, route, { method='GET', body, cookieValue=cookie, origin=serverInfo.origin, headers={} } = {}) {
  const h = { ...headers };
  if (origin !== null) h.Origin = origin;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookieValue) h.Cookie = cookieValue;
  const response = await fetch(`${serverInfo.base}${route}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const raw = await response.text();
  let json; try { json = JSON.parse(raw); } catch { json = raw; }
  return { response, status: response.status, json };
}
function expectSuccess(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.ok(result.json && result.json.data, JSON.stringify(result.json));
  assert.match(result.json.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
}
function expectError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json?.error?.code, code, JSON.stringify(result.json));
  assert.match(result.json.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
}

async function verifyEnvParity() {
  const project = path.join(tempRoot, 'env-project'); mkdirSync(project);
  writeFileSync(path.join(project, '.env.local'), 'M1_BASE=/tmp/m1-env-value\nTASKS_DATA_DIR="$M1_BASE/data" # inline comment\n');
  const original = { M1_BASE:process.env.M1_BASE, TASKS_DATA_DIR:process.env.TASKS_DATA_DIR, TASKS_DB_PATH:process.env.TASKS_DB_PATH };
  delete process.env.M1_BASE; delete process.env.TASKS_DATA_DIR; delete process.env.TASKS_DB_PATH;
  try {
    loadEnvFiles(project);
    assert.equal(resolveDbPath(), '/tmp/m1-env-value/data/tasks.db');
    process.env.TASKS_DB_PATH = '/tmp/m1-explicit.db';
    assert.equal(resolveDbPath(), '/tmp/m1-explicit.db');
  } finally {
    for (const [key,value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key]=value;
  }
  const drizzle = command([path.join(ROOT,'node_modules/drizzle-kit/bin.cjs'),'check'],{...process.env,NODE_ENV:'development'});
  assertCommandOk(drizzle,'drizzle-kit check');
}
async function verifyMigrationPreflight() {
  const root = path.join(tempRoot,'migrations-copy'); mkdirSync(root);
  cpSync(path.join(ROOT,'scripts'),path.join(root,'scripts'),{recursive:true});
  cpSync(path.join(ROOT,'db'),path.join(root,'db'),{recursive:true});
  symlinkSync(path.join(ROOT,'node_modules'),path.join(root,'node_modules'),'dir');
  const journalPath=path.join(root,'db/migrations/meta/_journal.json');
  const journal=JSON.parse(readFileSync(journalPath,'utf8'));
  journal.entries.push({...journal.entries.at(-1),idx:journal.entries.length,tag:'0002_missing',when:Date.now()});
  writeFileSync(journalPath,JSON.stringify(journal,null,2));
  const missingDb=path.join(root,'not-created','test.db');
  const missing=command([path.join(root,'scripts/migrate.mjs')],{...process.env,TASKS_DB_PATH:missingDb,NODE_ENV:'production'},root);
  assert.notEqual(missing.status,0); assert.equal(existsSync(path.dirname(missingDb)),false);
  cpSync(path.join(ROOT,'db/migrations'),path.join(root,'db/migrations'),{recursive:true,force:true});
  const newerDb=path.join(root,'newer.db');
  assertCommandOk(command([path.join(root,'scripts/migrate.mjs')],{...process.env,TASKS_DB_PATH:newerDb,NODE_ENV:'production'},root),'isolated migration');
  const olderCatalog=JSON.parse(readFileSync(journalPath,'utf8')); olderCatalog.entries=olderCatalog.entries.slice(0,1); writeFileSync(journalPath,JSON.stringify(olderCatalog,null,2));
  const before=createHash('sha256').update(readFileSync(newerDb)).digest('hex');
  const outdated=command([path.join(root,'scripts/migrate.mjs')],{...process.env,TASKS_DB_PATH:newerDb,NODE_ENV:'production'},root);
  assert.notEqual(outdated.status,0);
  assert.match(outdated.stderr+outdated.stdout,/未知的迁移|比代码新/);
  const after=createHash('sha256').update(readFileSync(newerDb)).digest('hex'); assert.equal(after,before);
}

async function runApiSuite() {
  const port=await freePort();
  const api=await launch(port,true); server=api.child;
  const health=await call(api,'/healthz'); assert.equal(health.status,200);
  expectError(await call(api,'/auth/me',{cookieValue:null}),401,'UNAUTHENTICATED');
  expectError(await call(api,'/system/backup-status',{cookieValue:null}),401,'UNAUTHENTICATED');
  expectError(await call(api,'/auth/me',{cookieValue:'tasks_session=invalid'}),401,'UNAUTHENTICATED');
  expectError(await call(api,'/auth/login',{method:'POST',cookieValue:null,origin:null,body:{username:'owner',password:'bad'}}),403,'BAD_ORIGIN');
  expectError(await call(api,'/tasks',{method:'POST',cookieValue:null,body:{requestId:randomUUID(),title:'unauth',spaceId:'x'}}),401,'UNAUTHENTICATED');
  expectError(await call(api,'/auth/login',{method:'POST',cookieValue:null,origin:'http://attacker.invalid',body:{username:'owner',password:'bad'}}),403,'BAD_ORIGIN');
  const wrong=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'wrong-password-test'}});
  expectError(wrong,401,'INVALID_CREDENTIALS');
  assert.equal(wrong.json.error.message,'用户名或密码错误');
  const tooLarge=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:JSON.stringify({username:'x',password:'a'.repeat(8300)})});
  expectError(tooLarge,413,'BODY_TOO_LARGE');

  const login=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:TEST_PASSWORD}});
  expectSuccess(login,200);
  const setCookies=login.response.headers.getSetCookie();
  assert.ok(setCookies.length);
  const setCookie=setCookies.find((v)=>v.startsWith('tasks_session=')); assert.ok(setCookie);
  for (const flag of ['HttpOnly','Secure','SameSite=lax','Path=/tasks']) assert.ok(setCookie.toLowerCase().includes(flag.toLowerCase()),setCookie);
  cookie=setCookie.split(';')[0];
  const token=cookie.slice(cookie.indexOf('=')+1);
  const db=new Database(dbPath);
  try {
    const row=db.prepare('SELECT id_hash FROM sessions LIMIT 1').get();
    assert.ok(row); assert.notEqual(row.id_hash,token); assert.equal(row.id_hash,createHash('sha256').update(token).digest('hex'));
    const expiredToken='expired-session-token-for-test';
    db.prepare('INSERT INTO sessions(id_hash,user_id,auth_version,expires_at,created_at) SELECT ?,id,auth_version,?,? FROM users WHERE username=?').run(createHash('sha256').update(expiredToken).digest('hex'),new Date(Date.now()-60000).toISOString(),new Date(Date.now()-120000).toISOString(),'owner');
  } finally { db.close(); }
  expectError(await call(api,'/auth/me',{cookieValue:'tasks_session=expired-session-token-for-test'}),401,'UNAUTHENTICATED');
  expectSuccess(await call(api,'/auth/me'),200);
  expectSuccess(await call(api,'/system/backup-status'),200); assert.equal((await call(api,'/system/backup-status')).json.data.latest,null);

  // Password reset helper must revoke pre-existing sessions and rate-limit rows.
  const extraToken='extra-session-token-for-reset-test';
  const resetDb=new Database(dbPath);
  try {
    resetDb.prepare('INSERT INTO sessions(id_hash,user_id,auth_version,expires_at,created_at) SELECT ?,id,auth_version,?,? FROM users WHERE username=?').run(createHash('sha256').update(extraToken).digest('hex'),new Date(Date.now()+60000).toISOString(),new Date().toISOString(),'owner');
    resetDb.prepare('INSERT INTO auth_rate_limits(key_hash,window_start,failure_count) VALUES(?,?,1)').run('reset-test-rate',new Date().toISOString());
    const sessionsBefore=resetDb.prepare('SELECT count(*) n FROM sessions').get().n;
    assert.ok(sessionsBefore >= 3);
    assert.equal(validatePasswordLength('short').ok,false);
    assert.equal(validatePasswordLength('😀'.repeat(80)).ok,true);
    assert.equal(validatePasswordLength('😀'.repeat(128)).ok,true);
    assert.equal(validatePasswordLength('😀'.repeat(129)).ok,false);
    assert.throws(()=>resetOwnerPassword(resetDb,'short'),/12–128码点/);
    assert.equal(resetDb.prepare('SELECT count(*) n FROM sessions').get().n,sessionsBefore);
    assert.equal(resetDb.prepare('SELECT auth_version FROM users WHERE username=?').get('owner').auth_version,1);
    const result=resetOwnerPassword(resetDb,'M1-reset-test-password-9732!'); assert.equal(result.authVersion,2);
    assert.equal(resetDb.prepare('SELECT count(*) n FROM sessions').get().n,0);
    assert.equal(resetDb.prepare('SELECT count(*) n FROM auth_rate_limits').get().n,0);
    assert.ok(verifyPassword('M1-reset-test-password-9732!',resetDb.prepare('SELECT password_hash FROM users WHERE username=?').get('owner').password_hash));
  } finally { resetDb.close(); }
  expectError(await call(api,'/auth/me'),401,'UNAUTHENTICATED');
  const resetLogin=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'M1-reset-test-password-9732!'}});
  expectSuccess(resetLogin,200); cookie=resetLogin.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')).split(';')[0];

  const initialInbox=await call(api,'/tasks?view=inbox'); expectSuccess(initialInbox,200); assert.equal(initialInbox.json.data.total,0);
  const titleOnlyId=randomUUID();
  const titleOnly=await call(api,'/tasks',{method:'POST',body:{requestId:titleOnlyId,title:'只有标题也能快速记录'}}); expectSuccess(titleOnly,201);
  const persistedId=titleOnly.json.data.id;
  const detailBefore=await call(api,'/tasks/'+persistedId); expectSuccess(detailBefore,200);
  assert.equal(detailBefore.json.data.title,'只有标题也能快速记录'); assert.equal(detailBefore.json.data.spaceName,'私人'); assert.equal(detailBefore.json.data.status,'todo'); assert.equal(detailBefore.json.data.isProcessed,false);
  const defaultsDb=new Database(dbPath,{readonly:true}); try { const row=defaultsDb.prepare('SELECT space_id,project_id,status,is_processed,responsible_kind,action_kind FROM tasks WHERE id=?').get(persistedId); assert.equal(row.project_id,null); assert.equal(row.status,'todo'); assert.equal(row.is_processed,0); assert.equal(row.responsible_kind,'self'); assert.equal(row.action_kind,'self'); } finally { defaultsDb.close(); }
  const processId=randomUUID();
  const processed=await call(api,'/tasks/'+persistedId+'/process',{method:'POST',body:{requestId:processId,expectedVersion:1}}); expectSuccess(processed,200); assert.equal(processed.json.data.isProcessed,true); assert.equal(processed.json.data.version,2);
  const processReplay=await call(api,'/tasks/'+persistedId+'/process',{method:'POST',body:{requestId:processId,expectedVersion:1}}); expectSuccess(processReplay,200); assert.equal(processReplay.response.headers.get('idempotency-replayed'),'true');
  const inboxAfter=await call(api,'/tasks?view=inbox'); expectSuccess(inboxAfter,200); assert.equal(inboxAfter.json.data.total,0);
  const allAfter=await call(api,'/tasks?view=all'); expectSuccess(allAfter,200); assert.ok(allAfter.json.data.items.some((item)=>item.id===persistedId&&item.isProcessed));
  const rename=await call(api,'/tasks/'+persistedId,{method:'PATCH',body:{requestId:randomUUID(),title:'整理好的标题',expectedVersion:2}}); expectSuccess(rename,200);
  assert.equal((await call(api,'/tasks/'+persistedId)).json.data.title,'整理好的标题');

  // M4-05 media upload, idempotency, private attachment read, soft removal and file download.
  const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p5sAAAAASUVORK5CYII=','base64');
  const uploadId=randomUUID();
  async function uploadFixture(name,type,bytes,requestId=uploadId,durationMs=null) {
    const form=new FormData();form.set('requestId',requestId);if(durationMs!==null)form.set('durationMs',String(durationMs));form.set('file',new Blob([bytes],{type}),name);
    const response=await fetch(`${api.base}/uploads`,{method:'POST',headers:{Origin:api.origin,Cookie:cookie},body:form});
    const raw=await response.text();let json;try{json=JSON.parse(raw)}catch{json=raw};return {response,status:response.status,json};
  }
  const mediaFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'M4 media isolated fixture'}});expectSuccess(mediaFixture,201);const mediaTaskId=mediaFixture.json.data.id;
  const imageUpload=await uploadFixture('pixel.png','image/png',pngBytes);expectSuccess(imageUpload,201);
  assert.equal(imageUpload.json.data.kind,'image');assert.equal(imageUpload.json.data.byteSize,pngBytes.length);
  const imageReplay=await uploadFixture('pixel.png','image/png',pngBytes);expectSuccess(imageReplay,201);assert.equal(imageReplay.json.data.id,imageUpload.json.data.id,'同上传requestId重放不重复存储');
  const reused=await uploadFixture('different.png','image/png',Buffer.concat([pngBytes,Buffer.from('different')]),uploadId);expectError(reused,409,'REQUEST_ID_REUSED');
  let currentVersion=(await call(api,'/tasks/'+mediaTaskId)).json.data.version;
  const attach=await call(api,'/tasks/'+mediaTaskId+'/attachments',{method:'POST',body:{requestId:randomUUID(),assetId:imageUpload.json.data.id,expectedVersion:currentVersion}});expectSuccess(attach,200);currentVersion=attach.json.data.version;
  const imageList=await call(api,'/tasks/'+mediaTaskId+'/attachments');expectSuccess(imageList,200);assert.equal(imageList.json.data.items.length,1);assert.equal(imageList.json.data.items[0].mimeType,'image/png');
  const privateRead=await fetch(`${api.base}/assets/${imageUpload.json.data.id}/content`,{headers:{Cookie:cookie}});assert.equal(privateRead.status,200);assert.equal(privateRead.headers.get('cache-control'),'no-store');assert.equal(Buffer.from(await privateRead.arrayBuffer()).compare(pngBytes),0);
  const privateDenied=await fetch(`${api.base}/assets/${imageUpload.json.data.id}/content`);assert.equal(privateDenied.status,401);
  const convertEmpty=await call(api,`/tasks/${mediaTaskId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:currentVersion,description:'',descriptionFormat:'markdown_v1',convertFromPlaintext:true}});expectSuccess(convertEmpty,200);currentVersion=convertEmpty.json.data.version;
  const imageMarkdown=`![pixel](asset:${imageUpload.json.data.id})`;
  const bodyWithAsset=await call(api,`/tasks/${mediaTaskId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:currentVersion,description:imageMarkdown,descriptionFormat:'markdown_v1'}});expectSuccess(bodyWithAsset,200);currentVersion=bodyWithAsset.json.data.version;
  const guardedRemove=await call(api,`/tasks/${mediaTaskId}/attachments/${attach.json.data.linkId}`,{method:'DELETE',body:{requestId:randomUUID(),expectedVersion:currentVersion}});expectError(guardedRemove,409,'ASSET_REFERENCED');
  const clearBody=await call(api,`/tasks/${mediaTaskId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:currentVersion,description:'',descriptionFormat:'markdown_v1'}});expectSuccess(clearBody,200);currentVersion=clearBody.json.data.version;
  const removed=await call(api,`/tasks/${mediaTaskId}/attachments/${attach.json.data.linkId}`,{method:'DELETE',body:{requestId:randomUUID(),expectedVersion:currentVersion}});expectSuccess(removed,200);currentVersion=removed.json.data.version;
  const gone=await fetch(`${api.base}/assets/${imageUpload.json.data.id}/content`,{headers:{Cookie:cookie}});assert.equal(gone.status,404,'移除关联后不能再读取附件');
  const pdfBytes=Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF','ascii');
  const pdfUpload=await uploadFixture('note.pdf','application/pdf',pdfBytes,randomUUID());expectSuccess(pdfUpload,201);assert.equal(pdfUpload.json.data.kind,'file');
  const pdfAttach=await call(api,'/tasks/'+mediaTaskId+'/attachments',{method:'POST',body:{requestId:randomUUID(),assetId:pdfUpload.json.data.id,expectedVersion:currentVersion}});expectSuccess(pdfAttach,200);currentVersion=pdfAttach.json.data.version;
  const pdfResponse=await fetch(`${api.base}/assets/${pdfUpload.json.data.id}/content`,{headers:{Cookie:cookie}});assert.equal(pdfResponse.status,200);assert.match(pdfResponse.headers.get('content-disposition')||'',/attachment/);assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).compare(pdfBytes),0);
  const assetStorageDb=new Database(dbPath,{readonly:true});let storageKey;try{storageKey=assetStorageDb.prepare('SELECT storage_key FROM assets WHERE id=?').get(pdfUpload.json.data.id).storage_key}finally{assetStorageDb.close()}
  assert.equal(statSync(path.join(tempRoot,'media',storageKey)).mode&0o777,0o600,'媒体文件权限应为0600');assert.equal(statSync(path.join(tempRoot,'media')).mode&0o777,0o700,'媒体目录权限应为0700');
  const archivedMedia=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'媒体归档守卫'}});expectSuccess(archivedMedia,201);
  const mediaGuardDb=new Database(dbPath);try{mediaGuardDb.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(new Date().toISOString(),archivedMedia.json.data.id)}finally{mediaGuardDb.close()}
  expectError(await call(api,`/tasks/${archivedMedia.json.data.id}/attachments`,{method:'POST',body:{requestId:randomUUID(),assetId:pdfUpload.json.data.id,expectedVersion:1}}),409,'TASK_ARCHIVED');
  const webmBytes=Buffer.from([0x1a,0x45,0xdf,0xa3,0x93,0x42,0x86,0x81,0x01,0x42,0xf7,0x81,0x01,0x42,0xf2,0x81,0x04,0x42,0xf3,0x81,0x08]);
  const audioUpload=await uploadFixture('voice.webm','audio/webm',webmBytes,randomUUID(),3456);expectSuccess(audioUpload,201);assert.equal(audioUpload.json.data.kind,'audio');assert.equal(audioUpload.json.data.durationMs,3456);
  const captureRequestId=randomUUID();
  const audioCapture=await call(api,'/captures',{method:'POST',body:{requestId:captureRequestId,title:'音频快速捕获',assetIds:[audioUpload.json.data.id]}});expectSuccess(audioCapture,201);assert.deepEqual(audioCapture.json.data.attachedAssetIds,[audioUpload.json.data.id]);
  const captureReplay=await call(api,'/captures',{method:'POST',body:{requestId:captureRequestId,title:'音频快速捕获',assetIds:[audioUpload.json.data.id]}});expectSuccess(captureReplay,200);assert.equal(captureReplay.json.data.id,audioCapture.json.data.id);
  const captureAssets=await call(api,`/tasks/${audioCapture.json.data.id}/attachments`);assert.equal(captureAssets.json.data.items.length,1);assert.equal(captureAssets.json.data.items[0].durationMs,3456);
  const sourceCaptureRequest=randomUUID();const sourceCapture=await call(api,'/captures',{method:'POST',body:{requestId:sourceCaptureRequest,title:'来源捕获单项',description:'捕获正文保留',sourceUrl:'https://example.test/article?q=1',sourceLabel:'测试来源'}});expectSuccess(sourceCapture,201);
  const sourceDetail=await call(api,`/tasks/${sourceCapture.json.data.id}`);assert.equal(sourceDetail.json.data.description,'捕获正文保留');assert.equal(sourceDetail.json.data.sourceUrl,'https://example.test/article?q=1');assert.equal(sourceDetail.json.data.sourceLabel,'测试来源');
  const sourceReplay=await call(api,'/captures',{method:'POST',body:{requestId:sourceCaptureRequest,title:'来源捕获单项',description:'捕获正文保留',sourceUrl:'https://example.test/article?q=1',sourceLabel:'测试来源'}});expectSuccess(sourceReplay,200);assert.equal(sourceReplay.json.data.id,sourceCapture.json.data.id);
  const batchRequest=randomUUID();const batchBody={requestId:batchRequest,sourceUrl:'https://example.test/list',sourceLabel:'批量来源',rows:[{title:'批量事项甲'},{title:'批量事项乙'}]};
  const batch=await call(api,'/capture-batches',{method:'POST',body:batchBody});expectSuccess(batch,201);assert.equal(batch.json.data.items.length,2);assert.equal(dbCount('SELECT count(*) FROM capture_batch_items WHERE batch_id=?',batch.json.data.batchId),2);
  const batchReplay=await call(api,'/capture-batches',{method:'POST',body:batchBody});expectSuccess(batchReplay,200);assert.equal(batchReplay.json.data.batchId,batch.json.data.batchId);assert.equal(dbCount('SELECT count(*) FROM capture_batch_items WHERE batch_id=?',batch.json.data.batchId),2);
  const beforeInvalidBatch=dbCount('SELECT count(*) FROM tasks');const invalidBatch=await call(api,'/capture-batches',{method:'POST',body:{requestId:randomUUID(),sourceUrl:'javascript:alert(1)',rows:[{title:'不会保存甲'},{title:'不会保存乙'}]}});expectError(invalidBatch,400,'INVALID_SOURCE_URL');assert.equal(dbCount('SELECT count(*) FROM tasks'),beforeInvalidBatch,'无效来源应整批回滚');
  const beforeBadAssetCapture=dbCount('SELECT count(*) FROM tasks');const badAssetCapture=await call(api,'/captures',{method:'POST',body:{requestId:randomUUID(),title:'无效媒体不得保存',description:'正文应保留在客户端',assetIds:[randomUUID()]}});expectError(badAssetCapture,404,'ASSET_NOT_FOUND');assert.equal(dbCount('SELECT count(*) FROM tasks'),beforeBadAssetCapture,'媒体关联失败不应留下半个Task');
  const progressAudio=await uploadFixture('progress.webm','audio/webm',webmBytes,randomUUID(),4567);expectSuccess(progressAudio,201);
  const progressAppend=await call(api,`/tasks/${mediaTaskId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:currentVersion,text:'',assetIds:[progressAudio.json.data.id]}});expectSuccess(progressAppend,200);currentVersion=progressAppend.json.data.version;assert.equal(progressAppend.json.data.attachedAssetIds[0],progressAudio.json.data.id);
  const progressEvents=await call(api,`/tasks/${mediaTaskId}/events`);const audioEvent=progressEvents.json.data.items.find(event=>event.id===progressAppend.json.data.eventId);assert.equal(audioEvent.type,'task_progress_appended');assert.equal(audioEvent.payload.mediaAttachments[0].durationMs,4567);
  const audioRange=await fetch(`${api.base}/assets/${progressAudio.json.data.id}/content`,{headers:{Cookie:cookie,Range:'bytes=0-5'}});assert.equal(audioRange.status,206);assert.equal((await audioRange.arrayBuffer()).byteLength,6);assert.equal(audioRange.headers.get('cache-control'),'no-store');
  const removedProgressAudio=await call(api,`/tasks/${mediaTaskId}/attachments/${audioEvent.payload.mediaAttachments[0].linkId}`,{method:'DELETE',body:{requestId:randomUUID(),expectedVersion:currentVersion}});expectSuccess(removedProgressAudio,200);currentVersion=removedProgressAudio.json.data.version;
  const placeholderEvents=await call(api,`/tasks/${mediaTaskId}/events`);const placeholder=placeholderEvents.json.data.items.find(event=>event.id===progressAppend.json.data.eventId);assert.ok(placeholder.payload.mediaAttachments[0].removedAt,'移除进展附件后保留历史占位');
  const removedProgressRead=await fetch(`${api.base}/assets/${progressAudio.json.data.id}/content`,{headers:{Cookie:cookie}});assert.equal(removedProgressRead.status,404);
  const badDuration=await uploadFixture('bad.webm','audio/webm',webmBytes,randomUUID(),300001);expectError(badDuration,400,'INVALID_INPUT');
  const badType=await uploadFixture('spoof.png','image/png',Buffer.from('not really a png'),randomUUID());expectError(badType,400,'UNSUPPORTED_MEDIA');

  // Archived tasks and containers reject new title writes without side effects.
  const archivedFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'archive guard fixture'}}); expectSuccess(archivedFixture,201);
  const archivedId=archivedFixture.json.data.id;
  const archiveDb=new Database(dbPath);
  const archiveNow=new Date().toISOString();
  try {
    const before=archiveDb.prepare('SELECT title,version FROM tasks WHERE id=?').get(archivedId);
    const beforeEvents=archiveDb.prepare('SELECT count(*) n FROM task_events WHERE task_id=?').get(archivedId).n;
    const beforeMutations=archiveDb.prepare('SELECT count(*) n FROM mutation_requests WHERE user_id=(SELECT owner_user_id FROM tasks WHERE id=?)').get(archivedId).n;
    archiveDb.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(archiveNow,archivedId);
    const rejectedTask=await call(api,'/tasks/'+archivedId,{method:'PATCH',body:{requestId:randomUUID(),title:'must not change',expectedVersion:before.version}}); expectError(rejectedTask,409,'TASK_ARCHIVED');
    assert.deepEqual(archiveDb.prepare('SELECT title,version FROM tasks WHERE id=?').get(archivedId),before);
    assert.equal(archiveDb.prepare('SELECT count(*) n FROM task_events WHERE task_id=?').get(archivedId).n,beforeEvents);
    assert.equal(archiveDb.prepare('SELECT count(*) n FROM mutation_requests WHERE user_id=(SELECT owner_user_id FROM tasks WHERE id=?)').get(archivedId).n,beforeMutations);
    archiveDb.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(archivedId);
    const spaceId=randomUUID(); const ownerId=archiveDb.prepare('SELECT owner_user_id owner FROM tasks WHERE id=?').get(archivedId).owner;
    archiveDb.prepare('INSERT INTO spaces(id,owner_user_id,name,description,is_default,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,0,NULL,1,?,?)').run(spaceId,ownerId,'archive-guard-space','',archiveNow,archiveNow);
    archiveDb.prepare('UPDATE tasks SET space_id=? WHERE id=?').run(spaceId,archivedId);
    archiveDb.prepare('UPDATE spaces SET archived_at=? WHERE id=?').run(archiveNow,spaceId);
    const rejectedSpace=await call(api,'/tasks/'+archivedId,{method:'PATCH',body:{requestId:randomUUID(),title:'space archived',expectedVersion:before.version}}); expectError(rejectedSpace,409,'CONTAINER_ARCHIVED');
    archiveDb.prepare('UPDATE spaces SET archived_at=NULL WHERE id=(SELECT space_id FROM tasks WHERE id=?)').run(archivedId);
    const projectId=randomUUID(); const projectOwner=archiveDb.prepare('SELECT owner_user_id owner,space_id space FROM tasks WHERE id=?').get(archivedId);
    archiveDb.prepare('INSERT INTO projects(id,owner_user_id,space_id,name,description,archived_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(projectId,projectOwner.owner,projectOwner.space,'archive-guard-project','',null,1,archiveNow,archiveNow);
    archiveDb.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(projectId,archivedId);
    archiveDb.prepare('UPDATE projects SET archived_at=? WHERE id=?').run(archiveNow,projectId);
    const rejectedProject=await call(api,'/tasks/'+archivedId,{method:'PATCH',body:{requestId:randomUUID(),title:'project archived',expectedVersion:before.version}}); expectError(rejectedProject,409,'CONTAINER_ARCHIVED');
  } finally { archiveDb.close(); }

  // M2-03 lifecycle rules, reasons, side effects, and idempotent replay.
  const lifecycleId=persistedId;
  const beforeInvalidTransition=dbCounts();
  const missingWait=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,status:'waiting'}}); expectError(missingWait,400,'INVALID_INPUT'); assert.deepEqual(dbCounts(),beforeInvalidTransition);
  const waitBody={requestId:randomUUID(),expectedVersion:3,status:'waiting',waitingReason:'等待供应商确认'};
  const waitResult=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:waitBody}); expectSuccess(waitResult); assert.equal(waitResult.json.data.status,'waiting'); assert.equal(waitResult.json.data.version,4); assert.equal(waitResult.json.data.waitingReason,'等待供应商确认');
  const waitReplay=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:waitBody}); expectSuccess(waitReplay); assert.equal(waitReplay.response.headers.get('idempotency-replayed'),'true'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',lifecycleId),4);
  const sameStatus=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,status:'waiting',waitingReason:'仍在等'}}); expectError(sameStatus,409,'INVALID_TRANSITION');
  const progress=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,status:'in_progress'}}); expectSuccess(progress); assert.equal(progress.json.data.version,5); assert.equal(progress.json.data.waitingReason,'');
  const delegationFixtureDb=new Database(dbPath); const contactId=randomUUID(); const delegationId=randomUUID(); const delegationNow=new Date().toISOString();
  try {
    const ownerId=delegationFixtureDb.prepare('SELECT owner_user_id FROM tasks WHERE id=?').get(lifecycleId).owner_user_id;
    delegationFixtureDb.prepare('INSERT INTO contacts(id,owner_user_id,name,note,inactive_at,version,created_at,updated_at) VALUES(?,?,?,\x27\x27,NULL,1,?,?)').run(contactId,ownerId,'回归联系人',delegationNow,delegationNow);
    delegationFixtureDb.prepare('UPDATE tasks SET action_kind=\x27contact\x27,action_contact_id=? WHERE id=?').run(contactId,lifecycleId);
    delegationFixtureDb.prepare('INSERT INTO delegations(id,task_id,owner_user_id,delegated_by,contact_id,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,NULL,NULL)').run(delegationId,lifecycleId,ownerId,ownerId,contactId,delegationNow);
  } finally { delegationFixtureDb.close(); }
  const done=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:5,status:'done'}}); expectSuccess(done); assert.equal(done.json.data.status,'done'); assert.equal(done.json.data.version,6); assert.ok(done.json.data.completedAt); assert.equal(done.json.data.isProcessed,true); assert.equal(dbCount('SELECT action_kind FROM tasks WHERE id=?',lifecycleId),'none'); assert.equal(dbCount("SELECT count(*) FROM delegations WHERE id=? AND ended_at IS NOT NULL AND end_reason='task_ended'",delegationId),1); assert.equal(dbCount("SELECT count(*) FROM task_events WHERE task_id=? AND type='task_delegation_ended'",lifecycleId),1);
  const reopen=await call(api,`/tasks/${lifecycleId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:6,status:'todo'}}); expectSuccess(reopen); assert.equal(reopen.json.data.status,'todo'); assert.equal(reopen.json.data.version,7); assert.equal(reopen.json.data.completedAt,null);
  const lifecycleDb=new Database(dbPath,{readonly:true}); try { const row=lifecycleDb.prepare('SELECT status,waiting_reason,completed_at,cancelled_at,is_processed,action_kind,action_contact_id FROM tasks WHERE id=?').get(lifecycleId); assert.deepEqual(row,{status:'todo',waiting_reason:'',completed_at:null,cancelled_at:null,is_processed:1,action_kind:'self',action_contact_id:null}); } finally { lifecycleDb.close(); }
  const cancelFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'取消与重新打开回归'}}); expectSuccess(cancelFixture,201); const cancelId=cancelFixture.json.data.id;
  const missingCancel=await call(api,`/tasks/${cancelId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'cancelled'}}); expectError(missingCancel,400,'INVALID_INPUT'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',cancelId),1);
  const cancelled=await call(api,`/tasks/${cancelId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'cancelled',cancellationReason:'需求已取消'}}); expectSuccess(cancelled); assert.equal(cancelled.json.data.status,'cancelled'); assert.ok(cancelled.json.data.cancelledAt); assert.equal(cancelled.json.data.isProcessed,true);
  const reopenedCancel=await call(api,`/tasks/${cancelId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,status:'todo'}}); expectSuccess(reopenedCancel); assert.equal(reopenedCancel.json.data.cancellationReason,''); assert.equal(reopenedCancel.json.data.status,'todo');
  assert.equal(dbCount("SELECT count(*) FROM task_events WHERE task_id=? AND type='task_transitioned'",lifecycleId),4);

  // M2-04 scheduling fields: strict calendar dates, field limits, ordering, and terminal follow-up guard.
  const badCalendar=await call(api,`/tasks/${lifecycleId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:7,priority:'high',plannedDate:'2026-02-30',dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}); expectError(badCalendar,400,'INVALID_DATE');
  const badRange=await call(api,`/tasks/${lifecycleId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:7,priority:'high',plannedDate:'2026-10-20',dueDate:'2026-10-19',followUpDate:null,nextAction:'',blockedReason:''}}); expectError(badRange,400,'INVALID_DATE_RANGE');
  const badLength=await call(api,`/tasks/${lifecycleId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:7,priority:'high',plannedDate:null,dueDate:null,followUpDate:null,nextAction:'x'.repeat(501),blockedReason:''}}); expectError(badLength,400,'INVALID_INPUT');
  const planBody={requestId:randomUUID(),expectedVersion:7,priority:'high',plannedDate:'2026-10-13',dueDate:'2026-10-15',followUpDate:'2026-10-20',nextAction:'联系供应商确认',blockedReason:'等待报价单'};
  const planSaved=await call(api,`/tasks/${lifecycleId}/planning`,{method:'PATCH',body:planBody}); expectSuccess(planSaved); assert.equal(planSaved.json.data.version,8); assert.equal(planSaved.json.data.priority,'high'); assert.equal(planSaved.json.data.followUpDate,'2026-10-20');
  const planReplay=await call(api,`/tasks/${lifecycleId}/planning`,{method:'PATCH',body:planBody}); expectSuccess(planReplay); assert.equal(planReplay.response.headers.get('idempotency-replayed'),'true'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',lifecycleId),8);
  const planDetail=await call(api,`/tasks/${lifecycleId}`); expectSuccess(planDetail); assert.equal(planDetail.json.data.nextAction,'联系供应商确认'); assert.equal(planDetail.json.data.blockedReason,'等待报价单');
  const endForPlan=await call(api,`/tasks/${cancelId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,status:'done'}}); expectSuccess(endForPlan);
  const endedFollowup=await call(api,`/tasks/${cancelId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:4,priority:'medium',plannedDate:null,dueDate:null,followUpDate:'2026-10-21',nextAction:'',blockedReason:''}}); expectError(endedFollowup,409,'TASK_ENDED');
  // M2-05 progress and immutable timeline.
  const eventsBefore=await call(api,`/tasks/${lifecycleId}/events?limit=50`); expectSuccess(eventsBefore); assert.ok(eventsBefore.json.data.items.length>=5); assert.equal(eventsBefore.json.data.hasMore,false);
  const timeline=eventsBefore.json.data.items; const times=timeline.map((event)=>event.occurredAt); assert.deepEqual(times,[...times].sort()); assert.equal(timeline[0].type,'task_created');
  const emptyProgress=await call(api,`/tasks/${lifecycleId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:8,text:'   '}}); expectError(emptyProgress,400,'INVALID_INPUT'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',lifecycleId),8);
  const longProgress=await call(api,`/tasks/${lifecycleId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:8,text:'x'.repeat(5001)}}); expectError(longProgress,400,'INVALID_INPUT');
  const progressBody={requestId:randomUUID(),expectedVersion:8,text:'已联系供应商，等待周四报价'}; const eventsCountBefore=dbCount('SELECT count(*) FROM task_events WHERE task_id=?',lifecycleId);
  const progressSaved=await call(api,`/tasks/${lifecycleId}/progress`,{method:'POST',body:progressBody}); expectSuccess(progressSaved); assert.equal(progressSaved.json.data.version,9); assert.equal(progressSaved.json.data.text,'已联系供应商，等待周四报价'); assert.equal(dbCount('SELECT count(*) FROM task_events WHERE task_id=?',lifecycleId),eventsCountBefore+1);
  const progressReplay=await call(api,`/tasks/${lifecycleId}/progress`,{method:'POST',body:progressBody}); expectSuccess(progressReplay); assert.equal(progressReplay.response.headers.get('idempotency-replayed'),'true'); assert.equal(dbCount('SELECT count(*) FROM task_events WHERE task_id=?',lifecycleId),eventsCountBefore+1); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',lifecycleId),9);
  const staleProgress=await call(api,`/tasks/${lifecycleId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:8,text:'旧版本写入'}}); expectError(staleProgress,409,'VERSION_CONFLICT');
  const progressEvent=new Database(dbPath,{readonly:true}); try { const row=progressEvent.prepare("SELECT payload_json FROM task_events WHERE task_id=? AND type='task_progress_appended' ORDER BY occurred_at DESC,id DESC LIMIT 1").get(lifecycleId); assert.equal(JSON.parse(row.payload_json).text,'已联系供应商，等待周四报价'); assert.throws(()=>progressEvent.prepare('UPDATE task_events SET payload_json=? WHERE task_id=?').run('{}',lifecycleId)); assert.throws(()=>progressEvent.prepare('DELETE FROM task_events WHERE task_id=?').run(lifecycleId)); } finally { progressEvent.close(); }
  const guardedFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'归档与删除写入保护回归'}}); expectSuccess(guardedFixture,201); const guardedId=guardedFixture.json.data.id;
  const guardDb=new Database(dbPath); const guardNow=new Date().toISOString(); try { guardDb.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(guardNow,guardedId); } finally { guardDb.close(); }
  const archivedProgress=await call(api,`/tasks/${guardedId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,text:'归档后写入'}}); expectError(archivedProgress,409,'TASK_ARCHIVED');
  const archivedEvents=await call(api,`/tasks/${guardedId}/events`); expectSuccess(archivedEvents); assert.equal(archivedEvents.json.data.items.length,1);
  const deleteDb=new Database(dbPath); try { deleteDb.prepare('UPDATE tasks SET deleted_at=? WHERE id=?').run(guardNow,guardedId); } finally { deleteDb.close(); }
  const deletedProgress=await call(api,`/tasks/${guardedId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,text:'删除后写入'}}); expectError(deletedProgress,404,'TASK_NOT_FOUND');
  const deletedEvents=await call(api,`/tasks/${guardedId}/events`); expectError(deletedEvents,404,'TASK_NOT_FOUND');
  // M2-06: validation failures must carry fieldErrors so the form can keep input, and must not write.
  const guardFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'M2-06 错误契约回归'}}); expectSuccess(guardFixture,201); const guardId=guardFixture.json.data.id;
  const guardCounts=dbCounts();
  const blankTitle=await call(api,`/tasks/${guardId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,title:'   '}}); expectError(blankTitle,400,'INVALID_TITLE'); assert.ok(blankTitle.json.error.fieldErrors?.title);
  const badPriority=await call(api,`/tasks/${guardId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'urgent',plannedDate:null,dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}); expectError(badPriority,400,'INVALID_INPUT'); assert.ok(badPriority.json.error.fieldErrors?.priority);
  const badDate=await call(api,`/tasks/${guardId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'none',plannedDate:'2026-13-01',dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}); expectError(badDate,400,'INVALID_DATE'); assert.ok(badDate.json.error.fieldErrors?.plannedDate);
  const blankProgress=await call(api,`/tasks/${guardId}/progress`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,text:' '}}); expectError(blankProgress,400,'INVALID_INPUT'); assert.ok(blankProgress.json.error.fieldErrors?.text);
  const blankWait=await call(api,`/tasks/${guardId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'waiting'}}); expectError(blankWait,400,'INVALID_INPUT'); assert.ok(blankWait.json.error.fieldErrors?.waitingReason);
  const blankCancel=await call(api,`/tasks/${guardId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'cancelled'}}); expectError(blankCancel,400,'INVALID_INPUT'); assert.ok(blankCancel.json.error.fieldErrors?.cancellationReason);
  const removedField=await call(api,`/tasks/${guardId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,title:'ok',status:'done'}}); expectError(removedField,400,'INVALID_INPUT'); assert.ok(removedField.json.error.fieldErrors?.status);
  assert.deepEqual(dbCounts(),guardCounts); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',guardId),1);
  const guardEvents=await call(api,`/tasks/${guardId}/events`); expectSuccess(guardEvents); assert.equal(guardEvents.json.data.items.length,1);
  const conflictPayload=await call(api,`/tasks/${guardId}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:99,priority:'none',plannedDate:null,dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}); expectError(conflictPayload,409,'VERSION_CONFLICT'); assert.equal(conflictPayload.json.error.currentVersion,1); assert.equal(conflictPayload.json.error.current.id,guardId);
  // M3-01 空间与项目 CRUD、归档守卫与归属校验
  const baselineSpaces=await call(api,'/spaces'); expectSuccess(baselineSpaces); for (const requiredName of ['私人','工作','生活','成长']) assert.ok(baselineSpaces.json.data.items.some((item)=>item.name===requiredName), requiredName);
  const privateSpace=baselineSpaces.json.data.items.find((item)=>item.isDefault); assert.ok(privateSpace); assert.equal(privateSpace.name,'私人');
  expectError(await call(api,'/spaces',{cookieValue:null}),401,'UNAUTHENTICATED');
  expectError(await call(api,'/spaces',{method:'POST',cookieValue:null,body:{requestId:randomUUID(),name:'未登录空间'}}),401,'UNAUTHENTICATED');
  const createSpaceBody={requestId:randomUUID(),name:'工程',description:'工程与门店'}; const spacesBefore=dbCount('SELECT count(*) FROM spaces');
  const spaceA=await call(api,'/spaces',{method:'POST',body:createSpaceBody}); expectSuccess(spaceA); assert.equal(spaceA.json.data.name,'工程'); assert.equal(spaceA.json.data.isDefault,false); assert.equal(spaceA.json.data.version,1); assert.equal(dbCount('SELECT count(*) FROM spaces'),spacesBefore+1);
  const spaceAId=spaceA.json.data.id;
  const spaceAReplay=await call(api,'/spaces',{method:'POST',body:createSpaceBody}); expectSuccess(spaceAReplay); assert.equal(spaceAReplay.response.headers.get('idempotency-replayed'),'true'); assert.equal(spaceAReplay.json.data.id,spaceAId); assert.equal(dbCount('SELECT count(*) FROM spaces'),spacesBefore+1);
  const dupSpace=await call(api,'/spaces',{method:'POST',body:{requestId:randomUUID(),name:'工程'}}); expectError(dupSpace,409,'NAME_TAKEN'); assert.ok(dupSpace.json.error.fieldErrors?.name);
  const blankSpace=await call(api,'/spaces',{method:'POST',body:{requestId:randomUUID(),name:'   '}}); expectError(blankSpace,400,'INVALID_INPUT'); assert.ok(blankSpace.json.error.fieldErrors?.name);
  const longSpace=await call(api,'/spaces',{method:'POST',body:{requestId:randomUUID(),name:'长'.repeat(81)}}); expectError(longSpace,400,'INVALID_INPUT'); assert.ok(longSpace.json.error.fieldErrors?.name);
  const extraSpaceField=await call(api,'/spaces',{method:'POST',body:{requestId:randomUUID(),name:'越权字段',isDefault:true}}); expectError(extraSpaceField,400,'INVALID_INPUT'); assert.ok(extraSpaceField.json.error.fieldErrors?.isDefault);
  const spacePatch=await call(api,`/spaces/${spaceAId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,name:'工程改造'}}); expectSuccess(spacePatch); assert.equal(spacePatch.json.data.name,'工程改造'); assert.equal(spacePatch.json.data.version,2); assert.equal(spacePatch.json.data.description,'工程与门店');
  const staleSpacePatch=await call(api,`/spaces/${spaceAId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,name:'过期改名'}}); expectError(staleSpacePatch,409,'VERSION_CONFLICT'); assert.equal(staleSpacePatch.json.error.currentVersion,2);
  const renamedToTaken=await call(api,`/spaces/${spaceAId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:2,name:'私人'}}); expectError(renamedToTaken,409,'NAME_TAKEN');
  const defaultArchive=await call(api,`/spaces/${privateSpace.id}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:privateSpace.version}}); expectError(defaultArchive,409,'SPACE_DEFAULT_ARCHIVE');
  expectError(await call(api,`/spaces/${randomUUID()}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,name:'不存在'}}),404,'SPACE_NOT_FOUND');
  const spaceB=baselineSpaces.json.data.items.find((item)=>item.name==='生活'); assert.ok(spaceB);

  // M3-02 项目 CRUD、项目内创建与归属守卫
  const projectA=await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:spaceAId,name:'门店数据'}}); expectSuccess(projectA); assert.equal(projectA.json.data.spaceId,spaceAId); assert.equal(projectA.json.data.version,1); const projectAId=projectA.json.data.id;
  const dupProject=await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:spaceAId,name:'门店数据'}}); expectError(dupProject,409,'NAME_TAKEN');
  const badSpaceProject=await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:randomUUID(),name:'无空间项目'}}); expectError(badSpaceProject,404,'SPACE_NOT_FOUND');
  const archivedSpace=await call(api,`/spaces/${spaceB.id}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:spaceB.version}}); expectSuccess(archivedSpace); assert.equal(archivedSpace.json.data.archived,true);
  expectError(await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:spaceB.id,name:'归档空间新项目'}}),409,'SPACE_ARCHIVED');
  expectError(await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'归档空间新事项',spaceId:spaceB.id}}),409,'SPACE_ARCHIVED');
  const restoredSpace=await call(api,`/spaces/${spaceB.id}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:archivedSpace.json.data.version}}); expectSuccess(restoredSpace); assert.equal(restoredSpace.json.data.archived,false);
  const projectC=await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:spaceB.id,name:'门店数据'}}); expectSuccess(projectC); const projectCId=projectC.json.data.id;
  expectError(await call(api,`/spaces/${spaceB.id}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:restoredSpace.json.data.version}}),409,'SPACE_HAS_PROJECTS');

  const projectTask=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'核实门店数据',projectId:projectAId}}); expectSuccess(projectTask,201); const projectTaskId=projectTask.json.data.id;
  assert.equal(projectTask.json.data.spaceId,spaceAId); assert.equal(projectTask.json.data.projectId,projectAId); assert.equal(projectTask.json.data.isProcessed,true);
  const mismatchedCreate=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'错配空间项目',spaceId:spaceAId,projectId:projectCId}}); expectError(mismatchedCreate,409,'PROJECT_SPACE_MISMATCH');
  const unknownProjectCreate=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'未知项目',projectId:randomUUID()}}); expectError(unknownProjectCreate,404,'PROJECT_NOT_FOUND');
  expectError(await call(api,`/projects/${projectAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1}}),409,'PROJECT_HAS_ACTIVE_TASKS');
  const projectList=await call(api,`/projects?spaceId=${spaceAId}`); expectSuccess(projectList); const listedProject=projectList.json.data.items.find((item)=>item.id===projectAId); assert.equal(listedProject.counts.active,1); assert.equal(listedProject.counts.completed,0);

  const moveToProject=await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,projectId:projectCId}}); expectSuccess(moveToProject); assert.equal(moveToProject.json.data.projectId,projectCId); assert.equal(moveToProject.json.data.spaceId,spaceB.id); assert.equal(moveToProject.json.data.version,2);
  expectError(await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,spaceId:spaceAId,projectId:projectCId}}),409,'PROJECT_SPACE_MISMATCH');
  const moveOut=await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,spaceId:spaceAId,projectId:null}}); expectSuccess(moveOut); assert.equal(moveOut.json.data.projectId,null); assert.equal(moveOut.json.data.spaceId,spaceAId); assert.equal(moveOut.json.data.version,3);
  const inboxReturn=await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,isProcessed:false}}); expectSuccess(inboxReturn); assert.equal(inboxReturn.json.data.isProcessed,false); assert.equal(inboxReturn.json.data.changed,true);
  const noopPlacement=await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,spaceId:spaceAId}}); expectSuccess(noopPlacement); assert.equal(noopPlacement.json.data.changed,false); assert.equal(noopPlacement.json.data.version,4);
  const placementEventDb=new Database(dbPath,{readonly:true}); try { const row=placementEventDb.prepare("SELECT payload_json FROM task_events WHERE task_id=? AND type='task_updated' ORDER BY occurred_at DESC,id DESC LIMIT 1").get(projectTaskId); const payload=JSON.parse(row.payload_json); assert.ok(payload.changes.isProcessed); } finally { placementEventDb.close(); }
  expectError(await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,spaceId:randomUUID(),projectId:null}}),404,'SPACE_NOT_FOUND');

  const archivedProject=await call(api,`/projects/${projectAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1}}); expectSuccess(archivedProject); assert.equal(archivedProject.json.data.archived,true);
  expectError(await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'归档项目新事项',projectId:projectAId}}),409,'PROJECT_ARCHIVED');
  expectError(await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,projectId:projectAId}}),409,'PROJECT_ARCHIVED');
  const unarchivedProject=await call(api,`/projects/${projectAId}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:archivedProject.json.data.version}}); expectSuccess(unarchivedProject); assert.equal(unarchivedProject.json.data.archived,false);
  const secondArchive=await call(api,`/projects/${projectAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:unarchivedProject.json.data.version}}); expectSuccess(secondArchive);
  const spaceWithArchivedProject=await call(api,`/spaces/${spaceAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2}}); expectError(spaceWithArchivedProject,409,'SPACE_HAS_TASKS');
  const archivedSecondSpace=await call(api,`/spaces/${spaceAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2}}); expectError(archivedSecondSpace,409,'SPACE_HAS_TASKS');
  const archivedTaskMove=await call(api,`/tasks/${projectTaskId}/placement`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,spaceId:spaceB.id,projectId:null}}); expectSuccess(archivedTaskMove);
  const spaceWithNoTasks=await call(api,`/spaces/${spaceAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2}}); expectSuccess(spaceWithNoTasks); assert.equal(spaceWithNoTasks.json.data.archived,true);
  expectError(await call(api,`/projects/${projectAId}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:secondArchive.json.data.version}}),409,'SPACE_ARCHIVED');
  expectError(await call(api,`/spaces/${spaceAId}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:spaceWithNoTasks.json.data.version}}),409,'ALREADY_ARCHIVED');
  const reopenedSpace=await call(api,`/spaces/${spaceAId}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:spaceWithNoTasks.json.data.version}}); expectSuccess(reopenedSpace); assert.equal(reopenedSpace.json.data.archived,false);
  expectSuccess(await call(api,`/projects/${projectAId}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:secondArchive.json.data.version}}));
  expectError(await call(api,`/projects/${projectAId}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:secondArchive.json.data.version+1}}),409,'NOT_ARCHIVED');
  const archivedSpaceList=await call(api,'/spaces?includeArchived=true'); expectSuccess(archivedSpaceList);
  const liveSpaces=await call(api,'/spaces'); expectSuccess(liveSpaces); assert.equal(liveSpaces.json.data.items.length,archivedSpaceList.json.data.items.length);

  // M5-01 project-root compatibility: root is the canonical project title/body/status, project counts exclude root.
  const rootCompatProject=await call(api,'/projects',{method:'POST',body:{requestId:randomUUID(),spaceId:spaceAId,name:'根兼容项目',description:'旧说明'}});expectSuccess(rootCompatProject,200);
  const rootCompatId=randomUUID();const rootCompatNow=new Date().toISOString();const rootCompatDb=new Database(dbPath);
  try{const owner=rootCompatDb.prepare('SELECT owner_user_id FROM projects WHERE id=?').get(rootCompatProject.json.data.id).owner_user_id;rootCompatDb.prepare(`INSERT INTO tasks(id,owner_user_id,space_id,project_id,title,description,description_plain,description_format,status,is_processed,created_at,updated_at,version) VALUES(?,?,?,?,?,? ,?,'plaintext','todo',1,?,?,1)`).run(rootCompatId,owner,spaceAId,rootCompatProject.json.data.id,'根兼容项目','旧说明','旧说明',rootCompatNow,rootCompatNow);rootCompatDb.prepare('UPDATE projects SET root_task_id=? WHERE id=?').run(rootCompatId,rootCompatProject.json.data.id)}finally{rootCompatDb.close()}
  const rootRead=await call(api,`/projects/${rootCompatProject.json.data.id}`);expectSuccess(rootRead);assert.equal(rootRead.json.data.rootTaskId,rootCompatId);assert.equal(rootRead.json.data.counts.active,0,'项目容器根不进入项目子项计数');const rootRows=await call(api,`/tasks?view=all&limit=100&offset=0&projectId=${rootCompatProject.json.data.id}&includeEnded=true`);expectSuccess(rootRows);assert.equal(rootRows.json.data.items.find(item=>item.id===rootCompatId).isProjectRoot,true,'项目目标根应向前端暴露明确标记');
  const childCreate=await call(api,`/tasks/${rootCompatId}/children`,{method:'POST',body:{requestId:randomUUID(),title:'隔离子事项',expectedStructureVersion:1}});expectSuccess(childCreate,201);const childId=childCreate.json.data.id;const childList=await call(api,`/tasks/${rootCompatId}/children?limit=10&offset=0`);expectSuccess(childList);assert.equal(childList.json.data.total,1);assert.equal(childList.json.data.items[0].id,childId);const childPath=await call(api,`/tasks/${childId}/ancestors?limit=10&offset=0`);expectSuccess(childPath);assert.deepEqual(childPath.json.data.items.map(item=>item.id),[rootCompatId]);const cycleDb=new Database(dbPath);try{assert.throws(()=>cycleDb.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(childId,rootCompatId),/task_parent_cycle/)}finally{cycleDb.close()}const staleStructure=await call(api,`/tasks/${rootCompatId}/children`,{method:'POST',body:{requestId:randomUUID(),title:'结构版本冲突',expectedStructureVersion:1}});expectError(staleStructure,409,'STRUCTURE_VERSION_CONFLICT');const cycleMove=await call(api,`/tasks/${rootCompatId}/parent`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,expectedStructureVersion:2,expectedTargetStructureVersion:1,expectedSpaceStructureVersion:rootRows.json.data.items.find(item=>item.id===rootCompatId).spaceStructureVersion,targetParentId:childId}});expectError(cycleMove,409,'TASK_TREE_CYCLE');const movable=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'可移动事项',spaceId:spaceAId,projectId:rootCompatProject.json.data.id}});expectSuccess(movable,201);const movableRow=await call(api,`/tasks?view=all&limit=100&offset=0&spaceId=${spaceAId}&includeEnded=true`);expectSuccess(movableRow);const movableItem=movableRow.json.data.items.find(item=>item.id===movable.json.data.id);const attachResult=await call(api,`/tasks/${movable.json.data.id}/parent`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,expectedStructureVersion:1,expectedSpaceStructureVersion:movableItem.spaceStructureVersion,targetParentId:rootCompatId,expectedTargetStructureVersion:2}});expectSuccess(attachResult);assert.equal(attachResult.json.data.parentId,rootCompatId);assert.equal((await call(api,`/tasks/${movable.json.data.id}`)).json.data.projectId,rootCompatProject.json.data.id,'挂接后应继承最近项目索引');const oldParentInfo=await call(api,`/tasks/${rootCompatId}/children?limit=1`);expectSuccess(oldParentInfo);const detach=await call(api,`/tasks/${movable.json.data.id}/parent`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,expectedStructureVersion:2,expectedOldParentStructureVersion:oldParentInfo.json.data.parent.structureVersion,expectedSpaceStructureVersion:movableItem.spaceStructureVersion+1,targetParentId:null}});expectSuccess(detach);assert.equal(detach.json.data.parentId,null);const detachedTask=await call(api,`/tasks/${movable.json.data.id}`);expectSuccess(detachedTask);assert.equal(detachedTask.json.data.projectId,null,'移到顶层后应清除最近项目索引');assert.equal(detachedTask.json.data.version,1,'结构移动不得改变内容版本');assert.equal(detachedTask.json.data.title,'可移动事项','结构移动须保持事项内容和ID可读');assert.equal(dbCount('SELECT count(*) FROM task_events WHERE task_id=?',movable.json.data.id),3,'结构移动仅追加关系事件，不抹除原历史');const movableDone=await call(api,`/tasks/${movable.json.data.id}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'done'}});expectSuccess(movableDone);const childDone=await call(api,`/tasks/${childId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,status:'done'}});expectSuccess(childDone);
  const concurrentA=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'并发A',spaceId:spaceAId}});expectSuccess(concurrentA,201);const concurrentB=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'并发B',spaceId:spaceAId}});expectSuccess(concurrentB,201);const concurrentRows=await call(api,`/tasks?view=all&spaceId=${spaceAId}&limit=100&offset=0`);expectSuccess(concurrentRows);const concurrentItems=concurrentRows.json.data.items.filter(item=>[concurrentA.json.data.id,concurrentB.json.data.id].includes(item.id));const structureAtStart=concurrentItems[0].spaceStructureVersion;const [moveA,moveB]=await Promise.all([[concurrentA,concurrentB],[concurrentB,concurrentA]].map(([source,target])=>call(api,`/tasks/${source.json.data.id}/parent`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,expectedStructureVersion:1,expectedSpaceStructureVersion:structureAtStart,expectedTargetStructureVersion:1,targetParentId:target.json.data.id}})));assert.equal([moveA,moveB].filter(r=>r.status>=200&&r.status<300).length,1,'并发互移最多允许一方成功');assert.equal([moveA,moveB].filter(r=>r.status===409).length,1,'另一互移请求应因结构版本冲突回滚');
  const deepRoot=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'101层隔离树',spaceId:spaceAId}});expectSuccess(deepRoot,201);const deepIds=[deepRoot.json.data.id];let deepParent=deepRoot.json.data.id;for(let depth=1;depth<101;depth++){const made=await call(api,`/tasks/${deepParent}/children`,{method:'POST',body:{requestId:randomUUID(),title:`层级${depth}`,expectedStructureVersion:1}});expectSuccess(made,201);deepParent=made.json.data.id;deepIds.push(deepParent)}const deepPathA=await call(api,`/tasks/${deepParent}/ancestors?limit=50&offset=0`);expectSuccess(deepPathA);assert.equal(deepPathA.json.data.total,100);assert.equal(deepPathA.json.data.items.length,50);assert.equal(deepPathA.json.data.hasMore,true);const deepPathB=await call(api,`/tasks/${deepParent}/ancestors?limit=50&offset=50`);expectSuccess(deepPathB);assert.equal(deepPathB.json.data.items.length,50);assert.equal(deepPathB.json.data.hasMore,false);assert.deepEqual([...deepPathA.json.data.items,...deepPathB.json.data.items].map(item=>item.id),deepIds.slice(0,-1));const middleId=deepIds[50],middleParentId=deepIds[49];const middleDetail=await call(api,`/tasks/${middleId}`);expectSuccess(middleDetail);const oldMiddleParent=await call(api,`/tasks/${middleParentId}/children?limit=1`);expectSuccess(oldMiddleParent);const moveMiddle=await call(api,`/tasks/${middleId}/parent`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:middleDetail.json.data.version,expectedStructureVersion:middleDetail.json.data.structureVersion,expectedOldParentStructureVersion:oldMiddleParent.json.data.parent.structureVersion,expectedSpaceStructureVersion:middleDetail.json.data.spaceStructureVersion,targetParentId:null}});expectSuccess(moveMiddle);assert.equal(moveMiddle.json.data.parentId,null);const movedLeafPath=await call(api,`/tasks/${deepParent}/ancestors?limit=100&offset=0`);expectSuccess(movedLeafPath);assert.equal(movedLeafPath.json.data.total,50);assert.equal(movedLeafPath.json.data.items[0].id,middleId);const depthDb=new Database(dbPath);try{const descendantCount=depthDb.prepare(`WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id=d.id) SELECT count(*) n FROM d`).get(middleId).n;assert.equal(descendantCount,51);assert.equal(depthDb.prepare('SELECT count(*) n FROM tasks WHERE id IN ('+deepIds.map(()=>'?').join(',')+')').get(...deepIds).n,101)}finally{depthDb.close()}
  const wideRoot=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'宽树隔离根',spaceId:spaceAId}});expectSuccess(wideRoot,201);const wideIds=[];for(let ix=0;ix<105;ix++){const state=await call(api,`/tasks/${wideRoot.json.data.id}/children?limit=1`);expectSuccess(state);const child=await call(api,`/tasks/${wideRoot.json.data.id}/children`,{method:'POST',body:{requestId:randomUUID(),title:`宽树${ix}`,expectedStructureVersion:state.json.data.parent.structureVersion}});expectSuccess(child,201);wideIds.push(child.json.data.id)}const widePage1=await call(api,`/tasks/${wideRoot.json.data.id}/children?limit=100&offset=0`);expectSuccess(widePage1);assert.equal(widePage1.json.data.total,105);assert.equal(widePage1.json.data.items.length,100);assert.equal(widePage1.json.data.hasMore,true);const widePage2=await call(api,`/tasks/${wideRoot.json.data.id}/children?limit=100&offset=100`);expectSuccess(widePage2);assert.equal(widePage2.json.data.items.length,5);assert.equal(widePage2.json.data.hasMore,false);assert.equal(new Set([...widePage1.json.data.items,...widePage2.json.data.items].map(item=>item.id)).size,105);console.log('M5-03 tree API: PASS (create/attach/detach/cycle/concurrency/101-level move/wide pagination)');
  const rootProjectEdit=await call(api,`/projects/${rootCompatProject.json.data.id}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,name:'根兼容改名',description:'根正文新版本'}});expectSuccess(rootProjectEdit);assert.equal(rootProjectEdit.json.data.name,'根兼容改名');assert.equal(rootProjectEdit.json.data.description,'根正文新版本');
  const rootAfterProjectEdit=await call(api,`/tasks/${rootCompatId}`);expectSuccess(rootAfterProjectEdit);assert.equal(rootAfterProjectEdit.json.data.title,'根兼容改名');assert.equal(rootAfterProjectEdit.json.data.description,'根正文新版本');
  const rootTaskEdit=await call(api,`/tasks/${rootCompatId}`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:2,title:'从根事项改名'}});expectSuccess(rootTaskEdit);assert.equal((await call(api,`/projects/${rootCompatProject.json.data.id}`)).json.data.name,'从根事项改名');
  const rootDone=await call(api,`/tasks/${rootCompatId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,status:'done'}});expectSuccess(rootDone);const rootProjectAfterDone=await call(api,`/projects/${rootCompatProject.json.data.id}`);assert.equal(rootProjectAfterDone.json.data.status,'completed');assert.equal(dbCount('SELECT status FROM projects WHERE id=?',rootCompatProject.json.data.id),'completed');
  const rootArchived=await call(api,`/projects/${rootCompatProject.json.data.id}/archive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:rootProjectAfterDone.json.data.version}});expectSuccess(rootArchived);assert.equal(dbCount('SELECT archived_at FROM tasks WHERE id=?',rootCompatId),rootArchived.json.data.archivedAt);
  const rootUnarchived=await call(api,`/projects/${rootCompatProject.json.data.id}/unarchive`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:rootArchived.json.data.version}});expectSuccess(rootUnarchived);assert.equal(dbCount('SELECT archived_at FROM tasks WHERE id=?',rootCompatId),null);

  // M3-03/04 处理方式与交给谁（含旧字段兼容与重开重置）
  const shToday=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const handlingOne=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'核实门店数据（工程）'}}); expectSuccess(handlingOne,201); const handlingOneId=handlingOne.json.data.id;
  const detailDefaults=await call(api,`/tasks/${handlingOneId}`); expectSuccess(detailDefaults); assert.equal(detailDefaults.json.data.handlingMode,'self'); assert.equal(detailDefaults.json.data.counterpartName,'');
  const otherNoText=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,handlingMode:'other'}}); expectError(otherNoText,400,'INVALID_INPUT'); assert.ok(otherNoText.json.error.fieldErrors?.counterpartName); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',handlingOneId),1);
  const otherBlank=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,handlingMode:'other',counterpartName:'   '}}); expectError(otherBlank,400,'INVALID_INPUT');
  const otherTooLong=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,handlingMode:'other',counterpartName:'长'.repeat(101)}}); expectError(otherTooLong,400,'INVALID_INPUT');
  const badMode=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,handlingMode:'contact',counterpartName:'x'}}); expectError(badMode,400,'INVALID_INPUT'); assert.ok(badMode.json.error.fieldErrors?.handlingMode);
  const handlingBody={requestId:randomUUID(),expectedVersion:1,handlingMode:'other',counterpartName:'工程部门'};
  const toOther=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:handlingBody}); expectSuccess(toOther); assert.equal(toOther.json.data.handlingMode,'other'); assert.equal(toOther.json.data.counterpartName,'工程部门'); assert.equal(toOther.json.data.version,2); assert.equal(toOther.json.data.changed,true);
  const handlingReplay=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:handlingBody}); expectSuccess(handlingReplay); assert.equal(handlingReplay.response.headers.get('idempotency-replayed'),'true'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',handlingOneId),2);
  const detailAfterHandling=await call(api,`/tasks/${handlingOneId}`); expectSuccess(detailAfterHandling); assert.equal(detailAfterHandling.json.data.status,'todo'); assert.equal(detailAfterHandling.json.data.plannedDate,null); assert.equal(detailAfterHandling.json.data.dueDate,null);
  const handlingEventDb=new Database(dbPath,{readonly:true}); try { const row=handlingEventDb.prepare("SELECT payload_json FROM task_events WHERE task_id=? AND type='task_updated' ORDER BY occurred_at DESC,id DESC LIMIT 1").get(handlingOneId); const payload=JSON.parse(row.payload_json); assert.deepEqual(payload.changes.handlingMode,{from:'self',to:'other'}); assert.deepEqual(payload.changes.counterpartName,{from:'',to:'工程部门'}); } finally { handlingEventDb.close(); }
  const backToSelf=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,handlingMode:'self',counterpartName:'工程部门'}}); expectSuccess(backToSelf); assert.equal(backToSelf.json.data.handlingMode,'self'); assert.equal(backToSelf.json.data.counterpartName,'');
  const staleHandling=await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,handlingMode:'other',counterpartName:'过期写入'}}); expectError(staleHandling,409,'VERSION_CONFLICT');
  const handlingTwo=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'同名处理方事项'}}); expectSuccess(handlingTwo,201); const handlingTwoId=handlingTwo.json.data.id;
  expectSuccess(await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,handlingMode:'other',counterpartName:'物业A'}}));
  expectSuccess(await call(api,`/tasks/${handlingTwoId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:1,handlingMode:'other',counterpartName:'物业A'}}));
  expectSuccess(await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:4,handlingMode:'other',counterpartName:'物业B'}}));
  assert.equal(dbCount('SELECT counterpart_name FROM tasks WHERE id=?',handlingTwoId),'物业A');
  assert.equal(dbCount('SELECT counterpart_name FROM tasks WHERE id=?',handlingOneId),'物业B');
  const endedHandling=await call(api,`/tasks/${handlingTwoId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:2,status:'done'}}); expectSuccess(endedHandling);
  assert.equal(dbCount('SELECT handling_mode FROM tasks WHERE id=?',handlingTwoId),'other');
  expectError(await call(api,`/tasks/${handlingTwoId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,handlingMode:'self'}}),409,'TASK_ENDED');
  const reopenedHandling=await call(api,`/tasks/${handlingTwoId}/transition`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:3,status:'todo'}}); expectSuccess(reopenedHandling);
  const reopenedDetail=await call(api,`/tasks/${handlingTwoId}`); expectSuccess(reopenedDetail); assert.equal(reopenedDetail.json.data.handlingMode,'self'); assert.equal(reopenedDetail.json.data.counterpartName,'');
  const archivedHandling=new Database(dbPath); const archivedNow=new Date().toISOString(); try { archivedHandling.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(archivedNow,handlingOneId); } finally { archivedHandling.close(); }
  expectError(await call(api,`/tasks/${handlingOneId}/handling`,{method:'POST',body:{requestId:randomUUID(),expectedVersion:5,handlingMode:'self'}}),409,'TASK_ARCHIVED');
  const unarchiveDb=new Database(dbPath); try { unarchiveDb.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(handlingOneId); } finally { unarchiveDb.close(); }

  // M3-05 视图、筛选与稳定排序
  expectError(await call(api,'/tasks?view=unknown'),400,'INVALID_INPUT');
  expectError(await call(api,'/tasks?view=all&status=unknown'),400,'INVALID_INPUT');
  expectError(await call(api,'/tasks?view=all&bogus=1'),400,'INVALID_INPUT');
  const doingView=await call(api,'/tasks?view=doing&limit=100'); expectSuccess(doingView); assert.ok(doingView.json.data.items.every((item)=>item.handlingMode==='self'));
  const delegatedView=await call(api,'/tasks?view=delegated&limit=100'); expectSuccess(delegatedView); assert.ok(delegatedView.json.data.items.every((item)=>item.handlingMode==='other')); assert.ok(delegatedView.json.data.items.some((item)=>item.id===handlingOneId));
  const selfInDelegated=delegatedView.json.data.items.some((item)=>item.id===handlingTwoId); assert.equal(selfInDelegated,false);
  const sortSpace=await call(api,'/spaces',{method:'POST',body:{requestId:randomUUID(),name:'排序验证'}}); expectSuccess(sortSpace); const sortSpaceId=sortSpace.json.data.id;
  const lowTask=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'低优先级有日期',spaceId:sortSpaceId}}); expectSuccess(lowTask,201);
  const highTask=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'高优先级无日期',spaceId:sortSpaceId}}); expectSuccess(highTask,201);
  const midTask=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'中优先级有日期',spaceId:sortSpaceId}}); expectSuccess(midTask,201);
  expectSuccess(await call(api,`/tasks/${lowTask.json.data.id}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'low',plannedDate:'2026-12-01',dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}));
  expectSuccess(await call(api,`/tasks/${highTask.json.data.id}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'high',plannedDate:null,dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}));
  expectSuccess(await call(api,`/tasks/${midTask.json.data.id}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'medium',plannedDate:'2026-11-01',dueDate:null,followUpDate:null,nextAction:'',blockedReason:''}}));
  const sortedList=await call(api,`/tasks?view=all&spaceId=${sortSpaceId}`); expectSuccess(sortedList); assert.deepEqual(sortedList.json.data.items.map((item)=>item.title),['高优先级无日期','中优先级有日期','低优先级有日期']);
  const statusFilter=await call(api,`/tasks?view=all&spaceId=${sortSpaceId}&status=todo`); expectSuccess(statusFilter); assert.equal(statusFilter.json.data.total,3);
  const statusFilterNone=await call(api,`/tasks?view=all&spaceId=${sortSpaceId}&status=done`); expectSuccess(statusFilterNone); assert.equal(statusFilterNone.json.data.total,0);
  const todayFixture=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'今天要跟进',spaceId:sortSpaceId}}); expectSuccess(todayFixture,201);
  expectSuccess(await call(api,`/tasks/${todayFixture.json.data.id}/planning`,{method:'PATCH',body:{requestId:randomUUID(),expectedVersion:1,priority:'none',plannedDate:null,dueDate:null,followUpDate:'2026-01-05',nextAction:'',blockedReason:''}}));
  const todayView=await call(api,'/tasks?view=today&limit=100'); expectSuccess(todayView); const todayItem=todayView.json.data.items.find((item)=>item.id===todayFixture.json.data.id); assert.ok(todayItem); assert.equal(todayItem.risk.followUpDue,true); assert.equal(todayView.json.data.today,shToday);
  const noDate=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'没有日期不进今天',spaceId:sortSpaceId}}); expectSuccess(noDate,201);
  assert.equal(todayView.json.data.items.some((item)=>item.id===noDate.json.data.id),false);
  const allDefault=await call(api,`/tasks?view=all&spaceId=${sortSpaceId}`); expectSuccess(allDefault); const allWithEnded=await call(api,`/tasks?view=all&spaceId=${sortSpaceId}&includeEnded=true`); expectSuccess(allWithEnded); assert.ok(allWithEnded.json.data.total>=allDefault.json.data.total);
  const projectScoped=await call(api,`/tasks?view=all&projectId=${projectAId}`); expectSuccess(projectScoped); assert.equal(projectScoped.json.data.total,0);
  const watchedView=await call(api,'/tasks?view=watched'); expectSuccess(watchedView); assert.equal(watchedView.json.data.items.length,0);
  const waitingView=await call(api,'/tasks?view=waiting'); expectSuccess(waitingView); assert.ok(waitingView.json.data.items.every((item)=>item.status==='waiting'));
  const space=dbOpenSpace();
  const zero=dbCounts();
  const badSpace=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'bad space',spaceId:'missing'}});
  expectError(badSpace,404,'SPACE_NOT_FOUND'); assert.deepEqual(dbCounts(),zero);
  const blank=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'  ',spaceId:space}});
  expectError(blank,400,'INVALID_TITLE'); assert.ok(blank.json.error.fieldErrors.title); assert.deepEqual(dbCounts(),zero);
  const forged=await call(api,'/tasks',{method:'POST',body:{requestId:randomUUID(),title:'forged owner',spaceId:space,ownerUserId:'attacker',status:'done'}});
  expectError(forged,400,'INVALID_INPUT'); assert.ok(forged.json.error.fieldErrors.ownerUserId); assert.deepEqual(dbCounts(),zero);

  const injectedId1=randomUUID(); const injectedId2=randomUUID();
  const beforeInjected=dbCounts();
  const injDb=new Database(dbPath);
  try {
    injDb.exec("CREATE TRIGGER m1_fail_created_event BEFORE INSERT ON task_events WHEN NEW.type='task_created' BEGIN SELECT RAISE(ABORT,'injected_event_failure'); END");
  } finally { injDb.close(); }
  const eventFailure=await call(api,'/tasks',{method:'POST',body:{requestId:injectedId1,title:'rollback event',spaceId:space}}); expectError(eventFailure,500,'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(eventFailure.json).includes('injected_event_failure')); assert.deepEqual(dbCounts(),beforeInjected);
  const dropEventDb=new Database(dbPath); try { dropEventDb.exec('DROP TRIGGER m1_fail_created_event'); } finally { dropEventDb.close(); }
  const replayFailureDb=new Database(dbPath); try { replayFailureDb.exec("CREATE TRIGGER m1_fail_replay BEFORE INSERT ON mutation_requests BEGIN SELECT RAISE(ABORT,'injected_replay_failure'); END"); } finally { replayFailureDb.close(); }
  const replayFailure=await call(api,'/tasks',{method:'POST',body:{requestId:injectedId2,title:'rollback replay',spaceId:space}}); expectError(replayFailure,500,'INTERNAL_ERROR'); assert.deepEqual(dbCounts(),beforeInjected);
  const dropReplayDb=new Database(dbPath); try { dropReplayDb.exec('DROP TRIGGER m1_fail_replay'); } finally { dropReplayDb.close(); }

  const createRequestId=randomUUID(); const createBody={requestId:createRequestId,title:'并发幂等任务',spaceId:space};
  const parallel=await Promise.all([call(api,'/tasks',{method:'POST',body:createBody}),call(api,'/tasks',{method:'POST',body:createBody})]);
  assert.deepEqual(parallel.map(x=>x.status).sort(),[200,201]);
  for (const r of parallel) { assert.equal(r.json.requestId,createRequestId); assert.ok(r.json.data); }
  taskId=parallel[0].json.data.id; assert.equal(parallel[1].json.data.id,taskId);
  assert.equal(parallel.filter(x=>x.response.headers.get('idempotency-replayed')==='true').length,1);
  assert.equal(dbCount(`SELECT count(*) FROM tasks WHERE id=?`,taskId),1);
  assert.equal(dbCount(`SELECT count(*) FROM task_events WHERE task_id=?`,taskId),1);
  assert.equal(dbCount(`SELECT count(*) FROM mutation_requests WHERE user_id=(SELECT id FROM users LIMIT 1) AND request_id=?`,createRequestId),1);
  const replay=await call(api,'/tasks',{method:'POST',body:createBody}); assert.equal(replay.status,200); assert.equal(replay.json.data.id,taskId);
  const mismatch=await call(api,'/tasks',{method:'POST',body:{...createBody,title:'changed'}}); expectError(mismatch,409,'REQUEST_ID_REUSED');
  const crossAction=await call(api,'/tasks/'+taskId,{method:'PATCH',body:{requestId:createRequestId,title:'cross-method',expectedVersion:1}}); expectError(crossAction,409,'REQUEST_ID_REUSED'); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',taskId),1);

  const beforeUpdateFailure=dbCounts();
  const updateTriggerDb=new Database(dbPath); try { updateTriggerDb.exec("CREATE TRIGGER m1_fail_updated_event BEFORE INSERT ON task_events WHEN NEW.type='task_updated' BEGIN SELECT RAISE(ABORT,'injected_update_event_failure'); END"); } finally { updateTriggerDb.close(); }
  const updateFailure=await call(api,'/tasks/'+taskId,{method:'PATCH',body:{requestId:randomUUID(),title:'rollback update',expectedVersion:1}}); expectError(updateFailure,500,'INTERNAL_ERROR'); assert.deepEqual(dbCounts(),beforeUpdateFailure); assert.equal(dbCount('SELECT version FROM tasks WHERE id=?',taskId),1);
  const dropUpdateTriggerDb=new Database(dbPath); try { dropUpdateTriggerDb.exec('DROP TRIGGER m1_fail_updated_event'); } finally { dropUpdateTriggerDb.close(); }
  const immutableDb=new Database(dbPath); try { assert.throws(()=>immutableDb.prepare('UPDATE task_events SET payload_json=? WHERE task_id=?').run('{}',taskId)); assert.throws(()=>immutableDb.prepare('DELETE FROM task_events WHERE task_id=?').run(taskId)); } finally { immutableDb.close(); }
  const patchA={requestId:randomUUID(),title:'并发修改 A',expectedVersion:1};
  const patchB={requestId:randomUUID(),title:'并发修改 B',expectedVersion:1};
  const concurrent=await Promise.all([call(api,`/tasks/${taskId}`,{method:'PATCH',body:patchA}),call(api,`/tasks/${taskId}`,{method:'PATCH',body:patchB})]);
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
  const conflict=concurrent.find(x=>x.status===409); assert.equal(conflict.json.error.currentVersion,2); assert.equal(conflict.json.error.current.version,2); assert.equal(conflict.json.error.current.id,taskId);
  assert.equal(dbCount(`SELECT count(*) FROM task_events WHERE task_id=?`,taskId),2);
  assert.equal(dbCount(`SELECT version FROM tasks WHERE id=?`,taskId),2);

  const preChangeCookie=cookie;
  const change=await call(api,'/auth/password',{method:'POST',body:{currentPassword:'M1-reset-test-password-9732!',newPassword:'M1-rotated-test-password-5638!'}});
  expectSuccess(change,200);
  cookie=change.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')).split(';')[0];
  expectError(await call(api,'/auth/me',{cookieValue:preChangeCookie}),401,'UNAUTHENTICATED');
  expectSuccess(await call(api,'/auth/me'),200);
  expectError(await call(api,'/auth/password',{method:'POST',body:{currentPassword:'wrong-current-password',newPassword:'M1-another-test-password-1111!'}}),401,'INVALID_CREDENTIALS');
  const logout=await call(api,'/auth/logout',{method:'POST'}); expectSuccess(logout,200);
  const clearCookie=logout.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')); assert.ok(clearCookie && /Max-Age=0|Expires=/i.test(clearCookie));
  cookie=null;
  expectError(await call(api,'/auth/me',{cookieValue:null}),401,'UNAUTHENTICATED');
  const relogin=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'M1-rotated-test-password-5638!'}}); expectSuccess(relogin,200); cookie=relogin.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')).split(';')[0];
  expectError(await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'M1-reset-test-password-9732!'}}),401,'INVALID_CREDENTIALS');

  // Unicode code-point policy: an 80-emoji password must survive change and login.
  const emojiPassword='😀'.repeat(80);
  const emojiChange=await call(api,'/auth/password',{method:'POST',body:{currentPassword:'M1-rotated-test-password-5638!',newPassword:emojiPassword}}); expectSuccess(emojiChange,200);
  cookie=emojiChange.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')).split(';')[0];
  const emojiRelogin=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:emojiPassword}}); expectSuccess(emojiRelogin,200);
  cookie=emojiRelogin.response.headers.getSetCookie().find((v)=>v.startsWith('tasks_session=')).split(';')[0];
  const overLimitLogin=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'😀'.repeat(129)}}); expectError(overLimitLogin,401,'INVALID_CREDENTIALS');

  // Account lockout threshold: five failures establish backoff, the next attempt is 429.
  for(let i=0;i<5;i++) expectError(await call(api,'/auth/login',{method:'POST',cookieValue:null,headers:{'X-Forwarded-For':`192.0.2.${i+1}`},body:{username:'m1-lockout-test',password:'wrong-lockout-pass'}}),401,'INVALID_CREDENTIALS');
  const locked=await call(api,'/auth/login',{method:'POST',cookieValue:null,body:{username:'m1-lockout-test',password:'wrong-lockout-pass'}});
  expectError(locked,429,'RATE_LIMITED'); assert.ok(locked.response.headers.get('retry-after'));

  // WAL snapshot and run-state record.
  const holder=new Database(dbPath);
  try {
    holder.pragma('journal_mode=WAL'); holder.pragma('wal_autocheckpoint=0');
    holder.exec('CREATE TABLE IF NOT EXISTS m1_wal_marker(value TEXT)'); holder.prepare('DELETE FROM m1_wal_marker').run(); holder.prepare('INSERT INTO m1_wal_marker(value) VALUES(?)').run('committed-in-wal');
    const backup=command([path.join(ROOT,'scripts/backup.mjs')],{...envFor(port),TASKS_BACKUP_DIR:backupDir}); assertCommandOk(backup,'backup with uncheckpointed WAL');
  } finally { holder.close(); }
  const artifacts= (await import('node:fs')).readdirSync(backupDir).filter(x=>x.endsWith('.db'));
  assert.equal(artifacts.length,1);
  const artifact=path.join(backupDir,artifacts[0]); assert.equal(Database(artifact,{readonly:true}).prepare('SELECT value FROM m1_wal_marker').get().value,'committed-in-wal');
  assert.equal(dbCount('SELECT count(*) FROM backup_runs WHERE status=? AND local_status=? AND remote_status=?','success','verified','unverified'),1);
  const statusApi=await call(api,'/system/backup-status'); expectSuccess(statusApi,200); assert.equal(statusApi.json.data.latest.status,'success'); assert.equal(statusApi.json.data.latest.remoteStatus,'unverified');
  const restored=path.join(tempRoot,'restored.db'); assertCommandOk(command([path.join(ROOT,'scripts/restore.mjs'),artifact,restored],process.env),'restore backup');
  const restoreDb=new Database(restored,{readonly:true}); try { assert.equal(restoreDb.prepare('SELECT value FROM m1_wal_marker').get().value,'committed-in-wal'); assert.equal(restoreDb.pragma('integrity_check',{simple:true}),'ok'); assert.equal(restoreDb.pragma('foreign_key_check').length,0); assert.equal(restoreDb.prepare('SELECT count(*) n FROM sessions').get().n,0,'restore revokes snapshot sessions'); assert.ok(restoreDb.prepare("SELECT auth_version FROM users WHERE username='owner'").get().auth_version>1); assert.ok(restoreDb.prepare('SELECT count(*) n FROM task_events').get().n>0); } finally { restoreDb.close(); }
  const restoredPort=await freePort(); const restoredApi=await launch(restoredPort,true,restored); secondServer=restoredApi.child;
  expectError(await call(restoredApi,'/auth/me',{cookieValue:cookie}),401,'UNAUTHENTICATED');
  const recoveryLogin=await call(restoredApi,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:emojiPassword}}); expectSuccess(recoveryLogin,200);
  await stop(secondServer); secondServer=null;
  const secondRestore=path.join(tempRoot,'restored-again.db'); assertCommandOk(command([path.join(ROOT,'scripts/restore.mjs'),artifact,secondRestore],process.env),'second isolated restore');
  assert.notEqual(command([path.join(ROOT,'scripts/restore.mjs'),artifact,restored],process.env).status,0,'restore must not overwrite target');
  const corrupt=path.join(tempRoot,'corrupt.db'); writeFileSync(corrupt,readFileSync(artifact)); writeFileSync(`${corrupt}.sha256`,readFileSync(`${artifact}.sha256`)); writeFileSync(corrupt,Buffer.concat([readFileSync(corrupt),Buffer.from('tamper')]));
  assert.notEqual(command([path.join(ROOT,'scripts/restore.mjs'),corrupt,path.join(tempRoot,'corrupt-target.db')],process.env).status,0,'tampered checksum must reject');
  const failedBackup=command([path.join(ROOT,'scripts/backup.mjs'),artifact],{...envFor(port),TASKS_BACKUP_DIR:backupDir}); assert.notEqual(failedBackup.status,0);
  assert.equal(dbCount('SELECT status FROM backup_runs ORDER BY started_at DESC LIMIT 1'),'failed');
  const failedStatus=await call(api,'/system/backup-status'); expectSuccess(failedStatus,200); assert.equal(failedStatus.json.data.latest.status,'failed');

  // DB open errors must be normalized and production must fail closed without configured Origin.
  const brokenPort=await freePort(); const broken=await launch(brokenPort,true,tempRoot); secondServer=broken.child;
  expectError(await call(broken,'/auth/me',{cookieValue:'tasks_session=opaque'}),503,'TEMPORARILY_UNAVAILABLE');
  expectError(await call(broken,'/tasks',{method:'POST',cookieValue:'tasks_session=opaque',body:{requestId:randomUUID(),title:'db down',spaceId:'x'}}),503,'TEMPORARILY_UNAVAILABLE');
  await stop(secondServer); secondServer=null;
  const noOriginPort=await freePort(); const noOrigin=await launch(noOriginPort,false,dbPath); secondServer=noOrigin.child;
  expectError(await call(noOrigin,'/auth/login',{method:'POST',cookieValue:null,body:{username:'owner',password:'not-used'}}),403,'BAD_ORIGIN');
  await stop(secondServer); secondServer=null;

  // Fallback IP bucket must not trust spoofed forwarding headers.
  const rateKey=createHash('sha256').update('ip:untrusted-proxy-single-bucket').digest('hex');
  let failures=dbCount('SELECT failure_count FROM auth_rate_limits WHERE key_hash=?',rateKey) ?? 0;
  let attempt=0;
  while(failures<30) {
    attempt++;
    const r=await call(api,'/auth/login',{method:'POST',cookieValue:null,headers:{'X-Forwarded-For':`198.51.100.${attempt}`},body:{username:`spoof-${attempt}`,password:'wrong-spoofed-ip-password'}});
    expectError(r,401,'INVALID_CREDENTIALS');
    failures=dbCount('SELECT failure_count FROM auth_rate_limits WHERE key_hash=?',rateKey) ?? 0;
  }
  expectError(await call(api,'/auth/login',{method:'POST',cookieValue:null,headers:{'X-Forwarded-For':'203.0.113.244'},body:{username:'owner',password:'M1-rotated-test-password-5638!'}}),429,'RATE_LIMITED');

  // M4-01/M4-02：正文格式、统一保存、修订与守卫（PRD 7.1/7.2、技术设计 5）
  await runM4Checks(api);

  // M4-04：结构化小步骤（PRD 9.3/9.4、FR-22、AT-37）
  await runM4ChecklistChecks(api);
}
function dbCount(sql,...params) {
  const db=new Database(dbPath,{readonly:true});
  try { const result=db.prepare(sql).get(...params); return result ? Object.values(result)[0] : 0; }
  finally { db.close(); }
}
function dbCounts() { return { tasks: dbCount('SELECT count(*) FROM tasks'), events: dbCount('SELECT count(*) FROM task_events'), requests: dbCount('SELECT count(*) FROM mutation_requests') }; }
function dbOpenSpace() {
  const db=new Database(dbPath,{readonly:true});
  try { return db.prepare("SELECT id FROM spaces WHERE name='私人'").get().id; }
  finally { db.close(); }
}

async function main() {
  try {
    await verifyEnvParity();
    await verifyModeIsolation();
    await verifyMigrationPreflight();
    await verifyTtyScripts();
    const env={...process.env,NODE_ENV:'production',TASKS_DB_PATH:dbPath,TASKS_ALLOW_NONINTERACTIVE_INIT:'1',TASKS_INIT_PASSWORD:TEST_PASSWORD};
    assertCommandOk(command([path.join(ROOT,'scripts/migrate.mjs')],env),'fresh migrations');
    assertCommandOk(command([path.join(ROOT,'scripts/init-account.mjs')],env),'account initialization');
    const seeded=new Database(dbPath,{readonly:true});
    try { assert.equal(seeded.prepare('SELECT count(*) n FROM users').get().n,1); assert.equal(seeded.prepare('SELECT count(*) n FROM spaces').get().n,4); } finally { seeded.close(); }
    await runApiSuite();
    console.log('M1 isolated integration suite: PASS');
  } finally {
    await stop(server); await stop(secondServer);
    rmSync(tempRoot,{recursive:true,force:true});
  }
}
await main();

async function verifyTtyScripts() {
  const available = spawnSync('which', ['expect'], { encoding: 'utf8' });
  if (available.status !== 0) { console.log('M1 TTY password checks: SKIP (expect unavailable)'); return; }
  const ttyDb = path.join(tempRoot, 'tty-password.db');
  assertCommandOk(command([path.join(ROOT, 'scripts/migrate.mjs')], { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: ttyDb }), 'TTY password test migration');
  const runExpect = (script) => spawnSync('expect', ['-c', script], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const scriptFor = (scriptPath, firstPrompt, firstPassword, secondPrompt, secondPassword, completion) => [
    'set timeout 20',
    `spawn env TASKS_DB_PATH=${ttyDb} ${NODE} ${scriptPath}`,
    `expect "${firstPrompt}"`,
    `send "${firstPassword}\\r"`,
    `expect "${secondPrompt}"`,
    `send "${secondPassword}\\r"`,
    `expect "${completion}"`,
    'expect eof',
    'set w [wait]',
    'exit [lindex $w 3]',
  ].join('\n');
  const initPath = path.join(ROOT, 'scripts/init-account.mjs');
  const badInit = runExpect(scriptFor(initPath, '请设置登录密码', 'M1-init-first-secret-6342!', '请再次输入以确认', 'M1-init-second-secret-1964!', '两次输入不一致'));
  assert.equal(badInit.status, 1, badInit.stdout + badInit.stderr);
  assert.ok(!badInit.stdout.includes('M1-init-first-secret') && !badInit.stdout.includes('M1-init-second-secret'));
  let check = new Database(ttyDb, { readonly: true });
  try { assert.equal(check.prepare('SELECT count(*) n FROM users').get().n, 0); } finally { check.close(); }
  const goodInit = runExpect(scriptFor(initPath, '请设置登录密码', 'M1-tty-initial-password-4927!', '请再次输入以确认', 'M1-tty-initial-password-4927!', '账号 owner 创建成功'));
  assert.equal(goodInit.status, 0, goodInit.stdout + goodInit.stderr);
  assert.ok(!goodInit.stdout.includes('M1-tty-initial-password'));
  const seed = new Database(ttyDb);
  try { seed.prepare("INSERT INTO sessions(id_hash,user_id,auth_version,expires_at,created_at) SELECT 'preexisting-hash',id,auth_version,'2099-01-01T00:00:00.000Z','2026-10-12T00:00:00.000Z' FROM users WHERE username='owner'").run(); } finally { seed.close(); }
  const resetPath = path.join(ROOT, 'scripts/reset-password.mjs');
  const badReset = runExpect(scriptFor(resetPath, '输入新密码', 'M1-reset-first-secret-3287!', '再次输入新密码', 'M1-reset-second-secret-8241!', '两次密码不一致'));
  assert.equal(badReset.status, 1, badReset.stdout + badReset.stderr);
  assert.ok(!badReset.stdout.includes('M1-reset-first-secret') && !badReset.stdout.includes('M1-reset-second-secret'));
  check = new Database(ttyDb, { readonly: true });
  try { assert.equal(check.prepare('SELECT auth_version FROM users').get().auth_version, 1); assert.equal(check.prepare('SELECT count(*) n FROM sessions').get().n, 1); } finally { check.close(); }
  const goodReset = runExpect(scriptFor(resetPath, '输入新密码', 'M1-tty-reset-password-7384!', '再次输入新密码', 'M1-tty-reset-password-7384!', '密码已重置'));
  assert.equal(goodReset.status, 0, goodReset.stdout + goodReset.stderr);
  assert.ok(!goodReset.stdout.includes('M1-tty-reset-password'));
  check = new Database(ttyDb, { readonly: true });
  try { assert.equal(check.prepare('SELECT auth_version FROM users').get().auth_version, 2); assert.equal(check.prepare('SELECT count(*) n FROM sessions').get().n, 0); } finally { check.close(); }
  console.log('M1 TTY password checks: PASS');
}

/** Prove .env.development/.env.production are honored by data commands and app startup. */
async function verifyModeIsolation() {
  const project=path.join(tempRoot,'env-project');
  rmSync(path.join(project,'.env.local'),{force:true});
  cpSync(path.join(ROOT,'src'),path.join(project,'src'),{recursive:true});
  cpSync(path.join(ROOT,'db'),path.join(project,'db'),{recursive:true});
  cpSync(path.join(ROOT,'scripts'),path.join(project,'scripts'),{recursive:true});
  cpSync(path.join(ROOT,'next.config.ts'),path.join(project,'next.config.ts'));
  cpSync(path.join(ROOT,'tsconfig.json'),path.join(project,'tsconfig.json'));
  cpSync(path.join(ROOT,'package.json'),path.join(project,'package.json'));
  cpSync(path.join(ROOT,'.next'),path.join(project,'.next'),{recursive:true});
  symlinkSync(path.join(ROOT,'node_modules'),path.join(project,'node_modules'),'dir');
  const devDb=path.join(project,'data-dev','tasks.db');
  const prodDb=path.join(project,'data-prod','tasks.db');
  const devPassword='M1-dev-mode-password-9431!';
  const prodPassword='M1-prod-mode-password-8427!';
  writeFileSync(path.join(project,'.env.development'),`TASKS_DB_PATH=${devDb}\nTASKS_ALLOW_NONINTERACTIVE_INIT=1\nTASKS_INIT_PASSWORD=${devPassword}\n`);
  writeFileSync(path.join(project,'.env.production'),`TASKS_DB_PATH=${prodDb}\nTASKS_ALLOW_NONINTERACTIVE_INIT=1\nTASKS_INIT_PASSWORD=${prodPassword}\n`);
  const clean={...process.env};
  const probe=path.join(project,'probe-env.mjs');
  writeFileSync(probe,'import {loadEnvFiles,resolveDbPath} from "./scripts/lib/env.mjs"; loadEnvFiles(); console.log(resolveDbPath());\n');
  for(const key of ['TASKS_DB_PATH','TASKS_DATA_DIR','TASKS_ALLOW_NONINTERACTIVE_INIT','TASKS_INIT_PASSWORD','TASKS_PUBLIC_ORIGIN','__NEXT_PROCESSED_ENV']) delete clean[key];
  for(const [mode,db,password] of [['development',devDb,devPassword],['production',prodDb,prodPassword]]) {
    const resolved=command([probe],{...clean,NODE_ENV:mode},project); assertCommandOk(resolved,` env resolution`); assert.equal(resolved.stdout.trim(),db,` env file path`);
    const modeEnv={...clean,NODE_ENV:mode,TASKS_DB_PATH:db,TASKS_ALLOW_NONINTERACTIVE_INIT:'1',TASKS_INIT_PASSWORD:password};
    assertCommandOk(command([path.join(project,'scripts/migrate.mjs')],modeEnv,project),`${mode} mode migration`);
    assertCommandOk(command([path.join(project,'scripts/init-account.mjs')],modeEnv,project),`${mode} mode account initialization`);
    const seeded=new Database(db,{readonly:true});
    try { assert.equal(seeded.prepare('SELECT count(*) n FROM users').get().n,1); assert.equal(seeded.prepare('SELECT count(*) n FROM spaces').get().n,4); } finally { seeded.close(); }
  }
  assert.notEqual(devDb,prodDb); assert.ok(existsSync(devDb)&&existsSync(prodDb));
  const devUser=new Database(devDb,{readonly:true}); const prodUser=new Database(prodDb,{readonly:true});
  try {
    assert.notEqual(devUser.prepare('SELECT password_hash FROM users').get().password_hash,prodUser.prepare('SELECT password_hash FROM users').get().password_hash);
  } finally { devUser.close(); prodUser.close(); }

  // The application itself must load the database path for each NODE_ENV.
  const startAndCheck=async(mode,args,password,appRoot=project)=>{
    const port=await freePort();
    const env={...clean,NODE_ENV:mode,TASKS_PUBLIC_ORIGIN:`http://localhost:${port}`};
    const log=path.join(tempRoot,`mode-${mode}.log`);
    const child=spawn(NODE,[path.join(appRoot,'node_modules/next/dist/bin/next'),...args,'-H','127.0.0.1','-p',String(port)],{cwd:appRoot,env,stdio:['ignore','pipe','pipe']});
    const out=(await import('node:fs')).createWriteStream(log,{flags:'a'}); child.stdout.pipe(out); child.stderr.pipe(out);
    const base=`http://127.0.0.1:${port}/tasks/api`;
    try {
      let ready=false;
      for(let i=0;i<120;i++) {
        if(child.exitCode!==null) throw new Error(`${mode} app exited: ${readFileSync(log,'utf8')}`);
        try { if((await fetch(`${base}/healthz`)).ok){ready=true;break;} } catch {}
        await sleep(250);
      }
      assert.ok(ready,`${mode} app not ready: ${readFileSync(log,'utf8')}`);
      const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{Origin:`http://localhost:${port}`,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password})});
      assert.equal(response.status,200,`${mode} app selected wrong DB: ${await response.text()}`);
    } finally { await stop(child); }
  };
  await startAndCheck('development',['dev','--webpack'],devPassword);
  // Start each mode from the fixture project so Next loads the matching .env file.
  await startAndCheck('production',['start'],prodPassword);
  console.log('M1 dev/prod DB path isolation: PASS');
}

/**
 * M4-01/M4-02 隔离集成检查（PRD v0.6 7.1/7.2、技术设计 5.1/5.2/5.3、AT-28～31）。
 * 全部通过真实 HTTP + 真实 SQLite 验证：正文格式与派生文本、统一保存一次版本、
 * 幂等与版本冲突、码点与请求体上限、旧纯文本升级不误解释、正文历史只追加、
 * 结束/归档守卫与来源校验。
 */
async function runM4Checks(api) {
  const created = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 正文与安排' } });
  expectSuccess(created, 201);
  const id = created.json.data.id;

  // 默认：旧纯文本格式 + 空正文；未登录或不存在的事项不得读取正文历史
  const fresh = await call(api, `/tasks/${id}`); expectSuccess(fresh, 200);
  assert.equal(fresh.json.data.description, ''); assert.equal(fresh.json.data.descriptionFormat, 'plaintext');
  expectError(await call(api, `/tasks/${id}/body-revisions`, { cookieValue: null }), 401, 'UNAUTHENTICATED');
  expectError(await call(api, `/tasks/${randomUUID()}/body-revisions`), 404, 'TASK_NOT_FOUND');
  expectError(await call(api, `/tasks/${randomUUID()}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, description: 'x', descriptionFormat: 'markdown_v1' } }), 404, 'TASK_NOT_FOUND');

  // 统一保存：标题 + 正文 + 安排 → 一次版本、一条事件、一条修订
  const saveRequestId = randomUUID();
  const saveBody = {
    requestId: saveRequestId, expectedVersion: fresh.json.data.version,
    title: 'M4 正文与安排（已完善）',
    description: '## 背景\n\n需要 **核实** 门店数据，参考 [来源](https://example.com/report)。\n\n- 第一步\n- 第二步',
    descriptionFormat: 'markdown_v1',
    priority: 'high', plannedDate: '2026-10-20', dueDate: '2026-10-30', followUpDate: '2026-10-25',
    nextAction: '联系门店', blockedReason: '等待对方',
  };
  const saved = await call(api, `/tasks/${id}`, { method: 'PATCH', body: saveBody }); expectSuccess(saved, 200);
  assert.equal(saved.json.data.version, 2);
  assert.equal(saved.json.data.changed, true);
  assert.equal(saved.json.data.title, saveBody.title);
  assert.equal(saved.json.data.description, saveBody.description);
  assert.equal(saved.json.data.descriptionFormat, 'markdown_v1');
  assert.ok(saved.json.data.body && saved.json.data.body.revisionId);
  assert.equal(saved.json.data.body.hasUnsupportedSyntax, false);
  assert.equal(saved.json.data.body.hasTaskListSyntax, false);
  assert.equal(dbCount('SELECT version FROM tasks WHERE id=?', id), 2);
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', id), 1);
  assert.equal(dbCount("SELECT count(*) FROM task_events WHERE task_id=? AND type='task_updated'", id), 1);
  const derivedPlain = '背景\n需要 核实 门店数据，参考 来源。\n第一步\n第二步';
  assert.equal(dbCount('SELECT content_plain FROM task_body_revisions WHERE task_id=?', id), derivedPlain);
  assert.equal(dbCount('SELECT description_plain FROM tasks WHERE id=?', id), derivedPlain);
  // 更新事件只带摘要，不落全文（AT-31）
  const eventPayload = dbCount("SELECT payload_json FROM task_events WHERE task_id=? AND type='task_updated'", id);
  assert.ok(!eventPayload.includes('核实'), eventPayload);
  const parsedEvent = JSON.parse(eventPayload);
  assert.equal(parsedEvent.version, 2);
  assert.equal(typeof parsedEvent.changes.description.to, 'number');
  assert.equal(parsedEvent.changes.priority.to, 'high');
  assert.equal(parsedEvent.body.length, [...saveBody.description].length);
  const detailAfter = await call(api, `/tasks/${id}`); expectSuccess(detailAfter, 200);
  assert.equal(detailAfter.json.data.description, saveBody.description);
  assert.equal(detailAfter.json.data.descriptionFormat, 'markdown_v1');
  assert.equal(detailAfter.json.data.priority, 'high'); assert.equal(detailAfter.json.data.dueDate, '2026-10-30');

  // 幂等：同 requestId 同正文重放不新增版本/修订；同 requestId 换正文被拒绝
  const replay = await call(api, `/tasks/${id}`, { method: 'PATCH', body: saveBody }); expectSuccess(replay, 200);
  assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
  assert.equal(dbCount('SELECT version FROM tasks WHERE id=?', id), 2);
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', id), 1);
  expectError(await call(api, `/tasks/${id}`, { method: 'PATCH', body: { ...saveBody, description: '改了内容' } }), 409, 'REQUEST_ID_REUSED');

  // 相同正文再次保存（新 requestId）不递增版本、不新增修订
  const unchanged = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, description: saveBody.description, descriptionFormat: 'markdown_v1' } });
  expectSuccess(unchanged, 200); assert.equal(unchanged.json.data.changed, false); assert.equal(unchanged.json.data.version, 2);
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', id), 1);

  // 版本冲突：不落修订、不改正文
  expectError(await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, description: '冲突内容', descriptionFormat: 'markdown_v1' } }), 409, 'VERSION_CONFLICT');
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', id), 1);
  assert.equal(dbCount('SELECT description FROM tasks WHERE id=?', id), saveBody.description);

  // 字段与日期校验
  const badRange = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, plannedDate: '2026-11-01', dueDate: '2026-10-30' } });
  expectError(badRange, 400, 'INVALID_DATE'); assert.ok(badRange.json.error.fieldErrors.plannedDate);
  const badPriority = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, priority: 'urgent' } });
  expectError(badPriority, 400, 'INVALID_INPUT'); assert.ok(badPriority.json.error.fieldErrors.priority);
  const unknownField = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, descriptionPlain: '越权派生值' } });
  expectError(unknownField, 400, 'INVALID_INPUT'); assert.ok(unknownField.json.error.fieldErrors.descriptionPlain);
  assert.equal(dbCount('SELECT version FROM tasks WHERE id=?', id), 2);

  // 码点上限（20,000）与路由体积上限（128KiB，技术设计 5.3）
  const tooLong = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, description: '😀'.repeat(20001), descriptionFormat: 'markdown_v1' } });
  expectError(tooLong, 400, 'INVALID_INPUT'); assert.ok(tooLong.json.error.fieldErrors.description);
  const tooLargeBody = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, description: 'a'.repeat(140000), descriptionFormat: 'markdown_v1' } });
  expectError(tooLargeBody, 413, 'BODY_TOO_LARGE');
  assert.equal(dbCount('SELECT version FROM tasks WHERE id=?', id), 2);

  // 净化契约：危险链接与 HTML 原样保存但被标记（渲染净化见 test-m4-body.mjs）
  const unsafeDescription = '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n| a | b |\n| - | - |';
  const unsafeSaved = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, description: unsafeDescription, descriptionFormat: 'markdown_v1' } });
  expectSuccess(unsafeSaved, 200);
  assert.equal(unsafeSaved.json.data.description, unsafeDescription);
  assert.equal(unsafeSaved.json.data.body.hasUnsupportedSyntax, true);
  assert.equal(dbCount('SELECT description FROM tasks WHERE id=?', id), unsafeDescription);

  // 复选框语法：只提示，不产生第二套互动状态（M4-04 才提供结构化小步骤）
  const checkboxSaved = await call(api, `/tasks/${id}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: unsafeSaved.json.data.version, description: '待办：\n\n- [ ] 打电话\n- [x] 发邮件', descriptionFormat: 'markdown_v1' } });
  expectSuccess(checkboxSaved, 200);
  assert.equal(checkboxSaved.json.data.body.hasTaskListSyntax, true);
  assert.ok(dbCount('SELECT description_plain FROM tasks WHERE id=?', id).includes('打电话'));
  assert.ok(!dbCount('SELECT description_plain FROM tasks WHERE id=?', id).includes('[ ] 打电话'), '复选框标记不入搜索派生文本');

  // 旧纯文本升级：先转义再解释，原文本不被误当成格式（AT-28）
  const legacy = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 旧纯文本升级' } }); expectSuccess(legacy, 201);
  const legacyId = legacy.json.data.id;
  const legacyText = '# 这不是标题\n*这不是斜体*\n- 这不是列表';
  const legacySaved = await call(api, `/tasks/${legacyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, description: legacyText, descriptionFormat: 'plaintext' } });
  expectSuccess(legacySaved, 200);
  assert.equal(legacySaved.json.data.descriptionFormat, 'plaintext');
  assert.equal(legacySaved.json.data.body.format, 'plaintext');
  assert.equal(legacySaved.json.data.body.hasUnsupportedSyntax, false);
  assert.equal(dbCount('SELECT description_plain FROM tasks WHERE id=?', legacyId), legacyText);
  const upgrade = await call(api, `/tasks/${legacyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 2, description: legacyText, descriptionFormat: 'markdown_v1', convertFromPlaintext: true } });
  expectSuccess(upgrade, 200);
  assert.equal(upgrade.json.data.descriptionFormat, 'markdown_v1');
  assert.equal(upgrade.json.data.description, '\\# 这不是标题\n\\*这不是斜体\\*\n\\- 这不是列表');
  assert.equal(dbCount('SELECT description_plain FROM tasks WHERE id=?', legacyId), legacyText);
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', legacyId), 2);
  // 修订只追加：第一版仍是原纯文本，不被后续改写（AT-31）
  assert.equal(dbCount('SELECT content FROM task_body_revisions WHERE task_id=? AND task_version=2', legacyId), legacyText);
  assert.equal(dbCount('SELECT format FROM task_body_revisions WHERE task_id=? AND task_version=2', legacyId), 'plaintext');
  // 未显式声明 convertFromPlaintext 时不得改写用户原文
  const noConvert = await call(api, `/tasks/${legacyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 3, description: '# 这是标题', descriptionFormat: 'markdown_v1' } });
  expectSuccess(noConvert, 200); assert.equal(noConvert.json.data.description, '# 这是标题');

  // 正文历史读取：倒序分页，含格式与来源版本
  const revisions = await call(api, `/tasks/${legacyId}/body-revisions`); expectSuccess(revisions, 200);
  assert.equal(revisions.json.data.items.length, 3);
  assert.equal(revisions.json.data.items[0].format, 'markdown_v1');
  assert.equal(revisions.json.data.items[0].taskVersion, 4);
  assert.equal(revisions.json.data.items[2].taskVersion, 2);
  assert.equal(revisions.json.data.items[2].format, 'plaintext');

  // 结束事项：正文仍可编辑，但不能新增跟进日期（PRD 10.4）
  const toDone = await call(api, `/tasks/${legacyId}/transition`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 4, status: 'done' } });
  expectSuccess(toDone, 200); assert.equal(toDone.json.data.status, 'done');
  const endedFollowUp = await call(api, `/tasks/${legacyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: toDone.json.data.version, followUpDate: '2026-11-05' } });
  expectError(endedFollowUp, 400, 'INVALID_INPUT'); assert.ok(endedFollowUp.json.error.fieldErrors.followUpDate);
  const doneBody = await call(api, `/tasks/${legacyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: toDone.json.data.version, description: '# 这是标题\n\n完成后补充说明' } });
  expectSuccess(doneBody, 200); assert.equal(doneBody.json.data.changed, true);

  // 归档事项拒绝写入且无副作用
  const archiveTarget = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 归档守卫' } }); expectSuccess(archiveTarget, 201);
  const archiveId = archiveTarget.json.data.id;
  const archiveDb = new Database(dbPath);
  try {
    const before = archiveDb.prepare('SELECT version,description FROM tasks WHERE id=?').get(archiveId);
    archiveDb.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(new Date().toISOString(), archiveId);
    expectError(await call(api, `/tasks/${archiveId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, description: '归档后写入', descriptionFormat: 'markdown_v1' } }), 409, 'TASK_ARCHIVED');
    assert.deepEqual(archiveDb.prepare('SELECT version,description FROM tasks WHERE id=?').get(archiveId), before);
    assert.equal(archiveDb.prepare('SELECT count(*) n FROM task_body_revisions WHERE task_id=?').get(archiveId).n, 0);
    archiveDb.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(archiveId);
  } finally { archiveDb.close(); }

  // 来源校验：非受信 Origin 的正文写入仍被拒绝
  expectError(await call(api, `/tasks/${id}`, { method: 'PATCH', origin: 'http://attacker.invalid', body: { requestId: randomUUID(), expectedVersion: checkboxSaved.json.data.version, description: 'x' } }), 403, 'BAD_ORIGIN');

  console.log('M4 body checks: PASS');
}

/**
 * M4-04 隔离集成检查（PRD 9.3/9.4、7.1；FR-22；AT-37）。
 * 覆盖：增删改查、排序与边界、上限 100、文本校验、条目/事项版本冲突、跨事项隔离、
 * 幂等重放、勾选不改变父事项状态与任务计数、归档守卫、事件只保存摘要、
 * 正文静态 `- [ ]` 一次性转为小步骤。
 */
async function runM4ChecklistChecks(api) {
  const created = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 小步骤清单' } });
  expectSuccess(created, 201);
  const id = created.json.data.id;

  // 初始为空；未登录不可读、事项不存在 404
  const empty = await call(api, `/tasks/${id}/checklist`); expectSuccess(empty, 200);
  assert.deepEqual(empty.json.data.items, []);
  assert.deepEqual(empty.json.data.counts, { total: 0, checked: 0, unchecked: 0 });
  expectError(await call(api, `/tasks/${id}/checklist`, { cookieValue: null }), 401, 'UNAUTHENTICATED');
  expectError(await call(api, `/tasks/${randomUUID()}/checklist`), 404, 'TASK_NOT_FOUND');

  // 新增：追加到末尾、默认未勾选、排序键定宽
  const first = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '  打电话预约  ' } });
  expectSuccess(first, 200);
  assert.equal(first.json.data.counts.total, 1);
  assert.equal(first.json.data.items[0].text, '打电话预约');
  assert.equal(first.json.data.items[0].isChecked, false);
  assert.equal(first.json.data.items[0].sortKey, '0000');
  assert.equal(first.json.data.items[0].version, 1);
  assert.equal(first.json.data.items[0].promotedTaskId, null);
  const firstItemId = first.json.data.items[0].id;
  const second = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '发邮件' } });
  expectSuccess(second, 200);
  const secondItemId = second.json.data.items[1].id;
  assert.equal(second.json.data.items[1].sortKey, '0001');

  // 勾选不改变父事项状态与版本，也不进入任务计数（AT-37）
  const beforeTask = await call(api, `/tasks/${id}`); expectSuccess(beforeTask, 200);
  const beforeAll = await call(api, '/tasks?view=all&includeEnded=true'); expectSuccess(beforeAll, 200);
  const beforeToday = await call(api, '/tasks?view=today'); expectSuccess(beforeToday, 200);
  const toggle = await call(api, `/tasks/${id}/checklist/${firstItemId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1, isChecked: true } });
  expectSuccess(toggle, 200);
  assert.equal(toggle.json.data.items[0].isChecked, true);
  assert.equal(toggle.json.data.items[0].version, 2);
  assert.equal(toggle.json.data.counts.checked, 1);
  const afterTask = await call(api, `/tasks/${id}`); expectSuccess(afterTask, 200);
  assert.equal(afterTask.json.data.status, beforeTask.json.data.status, '勾选不得改变事项状态');
  assert.equal(afterTask.json.data.version, beforeTask.json.data.version, '勾选不得改变事项版本');
  assert.equal(afterTask.json.data.isProcessed, beforeTask.json.data.isProcessed);
  const afterAll = await call(api, '/tasks?view=all&includeEnded=true'); expectSuccess(afterAll, 200);
  const afterToday = await call(api, '/tasks?view=today'); expectSuccess(afterToday, 200);
  assert.equal(afterAll.json.data.total, beforeAll.json.data.total, '小步骤不得进入任务计数');
  assert.equal(afterToday.json.data.total, beforeToday.json.data.total, '小步骤不得进入今天视图');
  assert.equal(dbCount('SELECT count(*) FROM tasks WHERE title=?', '发邮件'), 0, '小步骤不得成为事项');

  // 幂等重放与 requestId 复用；事件只保存摘要
  const replayBody = { requestId: randomUUID(), expectedVersion: 1, text: '只应出现一次' };
  const once = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: replayBody }); expectSuccess(once, 200);
  const replay = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: replayBody }); expectSuccess(replay, 200);
  assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
  assert.equal(dbCount('SELECT count(*) FROM checklist_items WHERE task_id=? AND text=?', id, '只应出现一次'), 1);
  expectError(await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { ...replayBody, text: '换了文本' } }), 409, 'REQUEST_ID_REUSED');
  const createdEvent = dbCount("SELECT payload_json FROM task_events WHERE task_id=? AND type='task_updated' ORDER BY occurred_at DESC LIMIT 1", id);
  assert.equal(JSON.parse(createdEvent).checklist.action, 'created');
  assert.equal(JSON.parse(createdEvent).checklist.textLength, 6);
  assert.equal(createdEvent.includes('只应出现一次'), false, '事件不得保存小步骤全文');

  // 文本/字段/版本/条目归属校验
  expectError(await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '   ' } }), 400, 'INVALID_INPUT');
  const tooLong = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '😀'.repeat(501) } });
  expectError(tooLong, 400, 'INVALID_INPUT'); assert.ok(tooLong.json.error.fieldErrors.text);
  expectError(await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: 'x', unexpected: 1 } }), 400, 'INVALID_INPUT');
  expectError(await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 99, text: '版本不对' } }), 409, 'VERSION_CONFLICT');
  expectError(await call(api, `/tasks/${id}/checklist/${randomUUID()}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1, isChecked: true } }), 404, 'CHECKLIST_ITEM_NOT_FOUND');
  expectError(await call(api, `/tasks/${id}/checklist/${firstItemId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1, isChecked: false } }), 409, 'ITEM_VERSION_CONFLICT');
  const other = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 小步骤隔离' } }); expectSuccess(other, 201);
  expectError(await call(api, `/tasks/${other.json.data.id}/checklist/${firstItemId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: other.json.data.version, itemVersion: 2, isChecked: false } }), 404, 'CHECKLIST_ITEM_NOT_FOUND');

  // 排序：边界不动、相邻交换、排序键连续
  const third = await call(api, `/tasks/${id}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '第三条' } });
  expectSuccess(third, 200);
  const orderBefore = third.json.data.items.map((item) => item.text);
  const boundary = await call(api, `/tasks/${id}/checklist/${firstItemId}/move`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 2, direction: 'up' } });
  expectSuccess(boundary, 200);
  assert.equal(boundary.json.data.changed, false, '首项上移不应有变化');
  assert.deepEqual(boundary.json.data.items.map((item) => item.text), orderBefore);
  const moved = await call(api, `/tasks/${id}/checklist/${secondItemId}/move`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1, direction: 'down' } });
  expectSuccess(moved, 200);
  assert.equal(moved.json.data.changed, true);
  assert.notDeepEqual(moved.json.data.items.map((item) => item.text), orderBefore);
  assert.deepEqual(moved.json.data.items.map((item) => item.sortKey), orderBefore.map((_, index) => String(index).padStart(4, '0')));
  expectError(await call(api, `/tasks/${id}/checklist/${secondItemId}/move`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1, direction: 'sideways' } }), 400, 'INVALID_INPUT');

  // 删除后重排
  const removableId = moved.json.data.items.find((item) => item.text === '只应出现一次').id;
  const removed = await call(api, `/tasks/${id}/checklist/${removableId}/remove`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, itemVersion: 1 } });
  expectSuccess(removed, 200);
  assert.equal(removed.json.data.items.some((item) => item.text === '只应出现一次'), false);
  assert.deepEqual(removed.json.data.items.map((item) => item.sortKey), removed.json.data.items.map((_, index) => String(index).padStart(4, '0')));
  assert.equal(removed.json.data.counts.total, orderBefore.length - 1);

  // 上限 100：播种到 100 条后新增被拒绝
  const limitTask = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 小步骤上限' } });
  expectSuccess(limitTask, 201);
  const limitId = limitTask.json.data.id;
  const seedDb = new Database(dbPath);
  try {
    const ownerId = seedDb.prepare('SELECT owner_user_id FROM tasks WHERE id=?').get(limitId).owner_user_id;
    const insert = seedDb.prepare('INSERT INTO checklist_items(id,owner_user_id,task_id,text,is_checked,sort_key,promoted_task_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const nowIso = new Date().toISOString();
    seedDb.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run(randomUUID(), ownerId, limitId, `播种 ${index}`, 0, String(index).padStart(4, '0'), null, 1, nowIso, nowIso);
      }
    })();
  } finally { seedDb.close(); }
  const seeded = await call(api, `/tasks/${limitId}/checklist`); expectSuccess(seeded, 200);
  assert.equal(seeded.json.data.counts.total, 100);
  expectError(await call(api, `/tasks/${limitId}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '第101条' } }), 409, 'CHECKLIST_LIMIT');

  // 正文静态复选框一次性转为小步骤（PRD 7.1）
  const bodyTask = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 静态复选框导入' } });
  expectSuccess(bodyTask, 201);
  const bodyId = bodyTask.json.data.id;
  const bodyText = '# 待办\n\n- [ ] 打电话\n- [x] 发邮件\n\n正文保留';
  const bodySaved = await call(api, `/tasks/${bodyId}`, { method: 'PATCH', body: { requestId: randomUUID(), expectedVersion: 1, description: bodyText, descriptionFormat: 'plaintext' } });
  expectSuccess(bodySaved, 200);
  const imported = await call(api, `/tasks/${bodyId}/checklist/import`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 2 } });
  expectSuccess(imported, 200);
  assert.equal(imported.json.data.imported, 2);
  assert.equal(imported.json.data.removedLines, 2);
  assert.equal(imported.json.data.version, 3);
  assert.equal(imported.json.data.description, '# 待办\n\n正文保留');
  assert.deepEqual(imported.json.data.items.map((item) => [item.text, item.isChecked]), [['打电话', false], ['发邮件', true]]);
  assert.equal(dbCount('SELECT count(*) FROM task_body_revisions WHERE task_id=?', bodyId), 2, '导入应留下正文修订');
  const again = await call(api, `/tasks/${bodyId}/checklist/import`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 3 } });
  expectSuccess(again, 200);
  assert.equal(again.json.data.changed, false);
  assert.equal(again.json.data.imported, 0);

  // 归档守卫：写入被拒、读取仍可
  const archiveTarget = await call(api, '/tasks', { method: 'POST', body: { requestId: randomUUID(), title: 'M4 小步骤归档守卫' } });
  expectSuccess(archiveTarget, 201);
  const archiveId = archiveTarget.json.data.id;
  const archiveDb = new Database(dbPath);
  try {
    archiveDb.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run(new Date().toISOString(), archiveId);
    expectError(await call(api, `/tasks/${archiveId}/checklist`, { method: 'POST', body: { requestId: randomUUID(), expectedVersion: 1, text: '归档后新增' } }), 409, 'TASK_ARCHIVED');
    const readable = await call(api, `/tasks/${archiveId}/checklist`); expectSuccess(readable, 200);
    archiveDb.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(archiveId);
  } finally { archiveDb.close(); }

  console.log('M4 checklist checks: PASS');
}
