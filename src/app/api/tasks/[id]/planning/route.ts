import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { updateTaskPlanningMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
const dateValue=(value:unknown)=>value===null||typeof value==='string';
export async function PATCH(request:Request,{params}:Context) {
  const fallbackId=apiRequestId();
  if(!originAllowed(request)) return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallbackId});
  let user; try {user=await currentUser();} catch(error) {return apiFailure(error,fallbackId);}
  if(!user) return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallbackId});
  const parsed=await readJsonBody(request); if(!parsed.ok) return parsed.response;
  const {body,requestId}=parsed;
  if(!body||typeof body!=='object'||Array.isArray(body)) return apiError(400,'INVALID_INPUT','请求内容无效',{requestId,fieldErrors:{body:'必须是JSON对象'}});
  const value=body as Record<string,unknown>; const fieldErrors:Record<string,string>={};
  const allowed=['requestId','expectedVersion','priority','plannedDate','dueDate','followUpDate','nextAction','blockedReason'];
  for(const key of Object.keys(value)) if(!allowed.includes(key)) fieldErrors[key]='不允许此字段';
  if(!isRequestId(value.requestId)) fieldErrors.requestId='必须是UUID';
  if(typeof value.expectedVersion!=='number') fieldErrors.expectedVersion='必须是数字';
  if(typeof value.priority!=='string') fieldErrors.priority='必须是文本';
  for(const key of ['plannedDate','dueDate','followUpDate']) if(!dateValue(value[key])) fieldErrors[key]='必须是YYYY-MM-DD文本或null';
  if(typeof value.nextAction!=='string') fieldErrors.nextAction='必须是文本';
  if(typeof value.blockedReason!=='string') fieldErrors.blockedReason='必须是文本';
  if(Object.keys(fieldErrors).length) return apiError(400,'INVALID_INPUT','请求字段无效',{requestId,fieldErrors});
  const mutationRequestId=value.requestId as string;
  let id:string; try{id=(await params).id;}catch(error){return apiFailure(error,mutationRequestId);}
  let db:ReturnType<typeof createDatabase>; try{db=createDatabase();}catch(error){return apiFailure(error,mutationRequestId);}
  try {
    const bodyValue={expectedVersion:value.expectedVersion,priority:value.priority,plannedDate:value.plannedDate,dueDate:value.dueDate,followUpDate:value.followUpDate,nextAction:value.nextAction,blockedReason:value.blockedReason};
    const result=updateTaskPlanningMutation(db,{userId:user.id,requestId:mutationRequestId,method:'PATCH',resource:`/api/tasks/${id}/planning`,body:bodyValue,taskId:id,expectedVersion:value.expectedVersion as number,priority:value.priority as string,plannedDate:value.plannedDate as string|null,dueDate:value.dueDate as string|null,followUpDate:value.followUpDate as string|null,nextAction:value.nextAction as string,blockedReason:value.blockedReason as string});
    return apiSuccess(result.response,mutationRequestId,result.replayed?{'Idempotency-Replayed':'true'}:undefined);
  } catch(error) {return apiFailure(error,mutationRequestId);}
  finally {db.$client.close();}
}
