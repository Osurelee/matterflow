import { apiError, apiRequestId } from '@/server/http/responses';

/** 默认 8KiB（认证等小请求）；正文路由按技术设计 5.3 单独放宽到 128KiB。 */
export const DEFAULT_JSON_BODY_LIMIT = 8192;
export const BODY_JSON_LIMIT = 128 * 1024;

export async function readJsonBody(request: Request, maxBytes: number = DEFAULT_JSON_BODY_LIMIT) {
  let bytes: ArrayBuffer;
  try { bytes = await request.arrayBuffer(); }
  catch { return { ok: false as const, response: apiError(400, 'INVALID_JSON', '请求内容格式无效') }; }
  if (bytes.byteLength > maxBytes) return { ok: false as const, response: apiError(413, 'BODY_TOO_LARGE', '请求内容过大') };
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return { ok: false as const, response: apiError(400, 'INVALID_JSON', '请求内容格式无效') }; }
  const requestId = apiRequestId(body && typeof body === 'object' ? (body as Record<string, unknown>).requestId : undefined);
  return { ok: true as const, body, requestId };
}
