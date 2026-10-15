import { createHash, randomUUID } from 'node:crypto';
import { BODY_MAX_CODE_POINTS, codePointLength, prepareBody, type DescriptionFormat } from '@/domain/body';
import { rawDb, type AppDatabase } from '@/server/db/client';
import { MutationConflict } from './errors';
import { resolveTaskPlacement } from './placement';
import { assertAncestorsActive, assertNoActiveDescendants } from './structure-guards';

export { MutationConflict } from './errors';

type MutationInput = { userId: string; requestId: string; method: string; resource: string; body: unknown };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const payloadHash = (input: MutationInput) => createHash('sha256').update(canonical({ method: input.method.toUpperCase(), resource: input.resource, body: input.body })).digest('hex');

/** Serializes competing mutations before checking the replay key, then commits domain/event/replay rows together. */
export function runIdempotentMutation<T>(database: AppDatabase, input: MutationInput, work: (sql: ReturnType<typeof rawDb>, now: string) => T) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new MutationConflict('requestId必须是UUID', 'INVALID_REQUEST_ID', 400, { fieldErrors: { requestId: '必须是UUID' } });
  }
  const sql = rawDb(database);
  const digest = payloadHash(input);
  return sql.transaction(() => {
    const prior = sql.prepare('SELECT payload_hash,response_json FROM mutation_requests WHERE user_id=? AND request_id=?').get(input.userId, input.requestId) as {payload_hash:string;response_json:string}|undefined;
    if (prior) {
      if (prior.payload_hash !== digest) throw new MutationConflict('requestId已用于其他请求', 'REQUEST_ID_REUSED');
      return { response: JSON.parse(prior.response_json) as T, replayed: true };
    }
    const now = new Date().toISOString();
    const response = work(sql, now);
    sql.prepare('INSERT INTO mutation_requests(user_id,request_id,payload_hash,response_json,created_at) VALUES(?,?,?,?,?)').run(input.userId,input.requestId,digest,JSON.stringify(response),now);
    return { response, replayed: false };
  }).immediate();
}

type CreateTaskInput = {
  userId:string; requestId:string; title:string; spaceId?:string; projectId?:string|null; processed?:boolean;
  assetIds?:string[]; description?:string; descriptionFormat?:DescriptionFormat; sourceUrl?:string|null; sourceLabel?:string|null;
};

function validateCaptureSource(sourceUrl:string|null|undefined,sourceLabel:string|null|undefined){
  const url=(sourceUrl??'').trim()||null;const label=(sourceLabel??'').trim()||null;
  if(url){let parsed:URL;try{parsed=new URL(url)}catch{throw new MutationConflict('来源URL无效','INVALID_SOURCE_URL',400,{fieldErrors:{sourceUrl:'必须是有效的http或https链接'}})}if(!['http:','https:'].includes(parsed.protocol)||url.length>2048)throw new MutationConflict('来源URL仅支持http/https且最多2048字符','INVALID_SOURCE_URL',400,{fieldErrors:{sourceUrl:'仅支持http/https，最多2048字符'}})}
  if(label&&[...label].length>200)throw new MutationConflict('来源名称最多200字符','INVALID_SOURCE_LABEL',400,{fieldErrors:{sourceLabel:'最多200字符'}});
  return {sourceUrl:url,sourceLabel:label};
}

function createTaskInside(sql:ReturnType<typeof rawDb>,now:string,input:CreateTaskInput){
  const taskId=randomUUID();
  if(!input.title.trim())throw new MutationConflict('标题不能为空','INVALID_TITLE',400,{fieldErrors:{title:'标题不能为空'}});
  const title=input.title.trim();if([...title].length>200)throw new MutationConflict('标题最多200个字符','INVALID_TITLE',400,{fieldErrors:{title:'标题最多200个字符'}});
  const description=input.description??'';
  const descriptionFormat=input.descriptionFormat??'plaintext';
  const prepared=prepareBody({description,format:descriptionFormat});
  if(codePointLength(prepared.description)>BODY_MAX_CODE_POINTS)throw new MutationConflict('正文最多20000字符','INVALID_INPUT',400,{fieldErrors:{description:'最多20000字符'}});
  const projectId=input.projectId??null;let spaceId:string;
  if(projectId){const project=sql.prepare('SELECT id,space_id FROM projects WHERE id=? AND owner_user_id=?').get(projectId,input.userId) as {id:string;space_id:string}|undefined;if(!project)throw new MutationConflict('项目不存在','PROJECT_NOT_FOUND',404,{fieldErrors:{projectId:'项目不存在'}});if(input.spaceId&&input.spaceId!==project.space_id)throw new MutationConflict('项目必须与事项同空间','PROJECT_SPACE_MISMATCH',409,{fieldErrors:{projectId:'项目必须与事项同空间'}});spaceId=resolveTaskPlacement(sql,input.userId,project.space_id,projectId).spaceId;
  }else if(input.spaceId){spaceId=resolveTaskPlacement(sql,input.userId,input.spaceId,null).spaceId;}else{const space=sql.prepare('SELECT id FROM spaces WHERE owner_user_id=? AND is_default=1 AND archived_at IS NULL LIMIT 1').get(input.userId) as {id:string}|undefined;if(!space)throw new MutationConflict('默认空间不存在或不可用','SPACE_NOT_FOUND',404);spaceId=space.id;}
  const isProcessed=projectId?(input.processed??true):Boolean(input.processed);const {sourceUrl,sourceLabel}=validateCaptureSource(input.sourceUrl,input.sourceLabel);
  const rootCount=(sql.prepare('SELECT count(*) n FROM tasks WHERE space_id=? AND parent_id IS NULL').get(spaceId) as {n:number}).n;const rootSortKey=String((rootCount+1)*1024).padStart(16,'0');
  const assetIds=input.assetIds??[];if(!Array.isArray(assetIds)||assetIds.length>10||new Set(assetIds).size!==assetIds.length)throw new MutationConflict('媒体附件列表无效','INVALID_MEDIA_LIST',400,{fieldErrors:{assetIds:'最多10项且不能重复'}});
  for(const assetId of assetIds){const asset=sql.prepare("SELECT id FROM assets WHERE id=? AND owner_user_id=? AND status='ready'").get(assetId,input.userId);if(!asset)throw new MutationConflict('媒体附件不存在或不可用','ASSET_NOT_FOUND',404);if(sql.prepare('SELECT 1 FROM task_asset_links WHERE asset_id=?').get(assetId))throw new MutationConflict('媒体附件已被其他内容关联','ASSET_ALREADY_LINKED',409);}
  sql.prepare(`INSERT INTO tasks(id,owner_user_id,space_id,project_id,title,description,description_plain,description_format,source_url,source_label,priority,next_action,result_note,status,is_processed,is_watched,responsible_kind,action_kind,waiting_reason,blocked_reason,cancellation_reason,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,'none','','','todo',?,0,'self','self','','','',?,?,1)`).run(taskId,input.userId,spaceId,projectId,title,prepared.description,prepared.descriptionPlain,descriptionFormat,sourceUrl,sourceLabel,isProcessed?1:0,now,now);
  sql.prepare('UPDATE tasks SET sort_key=? WHERE id=?').run(rootSortKey,taskId);sql.prepare('UPDATE spaces SET structure_version=structure_version+1,updated_at=? WHERE id=?').run(now,spaceId);
  if(prepared.description){sql.prepare(`INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,?,?,?,1,?,?)`).run(randomUUID(),input.userId,taskId,descriptionFormat,prepared.description,prepared.descriptionPlain,input.requestId,now)}
  for(const assetId of assetIds)sql.prepare("INSERT INTO task_asset_links(id,owner_user_id,task_id,asset_id,role,created_at) VALUES(?,?,?,?,'attachment',?)").run(randomUUID(),input.userId,taskId,assetId,now);
  const response={id:taskId,title,spaceId,projectId,status:'todo',isProcessed,version:1,createdAt:now,...(assetIds.length?{attachedAssetIds:assetIds}:{}),...(sourceUrl?{sourceUrl,sourceLabel}:{}),...(prepared.description?{description:prepared.description,descriptionFormat}: {})};
  const summary={schemaVersion:1,changes:{title:{from:null,to:title},...(prepared.description?{description:{format:descriptionFormat,length:codePointLength(prepared.description)}}:{}),...(sourceUrl?{sourceUrl:{from:null,to:sourceUrl}}:{}),...(assetIds.length?{attachmentCount:assetIds.length}:{})}};
  sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,taskId,input.userId,'task_created',JSON.stringify(summary),now,input.requestId);
  return response;
}

