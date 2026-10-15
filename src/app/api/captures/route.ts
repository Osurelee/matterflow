import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { createTaskMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { BODY_JSON_LIMIT, readJsonBody } from '@/server/http/request';
export const runtime='nodejs';
export async function POST(request:Request){
 const fallback=apiRequestId();if(!originAllowed(request))return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
 let user;try{user=await currentUser()}catch(e){return apiFailure(e,fallback)}if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
 const parsed=await readJsonBody(request,BODY_JSON_LIMIT);if(!parsed.ok)return parsed.response;const {body,requestId}=parsed;
 if(!body||typeof body!=='object'||Array.isArray(body))return apiError(400,'INVALID_INPUT','请求内容无效',{requestId,fieldErrors:{body:'必须是JSON对象'}});
 const value=body as Record<string,unknown>;const errors:Record<string,string>={};const allowed=['requestId','title','description','descriptionFormat','sourceUrl','sourceLabel','spaceId','projectId','assetIds'];
 for(const key of Object.keys(value))if(!allowed.includes(key))errors[key]='不允许此字段';
 if(!isRequestId(value.requestId))errors.requestId='必须是UUID';if(typeof value.title!=='string'||!value.title.trim())errors.title='标题必填';if(value.description!==undefined&&typeof value.description!=='string')errors.description='必须是文本';
 if(value.descriptionFormat!==undefined&&value.descriptionFormat!=='plaintext'&&value.descriptionFormat!=='markdown_v1')errors.descriptionFormat='只支持 plaintext 或 markdown_v1';
 if(value.sourceUrl!==undefined&&value.sourceUrl!==null&&typeof value.sourceUrl!=='string')errors.sourceUrl='必须是文本或null';if(value.sourceLabel!==undefined&&value.sourceLabel!==null&&typeof value.sourceLabel!=='string')errors.sourceLabel='必须是文本或null';
 if(value.spaceId!==undefined&&typeof value.spaceId!=='string')errors.spaceId='必须是文本';if(value.projectId!==undefined&&value.projectId!==null&&typeof value.projectId!=='string')errors.projectId='必须是文本或null';
 if(value.assetIds!==undefined&&(!Array.isArray(value.assetIds)||value.assetIds.length>10||value.assetIds.some(x=>typeof x!=='string'||!isRequestId(x))||new Set(value.assetIds).size!==value.assetIds.length))errors.assetIds='最多10个唯一UUID';
 if(Object.keys(errors).length)return apiError(400,'INVALID_INPUT','捕获字段无效',{requestId,fieldErrors:errors});
 const bodyHash={title:value.title,spaceId:value.spaceId??null,projectId:value.projectId??null,...(value.description?{description:value.description,descriptionFormat:value.descriptionFormat}:{}),...(value.sourceUrl?{sourceUrl:value.sourceUrl}:{}),...(value.sourceLabel?{sourceLabel:value.sourceLabel}:{}),...((value.assetIds as string[]|undefined)?.length?{assetIds:value.assetIds}:{})};
 const db=createDatabase();try{const mutation=createTaskMutation(db,{userId:user.id,requestId:value.requestId as string,method:'POST',resource:'/api/captures',body:bodyHash,title:value.title as string,spaceId:value.spaceId as string|undefined,projectId:(value.projectId??null) as string|null,description:value.description as string|undefined,descriptionFormat:value.descriptionFormat as 'plaintext'|'markdown_v1'|undefined,sourceUrl:value.sourceUrl as string|null|undefined,sourceLabel:value.sourceLabel as string|null|undefined,assetIds:(value.assetIds??[]) as string[]});return apiSuccess(mutation.response,value.requestId as string,mutation.replayed?{'Idempotency-Replayed':'true'}:undefined,mutation.replayed?200:201)}catch(e){return apiFailure(e,value.requestId as string)}finally{db.$client.close()}
}
