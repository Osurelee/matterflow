#!/usr/bin/env node
/** M5-02 isolated project-section proof. Never points at the user's normal DB. */
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath; const NEXT = path.join(ROOT, 'node_modules/next/dist/bin/next');
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-02-')); const dbPath = path.join(temp, 'tasks.db');
const password = 'M5-02-isolated-password-3581!'; let child; let cookie;
const command = (args) => spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: 'http://localhost:0', TASKS_ALLOW_NONINTERACTIVE_INIT: '1', TASKS_INIT_PASSWORD: password } });
const ok = (result, label) => assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }).on('error', reject); });
async function launch() { const port = await freePort(); const env = { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: `http://localhost:${port}` }; child = spawn(NODE, [NEXT, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] }); for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('next exited'); try { if ((await fetch(`http://127.0.0.1:${port}/tasks/api/healthz`)).ok) return { base: `http://127.0.0.1:${port}/tasks/api`, origin: `http://localhost:${port}` }; } catch {} await sleep(200); } throw new Error('server not ready'); }
async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
async function call(api, route, { method = 'GET', body, origin = api.origin, cookieValue = cookie } = {}) { const headers = {}; if (origin !== null) headers.Origin = origin; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookieValue) headers.Cookie = cookieValue; const response = await fetch(api.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { response, status: response.status, json }; }
function success(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.ok(result.json?.data, JSON.stringify(result.json)); return result.json.data; }
function failure(result, status, code) { assert.equal(result.status, status, JSON.stringify(result.json)); assert.equal(result.json?.error?.code, code, JSON.stringify(result.json)); }
const id = () => randomUUID();

