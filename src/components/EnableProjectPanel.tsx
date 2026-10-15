'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/shared/api';
import styles from './EnableProjectPanel.module.css';

type ProjectSummary = { id: string; name: string; rootTaskId: string | null; status: string; targetDate: string | null; successCriteria: string };
type EnablePreview = { task: { id: string; title: string; status: string; version: number; structureVersion: number; projectId: string | null }; expectedVersion: number; expectedStructureVersion: number; childCount: number; alreadyEnabled: boolean; project: ProjectSummary | null };
type EnableResult = { changed: boolean; taskId: string; taskVersion: number; structureVersion: number; affectedCount: number; project: ProjectSummary };
type Envelope<T> = { data: T; error?: { message?: string } };

export default function EnableProjectPanel({ taskId, expectedVersion, expectedStructureVersion, onEnabled }: { taskId: string; expectedVersion: number; expectedStructureVersion: number; onEnabled: (result: EnableResult) => void }) {
  const [preview, setPreview] = useState<EnablePreview | null>(null);
  const [successCriteria, setSuccessCriteria] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setPreview(null); setSuccessCriteria(''); setTargetDate(''); setError(''); }, [taskId]);

  async function loadPreview() {
    setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/enable-project`);
      const body = await response.json() as Envelope<EnablePreview>;
      if (!response.ok) throw new Error(body.error?.message ?? '项目视图预览失败');
      setPreview(body.data);
      if (body.data.project) { setSuccessCriteria(body.data.project.successCriteria ?? ''); setTargetDate(body.data.project.targetDate ?? ''); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '项目视图预览失败'); }
  }

  async function confirmEnable() {
    if (!preview || busy) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/enable-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: preview.expectedVersion, expectedStructureVersion: preview.expectedStructureVersion, ...(successCriteria.trim() ? { successCriteria: successCriteria.trim() } : {}), ...(targetDate ? { targetDate } : {}) }) });
      const body = await response.json() as Envelope<EnableResult>;
      if (!response.ok) throw new Error(body.error?.message ?? '启用项目视图失败');
      onEnabled(body.data); setPreview(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '启用项目视图失败'); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-label="启用项目视图">
    <div className={styles.top}><div><strong>项目视图</strong><span>原事项会成为项目目标，ID、正文、媒体和历史保留不变。</span></div><button type="button" onClick={() => void loadPreview()} disabled={busy}>{preview ? '重新预览' : '启用项目视图'}</button></div>
    {preview && <div className={styles.preview}>
      {preview.alreadyEnabled && preview.project ? <p className={styles.success}>已启用项目视图：{preview.project.name}。不会创建第二个项目。</p> : <>
        <p>将保留当前事项作为项目目标，并把 {preview.childCount} 个主后代纳入同一项目索引；不会复制事项。</p>
        <label>完成标准（可选）<textarea value={successCriteria} onChange={(event) => setSuccessCriteria(event.target.value)} maxLength={5000} rows={3} placeholder="例如：上线并完成验收" /></label>
        <label>成果日期（可选）<input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label>
        <button type="button" className={styles.confirm} onClick={() => void confirmEnable()} disabled={busy}>{busy ? '启用中…' : '确认启用项目视图'}</button>
      </>}
    </div>}
    {error && <p className={styles.error} role="alert">{error}<button type="button" onClick={() => void loadPreview()}>重试</button></p>}
  </section>;
}
