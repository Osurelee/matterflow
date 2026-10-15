import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from '@/server/services/errors';

const MEDIA_ROOT = process.env.TASKS_MEDIA_DIR || path.join(process.env.TASKS_DATA_DIR || path.join(homedir(), 'tasks', 'data'), 'media');
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
export type MediaKind = 'image' | 'file' | 'audio';
export type StagedAsset = { id: string; originalName: string; mimeType: string; byteSize: number; sha256: string; kind: MediaKind; contentUrl: string; durationMs: number | null };

function classify(name: string, mime: string, data: Buffer): { kind: MediaKind; mime: string; max: number } {
  const ext = path.extname(name).toLowerCase();
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', max: MAX_IMAGE };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { kind: 'image', mime: 'image/png', max: MAX_IMAGE };
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', max: MAX_IMAGE };
  if (data.length >= 5 && data.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'file', mime: 'application/pdf', max: MAX_FILE };
  const audioMime = new Map<string, string>([['audio/mpeg','mp3'],['audio/mp3','mp3'],['audio/wav','wav'],['audio/x-wav','wav'],['audio/ogg','ogg'],['audio/webm','webm'],['audio/mp4','mp4'],['audio/aac','aac']]);
  const audioExt: Record<string,string> = { '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.webm':'audio/webm','.m4a':'audio/mp4','.aac':'audio/aac' };
  const expected = audioExt[ext];
  if (expected && (mime === expected || (expected==='audio/mpeg' && mime==='audio/mp3') || (expected==='audio/wav' && mime==='audio/x-wav')) && audioMime.has(mime)) {
    const sniff = data.length > 12 && (data.toString('ascii',0,4)==='RIFF' || data.toString('ascii',0,4)==='OggS' || data.toString('ascii',0,4)==='fLaC' || data.toString('ascii',4,8)==='ftyp' || data.toString('ascii',0,3)==='ID3' || data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) || data[0]===0xff);
    if (sniff) return { kind: 'audio', mime: expected, max: MAX_AUDIO };
  }
  if (['.txt','.md','.markdown'].includes(ext) && (mime==='text/plain' || mime==='text/markdown' || mime==='application/octet-stream') && !data.includes(0)) {
    try { new TextDecoder('utf-8',{fatal:true}).decode(data); return {kind:'file',mime:ext==='.md'||ext==='.markdown'?'text/markdown':'text/plain',max:MAX_FILE}; } catch { /* reject invalid text encoding */ }
  }
  throw new MutationConflict('文件类型不支持或内容与类型不符','UNSUPPORTED_MEDIA',400);
}