try {
  ok(command([path.join(ROOT, 'scripts/migrate.mjs')]), 'migration'); ok(command([path.join(ROOT, 'scripts/init-account.mjs')]), 'account init');
  const api = await launch(); const login = await call(api, '/auth/login', { method: 'POST', cookieValue: null, body: { username: 'owner', password } }); success(login); cookie = login.response.headers.getSetCookie().find((value) => value.startsWith('tasks_session=')).split(';')[0];
  const space = success(await call(api, '/spaces')).items.find((item) => item.isDefault);
  const project = success(await call(api, '/projects', { method: 'POST', body: { requestId: id(), spaceId: space.id, name: 'M5-02 项目', description: '分组验证' } }), 200);
  const root = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M5-02 项目根', spaceId: space.id, projectId: project.id } }), 201);
  const db = new Database(dbPath); db.prepare('UPDATE projects SET root_task_id=? WHERE id=?').run(root.id, project.id); db.close();
  let projectRead = success(await call(api, `/projects/${project.id}`));
  const alpha = success(await call(api, `/projects/${project.id}/sections`, { method: 'POST', body: { requestId: id(), name: '准备', expectedProjectVersion: projectRead.version } }));
  projectRead = success(await call(api, `/projects/${project.id}`));
  const beta = success(await call(api, `/projects/${project.id}/sections`, { method: 'POST', body: { requestId: id(), name: '交付', expectedProjectVersion: projectRead.version } }));
  projectRead = success(await call(api, `/projects/${project.id}`));
  const sections = success(await call(api, `/projects/${project.id}/sections`)); assert.deepEqual(sections.items.map((item) => item.name), ['准备', '交付']); assert.equal(sections.ungroupedLabel, '未分组');
  const direct = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '直接项目事项', expectedStructureVersion: 1 } }), 201);
  const assigned = success(await call(api, `/tasks/${direct.id}/section`, { method: 'POST', body: { requestId: id(), expectedVersion: direct.version, sectionId: alpha.id } })); assert.equal(assigned.sectionId, alpha.id);
  const nested = success(await call(api, `/tasks/${direct.id}/children`, { method: 'POST', body: { requestId: id(), title: '深层子事项', expectedStructureVersion: 1 } }), 201);
  failure(await call(api, `/tasks/${nested.id}/section`, { method: 'POST', body: { requestId: id(), expectedVersion: nested.version, sectionId: alpha.id } }), 409, 'SECTION_NOT_APPLICABLE');
  const taskRead = success(await call(api, `/tasks/${direct.id}`)); assert.equal(taskRead.sectionId, alpha.id);
  const ungrouped = success(await call(api, `/tasks/${direct.id}/section`, { method: 'POST', body: { requestId: id(), expectedVersion: taskRead.version, sectionId: null } })); assert.equal(ungrouped.sectionId, null);
  const renamed = success(await call(api, `/projects/${project.id}/sections/${alpha.id}`, { method: 'PATCH', body: { requestId: id(), expectedVersion: alpha.version, name: '准备阶段' } })); assert.equal(renamed.name, '准备阶段');
  projectRead = success(await call(api, `/projects/${project.id}`));
  const reordered = success(await call(api, `/projects/${project.id}/sections/reorder`, { method: 'POST', body: { requestId: id(), expectedProjectVersion: projectRead.version, sectionIds: [beta.id, alpha.id] } })); assert.deepEqual(reordered.items.map((item) => item.id), [beta.id, alpha.id]);
  const dup = await call(api, `/projects/${project.id}/sections`, { method: 'POST', body: { requestId: id(), name: '交付' } }); failure(dup, 409, 'NAME_TAKEN');
  const nestedProject = success(await call(api, '/projects', { method: 'POST', body: { requestId: id(), spaceId: space.id, name: 'M5-02 嵌套项目', description: '' } }));
  const latestRoot = success(await call(api, `/tasks/${root.id}`));
  const nestedRoot = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '嵌套项目根', expectedStructureVersion: latestRoot.structureVersion } }), 201);
  const nestedDb = new Database(dbPath); nestedDb.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(nestedProject.id, nestedRoot.id); nestedDb.prepare('UPDATE projects SET root_task_id=? WHERE id=?').run(nestedRoot.id, nestedProject.id); nestedDb.close();
  const nestedProjectRead = success(await call(api, `/projects/${nestedProject.id}`));
  const nestedSection = success(await call(api, `/projects/${nestedProject.id}/sections`, { method: 'POST', body: { requestId: id(), name: '嵌套阶段', expectedProjectVersion: nestedProjectRead.version } }));
  const nestedChild = success(await call(api, `/tasks/${nestedRoot.id}/children`, { method: 'POST', body: { requestId: id(), title: '嵌套项目事项', expectedStructureVersion: 1 } }), 201);
  success(await call(api, `/tasks/${nestedChild.id}/section`, { method: 'POST', body: { requestId: id(), expectedVersion: nestedChild.version, sectionId: nestedSection.id } }));
  failure(await call(api, `/tasks/${nestedChild.id}/section`, { method: 'POST', body: { requestId: id(), expectedVersion: nestedChild.version + 1, sectionId: alpha.id } }), 404, 'SECTION_NOT_FOUND');
  const outerView = success(await call(api, `/tasks?view=all&includeEnded=true&projectId=${project.id}`)); assert.equal(outerView.items.some((item) => item.id === nestedChild.id), false, 'nested project child must not be counted in ancestor project view');
  const finalDb = new Database(dbPath); const sectioned = finalDb.prepare('SELECT section_id FROM tasks WHERE id=?').get(direct.id); assert.equal(sectioned.section_id, null); assert.equal(finalDb.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(finalDb.pragma('foreign_key_check').length, 0); assert.ok(finalDb.prepare('SELECT count(*) n FROM task_events WHERE type=?').get('task_updated').n >= 2); finalDb.close();
  const triggerDb = new Database(dbPath); assert.throws(() => triggerDb.prepare('UPDATE tasks SET section_id=? WHERE id=?').run(alpha.id, nested.id), /task_section_not_direct_project_child/); triggerDb.close();
  console.log('M5-02 project sections: PASS (optional sections, ungrouped clearing, direct-child-only guard, rename/reorder, SQL trigger)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
