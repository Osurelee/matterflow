/**
 * 应用路径前缀的唯一来源（技术设计 12.2）。
 *
 * - 公网入口：https://suresmac-mini.tail6bfbc0.ts.net/tasks
 * - 本机回环：http://127.0.0.1:3100/tasks
 *
 * 修改此值属于契约变更：需要重新构建，并同步更新
 * Cookie 名称（tasks_session）、manifest id/start_url/scope、Service Worker scope。
 */
export const BASE_PATH = '/tasks';
