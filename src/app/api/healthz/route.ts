import { NextResponse } from 'next/server';

import { BASE_PATH } from '@/shared/base-path';

/**
 * 健康检查（技术设计 12.3：公网可访问，但不泄露版本、路径或依赖细节）。
 * 实际挂载路径：GET /tasks/api/healthz
 */
export function GET() {
  return NextResponse.json({ status: 'ok', basePath: BASE_PATH }, { headers: { 'Cache-Control': 'no-store' } });
}
