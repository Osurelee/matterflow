/**
 * M4-01 正文共同子集契约（PRD v0.6 7.1、技术设计 5.1/5.3）。
 *
 * 唯一内容源：`tasks.description` 保存用户原文，`description_format` 区分
 * `plaintext`（M4 之前的旧数据）与 `markdown_v1`；`description_plain` 由本模块派生，
 * 只作为搜索用的派生值，永不反向编辑。
 *
 * 共同支持子集（PRD 7.1、快速捕获扩展）：段落、一~三级标题、粗体、斜体、删除线、
 * 无序/有序列表（含 `- [ ]` 待办复选框）、引用、行内代码与围栏代码块、链接、
 * GFM 表格、本机资源引用（`asset:UUID`）。
 *
 * 数据安全规则：
 * - 不支持的语法（四级以上标题、任意 HTML、缩进嵌套列表、未闭合围栏、残缺表格等）
 *   作为 `raw` 块原样保留，源模式往返不丢内容，渲染时只做转义，绝不执行。
 * - `parse` 保留反斜杠转义原文，因此 `serialize(parse(x))` 稳定可预期；
 *   只有 `canonicalBody` 会改写块之间的分隔空行与表格分隔行。
 * - 旧纯文本升级到 markdown_v1 必须先经 `escapePlaintextToMarkdown`，
 *   否则旧文本里的 `*` / `_` / `#` / `|` 会被误解释为格式（PRD 7.1、AT-28）。
 *
 * 本模块不依赖网络、数据库或框架，可被服务端、客户端与测试脚本直接引用。
 */

export const DESCRIPTION_FORMATS = ['plaintext', 'markdown_v1'] as const;
export type DescriptionFormat = (typeof DESCRIPTION_FORMATS)[number];

/** 语义正文上限（PRD 5.2：最多 20,000 码点）。 */
export const BODY_MAX_CODE_POINTS = 20000;

/** 资源引用令牌前缀：正文里用 `asset:<uuid>`，渲染走私有读取接口（技术设计 5.1/6.2）。 */
export const ASSET_TOKEN_PREFIX = 'asset:';

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'emphasis'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'image'; src: string; alt: string };

/** 列表项：text 为解析后的行内节点；checked 非空表示 `- [ ]` / `- [x]` 待办复选框。 */
export type ListItem = { text: InlineNode[]; checked: boolean | null };

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[]; bareTasks?: boolean }
  | { type: 'quote'; lines: InlineNode[][] }
  | { type: 'codeBlock'; lang: string | null; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'raw'; text: string };

export type ParseResult = {
  blocks: BlockNode[];
  /** 存在超出共同子集的语法（表格、四级标题、任意 HTML 等）。 */
  hasUnsupportedSyntax: boolean;
  /** 存在 `- [ ]` 复选框语法，M4-04 会提示转换为结构化小步骤（PRD 7.1）。 */
  hasTaskListSyntax: boolean;
};

/* -------------------------------------------------- 规范化与校验 */

/** 统一换行并去掉首尾空行；这是安全的最小规范化，不改动块结构。 */
export function normalizeBody(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/** 码点长度（与标题/密码校验口径一致，不使用 UTF-16 长度）。 */
export function codePointLength(value: string): number {
  return [...value].length;
}

export function validateBody(source: string): { ok: true } | { ok: false; reason: 'TOO_LONG' } {
  return codePointLength(source) > BODY_MAX_CODE_POINTS ? { ok: false, reason: 'TOO_LONG' } : { ok: true };
}

/** 仅允许 http/https/mailto；其余（javascript:、data:、file: 等）返回 null，渲染为纯文本。 */
export function safeHref(href: string): string | null {
  const cleaned = href.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(cleaned)) return cleaned;
  return null;
}

