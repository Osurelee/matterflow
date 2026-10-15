#!/usr/bin/env node
/** Consistent local SQLite snapshot, verification, checksum, and run-status recording. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { loadEnvFiles, resolveDbPath } from './lib/env.mjs';
loadEnvFiles();
const source = resolveDbPath();
const backupDir = process.env.TASKS_BACKUP_DIR || path.join(homedir(), 'tasks', 'backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(backupDir, `tasks-${timestamp}.db`);
const runId = randomUUID();
const startedAt = new Date().toISOString();

function recordRun({ status, checksum = null, errorCode = null }) {
  const db = new Database(source, { fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON');
    db.prepare(`INSERT INTO backup_runs(id,started_at,finished_at,status,artifact_name,checksum,error_code,local_status,remote_status,local_verified_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      runId, startedAt, new Date().toISOString(), status, path.basename(output), checksum, errorCode,
      status === 'success' ? 'verified' : 'failed', 'unverified', status === 'success' ? new Date().toISOString() : null,
    );
  } finally { db.close(); }
}

try {
  if (!existsSync(source)) throw new Error('SOURCE_DB_MISSING');
  if (existsSync(output)) throw new Error('TARGET_EXISTS');
  if (path.resolve(source) === output) throw new Error('TARGET_IS_SOURCE');
  mkdirSync(path.dirname(output), { recursive: true });
  const db = new Database(source, { fileMustExist: true });
  try {
    db.pragma('busy_timeout=10000');
    db.exec(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
  } finally { db.close(); }

  const check = new Database(output, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('INTEGRITY_CHECK_FAILED');
    if (check.pragma('foreign_key_check').length) throw new Error('FOREIGN_KEY_CHECK_FAILED');
    for (const table of ['users','spaces','tasks','task_events','sessions','mutation_requests','backup_runs']) {
      if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`REQUIRED_TABLE_MISSING:${table}`);
    }
  } finally { check.close(); }

  chmodSync(output, 0o600);
  const checksum = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(`${output}.sha256`, `${checksum}  ${path.basename(output)}\n`, { flag: 'wx', mode: 0o600 });
  // Record after the snapshot so the artifact does not contain a misleading `running` row for itself.
  recordRun({ status: 'success', checksum });
  console.log(`backup: verified ${output}`);
  console.log(`backup: sha256 ${checksum}`);
  console.log(`backup: runId ${runId}; remote_status=unverified`);
} catch (error) {
  let message = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
  try { if (existsSync(source)) recordRun({ status: 'failed', errorCode: message.split(':')[0] || 'BACKUP_FAILED' }); }
  catch { message = `${message}; status-log-write-failed`; }
  console.error(`backup: failed (${message}); any incomplete artifact must not be restored`);
  process.exitCode = 1;
}
