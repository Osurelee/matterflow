#!/usr/bin/env node
/** M5-08 production-process end-to-end proof. Never points at the user's normal DB. */
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
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-08-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M5-08-isolated-password-3581!'; let child; let cookie;
const command = (args) => spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: 'http://localhost:0', TASKS_ALLOW_NONINTERACTIVE_INIT: '1', TASKS_INIT_PASSWORD: password } });
const ok = (result, label) => assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }).on('error', reject); });
async function launch() { const port = await freePort(); const env = { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: `http://localhost:${port}` }; child = spawn(NODE, [NEXT, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] }); for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('next exited'); try { if ((await fetch(`http://127.0.0.1:${port}/tasks/api/healthz`)).ok) return { base: `http://127.0.0.1:${port}/tasks/api`, origin: `http://localhost:${port}` }; } catch {} await sleep(200); } throw new Error('server not ready'); }
async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
async function call(api, route, { method = 'GET', body, cookieValue = cookie } = {}) { const headers = { Origin: api.origin }; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookieValue) headers.Cookie = cookieValue; const response = await fetch(api.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: response.status, json, response }; }
function success(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.ok(result.json?.data, JSON.stringify(result.json)); return result.json.data; }
function failure(result, status, code) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.equal(result.json?.error?.code, code, JSON.stringify(result.json)); }
const id = () => randomUUID();
async function readTask(api, taskId) { return success(await call(api, `/tasks/${taskId}`)); }
async function createChild(api, parent) { return success(await call(api, `/tasks/${parent.id}/children`, { method: 'POST', body: { requestId: id(), title: `子项-${parent.title}`, expectedStructureVersion: parent.structureVersion } }), 201); }
async function finish(api, taskId) { const task = await readTask(api, taskId); return success(await call(api, `/tasks/${taskId}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: task.version, status: 'done' } })); }

try {
  ok(command([path.join(ROOT, 'scripts/migrate.mjs')]), 'migration'); ok(command([path.join(ROOT, 'scripts/init-account.mjs')]), 'account init'); const api = await launch();
  const login = await call(api, '/auth/login', { method: 'POST', cookieValue: null, body: { username: 'owner', password } }); assert.equal(login.status, 200); cookie = login.response.headers.getSetCookie().find((value) => value.startsWith('tasks_session=')).split(';')[0];
  const space = success(await call(api, '/spaces')).items.find((item) => item.isDefault);
  const a = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '捕获A', spaceId: space.id } }), 201);
  const b = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '容器B', spaceId: space.id } }), 201);
  const c = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '容器C', spaceId: space.id } }), 201);
  const target = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '引用目标', spaceId: space.id } }), 201);
  const a0 = await readTask(api, a.id); const a1 = await createChild(api, a0); const a1Read = await readTask(api, a1.id); const a2 = await createChild(api, a1Read);
  const aBeforeMove = await readTask(api, a.id); const bBeforeMove = await readTask(api, b.id);
  success(await call(api, `/tasks/${a.id}/move`, { method: 'POST', body: { requestId: id(), expectedVersion: aBeforeMove.version, expectedStructureVersion: aBeforeMove.structureVersion, expectedSourceSpaceStructureVersion: aBeforeMove.spaceStructureVersion, expectedTargetStructureVersion: bBeforeMove.structureVersion, expectedTargetSpaceStructureVersion: bBeforeMove.spaceStructureVersion, targetParentId: b.id, targetSpaceId: space.id } }));
  const bMoved = await readTask(api, b.id); const cBeforeMove = await readTask(api, c.id);
  success(await call(api, `/tasks/${b.id}/move`, { method: 'POST', body: { requestId: id(), expectedVersion: bMoved.version, expectedStructureVersion: bMoved.structureVersion, expectedSourceSpaceStructureVersion: bMoved.spaceStructureVersion, expectedTargetStructureVersion: cBeforeMove.structureVersion, expectedTargetSpaceStructureVersion: cBeforeMove.spaceStructureVersion, targetParentId: c.id, targetSpaceId: space.id } }));
  assert.equal((await readTask(api, a.id)).parentId, b.id); assert.equal((await readTask(api, b.id)).parentId, c.id); assert.equal((await readTask(api, a2.id)).parentId, a1.id);

  const aForRef = await readTask(api, a.id); const reference = success(await call(api, `/tasks/${a.id}/references`, { method: 'POST', body: { requestId: id(), targetTaskId: target.id, expectedStructureVersion: aForRef.structureVersion } })); assert.equal(reference.targetTaskId, target.id);
  const cPreview = success(await call(api, `/tasks/${c.id}/enable-project`)); const cEnabled = success(await call(api, `/tasks/${c.id}/enable-project`, { method: 'POST', body: { requestId: id(), expectedVersion: cPreview.expectedVersion, expectedStructureVersion: cPreview.expectedStructureVersion, successCriteria: '逐级核实并完成', targetDate: '2026-12-31' } }));
  assert.equal((await readTask(api, c.id)).projectId, cEnabled.project.id); assert.equal((await readTask(api, b.id)).projectId, cEnabled.project.id); assert.equal((await readTask(api, a.id)).projectId, cEnabled.project.id);
  const cTree = success(await call(api, `/projects/${cEnabled.project.id}/tree`)); assert.equal(cTree.items.some((item) => item.id === c.id), false); assert.equal(cTree.items.some((item) => item.id === b.id), true);

  const cActive = await readTask(api, c.id); failure(await call(api, `/tasks/${c.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: cActive.version, status: 'done' } }), 409, 'ACTIVE_DESCENDANTS');
  await finish(api, a2.id); await finish(api, a1.id); await finish(api, a.id); await finish(api, b.id); await finish(api, c.id);
  const projectAfter = success(await call(api, `/projects/${cEnabled.project.id}`)); assert.equal(projectAfter.status, 'completed');

  const targetBeforeDelete = await readTask(api, target.id); await finish(api, target.id); const targetDone = await readTask(api, target.id); const deleted = success(await call(api, `/tasks/${target.id}/delete`, { method: 'POST', body: { requestId: id(), expectedVersion: targetDone.version } })); assert.equal(deleted.deletedAt !== null, true); assert.equal(success(await call(api, `/tasks/${a.id}/references`)).items[0].task.deleted, true);
  const restored = success(await call(api, `/tasks/${target.id}/restore`, { method: 'POST', body: { requestId: id(), expectedVersion: targetDone.version + 1 } })); assert.equal(restored.deletedAt, null); assert.equal(success(await call(api, `/tasks/${a.id}/references`)).items[0].task.deleted, false); assert.equal(targetBeforeDelete.id, target.id);

  const db = new Database(dbPath); assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 6); assert.equal(db.prepare('SELECT count(*) AS n FROM projects WHERE root_task_id IS NOT NULL').get().n, 1); assert.equal(db.prepare('SELECT count(*) AS n FROM task_references WHERE removed_at IS NULL').get().n, 1); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(db.pragma('foreign_key_check').length, 0); db.close();
  console.log('M5-08 end-to-end flow: PASS (capture, repeated subtree moves, deep decomposition, reference delete/restore, project enablement, guarded completion, integrity)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
