'use client';

import { useEffect, useState } from 'react';

import { apiFetch, apiUrl } from '@/shared/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; body: string }
  | { kind: 'error'; message: string };

/**
 * 客户端前缀冒烟：证明经 apiFetch 封装的请求能命中 /tasks/api/healthz。
 * 直接 fetch('/api/healthz') 在 /tasks 前缀下会打到站点根，属契约违规（技术设计 12.2）。
 */
export function HealthCheck() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/healthz')
      .then(async (res) => {
        const text = await res.text();
        if (!cancelled) {
          setState(
            res.ok
              ? { kind: 'ok', body: text }
              : { kind: 'error', message: `HTTP ${res.status}: ${text}` },
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h2>客户端请求自检</h2>
      <p>
        请求地址：<code>{apiUrl('/api/healthz')}</code>
      </p>
      {state.kind === 'loading' && <p>检测中…</p>}
      {state.kind === 'ok' && <p data-testid="health-ok">响应：{state.body}</p>}
      {state.kind === 'error' && <p data-testid="health-error">失败：{state.message}</p>}
    </section>
  );
}