function syncRootProjectMirror(sql:ReturnType<typeof rawDb>,userId:string,taskId:string,fields:{title:string;description:string;descriptionPlain:string;status:string},now:string){
  const project=sql.prepare('SELECT id,space_id,name,description,status,is_paused FROM projects WHERE root_task_id=? AND owner_user_id=?').get(taskId,userId) as {id:string;space_id:string;name:string;description:string;status:string;is_paused:number}|undefined;
  if(!project)return;
  if(fields.title!==project.name){const duplicate=sql.prepare('SELECT id FROM projects WHERE space_id=? AND name=? AND id<>?').get(project.space_id,fields.title,project.id);if(duplicate)throw new MutationConflict('同一空间内已有同名项目','NAME_TAKEN',409,{fieldErrors:{title:'同一空间内已有同名项目'}})}
  const paused=(fields.status==='done'||fields.status==='cancelled')?0:project.is_paused;
  const status=fields.status==='done'?'completed':fields.status==='cancelled'?'cancelled':paused?'paused':'active';
  if(project.name===fields.title&&project.description===fields.description&&project.status===status&&project.is_paused===paused)return;
  sql.prepare('UPDATE projects SET name=?,description=?,status=?,is_paused=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=?').run(fields.title,fields.description,status,paused,now,project.id,userId);
}

export function createTaskMutation(database:AppDatabase,input:MutationInput & CreateTaskInput){
  return runIdempotentMutation(database,input,(sql,now)=>createTaskInside(sql,now,input));
}

export function createTaskBatchMutation(database:AppDatabase,input:MutationInput & {spaceId?:string;projectId?:string|null;rows:Array<{title:string;description?:string;sourceUrl?:string|null;sourceLabel?:string|null;assetIds?:string[]}>}){
  return runIdempotentMutation(database,input,(sql,now)=>{
    if(!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>50)throw new MutationConflict('每批需1到50条事项','INVALID_CAPTURE_BATCH',400,{fieldErrors:{rows:'每批需1到50条'}});
    const batchId=randomUUID();
    const digest=payloadHash(input);
    sql.prepare('INSERT INTO capture_batches(id,owner_user_id,request_id,payload_hash,response_json,created_at) VALUES(?,?,?,?,?,?)').run(batchId,input.userId,input.requestId,digest,'{}',now);
    const items=input.rows.map((row,sequence)=>{
      const created=createTaskInside(sql,now,{userId:input.userId,requestId:input.requestId,title:row.title,description:row.description??'',spaceId:input.spaceId,projectId:input.projectId,sourceUrl:row.sourceUrl,sourceLabel:row.sourceLabel,assetIds:row.assetIds??[]});
      sql.prepare('INSERT INTO capture_batch_items(id,batch_id,owner_user_id,sequence,task_id,title) VALUES(?,?,?,?,?,?)').run(randomUUID(),batchId,input.userId,sequence,created.id,created.title);
      return {sequence,...created};
    });
    const response={batchId,items};
    sql.prepare('UPDATE capture_batches SET response_json=? WHERE id=? AND owner_user_id=?').run(JSON.stringify(response),batchId,input.userId);
    return response;
  });
}

