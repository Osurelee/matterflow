import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { createDatabase, rawDb } from '@/server/db/client';
import { authRateLimits, users } from '@/server/db/schema';
import { issueSession, originAllowed, SESSION_COOKIE } from '@/server/auth/session';
import { verifyPassword } from '@/server/auth/password';
import { apiError, apiFailure, apiSuccess } from '@/server/http/responses';
import { readJsonBody } from '@/server/http/request';

export const runtime = 'nodejs';
const hashKey = (s: string) => createHash('sha256').update(s).digest('hex');
export async function POST(request: Request) {
  const requestId = randomUUID();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId });
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).username !== 'string' || typeof (body as Record<string, unknown>).password !== 'string') return apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误', { requestId });
  const { username, password } = body as { username: string; password: string };
  // Count Unicode code points, matching initialization and password-change policy.
  if ([...username].length > 128 || [...password].length > 128) return apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误', { requestId });
  let db: ReturnType<typeof createDatabase>;
  try { db = createDatabase(); } catch (error) { return apiFailure(error, requestId); }
  try {
    const acctKey = hashKey(`account:${username.toLowerCase()}`);
    // No proxy IP is trusted until the deployment explicitly provides a trustworthy proxy chain.
    const ipKey = hashKey('ip:untrusted-proxy-single-bucket');
    const keys = [acctKey, ipKey];
    const nowMs = Date.now();
    for (const key of keys) {
      const [entry] = await db.select().from(authRateLimits).where(eq(authRateLimits.keyHash, key)).limit(1);
      if (entry?.blockedUntil && Date.parse(entry.blockedUntil) > nowMs) return apiError(429, 'RATE_LIMITED', '登录尝试过多，请稍后再试', { requestId, headers: { 'Retry-After': String(Math.ceil((Date.parse(entry.blockedUntil) - nowMs) / 1000)) } });
    }
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    const valid = Boolean(user && verifyPassword(password, user.passwordHash));
    if (!valid) {
      const sql = rawDb(db);
      const now = new Date();
      const limit = sql.transaction(() => {
        for (const key of keys) {
          const entry = sql.prepare('SELECT window_start,failure_count,blocked_until FROM auth_rate_limits WHERE key_hash=?').get(key) as {window_start:string;failure_count:number;blocked_until:string|null}|undefined;
          if (entry?.blocked_until && Date.parse(entry.blocked_until) > now.getTime()) return Math.ceil((Date.parse(entry.blocked_until)-now.getTime())/1000);
        }
        for (const [index,key] of keys.entries()) {
          const entry = sql.prepare('SELECT window_start,failure_count FROM auth_rate_limits WHERE key_hash=?').get(key) as {window_start:string;failure_count:number}|undefined;
          const fresh = !entry || now.getTime()-Date.parse(entry.window_start) >= 15*60*1000;
          const count = fresh ? 1 : entry.failure_count+1;
          const threshold = index===0 ? 5 : 30;
          const delay = count>=threshold ? (index===0 ? Math.min(1000*2**(count-threshold),60000) : 60000) : 0;
          const windowStart = fresh ? now.toISOString() : entry!.window_start;
          const blockedUntil = delay ? new Date(now.getTime()+delay).toISOString() : null;
          sql.prepare(`INSERT INTO auth_rate_limits(key_hash,window_start,failure_count,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key_hash) DO UPDATE SET window_start=excluded.window_start,failure_count=excluded.failure_count,blocked_until=excluded.blocked_until`).run(key,windowStart,count,blockedUntil);
        }
        return 0;
      }).immediate();
      if (limit) return apiError(429, 'RATE_LIMITED', '登录尝试过多，请稍后再试', { requestId, headers: { 'Retry-After': String(limit) } });
      return apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误', { requestId });
    }
    await db.delete(authRateLimits).where(eq(authRateLimits.keyHash, acctKey));
    const session = await issueSession(user!.id, user!.authVersion);
    const response = apiSuccess({ id: user!.id, username: user!.username }, requestId);
    response.cookies.set(SESSION_COOKIE, session.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/tasks', expires: session.expiresAt });
    return response;
  } catch (error) { return apiFailure(error, requestId); }
  finally { db.$client.close(); }
}
