'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { parseBody, renderSafeHtml } from '@/domain/body';
import { apiUrl } from '@/shared/api';
import styles from './CaptureComposer.module.css';

/** 底部工具栏动作（在页面捕获区内触发附件/录音/更多菜单）。 */
type PickKind = 'image' | 'file';

type SlashInsert = { text: string; cursor: number };

type SlashItem = {
  key: string;
  label: string;
  hint: string;
  group: '格式' | '列表' | '插入';
  snippet: () => SlashInsert | null;
  pick?: PickKind;
};

type FloatingState = { left: number; top: number } | null;
type SlashState = { query: string; left: number; top: number } | null;

export type CaptureComposerHandle = {
  focus: () => void;
  /** 在光标处插入一段 Markdown 源文本（来源链接等），未聚焦时追加并聚焦。 */
  insertMarkdown: (md: string) => void;
};

type Props = {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  onComposingChange?: (composing: boolean) => void;
  /** 粘贴/拖拽文件时交给父级走真实上传；图片最终以缩略图 Chip 展示。 */
  onAttachFiles?: (files: File[]) => void;
  onPickMedia?: (kind: PickKind) => void;
  onRecord?: () => void;
  onBatch?: () => void;
  placeholder?: string;
  /** 仅控制底部提交按钮的可用态；保存期间仍可继续输入。 */
  submitDisabled?: boolean;
  hint?: string;
};

const assetUrl = (assetId: string) => apiUrl(`/api/assets/${assetId}/content`);

