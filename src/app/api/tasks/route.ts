import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { createTaskMutation } from '@/server/services/mutations';
import { listTasks, TASK_STATUS_VALUES, TASK_VIEWS, type TaskView } from '@/server/services/task-queries';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const requestId = apiRequestId();
  let user;
  try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
  const url = new URL(request.url);
  const requestedView = url.searchParams.get('view') ?? 'inbox';
  const viewValue = requestedView === 'follow_up' || requestedView === 'follow-up' ? 'followup' : requestedView;
  const fieldErrors: Record<string, string> = {};
  if (!TASK_VIEWS.includes(viewValue as TaskView)) fieldErrors.view = `只支持 ${TASK_VIEWS.join('/')}`;
  const limitValue = url.searchParams.get('limit');
  const offsetValue = url.searchParams.get('offset');
  const limit = limitValue === null ? 50 : Number(limitValue);
  const offset = offsetValue === null ? 0 : Number(offsetValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fieldErrors.limit = '必须是 1–100 的整数';
  if (!Number.isInteger(offset) || offset < 0) fieldErrors.offset = '必须是非负整数';
  const statusValue = url.searchParams.get('status') ?? undefined;
  if (statusValue !== undefined && !(TASK_STATUS_VALUES as readonly string[]).includes(statusValue)) fieldErrors.status = `只支持 ${TASK_STATUS_VALUES.join('/')}`;
  const includeEndedValue = url.searchParams.get('includeEnded');
  if (includeEndedValue !== null && includeEndedValue !== 'true' && includeEndedValue !== 'false') fieldErrors.includeEnded = '只支持 true 或 false';
  const allowed = ['view','limit','offset','spaceId','projectId','status','includeEnded'];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) fieldErrors[key] = '不支持此查询参数';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '查询参数无效', { requestId, fieldErrors });
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    return apiSuccess(listTasks(db, user.id, {
      view: viewValue as TaskView, limit, offset, status: statusValue,
      spaceId: url.searchParams.get('spaceId') ?? undefined,
      projectId: url.searchParams.get('projectId') ?? undefined,
      includeEnded: includeEndedValue === 'true',
    }), requestId);
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}

export async function POST(request: Request) {
  const fallbackId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user;
  try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId, fieldErrors: { body: '必须是JSON对象' } });
  const value = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const allowed = new Set(['requestId','title','spaceId','projectId','assetIds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fieldErrors[key] = '不允许此字段';
  if (!isRequestId(value.requestId)) fieldErrors.requestId = '必须是UUID';
  if (typeof value.title !== 'string') fieldErrors.title = '必须是文本';
  if (value.spaceId !== undefined && typeof value.spaceId !== 'string') fieldErrors.spaceId = '必须是文本';
  if (value.projectId !== undefined && value.projectId !== null && typeof value.projectId !== 'string') fieldErrors.projectId = '必须是文本或null';
  if(value.assetIds!==undefined&&(!Array.isArray(value.assetIds)||value.assetIds.length>10||value.assetIds.some((id)=>typeof id!=='string'||!isRequestId(id))||new Set(value.assetIds).size!==value.assetIds.length))fieldErrors.assetIds='最多10个唯一UUID';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors });
  const mutationRequestId = value.requestId as string;
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, mutationRequestId); }
  try {
    const mutation = createTaskMutation(db, { userId: user.id, requestId: mutationRequestId, method: 'POST', resource: '/api/tasks', body: { title: value.title, spaceId: value.spaceId ?? null, projectId: value.projectId ?? null, ...((Array.isArray(value.assetIds)&&value.assetIds.length)?{assetIds:value.assetIds}:{}) }, title: value.title as string, spaceId: value.spaceId as string|undefined, projectId: (value.projectId ?? null) as string|null, assetIds:(value.assetIds??[]) as string[] });
    const headers = mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined;
    return apiSuccess(mutation.response, mutationRequestId, headers, mutation.replayed ? 200 : 201);
  } catch (error) { return apiFailure(error, mutationRequestId); }
  finally { db.$client.close(); }
}
