import { currentUser, originAllowed } from '@/server/auth/session';
import { createDatabase, rawDb } from '@/server/db/client';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { attachAsset, listTaskAssets } from '@/server/services/media';
import { readJsonBody } from '@/server/http/request';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,{params}:Context) {
 const rid=apiRequestId(); let user; try{user=await currentUser()}catch(e){return apiFailure(e,rid)}
 if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:rid});
 const {id}=await params; const db=createDatabase(); try {
  const task=rawDb(db).prepare('SELECT 1 FROM tasks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL').get(id,user.id);
  if(!task)return apiError(404,'TASK_NOT_FOUND','事项不存在',{requestId:rid});
  return apiSuccess({items:listTaskAssets(db,user.id,id)},rid);
 }catch(e){return apiFailure(e,rid)}finally{db.$client.close()}
}
export async function POST(request:Request,{params}:Context) {
 const fallback=apiRequestId(); if(!originAllowed(request))return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
 let user;try{user=await currentUser()}catch(e){return apiFailure(e,fallback)} if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
 const parsed=await readJsonBody(request);if(!parsed.ok)return parsed.response;
 if(!parsed.body||typeof parsed.body!=='object'||Array.isArray(parsed.body))return apiError(400,'INVALID_INPUT','请求内容无效',{requestId:parsed.requestId});
 const b=parsed.body as Record<string,unknown>;const errors:Record<string,string>={};
 if(!isRequestId(b.requestId))errors.requestId='必须是UUID'; if(typeof b.assetId!=='string')errors.assetId='必须是文本'; if(typeof b.expectedVersion!=='number'||!Number.isInteger(b.expectedVersion))errors.expectedVersion='必须是整数';
 for(const k of Object.keys(b))if(!['requestId','assetId','expectedVersion'].includes(k))errors[k]='不允许此字段';
 if(Object.keys(errors).length)return apiError(400,'INVALID_INPUT','请求字段无效',{requestId:parsed.requestId,fieldErrors:errors});
 const {id}=await params;const db=createDatabase();try{return apiSuccess(attachAsset(db,user.id,id,b.assetId as string,b.expectedVersion as number,b.requestId as string),b.requestId as string)}catch(e){return apiFailure(e,b.requestId as string)}finally{db.$client.close()}
}
