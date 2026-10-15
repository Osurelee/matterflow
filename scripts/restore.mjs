#!/usr/bin/env node
/** Restore a verified SQLite snapshot to a new target, revoking snapshot-era sessions. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const source = process.argv[2] && path.resolve(process.argv[2]);
const target = process.argv[3] && path.resolve(process.argv[3]);
if (!source || !target) throw new Error('用法：node scripts/restore.mjs <已验证备份.db> <全新目标.db>');
if (!existsSync(source) || !existsSync(`${source}.sha256`)) throw new Error('备份文件或校验和文件不存在');
if (existsSync(target)) throw new Error(`拒绝覆盖已有目标数据库：${target}`);
if (source === target) throw new Error('恢复源与目标不能相同');
const expected = readFileSync(`${source}.sha256`, 'utf8').trim().split(/\s+/)[0];
const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
if (sourceHash !== expected) throw new Error('备份 SHA-256 不匹配');
const check = new Database(source, { readonly: true, fileMustExist: true });
try {
  if (check.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('源备份 integrity_check 失败');
  if (check.pragma('foreign_key_check').length) throw new Error('源备份 foreign_key_check 失败');
  for (const table of ['users','spaces','tasks','task_events','sessions','mutation_requests','backup_runs']) {
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`源备份关键表缺失：${table}`);
  }
} finally { check.close(); }
mkdirSync(path.dirname(target), { recursive: true });
const input = new Database(source, { readonly: true, fileMustExist: true });
try { input.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { input.close(); }

// A restored snapshot may contain tokens revoked after the backup. Revoke them and advance auth_version before checksum.
const restored = new Database(target);
try {
  restored.pragma('foreign_keys = ON');
  restored.transaction(() => {
    restored.prepare('UPDATE users SET auth_version = auth_version + 1').run();
    restored.prepare('DELETE FROM sessions').run();
  }).immediate();
  restored.pragma('wal_checkpoint(TRUNCATE)');
  restored.pragma('journal_mode = DELETE');
  if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('恢复后 integrity_check 失败');
  if (restored.pragma('foreign_key_check').length) throw new Error('恢复后 foreign_key_check 失败');
} catch (error) { throw new Error(`恢复目标校验/会话撤销失败，文件保留供检查：${error.message}`); }
finally { restored.close(); }
chmodSync(target, 0o600);
const restoredHash = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${restoredHash}  ${path.basename(target)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`restore: verified ${target}; snapshot sessions revoked`);
