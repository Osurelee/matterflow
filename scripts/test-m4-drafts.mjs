#!/usr/bin/env node
/**
 * M4-03 本机草稿契约测试（PRD 7.2、技术设计 5.2、AT-30）。
 *
 *   node --no-warnings --experimental-strip-types scripts/test-m4-drafts.mjs
 *
 * 只测纯逻辑与存储语义（内存后端）：键的账号/对象隔离、字段比较、
 * 恢复与冲突决策、解析与归属校验、容量上限、退出清理、后端不可用降级。
 */
import assert from 'node:assert/strict';
import {
  DRAFT_MAX_BYTES,
  DRAFT_SCHEMA_VERSION,
  captureDraftKey,
  createDraftStore,
  createMemoryDraftBackend,
  decideTaskDraft,
  draftFieldsEqual,
  draftKeyOf,
  emptyDraftFields,
  parseDraft,
  serializeDraft,
  taskDraftKey,
  userDraftKeyPrefix,
} from '../src/shared/drafts.ts';

let checks = 0;
async function check(label, fn) { await fn(); checks += 1; void label; }

const taskDraft = (overrides = {}) => ({
  schemaVersion: DRAFT_SCHEMA_VERSION, kind: 'task', userId: 'u1', taskId: 't1', baseVersion: 2,
  updatedAt: '2026-10-13T00:00:00.000Z', ...emptyDraftFields(), ...overrides,
});

const captureDraft = (overrides = {}) => ({
  schemaVersion: DRAFT_SCHEMA_VERSION, kind: 'capture', userId: 'u1', captureDraftId: 'c1',
  updatedAt: '2026-10-13T00:00:00.000Z', ...emptyDraftFields(), ...overrides,
});

const failingBackend = {
  async get() { throw new Error('QUOTA_EXCEEDED'); },
  async put() { throw new Error('QUOTA_EXCEEDED'); },
  async delete() { throw new Error('QUOTA_EXCEEDED'); },
  async keys() { throw new Error('QUOTA_EXCEEDED'); },
};

/* 1. 键：账号与对象隔离（技术设计 5.2） */
await check('draft keys are scoped by user and target', () => {
  assert.notEqual(taskDraftKey('u1', 't1'), taskDraftKey('u2', 't1'));
  assert.notEqual(taskDraftKey('u1', 't1'), captureDraftKey('u1', 't1'));
  assert.notEqual(draftKeyOf(taskDraft()), draftKeyOf(captureDraft()));
  assert.ok(taskDraftKey('u1', 't1').startsWith(userDraftKeyPrefix('u1')));
  assert.ok(!taskDraftKey('u1', 't1').startsWith(userDraftKeyPrefix('u2')));
});

/* 2. 字段比较：只比较内容字段，未完成上传标识不参与 */
await check('draft field comparison ignores pending uploads', () => {
  assert.equal(draftFieldsEqual(emptyDraftFields(), emptyDraftFields()), true);
  assert.equal(draftFieldsEqual(emptyDraftFields(), { ...emptyDraftFields(), pendingUploads: [{ kind: 'image', localId: 'x' }] }), true);
  for (const key of ['title', 'description', 'descriptionFormat', 'priority', 'plannedDate', 'dueDate', 'followUpDate', 'nextAction', 'blockedReason']) {
    assert.equal(draftFieldsEqual(emptyDraftFields(), { ...emptyDraftFields(), [key]: 'changed' }), false, `${key} 变化必须被识别`);
  }
});

/* 3. 恢复决策矩阵 */
await check('draft decision matrix', () => {
  const serverFields = emptyDraftFields();
  assert.deepEqual(decideTaskDraft({ draft: null, serverVersion: 2, serverFields }), { action: 'none' });
  assert.deepEqual(decideTaskDraft({ draft: taskDraft(), serverVersion: 2, serverFields }), { action: 'discard', reason: 'identical' });
  const dirty = taskDraft({ description: '本机编辑' });
  const restore = decideTaskDraft({ draft: dirty, serverVersion: 2, serverFields });
  assert.equal(restore.action, 'restore');
  assert.equal(restore.draft.description, '本机编辑');
  const conflict = decideTaskDraft({ draft: dirty, serverVersion: 5, serverFields });
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.serverVersion, 5);
  assert.equal(conflict.draft.description, '本机编辑');
  assert.deepEqual(decideTaskDraft({ draft: { ...dirty, schemaVersion: DRAFT_SCHEMA_VERSION + 1 }, serverVersion: 2, serverFields }), { action: 'discard', reason: 'invalid-version' });
});

