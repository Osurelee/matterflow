import { currentUser, originAllowed } from '@/server/auth/session';
import { createDatabase, rawDb } from '@/server/db/client';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { removeTaskAsset } from '@/server/services/media';
import { readJsonBody } from '@/server/http/request';
export const runtime='nodejs';type Context={params:Promise<{id:string;linkId:string}>};
export async function DELETE(request:Request,{params}:Context){
 const fallback=apiRequestId();if(!originAllowed(request))return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
 let user;try{user=await currentUser()}catch(e){return apiFailure(e,fallback)}if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
 const parsed=await readJsonBody(request);if(!parsed.ok)return parsed.response;const b=parsed.body as Record<string,unknown>;
 if(!b||typeof b!=='object'||Array.isArray(b)||!isRequestId(b.requestId)||typeof b.expectedVersion!=='number'||!Number.isInteger(b.expectedVersion))return apiError(400,'INVALID_INPUT','requestId 与 expectedVersion 无效',{requestId:parsed.requestId});
 const {id,linkId}=await params;const db=createDatabase();try{return apiSuccess(removeTaskAsset(db,user.id,id,linkId,b.expectedVersion,b.requestId),b.requestId)}catch(e){return apiFailure(e,b.requestId)}finally{db.$client.close()}
}
