import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createDatabase } from '@/server/db/client';
import { sessions } from '@/server/db/schema';
import { originAllowed, SESSION_COOKIE } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const requestId = apiRequestId();
  if (!originAllowed(request)) return apiError(403, 'BAD_ORIGIN', '请求来源无效', { requestId });
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) {
      const hash = createHash('sha256').update(token).digest('hex');
      const db = createDatabase();
      try { await db.delete(sessions).where(eq(sessions.idHash, hash)); } finally { db.$client.close(); }
    }
    const response = apiSuccess({ ok: true }, requestId);
    response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/tasks', expires: new Date(0) });
    return response;
  } catch (error) { return apiFailure(error, requestId); }
}
