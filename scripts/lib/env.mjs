/**
 * 脚本共享的环境与路径解析（ACC-03 修复 + R-01 复验修复，2026-10-12）。
 *
 * 统一规则（应用 src/server/db/client.ts 与所有脚本必须一致）：
 *   数据库路径优先级：TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db
 *
 * R-01：独立 Node 脚本原先用自制解析器读 .env.local/.env，与 Next.js 实际行为不一致
 * （行尾注释、变量引用 $VAR、多行引号等）。现改用应用同款加载器 `@next/env`
 * （next 16.4.0 自带，零新增依赖），保证"脚本与应用读到同一组环境值"这一不变量
 * 由同一实现保证，而不是由两套实现碰巧对齐。
 *
 * @next/env 语义（与 next dev/build/start 一致）：
 * - 按优先级加载 .env.local > .env.$(NODE_ENV) > .env；先读到者生效；
 * - 不覆盖进程已设置的环境变量；
 * - 变量展开 $VAR / ${VAR}、引号、行尾注释均按其规则处理。
 */
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * 用 @next/env 加载环境（应用同款）。幂等：进程已设置的变量不会被覆盖。
 * 返回 @next/env 的解析结果，供需要区分"文件值/进程值"的场景。
 */
export function loadEnvFiles(dir = PROJECT_ROOT) {
  return loadEnvConfig(dir, process.env.NODE_ENV === "development");
}

/** 默认数据目录：~/tasks/data */
export function defaultDataDir() {
  return path.join(homedir(), 'tasks', 'data');
}

/**
 * 数据目录：TASKS_DATA_DIR 优先，其次默认目录。
 * 注意：必须在 loadEnvFiles() 之后调用，否则 .env.local 中的值不可见。
 */
export function resolveDataDir() {
  return process.env.TASKS_DATA_DIR || defaultDataDir();
}

/** 数据库文件：TASKS_DB_PATH 优先，其次 TASKS_DATA_DIR/tasks.db，最后默认目录 */
export function resolveDbPath() {
  if (process.env.TASKS_DB_PATH) return process.env.TASKS_DB_PATH;
  return path.join(resolveDataDir(), 'tasks.db');
}
