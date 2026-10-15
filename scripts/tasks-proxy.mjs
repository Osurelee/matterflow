#!/usr/bin/env node
/**
 * /tasks 前缀恢复代理（M1-01 实测结论，技术设计 12.2）
 *
 * 背景（实测，2026-10-12）：
 *   Tailscale serve/funnel 的 --set-path=/tasks 会在转发前**剥掉** /tasks 前缀：
 *     公网 /tasks              -> 应用收到 /
 *     公网 /tasks/api/healthz  -> 应用收到 /api/healthz
 *   而契约要求代理后仍保留 /tasks（Next.js 以 basePath=/tasks 构建）。
 *
 * 本代理只做一件事：把收到的路径重新加上 /tasks 再转发给应用，
 * 不改变既有根路径服务（memos 仍由 Funnel 的 / 处理）。
 *
 * 拓扑：
 *   公网 https://suresmac-mini.tail6bfbc0.ts.net/tasks
 *     -> tailscaled 剥掉 /tasks
 *     -> 本代理 127.0.0.1:3101（恢复 /tasks）
 *     -> 应用 127.0.0.1:3100
 *
 * 端口来源：默认 3101；可用 TASKS_PROXY_PORT / TASKS_APP_PORT / TASKS_BASE_PATH 覆盖。
 */
import http from 'node:http';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.TASKS_PROXY_PORT ?? 3101);
const APP_HOST = '127.0.0.1';
const APP_PORT = Number(process.env.TASKS_APP_PORT ?? 3100);
const BASE_PATH = process.env.TASKS_BASE_PATH ?? '/tasks';

const server = http.createServer((req, res) => {
  const [rawPath = '/', query] = (req.url ?? '/').split('?');
  // tailscaled 已剥掉挂载前缀；根路径 "/" 对应挂载点本身，避免产生 "/tasks/"
  const suffix = rawPath === '/' ? '' : rawPath;
  const targetPath = `${BASE_PATH}${suffix}${query ? `?${query}` : ''}`;

  const proxyReq = http.request(
    {
      host: APP_HOST,
      port: APP_PORT,
      method: req.method,
      path: targetPath,
      headers: {
        ...req.headers,
        host: req.headers.host ?? `${APP_HOST}:${APP_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`prefix-restore proxy error: ${err.message}\n`);
  });

  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `tasks prefix-restore proxy on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${APP_HOST}:${APP_PORT}${BASE_PATH}`,
  );
});