export function isAssetToken(src: string): boolean {
  return new RegExp(`^${ASSET_TOKEN_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i').test(src.trim());
}

export function assetIdFromToken(src: string): string | null {
  return isAssetToken(src) ? src.trim().slice(ASSET_TOKEN_PREFIX.length).toLowerCase() : null;
}

/* -------------------------------------------------- 行内解析 */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '[', ']', '(', ')', '!', '#', '>', '-', '+', '.', '|']);

function findClosing(src: string, from: number, token: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src.startsWith(token, i)) return i;
    i += 1;
  }
  return -1;
}

function matchBracket(src: string, start: number): { text: string; href: string; end: number } | null {
  let i = start + 1;
  let text = '';
  while (i < src.length) {
    const char = src[i];
    if (char === '\\' && i + 1 < src.length) { text += char + src[i + 1]; i += 2; continue; }
    if (char === '\n') return null;
    if (char === ']') break;
    text += char; i += 1;
  }
  if (i >= src.length || src[i] !== ']' || src[i + 1] !== '(') return null;
  let j = i + 2;
  let href = '';
  while (j < src.length) {
    const char = src[j];
    if (char === '\\' && j + 1 < src.length) { href += char + src[j + 1]; j += 2; continue; }
    if (char === '\n') return null;
    if (char === ')') break;
    href += char; j += 1;
  }
  if (j >= src.length || src[j] !== ')') return null;
  return { text, href, end: j + 1 };
}

function parseInline(src: string, depth = 0): InlineNode[] {
  if (depth > 6) return [{ type: 'text', text: src }];
  const out: InlineNode[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { out.push({ type: 'text', text: buffer }); buffer = ''; } };
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    if (char === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) { buffer += char + src[i + 1]; i += 2; continue; }
    if (char === '`') {
      const close = findClosing(src, i + 1, '`');
      if (close > i + 1) { flush(); out.push({ type: 'code', text: src.slice(i + 1, close) }); i = close + 1; continue; }
    }
    if (char === '!' && src[i + 1] === '[') {
      const image = matchBracket(src, i + 1);
      if (image) { flush(); out.push({ type: 'image', src: image.href.trim(), alt: image.text }); i = image.end; continue; }
    }
    if (char === '[') {
      const link = matchBracket(src, i);
      if (link) { flush(); out.push({ type: 'link', href: link.href.trim(), children: parseInline(link.text, depth + 1) }); i = link.end; continue; }
    }
    if (src.startsWith('**', i)) {
      const close = findClosing(src, i + 2, '**');
      if (close > i + 2) { flush(); out.push({ type: 'strong', children: parseInline(src.slice(i + 2, close), depth + 1) }); i = close + 2; continue; }
    }
    if (src.startsWith('__', i)) {
      const close = findClosing(src, i + 2, '__');
      if (close > i + 2) { flush(); out.push({ type: 'strong', children: parseInline(src.slice(i + 2, close), depth + 1) }); i = close + 2; continue; }
    }
    if (src.startsWith('~~', i)) {
      const close = findClosing(src, i + 2, '~~');
      if (close > i + 2) { flush(); out.push({ type: 'strike', children: parseInline(src.slice(i + 2, close), depth + 1) }); i = close + 2; continue; }
    }
    if (char === '*' || char === '_') {
      const close = findClosing(src, i + 1, char);
      const inner = close > i + 1 ? src.slice(i + 1, close) : '';
      if (close > i + 1 && inner.trim() === inner && !inner.includes('\n')) {
        flush(); out.push({ type: 'emphasis', children: parseInline(inner, depth + 1) }); i = close + 1; continue;
      }
    }
    buffer += char; i += 1;
  }
  flush();
  return out;
}

/* -------------------------------------------------- 块解析 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^(\d{1,9})[.)]\s+(.*)$/;
const TASK_ITEM = /^\[[ xX]?\]\s?/;
/** 裸待办行：行首 `[ ]` / `[]` / `[x]` / `[X]` 后接空格，无需 `- ` 列表符号。 */
const TASK_LINE = /^(\[[ xX]?\])\s+(.*)$/;
const TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;
const HORIZONTAL_RULE = /^(\s*)(-{3,}|\*{3,}|_{3,})(\s*)$/;
const SETEXT_H1 = /^=+$/;
const SETEXT_H2 = /^-+$/;

/** 拆一行 `| a | b |` 的单元格；保留反斜杠转义（`\|`）给行内解析器处理。 */
function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (!text.startsWith('|')) return [];
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) { current += char + text[i + 1]; i += 1; continue; }
    if (char === '|') { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.length || text.endsWith('|')) cells.push(current.trim());
  if (cells.length >= 2 && cells[0] === '' && cells[cells.length - 1] === '') return cells.slice(1, -1);
  return cells.filter((cell) => cell !== '');
}

/** GFM 分隔行：每个单元格只含 `-`、可选 `:` 对齐标记。 */
function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()));
}

function isBlockStart(line: string): boolean {
  return line.trim() === '' || FENCE.test(line) || HEADING.test(line) || QUOTE.test(line)
    || BULLET.test(line) || ORDERED.test(line) || TASK_LINE.test(line) || line.startsWith('|');
}

