/**
 * drizzle-kit 配置（M1-02）。
 *
 * 迁移输出到 db/migrations（版本化管理）；数据库 schema 定义在 src/server/db。
 * 连接配置仅用于生成元数据，运行时与迁移执行都不走这里
 * （运行时用 src/server/db/client.ts；迁移用 scripts/migrate.mjs）。
 *
 * 路径优先级与 scripts/lib/env.mjs 保持一致（ACC-03）：
 *   TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db
 * drizzle-kit 与独立脚本都通过 /env 加载项目环境文件，数据库路径规则一致。
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd(), process.env.NODE_ENV === "development");

import { defineConfig } from 'drizzle-kit';

const dataDir = process.env.TASKS_DATA_DIR || path.join(homedir(), 'tasks', 'data');
const dbPath = process.env.TASKS_DB_PATH || path.join(dataDir, 'tasks.db');

export default defineConfig({
  dialect: 'sqlite',
  schema: path.join('src', 'server', 'db', 'schema.ts'),
  out: path.join('db', 'migrations'),
  dbCredentials: { url: dbPath },
  strict: true,
  verbose: true,
});

