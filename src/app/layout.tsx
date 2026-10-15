import type { Metadata, Viewport } from 'next';

import { BASE_PATH } from '@/shared/base-path';

export const metadata: Metadata = {
  title: '通用事务管理平台',
  description: '以事项为核心，统一管理工作、生活和个人成长',
  manifest: `${BASE_PATH}/manifest.webmanifest`,
  icons: {
    icon: `${BASE_PATH}/icon.svg`,
    apple: `${BASE_PATH}/icon.svg`,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f6f8f6',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