export function parseBody(source: string): ParseResult {
  const lines = normalizeBody(source).split('\n');
  const blocks: BlockNode[] = [];
  let hasUnsupportedSyntax = false;
  let hasTaskListSyntax = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') { index += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim();
      const body: string[] = [];
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        if (new RegExp(`^${marker}\\s*$`).test(lines[cursor])) { closed = true; break; }
        body.push(lines[cursor]);
        cursor += 1;
      }
      if (closed) {
        blocks.push({ type: 'codeBlock', lang: lang || null, text: body.join('\n') });
        index = cursor + 1;
      } else {
        hasUnsupportedSyntax = true;
        blocks.push({ type: 'raw', text: lines.slice(index).join('\n') });
        index = lines.length;
      }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level <= 6) blocks.push({ type: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) });
      else { hasUnsupportedSyntax = true; blocks.push({ type: 'raw', text: line }); }
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoteLines: InlineNode[][] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoteLines.push(parseInline(QUOTE.exec(lines[index])![1]));
        index += 1;
      }
      blocks.push({ type: 'quote', lines: quoteLines });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const start = ordered ? Number(ordered[1]) : 1;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = isOrdered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index]);
        if (!match) break;
        const raw = isOrdered ? match[2] : match[1];
        let checked: boolean | null = null;
        let text = raw;
        if (TASK_ITEM.test(raw)) {
          hasTaskListSyntax = true;
          checked = /^\[[xX]\]/.test(raw);
          text = raw.replace(TASK_ITEM, '');
        }
        items.push({ text: parseInline(text), checked });
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items });
      continue;
    }

    const taskLine = TASK_LINE.exec(line);
    if (taskLine) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = TASK_LINE.exec(lines[index]);
        if (!match) break;
        hasTaskListSyntax = true;
        items.push({ text: parseInline(match[2]), checked: /^\[[xX]\]/.test(match[1]) });
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, start: 1, items, bareTasks: true });
      continue;
    }

    if (line.startsWith('|')) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].startsWith('|')) { tableLines.push(lines[index]); index += 1; }
      const header = splitTableRow(tableLines[0]);
      if (tableLines.length >= 2 && isTableSeparator(tableLines[1]) && header.length > 0) {
        const rows: string[][] = [];
        for (let row = 2; row < tableLines.length; row += 1) {
          const cells = splitTableRow(tableLines[row]);
          if (cells.length > 0) rows.push(cells);
        }
        blocks.push({ type: 'table', header, rows });
      } else {
        hasUnsupportedSyntax = true;
        blocks.push({ type: 'raw', text: tableLines.join('\n') });
      }
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockStart(lines[index])) { paragraphLines.push(lines[index]); index += 1; }
    if (paragraphLines.length === 0) { paragraphLines.push(line); index += 1; }
    const lastLine = paragraphLines[paragraphLines.length - 1];
    if (paragraphLines.length >= 2 && SETEXT_H1.test(lastLine)) {
      blocks.push({ type: 'heading', level: 1, children: parseInline(paragraphLines.slice(0, -1).join('\n')) });
      continue;
    }
    if (paragraphLines.length >= 2 && SETEXT_H2.test(lastLine)) {
      blocks.push({ type: 'heading', level: 2, children: parseInline(paragraphLines.slice(0, -1).join('\n')) });
      continue;
    }
    if (paragraphLines.length === 1 && HORIZONTAL_RULE.test(paragraphLines[0])) {
      blocks.push({ type: 'hr' });
      continue;
    }
    const text = paragraphLines.join('\n');
    if (/<[a-zA-Z!/]/.test(text)) hasUnsupportedSyntax = true;
    blocks.push({ type: 'paragraph', children: parseInline(text) });
  }

  return { blocks, hasUnsupportedSyntax, hasTaskListSyntax };
}

/* -------------------------------------------------- 序列化 */

export function serializeInline(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'strong': return `**${serializeInline(node.children)}**`;
      case 'emphasis': return `*${serializeInline(node.children)}*`;
      case 'strike': return `~~${serializeInline(node.children)}~~`;
      case 'code': return `\`${node.text}\``;
      case 'link': return `[${serializeInline(node.children)}](${node.href})`;
      case 'image': return `![${node.alt}](${node.src})`;
    }
  }).join('');
}

