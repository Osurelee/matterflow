import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { transitionTaskMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
const statuses=['todo','in_progress','waiting','done','cancelled'] as const;
export async function POST(request:Request,{params}:Context) {
  const fallbackId=apiRequestId();
  if(!originAllowed(request)) return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallbackId});
  let user; try {user=await currentUser();} catch(error) {return apiFailure(error,fallbackId);}
  if(!user) return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallbackId});
  const parsed=await readJsonBody(request); if(!parsed.ok) return parsed.response;
  const {body,requestId}=parsed;
  if(!body||typeof body!=='object'||Array.isArray(body)) return apiError(400,'INVALID_INPUT','请求内容无效',{requestId,fieldErrors:{body:'必须是JSON对象'}});
  const value=body as Record<string,unknown>; const fieldErrors:Record<string,string>={};
  for(const key of Object.keys(value)) if(!['requestId','expectedVersion','status','waitingReason','cancellationReason'].includes(key)) fieldErrors[key]='不允许此字段';
  if(!isRequestId(value.requestId)) fieldErrors.requestId='必须是UUID';
  if(typeof value.expectedVersion!=='number') fieldErrors.expectedVersion='必须是数字';
  if(typeof value.status!=='string'||!statuses.includes(value.status as typeof statuses[number])) fieldErrors.status='状态无效';
  if(value.waitingReason!==undefined&&typeof value.waitingReason!=='string') fieldErrors.waitingReason='必须是文本';
  if(value.cancellationReason!==undefined&&typeof value.cancellationReason!=='string') fieldErrors.cancellationReason='必须是文本';
  if(Object.keys(fieldErrors).length) return apiError(400,'INVALID_INPUT','请求字段无效',{requestId,fieldErrors});
  const mutationRequestId=value.requestId as string;
  let id:string; try{id=(await params).id;}catch(error){return apiFailure(error,mutationRequestId);}
  let db:ReturnType<typeof createDatabase>; try{db=createDatabase();}catch(error){return apiFailure(error,mutationRequestId);}
  try {
    const input={userId:user.id,requestId:mutationRequestId,method:'POST',resource:`/api/tasks/${id}/transition`,body:{expectedVersion:value.expectedVersion,status:value.status,waitingReason:value.waitingReason,cancellationReason:value.cancellationReason},taskId:id,expectedVersion:value.expectedVersion as number,status:value.status as typeof statuses[number],waitingReason:value.waitingReason as string|undefined,cancellationReason:value.cancellationReason as string|undefined};
    const result=transitionTaskMutation(db,input);
    return apiSuccess(result.response,mutationRequestId,result.replayed?{'Idempotency-Replayed':'true'}:undefined);
  } catch(error) {return apiFailure(error,mutationRequestId);}
  finally {db.$client.close();}
}
