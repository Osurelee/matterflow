'use client';
import { ChangeEvent, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { apiUrl } from '@/shared/api';
import styles from './CaptureAttachments.module.css';

type Asset = { id: string; originalName: string; mimeType: string; byteSize: number; kind: 'image' | 'file' | 'audio'; contentUrl: string; previewUrl: string };
type Local = { id: string; file: File; url: string; requestId: string; progress: number; busy: boolean; error: string };
type Envelope<T> = { data: T };
type PickKind = 'image' | 'file';

export type CaptureAttachmentsHandle = {
  /** 粘贴/拖拽进入的本地文件：加入队列并自动上传暂存。 */
  addFiles: (files: File[]) => void;
  openPicker: (kind?: PickKind) => void;
};

type Props = {
  onChange: (items: Asset[]) => void;
  onPendingChange: (pending: boolean) => void;
  /** 单个文件上传暂存成功（图片可据此显示缩略图；父级已不再需要写回正文）。 */
  onStagedAsset?: (asset: Asset) => void;
  onRemoveAsset?: (asset: Asset) => void;
  commitToken: number;
  initialAssets?: Asset[];
  variant?: 'panel' | 'flat';
};

function upload(file: File, requestId: string, onProgress: (n: number) => void) {
  return new Promise<Omit<Asset, 'previewUrl'>>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/uploads'));
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100))); };
    xhr.onerror = () => reject(new Error('网络中断，所选文件保留，可重试'));
    xhr.onabort = () => reject(new Error('上传取消，所选文件保留，可重试'));
    xhr.onload = () => {
      let result: Envelope<Omit<Asset, 'previewUrl'>> & { error?: { message?: string } };
      try { result = JSON.parse(xhr.responseText); } catch { return reject(new Error('服务器响应无效')); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(result.error?.message || `上传失败 (${xhr.status})`));
      resolve(result.data);
    };
    const form = new FormData();
    form.set('requestId', requestId);
    form.set('file', file, file.name);
    xhr.send(form);
  });
}

function acceptFor(kind?: PickKind): string {
  return kind === 'image'
    ? 'image/*'
    : 'image/*,audio/*,.pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown';
}