export function serializeBody(blocks: BlockNode[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph': return serializeInline(block.children);
      case 'heading': return `${'#'.repeat(block.level)} ${serializeInline(block.children)}`;
      case 'list': return block.items
        .map((item, offset) => {
          const marker = block.bareTasks ? '' : block.ordered ? `${block.start + offset}. ` : '- ';
          const task = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
          return `${marker}${task}${serializeInline(item.text)}`;
        })
        .join('\n');
      case 'quote': return block.lines.map((line) => `> ${serializeInline(line)}`).join('\n');
      case 'codeBlock': return `\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\``;
      case 'table': {
        const header = `| ${block.header.join(' | ')} |`;
        const separator = `| ${block.header.map(() => '---').join(' | ')} |`;
        const body = block.rows.map((row) => `| ${row.join(' | ')} |`);
        return [header, separator, ...body].join('\n');
      }
      case 'hr': return '---';
      case 'raw': return block.text;
    }
  }).join('\n\n');
}

/** 源模式 ↔ 可视模式共用的规范化文本：块之间统一一个空行。 */
export function canonicalBody(source: string): string {
  return serializeBody(parseBody(source).blocks);
}

/* -------------------------------------------------- 派生值 */

/** 去掉用于保真的反斜杠转义，得到显示/搜索文本。 */
function unescape(text: string): string {
  return text.replace(/\\([\s\S])/g, (_, char: string) => (ESCAPABLE.has(char) ? char : `\\${char}`));
}

function inlinePlainText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return unescape(node.text);
      case 'strong':
      case 'emphasis':
      case 'strike':
      case 'link': return inlinePlainText(node.children);
      case 'code': return node.text;
      case 'image': return node.alt;
    }
  }).join('');
}

/** description_plain：仅供搜索的派生文本，不反向编辑（技术设计 5.1）。 */
export function bodyToPlainText(source: string): string {
  const { blocks } = parseBody(source);
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph':
      case 'heading': return inlinePlainText(block.children);
      case 'list': return block.items.map((item) => inlinePlainText(item.text)).join('\n');
      case 'quote': return block.lines.map((line) => inlinePlainText(line)).join('\n');
      case 'codeBlock': return block.text;
      case 'table': {
        const rows = [block.header, ...block.rows].map((row) => row.map((cell) => inlinePlainText(parseInline(cell))).join(' '));
        return rows.join('\n');
      }
      case 'hr': return '';
      case 'raw': return unescape(block.text);
    }
  }).filter((part) => part.trim() !== '').join('\n');
}

/* -------------------------------------------------- 渲染 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 裸链接自动识别（GFM autolink 子集）：仅渲染层生效，正文源文本保持原样。 */
function renderInlineText(raw: string): string {
  const text = unescape(raw);
  const parts = text.split(/(https?:\/\/[^\s<>()]+)/);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      const match = /^(https?:\/\/[^\s<>()]*?)([.,;:!?"'）。！？、」』”’…]*)$/.exec(part);
      const href = match && match[1] ? safeHref(match[1]) : null;
      if (href) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(match![1])}</a>${escapeHtml(match![2])}`;
      return escapeHtml(part);
    }
    return escapeHtml(part).replace(/\n/g, '<br />');
  }).join('');
}

function renderInline(nodes: InlineNode[], assetUrl: (assetId: string) => string): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return renderInlineText(node.text);
      case 'strong': return `<strong>${renderInline(node.children, assetUrl)}</strong>`;
      case 'emphasis': return `<em>${renderInline(node.children, assetUrl)}</em>`;
      case 'strike': return `<s>${renderInline(node.children, assetUrl)}</s>`;
      case 'code': return `<code>${escapeHtml(node.text)}</code>`;
      case 'link': {
        const href = safeHref(node.href);
        const label = renderInline(node.children, assetUrl);
        if (!href) return `${label}<span class="bodyUnsafeLink">（链接已忽略）</span>`;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
      }
      case 'image': {
        const assetId = assetIdFromToken(node.src);
        const alt = escapeHtml(unescape(node.alt));
        if (assetId) return `<span class="bodyAsset" data-asset-id="${assetId}"><img class="bodyAssetImage" src="${escapeHtml(assetUrl(assetId))}" data-asset-id="${assetId}" alt="${alt || '图片'}" loading="lazy" /></span>`;
        const href = safeHref(node.src);
        // PRD 7.1：外部图片只作为链接，不内联预览。
        return href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${alt || escapeHtml(href)}</a>`
          : `${alt ? escapeHtml(alt) : ''}<span class="bodyUnsafeLink">（图片链接已忽略）</span>`;
      }
    }
  }).join('');
}

/**
 * 渲染为可安全注入的 HTML：只输出本模块生成的标签，文本全部转义，
 * 不支持的语法按纯文本输出，绝不执行（技术设计 5.1、AT-29）。
 */
