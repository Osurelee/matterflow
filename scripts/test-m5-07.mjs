#!/usr/bin/env node
/** M5-07 isolated Task-to-Project enablement proof. Never points at the user's normal DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const NODE = process.execPath; const NEXT = path.join(ROOT, 'node_modules/next/dist/bin/next');
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-07-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M5-07-isolated-password-3581!'; let child; let cookie;
const command = (args) => spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: 'http://localhost:0', TASKS_ALLOW_NONINTERACTIVE_INIT: '1', TASKS_INIT_PASSWORD: password } });
const ok = (result, label) => assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }).on('error', reject); });
async function launch() { const port = await freePort(); const env = { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: `http://localhost:${port}` }; child = spawn(NODE, [NEXT, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] }); for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('next exited'); try { if ((await fetch(`http://127.0.0.1:${port}/tasks/api/healthz`)).ok) return { base: `http://127.0.0.1:${port}/tasks/api`, origin: `http://localhost:${port}` }; } catch {} await sleep(200); } throw new Error('server not ready'); }
async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
async function call(api, route, { method = 'GET', body, cookieValue = cookie } = {}) { const headers = { Origin: api.origin }; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookieValue) headers.Cookie = cookieValue; const response = await fetch(api.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: response.status, json, response }; }
function success(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.ok(result.json?.data, JSON.stringify(result.json)); return result.json.data; }
function failure(result, status, code) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.equal(result.json?.error?.code, code, JSON.stringify(result.json)); }
const id = () => randomUUID();

try {
  ok(command([path.join(ROOT, 'scripts/migrate.mjs')]), 'migration'); ok(command([path.join(ROOT, 'scripts/init-account.mjs')]), 'account init'); const api = await launch();
  const login = await call(api, '/auth/login', { method: 'POST', cookieValue: null, body: { username: 'owner', password } }); assert.equal(login.status, 200); cookie = login.response.headers.getSetCookie().find((value) => value.startsWith('tasks_session=')).split(';')[0];
  const space = success(await call(api, '/spaces')).items.find((item) => item.isDefault);
  const root = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '可升级原事项', spaceId: space.id } }), 201);
  const rootForBody = success(await call(api, `/tasks/${root.id}`));
  success(await call(api, `/tasks/${root.id}`, { method: 'PATCH', body: { requestId: id(), expectedVersion: rootForBody.version, description: '保留这段正文' } }));
  const rootReady = success(await call(api, `/tasks/${root.id}`));
  const childTask = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '主后代', expectedStructureVersion: rootReady.structureVersion } }), 201);
  const rootBeforeHistory = success(await call(api, `/tasks/${root.id}`));
  success(await call(api, `/tasks/${root.id}/progress`, { method: 'POST', body: { requestId: id(), expectedVersion: rootBeforeHistory.version, text: '原事项历史仍应保留' } }));
  const before = success(await call(api, `/tasks/${root.id}`));
  const beforeEvents = success(await call(api, `/tasks/${root.id}/events`)).items.length;
  const beforeDb = new Database(dbPath); const beforeLinks = beforeDb.prepare('SELECT count(*) AS n FROM task_asset_links WHERE task_id=?').get(root.id).n; beforeDb.close();
  const preview = success(await call(api, `/tasks/${root.id}/enable-project`)); assert.equal(preview.alreadyEnabled, false); assert.equal(preview.task.id, root.id); assert.equal(preview.childCount, 1);
  failure(await call(api, `/tasks/${root.id}/enable-project`, { method: 'POST', body: { requestId: id(), expectedVersion: before.version, expectedStructureVersion: preview.expectedStructureVersion + 1 } }), 409, 'STRUCTURE_VERSION_CONFLICT');
  const projectBody = { requestId: id(), expectedVersion: before.version, expectedStructureVersion: preview.expectedStructureVersion, successCriteria: '完成验收并上线', targetDate: '2026-12-31' };
  const enabled = success(await call(api, `/tasks/${root.id}/enable-project`, { method: 'POST', body: projectBody })); assert.equal(enabled.changed, true); assert.equal(enabled.taskId, root.id); assert.equal(enabled.project.rootTaskId, root.id); assert.equal(enabled.project.successCriteria, '完成验收并上线'); assert.equal(enabled.project.targetDate, '2026-12-31');
  const rootAfter = success(await call(api, `/tasks/${root.id}`)); assert.equal(rootAfter.id, root.id); assert.equal(rootAfter.title, before.title); assert.equal(rootAfter.description, before.description); assert.equal(rootAfter.projectId, enabled.project.id); assert.equal(rootAfter.projectRootTaskId, root.id); assert.equal(rootAfter.version, enabled.taskVersion); assert.equal(rootAfter.structureVersion, enabled.structureVersion);
  const childAfter = success(await call(api, `/tasks/${childTask.id}`)); assert.equal(childAfter.projectId, enabled.project.id); assert.equal(success(await call(api, `/tasks/${root.id}/events`)).items.length, beforeEvents + 1); const afterDb = new Database(dbPath); assert.equal(afterDb.prepare('SELECT count(*) AS n FROM task_asset_links WHERE task_id=?').get(root.id).n, beforeLinks); afterDb.close();
  const replay = success(await call(api, `/tasks/${root.id}/enable-project`, { method: 'POST', body: projectBody })); assert.equal(replay.project.id, enabled.project.id);
  const repeat = success(await call(api, `/tasks/${root.id}/enable-project`, { method: 'POST', body: { requestId: id(), expectedVersion: rootAfter.version, expectedStructureVersion: rootAfter.structureVersion } })); assert.equal(repeat.changed, false); assert.equal(repeat.project.id, enabled.project.id);
  const listed = success(await call(api, '/projects')); assert.equal(listed.items.filter((item) => item.rootTaskId === root.id).length, 1);

  const grandchild = success(await call(api, `/tasks/${childTask.id}/children`, { method: 'POST', body: { requestId: id(), title: '嵌套项目后代', expectedStructureVersion: childAfter.structureVersion } }), 201);
  const childBefore = success(await call(api, `/tasks/${childTask.id}`)); const nested = success(await call(api, `/tasks/${childTask.id}/enable-project`, { method: 'POST', body: { requestId: id(), expectedVersion: childBefore.version, expectedStructureVersion: childBefore.structureVersion, successCriteria: '子项目完成' } })); assert.equal(nested.project.rootTaskId, childTask.id); assert.notEqual(nested.project.id, enabled.project.id);
  const nestedGrandchild = success(await call(api, `/tasks/${grandchild.id}`)); assert.equal(nestedGrandchild.projectId, nested.project.id); const rootStill = success(await call(api, `/tasks/${root.id}`)); assert.equal(rootStill.projectId, enabled.project.id);
  const db = new Database(dbPath); assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 3); assert.equal(db.prepare('SELECT count(*) AS n FROM projects WHERE root_task_id IS NOT NULL').get().n, 2); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(db.pragma('foreign_key_check').length, 0); db.close();
  console.log('M5-07 enable project view: PASS (preview, atomic guard, ID/body/history/media preservation, descendant reindex, nested project, idempotency, integrity)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
