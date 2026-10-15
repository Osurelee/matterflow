import type { NextConfig } from 'next';

import { BASE_PATH } from './src/shared/base-path';

/**
 * 路径契约（技术设计 12.2）：
 * basePath 在构建时固定；修改该值必须重新构建，并同步检查站内导航、重定向、
 * 原生 fetch、图片与 manifest 的前缀。
 */
const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
