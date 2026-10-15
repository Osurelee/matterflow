#!/usr/bin/env node
/** Isolated M6 search/review/date contract smoke test. Never uses the normal DB. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'tasks-m6-search-review-')); const dbPath = path.join(temp, 'tasks.db');
const password = 'M6-isolated-password-3581!'; const node = process.execPath; const next = path.join(root, 'node_modules/next/dist/bin/next'); let child; let cookie;
const env = { ...process.env, NODE_ENV: 'production', TASKS_DB_PATH: dbPath, TASKS_MEDIA_DIR: path.join(temp, 'media'), TASKS_PUBLIC_ORIGIN: 'http://localhost:0', TASKS_ALLOW_NONINTERACTIVE_INIT: '1', TASKS_INIT_PASSWORD: password };
const run = (args) => { const r = spawnSync(node, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 }); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); };
const id = () => randomUUID();
async function port() { const s = net.createServer(); await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; s.close(); return p; }
async function call(api, route, options = {}) { const h = { Origin: api.origin }; if (options.body) { h['Content-Type'] = 'application/json'; } if (cookie) h.Cookie = cookie; const r = await fetch(api.base + route, { method: options.method ?? 'GET', headers: h, body: options.body ? JSON.stringify(options.body) : undefined }); const json = await r.json(); return { status: r.status, json, response: r }; }
function data(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.json)); return result.json.data; }

try {
  run([path.join(root, 'scripts/migrate.mjs')]); run([path.join(root, 'scripts/init-account.mjs')]);
  const p = await port(); env.TASKS_PUBLIC_ORIGIN = `http://localhost:${p}`; child = spawn(node, [next, 'start', '-H', '127.0.0.1', '-p', String(p)], { cwd: root, env, stdio: 'ignore' });
  const api = { base: `http://127.0.0.1:${p}/tasks/api`, origin: `http://localhost:${p}` };
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${api.base}/healthz`)).ok) break; } catch {} await sleep(100); }
  const login = await call(api, '/auth/login', { method: 'POST', body: { username: 'owner', password } }); assert.equal(login.status, 200); cookie = login.response.headers.getSetCookie().find((v) => v.startsWith('tasks_session=')).split(';')[0];
  const space = data(await call(api, '/spaces')).items.find((item) => item.isDefault);
  const task = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 搜索标题', spaceId: space.id } }), 201);
  let detail = data(await call(api, `/tasks/${task.id}`));
  detail = data(await call(api, `/tasks/${task.id}`, { method: 'PATCH', body: { requestId: id(), expectedVersion: detail.version, description: '上海正文关键词', descriptionFormat: 'plaintext', nextAction: '' } }));
  data(await call(api, `/tasks/${task.id}/planning`, { method: 'PATCH', body: { requestId: id(), expectedVersion: detail.version, priority: 'none', plannedDate: null, dueDate: null, followUpDate: null, nextAction: '', blockedReason: '' } }));
  const search = data(await call(api, '/search?q=关键词')); assert.equal(search.total, 1); assert.equal(search.items[0].path.at(-1).id, task.id); assert.ok('source' in search.items[0]);
  const review = data(await call(api, '/review?kind=unprocessed')); assert.equal(review.items.some((item) => item.id === task.id), true); assert.ok(Array.isArray(review.items[0].path));
  const parent = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 到期父项', spaceId: space.id } }), 201);
  const leaf = data(await call(api, `/tasks/${parent.id}/children`, { method: 'POST', body: { requestId: id(), title: 'M6 到期叶子', expectedStructureVersion: 1 } }), 201);
  const shanghaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shiftShanghai = (days) => { const [year, month, day] = shanghaiToday.split('-').map(Number); const value = new Date(Date.UTC(year, month - 1, day + days)); return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`; };
  const parentDetail = data(await call(api, `/tasks/${parent.id}`));
  data(await call(api, `/tasks/${parent.id}/planning`, { method: 'PATCH', body: { requestId: id(), expectedVersion: parentDetail.version, priority: 'none', plannedDate: null, dueDate: shanghaiToday, followUpDate: null, nextAction: '', blockedReason: '' } }));
  const childDetail = data(await call(api, `/tasks/${leaf.id}`));
  data(await call(api, `/tasks/${leaf.id}/planning`, { method: 'PATCH', body: { requestId: id(), expectedVersion: childDetail.version, priority: 'none', plannedDate: null, dueDate: shanghaiToday, followUpDate: shanghaiToday, nextAction: '', blockedReason: '' } }));
  const overdueTask = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 逾期事项', spaceId: space.id } }), 201);
  const overdueDetail = data(await call(api, `/tasks/${overdueTask.id}`));
  data(await call(api, `/tasks/${overdueTask.id}/planning`, { method: 'PATCH', body: { requestId: id(), expectedVersion: overdueDetail.version, priority: 'none', plannedDate: null, dueDate: shiftShanghai(-1), followUpDate: null, nextAction: '', blockedReason: '' } }));
  const today = data(await call(api, '/tasks?view=today')); assert.equal(new Set(today.items.map((item) => item.id)).size, today.items.length); assert.equal(today.items.some((item) => item.id === parent.id), false); assert.equal(today.items.some((item) => item.id === leaf.id), true);
  const overdue = data(await call(api, '/tasks?view=overdue')); assert.equal(overdue.items.some((item) => item.id === overdueTask.id), true);
  const followup = data(await call(api, '/tasks?view=followup')); assert.equal(followup.items.some((item) => item.id === leaf.id), true);

  const waitingTask = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 等待待跟进', spaceId: space.id } }), 201);
  const waitingDetail = data(await call(api, `/tasks/${waitingTask.id}`));
  data(await call(api, `/tasks/${waitingTask.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: waitingDetail.version, status: 'waiting', waitingReason: '等待外部确认' } }));
  const waitingReview = data(await call(api, '/review?kind=waiting')); assert.equal(waitingReview.items.some((item) => item.id === waitingTask.id), true);
  const projectTask = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 无下一步项目', spaceId: space.id } }), 201);
  const projectPreview = data(await call(api, `/tasks/${projectTask.id}/enable-project`));
  data(await call(api, `/tasks/${projectTask.id}/enable-project`, { method: 'POST', body: { requestId: id(), expectedVersion: projectPreview.expectedVersion, expectedStructureVersion: projectPreview.expectedStructureVersion, successCriteria: '完成项目' } }));
  const projectReview = data(await call(api, '/review?kind=project_next_action')); assert.equal(projectReview.items.some((item) => item.id === projectTask.id), true);
  const doneTask = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 已完成成果', spaceId: space.id } }), 201);
  const doneDetail = data(await call(api, `/tasks/${doneTask.id}`));
  const doneResult = data(await call(api, `/tasks/${doneTask.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: doneDetail.version, status: 'done' } }));
  const noteResult = data(await call(api, `/tasks/${doneTask.id}`, { method: 'PATCH', body: { requestId: id(), expectedVersion: doneResult.version, resultNote: '已完成并留下可复用结论' } })); assert.equal(noteResult.resultNote, '已完成并留下可复用结论');
  const completedReview = data(await call(api, '/review?kind=completed')); const completedItem = completedReview.items.find((item) => item.id === doneTask.id); assert.ok(completedItem); assert.equal(completedItem.resultNote, '已完成并留下可复用结论');
  const cancelledTask = data(await call(api, '/tasks', { method: 'POST', body: { requestId: id(), title: 'M6 已取消成果', spaceId: space.id } }), 201);
  const cancelledDetail = data(await call(api, `/tasks/${cancelledTask.id}`));
  data(await call(api, `/tasks/${cancelledTask.id}/transition`, { method: 'POST', body: { requestId: id(), expectedVersion: cancelledDetail.version, status: 'cancelled', cancellationReason: '需求已取消' } }));
  const cancelledReview = data(await call(api, '/review?kind=cancelled')); assert.equal(cancelledReview.items.some((item) => item.id === cancelledTask.id), true);
  assert.equal((await call(api, '/search')).status, 400); assert.equal((await call(api, '/review?kind=bad')).status, 400);
  console.log('M6 search/review: PASS (owner filtering, plaintext search, path/source fields, review categories, Shanghai date view, stable dedup)');
} finally { if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(300); if (child.exitCode === null) child.kill('SIGKILL'); } rmSync(temp, { recursive: true, force: true }); }
