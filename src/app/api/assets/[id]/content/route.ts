import { currentUser } from '@/server/auth/session';
import { createDatabase } from '@/server/db/client';
import { readAsset } from '@/server/services/media';
import { apiError, apiFailure, apiRequestId } from '@/server/http/responses';
export const runtime='nodejs';type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){
 const rid=apiRequestId();let user;try{user=await currentUser()}catch(e){return apiFailure(e,rid)}if(!user)return apiError(401,'UNAUTHENTICATED','请先登录',{requestId:rid});
 const {id}=await params;const db=createDatabase();try{
  const asset=await readAsset(db,user.id,id);if(!asset)return apiError(404,'ASSET_NOT_FOUND','附件不存在',{requestId:rid});
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Type':asset.mime});
  if(!asset.mime.startsWith('image/')&&!asset.mime.startsWith('audio/'))headers.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
  const range=request.headers.get('range');
  if(range&&asset.mime.startsWith('audio/')){
   const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${asset.size}`,'Cache-Control':'no-store'}});
   let start=match[1]?Number(match[1]):0;let end=match[2]?Number(match[2]):asset.size-1;if(!match[1]&&match[2]){const suffix=Number(match[2]);start=Math.max(0,asset.size-suffix);end=asset.size-1}
   if(start>end||start>=asset.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${asset.size}`,'Cache-Control':'no-store'}});
   end=Math.min(end,asset.size-1);headers.set('Content-Range',`bytes ${start}-${end}/${asset.size}`);headers.set('Content-Length',String(end-start+1));return new Response(asset.data.subarray(start,end+1),{status:206,headers});
  }
  headers.set('Content-Length',String(asset.size));return new Response(asset.data,{status:200,headers});
 }catch(e){return apiFailure(e,rid)}finally{db.$client.close()}
}