const CaptureAttachments = forwardRef<CaptureAttachmentsHandle, Props>(function CaptureAttachments(
  { onChange, onPendingChange, onStagedAsset, onRemoveAsset, commitToken, initialAssets = [], variant = 'panel' }: Props,
  ref,
) {
  const [local, setLocal] = useState<Local[]>([]);
  const [assets, setAssets] = useState<Asset[]>(initialAssets);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const commit = useRef(commitToken);
  const assetsRef = useRef(assets);
  const localRef = useRef(local);
  assetsRef.current = assets;
  localRef.current = local;

  useEffect(() => { onChange(assets); onPendingChange(local.length > 0); }, [assets, local, onChange, onPendingChange]);
  useEffect(() => {
    if (commit.current !== commitToken) {
      commit.current = commitToken;
      local.forEach((x) => URL.revokeObjectURL(x.url));
      assets.forEach((x) => URL.revokeObjectURL(x.previewUrl));
      setLocal([]); setAssets([]); setError('');
    }
  }, [commitToken, local, assets]);
  useEffect(() => () => { local.forEach((x) => URL.revokeObjectURL(x.url)); assets.forEach((x) => URL.revokeObjectURL(x.previewUrl)); onPendingChange(false); }, []);

  function stage(item: Local) {
    setLocal((cur) => cur.map((x) => (x.id === item.id ? { ...x, busy: true, error: '' } : x)));
    void upload(item.file, item.requestId, (n) => setLocal((cur) => cur.map((x) => (x.id === item.id ? { ...x, progress: n } : x)))).then((result) => {
      const asset: Asset = { ...result, previewUrl: item.url };
      setAssets((cur) => [...cur, asset]);
      setLocal((cur) => cur.filter((x) => x.id !== item.id));
      setError('');
      onStagedAsset?.(asset);
    }).catch((error: unknown) => {
      setLocal((cur) => cur.map((x) => (x.id === item.id ? { ...x, busy: false, error: error instanceof Error ? error.message : '上传失败' } : x)));
    });
  }

  function addFiles(files: File[]) {
    if (!files.length) return;
    if (assetsRef.current.length + localRef.current.length + files.length > 10) { setError('一次捕获最多10个媒体附件'); return; }
    const accepted = files.filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf' || f.type === 'text/plain' || f.type === 'text/markdown' || f.type.startsWith('audio/'));
    if (!accepted.length) { setError('支持图片、PDF、UTF-8文本或Markdown'); return; }
    setError('');
    const items = accepted.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), requestId: crypto.randomUUID(), progress: 0, busy: false, error: '' }));
    setLocal((cur) => [...cur, ...items]);
    items.forEach((item) => stage(item));
  }

  function openPicker(kind?: PickKind) {
    if (!input.current) return;
    input.current.accept = acceptFor(kind);
    input.current.click();
  }

  useImperativeHandle(ref, () => ({ addFiles, openPicker }), []);

  function select(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    addFiles(files);
  }

  function removeLocal(id: string) {
    const item = local.find((x) => x.id === id);
    if (item) URL.revokeObjectURL(item.url);
    setLocal((cur) => cur.filter((x) => x.id !== id));
  }

  function removeAsset(id: string) {
    const asset = assets.find((x) => x.id === id);
    if (asset) {
      URL.revokeObjectURL(asset.previewUrl);
      onRemoveAsset?.(asset);
    }
    setAssets((cur) => cur.filter((x) => x.id !== id));
  }

  if (variant === 'flat' && !local.length && !assets.length && !error) {
    return (
      <section className={styles.panelFlat} aria-label="捕获媒体" hidden>
        <input ref={input} type="file" multiple accept={acceptFor()} onChange={select} className={styles.hidden} />
      </section>
    );
  }

  return (
    <section className={`${styles.panel} ${variant === 'flat' ? styles.flat : ''}`} aria-label="捕获媒体">
      <input ref={input} type="file" multiple accept={acceptFor()} onChange={select} className={styles.hidden} />
      {error && <p className={styles.error} role="alert">{error}</p>}
      {(local.length || assets.length) && (
        <ul className={styles.chips}>
          {local.map((item) => (
            <li key={item.id} className={styles.chip}>
              {item.file.type.startsWith('image/')
                ? <img className={styles.chipImage} src={item.url} alt="" />
                : <span className={styles.chipIcon}>{item.file.type.startsWith('audio/') ? '♫' : '▤'}</span>}
              <div className={styles.chipBody}>
                <b>{item.file.name}</b>
                {item.busy
                  ? <progress className={styles.progress} max={100} value={item.progress} aria-label="上传进度" />
                  : item.error
                    ? <small className={styles.error}>{item.error}</small>
                    : <small>上传中…</small>}
                <span className={styles.chipActions}>
                  {item.error && <button type="button" className={styles.retry} onClick={() => stage(item)} disabled={item.busy}>重试</button>}
                  <button type="button" className={styles.remove} onClick={() => removeLocal(item.id)} disabled={item.busy} aria-label="移除" title="移除">×</button>
                </span>
              </div>
            </li>
          ))}
          {assets.map((asset) => (
            <li key={asset.id} className={styles.chip}>
              {asset.kind === 'image' && asset.previewUrl
                ? <img className={styles.chipImage} src={asset.previewUrl} alt="" />
                : <span className={styles.chipIcon}>{asset.kind === 'audio' ? '♫' : '▤'}</span>}
              <div className={styles.chipBody}>
                <b>{asset.originalName}</b>
                <small>已暂存</small>
                <span className={styles.chipActions}>
                  <button type="button" className={styles.remove} onClick={() => removeAsset(asset.id)} aria-label="移除" title="移除">×</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {variant !== 'flat' && (
        <header>
          <strong>图片 / 文件</strong>
          <button type="button" onClick={() => openPicker()}>选择媒体</button>
        </header>
      )}
    </section>
  );
});

export default CaptureAttachments;
