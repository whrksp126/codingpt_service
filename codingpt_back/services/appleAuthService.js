/**
 * Apple 로그인 — identity token(id_token) 검증.
 *
 *  클라이언트(iOS 네이티브 / 웹 AppleID JS / PC·안드로이드 웹플로우)가 Apple 로부터 받은 id_token 을
 *  그대로 백엔드에 넘기면, 여기서 Apple 공개키(JWKS)로 서명·발급자·수신자·만료를 검증하고
 *  { sub, email, emailVerified } 를 돌려준다. 구글 로그인(userService.login)과 대칭 구조.
 *
 *  audience(수신자)는 클라이언트 종류에 따라 다르다:
 *   · iOS 네이티브        → 앱 번들 ID (APPLE_BUNDLE_ID)
 *   · 웹/PC/안드로이드 웹  → Services ID (APPLE_SERVICES_ID)
 *  둘 다 허용한다.
 */
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.ghmate.codingpt.app';
const APPLE_SERVICES_ID = process.env.APPLE_SERVICES_ID || 'com.ghmate.codingpt.web';

// JWKS 클라이언트 — Apple 공개키를 kid 로 조회(캐시 + rate-limit 내장).
const client = jwksClient({
  jwksUri: APPLE_JWKS_URI,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000, // 24h
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Apple identity token 검증.
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email: string|null, emailVerified: boolean }>}
 */
function verifyIdentityToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    return Promise.reject(new Error('Apple identityToken 이 필요합니다.'));
  }
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getKey,
      {
        algorithms: ['RS256'],
        issuer: APPLE_ISSUER,
        audience: [APPLE_BUNDLE_ID, APPLE_SERVICES_ID],
      },
      (err, payload) => {
        if (err) {
          // 원인별 사용자 메시지
          if (err.name === 'TokenExpiredError') return reject(new Error('Apple 토큰이 만료되었습니다. 다시 로그인해주세요.'));
          if (err.message && err.message.includes('audience')) return reject(new Error('Apple 클라이언트 ID가 일치하지 않습니다.'));
          return reject(new Error('유효하지 않은 Apple 토큰입니다.'));
        }
        if (!payload || !payload.sub) return reject(new Error('Apple 토큰에서 사용자 식별자를 찾을 수 없습니다.'));
        resolve({
          sub: String(payload.sub),
          email: payload.email ? String(payload.email) : null,
          // email_verified 는 문자열 'true' 로 오기도 한다.
          emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        });
      }
    );
  });
}

module.exports = { verifyIdentityToken, APPLE_BUNDLE_ID, APPLE_SERVICES_ID };
