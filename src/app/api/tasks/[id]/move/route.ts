import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';
import { moveTaskTreeMutation } from '@/server/services/task-structure';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
const positive=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)&&v>=1;

export async function POST(request:Request,{params}:Context){
  const fallback=apiRequestId();
  if(!originAllowed(request))return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
  let user;try{user=await currentUser()}catch(e){return apiFailure(e,fallback)}
  if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
  const parsed=await readJsonBody(request);if(!parsed.ok)return parsed.response;
  const {body,requestId}=parsed;if(!body||typeof body!=='object'||Array.isArray(body))return apiError(400,'INVALID_INPUT','请求内容无效',{requestId});
  const v=body as Record<string,unknown>;const allowed=['requestId','expectedVersion','expectedStructureVersion','expectedOldParentStructureVersion','expectedSourceSpaceStructureVersion','expectedTargetStructureVersion','expectedTargetSpaceStructureVersion','targetParentId','targetSpaceId','position'];const errors:Record<string,string>={};
  for(const key of Object.keys(v))if(!allowed.includes(key))errors[key]='不支持此字段';
  if(!isRequestId(v.requestId))errors.requestId='必须是UUID';
  for(const key of ['expectedVersion','expectedStructureVersion'])if(!positive(v[key]))errors[key]='必须是正整数';
  for(const key of ['expectedOldParentStructureVersion','expectedSourceSpaceStructureVersion','expectedTargetStructureVersion','expectedTargetSpaceStructureVersion'])if(v[key]!==undefined&&!positive(v[key]))errors[key]='必须是正整数';
  if(typeof v.targetSpaceId!=='string'||!isRequestId(v.targetSpaceId))errors.targetSpaceId='必须是空间UUID';
  if(v.targetParentId!==null&&typeof v.targetParentId!=='string')errors.targetParentId='必须是事项UUID或null';
  if(typeof v.targetParentId==='string'&&!isRequestId(v.targetParentId))errors.targetParentId='必须是事项UUID或null';
  if(v.position!==undefined&&v.position!==null&&(!Number.isInteger(v.position)||Number(v.position)<0))errors.position='必须是非负整数或null';
  if(Object.keys(errors).length)return apiError(400,'INVALID_INPUT','请求字段无效',{requestId,fieldErrors:errors});
  let db;try{db=createDatabase()}catch(e){return apiFailure(e,requestId)}
  try{const id=(await params).id;const mutation=moveTaskTreeMutation(db,{userId:user.id,requestId,method:'POST',resource:`/api/tasks/${id}/move`,body:v,taskId:id,expectedVersion:v.expectedVersion as number,expectedStructureVersion:v.expectedStructureVersion as number,expectedOldParentStructureVersion:v.expectedOldParentStructureVersion as number|undefined,expectedSourceSpaceStructureVersion:v.expectedSourceSpaceStructureVersion as number|undefined,expectedTargetStructureVersion:v.expectedTargetStructureVersion as number|undefined,expectedTargetSpaceStructureVersion:v.expectedTargetSpaceStructureVersion as number|undefined,targetParentId:v.targetParentId as string|null,targetSpaceId:v.targetSpaceId as string,position:v.position as number|null|undefined});return apiSuccess(mutation.response,requestId,mutation.replayed?{'Idempotency-Replayed':'true'}:undefined)}catch(e){return apiFailure(e,requestId)}finally{db.$client.close()}
}
