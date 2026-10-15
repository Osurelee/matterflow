'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { apiFetch, apiUrl } from '@/shared/api';
import styles from './AudioRecorder.module.css';

type Envelope<T>={data:T};
type Asset={id:string;kind:'audio';mimeType:string;byteSize:number;durationMs:number|null;contentUrl:string};
type Clip={blob:Blob;url:string;mimeType:string;extension:string;durationMs:number;uploadId:string;attachId:string;asset?:Asset};
type Phase='idle'|'requesting'|'recording'|'finalizing'|'preview'|'uploading'|'error';
const MAX_DURATION_MS=5*60*1000;
const MAX_BYTES=24*1024*1024;
const MIME_CANDIDATES=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'];
function extensionFor(mime:string){if(mime==='audio/mp4')return'm4a';if(mime==='audio/webm')return'webm';if(mime==='audio/ogg')return'ogg';if(mime==='audio/wav'||mime==='audio/x-wav')return'wav';if(mime==='audio/mpeg')return'mp3';if(mime==='audio/aac')return'aac';return''}
function prettyTime(ms:number){const seconds=Math.floor(ms/1000);return`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`}
async function responseError(response:Response){try{return((await response.json()) as {error?:{message?:string}}).error?.message||`请求失败 (${response.status})`}catch{return`请求失败 (${response.status})`}}

