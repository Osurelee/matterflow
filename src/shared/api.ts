import { BASE_PATH } from './base-path';

/**
 * 客户端/服务端请求前缀封装（技术设计 12.2）。
 *
 * 原生 fetch 不会自动加上 basePath 前缀，因此业务代码一律使用本模块，
 * 不要直接拼接以 "/" 开头的绝对路径。
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
