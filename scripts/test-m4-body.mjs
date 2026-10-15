#!/usr/bin/env node
/**
 * M4-01 正文共同子集契约测试（PRD v0.6 7.1、技术设计 5.1/5.3、AT-28/AT-29）。
 *
 * 直接对 src/domain/body.ts 做纯逻辑验证，不连数据库、不启动服务：
 *   node --experimental-strip-types scripts/test-m4-body.mjs
 * 覆盖：共同子集往返稳定、未知语法保留、旧纯文本升级不误解释、
 * 渲染净化、派生纯文本、资源令牌与码点上限。
 */
import assert from 'node:assert/strict';
import {
  BODY_MAX_CODE_POINTS,
  bodyToPlainText,
  canonicalBody,
  escapePlaintextToMarkdown,
  isAssetToken,
  parseBody,
  prepareBody,
  renderSafeHtml,
  safeHref,
  validateBody,
} from '../src/domain/body.ts';

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

/* 1. 共同子集：规范化后往返稳定（parse → serialize → parse 深度一致） */
const samples = [
  '',
  '只有一行普通文字',
  '第一行\n第二行（同一段落内换行）',
  '# 一级标题',
  '## 二级标题',
  '### 三级标题',
  '# 标题\n\n正文 **粗体** 与 *斜体* 与 ~~删除线~~。',
  '- 第一项\n- 第二项',
  '* 星号开头列表',
  '1. 甲\n2. 乙',
  '3. 从三开始\n4. 继续',
  '> 引用一\n> 引用二',
  '```js\nconst a = 1;\n```',
  '~~~\n无语言围栏\n~~~',
  '见 [链接](https://example.com/x?a=1) 与 ![图](asset:11111111-1111-4111-8111-111111111111)',
  '行内 `code` 与 \\*转义星号\\*',
  '_下划线斜体_ 与 __下划线粗体__',
  '| a | b |\n| - | - |',
  '---',
  '文字\n===',
  '文字\n---',
  '#### 四级标题',
  '###### 六级标题',
  '见 https://example.com 的说明',
  '[ ] 裸待办',
  '[x] 已完成',
  '[] 空框',
  '- [] 带符号空框',
  '```\n未闭合围栏',
  '<div onclick="x">html</div>',
  ' 缩进的 - 嵌套列表保留原样',
  '1. 列表\n\n段落分隔',
  '文字 <script>alert(1)</script> 文字',
];
for (const sample of samples) {
  check(`roundtrip:${sample.slice(0, 12)}`, () => {
    const once = canonicalBody(sample);
    const twice = canonicalBody(once);
    assert.equal(twice, once, `规范化不稳定: ${JSON.stringify(sample)} -> ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
    assert.deepEqual(parseBody(twice), parseBody(once));
  });
}

/* 2. 明确的规范化结果：只统一块分隔与列表符号，不改写内容 */
check('heading-paragraph-block separator', () => assert.equal(canonicalBody('a\n# h'), 'a\n\n# h'));
check('bullet canonical symbol', () => assert.equal(canonicalBody('* a\n* b'), '- a\n- b'));
check('escape preserved', () => assert.equal(canonicalBody('\\*不是斜体\\*'), '\\*不是斜体\\*'));
check('unclosed fence preserved', () => assert.equal(canonicalBody('```\n未闭合'), '```\n未闭合'));
check('trailing blank lines trimmed', () => assert.equal(canonicalBody('文字\n\n\n'), '文字'));

/* 3. 未知语法：保留原文并标记，绝不静默丢弃；表格与待办为已支持语法 */
check('unsupported flags + table/task-list support', () => {
  const table = parseBody('| a | b |\n| - | - |\n| c | d |');
  assert.equal(table.hasUnsupportedSyntax, false);
  assert.equal(table.blocks[0].type, 'table');
  assert.equal(canonicalBody('| a | b |\n| - | - |'), '| a | b |\n| --- | --- |');
  const tableHtml = renderSafeHtml('| a | b |\n| --- | --- |\n| c | d |');
  assert.ok(tableHtml.includes('<table>'), tableHtml);
  assert.ok(tableHtml.includes('<td>'), tableHtml);
  assert.equal(parseBody('| a | b |').hasUnsupportedSyntax, true, '残缺表格仍标记不支持');
  assert.equal(parseBody('#### 四级').hasUnsupportedSyntax, false, '四~六级标题为支持语法');
  assert.equal(parseBody('<b>x</b>').hasUnsupportedSyntax, true);
  assert.equal(parseBody('- [ ] 小步骤').hasTaskListSyntax, true);
  assert.equal(parseBody('- 普通项').hasTaskListSyntax, false);
  assert.equal(parseBody('- [] 带符号空框').hasTaskListSyntax, true, '`- []` 空框也识别为待办');
  assert.equal(parseBody('[ ] 裸待办').blocks[0].type, 'list', '裸 `[ ]` 行识别为待办列表');
  assert.equal(parseBody('[ ] 裸待办').hasTaskListSyntax, true);
  assert.ok(renderSafeHtml('- [ ] 待办').includes('type="checkbox"'));
  assert.ok(renderSafeHtml('[ ] 裸待办').includes('type="checkbox"'));
  assert.ok(renderSafeHtml('[x](https://example.com)').includes('<a href'), '`[x](url)` 是链接不是待办');
  assert.equal(canonicalBody('[ ] 裸待办'), '[ ] 裸待办', '裸待办往返保持形态');
  assert.equal(bodyToPlainText('- [x] 已完成'), '已完成');
});

/* 3b. 横线、setext 标题、四级+标题、裸链接自动识别 */
check('hr / setext / h4-h6 / autolink', () => {
  assert.equal(parseBody('---').blocks[0].type, 'hr');
  assert.equal(canonicalBody('---'), '---');
  assert.ok(renderSafeHtml('a\n\n---').includes('<hr'), '横线渲染为 <hr>');
  assert.equal(parseBody('文字\n===').blocks[0].type, 'heading');
  assert.equal(parseBody('文字\n===').blocks[0].level, 1);
  assert.equal(parseBody('文字\n---').blocks[0].level, 2);
  assert.equal(canonicalBody('文字\n==='), '# 文字');
  assert.equal(parseBody('#### 四级').blocks[0].level, 4);
  assert.equal(parseBody('###### 六级').blocks[0].level, 6);
  assert.ok(renderSafeHtml('#### 四级').includes('<h4>'), '四级标题渲染为 h4');
  const urlHtml = renderSafeHtml('见 https://example.com/a?x=1。');
  assert.ok(urlHtml.includes('<a href="https://example.com/a?x=1"'), urlHtml);
  assert.ok(urlHtml.includes('>https://example.com/a?x=1</a>'), urlHtml);
  assert.ok(urlHtml.includes('</a>。'), '链接后的句号不被吞掉');
  assert.equal(canonicalBody('见 https://example.com/a。'), '见 https://example.com/a。', '裸链接不改写源文本');
});

/* 4. 派生纯文本（搜索用） */
check('plain text derivation', () => {
  assert.equal(
    bodyToPlainText('## 标题\n\n正文 **粗** [链接](https://x) ![图注](asset:11111111-1111-4111-8111-111111111111)'),
    '标题\n正文 粗 链接 图注',
  );
  assert.equal(bodyToPlainText('- a\n- b'), 'a\nb');
  assert.equal(bodyToPlainText('\\*字面星号\\*'), '*字面星号*');
  assert.equal(bodyToPlainText('```\nkeep code\n```'), 'keep code');
});

/* 5. 渲染净化（AT-29）：HTML 不执行、危险链接拒绝、外部图片不内联 */
check('sanitized rendering', () => {
  const html = renderSafeHtml('文字 <script>alert(1)</script> 文字');
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
  const unsafe = renderSafeHtml('[点我](javascript:alert(1))');
  assert.ok(!unsafe.includes('javascript:'), unsafe);
  assert.ok(unsafe.includes('链接已忽略'), unsafe);
  assert.equal(safeHref('https://ok.example/a'), 'https://ok.example/a');
  assert.equal(safeHref('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html;base64,xx'), null);
  assert.equal(safeHref('/etc/passwd'), null);
  const external = renderSafeHtml('![远端](https://cdn.example/a.png)');
  assert.ok(!external.includes('<img'), external);
  const local = renderSafeHtml('![本机](asset:11111111-1111-4111-8111-111111111111)');
  assert.ok(local.includes('data-asset-id="11111111-1111-4111-8111-111111111111"'), local);
  assert.equal(isAssetToken('asset:11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isAssetToken('asset:../../../etc/passwd'), false);
});

/* 6. 旧纯文本升级（AT-28）：星号/井号/列表符号不被误解释 */
check('plaintext upgrade keeps literal text', () => {
  const legacy = '# 这不是标题\n*这不是斜体*\n- 这不是列表\n1. 这不是序号';
  const escaped = escapePlaintextToMarkdown(legacy);
  const parsed = parseBody(escaped);
  assert.equal(parsed.blocks.every((block) => block.type === 'paragraph'), true, JSON.stringify(parsed.blocks));
  assert.equal(bodyToPlainText(escaped), legacy);
  const prepared = prepareBody({ description: legacy, format: 'markdown_v1', convertFromPlaintext: true });
  assert.equal(prepared.descriptionFormat, 'markdown_v1');
  assert.equal(prepared.descriptionPlain, legacy);
  assert.ok(prepared.description.startsWith('\\#'), prepared.description);
  // 普通文字不受转义影响
  assert.equal(escapePlaintextToMarkdown('正常的一段话，含标点。（括号）'), '正常的一段话，含标点。（括号）');
});

/* 7. 码点上限与格式契约 */
check('code point limit and format', () => {
  assert.equal(BODY_MAX_CODE_POINTS, 20000);
  assert.deepEqual(validateBody('😀'.repeat(20000)), { ok: true });
  assert.equal(validateBody('😀'.repeat(20001)).ok, false);
  const plain = prepareBody({ description: '纯文本 * 保持', format: 'plaintext' });
  assert.equal(plain.descriptionFormat, 'plaintext');
  assert.equal(plain.descriptionPlain, '纯文本 * 保持');
  assert.equal(plain.hasUnsupportedSyntax, false);
});

console.log(`M4-01 body contract: PASS (${checks} checks)`);
