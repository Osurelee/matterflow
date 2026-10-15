import type { MetadataRoute } from 'next';

import { BASE_PATH } from '@/shared/base-path';

/**
 * PWA manifest（技术设计 12.2：id、start_url、scope 均限定在 /tasks/ 内）。
 * 图标与 Service Worker 属 M5 范围，此处锁定移动端安装所需的路径契约。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: `${BASE_PATH}/`,
    name: '通用事务管理平台',
    short_name: '事项',
    description: '以事项为核心，统一管理工作、生活和个人成长',
    start_url: `${BASE_PATH}/`,
    scope: `${BASE_PATH}/`,
    display: 'standalone',
    background_color: '#f6f8f6',
    theme_color: '#f6f8f6',
    orientation: 'portrait',
    icons: [
      { src: `${BASE_PATH}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
