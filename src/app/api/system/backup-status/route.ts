import { desc } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { backupRuns } from '@/server/db/schema';
import { createDatabase } from '@/server/db/client';
import { currentUser } from '@/server/auth/session';
import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
export const runtime = 'nodejs';
export async function GET() {
  const requestId = apiRequestId();
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
    const db = createDatabase();
    try {
      const [latest] = await db.select({ id: backupRuns.id, startedAt: backupRuns.startedAt, finishedAt: backupRuns.finishedAt, status: backupRuns.status, artifactName: backupRuns.artifactName, checksum: backupRuns.checksum, errorCode: backupRuns.errorCode, localStatus: backupRuns.localStatus, remoteStatus: backupRuns.remoteStatus, localVerifiedAt: backupRuns.localVerifiedAt, remoteVerifiedAt: backupRuns.remoteVerifiedAt, remoteObjectId: backupRuns.remoteObjectId }).from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(1);
      return apiSuccess({ latest: latest ?? null }, requestId);
    } finally { db.$client.close(); }
  } catch (error) { return apiFailure(error, requestId); }
}
