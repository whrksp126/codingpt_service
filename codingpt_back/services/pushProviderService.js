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

// 표시 푸시(FCM) 메시지 조립(순수) — 액션 가능 푸시(승인)만 추가 필드가 붙고, 나머지는 기존과 동일.
//  · payload.data     — 기본 data 위에 얹는 추가 키(approvalId/deadlineAt/tool/actions). 문자열화됨.
//  · payload.channelId— Android 알림 채널(미지정 = codingpt_default). 앱이 만들지 않은 채널을 지정하면
//                       FCM 이 매니페스트 기본 채널로 폴백하므로 표시 자체는 유실되지 않는다.
//  · payload.category — iOS aps.category(UNNotificationCategory 식별자, 예 CPT_APPROVAL) + 시간민감 레벨.
//                       미지정이면 aps 는 예전 그대로 { sound:'default' } 다(기존 알림 회귀 0).
//  ★ Android 는 notification+data 혼합 유지 — data-only 로 바꾸면 제조사 절전에서 유실 시 아무것도 안 뜬다.
function buildFcmMessage(device, payload) {
  return {
    message: {
      token: device.token,
      notification: { title: payload.title || 'CodingPT', body: payload.body || '' },
      data: stringData({
        kind: payload.kind, sessionId: payload.sessionId, workspaceId: payload.workspaceId,
        deeplink: payload.deeplink, notifId: payload.notifId,
        ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
      }),
      // Android: 소리·진동·헤드업 명시(채널 codingpt_default = importance HIGH). notification 블록이 없으면
      //  기기/런처가 조용히 처리하는 경우가 있어 명시한다.
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          default_sound: true,
          default_vibrate_timings: true,
          channel_id: payload.channelId || 'codingpt_default',
          notification_priority: 'PRIORITY_MAX',
          // 크로스기기 dismiss 용 안정 태그 — FCM SDK 가 이 태그(id=0)로 표시하므로,
          //  나중에 NotificationManager.cancel(tag, 0) 로 정확히 그 배너만 회수할 수 있다.
          //  승인 알림도 같은 규약을 유지해야 NotifTray 회수 로직이 무수정으로 동작한다.
          ...(payload.notifId != null ? { tag: `cptnotif-${payload.notifId}` } : {}),
        },
      },
      // iOS: 최고 우선순위 + 소리(사용자 Focus/무음 상태는 기기가 판단).
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: {
          aps: {
            sound: 'default',
            ...(payload.category ? { category: payload.category, 'interruption-level': 'time-sensitive' } : {}),
          },
        },
      },
    },
  };
}

async function sendFcm(device, payload) {
  const sa = loadFcmServiceAccount();
  const projectId = process.env.FCM_PROJECT_ID || (sa && sa.project_id);
  if (!projectId) return { ok: false };
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return { ok: false };
  const message = buildFcmMessage(device, payload);
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

// data-only 무음 푸시(FCM) — 표시 없이 앱 백그라운드 핸들러만 깨운다(크로스기기 dismiss 등).
//  Android: priority high 데이터 메시지(headless JS). iOS: content-available 백그라운드 푸시
//  (스로틀될 수 있음 — best effort. 배너 회수 실패 시 사용자가 스와이프하면 그만).
async function sendFcmData(device, data) {
  const sa = loadFcmServiceAccount();
  const projectId = process.env.FCM_PROJECT_ID || (sa && sa.project_id);
  if (!projectId) return { ok: false };
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return { ok: false };
  const message = {
    message: {
      token: device.token,
      data: stringData(data),
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } },
      },
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
      // category 는 승인 등 액션 가능 알림만 채워진다(미지정 시 기존 payload 와 완전 동일).
      aps: {
        alert: { title: payload.title || 'CodingPT', body: payload.body || '' }, sound: 'default',
        ...(payload.category ? { category: payload.category, 'interruption-level': 'time-sensitive' } : {}),
      },
      ...stringData({
        kind: payload.kind, sessionId: payload.sessionId, workspaceId: payload.workspaceId, deeplink: payload.deeplink,
        ...(payload.data && typeof payload.data === 'object' ? payload.data : {}),
      }),
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

module.exports = {
  sendFcm, sendFcmData, sendApns, configured,
  _buildFcmMessage: buildFcmMessage, // 테스트 노출(순수) — 액션 푸시 조립/기존 알림 무회귀 고정
};
