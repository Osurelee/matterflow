/** 空间/项目路由共用外壳（M3-01）：统一 Origin、登录、字段校验与错误映射。 */
import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

type AppDatabase = ReturnType<typeof createDatabase>;
type FieldSpec = { type: 'uuid' | 'number' | 'string' | 'boolean'; required?: boolean };
type MutationResult = { response: unknown; replayed: boolean };

export function structureRead(handler: (db: AppDatabase, ownerId: string, request: Request) => unknown) {
  return async (request: Request) => {
    const requestId = apiRequestId();
    let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, requestId); }
    if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
    let db: AppDatabase; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
    try { return apiSuccess(handler(db, user.id, request), requestId); }
    catch (error) { return apiFailure(error, requestId); }
    finally { db.$client.close(); }
  };
}

export async function structureWrite(params: {
  request: Request;
  resource: string;
  fields: Record<string, FieldSpec>;
  run: (context: { db: AppDatabase; userId: string; requestId: string; method: string; resource: string; value: Record<string, unknown>; semantic: Record<string, unknown> }) => MutationResult;
}) {
  const fallbackId = apiRequestId();
  if (!originAllowed(params.request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user; try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(params.request); if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId: fallbackId, fieldErrors: { body: '必须是JSON对象' } });
  const value = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(value)) if (!(key in params.fields)) fieldErrors[key] = '不允许此字段';
  for (const [key, spec] of Object.entries(params.fields)) {
    const raw = value[key];
    if (raw === undefined || raw === null) { if (spec.required) fieldErrors[key] = '必填'; else if (raw === null) fieldErrors[key] = '不能为null'; continue; }
    if (spec.type === 'uuid' && !isRequestId(raw)) fieldErrors[key] = '必须是UUID';
    else if (spec.type === 'number' && typeof raw !== 'number') fieldErrors[key] = '必须是数字';
    else if (spec.type === 'string' && typeof raw !== 'string') fieldErrors[key] = '必须是文本';
    else if (spec.type === 'boolean' && typeof raw !== 'boolean') fieldErrors[key] = '必须是布尔值';
  }
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId: fallbackId, fieldErrors });
  const requestId = value.requestId as string;
  const semantic: Record<string, unknown> = {};
  for (const key of Object.keys(params.fields)) if (key !== 'requestId' && value[key] !== undefined) semantic[key] = value[key];
  let db: AppDatabase; try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const result = params.run({ db, userId: user.id, requestId, method: params.request.method, resource: params.resource, value, semantic });
    return apiSuccess(result.response, requestId, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}
