import Link from 'next/link';

import { BASE_PATH } from '@/shared/base-path';

/**
 * 深链接冒烟目标：验证 /tasks 前缀下的非根路由可直接访问（刷新不 404）。
 * 实际挂载路径：GET /tasks/contract
 */
export default function ContractPage() {
  return (
    <main>
      <h1>路径契约页（深链接）</h1>
      <p>
        当前路由前缀：<code>{BASE_PATH}</code>
      </p>
      <ul>
        <li>
          静态资源：<code>{BASE_PATH}/_next/static/...</code>
        </li>
        <li>
          健康检查：<code>{BASE_PATH}/api/healthz</code>
        </li>
        <li>
          manifest：<code>{BASE_PATH}/manifest.webmanifest</code>
        </li>
      </ul>
      <p>
        <Link href="/">返回首页</Link>
      </p>
    </main>
  );
}
