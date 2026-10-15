/**
 * 数据库连接（M1-02）。
 *
 * 约定（技术设计 8）：SQLite 开启 foreign_keys 与合理 busy_timeout；
 * 数据目录由 TASKS_DATA_DIR 提供（默认 ~/tasks/data），测试可用环境变量覆盖。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';

export const DATA_DIR = process.env.TASKS_DATA_DIR || path.join(homedir(), 'tasks', 'data');
export const DB_PATH = process.env.TASKS_DB_PATH || path.join(DATA_DIR, 'tasks.db');

/** drizzle better-sqlite3 实例类型（schema 绑定） */
export type AppDatabase = ReturnType<typeof createAppDatabase>;

function createAppDatabase(dbPath: string) {
  const sqlite = new Database(dbPath);
  return drizzle(sqlite, { schema });
}

export function createDatabase(dbPath: string = DB_PATH): AppDatabase {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = createAppDatabase(dbPath);
  // 技术设计 3/8：连接开启外键；WAL 与 busy_timeout 参数按真实并发测试调整
  const sqlite = db.$client;
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = FULL');
  return db;
}

/** 测试/脚本直接取原生连接用 */
export function rawDb(db: AppDatabase): Database.Database {
  // drizzle better-sqlite3 驱动持有原生实例
  return (db.$client as unknown as Database.Database);
}