/** M3-02：归属移动与收件箱整理标记；项目决定空间，跨空间移动需一次提交完成。 */
export function moveTaskPlacementMutation(database: AppDatabase, input: MutationInput & { taskId: string; expectedVersion: number; spaceId?: string; projectId?: string | null; isProcessed?: boolean }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
    const current = sql.prepare('SELECT id,title,space_id,project_id,section_id,is_processed,archived_at,version,updated_at FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(input.taskId, input.userId) as { id: string; title: string; space_id: string; project_id: string | null; section_id: string | null; is_processed: number; archived_at: string | null; version: number; updated_at: string } | undefined;
    if (!current) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    if (current.archived_at) throw new MutationConflict('已归档事项不可修改', 'TASK_ARCHIVED', 409);
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });
    const requestedProject = input.projectId === undefined ? current.project_id : input.projectId;
    let spaceId: string;
    let projectId: string | null;
    if (requestedProject) {
      const project = sql.prepare('SELECT id,space_id FROM projects WHERE id=? AND owner_user_id=?').get(requestedProject, input.userId) as { id: string; space_id: string } | undefined;
      if (!project) throw new MutationConflict('项目不存在', 'PROJECT_NOT_FOUND', 404, { fieldErrors: { projectId: '项目不存在' } });
      if (input.spaceId !== undefined && input.spaceId !== project.space_id) throw new MutationConflict('项目必须与事项同空间', 'PROJECT_SPACE_MISMATCH', 409, { fieldErrors: { projectId: '项目必须与事项同空间' } });
      spaceId = resolveTaskPlacement(sql, input.userId, project.space_id, requestedProject).spaceId;
      projectId = project.id;
    } else {
      spaceId = resolveTaskPlacement(sql, input.userId, input.spaceId ?? current.space_id, null).spaceId;
      projectId = null;
    }
    const isProcessed = input.isProcessed === undefined ? Boolean(current.is_processed) : input.isProcessed;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (spaceId !== current.space_id) changes.spaceId = { from: current.space_id, to: spaceId };
    if ((projectId ?? null) !== (current.project_id ?? null)) changes.projectId = { from: current.project_id, to: projectId };
    if (isProcessed !== Boolean(current.is_processed)) changes.isProcessed = { from: Boolean(current.is_processed), to: isProcessed };
    const clearSection = current.section_id !== null && (spaceId !== current.space_id || (projectId ?? null) !== (current.project_id ?? null));
    if (clearSection) changes.sectionId = { from: current.section_id, to: null };
    if (!Object.keys(changes).length) return { id: current.id, spaceId, projectId, isProcessed, version: current.version, updatedAt: current.updated_at, changed: false };
    const updated = sql.prepare('UPDATE tasks SET space_id=?,project_id=?,section_id=?,is_processed=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(spaceId, projectId, clearSection ? null : current.section_id, isProcessed ? 1 : 0, now, current.id, input.userId, input.expectedVersion);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });
    const version = input.expectedVersion + 1;
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, current.id, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, changes, version }), now, input.requestId);
    return { id: current.id, spaceId, projectId, sectionId: clearSection ? null : current.section_id, isProcessed, version, updatedAt: now, changed: true };
  });
}

export function updateTaskTitleMutation(database: AppDatabase, input: MutationInput & { taskId: string; expectedVersion: number; title: string }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    if (!input.title.trim()) throw new MutationConflict('标题不能为空','INVALID_TITLE',400,{fieldErrors:{title:'标题不能为空'}});
    if ([...input.title.trim()].length > 200) throw new MutationConflict('标题最多200个字符','INVALID_TITLE',400,{fieldErrors:{title:'标题最多200个字符'}});
    const current = sql.prepare('SELECT t.id,t.title,t.description,t.description_plain,t.status,t.version,t.updated_at,t.archived_at,s.archived_at AS space_archived_at,p.archived_at AS project_archived_at FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL').get(input.taskId,input.userId) as {id:string;title:string;description:string;description_plain:string;status:string;version:number;updated_at:string;archived_at:string|null;space_archived_at:string|null;project_archived_at:string|null}|undefined;
    if (!current) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if (current.archived_at) throw new MutationConflict('已归档事项不可修改','TASK_ARCHIVED',409);
    if (current.space_archived_at || current.project_archived_at) throw new MutationConflict('所属空间或项目已归档，不可修改','CONTAINER_ARCHIVED',409);
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,title:current.title,version:current.version,updatedAt:current.updated_at}});
    const update = sql.prepare('UPDATE tasks SET title=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(input.title.trim(),now,input.taskId,input.userId,input.expectedVersion);
    if (update.changes !== 1) {
      const latest=sql.prepare('SELECT id,title,version,updated_at FROM tasks WHERE id=? AND owner_user_id=?').get(input.taskId,input.userId) as typeof current;
      throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:latest?.version,current:latest?{id:latest.id,title:latest.title,version:latest.version,updatedAt:latest.updated_at}:undefined});
    }
    syncRootProjectMirror(sql,input.userId,input.taskId,{title:input.title.trim(),description:current.description,descriptionPlain:current.description_plain,status:current.status},now);
    const response = { id: input.taskId, title: input.title.trim(), version: input.expectedVersion + 1, updatedAt: now };
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,input.taskId,input.userId,'task_updated',JSON.stringify({ schemaVersion: 1, changes: { title: { from: current.title, to: input.title.trim() } }, version: response.version }),now,input.requestId);
    return response;
  });
}

export function markTaskProcessedMutation(database: AppDatabase, input: MutationInput & { taskId: string; expectedVersion: number }) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    const current = sql.prepare('SELECT id,title,is_processed,version,updated_at FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL AND archived_at IS NULL').get(input.taskId,input.userId) as {id:string;title:string;is_processed:number;version:number;updated_at:string}|undefined;
    if (!current) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,title:current.title,version:current.version,updatedAt:current.updated_at}});
    if (current.is_processed) throw new MutationConflict('事项已整理','ALREADY_PROCESSED',409,{currentVersion:current.version,current:{id:current.id,title:current.title,version:current.version,updatedAt:current.updated_at}});
    const updated = sql.prepare('UPDATE tasks SET is_processed=1,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=? AND is_processed=0').run(now,input.taskId,input.userId,input.expectedVersion);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,title:current.title,version:current.version,updatedAt:current.updated_at}});
    const response = { id: current.id, title: current.title, isProcessed: true, version: input.expectedVersion + 1, updatedAt: now };
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,current.id,input.userId,'task_processed_marked',JSON.stringify({schemaVersion:1,changes:{isProcessed:{from:false,to:true}},version:response.version}),now,input.requestId);
    return response;
  });
}

