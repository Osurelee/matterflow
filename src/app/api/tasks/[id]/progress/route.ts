import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { appendTaskProgressMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,{params}:Context) {
  const fallbackId=apiRequestId();
  if(!originAllowed(request)) return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallbackId});
  let user; try {user=await currentUser();} catch(error) {return apiFailure(error,fallbackId);}
  if(!user) return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallbackId});
  const parsed=await readJsonBody(request); if(!parsed.ok) return parsed.response;
  const {body,requestId}=parsed;
  if(!body||typeof body!=='object'||Array.isArray(body)) return apiError(400,'INVALID_INPUT','请求内容无效',{requestId,fieldErrors:{body:'必须是JSON对象'}});
  const value=body as Record<string,unknown>; const fieldErrors:Record<string,string>={};
  for(const key of Object.keys(value)) if(!['requestId','expectedVersion','text','assetIds'].includes(key)) fieldErrors[key]='不允许此字段';
  if(!isRequestId(value.requestId)) fieldErrors.requestId='必须是UUID';
  if(typeof value.expectedVersion!=='number') fieldErrors.expectedVersion='必须是数字';
  if(typeof value.text!=='string') fieldErrors.text='必须是文本';
  if(value.assetIds!==undefined&&(!Array.isArray(value.assetIds)||value.assetIds.length>10||value.assetIds.some((id)=>typeof id!=='string'||!isRequestId(id))||new Set(value.assetIds).size!==value.assetIds.length))fieldErrors.assetIds='最多10个唯一UUID';
  if(Object.keys(fieldErrors).length) return apiError(400,'INVALID_INPUT','请求字段无效',{requestId,fieldErrors});
  const mutationRequestId=value.requestId as string;
  let id:string; try{id=(await params).id;}catch(error){return apiFailure(error,mutationRequestId);}
  let db:ReturnType<typeof createDatabase>; try{db=createDatabase();}catch(error){return apiFailure(error,mutationRequestId);}
  try {
    const result=appendTaskProgressMutation(db,{userId:user.id,requestId:mutationRequestId,method:'POST',resource:`/api/tasks/${id}/progress`,body:{expectedVersion:value.expectedVersion,text:value.text,...((Array.isArray(value.assetIds)&&value.assetIds.length)?{assetIds:value.assetIds}:{})},taskId:id,expectedVersion:value.expectedVersion as number,text:value.text as string,assetIds:(value.assetIds??[]) as string[]});
    return apiSuccess(result.response,mutationRequestId,result.replayed?{'Idempotency-Replayed':'true'}:undefined);
  } catch(error) {return apiFailure(error,mutationRequestId);}
  finally {db.$client.close();}
}
