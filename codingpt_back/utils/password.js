const crypto = require('crypto');

// scrypt 기반 비밀번호 해시 (Node 내장 — 외부 의존성 없음).
// 저장 포맷: scrypt$<saltHex>$<hashHex>
// 용도: 카드사 심사용 ID/PW 계정(소셜 로그인과 별개). 일반 사용자 가입엔 사용 안 함.

const N = 16384, r = 8, p = 1, keylen = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, keylen, { N, r, p });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, saltHex, hashHex] = stored.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
