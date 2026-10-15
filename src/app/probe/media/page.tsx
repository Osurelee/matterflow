'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * M4-01 录音/媒体能力探针（PRD Q-02/Q-08、技术设计 12「真机」层）。
 *
 * 目的：在字段真机上取得**实测事实**，而不是假定录音可用：
 * - 是否处于安全上下文、是否有 navigator.mediaDevices / MediaRecorder；
 * - 本机支持哪些 MIME（候选按优先级逐个 isTypeSupported）；
 * - 实际录出来的容器/采样率/声道/码率与字节数（含容器魔数嗅探，不靠扩展名）；
 * - 权限拒绝、录音中途 track 结束（中断）时的行为与错误名；
 * - 触控/视口等窄屏事实。
 *
 * 本页只探测浏览器能力，不读写任何事项数据；结果需要人工复制回
 * docs/ACCEPTANCE_M4_01.md 的实测记录表。M4-06 锁定录音格式后本页应删除。
 */

type Sniff = { container: string; hex: string };

type MediaSettings = { sampleRate?: number; channelCount?: number; echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean } | null;

type Report = {
  checkedAt: string;
  userAgent: string;
  platform: string;
  viewport: string;
  maxTouchPoints: number;
  secureContext: boolean;
  hasMediaDevices: boolean;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  supportedMimeTypes: string[];
  chosenMimeType: string | null;
  recorderEvents: string[];
  recording: null | { requestedMs: number; actualMs: number; bytes: number; blobType: string; sniff: Sniff; settings: MediaSettings; mimeType: string };
  interruption: null | { trackEndedObserved: boolean; dataStillCollected: boolean; bytesBeforeInterrupt: number };
  permission: null | { granted: boolean; errorName: string | null; errorMessage: string | null };
  audioInputCount: number | null;
  notes: string[];
};

const CANDIDATE_MIME_TYPES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
];

/** 容器魔数嗅探：格式按字节判定，不按扩展名（技术设计 12 真机层）。 */
function sniffContainer(bytes: Uint8Array): Sniff {
  const head = Array.from(bytes.slice(0, 16));
  const hex = head.map((value) => value.toString(16).padStart(2, '0')).join(' ');
  const ascii = String.fromCharCode(...head.slice(0, 8));
  let container = 'unknown';
  if (ascii.startsWith('OggS')) container = 'ogg';
  else if (head.slice(0, 4).join(',') === '26,69,223,163') container = 'webm-or-matroska';
  else if (ascii.startsWith('RIFF') && String.fromCharCode(...head.slice(8, 12)) === 'WAVE') container = 'wav';
  else if (head.slice(4, 8).join(',') === '102,116,121,112') container = 'iso-bmff(mp4/m4a)';
  else if (ascii.startsWith('ID3')) container = 'mp3-id3';
  else if (hex.startsWith('ff fb') || hex.startsWith('ff f3')) container = 'mp3';
  return { container, hex };
}

