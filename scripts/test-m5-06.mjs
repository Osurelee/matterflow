#!/usr/bin/env node
/** M5-06 isolated checklist-promotion proof. Never points at the user's normal DB. */
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
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-06-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M5-06-isolated-password-3581!'; let child; let cookie;
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
  const space = success(await call(api, '/spaces')).items.find((item) => item.isDefault); const parent = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '清单来源事项', spaceId: space.id } }), 201);
  const one = success(await call(api, `/tasks/${parent.id}/checklist`, { method: 'POST', body: { requestId: id(), expectedVersion: parent.version, text: '已勾选步骤' } }));
  const two = success(await call(api, `/tasks/${parent.id}/checklist`, { method: 'POST', body: { requestId: id(), expectedVersion: parent.version, text: '待处理步骤' } }));
  const checked = success(await call(api, `/tasks/${parent.id}/checklist/${one.itemId}`, { method: 'PATCH', body: { requestId: id(), expectedVersion: parent.version, itemVersion: 1, isChecked: true } }));
  const preview = success(await call(api, `/tasks/${parent.id}/checklist/promote`)); assert.equal(preview.pendingCount, 2); assert.equal(preview.items.find((item) => item.id === one.itemId).isChecked, true);
  failure(await call(api, `/tasks/${parent.id}/checklist/promote`, { method: 'POST', body: { requestId: id(), expectedVersion: parent.version, expectedStructureVersion: preview.expectedStructureVersion + 1 } }), 409, 'STRUCTURE_VERSION_CONFLICT');
  const promoted = success(await call(api, `/tasks/${parent.id}/checklist/promote`, { method: 'POST', body: { requestId: id(), expectedVersion: parent.version, expectedStructureVersion: preview.expectedStructureVersion } })); assert.equal(promoted.created.length, 2); assert.deepEqual(promoted.created.map((item) => item.status), ['done', 'todo']);
  const children = success(await call(api, `/tasks/${parent.id}/children`)); assert.equal(children.items.length, 2); assert.deepEqual(children.items.map((item) => item.status), ['done', 'todo']);
  const list = success(await call(api, `/tasks/${parent.id}/checklist`)); assert.ok(list.items.every((item) => item.promotedTaskId));
  const repeat = success(await call(api, `/tasks/${parent.id}/checklist/promote`, { method: 'POST', body: { requestId: id(), expectedVersion: parent.version, expectedStructureVersion: promoted.structureVersion } })); assert.equal(repeat.changed, false);
  const db = new Database(dbPath); assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE parent_id=?').get(parent.id).n, 2); assert.equal(db.prepare('SELECT count(*) n FROM checklist_items WHERE promoted_task_id IS NOT NULL').get().n, 2); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(db.pragma('foreign_key_check').length, 0); db.close();
  console.log('M5-06 checklist promotion: PASS (preview, atomic version guard, checked-status mapping, association dedupe, repeat no-op, integrity)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