type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done' | 'cancelled';
const STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['in_progress', 'waiting', 'done', 'cancelled'],
  in_progress: ['todo', 'waiting', 'done', 'cancelled'],
  waiting: ['todo', 'in_progress', 'done', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};

export function transitionTaskMutation(database: AppDatabase, input: MutationInput & {
  taskId: string; expectedVersion: number; status: TaskStatus; waitingReason?: string; cancellationReason?: string;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    const current = sql.prepare(`SELECT t.id,t.status,t.version,t.title,t.is_processed,t.archived_at,t.completed_at,t.cancelled_at,t.waiting_reason,t.cancellation_reason,t.result_note,t.blocked_reason,t.follow_up_date,t.action_kind,t.action_contact_id,t.handling_mode,t.counterpart_name,t.updated_at,s.archived_at AS space_archived_at,p.archived_at AS project_archived_at,p.id AS project_id,p.root_task_id AS project_root_task_id,p.is_paused AS project_is_paused
      FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL`).get(input.taskId,input.userId) as {
        id:string;status:TaskStatus;version:number;title:string;is_processed:number;archived_at:string|null;completed_at:string|null;cancelled_at:string|null;waiting_reason:string;cancellation_reason:string;result_note:string;blocked_reason:string;follow_up_date:string|null;action_kind:string;action_contact_id:string|null;handling_mode:string;counterpart_name:string;updated_at:string;space_archived_at:string|null;project_archived_at:string|null;project_id:string|null;project_root_task_id:string|null;project_is_paused:number|null;
      }|undefined;
    if (!current) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    const reopening = (current.status === 'done' || current.status === 'cancelled') && input.status === 'todo';
    if (current.archived_at && !reopening) throw new MutationConflict('已归档事项只能重新打开','TASK_ARCHIVED',409);
    if (current.space_archived_at || current.project_archived_at) throw new MutationConflict('所属空间或项目已归档，请先取消归档','CONTAINER_ARCHIVED',409);
    if (!STATUS_TRANSITIONS[current.status]?.includes(input.status)) throw new MutationConflict(`不允许从${current.status}转换到${input.status}`,'INVALID_TRANSITION',409,{currentVersion:current.version,current:{id:current.id,status:current.status,version:current.version}});
    if (reopening) assertAncestorsActive(sql, input.userId, current.id);
    if (input.status === 'done' || input.status === 'cancelled') assertNoActiveDescendants(sql, input.userId, current.id);
    const waitingReason=input.status==='waiting'?(input.waitingReason??'').trim():'';
    const cancellationReason=input.status==='cancelled'?(input.cancellationReason??'').trim():'';
    if (input.status==='waiting' && !waitingReason) throw new MutationConflict('进入等待中必须填写等待原因','INVALID_INPUT',400,{fieldErrors:{waitingReason:'必填'}});
    if ([...waitingReason].length>1000) throw new MutationConflict('等待原因最多1000个字符','INVALID_INPUT',400,{fieldErrors:{waitingReason:'最多1000个字符'}});
    if (input.status==='cancelled' && !cancellationReason) throw new MutationConflict('取消事项必须填写取消原因','INVALID_INPUT',400,{fieldErrors:{cancellationReason:'必填'}});
    if ([...cancellationReason].length>1000) throw new MutationConflict('取消原因最多1000个字符','INVALID_INPUT',400,{fieldErrors:{cancellationReason:'最多1000个字符'}});

    const terminal=input.status==='done'||input.status==='cancelled';
    const changes:Record<string,{from:unknown;to:unknown}>={status:{from:current.status,to:input.status}};
    if (current.waiting_reason!==waitingReason) changes.waitingReason={from:current.waiting_reason,to:waitingReason};
    if (current.cancellation_reason!==cancellationReason) changes.cancellationReason={from:current.cancellation_reason,to:cancellationReason};
    const completedAt=input.status==='done'?now:null;
    const cancelledAt=input.status==='cancelled'?now:null;
    const followUpDate=terminal||reopening?null:current.follow_up_date;
    const actionKind=terminal?'none':reopening?'self':current.action_kind;
    const actionContactId=terminal||reopening?null:current.action_contact_id;
    const resultNote=reopening?'':current.result_note;
    const blockedReason=terminal||reopening?'':current.blocked_reason;
    const archivedAt=reopening?null:current.archived_at;
    const isProcessed=terminal?1:current.is_processed;
    const updated=sql.prepare(`UPDATE tasks SET status=?,waiting_reason=?,cancellation_reason=?,completed_at=?,cancelled_at=?,follow_up_date=?,action_kind=?,action_contact_id=?,result_note=?,blocked_reason=?,archived_at=?,is_processed=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?`).run(
      input.status,waitingReason,cancellationReason,completedAt,cancelledAt,followUpDate,actionKind,actionContactId,resultNote,blockedReason,archivedAt,isProcessed,now,input.taskId,input.userId,input.expectedVersion,
    );
    if(updated.changes!==1) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,status:current.status,version:current.version}});
    const version=input.expectedVersion+1;
    if(current.status==='waiting' && input.status!=='waiting') changes.waitingReason={from:current.waiting_reason,to:''};
    if(reopening) {
      // M3-03：重开默认自己处理并清空交给谁；M2 既有副作用（取消原因/结果/阻塞/跟进）保持
      sql.prepare("UPDATE tasks SET handling_mode='self',counterpart_name='' WHERE id=? AND owner_user_id=?").run(current.id,input.userId);
      changes.handlingMode={from:current.handling_mode,to:'self'};
      if(current.counterpart_name) changes.counterpartName={from:current.counterpart_name,to:''};
      changes.cancellationReason={from:current.cancellation_reason,to:''};
      changes.resultNote={from:current.result_note,to:''};
      changes.blockedReason={from:current.blocked_reason,to:''};
      if(current.archived_at) changes.archivedAt={from:current.archived_at,to:null};
    }
    if(terminal) {
      changes.action={from:{kind:current.action_kind,contactId:current.action_contact_id},to:{kind:actionKind,contactId:actionContactId}};
      if(current.follow_up_date) changes.followUpDate={from:current.follow_up_date,to:null};
      if(current.blocked_reason) changes.blockedReason={from:current.blocked_reason,to:''};
    }
    if(terminal) {
      const activeDelegation=sql.prepare('SELECT id,contact_id FROM delegations WHERE task_id=? AND ended_at IS NULL').get(current.id) as {id:string;contact_id:string}|undefined;
      if(activeDelegation) {
        sql.prepare('UPDATE delegations SET ended_at=?,end_reason=? WHERE id=? AND ended_at IS NULL').run(now,'task_ended',activeDelegation.id);
        sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,current.id,input.userId,'task_delegation_ended',JSON.stringify({schemaVersion:1,delegationId:activeDelegation.id,contactId:activeDelegation.contact_id,endReason:'task_ended'}),now,input.requestId);
      }
    }
    if(current.project_id&&current.project_root_task_id===current.id){const paused=(terminal?0:(current.project_is_paused??0));const projectStatus=input.status==='done'?'completed':input.status==='cancelled'?'cancelled':paused?'paused':'active';sql.prepare('UPDATE projects SET status=?,is_paused=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=?').run(projectStatus,paused,now,current.project_id,input.userId)}
    const response={id:current.id,status:input.status,version,updatedAt:now,waitingReason,cancellationReason,completedAt,cancelledAt,isProcessed:Boolean(isProcessed),archivedAt};
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,current.id,input.userId,'task_transitioned',JSON.stringify({schemaVersion:1,changes,version}),now,input.requestId);
    return response;
  });
}

