#!/usr/bin/env node
/**
 * 账号与默认空间初始化脚本（M1-02；登录流程属 M1-03）。
 *
 * 设计依据：
 * - 技术设计 1/6：一个预置账号；无默认密码，交互输入（12.3：12–128 码点，不隐式 trim）；
 * - PRD 4：V1 默认空间为 私人、工作、生活、成长；私人不可归档（服务层校验，is_default 标记）；
 * - 技术设计 12.1：所有业务实体初始 version=1；首版只允许初始化一个账号。
 *
 * 幂等性：
 * - 已存在账号时不重复创建（打印提示后退出）；
 * - 用户名固定 'owner'（单账号首版；PRD FR-01 关闭公开注册）。
 *
 * 用法：
 *   node scripts/init-account.mjs                       # 交互输入密码（隐藏回显，需输入两次）
 *   TASKS_DB_PATH=/tmp/test.db node scripts/init-account.mjs
 *   TASKS_ALLOW_NONINTERACTIVE_INIT=1 TASKS_INIT_PASSWORD=... node scripts/init-account.mjs
 *     # 仅供本机脚本/自动化测试；默认禁用，避免环境变量无意间成为"默认密码"通道
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import Database from 'better-sqlite3';

import { loadEnvFiles, resolveDbPath } from './lib/env.mjs';

loadEnvFiles();
// ACC-03：与 migrate.mjs、应用 client.ts 使用同一路径优先级
const DB_PATH = resolveDbPath();

/** 单账号用户名（首版固定；注册入口不存在） */
const USERNAME = 'owner';
/** PRD 4：V1 默认空间 */
const DEFAULT_SPACES = ['私人', '工作', '生活', '成长'];

/** 隐藏回显的密码输入（TTY）；非 TTY 时按行读取标准输入，便于管道与测试 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.stdout.write(question);
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('用户取消输入'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

let pipedLines = null;
async function nextPipedLine() {
  if (pipedLines === null) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    pipedLines = Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''));
  }
  return pipedLines.shift() ?? '';
}

async function readPassword() {
  const env = process.env.TASKS_INIT_PASSWORD;
  if (env !== undefined) {
    if (process.env.TASKS_ALLOW_NONINTERACTIVE_INIT !== '1') {
      console.error(
        'init-account: 已忽略 TASKS_INIT_PASSWORD（技术设计 12.3 要求初始化强制交互设置）。\n' +
          '             如确为自动化测试，请显式设置 TASKS_ALLOW_NONINTERACTIVE_INIT=1。',
      );
      process.exit(1);
    }
    console.warn('init-account: 警告：正在使用非交互方式设置密码（仅限本机脚本/测试）。');
    return env;
  }
  if (!process.stdin.isTTY) {
    const first = await nextPipedLine();
    const second = await nextPipedLine();
    if (first !== second) {
      console.error('init-account: 两次输入不一致，初始化中止');
      process.exit(1);
    }
    return first;
  }
  const first = await promptHidden('请设置登录密码（12–128 个字符，输入不回显）：');
  const second = await promptHidden('请再次输入以确认：');
  if (first !== second) {
    console.error('init-account: 两次输入不一致，初始化中止');
    process.exit(1);
  }
  return first;
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // 迁移未应用时先中止（脚本分工：schema 由 scripts/migrate.mjs 创建）
  const hasUsers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsers) {
    console.error(`init-account: 数据库 ${DB_PATH} 尚未应用迁移（缺少 users 表），请先执行: node scripts/migrate.mjs`);
    process.exit(1);
  }

  const existing = db.prepare('SELECT id, username FROM users LIMIT 1').get();
  if (existing) {
    console.log(`init-account: 已存在账号（id=${existing.id} username=${existing.username}），不重复创建`);
    const spaces = db.prepare('SELECT name FROM spaces ORDER BY created_at, id').all();
    console.log(`init-account: 现有空间 [${spaces.map((s) => s.name).join(', ')}]`);
    db.close();
    return;
  }

  const password = await readPassword();
  const cps = [...password].length;
  if (cps < 12 || cps > 128) {
    console.error(`init-account: 密码长度 ${cps} 不在 12–128 码点范围内，初始化中止`);
    process.exit(1);
  }

  // 密码哈希：scrypt（src/server/auth/password.ts 同参数；脚本侧内联实现避免 TS 引用）
  const { randomBytes, scryptSync } = await import('node:crypto');
  const N = 16384, r = 8, p = 1, KEYLEN = 64;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  const passwordHash = ['scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join('$');

  const now = new Date().toISOString();
  const userId = randomUUID();
  const spaceRows = DEFAULT_SPACES.map((name) => ({
    id: randomUUID(),
    userId,
    name,
    isDefault: name === '私人' ? 1 : 0,
    now,
  }));

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, username, password_hash, timezone, auth_version, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(userId, USERNAME, passwordHash, 'Asia/Shanghai', now);
    const insertSpace = db.prepare(
      'INSERT INTO spaces (id, owner_user_id, name, description, is_default, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    );
    for (const s of spaceRows) {
      insertSpace.run(s.id, s.userId, s.name, '', s.isDefault, s.now, s.now);
    }
  });
  tx();

  console.log(`init-account: 账号 owner 创建成功（id=${userId}）`);
  console.log(`init-account: 默认空间已创建 -> ${DEFAULT_SPACES.join('、')}（is_default=私人）`);
  console.log(`init-account: 数据库 ${DB_PATH}`);
  db.close();
}

main().catch((err) => {
  console.error('init-account: 失败', err);
  process.exit(1);
});
