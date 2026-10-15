'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/shared/api';
import styles from './TaskReferencesPanel.module.css';

type TaskStub = { id: string; title: string; status: string; spaceName: string | null; projectName: string | null; archived: boolean; deleted: boolean };
type Reference = { id: string; version: number; sourceTaskId: string; targetTaskId: string; task: TaskStub };
type Envelope<T> = { data: T };

export default function TaskReferencesPanel({ taskId, expectedStructureVersion, onOpen, onStructureVersionChange }: { taskId: string; expectedStructureVersion: number; onOpen: (id: string) => void; onStructureVersionChange: (version: number) => void }) {
  const [outgoing, setOutgoing] = useState<Reference[]>([]);
  const [incoming, setIncoming] = useState<Reference[]>([]);
  const [targetTaskId, setTargetTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [outResponse, inResponse] = await Promise.all([apiFetch(`/api/tasks/${taskId}/references`), apiFetch(`/api/tasks/${taskId}/referenced-by`)]);
      const outBody = await outResponse.json() as Envelope<{ items: Reference[] }>;
      const inBody = await inResponse.json() as Envelope<{ items: Reference[] }>;
      if (!outResponse.ok || !inResponse.ok) throw new Error('引用读取失败');
      setOutgoing(outBody.data.items); setIncoming(inBody.data.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '引用读取失败'); }
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  async function addReference() {
    const target = targetTaskId.trim(); if (!target) return;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/references`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), targetTaskId: target, expectedStructureVersion }) });
      const body = await response.json() as Envelope<Reference & { changed?: boolean; sourceStructureVersion?: number }> & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? '添加引用失败');
      if (body.data.sourceStructureVersion) onStructureVersionChange(body.data.sourceStructureVersion);
      setTargetTaskId(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '添加引用失败'); }
    finally { setBusy(false); }
  }

  async function removeReference(reference: Reference) {
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/tasks/${taskId}/references/${reference.id}/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: reference.version, expectedStructureVersion }) });
      const body = await response.json() as Envelope<{ sourceStructureVersion?: number }> & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? '移除引用失败');
      if (body.data.sourceStructureVersion) onStructureVersionChange(body.data.sourceStructureVersion);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '移除引用失败'); }
    finally { setBusy(false); }
  }

  const row = (reference: Reference, removable: boolean) => <li key={reference.id}><button type="button" className={styles.task} onClick={() => !reference.task.deleted && onOpen(reference.task.id)} disabled={reference.task.deleted}>{reference.task.title}</button><span>{reference.task.deleted ? '事项已删除' : reference.task.archived ? '已归档' : reference.task.status}</span>{removable && <button type="button" className={styles.remove} onClick={() => void removeReference(reference)} disabled={busy}>移除</button>}</li>;

  return <section className={styles.panel} aria-label="事项引用"><div className={styles.heading}><h3>引用</h3><span>不复制内容，只显示原事项</span></div><div className={styles.add}><input value={targetTaskId} onChange={(event) => setTargetTaskId(event.target.value)} placeholder="粘贴要引用的事项ID" aria-label="引用目标事项ID" /><button type="button" onClick={() => void addReference()} disabled={busy || !targetTaskId.trim()}>添加引用</button></div>{outgoing.length > 0 && <div><strong>我引用的事项</strong><ul className={styles.list}>{outgoing.map((reference) => row(reference, true))}</ul></div>}{incoming.length > 0 && <div><strong>被引用位置</strong><ul className={styles.list}>{incoming.map((reference) => row(reference, false))}</ul></div>}{error && <p className={styles.error} role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}</section>;
}
