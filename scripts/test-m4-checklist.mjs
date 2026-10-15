#!/usr/bin/env node
/**
 * M4-04 结构化小步骤契约测试（PRD 9.3/9.4、7.1；FR-22；AT-37）。
 *
 *   node --no-warnings --experimental-strip-types scripts/test-m4-checklist.mjs
 *
 * 只测纯逻辑：文本校验、排序键、上下移动、计数、未勾完确认文案、
 * 正文静态复选框的识别与移除。
 */
import assert from 'node:assert/strict';
import {
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_TEXT_MAX_CODE_POINTS,
  checklistCounts,
  moveId,
  normalizeSortKeys,
  sortKeyForIndex,
  staticChecklistLines,
  stripStaticChecklistLines,
  uncheckedCompletionWarning,
  validateChecklistText,
} from '../src/domain/checklist.ts';

let checks = 0;
async function check(label, fn) { await fn(); checks += 1; void label; }

await check('limits match PRD 9.3', () => {
  assert.equal(CHECKLIST_MAX_ITEMS, 100);
  assert.equal(CHECKLIST_TEXT_MAX_CODE_POINTS, 500);
});

await check('text validation', () => {
  assert.deepEqual(validateChecklistText('  打电话  '), { ok: true, text: '打电话' });
  assert.equal(validateChecklistText('').ok, false);
  assert.equal(validateChecklistText('   ').ok, false);
  assert.equal(validateChecklistText(42).reason, 'NOT_TEXT');
  assert.equal(validateChecklistText('😀'.repeat(500)).ok, true, '500 码点应通过');
  assert.equal(validateChecklistText('😀'.repeat(501)).reason, 'TOO_LONG');
});

await check('sort keys are fixed width and ordered', () => {
  assert.equal(sortKeyForIndex(0), '0000');
  assert.equal(sortKeyForIndex(9), '0009');
  assert.equal(sortKeyForIndex(99), '0099');
  const keys = normalizeSortKeys(3);
  assert.deepEqual(keys, ['0000', '0001', '0002']);
  assert.deepEqual([...keys].sort(), keys, '字典序即顺序');
  assert.equal(normalizeSortKeys(0).length, 0);
});

await check('move is pure and boundary safe', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveId(ids, 'b', 'up'), ['b', 'a', 'c']);
  assert.deepEqual(moveId(ids, 'b', 'down'), ['a', 'c', 'b']);
  assert.deepEqual(moveId(ids, 'a', 'up'), ['a', 'b', 'c'], '首项上移应无变化');
  assert.deepEqual(moveId(ids, 'c', 'down'), ['a', 'b', 'c'], '末项下移应无变化');
  assert.deepEqual(moveId(ids, 'missing', 'up'), ['a', 'b', 'c']);
  assert.deepEqual(ids, ['a', 'b', 'c'], '不得就地修改入参');
});

await check('counts and completion warning', () => {
  assert.deepEqual(checklistCounts([{ isChecked: true }, { isChecked: false }]), { total: 2, checked: 1, unchecked: 1 });
  assert.deepEqual(checklistCounts([]), { total: 0, checked: 0, unchecked: 0 });
  assert.equal(uncheckedCompletionWarning(0), null);
  const warning = uncheckedCompletionWarning(3);
  assert.ok(warning && warning.includes('3'), warning);
  assert.ok(warning.includes('确定完成'), warning);
});

await check('static checkbox lines are recognised, others ignored', () => {
  const lines = staticChecklistLines('# 标题\n- [ ] 打电话\n- [x] 发邮件\n- [X] 已归档\n- 普通项\n- [ ] \n  缩进 - [ ] 不算\n正文');
  assert.deepEqual(lines.map((entry) => entry.text), ['打电话', '发邮件', '已归档']);
  assert.deepEqual(lines.map((entry) => entry.checked), [false, true, true]);
  assert.equal(lines[0].line, '- [ ] 打电话');
  assert.equal(staticChecklistLines('没有复选框').length, 0);
  assert.equal(staticChecklistLines('**加粗** - [ ] 不在行首').length, 0);
});

await check('stripping removes only those lines and keeps the rest', () => {
  const body = '# 标题\n\n- [ ] 打电话\n- [x] 发邮件\n\n正文保持不变';
  const lines = staticChecklistLines(body);
  const stripped = stripStaticChecklistLines(body, lines.map((entry) => entry.line));
  assert.equal(stripped, '# 标题\n\n正文保持不变');
  assert.ok(!stripped.includes('打电话') && !stripped.includes('发邮件'), stripped);
  // 重复行只移除第一个
  const duplicated = '- [ ] 重复\n- [ ] 重复';
  const firstOnly = stripStaticChecklistLines(duplicated, ['- [ ] 重复']);
  assert.equal(firstOnly, '- [ ] 重复');
  // 未传入的行不动
  assert.equal(stripStaticChecklistLines(body, []), body);
});

console.log(`M4-04 checklist contract: PASS (${checks} checks)`);