const VALID_PRIORITIES=['none','low','medium','high'] as const;
function validateBusinessDate(value:string|null,label:string) {
  if(value===null) return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MutationConflict(`${label}必须是YYYY-MM-DD有效日期`,'INVALID_DATE',400,{fieldErrors:{[label]:`${label}必须是YYYY-MM-DD有效日期`}});
  const parsed=Date.parse(`${value}T00:00:00.000Z`);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value) throw new MutationConflict(`${label}不是有效日历日期`,'INVALID_DATE',400,{fieldErrors:{[label]:'不是有效日历日期'}});
}

export function updateTaskPlanningMutation(database:AppDatabase,input:MutationInput & {
  taskId:string;expectedVersion:number;priority:string;plannedDate:string|null;dueDate:string|null;followUpDate:string|null;nextAction:string;blockedReason:string;
}) {
  return runIdempotentMutation(database,input,(sql,now)=>{
    if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1) throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    const errors:Record<string,string>={}; let dateInvalid=false;
    if(!VALID_PRIORITIES.includes(input.priority as typeof VALID_PRIORITIES[number])) errors.priority='优先级无效';
    for(const [key,value] of [['plannedDate',input.plannedDate],['dueDate',input.dueDate],['followUpDate',input.followUpDate]] as const) {
      try {validateBusinessDate(value,key);} catch(error) {if(error instanceof MutationConflict){errors[key]=error.details.fieldErrors?.[key]??error.message;dateInvalid=true;} else throw error;}
    }
    if(typeof input.nextAction!=='string') errors.nextAction='必须是文本';
    else if([...input.nextAction.trim()].length>500) errors.nextAction='最多500个字符';
    if(typeof input.blockedReason!=='string') errors.blockedReason='必须是文本';
    else if([...input.blockedReason.trim()].length>1000) errors.blockedReason='最多1000个字符';
    if(Object.keys(errors).length) throw new MutationConflict(dateInvalid?'日期字段无效':'事项安排字段无效',dateInvalid?'INVALID_DATE':'INVALID_INPUT',400,{fieldErrors:errors});
    if(input.plannedDate&&input.dueDate&&input.plannedDate>input.dueDate) throw new MutationConflict('计划日期不能晚于截止日期','INVALID_DATE_RANGE',400,{fieldErrors:{plannedDate:'不能晚于截止日期'}});
    const current=sql.prepare('SELECT t.id,t.version,t.status,t.priority,t.planned_date,t.due_date,t.follow_up_date,t.next_action,t.blocked_reason,t.archived_at,t.updated_at,s.archived_at AS space_archived_at,p.archived_at AS project_archived_at FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL').get(input.taskId,input.userId) as {id:string;version:number;status:string;priority:string;planned_date:string|null;due_date:string|null;follow_up_date:string|null;next_action:string;blocked_reason:string;archived_at:string|null;updated_at:string;space_archived_at:string|null;project_archived_at:string|null}|undefined;
    if(!current) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if(current.archived_at) throw new MutationConflict('已归档事项不可修改','TASK_ARCHIVED',409);
    if(current.space_archived_at||current.project_archived_at) throw new MutationConflict('所属空间或项目已归档，不可修改','CONTAINER_ARCHIVED',409);
    if(current.version!==input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,version:current.version,updatedAt:current.updated_at}});
    if((current.status==='done'||current.status==='cancelled')&&input.followUpDate!==null) throw new MutationConflict('结束事项不能安排跟进，请先重新打开','TASK_ENDED',409,{fieldErrors:{followUpDate:'请先重新打开事项'}});
    const plannedDate=input.plannedDate; const dueDate=input.dueDate; const followUpDate=input.followUpDate; const nextAction=input.nextAction.trim(); const blockedReason=input.blockedReason.trim();
    const changes:Record<string,{from:unknown;to:unknown}>={};
    for(const [key,from,to] of [['priority',current.priority,input.priority],['plannedDate',current.planned_date,plannedDate],['dueDate',current.due_date,dueDate],['followUpDate',current.follow_up_date,followUpDate],['nextAction',current.next_action,nextAction],['blockedReason',current.blocked_reason,blockedReason]] as const) if(from!==to) changes[key]={from,to};
    const version=input.expectedVersion+1;
    sql.prepare('UPDATE tasks SET priority=?,planned_date=?,due_date=?,follow_up_date=?,next_action=?,blocked_reason=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(input.priority,plannedDate,dueDate,followUpDate,nextAction,blockedReason,now,input.taskId,input.userId,input.expectedVersion);
    const response={id:current.id,priority:input.priority,plannedDate,dueDate,followUpDate,nextAction,blockedReason,version,updatedAt:now};
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),input.userId,current.id,input.userId,'task_updated',JSON.stringify({schemaVersion:1,changes,version}),now,input.requestId);
    return response;
  });
}

