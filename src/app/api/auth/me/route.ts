import { apiError, apiFailure, apiRequestId, apiSuccess } from '@/server/http/responses';
import { currentUser } from '@/server/auth/session';
export const runtime = 'nodejs';
export async function GET() {
  const requestId = apiRequestId();
  try {
    const user = await currentUser();
    if (!user) return apiError(401, 'UNAUTHENTICATED', '请先登录', { requestId });
    return apiSuccess(user, requestId);
  } catch (error) { return apiFailure(error, requestId); }
}