/* 4. 解析与归属校验：换账号或结构不符一律视为无效草稿 */
await check('draft parsing and ownership checks', () => {
  const task = taskDraft({ description: 'x' });
  assert.deepEqual(parseDraft(serializeDraft(task), 'u1'), task);
  assert.deepEqual(parseDraft(serializeDraft(captureDraft()), 'u1'), captureDraft());
  assert.equal(parseDraft(serializeDraft(task), 'u2'), null);
  assert.equal(parseDraft(null, 'u1'), null);
  assert.equal(parseDraft('{ not json', 'u1'), null);
  assert.equal(parseDraft(JSON.stringify({ ...task, schemaVersion: 99 }), 'u1'), null);
  assert.equal(parseDraft(JSON.stringify({ ...task, description: 42 }), 'u1'), null);
  assert.equal(parseDraft(JSON.stringify({ ...task, kind: 'unknown' }), 'u1'), null);
  assert.equal(parseDraft(JSON.stringify({ ...task, taskId: undefined }), 'u1'), null);
  assert.equal(parseDraft(JSON.stringify({ ...task, pendingUploads: 'nope' }), 'u1'), null);
  const detailedCapture=captureDraft({title:'待提交语音',sourceUrl:'https://example.test/x',sourceLabel:'来源',captureMode:'multiple',multiText:'甲\n乙',previewRows:['甲','乙'],captureAudioAssetIds:['asset-audio-1'],spaceId:'space-1',projectId:'',pendingUploads:[{kind:'audio',localId:'asset-audio-1',note:'已暂存'}],mediaAssets:[{assetId:'asset-image-1',originalName:'图.png',mimeType:'image/png',byteSize:123,kind:'image',contentUrl:'/api/assets/asset-image-1/content'}]});
  assert.deepEqual(parseDraft(serializeDraft(detailedCapture),'u1'),detailedCapture,'captureDraftId应往返恢复捕获字段与已暂存媒体元数据');
  assert.equal(parseDraft(JSON.stringify({...captureDraft(),pendingUploads:[{kind:'video',localId:'v'}]}),'u1'),null,'未知待上传类型应拒绝');
});

/* 5. 读写与账号隔离 */
await check('draft store round trip and per-account isolation', async () => {
  const store = createDraftStore(createMemoryDraftBackend());
  assert.equal(await store.save(taskDraft({ description: '未提交正文' })), 'saved');
  assert.equal((await store.loadTask('u1', 't1')).description, '未提交正文');
  assert.equal(await store.loadTask('u2', 't1'), null, '其他账号不得读到草稿');
  assert.equal(await store.loadTask('u1', 'other-task'), null);
  await store.save(captureDraft({ title: '捕获草稿' }));
  assert.equal((await store.loadCapture('u1', 'c1')).title, '捕获草稿');
  assert.equal(await store.loadTask('u1', 'c1'), null, '捕获草稿不得被当作事项草稿');
});

/* 6. 退出清理：只清理当前账号并报数 */
await check('clearUser removes only that account and reports count', async () => {
  const backend = createMemoryDraftBackend();
  const store = createDraftStore(backend);
  await store.save(taskDraft());
  await store.save(captureDraft());
  await store.save(taskDraft({ userId: 'u2', taskId: 't2' }));
  assert.equal((await backend.keys()).length, 3);
  assert.equal(await store.clearUser('u1'), 2);
  const remaining = await backend.keys();
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].includes('|u2|'), remaining[0]);
  assert.equal(await store.loadTask('u1', 't1'), null);
  assert.equal((await store.loadTask('u2', 't2')) !== null, true, '其他账号草稿必须保留');
});

/* 7. 单条删除不影响其他草稿 */
await check('removeTask deletes one draft only', async () => {
  const backend = createMemoryDraftBackend();
  const store = createDraftStore(backend);
  await store.save(taskDraft());
  await store.save(captureDraft());
  await store.removeTask('u1', 't1');
  assert.equal(await store.loadTask('u1', 't1'), null);
  assert.equal((await store.loadCapture('u1', 'c1')) !== null, true);
});

/* 8. 容量上限：超限不落盘 */
await check('size guard rejects oversized drafts without writing', async () => {
  const backend = createMemoryDraftBackend();
  const store = createDraftStore(backend);
  assert.equal(await store.save(taskDraft({ description: 'a'.repeat(Math.floor(DRAFT_MAX_BYTES * 0.9)) })), 'saved');
  assert.equal(await store.save(taskDraft({ description: 'a'.repeat(DRAFT_MAX_BYTES + 1024) })), 'too-large');
  const keys = await backend.keys();
  assert.equal(keys.length, 1, '超限草稿不得落盘');
  const stored = JSON.parse(await backend.get(keys[0]));
  assert.equal(stored.description.length, Math.floor(DRAFT_MAX_BYTES * 0.9), '落盘内容应保持未超限的那一份');
});

/* 9. 后端不可用（配额/隐私模式）：降级而不抛错 */
await check('backend failure degrades without throwing', async () => {
  const store = createDraftStore(failingBackend);
  assert.equal(await store.save(taskDraft()), 'unavailable');
  assert.equal(await store.loadTask('u1', 't1'), null);
  assert.equal(await store.loadCapture('u1', 'c1'), null);
  assert.equal(await store.clearUser('u1'), 0);
  await store.removeTask('u1', 't1');
});

console.log(`M4-03 draft contract: PASS (${checks} checks)`);
