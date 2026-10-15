'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/shared/api';
import styles from './ChecklistPromotionPanel.module.css';

type PromotionItem = { id: string; text: string; isChecked: boolean; version: number; promotedTaskId: string | null };
type PromotionPreview = { expectedVersion: number; expectedStructureVersion: number; items: PromotionItem[]; pendingCount: number; alreadyPromotedCount: number };
type Envelope<T> = { data: T; error?: { message?: string } };

export default function ChecklistPromotionPanel({ taskId, expectedVersion, expectedStructureVersion, onOpen, onStructureVersionChange }: { taskId: string; expectedVersion: number; expectedStructureVersion: number; onOpen: (id: string) => void; onStructureVersionChange: (version: number) => void }) {
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function loadPreview() {
    setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/checklist/promote`); const body = await response.json() as Envelope<PromotionPreview>;
      if (!response.ok) throw new Error(body.error?.message ?? '提升预览失败'); setPreview(body.data); setOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提升预览失败'); }
  }

  useEffect(() => { setPreview(null); setOpen(false); setError(''); }, [taskId]);

  async function confirmPromotion() {
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/checklist/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion, expectedStructureVersion }) });
      const body = await response.json() as Envelope<PromotionPreview & { created?: Array<{ taskId: string }>; structureVersion?: number }>;
      if (!response.ok) throw new Error(body.error?.message ?? '提升失败');
      onStructureVersionChange(body.data.structureVersion ?? expectedStructureVersion + (body.data.created?.length ? 1 : 0)); setPreview(null); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提升失败'); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-label="小步骤提升"><div className={styles.top}><div><strong>提升为独立事项</strong><span>保留原清单关联，不重复创建</span></div><button type="button" onClick={() => void loadPreview()} disabled={busy}>{open ? '重新预览' : '预览提升'}</button></div>{open && preview && <div className={styles.preview}><p>将创建 {preview.pendingCount} 个直接子事项；已提升 {preview.alreadyPromotedCount} 个。勾选项会创建为已完成事项，未勾选项创建为待处理事项。</p><ul>{preview.items.map((item) => <li key={item.id}><span>{item.text}</span><em>{item.promotedTaskId ? '已关联' : item.isChecked ? '已完成' : '待处理'}</em>{item.promotedTaskId && <button type="button" onClick={() => onOpen(item.promotedTaskId!)}>打开事项</button>}</li>)}</ul><button type="button" className={styles.confirm} onClick={() => void confirmPromotion()} disabled={busy || preview.pendingCount === 0}>{busy ? '提升中…' : preview.pendingCount === 0 ? '已全部提升' : '确认原子提升'}</button></div>}{error && <p className={styles.error} role="alert">{error}<button type="button" onClick={() => void loadPreview()}>重试</button></p>}</section>;
}
