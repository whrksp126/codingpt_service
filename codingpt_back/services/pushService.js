// 푸시 발송 서비스(M3-3 선골격).
// 기기 등록/해제 + 사용자별 발송. 실제 FCM/APNs 발송은 provider 키가 설정된 뒤에 dispatch 에서 구현한다.
// 지금은 골격: 키가 없으면 "would send" 로그만 남기고 스킵(앱/트리거 배관은 완성, 발송만 대기).

const { PushDevice } = require('../models');

// provider 키가 설정돼 있는가(GA 전엔 보통 false → 스킵). 나중에 이 판정을 실제 자격증명으로.
function providerConfigured() {
  return !!(process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FCM_SERVER_KEY || process.env.APNS_KEY);
}

function defaultProvider(platform) {
  // 초기 기본. 실제로는 FCM 하나로 iOS/Android 통합 가능(APNs 인증서 연결).
  return platform === 'ios' ? 'apns' : 'fcm';
}

// 기기 토큰 등록(upsert). token 재발급 시 같은 행을 갱신.
async function registerDevice(userId, { token, platform, provider }) {
  if (!token || !platform) throw new Error('token, platform 이 필요합니다.');
  const payload = {
    user_id: userId, token, platform,
    provider: provider || defaultProvider(platform),
    enabled: true, last_seen_at: new Date(), updated_at: new Date(),
  };
  const existing = await PushDevice.findOne({ where: { token } });
  if (existing) { await existing.update(payload); return existing; }
  return PushDevice.create(payload);
}

async function unregisterDevice(userId, token) {
  if (!token) return 0;
  return PushDevice.destroy({ where: { user_id: userId, token } });
}

// 사용자의 모든 활성 기기에 발송. payload = { kind, sessionId, workspaceId?, title, body?, deeplink }.
//  실패해도 throw 하지 않는다(호출부는 fire-and-forget). 반환 { sent, skipped }.
async function sendToUser(userId, payload) {
  let devices;
  try { devices = await PushDevice.findAll({ where: { user_id: userId, enabled: true } }); }
  catch (_) { return { sent: 0, skipped: 0 }; }
  if (!devices || !devices.length) return { sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;
  for (const d of devices) {
    try { (await dispatch(d, payload)) ? (sent += 1) : (skipped += 1); }
    catch (e) { skipped += 1; console.warn('[push] 발송 실패 device=' + d.id + ': ' + (e && e.message)); }
  }
  return { sent, skipped };
}

// 실제 발송 지점(선골격). provider 미설정이면 로그만 남기고 스킵.
//  ── GA 구현 시 여기서 ──
//   · FCM HTTP v1: POST https://fcm.googleapis.com/v1/projects/<pid>/messages:send (OAuth, service account)
//   · APNs HTTP/2: https://api.push.apple.com/3/device/<token> (JWT 인증)
//   · 발송 실패(등록해제/무효 토큰)면 device.update({ enabled:false }) 로 정리
async function dispatch(device, payload) {
  if (!providerConfigured()) {
    console.log(`[push] (provider 미설정 · 스킵) user=${device.user_id} ${device.platform} kind=${payload.kind} title="${payload.title}" deeplink=${payload.deeplink}`);
    return false;
  }
  // TODO(M3-3 GA): device.provider 에 따라 FCM/APNs 실제 발송.
  console.log(`[push] provider 설정됨 — 발송 구현 대기 user=${device.user_id} ${device.platform}`);
  return false;
}

module.exports = { registerDevice, unregisterDevice, sendToUser, providerConfigured };
