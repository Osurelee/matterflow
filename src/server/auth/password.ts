/** Password hashing contract: scrypt N=16384, r=8, p=1, 64-byte key. */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
const SCRYPT_N=16384, SCRYPT_R=8, SCRYPT_P=1, KEYLEN=64;
export function hashPassword(password:string):string {
  const salt=randomBytes(16); const hash=scryptSync(password,salt,KEYLEN,{N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P});
  return ['scrypt',SCRYPT_N,SCRYPT_R,SCRYPT_P,salt.toString('hex'),hash.toString('hex')].join('$');
}
export function verifyPassword(password:string,stored:string):boolean {
  try {
    const parts=stored.split('$'); if(parts.length!==6||parts[0]!=='scrypt') return false;
    const [,n,r,p,saltHex,hashHex]=parts;
    if(Number(n)!==SCRYPT_N||Number(r)!==SCRYPT_R||Number(p)!==SCRYPT_P||!/^[0-9a-f]{32}$/i.test(saltHex)||!/^[0-9a-f]{128}$/i.test(hashHex)) return false;
    const expected=Buffer.from(hashHex,'hex'); const actual=scryptSync(password,Buffer.from(saltHex,'hex'),KEYLEN,{N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P});
    return timingSafeEqual(actual,expected);
  } catch { return false; }
}
export function validatePasswordLength(password:string):{ok:boolean;message?:string} {
  const cps=[...password].length;
  if(cps<12||cps>128) return {ok:false,message:'密码长度需为 12–128 个字符（码点）'};
  return {ok:true};
}
