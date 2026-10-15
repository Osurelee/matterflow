import { currentUser, originAllowed } from '@/server/auth/session';
import { createDatabase } from '@/server/db/client';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { stageUpload } from '@/server/services/media';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
  const fallback=apiRequestId();
  if(!originAllowed(request)) return apiError(403,'BAD_ORIGIN','请求来源无效',{requestId:fallback});
  let user; try { user=await currentUser(); } catch(error) { return apiFailure(error,fallback); }
  if(!user) return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:fallback});
  const length=Number(request.headers.get('content-length')||0);
  if(length>26*1024*1024) return apiError(413,'BODY_TOO_LARGE','上传请求超过限制',{requestId:fallback});
  let form:FormData; try { form=await request.formData(); } catch { return apiError(400,'INVALID_MULTIPART','上传表单无效',{requestId:fallback}); }
  const requestId=form.get('requestId'); const file=form.get('file'); const rawDuration=form.get('durationMs');
  const durationMs=rawDuration===null?null:(typeof rawDuration==='string'&&/^\d+$/.test(rawDuration)?Number(rawDuration):NaN);
  if(!isRequestId(requestId)) return apiError(400,'INVALID_INPUT','上传请求ID必须是UUID',{requestId:fallback,fieldErrors:{requestId:'必须是UUID'}});
  if(rawDuration!==null&&(!Number.isInteger(durationMs)||Number(durationMs)<1||Number(durationMs)>300000))return apiError(400,'INVALID_INPUT','音频时长无效',{requestId,fieldErrors:{durationMs:'必须是1到300000毫秒'}});
  if(!(file instanceof File)) return apiError(400,'INVALID_INPUT','请选择一个文件',{requestId,fieldErrors:{file:'必须是文件'}});
  let db; try { db=createDatabase(); } catch(error) { return apiFailure(error,requestId); }
  try { const asset=await stageUpload(db,user.id,requestId,file,durationMs as number|null); return apiSuccess(asset,requestId,undefined,201); }
  catch(error) { return apiFailure(error,requestId); }
  finally { db.$client.close(); }
}
