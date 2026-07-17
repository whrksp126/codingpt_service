/**
 * Apple 로그인 — identity token(id_token) 검증.
 *
 *  클라이언트(iOS 네이티브 / 웹 AppleID JS / PC·안드로이드 웹플로우)가 Apple 로부터 받은 id_token 을
 *  그대로 백엔드에 넘기면, 여기서 Apple 공개키(JWKS)로 서명·발급자·수신자·만료를 검증하고
 *  { sub, email, emailVerified } 를 돌려준다. 구글 로그인(userService.login)과 대칭 구조.
 *
 *  Apple 공개키는 https://appleid.apple.com/auth/keys(JWKS)에서 받아 Node 내장 crypto 로
 *  JWK→공개키 변환(외부 의존성 없음 — jwks-rsa 는 ESM 전용 jose 를 끌어와 CommonJS prod 에서 크래시).
 *
 *  audience(수신자)는 클라이언트 종류에 따라 다르다:
 *   · iOS 네이티브        → 앱 번들 ID (APPLE_BUNDLE_ID)
 *   · 웹/PC/안드로이드 웹  → Services ID (APPLE_SERVICES_ID)
 *  둘 다 허용한다.
 */
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.ghmate.codingpt.app';
const APPLE_SERVICES_ID = process.env.APPLE_SERVICES_ID || 'com.ghmate.codingpt.web';

// JWKS 캐시(kid → PEM) — Apple 키는 자주 바뀌지 않는다. 미스 시 재조회.
let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function fetchJwks() {
  return new Promise((resolve, reject) => {
    https.get(APPLE_JWKS_URI, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`JWKS ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).keys || []); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// kid 에 해당하는 공개키(PEM)를 반환. 캐시 미스이거나 kid 없으면 강제 재조회 1회.
async function getPublicKey(kid) {
  const now = Date.now();
  if (!jwksCache.keys || now - jwksCache.fetchedAt > JWKS_TTL_MS) {
    jwksCache = { keys: await fetchJwks(), fetchedAt: now };
  }
  let jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) { // 회전 등으로 새 kid → 강제 재조회
    jwksCache = { keys: await fetchJwks(), fetchedAt: now };
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('일치하는 Apple 공개키가 없습니다.');
  // Node 내장: JWK(RSA n/e) → 공개키 객체 → PEM.
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

/**
 * Apple identity token 검증.
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email: string|null, emailVerified: boolean }>}
 */
async function verifyIdentityToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Apple identityToken 이 필요합니다.');
  }

  // 서명 검증 전, 헤더에서 kid 를 읽어 해당 공개키를 조회.
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error('유효하지 않은 Apple 토큰입니다.');
  }

  let pem;
  try {
    pem = await getPublicKey(decoded.header.kid);
  } catch (_) {
    throw new Error('Apple 공개키 조회에 실패했습니다.');
  }

  let payload;
  try {
    payload = jwt.verify(idToken, pem, {
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience: [APPLE_BUNDLE_ID, APPLE_SERVICES_ID],
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new Error('Apple 토큰이 만료되었습니다. 다시 로그인해주세요.');
    if (err.message && err.message.includes('audience')) throw new Error('Apple 클라이언트 ID가 일치하지 않습니다.');
    throw new Error('유효하지 않은 Apple 토큰입니다.');
  }

  if (!payload || !payload.sub) throw new Error('Apple 토큰에서 사용자 식별자를 찾을 수 없습니다.');
  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  };
}

module.exports = { verifyIdentityToken, APPLE_BUNDLE_ID, APPLE_SERVICES_ID };
