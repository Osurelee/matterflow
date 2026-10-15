#!/usr/bin/env node
/** M5-05 isolated project tree/progress proof. Never points at the user's normal DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const NODE = process.execPath; const NEXT = path.join(ROOT, 'node_modules/next/dist/bin/next');
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-05-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M5-05-isolated-password-3581!'; let child; let cookie;
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
  const space = success(await call(api, '/spaces')).items.find((item) => item.isDefault); const project = success(await call(api, '/projects', { method: 'POST', body: { requestId: id(), spaceId: space.id, name: 'M5-05 项目', description: '' } })); const root = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '项目目标', spaceId: space.id, projectId: project.id } }), 201);
  const db = (await import('better-sqlite3')).default; const handle = new db(dbPath); handle.prepare('UPDATE projects SET root_task_id=? WHERE id=?').run(root.id, project.id); handle.close();
  const doneLeaf = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '已完成叶子', expectedStructureVersion: 1 } }), 201); await call(api, `/tasks/${doneLeaf.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: doneLeaf.version, status: 'done' } });
  const activeLeaf = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '活跃叶子', expectedStructureVersion: 2 } }), 201);
  const reviewParent = success(await call(api, `/tasks/${root.id}/children`, { method: 'POST', body: { requestId: id(), title: '待核实父项', expectedStructureVersion: 3 } }), 201);
  const reviewChild = success(await call(api, `/tasks/${reviewParent.id}/children`, { method: 'POST', body: { requestId: id(), title: '已结束后代', expectedStructureVersion: 1 } }), 201); await call(api, `/tasks/${reviewChild.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: reviewChild.version, status: 'done' } });
  const overview = success(await call(api, `/projects/${project.id}/overview`)); assert.deepEqual(overview.progress, { active: 1, completed: 2, cancelled: 0, needsReview: 1, leafTotal: 3, completionPercent: 67 });
  const tree = success(await call(api, `/projects/${project.id}/tree`)); assert.equal(tree.items.length, 3); assert.equal(tree.items.find((item) => item.id === reviewParent.id).hasChildren, true); assert.equal(tree.items.some((item) => item.id === root.id), false, 'project root is excluded from direct children');
  const nested = success(await call(api, `/projects/${project.id}/tree?parentId=${reviewParent.id}`)); assert.equal(nested.items.length, 1); assert.equal(nested.items[0].id, reviewChild.id);
  const outside = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '项目外事项', spaceId: space.id } }), 201); failure(await call(api, `/projects/${project.id}/tree?parentId=${outside.id}`), 409, 'PROJECT_TREE_OUT_OF_SCOPE');
  const empty = success(await call(api, '/projects', { method: 'POST', body: { requestId: id(), spaceId: space.id, name: 'M5-05 空项目', description: '' } })); const emptyOverview = success(await call(api, `/projects/${empty.id}/overview`)); assert.equal(emptyOverview.empty, true); assert.equal(emptyOverview.progress.completionPercent, null);
  console.log('M5-05 project tree/progress: PASS (on-demand tree, focus scope, leaf counts, review candidates, root exclusion, empty project)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
