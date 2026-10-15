import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { createTaskBatchMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { BODY_JSON_LIMIT, readJsonBody } from '@/server/http/request';
export const runtime='nodejs';
export async function POST(request:Request){
 const fallback=apiRequestId();if(!originAllowed(request))return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
 let user;try{user=await currentUser()}catch(e){return apiFailure(e,fallback)}if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
 const parsed=await readJsonBody(request,BODY_JSON_LIMIT);if(!parsed.ok)return parsed.response;const {body,requestId}=parsed;
 if(!body||typeof body!=='object'||Array.isArray(body))return apiError(400,'INVALID_INPUT','请求内容无效',{requestId,fieldErrors:{body:'必须是JSON对象'}});
 const value=body as Record<string,unknown>;const errors:Record<string,string>={};
 for(const key of Object.keys(value))if(!['requestId','rows','spaceId','projectId','sourceUrl','sourceLabel'].includes(key))errors[key]='不允许此字段';
 if(!isRequestId(value.requestId))errors.requestId='必须是UUID';if(!Array.isArray(value.rows)||value.rows.length<1||value.rows.length>50)errors.rows='必须是1到50条预览事项';
 if(value.spaceId!==undefined&&typeof value.spaceId!=='string')errors.spaceId='必须是文本';if(value.projectId!==undefined&&value.projectId!==null&&typeof value.projectId!=='string')errors.projectId='必须是文本或null';
 if(value.sourceUrl!==undefined&&value.sourceUrl!==null&&typeof value.sourceUrl!=='string')errors.sourceUrl='必须是文本或null';if(value.sourceLabel!==undefined&&value.sourceLabel!==null&&typeof value.sourceLabel!=='string')errors.sourceLabel='必须是文本或null';
 if(Array.isArray(value.rows))value.rows.forEach((row,index)=>{if(!row||typeof row!=='object'||Array.isArray(row)){errors[`rows.${index}`]='必须是对象';return}const item=row as Record<string,unknown>;for(const key of Object.keys(item))if(key!=='title')errors[`rows.${index}.${key}`]='不允许此字段';if(typeof item.title!=='string'||!item.title.trim())errors[`rows.${index}.title`]='标题必填';if(typeof item.title==='string'&&[...item.title.trim()].length>200)errors[`rows.${index}.title`]='标题最多200字符'});
 if(Object.keys(errors).length)return apiError(400,'INVALID_INPUT','批量预览内容无效',{requestId,fieldErrors:errors});
 const rows=(value.rows as Array<{title:string}>).map(row=>({title:row.title.trim(),sourceUrl:value.sourceUrl as string|null|undefined,sourceLabel:value.sourceLabel as string|null|undefined}));
 const semantic={spaceId:value.spaceId??null,projectId:value.projectId??null,sourceUrl:value.sourceUrl??null,sourceLabel:value.sourceLabel??null,rows};
 const db=createDatabase();try{const mutation=createTaskBatchMutation(db,{userId:user.id,requestId:value.requestId as string,method:'POST',resource:'/api/capture-batches',body:semantic,spaceId:value.spaceId as string|undefined,projectId:(value.projectId??null) as string|null,rows});return apiSuccess(mutation.response,value.requestId as string,mutation.replayed?{'Idempotency-Replayed':'true'}:undefined,mutation.replayed?200:201)}catch(e){return apiFailure(e,value.requestId as string)}finally{db.$client.close()}
}
