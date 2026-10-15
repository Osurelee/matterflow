'use client';

import { ChangeEvent, DragEvent, ClipboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiUrl } from '@/shared/api';
import AudioRecorder from '@/components/AudioRecorder';
import styles from './TaskAttachments.module.css';

type Envelope<T>={data:T};
type Asset={id:string;originalName:string;mimeType:string;byteSize:number;sha256:string;kind:'image'|'file'|'audio';contentUrl:string;durationMs:number|null};
type SavedAttachment=Asset&{linkId:string;role:string;createdAt:string};
type Pending={localId:string;file:File;previewUrl:string;uploadId:string;attachId:string;asset?:Asset;progress:number;busy:boolean;error:string};

async function errorMessage(response:Response) {
  try { const body=await response.json() as {error?:{message?:string}}; return body.error?.message||`请求失败 (${response.status})`; }
  catch { return `请求失败 (${response.status})`; }
}

function xhrUpload(file:File,requestId:string,onProgress:(value:number)=>void) {
 return new Promise<Asset>((resolve,reject)=>{
  const xhr=new XMLHttpRequest(); xhr.open('POST',apiUrl('/api/uploads')); xhr.withCredentials=true;
  xhr.upload.onprogress=(event)=>{if(event.lengthComputable)onProgress(Math.min(99,Math.round(event.loaded/event.total*100)))};
  xhr.onerror=()=>reject(new Error('网络中断，文件仍保留在本机，可重试'));
  xhr.onabort=()=>reject(new Error('上传已取消，文件仍保留在本机'));
  xhr.onload=()=>{
   let body:Envelope<Asset>&{error?:{message?:string}};try{body=JSON.parse(xhr.responseText)}catch{return reject(new Error('服务器响应无效'))}
   if(xhr.status<200||xhr.status>=300)return reject(new Error(body.error?.message||`上传失败 (${xhr.status})`));
   onProgress(100);resolve(body.data);
  };
  const form=new FormData();form.set('requestId',requestId);form.set('file',file,file.name);xhr.send(form);
 });
}

function formatBytes(bytes:number) { if(bytes<1024)return `${bytes} B`; if(bytes<1024*1024)return `${(bytes/1024).toFixed(0)} KB`; return `${(bytes/1024/1024).toFixed(1)} MB`; }