export function appendTaskProgressMutation(database:AppDatabase,input:MutationInput & {
  taskId:string;expectedVersion:number;text:string;assetIds?:string[];
}) {
  return runIdempotentMutation(database,input,(sql,now)=>{
    if(!Number.isInteger(input.expectedVersion)||input.expectedVersion<1) throw new MutationConflict('expectedVersion无效','INVALID_VERSION',400,{fieldErrors:{expectedVersion:'必须是正整数'}});
    if(typeof input.text!=='string') throw new MutationConflict('进展内容必须是文本','INVALID_INPUT',400,{fieldErrors:{text:'必须是文本'}});
    const text=input.text.trim();
    const assetIds=input.assetIds??[];
    if(!Array.isArray(assetIds)||assetIds.length>10||new Set(assetIds).size!==assetIds.length) throw new MutationConflict('媒体附件列表无效','INVALID_MEDIA_LIST',400,{fieldErrors:{assetIds:'最多10项且不能重复'}});
    if(!text&&!assetIds.length) throw new MutationConflict('进展内容或附件至少填写一项','INVALID_INPUT',400,{fieldErrors:{text:'必填或添加附件'}});
    if([...text].length>5000) throw new MutationConflict('进展最多5000个字符','INVALID_INPUT',400,{fieldErrors:{text:'最多5000个字符'}});
    const current=sql.prepare('SELECT t.id,t.version,t.archived_at,t.updated_at,s.archived_at AS space_archived_at,p.archived_at AS project_archived_at FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL').get(input.taskId,input.userId) as {id:string;version:number;archived_at:string|null;updated_at:string;space_archived_at:string|null;project_archived_at:string|null}|undefined;
    if(!current) throw new MutationConflict('事项不存在','TASK_NOT_FOUND',404);
    if(current.archived_at) throw new MutationConflict('已归档事项只读，不能追加进展','TASK_ARCHIVED',409);
    if(current.space_archived_at||current.project_archived_at) throw new MutationConflict('所属空间或项目已归档，不可修改','CONTAINER_ARCHIVED',409);
    if(current.version!==input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,version:current.version,updatedAt:current.updated_at}});
    for(const assetId of assetIds){
      const asset=sql.prepare("SELECT id FROM assets WHERE id=? AND owner_user_id=? AND status='ready'").get(assetId,input.userId);
      if(!asset) throw new MutationConflict('媒体附件不存在或不可用','ASSET_NOT_FOUND',404);
      if(sql.prepare('SELECT 1 FROM task_asset_links WHERE asset_id=?').get(assetId)) throw new MutationConflict('媒体附件已被其他内容关联','ASSET_ALREADY_LINKED',409);
    }
    const version=input.expectedVersion+1;
    const updated=sql.prepare('UPDATE tasks SET updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(now,input.taskId,input.userId,input.expectedVersion);
    if(updated.changes!==1) throw new MutationConflict('事项版本已变化，请重新加载','VERSION_CONFLICT',409,{currentVersion:current.version,current:{id:current.id,version:current.version,updatedAt:current.updated_at}});
    const eventId=randomUUID();
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(eventId,input.userId,current.id,input.userId,'task_progress_appended',JSON.stringify({schemaVersion:1,text,version,attachmentCount:assetIds.length}),now,input.requestId);
    for(const assetId of assetIds) sql.prepare("INSERT INTO task_asset_links(id,owner_user_id,task_id,asset_id,role,created_at,progress_event_id) VALUES(?,?,?,?,'progress',?,?)").run(randomUUID(),input.userId,current.id,assetId,now,eventId);
    return {id:current.id,eventId,text,version,updatedAt:now,attachedAssetIds:assetIds};
  });
}

/** M3-04 处理安排：处理方式与交给谁成对更新；不改变状态与日期（PRD v0.6 10.2）。 */
export function updateTaskHandlingMutation(database: AppDatabase, input: MutationInput & {
  taskId: string; expectedVersion: number; handlingMode: string; counterpartName?: string;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
    const fieldErrors: Record<string, string> = {};
    if (input.handlingMode !== 'self' && input.handlingMode !== 'other') fieldErrors.handlingMode = '只支持 self 或 other';
    const current = sql.prepare('SELECT id,title,status,version,archived_at,updated_at,handling_mode,counterpart_name FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(input.taskId, input.userId) as { id: string; title: string; status: string; version: number; archived_at: string | null; updated_at: string; handling_mode: string; counterpart_name: string } | undefined;
    if (!current) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    let counterpartName = '';
    if (input.handlingMode === 'other') {
      if (typeof input.counterpartName !== 'string') fieldErrors.counterpartName = '必须是文本';
      else {
        counterpartName = input.counterpartName.trim();
        if (!counterpartName) fieldErrors.counterpartName = '交给别人时必须填写交给谁';
        else if ([...counterpartName].length > 100) fieldErrors.counterpartName = '最多100个字符';
      }
    }
    if (Object.keys(fieldErrors).length) throw new MutationConflict('处理安排字段无效', 'INVALID_INPUT', 400, { fieldErrors });
    if (current.archived_at) throw new MutationConflict('已归档事项不可修改', 'TASK_ARCHIVED', 409);
    if (current.status === 'done' || current.status === 'cancelled') throw new MutationConflict('结束事项不能改处理方式，请先重新打开', 'TASK_ENDED', 409, { fieldErrors: { handlingMode: '请先重新打开事项' } });
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (current.handling_mode !== input.handlingMode) changes.handlingMode = { from: current.handling_mode, to: input.handlingMode };
    if (current.counterpart_name !== counterpartName) changes.counterpartName = { from: current.counterpart_name, to: counterpartName };
    if (!Object.keys(changes).length) return { id: current.id, handlingMode: input.handlingMode, counterpartName, version: current.version, updatedAt: current.updated_at, changed: false };
    const updated = sql.prepare('UPDATE tasks SET handling_mode=?,counterpart_name=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?').run(input.handlingMode, counterpartName, now, current.id, input.userId, input.expectedVersion);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });
    const version = input.expectedVersion + 1;
    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.userId, current.id, input.userId, 'task_updated', JSON.stringify({ schemaVersion: 1, changes, version }), now, input.requestId);
    return { id: current.id, handlingMode: input.handlingMode, counterpartName, version, updatedAt: now, changed: true };
  });
}