export function renderSafeHtml(source: string, assetUrl: (assetId: string) => string = (assetId) => `/api/assets/${assetId}/content`): string {
  const { blocks } = parseBody(source);
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph': return `<p>${renderInline(block.children, assetUrl)}</p>`;
      case 'heading': return `<h${block.level}>${renderInline(block.children, assetUrl)}</h${block.level}>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const attrs = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
        return `<${tag}${attrs}>${block.items.map((item) => {
          const checkedAttr = item.checked === null ? '' : ` data-checked="${item.checked ? 'true' : 'false'}"`;
          const checkbox = item.checked === null ? '' : `<input type="checkbox"${item.checked ? ' checked' : ''} />`;
          return `<li${item.checked === null ? '' : ' class="bodyTaskItem"'}${checkedAttr}>${checkbox}${renderInline(item.text, assetUrl)}</li>`;
        }).join('')}</${tag}>`;
      }
      case 'quote': return `<blockquote>${block.lines.map((line) => `<p>${renderInline(line, assetUrl)}</p>`).join('')}</blockquote>`;
      case 'codeBlock': {
        const lang = block.lang ? ` class="language-${escapeHtml(block.lang.replace(/[^a-zA-Z0-9_+-]/g, ''))}"` : '';
        return `<pre><code${lang}>${escapeHtml(block.text)}</code></pre>`;
      }
      case 'hr': return '<hr />';
      case 'table': {
        const header = block.header.map((cell) => `<th scope="col">${renderInline(parseInline(cell), assetUrl)}</th>`).join('');
        const body = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(parseInline(cell), assetUrl)}</td>`).join('')}</tr>`).join('');
        return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
      }
      case 'raw': return `<p class="bodyRaw">${escapeHtml(block.text).replace(/\n/g, '<br />')}</p>`;
    }
  }).join('');
}

/* -------------------------------------------------- 旧纯文本升级 */

/** 行首块级字符标记：升级时必须转义，避免旧文本被解释为标题/列表/引用/setext 标题。 */
const LINE_START_CHAR = /^(\s*)([#>|+\-*=])/;
/** 有序列表行首：转义序号后的 . 或 )，避免旧文本变成列表。 */
const LINE_START_DIGIT = /^(\s*)(\d{1,9})([.)])/;

/**
 * 把旧 plaintext 转义成 markdown_v1 源文本（PRD 7.1、技术设计 3.3、AT-28）。
 * 转义只发生在可能引起解析歧义的位置，普通文字保持原样：
 * - 行内特殊字符 \ ` * _ ~ [ ] 一律加反斜杠；
 * - 行首 # > | + - * 加反斜杠；行首序号只转义其后的 . 或 )；
 * - 围栏由反引号转义覆盖，因此不会在升级时变成代码块。
 */
export function escapePlaintextToMarkdown(plain: string): string {
  return normalizeBody(plain)
    .split('\n')
    .map((line) => {
      let escaped = line.replace(/([\\`*_~[\]])/g, '\\$1');
      const digit = LINE_START_DIGIT.exec(escaped);
      if (digit) {
        const prefix = digit[1] + digit[2];
        escaped = `${prefix}\\${escaped.slice(prefix.length)}`;
      }
      const marker = LINE_START_CHAR.exec(escaped);
      if (marker) escaped = `${marker[1]}\\${escaped.slice(marker[1].length)}`;
      return escaped;
    })
    .join('\n');
}

/** 保存正文时服务端使用的共享入口：返回规范化源文本、派生纯文本与兼容提示。 */
export type PreparedBody = {
  description: string;
  descriptionFormat: DescriptionFormat;
  descriptionPlain: string;
  hasUnsupportedSyntax: boolean;
  hasTaskListSyntax: boolean;
};

export function prepareBody(input: { description: string; format: DescriptionFormat; convertFromPlaintext?: boolean }): PreparedBody {
  const raw = normalizeBody(input.description);
  const normalized = input.format === 'markdown_v1' && input.convertFromPlaintext && raw !== '' ? escapePlaintextToMarkdown(raw) : raw;
  const parsed = parseBody(normalized);
  return {
    description: normalized,
    descriptionFormat: input.format,
    descriptionPlain: input.format === 'markdown_v1' ? bodyToPlainText(normalized) : normalized,
    hasUnsupportedSyntax: input.format === 'markdown_v1' ? parsed.hasUnsupportedSyntax : false,
    hasTaskListSyntax: input.format === 'markdown_v1' ? parsed.hasTaskListSyntax : false,
  };
}
