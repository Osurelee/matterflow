import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { listTaskEvents } from '@/server/services/task-queries';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';

export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context) {
  const requestId=apiRequestId();
  let user; try {user=await currentUser();} catch(error) {return apiFailure(error,requestId);}
  if(!user) return apiError(401,'UNAUTHENTICATED','请先登录',{requestId});
  const url=new URL(request.url);
  const rawLimit=Number(url.searchParams.get('limit')??'50');
  const limit=Number.isInteger(rawLimit)&&rawLimit>0?Math.min(rawLimit,100):50;
  const before=url.searchParams.get('before')??undefined;
  const beforeId=url.searchParams.get('beforeId')??undefined;
  const includeDeleted=url.searchParams.get('includeDeleted') === 'true';
  if(url.searchParams.has('includeDeleted') && !['true','false'].includes(url.searchParams.get('includeDeleted')!)) return apiError(400,'INVALID_INPUT','查询参数无效',{requestId,fieldErrors:{includeDeleted:'只支持 true 或 false'}});
  for(const key of url.searchParams.keys()) if(!['limit','before','beforeId','includeDeleted'].includes(key)) return apiError(400,'INVALID_INPUT','查询参数无效',{requestId,fieldErrors:{[key]:'不支持此查询参数'}});
  if(before&&!Number.isFinite(Date.parse(before))) return apiError(400,'INVALID_INPUT','分页游标无效',{requestId,fieldErrors:{before:'必须是时间戳'}});
  let id:string; try{id=(await params).id;}catch(error){return apiFailure(error,requestId);}
  let db:ReturnType<typeof createDatabase>; try{db=createDatabase();}catch(error){return apiFailure(error,requestId);}
  try {
    const page=listTaskEvents(db,user.id,id,limit,before,beforeId,includeDeleted);
    if(!page) return apiError(404,'TASK_NOT_FOUND','事项不存在',{requestId});
    return apiSuccess(page,requestId);
  } catch(error) {return apiFailure(error,requestId);}
  finally {db.$client.close();}
}
