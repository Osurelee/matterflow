#!/usr/bin/env node
/** M5-09 isolated reference proof. Never points at the user's normal DB. */
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
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m5-09-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M5-09-isolated-password-3581!'; let child; let cookie;
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
  const source = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '引用来源', spaceId: space.id } }), 201);
  const target = success(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '被引用事项', spaceId: space.id } }), 201);
  let sourceRead = success(await call(api, `/tasks/${source.id}`));
  const created = success(await call(api, `/tasks/${source.id}/references`, { method: 'POST', body: { requestId: id(), targetTaskId: target.id, expectedStructureVersion: sourceRead.structureVersion } })); assert.equal(created.task.id, target.id); assert.equal(created.changed, true);
  const duplicate = success(await call(api, `/tasks/${source.id}/references`, { method: 'POST', body: { requestId: id(), targetTaskId: target.id, expectedStructureVersion: created.sourceStructureVersion } })); assert.equal(duplicate.changed, false);
  const outgoing = success(await call(api, `/tasks/${source.id}/references`)); assert.equal(outgoing.items.length, 1); assert.equal(outgoing.items[0].task.title, '被引用事项');
  const incoming = success(await call(api, `/tasks/${target.id}/referenced-by`)); assert.equal(incoming.items.length, 1); assert.equal(incoming.items[0].task.title, '引用来源');
  failure(await call(api, `/tasks/${source.id}/references`, { method: 'POST', body: { requestId: id(), targetTaskId: source.id, expectedStructureVersion: created.sourceStructureVersion } }), 409, 'SELF_REFERENCE');
  const ref = outgoing.items[0]; sourceRead = success(await call(api, `/tasks/${source.id}`)); const removed = success(await call(api, `/tasks/${source.id}/references/${ref.id}/remove`, { method: 'POST', body: { requestId: id(), expectedVersion: ref.version, expectedStructureVersion: sourceRead.structureVersion } })); assert.equal(removed.changed, true);
  assert.equal(success(await call(api, `/tasks/${source.id}/references`)).items.length, 0); assert.equal(success(await call(api, `/tasks/${target.id}/referenced-by`)).items.length, 0);
  const db = new Database(dbPath); assert.equal(db.prepare('SELECT count(*) n FROM task_references').get().n, 1); assert.equal(db.prepare('SELECT removed_at IS NOT NULL removed FROM task_references').get().removed, 1); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.equal(db.pragma('foreign_key_check').length, 0); db.close();
  console.log('M5-09 task references: PASS (create, bidirectional read, duplicate protection, self guard, soft removal, integrity)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
