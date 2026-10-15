'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { apiUrl } from '@/shared/api';
import { renderSafeHtml } from '@/domain/body';
import { editableHtmlToMarkdown } from '@/shared/dom-to-markdown';
import styles from './RichBodyEditor.module.css';

type EditorMode = 'visual' | 'source' | 'preview';

export type RichBodyEditorHandle = { insertAsset: (assetId:string, alt:string) => void };

type Props = {
  value: string;
  mode: EditorMode;
  disabled?: boolean;
  onChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onConvert?: () => void;
  isLegacyPlaintext?: boolean;
  /** UX-02：输入法组合期间为 true；父级据此暂停自动保存，不提交组合中的半成品（PRD 4.2）。 */
  onComposingChange?: (composing: boolean) => void;
};

function exec(command: string, value?: string) {
  document.execCommand(command, false, value);
}

const RichBodyEditor = forwardRef<RichBodyEditorHandle, Props>(function RichBodyEditor({ value, mode, disabled = false, onChange, onModeChange, onConvert, isLegacyPlaintext = false, onComposingChange }: Props, ref) {
  const visualRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const lastValue = useRef(value);
  const focused = useRef(false);

  useEffect(() => {
    if (mode === 'visual' && visualRef.current && !focused.current && lastValue.current !== value) {
      visualRef.current.innerHTML = renderSafeHtml(value, (id)=>apiUrl(`/api/assets/${id}/content`));
      lastValue.current = value;
    }
  }, [mode, value]);

  useImperativeHandle(ref, () => ({
    insertAsset(assetId, alt) {
      const safeAlt = alt.replace(/[\[\]]/g,'');
      const token = `![${safeAlt}](asset:${assetId})`;
      if (mode === 'source' && sourceRef.current) {
        const input=sourceRef.current; const start=input.selectionStart; const end=input.selectionEnd;
        const next=`${value.slice(0,start)}${token}${value.slice(end)}`; onChange(next);
        requestAnimationFrame(()=>{input.focus();const cursor=start+token.length;input.setSelectionRange(cursor,cursor)}); return;
      }
      if (mode === 'visual' && visualRef.current) {
        const root=visualRef.current; root.focus();
        const image=document.createElement('img'); image.src=apiUrl(`/api/assets/${assetId}/content`); image.alt=alt; image.dataset.assetId=assetId; image.className='bodyAssetImage';
        const selection=window.getSelection(); let range:Range|undefined;
        if(selection&&selection.rangeCount&&root.contains(selection.anchorNode))range=selection.getRangeAt(0);
        else {range=document.createRange();range.selectNodeContents(root);range.collapse(false)}
        range.deleteContents();range.insertNode(image);range.setStartAfter(image);range.collapse(true);selection?.removeAllRanges();selection?.addRange(range);emit();return;
      }
      onChange(`${value}${value?'\n\n':''}${token}`);onModeChange('source');
    }
  }),[mode,value,onChange,onModeChange]);

  function emit() {
    if (!visualRef.current) return;
    const next = editableHtmlToMarkdown(visualRef.current);
    lastValue.current = next;
    onChange(next);
  }

  function command(commandName: string, commandValue?: string) {
    visualRef.current?.focus();
    exec(commandName, commandValue);
    emit();
  }

  function link() {
    const href = window.prompt('链接地址（仅保存 http/https/mailto）', 'https://');
    if (!href) return;
    command('createLink', href);
  }

  if (isLegacyPlaintext) {
    return <div className={styles.legacyWrap}>
      <p className={styles.legacyHint}>这是旧纯文本正文。需要格式化编辑时先显式转换，原有 `*`、`#` 等文字不会被误解释。</p>
      <button type="button" className={styles.convertButton} onClick={onConvert} disabled={disabled}>转换为 Markdown 正文</button>
    </div>;
  }

  return <div className={styles.editor}>
    <div className={styles.modeBar} role="tablist" aria-label="正文编辑模式">
      <button type="button" role="tab" aria-selected={mode === 'visual'} className={mode === 'visual' ? styles.active : ''} onClick={() => onModeChange('visual')}>可视编辑</button>
      <button type="button" role="tab" aria-selected={mode === 'source'} className={mode === 'source' ? styles.active : ''} onClick={() => onModeChange('source')}>Markdown 源</button>
      <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? styles.active : ''} onClick={() => onModeChange('preview')}>预览</button>
    </div>
    {mode === 'visual' && <>
      <div className={styles.toolbar} role="toolbar" aria-label="可视正文工具栏">
        <button type="button" onClick={() => command('bold')} disabled={disabled} title="粗体">B</button>
        <button type="button" onClick={() => command('italic')} disabled={disabled} title="斜体"><i>I</i></button>
        <button type="button" onClick={() => command('strikeThrough')} disabled={disabled} title="删除线"><s>S</s></button>
        <button type="button" onClick={() => command('formatBlock', 'H1')} disabled={disabled} title="一级标题">H1</button>
        <button type="button" onClick={() => command('formatBlock', 'H2')} disabled={disabled} title="二级标题">H2</button>
        <button type="button" onClick={() => command('formatBlock', 'H3')} disabled={disabled} title="三级标题">H3</button>
        <button type="button" onClick={() => command('insertUnorderedList')} disabled={disabled} title="无序列表">• 列表</button>
        <button type="button" onClick={() => command('insertOrderedList')} disabled={disabled} title="有序列表">1. 列表</button>
        <button type="button" onClick={() => command('formatBlock', 'BLOCKQUOTE')} disabled={disabled} title="引用">❝</button>
        <button type="button" onClick={() => command('formatBlock', 'PRE')} disabled={disabled} title="代码块">代码</button>
        <button type="button" onClick={link} disabled={disabled} title="链接">链接</button>
      </div>
      <div
        ref={(node) => { visualRef.current = node; if (node && !focused.current && (!node.innerHTML || lastValue.current !== value)) { node.innerHTML = renderSafeHtml(value, (id)=>apiUrl(`/api/assets/${id}/content`)); lastValue.current = value; } }}
        className={styles.visualInput}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label="正文内容说明（可视编辑）"
        data-placeholder="补充背景、要求、参考或交付标准…"
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; }}
        onInput={emit}
        onCompositionStart={() => onComposingChange?.(true)}
        onCompositionEnd={() => onComposingChange?.(false)}
      />
    </>}
    {mode === 'source' && <textarea ref={sourceRef} className={styles.sourceInput} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label="正文内容说明（Markdown 源）" placeholder="补充背景、要求、参考或交付标准…" onCompositionStart={() => onComposingChange?.(true)} onCompositionEnd={() => onComposingChange?.(false)} />}
    {mode === 'preview' && <div className={styles.preview} dangerouslySetInnerHTML={{ __html: renderSafeHtml(value, (id)=>apiUrl(`/api/assets/${id}/content`)) }} />}
  </div>;
});

export default RichBodyEditor;