export default function MediaProbePage() {
  const [report, setReport] = useState<Report>(() => ({
    checkedAt: '',
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    platform: typeof navigator === 'undefined' ? '' : navigator.platform,
    viewport: typeof window === 'undefined' ? '' : `${window.innerWidth}×${window.innerHeight}`,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
    secureContext: typeof window === 'undefined' ? false : window.isSecureContext,
    hasMediaDevices: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices),
    hasGetUserMedia: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
    hasMediaRecorder: typeof window !== 'undefined' && typeof window.MediaRecorder === 'function',
    supportedMimeTypes: [],
    chosenMimeType: null,
    recorderEvents: [],
    recording: null,
    interruption: null,
    permission: null,
    audioInputCount: null,
    notes: [],
  }));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('尚未检测');
  const notesRef = useRef<string[]>([]);

  const note = (text: string) => { notesRef.current = [...notesRef.current, text]; };

  const supportedMimeTypes = useMemo(() => {
    if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return [];
    return CANDIDATE_MIME_TYPES.filter((type) => {
      try { return window.MediaRecorder.isTypeSupported(type); } catch { return false; }
    });
  }, []);

  const update = useCallback((patch: Partial<Report>) => setReport((prior) => ({ ...prior, ...patch, notes: notesRef.current })), []);

  /** 权限与设备枚举：拒绝也要留下错误名。 */
  const probeDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) { note('enumerateDevices 不可用'); update({ audioInputCount: null }); return; }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      note(`enumerateDevices: ${inputs.length} 个音频输入`);
      update({ audioInputCount: inputs.length });
    } catch (error) {
      note(`enumerateDevices 失败: ${(error as Error).name}`);
      update({ audioInputCount: null });
    }
  }, [update]);

  /** 录制实测：默认 3 秒，随后停止并读取实际字节、容器、采样率。 */
  const runRecording = useCallback(async (requestedMs = 3000) => {
    if (typeof window.MediaRecorder !== 'function') { note('MediaRecorder 不可用，无法录制'); update({}); return; }
    const chosen = supportedMimeTypes[0] ?? null;
    const chunks: Blob[] = [];
    const events: string[] = [];
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      note('getUserMedia 成功（已获得麦克风权限）');
      update({ permission: { granted: true, errorName: null, errorMessage: null } });
    } catch (error) {
      const err = error as Error;
      note(`getUserMedia 失败: ${err.name}`);
      update({ permission: { granted: false, errorName: err.name, errorMessage: err.message } });
      return;
    }
    try {
      const recorder = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
      recorder.addEventListener('start', () => events.push('start'));
      recorder.addEventListener('stop', () => events.push('stop'));
      recorder.addEventListener('error', (event) => events.push(`error:${(event as ErrorEvent).error?.name ?? 'unknown'}`));
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data); });
      const started = performance.now();
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, requestedMs));
      recorder.stop();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const blob = new Blob(chunks, { type: recorder.mimeType || chosen || '' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const track = stream.getAudioTracks()[0];
      const settings = (track?.getSettings?.() ?? null) as unknown as MediaSettings;
      const actualMs = Math.round(performance.now() - started);
      note(`录制完成: ${bytes.byteLength} 字节, 容器=${sniffContainer(bytes).container}, mime=${blob.type || '未知'}`);
      update({
        chosenMimeType: chosen,
        recorderEvents: events,
        recording: {
          requestedMs, actualMs: actualMs, bytes: bytes.byteLength,
          blobType: blob.type || '', sniff: sniffContainer(bytes), settings,
          mimeType: recorder.mimeType || chosen || '',
        },
      });
    } catch (error) {
      note(`MediaRecorder 使用失败: ${(error as Error).name}: ${(error as Error).message}`);
      update({ recorderEvents: events });
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  }, [supportedMimeTypes, update]);

  /** 中断实测：录制中直接结束 track，观察是否仍能拿到已产生的数据。 */
  const runInterruption = useCallback(async () => {
    if (typeof window.MediaRecorder !== 'function') { note('MediaRecorder 不可用，无法测试中断'); update({}); return; }
    const chunks: Blob[] = [];
    let ended = false;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chosen = supportedMimeTypes[0];
      const recorder = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
      stream.getAudioTracks()[0].addEventListener('ended', () => { ended = true; });
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data); });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 900));
      stream.getTracks().forEach((track) => track.stop());
      await new Promise((resolve) => setTimeout(resolve, 900));
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      note(`中断实测: trackEnded=${ended}, 已收集 ${bytes.byteLength} 字节`);
      update({ interruption: { trackEndedObserved: ended, dataStillCollected: bytes.byteLength > 0, bytesBeforeInterrupt: bytes.byteLength } });
    } catch (error) {
      note(`中断实测失败: ${(error as Error).name}`);
      update({ interruption: { trackEndedObserved: ended, dataStillCollected: false, bytesBeforeInterrupt: 0 } });
    } finally {
      stream?.getTracks()?.forEach((track) => track.stop());
    }
  }, [supportedMimeTypes, update]);

  const runAll = useCallback(async () => {
    setBusy(true); setStatus('检测中…');
    notesRef.current = [];
    await probeDevices();
    await runRecording(3000);
    await runInterruption();
    setStatus('检测完成：请复制报告');
    setBusy(false);
  }, [probeDevices, runRecording, runInterruption]);

  const fullReport = () => JSON.stringify({ ...report, supportedMimeTypes, checkedAt: new Date().toISOString() }, null, 2);

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px 60px', fontFamily: 'system-ui, sans-serif', fontSize: 14, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 20 }}>录音 / 媒体能力探针（M4-01）</h1>
      <p style={{ color: '#5c6b63' }}>
        本页只在本机浏览器里做能力实测，不读写事项数据。请用<b>真实目标手机</b>通过正式入口打开本页执行一次，
        再把报告粘贴回 <code>docs/ACCEPTANCE_M4_01.md</code> 的实测表；未实测前不得声称录音能力可用。
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void runAll()} disabled={busy} style={{ padding: '9px 14px', borderRadius: 8, border: 0, background: '#237750', color: '#fff', fontWeight: 600 }}>
          {busy ? '检测中…' : '开始完整检测（约 6 秒）'}
        </button>
        <button type="button" onClick={() => void runRecording(3000)} disabled={busy} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #dfe7e1', background: '#fff' }}>只测录制</button>
        <button type="button" onClick={() => void runInterruption()} disabled={busy} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #dfe7e1', background: '#fff' }}>只测中断</button>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(fullReport()); setStatus('报告已复制到剪贴板'); }} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #dfe7e1', background: '#fff' }}>复制报告</button>
      </div>
      <p style={{ marginTop: 12, color: '#78857e', fontSize: 12 }}>状态：{status}</p>
      <ul style={{ paddingLeft: 18, fontSize: 12 }}>
        <li>安全上下文：{String(report.secureContext)}（getUserMedia 只在 HTTPS 或 localhost 可用）</li>
        <li>mediaDevices：{String(report.hasMediaDevices)}；getUserMedia：{String(report.hasGetUserMedia)}；MediaRecorder：{String(report.hasMediaRecorder)}</li>
        <li>音频输入设备数：{report.audioInputCount ?? '未知'}；视口：{report.viewport}；触控点：{report.maxTouchPoints}</li>
        <li>支持 MIME：{supportedMimeTypes.length ? supportedMimeTypes.join('、') : '未检出'}</li>
        <li>权限：{report.permission ? (report.permission.granted ? '已授权' : `拒绝（${report.permission.errorName}）`) : '未检测'}</li>
        <li>录制结果：{report.recording ? `${report.recording.bytes} 字节 / ${report.recording.actualMs}ms / 容器 ${report.recording.sniff.container} / mime ${report.recording.blobType || '空'}` : '未录制'}</li>
        <li>中断结果：{report.interruption ? `track 结束=${String(report.interruption.trackEndedObserved)}，仍收到数据=${String(report.interruption.dataStillCollected)}，${report.interruption.bytesBeforeInterrupt} 字节` : '未测试'}</li>
      </ul>
      <h2 style={{ fontSize: 15 }}>完整报告（可复制粘贴回验收文档）</h2>
      <textarea readOnly value={fullReport()} aria-label="探针报告" style={{ width: '100%', height: 320, padding: 10, borderRadius: 8, border: '1px solid #dfe7e1', fontFamily: 'ui-monospace, monospace', fontSize: 11 }} />
    </main>
  );
}
