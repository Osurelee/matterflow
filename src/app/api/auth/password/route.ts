import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createDatabase, rawDb } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { hashPassword, validatePasswordLength, verifyPassword } from '@/server/auth/password';
import { currentUser, hashSessionToken, originAllowed, SESSION_COOKIE, SESSION_TTL_MS } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const requestId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId });
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { requestId: bodyRequestId, body } = parsed;
  let principal;
  try { principal = await currentUser(); } catch (error) { return apiFailure(error, bodyRequestId); }
  if (!principal) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId: bodyRequestId });
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).currentPassword !== 'string' || typeof (body as Record<string, unknown>).newPassword !== 'string') {
    return apiError(400, 'INVALID_INPUT', '请输入当前密码和新密码', { requestId: bodyRequestId, fieldErrors: { currentPassword: '必填', newPassword: '必填' } });
  }
  const { currentPassword, newPassword } = body as { currentPassword: string; newPassword: string };
  const validLength = validatePasswordLength(newPassword);
  if (!validLength.ok) return apiError(400, 'INVALID_INPUT', validLength.message ?? '密码长度无效', { requestId: bodyRequestId, fieldErrors: { newPassword: validLength.message ?? '密码长度无效' } });
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, bodyRequestId); }
  try {
    const [user] = await db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) return apiError(401, 'INVALID_CREDENTIALS', '当前密码不正确', { requestId: bodyRequestId, fieldErrors: { currentPassword: '当前密码不正确' } });
    const newVersion = user.authVersion + 1;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const sql = rawDb(db);
    sql.transaction(() => {
      sql.prepare('UPDATE users SET password_hash = ?, auth_version = ? WHERE id = ?').run(hashPassword(newPassword), newVersion, user.id);
      sql.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      sql.prepare('INSERT INTO sessions(id_hash,user_id,auth_version,expires_at,created_at) VALUES(?,?,?,?,?)').run(hashSessionToken(token), user.id, newVersion, expiresAt.toISOString(), now.toISOString());
    }).immediate();
    const response = apiSuccess({ ok: true }, bodyRequestId);
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/tasks', expires: expiresAt });
    return response;
  } catch (error) { return apiFailure(error, bodyRequestId); }
  finally { db.$client.close(); }
}
