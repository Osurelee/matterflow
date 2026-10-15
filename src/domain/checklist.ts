/**
 * M4-04 结构化小步骤契约（PRD 9.3、7.1；FR-22；AT-37）。
 *
 * 规则：
 * - 小步骤只有文本、勾选与排序，**没有**独立日期、状态或处理方；不进入今天/搜索等
 *   任务结果，也不计入任务完成数（PRD 9.4）。
 * - 每个事项最多 100 条，每条 1–500 码点，条目有独立 ID 与 version。
 * - 勾选不改变父事项状态；未勾完也可以完成事项，但必须提示并确认（放弃小步骤，
 *   不自动批量勾完）。
 * - 正文里的 `- [ ]` / `- [x]` 只是静态文本：导入时由用户选择「转为小步骤」或
 *   「保留静态文本」，不产生第二套可互动的完成状态（PRD 7.1）。
 *
 * 本模块不依赖数据库与框架，服务端、客户端与测试共用。
 */
export const CHECKLIST_MAX_ITEMS = 100;
export const CHECKLIST_TEXT_MAX_CODE_POINTS = 500;
/** 排序键为定宽零填充字符串，字典序即顺序；重排时整表重算（≤100 条）。 */
export const CHECKLIST_SORT_KEY_WIDTH = 4;

export function codePointLengthOf(value: string): number {
  return [...value].length;
}

export type ChecklistCounts = { total: number; checked: number; unchecked: number };

export function validateChecklistText(value: unknown): { ok: true; text: string } | { ok: false; reason: 'NOT_TEXT' | 'EMPTY' | 'TOO_LONG' } {
  if (typeof value !== 'string') return { ok: false, reason: 'NOT_TEXT' };
  const text = value.trim();
  if (!text) return { ok: false, reason: 'EMPTY' };
  if (codePointLengthOf(text) > CHECKLIST_TEXT_MAX_CODE_POINTS) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, text };
}

export function sortKeyForIndex(index: number): string {
  return String(index).padStart(CHECKLIST_SORT_KEY_WIDTH, '0');
}

export function normalizeSortKeys(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => sortKeyForIndex(index));
}

/** 上/下移动一位；越界或未知条目返回原顺序（不抛错，便于菜单与键盘等价动作）。 */
export function moveId(ids: string[], itemId: string, direction: 'up' | 'down'): string[] {
  const index = ids.indexOf(itemId);
  if (index < 0) return [...ids];
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function checklistCounts(items: Array<{ isChecked: boolean }>): ChecklistCounts {
  const checked = items.filter((item) => item.isChecked).length;
  return { total: items.length, checked, unchecked: items.length - checked };
}

/** 未勾完就完成事项时的确认文案；返回 null 表示无需确认。 */
export function uncheckedCompletionWarning(uncheckedCount: number): string | null {
  if (uncheckedCount <= 0) return null;
  return `还有 ${uncheckedCount} 项小步骤没有勾选。完成事项不会自动勾选它们（表示放弃这些步骤），确定完成吗？`;
}

/** 本地最小规范化（CRLF→LF、去掉首尾空行），与正文模块的规范化语义一致；本模块保持零依赖。 */
function normalizeLines(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

const STATIC_CHECKBOX = /^-\s+\[([ xX])\]\s*(.*)$/;

/** 正文中的静态复选框行（含原文行，便于精确移除）。 */
export function staticChecklistLines(source: string): Array<{ checked: boolean; text: string; line: string }> {
  return normalizeLines(source)
    .split('\n')
    .map((line) => {
      const match = STATIC_CHECKBOX.exec(line);
      if (!match) return null;
      const text = match[2].trim();
      if (!text) return null;
      return { checked: match[1].toLowerCase() === 'x', text, line };
    })
    .filter((entry): entry is { checked: boolean; text: string; line: string } => entry !== null);
}

/**
 * 从正文中移除给定的静态复选框行（每行只移除首次出现），并折叠因此产生的连续空行。
 * 用于「转为小步骤」：先建小步骤、再清理正文，任何一步失败都不会丢文字。
 */
export function stripStaticChecklistLines(source: string, lines: string[]): string {
  const remove = new Set(lines);
  const kept: string[] = [];
  const used = new Set<string>();
  for (const line of normalizeLines(source).split('\n')) {
    if (remove.has(line) && !used.has(line)) { used.add(line); continue; }
    kept.push(line);
  }
  const collapsed: string[] = [];
  for (const line of kept) {
    const isBlank = line.trim() === '';
    if (isBlank && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(line);
  }
  return normalizeLines(collapsed.join('\n'));
}

export type ChecklistItemDto = {
  id: string;
  text: string;
  isChecked: boolean;
  sortKey: string;
  version: number;
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};