/** 正文里是否存在超出“普通段落文字”的 Markdown 结构；有则展示所见即所得预览。 */
function hasMarkdownFormatting(md: string): boolean {
  const trimmed = md.trim();
  if (!trimmed) return false;
  const { blocks } = parseBody(trimmed);
  if (blocks.some((block) => block.type !== 'paragraph')) return true;
  return /!?\[[^\]]*\]\([^)]*\)|(\*\*|__|~~|`)/.test(trimmed);
}

function promptLink(): SlashInsert | null {
  const url = window.prompt('链接地址（仅保存 http/https）', 'https://');
  if (!url) return null;
  const clean = url.trim().replace(/[()\s]/g, '');
  if (!clean) return null;
  const label = window.prompt('链接文字', '链接')?.trim() || clean;
  return { text: `[${label}](${clean})`, cursor: 1 };
}

/* 统一的线性 SVG 图标（currentColor 描边，随按钮悬停变色）。 */
function SvgIcon({ size = 16, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const IconImage = () => <SvgIcon><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></SvgIcon>;
const IconPaperclip = () => <SvgIcon><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></SvgIcon>;
const IconMic = () => <SvgIcon><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 11a7 7 0 0 1-14 0" /><path d="M12 18v4" /></SvgIcon>;
const IconList = () => <SvgIcon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></SvgIcon>;
const IconSend = () => <SvgIcon><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7Z" /></SvgIcon>;
const IconLink = () => <SvgIcon><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></SvgIcon>;
const IconEye = () => <SvgIcon><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="2.6" /></SvgIcon>;

/** 翻转 Markdown 源文本里第 index 个待办项的勾选状态（支持 `- [ ]` 与裸 `[ ]`/`[]`/`[x]`）。 */
function toggleTaskAt(md: string, index: number): string {
  const TASK = /^(\s*)([-*+]\s+)?(\[[ xX]?\])(\s+.*)?$/;
  let seen = 0;
  return md.split('\n').map((line) => {
    const match = TASK.exec(line);
    if (!match) return line;
    if (seen === index) {
      seen += 1;
      const inner = match[3].slice(1, -1);
      const next = inner === 'x' || inner === 'X' ? ' ' : 'x';
      return `${match[1]}${match[2] ?? ''}[${next}]${match[4] ?? ''}`;
    }
    seen += 1;
    return line;
  }).join('\n');
}

const CaptureComposer = forwardRef<CaptureComposerHandle, Props>(function CaptureComposer(
  { value, onChange, onSubmit, onComposingChange, onAttachFiles, onPickMedia, onRecord, onBatch, placeholder, submitDisabled = false, hint }: Props,
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onComposingChangeRef = useRef(onComposingChange);
  const onAttachFilesRef = useRef(onAttachFiles);
  const onPickMediaRef = useRef(onPickMedia);
  const onRecordRef = useRef(onRecord);
  const onBatchRef = useRef(onBatch);

  const [floating, setFloating] = useState<FloatingState>(null);
  const [slash, setSlash] = useState<SlashState>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  useEffect(() => { onChangeRef.current = onChange; });
  useEffect(() => { onSubmitRef.current = onSubmit; });
  useEffect(() => { onComposingChangeRef.current = onComposingChange; });
  useEffect(() => { onAttachFilesRef.current = onAttachFiles; });
  useEffect(() => { onPickMediaRef.current = onPickMedia; });
  useEffect(() => { onRecordRef.current = onRecord; });
  useEffect(() => { onBatchRef.current = onBatch; });

  // 高度自适应：默认 ~52px（单行起，聚焦书写时自然撑高），内容增长至 280px 上限后滚动。
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 280)}px`;
  }, [value]);

  function detectSlash(next: string) {
    const el = taRef.current;
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!el || !wrap || composingRef.current) { setSlash(null); return; }
    const before = next.slice(0, el.selectionStart);
    const match = /(^|\s)\/([a-z0-9]*)$/i.exec(before);
    if (!match) { setSlash(null); return; }
    const caret = el.getBoundingClientRect();
    const left = Math.min(Math.max(caret.left - wrap.left, 8), wrap.width - 250);
    const top = Math.min(el.selectionStart === 0 ? caret.bottom - wrap.top + 6 : caret.bottom - wrap.top + 6, wrap.height - 140);
    setSlash({ query: match[2].toLowerCase(), left, top });
  }

  function updateFloating(event?: React.MouseEvent<HTMLTextAreaElement>) {
    const el = taRef.current;
    const wrap = wrapRef.current?.getBoundingClientRect();
    if (!el || !wrap) { setFloating(null); return; }
    if (el.selectionStart === el.selectionEnd) { setFloating(null); return; }
    if (event && event.type === 'mouseup') {
      setFloating({
        left: Math.min(Math.max(event.clientX - wrap.left, 8), wrap.width - 320),
        top: Math.max(event.clientY - wrap.top - 44, 8),
      });
      return;
    }
    const caret = el.getBoundingClientRect();
    setFloating({ left: Math.min(Math.max(caret.left - wrap.left, 8), wrap.width - 320), top: Math.max(caret.top - wrap.top - 44, 8) });
  }

  function applySlashItem(item: SlashItem) {
    const el = taRef.current;
    if (item.pick) { onPickMediaRef.current?.(item.pick); setSlash(null); return; }
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = value.slice(0, start);
    const match = /(^|\s)\/([a-z0-9]*)$/i.exec(before);
    const tokenStart = match ? match.index + match[1].length : start;
    const head = value.slice(0, tokenStart);
    const tail = value.slice(end);
    const snippet = item.snippet();
    if (!snippet) { setSlash(null); return; }
    const next = head + snippet.text + tail;
    const cursor = tokenStart + snippet.cursor;
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(cursor, cursor); });
    setSlash(null);
  }

  function wrapSelection(prefix: string, suffix: string, placeholderText: string) {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || placeholderText;
    const next = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + prefix.length, start + prefix.length + selected.length); });
    setFloating(null);
  }

  function prefixSelection(prefix: string) {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEndIndex = value.indexOf('\n', end);
    const actualEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const next = `${value.slice(0, lineStart)}${prefix}${value.slice(lineStart, actualEnd)}${value.slice(actualEnd)}`;
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(lineStart + prefix.length, actualEnd + prefix.length); });
    setFloating(null);
  }

  function linkAroundSelection() {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end).trim();
    const url = window.prompt('链接地址（仅保存 http/https）', 'https://');
    if (!url) return;
    const clean = url.trim().replace(/[()\s]/g, '');
    if (!clean) return;
    const label = selected || (window.prompt('链接文字', '链接')?.trim() || clean);
    const next = `${value.slice(0, start)}[${label}](${clean})${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + 1, start + 1 + label.length); });
    setFloating(null);
  }

  /** 来源链接：不弹窗，直接在光标处插入链接骨架，光标停在 url 处由用户输入/粘贴。 */
  function insertSourceLink() {
    const el = taRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end).trim();
    const label = selected || '来源';
    const prefix = `[${label}](`;
    const next = `${value.slice(0, start)}${prefix})${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { el.focus(); const cursor = start + prefix.length; el.setSelectionRange(cursor, cursor); });
  }

  function onPreviewClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type !== 'checkbox') return;
    event.preventDefault();
    const preview = previewRef.current;
    if (!preview) return;
    const boxes = Array.from(preview.querySelectorAll('li.bodyTaskItem input[type="checkbox"]'));
    const index = boxes.indexOf(target as HTMLInputElement);
    if (index === -1) return;
    const next = toggleTaskAt(value, index);
    onChange(next);
  }

  const slashItems: SlashItem[] = [
    { key: 'h1', label: '标题 1', hint: '#', group: '格式', snippet: () => ({ text: '# ', cursor: 2 }) },
    { key: 'h2', label: '标题 2', hint: '##', group: '格式', snippet: () => ({ text: '## ', cursor: 3 }) },
    { key: 'h3', label: '标题 3', hint: '###', group: '格式', snippet: () => ({ text: '### ', cursor: 4 }) },
    { key: 'bold', label: '粗体', hint: '**文字**', group: '格式', snippet: () => ({ text: '****', cursor: 2 }) },
    { key: 'italic', label: '斜体', hint: '*文字*', group: '格式', snippet: () => ({ text: '**', cursor: 1 }) },
    { key: 'strike', label: '删除线', hint: '~~文字~~', group: '格式', snippet: () => ({ text: '~~~~', cursor: 2 }) },
    { key: 'code', label: '行内代码', hint: '`code`', group: '格式', snippet: () => ({ text: '``', cursor: 1 }) },
    { key: 'quote', label: '引用', hint: '> 引用', group: '列表', snippet: () => ({ text: '> ', cursor: 2 }) },
    { key: 'ul', label: '无序列表', hint: '- 列表', group: '列表', snippet: () => ({ text: '- ', cursor: 2 }) },
    { key: 'ol', label: '有序列表', hint: '1. 列表', group: '列表', snippet: () => ({ text: '1. ', cursor: 3 }) },
    { key: 'task', label: '待办', hint: '- [ ] 任务', group: '列表', snippet: () => ({ text: '- [ ] ', cursor: 6 }) },
    { key: 'codeblock', label: '代码块', hint: '``` 代码', group: '插入', snippet: () => ({ text: '```\n\n```', cursor: 4 }) },
    { key: 'table', label: '表格', hint: '2×2', group: '插入', snippet: () => ({ text: '| 列1 | 列2 |\n| --- | --- |\n|  |  |', cursor: 30 }) },
    { key: 'hr', label: '分割线', hint: '---', group: '插入', snippet: () => ({ text: '---\n', cursor: 4 }) },
    { key: 'link', label: '链接', hint: '[文字](url)', group: '插入', snippet: promptLink },
    { key: 'image', label: '图片', hint: '粘贴图片或从本机选择', group: '插入', snippet: () => ({ text: '', cursor: 0 }), pick: 'image' },
  ];

  const visibleSlash = slash ? slashItems.filter((item) =>
    item.key.includes(slash.query) || item.label.toLowerCase().includes(slash.query) || item.hint.toLowerCase().includes(slash.query),
  ) : [];

  useEffect(() => { setSlashIndex(0); }, [slash?.query]);

  const floatingActions: Array<{ label?: string; icon?: React.ReactNode; title: string; run: () => void }> = [
    { label: 'B', title: '粗体', run: () => wrapSelection('**', '**', '粗体') },
    { label: 'I', title: '斜体', run: () => wrapSelection('*', '*', '斜体') },
    { label: 'S', title: '删除线', run: () => wrapSelection('~~', '~~', '删除线') },
    { label: 'H1', title: '一级标题', run: () => prefixSelection('# ') },
    { label: 'H2', title: '二级标题', run: () => prefixSelection('## ') },
    { label: 'H3', title: '三级标题', run: () => prefixSelection('### ') },
    { label: '•', title: '无序列表', run: () => prefixSelection('- ') },
    { label: '❝', title: '引用', run: () => prefixSelection('> ') },
    { label: '`', title: '行内代码', run: () => wrapSelection('`', '`', '代码') },
    { icon: <IconLink />, title: '链接', run: linkAroundSelection },
  ];

  function focusEditor() {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const length = value.length;
    el.setSelectionRange(length, length);
  }

  useImperativeHandle(ref, () => ({
    focus: focusEditor,
    insertMarkdown(md) {
      const el = taRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const prefix = value.slice(0, start);
      const needsBreak = prefix.trim() !== '' && !prefix.endsWith('\n');
      const next = `${prefix}${needsBreak ? '\n\n' : ''}${md}${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => { el.focus(); const cursor = start + (needsBreak ? 2 : 0) + md.length; el.setSelectionRange(cursor, cursor); });
    },
  }), [value, onChange]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || composingRef.current;
    if (event.key === 'Escape') {
      if (slash || floating) { event.preventDefault(); event.stopPropagation(); setSlash(null); setFloating(null); return; }
      return;
    }
    if (composing) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSubmitRef.current?.();
      return;
    }
    if (slash && visibleSlash.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex((i) => Math.min(i + 1, visibleSlash.length - 1)); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((i) => Math.max(i - 1, 0)); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applySlashItem(visibleSlash[slashIndex]); return; }
    }
  }

  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    const next = el.value;
    onChange(next);
    if (composingRef.current) return;
    detectSlash(next);
    updateFloating();
  }

  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) { event.preventDefault(); onAttachFilesRef.current?.(files); return; }
    // 文本默认粘贴为 Markdown 源；预览即时渲染。
  }

  function onDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) { onAttachFilesRef.current?.(files); return; }
    const text = event.dataTransfer?.getData('text/plain');
    if (text != null) {
      const el = taRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
    }
  }

  const showPreview = hasMarkdownFormatting(value);
  const grouped = slash ? (['格式', '列表', '插入'] as const).map((group) => ({ group, items: visibleSlash.filter((item) => item.group === group) })).filter((entry) => entry.items.length) : [];

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <textarea
        ref={taRef}
        className={styles.input}
        value={value}
        placeholder={placeholder ?? '记下你现在想到的事…（⌘/Ctrl+Enter 保存，/ 打开功能菜单）'}
        aria-label="新增事项内容"
        maxLength={20000}
        spellCheck={false}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onSelect={() => { if (!composingRef.current) updateFloating(); }}
        onMouseUp={(event) => { if (!composingRef.current) updateFloating(event); }}
        onKeyUp={() => { if (!composingRef.current) { detectSlash(value); updateFloating(); } }}
        onClick={() => { if (!composingRef.current) { detectSlash(value); } }}
        onBlur={() => { composingRef.current = false; setSlash(null); setFloating(null); onComposingChangeRef.current?.(false); }}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onCompositionStart={() => { composingRef.current = true; setSlash(null); setFloating(null); onComposingChangeRef.current?.(true); }}
        onCompositionEnd={() => { composingRef.current = false; onComposingChangeRef.current?.(false); }}
      />

      {showPreview && (
        <div className={styles.preview} aria-label="Markdown 预览" ref={previewRef} onClick={onPreviewClick}>
          <div className={styles.previewLabel}><IconEye /> 预览</div>
          <div className={styles.previewInner} dangerouslySetInnerHTML={{ __html: renderSafeHtml(value, assetUrl) }} />
        </div>
      )}

      {floating && (
        <div className={styles.floating} style={{ left: floating.left, top: floating.top }} role="toolbar" aria-label="选中文字格式">
          {floatingActions.map((action) => (
            <button
              key={action.title}
              type="button"
              title={action.title}
              aria-label={action.title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={action.run}
            >{action.icon ?? action.label}</button>
          ))}
        </div>
      )}

      {slash && grouped.length > 0 && (
        <div className={styles.slash} style={{ left: slash.left, top: slash.top }} role="menu" aria-label="功能菜单">
          {grouped.map((entry) => (
            <div key={entry.group}>
              <div className={styles.slashGroup}>{entry.group}</div>
              {entry.items.map((item) => {
                const index = visibleSlash.indexOf(item);
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className={`${styles.slashItem} ${index === slashIndex ? styles.slashItemActive : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySlashItem(item)}
                  >
                    <span>{item.label}</span>
                    <small>{item.hint}</small>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button type="button" className={styles.iconButton} title="添加图片" aria-label="添加图片" onClick={() => onPickMediaRef.current?.('image')}><IconImage /></button>
          <button type="button" className={styles.iconButton} title="添加附件" aria-label="添加附件" onClick={() => onPickMediaRef.current?.('file')}><IconPaperclip /></button>
          <button type="button" className={styles.iconButton} title="录音" aria-label="录音" onClick={() => onRecordRef.current?.()}><IconMic /></button>
          <button type="button" className={styles.iconButton} title="批量新建" aria-label="批量新建" onClick={() => onBatchRef.current?.()}><IconList /></button>
          <button type="button" className={styles.iconButton} title="来源链接" aria-label="来源链接" onClick={insertSourceLink}><IconLink /></button>
        </div>
        <div className={styles.toolbarRight}>
          {hint && <span className={styles.hint}>{hint}</span>}
          <button type="button" className={styles.submitButton} title="保存（⌘/Ctrl+Enter）" aria-label="保存" disabled={submitDisabled} onClick={() => onSubmitRef.current?.()}><IconSend /></button>
        </div>
      </div>
    </div>
  );
});

export default CaptureComposer;