export async function stageUpload(database: AppDatabase, ownerId: string, requestId: string, file: File, durationMs: number | null = null): Promise<StagedAsset> {
  const cleanName = path.basename(file.name || 'attachment').replace(/[\\/\0-\x1f\x7f]/g, '_').slice(0, 240) || 'attachment';
  if (!file.size || file.size > MAX_AUDIO) throw new MutationConflict('文件为空或超过25MiB','MEDIA_TOO_LARGE',413);
  const data = Buffer.from(await file.arrayBuffer());
  const valid = classify(cleanName, file.type.toLowerCase(), data);
  if (data.byteLength > valid.max) throw new MutationConflict(`该类文件不得超过${Math.round(valid.max/1024/1024)}MiB`,'MEDIA_TOO_LARGE',413);
  if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 300000 || valid.kind !== 'audio')) throw new MutationConflict('音频时长无效','INVALID_MEDIA_DURATION',400);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const sql = rawDb(database);
  const existing = sql.prepare('SELECT id,original_name,mime_type,byte_size,sha256,status,duration_ms FROM assets WHERE owner_user_id=? AND upload_request_id=?').get(ownerId,requestId) as Record<string,unknown>|undefined;
  if (existing) {
    if (existing.sha256 !== sha256 || existing.status !== 'ready') throw new MutationConflict('上传请求ID已用于不同文件，请为新上传生成新的请求ID','REQUEST_ID_REUSED',409);
    return {id:String(existing.id),originalName:String(existing.original_name),mimeType:String(existing.mime_type),byteSize:Number(existing.byte_size),sha256:String(existing.sha256),kind:valid.kind,contentUrl:`/api/assets/${existing.id}/content`,durationMs:(existing.duration_ms as number|null)??durationMs};
  }
  await mkdir(MEDIA_ROOT,{recursive:true,mode:0o700});
  await chmod(MEDIA_ROOT,0o700);
  const id=randomUUID(); const storageKey=randomUUID(); const temp=path.join(MEDIA_ROOT,`.${storageKey}.upload`); const target=path.join(MEDIA_ROOT,storageKey);
  await writeFile(temp,data,{flag:'wx',mode:0o600});
  try {
    await rename(temp,target);
    sql.prepare('INSERT INTO assets(id,owner_user_id,upload_request_id,original_name,mime_type,byte_size,sha256,storage_key,status,created_at,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,ownerId,requestId,cleanName,valid.mime,data.byteLength,sha256,storageKey,'ready',new Date().toISOString(),durationMs);
  } catch (error) {
    const e=error as {code?:string};
    if(e.code==='SQLITE_CONSTRAINT_UNIQUE') {
      const row=sql.prepare('SELECT id,original_name,mime_type,byte_size,sha256,duration_ms FROM assets WHERE owner_user_id=? AND upload_request_id=?').get(ownerId,requestId) as Record<string,unknown>|undefined;
      if(row && row.sha256===sha256) return {id:String(row.id),originalName:String(row.original_name),mimeType:String(row.mime_type),byteSize:Number(row.byte_size),sha256,kind:valid.kind,contentUrl:`/api/assets/${row.id}/content`,durationMs:(row.duration_ms as number|null)??durationMs};
    }
    throw error;
  }
  return {id,originalName:cleanName,mimeType:valid.mime,byteSize:data.byteLength,sha256,kind:valid.kind,contentUrl:`/api/assets/${id}/content`,durationMs};
}

export function listTaskAssets(database: AppDatabase, ownerId:string, taskId:string) {
  const sql=rawDb(database);
  const rows=sql.prepare(`SELECT a.id,a.original_name,a.mime_type,a.byte_size,a.sha256,a.duration_ms,a.created_at,l.role,l.id link_id FROM task_asset_links l JOIN assets a ON a.id=l.asset_id JOIN tasks t ON t.id=l.task_id WHERE l.owner_user_id=? AND l.task_id=? AND l.removed_at IS NULL AND l.role='attachment' AND a.status='ready' AND t.owner_user_id=? AND t.deleted_at IS NULL ORDER BY l.created_at,l.id`).all(ownerId,taskId,ownerId) as Array<Record<string,unknown>>;
  return rows.map(r=>({id:r.id,originalName:r.original_name,mimeType:r.mime_type,byteSize:r.byte_size,sha256:r.sha256,durationMs:r.duration_ms,createdAt:r.created_at,role:r.role,linkId:r.link_id,contentUrl:`/api/assets/${r.id}/content`}));
}

