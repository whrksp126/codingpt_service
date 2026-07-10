// 푸시 실발송 provider — FCM HTTP v1 + APNs HTTP/2 (M3-3 GA).
//  자격증명은 env 로만 주입(코드/저장소에 하드코딩·커밋 금지):
//   · FCM: FCM_SERVICE_ACCOUNT_JSON(서비스계정 JSON 인라인 또는 파일경로) [+ FCM_PROJECT_ID(생략 시 SA 의 project_id)]
//   · APNs: APNS_KEY(.p8 PEM 인라인 또는 파일경로) + APNS_KEY_ID + APNS_TEAM_ID + APNS_BUNDLE_ID [+ APNS_PRODUCTION=1]
//  무효 토큰(등록해제/BadDeviceToken)은 { invalidToken:true } 로 알려 호출부가 기기를 비활성화한다.
const fs = require('fs');
const http2 = require('http2');
const jwt = require('jsonwebtoken');

// env 값이 '{'로 시작하면 인라인 JSON/PEM, 아니면 파일경로로 간주해 읽는다.
function readInlineOrFile(val, expectBrace) {
  if (!val) return null;
  const s = String(val).trim();
  const looksInline = expectBrace ? s.startsWith('{') : s.includes('BEGIN');
  if (looksInline) return s;
  try { return fs.readFileSync(s, 'utf8'); } catch (_) { return null; }
}

// 문자열 data 페이로드(FCM data 는 문자열만 허용). null/undefined 제외.
function stringData(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = String(v);
  return out;
}

// ── FCM HTTP v1 ──────────────────────────────────────────────────────
let _fcmSa = null;                // 파싱된 서비스계정
let _fcmToken = null;             // { access_token, exp(ms) }

function loadFcmServiceAccount() {
  if (_fcmSa) return _fcmSa;
  const raw = readInlineOrFile(process.env.FCM_SERVICE_ACCOUNT_JSON, true);
  if (!raw) return null;
  try { _fcmSa = JSON.parse(raw); return _fcmSa; }
  catch (e) { console.warn('[push] FCM 서비스계정 파싱 실패: ' + e.message); return null; }
}

// 서비스계정 → OAuth access token(캐시, 만료 60s 전 갱신).
async function getFcmAccessToken() {
  const now = Date.now();
  if (_fcmToken && _fcmToken.exp - 60000 > now) return _fcmToken.access_token;
  const sa = loadFcmServiceAccount();
  if (!sa || !sa.private_key || !sa.client_email) return null;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = jwt.sign(
    { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
    sa.private_key,
    { algorithm: 'RS256', issuer: sa.client_email, subject: sa.client_email, audience: tokenUri, expiresIn: 3600, keyid: sa.private_key_id },
  );
  let res;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
  } catch (e) { console.warn('[push] FCM 토큰 요청 오류: ' + e.message); return null; }
  if (!res.ok) { console.warn('[push] FCM 토큰 교환 실패 status=' + res.status); return null; }
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) return null;
  _fcmToken = { access_token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return _fcmToken.access_token;
}

async function sendFcm(device, payload) {
  const sa = loadFcmServiceAccount();
  const projectId = process.env.FCM_PROJECT_ID || (sa && sa.project_id);
  if (!projectId) return { ok: false };
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return { ok: false };
  const message = {
    message: {
      token: device.token,
      notification: { title: payload.title || 'CodingPT', body: payload.body || '' },
      data: stringData({ kind: payload.kind, sessionId: payload.sessionId, workspaceId: payload.workspaceId, deeplink: payload.deeplink }),
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    },
  };
  let res;
  try {
    res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (e) { return { ok: false, err: e.message }; }
  if (res.ok) return { ok: true };
  const errText = await res.text().catch(() => '');
  const invalidToken = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(errText);
  return { ok: false, invalidToken, status: res.status, err: errText.slice(0, 200) };
}

// ── APNs HTTP/2 ──────────────────────────────────────────────────────
let _apnsJwt = null;             // { token, iat(ms) } — APNs JWT 는 재사용 권장(20~60분)

function apnsConfig() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  const pem = readInlineOrFile(process.env.APNS_KEY, false);
  if (!pem || !keyId || !teamId || !bundleId) return null;
  return { pem, keyId, teamId, bundleId, production: /^(1|true|prod)/i.test(String(process.env.APNS_PRODUCTION || '')) };
}

function getApnsJwt(cfg) {
  const now = Date.now();
  if (_apnsJwt && now - _apnsJwt.iat < 50 * 60 * 1000) return _apnsJwt.token;
  const token = jwt.sign({}, cfg.pem, { algorithm: 'ES256', issuer: cfg.teamId, keyid: cfg.keyId });
  _apnsJwt = { token, iat: now };
  return token;
}

function sendApns(device, payload) {
  return new Promise((resolve) => {
    const cfg = apnsConfig();
    if (!cfg) return resolve({ ok: false });
    let bearer;
    try { bearer = getApnsJwt(cfg); } catch (e) { return resolve({ ok: false, err: 'jwt: ' + e.message }); }
    const host = cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    let client;
    try { client = http2.connect(host); } catch (e) { return resolve({ ok: false, err: e.message }); }
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { client.close(); } catch (_) {} resolve(r); };
    client.on('error', (e) => done({ ok: false, err: e.message }));
    const body = JSON.stringify({
      aps: { alert: { title: payload.title || 'CodingPT', body: payload.body || '' }, sound: 'default' },
      ...stringData({ kind: payload.kind, sessionId: payload.sessionId, workspaceId: payload.workspaceId, deeplink: payload.deeplink }),
    });
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${device.token}`,
      authorization: `bearer ${bearer}`, 'apns-topic': cfg.bundleId, 'apns-push-type': 'alert', 'content-type': 'application/json',
    });
    let status = 0, resp = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { resp += d; });
    req.on('end', () => {
      if (status === 200) return done({ ok: true });
      const invalidToken = status === 410 || /BadDeviceToken|Unregistered/i.test(resp);
      done({ ok: false, invalidToken, status, err: resp.slice(0, 200) });
    });
    req.on('error', (e) => done({ ok: false, err: e.message }));
    req.setTimeout(8000, () => done({ ok: false, err: 'timeout' }));
    req.end(body);
  });
}

// provider 자격증명이 하나라도 설정됐는가.
function configured() {
  return !!(loadFcmServiceAccount() || apnsConfig());
}

module.exports = { sendFcm, sendApns, configured };
