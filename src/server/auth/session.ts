import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { createDatabase } from '@/server/db/client';
import { sessions, users } from '@/server/db/schema';

export const SESSION_COOKIE = 'tasks_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const hashSessionToken = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = hashSessionToken;

export async function issueSession(userId: string, authVersion: number) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const db = createDatabase();
  try { await db.insert(sessions).values({ idHash: digest(token), userId, authVersion, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() }); }
  finally { db.$client.close(); }
  return { token, expiresAt };
}

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = createDatabase();
  try {
    const [row] = await db.select({ id: users.id, username: users.username, authVersion: users.authVersion, expiresAt: sessions.expiresAt, sessionVersion: sessions.authVersion }).from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(eq(sessions.idHash, digest(token))).limit(1);
    if (!row || Date.parse(row.expiresAt) <= Date.now() || row.authVersion !== row.sessionVersion) return null;
    return { id: row.id, username: row.username };
  } finally { db.$client.close(); }
}

/** Only compare against configured public origin or the direct request origin; never trust forwarded headers. */
export function originAllowed(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const allowed = new Set<string>();
    if (process.env.NODE_ENV === "production" && !process.env.TASKS_PUBLIC_ORIGIN) return false;
    if (process.env.TASKS_PUBLIC_ORIGIN) {
      for (const configuredOrigin of process.env.TASKS_PUBLIC_ORIGIN.split(',')) {
        const value = configuredOrigin.trim();
        if (value) allowed.add(new URL(value).origin);
      }
    }
    if (process.env.NODE_ENV !== "production") {
      allowed.add(new URL(request.url).origin);
      // Next dev 会把回环请求的 Host 规范成 localhost；同时放行 Host 头对应的回环来源，
      // 避免用户用 127.0.0.1 访问时被误拒。仅放行回环 host，不信任任意转发头。
      const host = request.headers.get('host');
      if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
        allowed.add(`http://${host}`);
        allowed.add(`https://${host}`);
      }
    }
    return allowed.has(new URL(origin).origin);
  } catch { return false; }
}