export function attachAsset(database:AppDatabase,ownerId:string,taskId:string,assetId:string,expectedVersion:number,requestId:string) {
  const sql=rawDb(database); const now=new Date().toISOString(); const linkId=randomUUID();
  return sql.transaction(()=>{
    const task=sql.prepare('SELECT version,archived_at,deleted_at FROM tasks WHERE id=? AND owner_user_id=?').get(taskId,ownerId) as Record<string,unknown>|undefined;
    if(!task || task.deleted_at) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if(task.archived_at) throw new MutationConflict('已归档事项不可添加附件','TASK_ARCHIVED',409);
    if(task.version!==expectedVersion) throw new MutationConflict('事项已更新，请刷新后重试','VERSION_CONFLICT',409,{currentVersion:Number(task.version)});
    const asset=sql.prepare("SELECT id FROM assets WHERE id=? AND owner_user_id=? AND status='ready'").get(assetId,ownerId);
    if(!asset) throw new MutationConflict('附件不存在或不可用','ASSET_NOT_FOUND',404);
    const old=sql.prepare("SELECT id FROM task_asset_links WHERE task_id=? AND asset_id=? AND role='attachment'").get(taskId,assetId);
    if(old) return {linkId:(old as {id:string}).id,version:Number(task.version),replayed:true};
    sql.prepare("INSERT INTO task_asset_links(id,owner_user_id,task_id,asset_id,role,created_at) VALUES(?,?,?,?,'attachment',?)").run(linkId,ownerId,taskId,assetId,now);
    const next=Number(task.version)+1;
    sql.prepare('UPDATE tasks SET version=?,updated_at=? WHERE id=? AND version=?').run(next,now,taskId,expectedVersion);
    sql.prepare("INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,'task_updated',?,?,?)").run(randomUUID(),ownerId,taskId,ownerId,JSON.stringify({schemaVersion:1,changes:{attachments:{from:null,to:{assetId}}}}),now,requestId);
    return {linkId,version:next,replayed:false};
  }).immediate();
}

export function removeTaskAsset(database:AppDatabase,ownerId:string,taskId:string,linkId:string,expectedVersion:number,requestId:string) {
  const sql=rawDb(database); const now=new Date().toISOString();
  return sql.transaction(()=>{
    const task=sql.prepare('SELECT version,archived_at,deleted_at FROM tasks WHERE id=? AND owner_user_id=?').get(taskId,ownerId) as Record<string,unknown>|undefined;
    if(!task || task.deleted_at) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if(task.archived_at) throw new MutationConflict('已归档事项不可移除附件','TASK_ARCHIVED',409);
    if(task.version!==expectedVersion) throw new MutationConflict('事项已更新，请刷新后重试','VERSION_CONFLICT',409,{currentVersion:Number(task.version)});
    const link=sql.prepare('SELECT id,asset_id FROM task_asset_links WHERE id=? AND task_id=? AND owner_user_id=? AND removed_at IS NULL').get(linkId,taskId,ownerId) as {id:string;asset_id:string}|undefined;
    if(!link) throw new MutationConflict('附件关联不存在','ATTACHMENT_NOT_FOUND',404);
    const body=sql.prepare('SELECT description FROM tasks WHERE id=?').get(taskId) as {description:string};
    if(body.description.includes(`asset:${link.asset_id}`)) throw new MutationConflict('正文仍引用此图片；请先从正文移除图片并保存，再移除此附件','ASSET_REFERENCED',409);
    sql.prepare('UPDATE task_asset_links SET removed_at=? WHERE id=?').run(now,linkId);
    const next=Number(task.version)+1;
    sql.prepare('UPDATE tasks SET version=?,updated_at=? WHERE id=? AND version=?').run(next,now,taskId,expectedVersion);
    sql.prepare("INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,'task_updated',?,?,?)").run(randomUUID(),ownerId,taskId,ownerId,JSON.stringify({schemaVersion:1,changes:{attachments:{from:{assetId:link.asset_id},to:null}}}),now,requestId);
    return {version:next};
  }).immediate();
}

export async function readAsset(database:AppDatabase,ownerId:string,assetId:string) {
  const sql=rawDb(database);
  const row=sql.prepare("SELECT a.storage_key,a.original_name,a.mime_type,a.byte_size,a.sha256 FROM assets a WHERE a.id=? AND a.owner_user_id=? AND a.status='ready' AND EXISTS(SELECT 1 FROM task_asset_links l WHERE l.asset_id=a.id AND l.owner_user_id=? AND l.removed_at IS NULL)").get(assetId,ownerId,ownerId) as Record<string,unknown>|undefined;
  if(!row) return null;
  const data=await readFile(path.join(MEDIA_ROOT,String(row.storage_key)));
  if(data.length!==Number(row.byte_size)||createHash('sha256').update(data).digest('hex')!==row.sha256) throw new Error('asset checksum mismatch');
  return {data,name:String(row.original_name),mime:String(row.mime_type),size:data.length};
}