type AudioRecorderProps = { taskId:string;expectedVersion:number;onVersionChange:(version:number)=>void;onAttached:()=>void;onPendingChange:(pending:boolean)=>void;mode?:'task'|'staged';onStagedAsset?:(assetId:string)=>void;onDiscardStaged?:(assetId:string)=>void;commitToken?:number;variant?:'panel'|'flat' };
const AudioRecorder = forwardRef<{start:()=>void}, AudioRecorderProps>(function AudioRecorder({taskId,expectedVersion,onVersionChange,onAttached,onPendingChange,mode='task',onStagedAsset,onDiscardStaged,commitToken=0,variant='panel'}:AudioRecorderProps, ref){
 const [phase,setPhase]=useState<Phase>('idle');const [elapsed,setElapsed]=useState(0);const [clip,setClip]=useState<Clip|null>(null);const [message,setMessage]=useState('');const [progress,setProgress]=useState(0);
 const recorderRef=useRef<MediaRecorder|null>(null);const requestCancelRef=useRef(false);const streamRef=useRef<MediaStream|null>(null);const chunksRef=useRef<Blob[]>([]);const bytesRef=useRef(0);const startAtRef=useRef(0);const timerRef=useRef<ReturnType<typeof setInterval>|null>(null);const stopReasonRef=useRef('');const discardOnStopRef=useRef(false);const uploadRef=useRef<XMLHttpRequest|null>(null);const phaseRef=useRef(phase);phaseRef.current=phase;const committedRef=useRef(commitToken);
 const releaseStream=useCallback(()=>{if(timerRef.current){clearInterval(timerRef.current);timerRef.current=null}streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null},[]);
 const finishRecording=useCallback((reason='')=>{
  const recorder=recorderRef.current;
  if(!recorder||recorder.state==='inactive')return;
  stopReasonRef.current=reason;setPhase('finalizing');
  try{recorder.stop()}catch{releaseStream();setPhase('error');setMessage('无法停止录音；麦克风已释放。请重试或导入音频。')}
 },[releaseStream]);
 useEffect(()=>{const busy=['requesting','recording','finalizing','uploading'].includes(phase);const pendingClip=Boolean(clip&&(mode==='task'||!clip.asset));onPendingChange(busy||pendingClip)},[phase,clip,mode,onPendingChange]);
 useEffect(()=>{if(committedRef.current!==commitToken){committedRef.current=commitToken;if(clip){URL.revokeObjectURL(clip.url);setClip(null);setPhase('idle');setMessage('录音已随事项保存。')}}},[commitToken,clip]);
 useEffect(()=>{
  const visibility=()=>{if(document.visibilityState==='hidden'&&phaseRef.current==='recording')finishRecording('录音因页面切后台而中断，请试听检查。')};
  document.addEventListener('visibilitychange',visibility);
  return()=>{document.removeEventListener('visibilitychange',visibility);if(uploadRef.current)uploadRef.current.abort();if(recorderRef.current&&recorderRef.current.state!=='inactive'){try{recorderRef.current.stop()}catch{}}releaseStream();if(clip)URL.revokeObjectURL(clip.url)};
 },[finishRecording,releaseStream,clip]);
 const start=async(preserveStaged=false)=>{
  if(['requesting','recording','finalizing','uploading'].includes(phase))return;
  if(!window.isSecureContext){setPhase('error');setMessage('录音需要 HTTPS 或 localhost；请改用上传已有音频。');return}
  if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setPhase('error');setMessage('此浏览器不支持页面录音，请上传已有音频。');return}
  if(clip&&!preserveStaged&&!window.confirm('重录会放弃当前未上传片段，继续吗？'))return;
  if(clip){if(!preserveStaged&&mode==='staged'&&clip.asset)onDiscardStaged?.(clip.asset.id);URL.revokeObjectURL(clip.url);setClip(null)}
  setMessage('正在请求麦克风权限…');setPhase('requesting');chunksRef.current=[];bytesRef.current=0;stopReasonRef.current='';discardOnStopRef.current=false;
  let stream:MediaStream;requestCancelRef.current=false;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});streamRef.current=stream;if(requestCancelRef.current){stream.getTracks().forEach(track=>track.stop());streamRef.current=null;setPhase('idle');setMessage('已取消麦克风请求。');return}}catch(error){const err=error as DOMException;setPhase('error');setMessage(err.name==='NotAllowedError'?'麦克风权限被拒绝。请在浏览器网站设置中允许麦克风，或上传已有音频。':err.name==='NotFoundError'?'没有可用麦克风，请上传已有音频。':`无法访问麦克风（${err.name||'错误'}）。请检查设备权限或上传已有音频。`);return}
  try{
   const mimeType=MIME_CANDIDATES.find(type=>MediaRecorder.isTypeSupported(type));const recorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);recorderRef.current=recorder;
   recorder.ondataavailable=(event)=>{if(event.data.size<=0)return;if(bytesRef.current+event.data.size>MAX_BYTES){stopReasonRef.current='已达到录音大小上限，保留上限内片段。';finishRecording(stopReasonRef.current);return}bytesRef.current+=event.data.size;chunksRef.current.push(event.data)};
   recorder.onerror=()=>{stopReasonRef.current='录音发生错误；请检查保留片段。';finishRecording(stopReasonRef.current)};
   stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>{if(phaseRef.current==='recording')finishRecording('麦克风设备中断，已尽力保留录音片段，请试听检查。')},{once:true}));
   recorder.onstop=()=>{
    releaseStream();setElapsed(Math.max(0,Date.now()-startAtRef.current));
    if(discardOnStopRef.current){chunksRef.current=[];bytesRef.current=0;setClip(null);setPhase('idle');setMessage('录音已放弃');return}
    const actualMime=(recorder.mimeType||chunksRef.current.find(c=>c.type)?.type||mimeType||'').split(';')[0].trim().toLowerCase();const blob=new Blob(chunksRef.current,{type:actualMime});chunksRef.current=[];
    if(!blob.size){setClip(null);setPhase('error');setMessage(stopReasonRef.current||'没有取得有效音频片段，请重试或上传已有音频。');return}
    const extension=extensionFor(actualMime);if(!extension){const url=URL.createObjectURL(blob);setClip({blob,url,mimeType:actualMime,extension:'bin',durationMs:Math.min(MAX_DURATION_MS,Date.now()-startAtRef.current),uploadId:crypto.randomUUID(),attachId:crypto.randomUUID()});setPhase('error');setMessage(`录音格式 ${actualMime||'未知'} 尚未验证；片段已保留试听，请使用“上传已有音频”或重录。`);return}
    const url=URL.createObjectURL(blob);setClip({blob,url,mimeType:actualMime,extension,durationMs:Math.max(1,Math.min(MAX_DURATION_MS,Date.now()-startAtRef.current)),uploadId:crypto.randomUUID(),attachId:crypto.randomUUID()});setPhase('preview');setMessage(stopReasonRef.current||'试听确认后再添加；当前片段尚未保存。');
   };
   recorder.start(250);startAtRef.current=Date.now();setElapsed(0);setPhase('recording');setMessage('正在录音；切换后台会停止并提示检查片段。');timerRef.current=setInterval(()=>{const now=Date.now();setElapsed(now-startAtRef.current);if(now-startAtRef.current>=MAX_DURATION_MS)finishRecording('已达到5分钟上限，录音已自动停止。')},250);
  }catch(error){releaseStream();setPhase('error');setMessage(`录音启动失败（${(error as Error).name||'错误'}）；请上传已有音频。`)}
 };
 useImperativeHandle(ref, () => ({ start: () => void start() }), [start]);
 const stop=()=>finishRecording('');
 const recordAnother=()=>{if(!clip||mode!=='staged'||!clip.asset||!window.confirm('当前录音已暂存；继续录一段并一并提交吗？'))return;void start(true)};
 const cancel=()=>{if(!window.confirm('放弃当前录音片段？'))return;if(clip&&mode==='staged'&&clip.asset)onDiscardStaged?.(clip.asset.id);if(phase==='recording'){discardOnStopRef.current=true;finishRecording('')}else{if(clip)URL.revokeObjectURL(clip.url);setClip(null);setPhase('idle');setMessage('录音片段已放弃')}};
 const upload=async()=>{
  if(!clip||phase==='uploading')return;
  setPhase('uploading');setMessage('正在上传并关联录音…');setProgress(0);
  try{
   let asset=clip.asset;
   if(!asset){const file=new File([clip.blob],`录音-${new Date().toISOString().replace(/[:.]/g,'-')}.${clip.extension}`,{type:clip.mimeType});asset=await new Promise<Asset>((resolve,reject)=>{const xhr=new XMLHttpRequest();uploadRef.current=xhr;xhr.open('POST',apiUrl('/api/uploads'));xhr.withCredentials=true;xhr.upload.onprogress=e=>{if(e.lengthComputable)setProgress(Math.min(99,Math.round(e.loaded/e.total*100)))};xhr.onerror=()=>reject(new Error('网络中断，录音片段仍保留，可重试'));xhr.onabort=()=>reject(new Error('上传已取消，录音片段仍保留，可重试'));xhr.onload=()=>{let body:Envelope<Asset>&{error?:{message?:string}};try{body=JSON.parse(xhr.responseText)}catch{return reject(new Error('服务器响应无效'))}if(xhr.status<200||xhr.status>=300)return reject(new Error(body.error?.message||`上传失败 (${xhr.status})`));resolve(body.data)};const form=new FormData();form.set('requestId',clip.uploadId);form.set('durationMs',String(clip.durationMs));form.set('file',file,file.name);xhr.send(form)});setClip({...clip,asset});}
   if(mode==='staged'){onStagedAsset?.(asset.id);setClip({...clip,asset});setPhase('preview');setProgress(100);setMessage('录音已暂存，尚未保存；提交事项或进展后才会关联。');uploadRef.current=null;return}
   const response=await apiFetch(`/api/tasks/${taskId}/attachments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:clip.attachId,assetId:asset.id,expectedVersion})});
   if(!response.ok)throw new Error(await responseError(response));const result=await response.json() as Envelope<{version:number}>;onVersionChange(result.data.version);onAttached();uploadRef.current=null;URL.revokeObjectURL(clip.url);setClip(null);setPhase('idle');setProgress(100);setMessage('录音已保存并关联到此事项。');
  }catch(error){setPhase('preview');setMessage(error instanceof Error?error.message:'添加录音失败；片段已保留，可重试。')}
 };
 if(variant==='flat'&&phase==='idle'&&!clip)return <section className={`${styles.panel} ${styles.flat}`} aria-label="页面录音" hidden/>;
 return <section className={`${styles.panel} ${variant==='flat'?styles.flat:''} ${variant==='flat'&&(clip||['requesting','recording','finalizing','uploading'].includes(phase))?styles.flatWide:''}`} aria-label="页面录音">
  <div className={styles.head}><div><h3>{variant==='flat'?'录音':'录音附件'}</h3><span>点击录制后才申请麦克风；最长5分钟，不在后台持续录音。</span></div><span className={`${styles.indicator} ${phase==='recording'?styles.live:''}`}>{phase==='recording'?'● 录音中':phase==='requesting'?'请求权限…':phase==='finalizing'?'正在收尾…':phase==='uploading'?'上传中…':'就绪'}</span></div>
  <div className={styles.controls}>{phase==='idle'||phase==='error'?<button type="button" onClick={()=>void start()}>{variant==='flat'?'● 录音':'录制语音'}</button>:phase==='recording'?<><strong className={styles.timer} aria-live="off">{prettyTime(elapsed)} / 05:00</strong><button type="button" onClick={stop}>停止</button><button type="button" className={styles.quiet} onClick={cancel}>取消录音</button></>:phase==='requesting'?<button type="button" className={styles.quiet} onClick={()=>{requestCancelRef.current=true;setMessage('已请求取消；若浏览器权限框仍显示，请选择拒绝。')}}>取消</button>:phase==='finalizing'?<span>正在取得最后音频片段并释放麦克风…</span>:mode==='staged'&&clip?.asset?<><span>已暂存，待提交</span><button type="button" className={styles.quiet} onClick={recordAnother}>再录一段</button><button type="button" className={styles.quiet} onClick={cancel}>移除此段</button></>:<><button type="button" onClick={()=>void upload()} disabled={phase==='uploading'}>{phase==='uploading'?'添加中…':mode==='staged'?'暂存录音':'添加录音'}</button><button type="button" className={styles.quiet} onClick={()=>void start()} disabled={phase==='uploading'}>重录</button><button type="button" className={styles.quiet} onClick={cancel} disabled={phase==='uploading'}>放弃</button></>}</div>
  {clip&&<div className={styles.preview}><audio controls preload="metadata" src={clip.url} aria-label="试听未提交录音"/><span>{prettyTime(clip.durationMs)} · {(clip.blob.size/1024/1024).toFixed(2)} MiB · {clip.mimeType||'未知格式'} · 本机未提交</span>{phase==='uploading'&&<div className={styles.progress}><progress max={100} value={progress}/><span>{progress}%</span><button type="button" className={styles.quiet} onClick={()=>uploadRef.current?.abort()}>取消上传</button></div>}</div>}
  {message&&<p className={phase==='error'?styles.error:styles.status} role="status">{message}</p>}
 </section>;
});
export default AudioRecorder;
