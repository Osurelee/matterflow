#!/usr/bin/env node
/** Local password reset (M1-03). Input is masked; no plaintext password is printed or written. */
import process from 'node:process';
import Database from 'better-sqlite3';
import { loadEnvFiles, resolveDbPath } from './lib/env.mjs';
import { resetOwnerPassword } from './lib/account-password.mjs';
loadEnvFiles();

const input = (prompt) => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return reject(new Error('密码重置要求交互式终端'));
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdout.write(prompt);
  let value = '';
  const finish = () => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
  const onData = (chunk) => {
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') { finish(); resolve(value); return; }
      if (ch === '\u0003') { finish(); reject(new Error('已取消')); return; }
      if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); process.stdout.write('\b \b'); }
      else if (ch >= ' ') { value += ch; process.stdout.write('*'); }
    }
  };
  process.stdin.on('data', onData);
});

let db;
try {
  const first = await input('输入新密码（12–128字符）：');
  const second = await input('再次输入新密码：');
  if (first !== second) throw new Error('两次密码不一致');
  db = new Database(resolveDbPath());
  const result = resetOwnerPassword(db, first);
  console.log(`reset-password: owner密码已重置（auth_version=${result.authVersion}），所有现存会话已撤销。`);
} catch (error) {
  console.error(`reset-password: ${error instanceof Error ? error.message : '操作失败'}`);
  process.exitCode = 1;
} finally { db?.close(); }