/* -------------------------------------------------- M4-02 正文与安排统一保存 */

const CONTENT_FORMATS: readonly DescriptionFormat[] = ['plaintext', 'markdown_v1'];

type TaskContentRow = {
  id: string; title: string; description: string; description_plain:string; description_format: string;
  priority: string; planned_date: string | null; due_date: string | null; follow_up_date: string | null;
  next_action: string; blocked_reason: string; result_note: string; status: string;
  archived_at: string | null; version: number; updated_at: string;
  space_archived_at: string | null; project_archived_at: string | null;
};

/**
 * M4-02（PRD 7.1/7.2、技术设计 4/5.1/5.2）：标题、正文与可编辑安排在**同一次请求**里保存，
 * 只递增一次版本、只追加一条事件；正文变化时额外只追加一条 task_body_revisions。
 * 语义：未提供的字段保持原值，日期用 null 表示清空。
 * 旧纯文本升级为 markdown_v1 时先做转义（AT-28），普通编辑不做任何解释性改写。
 */
export function saveTaskContentMutation(database: AppDatabase, input: MutationInput & {
  taskId: string; expectedVersion: number;
  title?: string;
  description?: string; descriptionFormat?: string; convertFromPlaintext?: boolean;
  priority?: string; plannedDate?: string | null; dueDate?: string | null; followUpDate?: string | null;
  nextAction?: string; blockedReason?: string; resultNote?: string;
}) {
  return runIdempotentMutation(database, input, (sql, now) => {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new MutationConflict('expectedVersion无效', 'INVALID_VERSION', 400, { fieldErrors: { expectedVersion: '必须是正整数' } });
    const current = sql.prepare(`SELECT t.id,t.title,t.description,t.description_plain,t.description_format,t.priority,t.planned_date,t.due_date,t.follow_up_date,t.next_action,t.blocked_reason,t.result_note,t.status,t.archived_at,t.version,t.updated_at,
        s.archived_at AS space_archived_at,p.archived_at AS project_archived_at
      FROM tasks t JOIN spaces s ON s.id=t.space_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.id=? AND t.owner_user_id=? AND t.deleted_at IS NULL`).get(input.taskId, input.userId) as TaskContentRow | undefined;
    if (!current) throw new MutationConflict('事项不存在', 'TASK_NOT_FOUND', 404);
    if (current.archived_at) throw new MutationConflict('已归档事项不可修改', 'TASK_ARCHIVED', 409);
    if (current.space_archived_at || current.project_archived_at) throw new MutationConflict('所属空间或项目已归档，不可修改', 'CONTAINER_ARCHIVED', 409);
    if (current.version !== input.expectedVersion) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });

    const fieldErrors: Record<string, string> = {};
    let dateInvalid = false;
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    // 标题（PRD 5.2：去首尾空白后 1–200 码点）
    let title = current.title;
    if (input.title !== undefined) {
      if (typeof input.title !== 'string') fieldErrors.title = '必须是文本';
      else {
        const clean = input.title.trim();
        if (!clean) fieldErrors.title = '标题不能为空';
        else if (codePointLength(clean) > 200) fieldErrors.title = '标题最多200个字符';
        else title = clean;
      }
    }

    // 正文：唯一内容源 + 服务端派生搜索文本
    let body: ReturnType<typeof prepareBody> | null = null;
    if (input.description !== undefined) {
      if (typeof input.description !== 'string') fieldErrors.description = '必须是文本';
      else {
        const format = input.descriptionFormat ?? current.description_format;
        if (!CONTENT_FORMATS.includes(format as DescriptionFormat)) fieldErrors.descriptionFormat = '只支持 plaintext 或 markdown_v1';
        else {
          const convert = input.convertFromPlaintext === true && current.description_format === 'plaintext' && format === 'markdown_v1';
          const prepared = prepareBody({ description: input.description, format: format as DescriptionFormat, convertFromPlaintext: convert });
          if (codePointLength(prepared.description) > BODY_MAX_CODE_POINTS) fieldErrors.description = `正文最多${BODY_MAX_CODE_POINTS}个字符`;
          else body = prepared;
        }
      }
    }

    // 可编辑安排（未提供即保持原值；日期 null 表示清空）
    const priority = input.priority !== undefined ? input.priority : current.priority;
    const plannedDate = input.plannedDate !== undefined ? input.plannedDate : current.planned_date;
    const dueDate = input.dueDate !== undefined ? input.dueDate : current.due_date;
    const followUpDate = input.followUpDate !== undefined ? input.followUpDate : current.follow_up_date;
    let nextAction = current.next_action;
    let blockedReason = current.blocked_reason;
    let resultNote = current.result_note;
    if (input.priority !== undefined && !VALID_PRIORITIES.includes(input.priority as typeof VALID_PRIORITIES[number])) fieldErrors.priority = '优先级无效';
    for (const entry of [
      { key: 'plannedDate' as const, value: plannedDate, provided: input.plannedDate !== undefined },
      { key: 'dueDate' as const, value: dueDate, provided: input.dueDate !== undefined },
      { key: 'followUpDate' as const, value: followUpDate, provided: input.followUpDate !== undefined },
    ]) {
      if (!entry.provided) continue;
      try { validateBusinessDate(entry.value, entry.key); }
      catch (error) {
        if (error instanceof MutationConflict) { fieldErrors[entry.key] = error.details.fieldErrors?.[entry.key] ?? error.message; dateInvalid = true; } else throw error;
      }
    }
    if (input.nextAction !== undefined) {
      if (typeof input.nextAction !== 'string') fieldErrors.nextAction = '必须是文本';
      else { nextAction = input.nextAction.trim(); if (codePointLength(nextAction) > 500) fieldErrors.nextAction = '最多500个字符'; }
    }
    if (input.blockedReason !== undefined) {
      if (typeof input.blockedReason !== 'string') fieldErrors.blockedReason = '必须是文本';
      else { blockedReason = input.blockedReason.trim(); if (codePointLength(blockedReason) > 1000) fieldErrors.blockedReason = '最多1000个字符'; }
    }
    if (input.resultNote !== undefined) {
      if (typeof input.resultNote !== 'string') fieldErrors.resultNote = '必须是文本';
      else { resultNote = input.resultNote.trim(); if (codePointLength(resultNote) > 5000) fieldErrors.resultNote = '最多5000个字符'; }
    }
    if (plannedDate && dueDate && plannedDate > dueDate) { fieldErrors.plannedDate = '不能晚于截止日期'; dateInvalid = true; }
    if ((current.status === 'done' || current.status === 'cancelled') && input.followUpDate !== undefined && input.followUpDate !== null) fieldErrors.followUpDate = '请先重新打开事项';
    if (Object.keys(fieldErrors).length) throw new MutationConflict(dateInvalid ? '日期字段无效' : '正文与安排字段无效', dateInvalid ? 'INVALID_DATE' : 'INVALID_INPUT', 400, { fieldErrors });

    const nextDescription = body ? body.description : current.description;
    const nextFormat = body ? body.descriptionFormat : current.description_format;
    // 相同正文重放不产生新版本与新修订（客户端只在脏时才提交）
    const descriptionChanged = Boolean(body) && (nextDescription !== current.description || nextFormat !== current.description_format);

    if (!descriptionChanged && title === current.title && priority === current.priority && plannedDate === current.planned_date
      && dueDate === current.due_date && followUpDate === current.follow_up_date
      && nextAction === current.next_action && blockedReason === current.blocked_reason && resultNote === current.result_note) {
      return {
        id: current.id, changed: false, version: current.version, updatedAt: current.updated_at, title: current.title,
        description: current.description, descriptionFormat: current.description_format,
        priority: current.priority, plannedDate: current.planned_date, dueDate: current.due_date, followUpDate: current.follow_up_date,
        nextAction: current.next_action, blockedReason: current.blocked_reason, resultNote: current.result_note, body: null,
      };
    }

    if (title !== current.title) changes.title = { from: current.title, to: title };
    if (descriptionChanged && body) changes.description = { from: codePointLength(current.description), to: codePointLength(body.description) };
    if (priority !== current.priority) changes.priority = { from: current.priority, to: priority };
    if (plannedDate !== current.planned_date) changes.plannedDate = { from: current.planned_date, to: plannedDate };
    if (dueDate !== current.due_date) changes.dueDate = { from: current.due_date, to: dueDate };
    if (followUpDate !== current.follow_up_date) changes.followUpDate = { from: current.follow_up_date, to: followUpDate };
    if (nextAction !== current.next_action) changes.nextAction = { from: current.next_action, to: nextAction };
    if (blockedReason !== current.blocked_reason) changes.blockedReason = { from: current.blocked_reason, to: blockedReason };
    if (resultNote !== current.result_note) changes.resultNote = { from: current.result_note, to: resultNote };

    const version = input.expectedVersion + 1;
    const updated = body
      ? sql.prepare('UPDATE tasks SET title=?,description=?,description_plain=?,description_format=?,priority=?,planned_date=?,due_date=?,follow_up_date=?,next_action=?,blocked_reason=?,result_note=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?')
        .run(title, nextDescription, body.descriptionPlain, nextFormat, priority, plannedDate, dueDate, followUpDate, nextAction, blockedReason, resultNote, now, current.id, input.userId, input.expectedVersion)
      : sql.prepare('UPDATE tasks SET title=?,priority=?,planned_date=?,due_date=?,follow_up_date=?,next_action=?,blocked_reason=?,result_note=?,updated_at=?,version=version+1 WHERE id=? AND owner_user_id=? AND version=?')
        .run(title, priority, plannedDate, dueDate, followUpDate, nextAction, blockedReason, resultNote, now, current.id, input.userId, input.expectedVersion);
    if (updated.changes !== 1) throw new MutationConflict('事项版本已变化，请重新加载', 'VERSION_CONFLICT', 409, { currentVersion: current.version, current: { id: current.id, title: current.title, version: current.version, updatedAt: current.updated_at } });

    syncRootProjectMirror(sql,input.userId,current.id,{title,description:nextDescription,descriptionPlain:body?body.descriptionPlain:current.description_plain,status:current.status},now);

    // 正文修订只追加，来源版本 = 本次新版本（技术设计 5.2、AT-31）
    let revisionId: string | null = null;
    if (descriptionChanged && body) {
      revisionId = randomUUID();
      sql.prepare('INSERT INTO task_body_revisions(id,owner_user_id,task_id,format,content,content_plain,task_version,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(revisionId, input.userId, current.id, body.descriptionFormat, body.description, body.descriptionPlain, version, input.requestId, now);
    }

    sql.prepare('INSERT INTO task_events(id,owner_user_id,task_id,actor_user_id,type,payload_json,occurred_at,request_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), input.userId, current.id, input.userId, 'task_updated', JSON.stringify({
        schemaVersion: 1,
        changes,
        version,
        ...(descriptionChanged && body ? { body: { revisionId, format: body.descriptionFormat, length: codePointLength(body.description), plainLength: codePointLength(body.descriptionPlain), hasUnsupportedSyntax: body.hasUnsupportedSyntax, hasTaskListSyntax: body.hasTaskListSyntax } } : {}),
      }), now, input.requestId);

    return {
      id: current.id, changed: true, version, updatedAt: now, title,
      description: nextDescription, descriptionFormat: nextFormat,
      priority, plannedDate, dueDate, followUpDate, nextAction, blockedReason, resultNote,
      body: descriptionChanged && body ? { revisionId, format: body.descriptionFormat, length: codePointLength(body.description), hasUnsupportedSyntax: body.hasUnsupportedSyntax, hasTaskListSyntax: body.hasTaskListSyntax } : null,
    };
  });
}
