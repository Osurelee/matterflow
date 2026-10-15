import { createDatabase } from '@/server/db/client';
import { currentUser, originAllowed } from '@/server/auth/session';
import { saveTaskContentMutation } from '@/server/services/mutations';
import { apiError, apiFailure, apiRequestId, apiSuccess, isRequestId } from '@/server/http/responses';
import { BODY_JSON_LIMIT, readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const dateValue = (value: unknown) => value === null || typeof value === 'string';

/**
 * M4-02（技术设计 5.1/5.2/9、PRD 7.1/7.2）：标题 + 正文 + 安排统一保存。
 * 请求体上限 128KiB（技术设计 5.3），语义正文 20,000 码点由服务层再校验。
 */
export async function PATCH(request: Request, { params }: Context) {
  const fallbackId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId: fallbackId });
  let user;
  try { user = await currentUser(); } catch (error) { return apiFailure(error, fallbackId); }
  if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: fallbackId });
  const parsed = await readJsonBody(request, BODY_JSON_LIMIT);
  if (!parsed.ok) return parsed.response;
  const { body, requestId } = parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError(400, 'INVALID_INPUT', '请求内容无效', { requestId, fieldErrors: { body: '必须是JSON对象' } });
  const value = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const allowed = ['requestId', 'expectedVersion', 'title', 'description', 'descriptionFormat', 'convertFromPlaintext', 'priority', 'plannedDate', 'dueDate', 'followUpDate', 'nextAction', 'blockedReason'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fieldErrors[key] = '不允许此字段';
  if (!isRequestId(value.requestId)) fieldErrors.requestId = '必须是UUID';
  if (typeof value.expectedVersion !== 'number') fieldErrors.expectedVersion = '必须是数字';
  if (value.title !== undefined && typeof value.title !== 'string') fieldErrors.title = '必须是文本';
  if (value.description !== undefined && typeof value.description !== 'string') fieldErrors.description = '必须是文本';
  if (value.descriptionFormat !== undefined && value.descriptionFormat !== 'plaintext' && value.descriptionFormat !== 'markdown_v1') fieldErrors.descriptionFormat = '只支持 plaintext 或 markdown_v1';
  if (value.convertFromPlaintext !== undefined && typeof value.convertFromPlaintext !== 'boolean') fieldErrors.convertFromPlaintext = '必须是布尔值';
  if (value.priority !== undefined && typeof value.priority !== 'string') fieldErrors.priority = '必须是文本';
  for (const key of ['plannedDate', 'dueDate', 'followUpDate']) if (value[key] !== undefined && !dateValue(value[key])) fieldErrors[key] = '必须是YYYY-MM-DD文本或null';
  if (value.nextAction !== undefined && typeof value.nextAction !== 'string') fieldErrors.nextAction = '必须是文本';
  if (value.blockedReason !== undefined && typeof value.blockedReason !== 'string') fieldErrors.blockedReason = '必须是文本';
  if (Object.keys(fieldErrors).length) return apiError(400, 'INVALID_INPUT', '请求字段无效', { requestId, fieldErrors });
  const mutationRequestId = value.requestId as string;
  let id: string;
  try { id = (await params).id; } catch (error) { return apiFailure(error, mutationRequestId); }
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, mutationRequestId); }
  try {
    const semantic = {
      expectedVersion: value.expectedVersion,
      ...(value.title !== undefined ? { title: value.title } : {}),
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(value.descriptionFormat !== undefined ? { descriptionFormat: value.descriptionFormat } : {}),
      ...(value.convertFromPlaintext !== undefined ? { convertFromPlaintext: value.convertFromPlaintext } : {}),
      ...(value.priority !== undefined ? { priority: value.priority } : {}),
      ...(value.plannedDate !== undefined ? { plannedDate: value.plannedDate } : {}),
      ...(value.dueDate !== undefined ? { dueDate: value.dueDate } : {}),
      ...(value.followUpDate !== undefined ? { followUpDate: value.followUpDate } : {}),
      ...(value.nextAction !== undefined ? { nextAction: value.nextAction } : {}),
      ...(value.blockedReason !== undefined ? { blockedReason: value.blockedReason } : {}),
    };
    const mutation = saveTaskContentMutation(db, {
      userId: user.id, requestId: mutationRequestId, method: 'PATCH', resource: `/api/tasks/${id}/content`, body: semantic,
      taskId: id, expectedVersion: value.expectedVersion as number,
      title: value.title as string | undefined,
      description: value.description as string | undefined,
      descriptionFormat: value.descriptionFormat as string | undefined,
      convertFromPlaintext: value.convertFromPlaintext as boolean | undefined,
      priority: value.priority as string | undefined,
      plannedDate: value.plannedDate as string | null | undefined,
      dueDate: value.dueDate as string | null | undefined,
      followUpDate: value.followUpDate as string | null | undefined,
      nextAction: value.nextAction as string | undefined,
      blockedReason: value.blockedReason as string | undefined,
    });
    const headers = mutation.replayed ? { 'Idempotency-Replayed': 'true' } : undefined;
    return apiSuccess(mutation.response, mutationRequestId, headers);
  } catch (error) { return apiFailure(error, mutationRequestId); }
  finally { db.$client.close(); }
}
