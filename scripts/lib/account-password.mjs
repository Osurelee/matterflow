import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384, r = 8, p = 1, keylen = 64;
export function validatePasswordLength(password) {
  const length = [...password].length;
  return length >= 12 && length <= 128 ? { ok: true } : { ok: false, message: '密码长度必须是12–128码点' };
}
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join('$');
}
export function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, rr, pp, saltHex, hashHex] = encoded.split('$');
    if (algorithm !== 'scrypt' || Number(n) !== N || Number(rr) !== r || Number(pp) !== p || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), keylen, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

/** DB-only reset core is shared by the CLI and isolated tests. Caller owns/ closes db. */
export function resetOwnerPassword(db, password) {
  const validation = validatePasswordLength(password);
  if (!validation.ok) throw new Error(validation.message);
  const encoded = hashPassword(password);
  return db.transaction(() => {
    const result = db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE username=?').run(encoded, 'owner');
    if (result.changes !== 1) throw new Error('owner账号不存在，未修改数据库');
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM auth_rate_limits').run();
    return { authVersion: db.prepare('SELECT auth_version FROM users WHERE username=?').get('owner').auth_version };
  }).immediate();
}
