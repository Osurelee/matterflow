#!/usr/bin/env node
/** M6-05 isolated export proof. Uses a temporary database and media directory. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m6-export-')); const dbPath = path.join(temp, 'tasks.db'); const password = 'M6-export-isolated-password-3581!'; let child; let cookie;
const command = (args, env = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: 'http://localhost:0', TASKS_ALLOW_NONINTERACTIVE_INIT: '1', TASKS_INIT_PASSWORD: password, ...env } });
const ok = (r, label) => assert.equal(r.status, 0, `${label}\n${r.stdout}\n${r.stderr}`);
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }).on('error', reject); });
async function launch() { const p = await port(); const origin = `http://localhost:${p}`; child = spawn(process.execPath, [path.join(ROOT, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(p)], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'inherit', 'inherit'] }); for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/tasks/api/healthz`)).ok) return { origin, base: `${origin}/tasks/api` }; } catch {} await sleep(100); } throw new Error('server not ready'); }
async function stop() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
async function call(api, route, { method = 'GET', body, cookieValue = cookie, withOrigin = true } = {}) { const headers = {}; if (withOrigin) headers.Origin = api.origin; if (body !== undefined) { headers['Content-Type'] = 'application/json'; } if (cookieValue) headers.Cookie = cookieValue; const response = await fetch(api.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const binary = await response.clone().arrayBuffer(); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { response, status: response.status, body: json, text, bytes: new Uint8Array(binary) }; }
const id = () => randomUUID();
try {
  ok(command([path.join(ROOT, 'scripts/migrate.mjs')]), 'migration'); ok(command([path.join(ROOT, 'scripts/init-account.mjs')]), 'account init'); const api = await launch();
  const login = await call(api, '/auth/login', { method: 'POST', cookieValue: null, body: { username: 'owner', password } }); assert.equal(login.status, 200); cookie = login.response.headers.getSetCookie().find((value) => value.startsWith('tasks_session=')).split(';')[0];
  const spaces = await call(api, '/spaces'); assert.equal(spaces.status, 200); const space = spaces.body.data.items.find((item) => item.isDefault);
  const created = await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: '=SUM(A1)', spaceId: space.id } }); assert.equal(created.status, 201);
  const archived = await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 全量历史事项', spaceId: space.id } }); assert.equal(archived.status, 201);
  const archivedDetail = await call(api, `/tasks/${archived.body.data.id}`); assert.equal(archivedDetail.status, 200);
  const archivedDone = await call(api, `/tasks/${archived.body.data.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: archivedDetail.body.data.version, status: 'done' } }); assert.equal(archivedDone.status, 200);
  const archivedOut = await call(api, `/tasks/${archived.body.data.id}/archive`, { method: 'POST', body: { requestId: id(), expectedVersion: archivedDone.body.data.version, scope: 'subtree' } }); assert.equal(archivedOut.status, 200);
  const json = await call(api, '/exports/json'); assert.equal(json.status, 200, JSON.stringify(json.body)); assert.equal(json.response.headers.get('content-type'), 'application/json; charset=utf-8'); assert.equal(json.body.scope.kind, 'all'); assert.equal(json.body.entities.tasks.length, 2); assert.equal(json.body.entities.tasks.some((row) => row.id === archived.body.data.id), true); assert.equal(JSON.stringify(json.body.entities).includes('password_hash'), false); assert.equal(json.body.entities.mutation_requests, undefined);
  const filteredJson = await call(api, `/exports/json?view=all&q=${encodeURIComponent('SUM')}`); assert.equal(filteredJson.status, 200); assert.equal(filteredJson.body.scope.kind, 'filtered'); assert.equal(filteredJson.body.entities.tasks.length, 1); assert.equal(filteredJson.body.entities.tasks[0].id, created.body.data.id);
  const csv = await call(api, '/exports/csv?view=all&includeEnded=false'); assert.equal(csv.status, 200); assert.match(csv.text, /^id,title,/); assert.match(csv.text, /'=SUM\(A1\)/); assert.match(csv.text, /\r\n/);
  const bundle = await call(api, '/exports/bundle?view=all'); assert.equal(bundle.status, 200); assert.equal(bundle.response.headers.get('content-type'), 'application/zip'); assert.equal(String.fromCharCode(...bundle.bytes.slice(0, 2)), 'PK');
  const unauth = await call(api, '/exports/json', { cookieValue: null }); assert.equal(unauth.status, 401); const badOrigin = await call(api, '/exports/json', { withOrigin: false }); assert.equal(badOrigin.status, 403);
  console.log('M6-05 exports: PASS (JSON scope/exclusions, CSV filter/formula guard, bundle zip, auth/origin guard)');
} finally { await stop(); rmSync(temp, { recursive: true, force: true }); }
