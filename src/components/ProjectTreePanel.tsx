'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/shared/api';
import styles from './ProjectTreePanel.module.css';

type Envelope<T> = { data: T };
type TreeItem = { id: string; title: string; status: string; parentId: string | null; sectionId: string | null; hasChildren: boolean; nestedProjectId: string | null; structureVersion: number };
type Progress = { active: number; completed: number; cancelled: number; needsReview: number; leafTotal: number; completionPercent: number | null };
type TreeResponse = { rootTaskId: string | null; parentId: string | null; items: TreeItem[]; progress: Progress };

const statusNames: Record<string, string> = { todo: '待处理', in_progress: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };

export default function ProjectTreePanel({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const [rootTaskId, setRootTaskId] = useState<string | null>(null);
  const [items, setItems] = useState<TreeItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, TreeItem[]>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState('项目目标');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (parentId: string | null, initial = false): Promise<TreeItem[]> => {
    setBusy(parentId ?? 'root'); setError('');
    try {
      const response = await apiFetch(`/api/projects/${projectId}/tree${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`);
      if (!response.ok) throw new Error('项目树读取失败');
      const body = await response.json() as Envelope<TreeResponse>;
      setRootTaskId(body.data.rootTaskId); setProgress(body.data.progress);
      if (parentId) setChildren((current) => ({ ...current, [parentId]: body.data.items })); else setItems(body.data.items);
      if (initial && body.data.rootTaskId) setFocusTitle('项目目标');
      return body.data.items;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '项目树读取失败'); }
    finally { setBusy(''); setLoading(false); }
    return [];
  }, [projectId]);

  useEffect(() => { setFocusId(null); setChildren({}); void load(null, true); }, [load]);

  async function toggle(item: TreeItem) {
    if (!item.hasChildren) return;
    if (expanded.has(item.id)) { setExpanded((current) => { const next = new Set(current); next.delete(item.id); return next; }); return; }
    if (!children[item.id]) await load(item.id);
    setExpanded((current) => new Set(current).add(item.id));
  }

  const visibleItems = useMemo(() => {
    const flatten = (rows: TreeItem[], depth: number): Array<{ item: TreeItem; depth: number }> => rows.flatMap((item) => [{ item, depth }, ...(expanded.has(item.id) ? flatten(children[item.id] ?? [], depth + 1) : [])]);
    return flatten(items, 0);
  }, [children, expanded, items]);

  async function focus(item: TreeItem) {
    setFocusId(item.id); setFocusTitle(item.title); setExpanded(new Set());
    const nextItems = children[item.id] ?? await load(item.id);
    setItems(nextItems);
  }

  function resetFocus() {
    setFocusId(null); setFocusTitle('项目目标'); setExpanded(new Set()); void load(null);
  }

  return <section className={styles.panel} aria-label="项目主树">
    <header className={styles.header}><div><strong>项目主树</strong><span>{focusTitle}</span></div><button type="button" onClick={resetFocus} disabled={!focusId || Boolean(busy)}>回到项目目标</button></header>
    {progress && <div className={styles.progress} aria-label="项目进度"><div className={styles.progressTop}><strong>{progress.completionPercent === null ? '尚未拆解' : `${progress.completionPercent}% 已完成`}</strong><span>叶子 {progress.leafTotal} · 活跃 {progress.active} · 完成 {progress.completed} · 取消 {progress.cancelled}</span></div><div className={styles.track}><span style={{ width: `${progress.completionPercent ?? 0}%` }}/></div>{progress.needsReview > 0 && <p>待核实成果：{progress.needsReview} 项（后代已结束，但事项本身仍活跃）</p>}</div>}
    {loading ? <p className={styles.empty}>正在读取项目树…</p> : visibleItems.length === 0 ? <p className={styles.empty}>当前层级还没有主子项</p> : <ul className={styles.list}>{visibleItems.map(({ item, depth }) => <li key={item.id} style={{ paddingLeft: `${depth * 18}px` }}><button type="button" className={styles.expand} onClick={() => void toggle(item)} disabled={!item.hasChildren || busy === item.id} aria-label={item.hasChildren ? (expanded.has(item.id) ? `收起 ${item.title}` : `展开 ${item.title}`) : undefined}>{item.hasChildren ? (expanded.has(item.id) ? '⌄' : '›') : '·'}</button><button type="button" className={styles.title} onClick={() => onOpen(item.id)}>{item.title}</button><span className={`${styles.status} ${styles[`status_${item.status}`] ?? ''}`}>{statusNames[item.status] ?? item.status}</span>{item.nestedProjectId && <span className={styles.nested}>嵌套项目</span>}<button type="button" className={styles.focus} onClick={() => void focus(item)}>聚焦</button></li>)}</ul>}
    {error && <p className={styles.error} role="status">{error}<button type="button" onClick={() => void load(focusId)}>重试</button></p>}
    {rootTaskId && <p className={styles.hint}>树按层级按需加载；“聚焦”后只查看该事项下的主子树，引用不会进入项目进度。</p>}
  </section>;
}
