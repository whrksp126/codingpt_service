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
const fs = require('fs');
const jwt = require('jsonwebtoken');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';
const APPLE_TOKEN_URI = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URI = 'https://appleid.apple.com/auth/revoke';

const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.ghmate.codingpt.app';
const APPLE_SERVICES_ID = process.env.APPLE_SERVICES_ID || 'com.ghmate.codingpt.web';

// 회원탈퇴 시 Apple 연동 해제(App Store 5.1.1(v) 의무)에 필요한 값.
//  .p8 개인키로 ES256 client_secret 을 서명 → authorizationCode 를 refresh_token 으로 교환 → 저장 →
//  탈퇴 시 revoke. .p8 이 없으면(예: 배포 전) 관련 기능만 조용히 no-op — 로그인 자체는 영향 없음.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'BB8GGQPRRX';
const APPLE_KEY_ID = process.env.APPLE_KEY_ID || 'J89V87G5F7';
// 개인키: 값 직접 주입(APPLE_P8_KEY, 개행 \n 이스케이프 허용) 우선, 없으면 파일 경로(APPLE_P8_PATH).
const APPLE_P8_KEY = process.env.APPLE_P8_KEY || '';
const APPLE_P8_PATH = process.env.APPLE_P8_PATH || '';

let p8Cache; // undefined=미조회, null=없음, string=PEM
function getP8() {
  if (p8Cache !== undefined) return p8Cache;
  try {
    if (APPLE_P8_KEY) p8Cache = APPLE_P8_KEY.replace(/\\n/g, '\n');
    else if (APPLE_P8_PATH && fs.existsSync(APPLE_P8_PATH)) p8Cache = fs.readFileSync(APPLE_P8_PATH, 'utf8');
    else p8Cache = null;
  } catch (_) { p8Cache = null; }
  return p8Cache;
}

// Apple client_secret(ES256 JWT). sub=client_id(교환/폐기 대상 토큰의 aud 와 일치해야 함).
function makeClientSecret(clientId) {
  const key = getP8();
  if (!key) throw new Error('Apple 개인키(.p8)가 설정되지 않았습니다.');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: APPLE_TEAM_ID, iat: now, exp: now + 3600, aud: APPLE_ISSUER, sub: clientId },
    key,
    { algorithm: 'ES256', header: { kid: APPLE_KEY_ID } }
  );
}

// application/x-www-form-urlencoded POST — Apple 토큰/폐기 엔드포인트용.
function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// authorizationCode → refresh_token 교환. 성공 시 refresh_token 문자열, 실패/미설정 시 null.
//  clientId 는 로그인에 쓰인 aud(네이티브=번들ID, 웹=ServicesID).
async function exchangeAuthCode(code, clientId) {
  if (!code || !getP8()) return null;
  try {
    const { status, text } = await postForm(APPLE_TOKEN_URI, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: makeClientSecret(clientId),
    });
    if (status !== 200) { console.warn('[apple] code 교환 실패', status, text.slice(0, 300)); return null; }
    return JSON.parse(text).refresh_token || null;
  } catch (e) {
    console.warn('[apple] code 교환 예외', e.message);
    return null;
  }
}

// refresh_token 폐기(연동 해제). 성공/미설정 무관하게 throw 하지 않음(탈퇴 흐름을 막지 않도록).
async function revokeToken(refreshToken, clientId) {
  if (!refreshToken || !clientId || !getP8()) return false;
  try {
    const { status, text } = await postForm(APPLE_REVOKE_URI, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: clientId,
      client_secret: makeClientSecret(clientId),
    });
    if (status !== 200) { console.warn('[apple] revoke 실패', status, text.slice(0, 300)); return false; }
    return true;
  } catch (e) {
    console.warn('[apple] revoke 예외', e.message);
    return false;
  }
}

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
    // 이 토큰의 수신자(client_id) — code 교환·revoke 에 동일 값이 필요하다.
    aud: Array.isArray(payload.aud) ? String(payload.aud[0]) : String(payload.aud || ''),
  };
}

module.exports = {
  verifyIdentityToken, exchangeAuthCode, revokeToken,
  APPLE_BUNDLE_ID, APPLE_SERVICES_ID,
};