export default function TaskAttachments({taskId,expectedVersion,onVersionChange,onInsertImage,onPendingChange}:{taskId:string;expectedVersion:number;onVersionChange:(version:number)=>void;onInsertImage:(assetId:string,alt:string)=>void;onPendingChange:(count:number)=>void}) {
 const [items,setItems]=useState<SavedAttachment[]>([]); const [pending,setPending]=useState<Pending[]>([]); const [audioPending,setAudioPending]=useState(false); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [dragging,setDragging]=useState(false); const imageInput=useRef<HTMLInputElement>(null); const fileInput=useRef<HTMLInputElement>(null); const pendingRef=useRef<Pending[]>([]);
 const load=useCallback(async()=>{
  setLoading(true);setError('');try{const response=await apiFetch(`/api/tasks/${taskId}/attachments`);if(!response.ok)throw new Error(await errorMessage(response));const result=await response.json() as Envelope<{items:SavedAttachment[]}>;setItems(result.data.items)}catch(e){setError(e instanceof Error?e.message:'读取附件失败')}finally{setLoading(false)}
 },[taskId]);
 useEffect(()=>{void load()},[load]);
 useEffect(()=>{pendingRef.current=pending;onPendingChange(pending.length+(audioPending?1:0))},[pending,audioPending,onPendingChange]);
 useEffect(()=>()=>{pendingRef.current.forEach((p)=>URL.revokeObjectURL(p.previewUrl));onPendingChange(0)},[onPendingChange]);
 const addFiles=useCallback((files:FileList|File[])=>{
  const accepted=Array.from(files).filter((file)=>file.type.startsWith('image/')||file.type==='application/pdf'||file.type==='text/plain'||file.type==='text/markdown'||file.type.startsWith('audio/'));
  if(!accepted.length){setError('请选择图片、PDF 或 UTF-8 文本/Markdown 文件');return}
  setError('');setPending((current)=>[...current,...accepted.map((file)=>({localId:crypto.randomUUID(),file,previewUrl:URL.createObjectURL(file),uploadId:crypto.randomUUID(),attachId:crypto.randomUUID(),progress:0,busy:false,error:''}))]);
 },[]);
 function onFileChange(event:ChangeEvent<HTMLInputElement>){if(event.target.files)addFiles(event.target.files);event.target.value=''}
 function onDrop(event:DragEvent<HTMLElement>){event.preventDefault();setDragging(false);addFiles(event.dataTransfer.files)}
 function onPaste(event:ClipboardEvent<HTMLElement>){const fromItems=Array.from(event.clipboardData.items).filter((item)=>item.kind==='file').map((item)=>item.getAsFile()).filter((file):file is File=>Boolean(file));const files=[...Array.from(event.clipboardData.files),...fromItems];if(files.length){event.preventDefault();addFiles(files)}}
 function discard(localId:string){const item=pendingRef.current.find((p)=>p.localId===localId);if(item)URL.revokeObjectURL(item.previewUrl);setPending((current)=>current.filter((p)=>p.localId!==localId))}
 async function upload(item:Pending){
  setPending((current)=>current.map((p)=>p.localId===item.localId?{...p,busy:true,error:''}:p));setError('');
  try{
   let asset=item.asset;
   if(!asset)asset=await xhrUpload(item.file,item.uploadId,(progress)=>setPending((current)=>current.map((p)=>p.localId===item.localId?{...p,progress}:p)));
   setPending((current)=>current.map((p)=>p.localId===item.localId?{...p,asset,progress:100}:p));
   const response=await apiFetch(`/api/tasks/${taskId}/attachments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:item.attachId,assetId:asset.id,expectedVersion})});
   if(!response.ok)throw new Error(await errorMessage(response));
   const result=await response.json() as Envelope<{version:number}>;onVersionChange(result.data.version);await load();discard(item.localId);
  }catch(e){setPending((current)=>current.map((p)=>p.localId===item.localId?{...p,busy:false,asset:p.asset,progress:p.progress,error:e instanceof Error?e.message:'上传/关联失败，文件已保留'}:p))}
 }
 async function remove(item:SavedAttachment){
  if(!window.confirm(`从此事项移除“${item.originalName}”？历史记录会保留，原文件不会删除。`))return;
  setError('');try{const response=await apiFetch(`/api/tasks/${taskId}/attachments/${item.linkId}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),expectedVersion})});if(!response.ok)throw new Error(await errorMessage(response));const result=await response.json() as Envelope<{version:number}>;onVersionChange(result.data.version);setItems((current)=>current.filter((x)=>x.linkId!==item.linkId))}catch(e){setError(e instanceof Error?e.message:'移除失败')}
 }
 return <section className={`${styles.panel} ${dragging?styles.dragging:''}`} aria-label="内容附件" tabIndex={0} onDragEnter={(e)=>{e.preventDefault();setDragging(true)}} onDragOver={(e)=>e.preventDefault()} onDragLeave={(e)=>{if(e.currentTarget===e.target)setDragging(false)}} onDrop={onDrop} onPaste={onPaste}>
  <input ref={imageInput} className={styles.hidden} type="file" accept="image/*" multiple capture="environment" onChange={onFileChange} aria-label="选择或拍摄图片" />
  <input ref={fileInput} className={styles.hidden} type="file" accept="image/*,audio/*,.pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" multiple onChange={onFileChange} aria-label="选择图片或文件" />
  <div className={styles.head}><div><h3>附件</h3><span>图片默认作为附件；需要时可单独插入正文</span></div><div className={styles.actions}><button type="button" onClick={()=>imageInput.current?.click()}>添加图片</button><button type="button" onClick={()=>fileInput.current?.click()}>添加文件</button></div></div>
  <div className={styles.dropHint} onClick={()=>fileInput.current?.click()}>拖放文件到此处，或粘贴剪贴板图片</div>
  <AudioRecorder taskId={taskId} expectedVersion={expectedVersion} onVersionChange={onVersionChange} onAttached={()=>void load()} onPendingChange={setAudioPending} />
  {error&&<p role="alert" className={styles.error}>{error}<button type="button" onClick={()=>void load()}>重新加载</button></p>}
  {loading?<p className={styles.empty}>正在读取附件…</p>:items.length===0&&pending.length===0?null:<ul className={styles.list}>
   {items.map((item)=>{const image=item.mimeType.startsWith('image/');const audio=item.mimeType.startsWith('audio/');return <li key={item.linkId} className={styles.saved}>
    {image?<a className={styles.thumb} href={apiUrl(item.contentUrl)} target="_blank" rel="noopener noreferrer" aria-label={`放大查看 ${item.originalName}`}><img src={apiUrl(item.contentUrl)} alt={item.originalName} loading="lazy" /></a>:audio?<span className={styles.fileIcon}>♫</span>:<span className={styles.fileIcon}>▤</span>}
    <div className={styles.info}><strong title={item.originalName}>{item.originalName}</strong><small>{formatBytes(item.byteSize)} · {image?'图片':audio?`录音附件${item.durationMs?` · ${Math.ceil(item.durationMs/1000)}秒`:''}`:'文件'}</small>{audio&&<audio className={styles.audioPlayer} controls preload="metadata" src={apiUrl(item.contentUrl)} aria-label={`播放录音 ${item.originalName}`} />}<div className={styles.rowActions}>{image&&<button type="button" onClick={()=>onInsertImage(item.id,item.originalName)}>插入正文</button>}<a href={apiUrl(item.contentUrl)} download={item.originalName}>下载</a><button type="button" onClick={()=>void remove(item)}>移除此附件</button></div></div>
   </li>})}
   {pending.map((item)=><li key={item.localId} className={styles.pending}>
    {item.file.type.startsWith('image/')?<img className={styles.localThumb} src={item.previewUrl} alt={`本机预览：${item.file.name}`} />:<span className={styles.fileIcon}>▤</span>}
    <div className={styles.info}><strong title={item.file.name}>{item.file.name}</strong><small>{formatBytes(item.file.size)} · 仅本机预览，尚未保存</small>
     {item.busy&&<div className={styles.progressWrap}><progress max={100} value={item.progress}/><span>{item.progress>=100?'正在关联…':`上传 ${item.progress}%`}</span></div>}
     {item.error&&<p className={styles.error}>{item.error}</p>}
     <div className={styles.rowActions}><button type="button" disabled={item.busy||pending.some((x)=>x.busy&&x.localId!==item.localId)} onClick={()=>void upload(item)}>{item.busy?'处理中…':item.asset?'重试关联':'上传并添加'}</button>{item.asset&&item.asset.kind==='image'&&<button type="button" disabled={item.busy} onClick={()=>onInsertImage(item.asset!.id,item.file.name)}>上传后插入正文</button>}<button type="button" disabled={item.busy} onClick={()=>discard(item.localId)}>放弃</button></div>
    </div>
   </li>)}
  </ul>}
 </section>;
}
