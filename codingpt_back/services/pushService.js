// 푸시 발송 서비스(M3-3).
// 기기 등록/해제 + 사용자별 발송. 실제 FCM/APNs 발송은 pushProviderService 가 담당.
// provider 자격증명(env)이 없으면 "would send" 로그만 남기고 스킵(앱/트리거 배관은 완성, 발송만 대기).

const { PushDevice } = require('../models');
const pushProvider = require('./pushProviderService');

// provider 자격증명이 설정돼 있는가(미설정이면 스킵). 실제 판정은 pushProviderService 로 위임.
function providerConfigured() {
  return pushProvider.configured();
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

// 실제 발송 지점. provider 미설정이면 로그만 남기고 스킵.
//  device.provider(또는 platform)로 FCM/APNs 라우팅. 무효 토큰이면 기기 비활성화.
async function dispatch(device, payload) {
  if (!providerConfigured()) {
    console.log(`[push] (provider 미설정 · 스킵) user=${device.user_id} ${device.platform} kind=${payload.kind} title="${payload.title}" deeplink=${payload.deeplink}`);
    return false;
  }
  const provider = device.provider || defaultProvider(device.platform);
  const r = provider === 'apns' || device.platform === 'ios'
    ? await pushProvider.sendApns(device, payload)
    : await pushProvider.sendFcm(device, payload);
  if (r.ok) return true;
  // 무효 토큰(등록해제/BadDeviceToken) → 다음 발송 대상에서 제외.
  if (r.invalidToken) {
    try { await device.update({ enabled: false, updated_at: new Date() }); } catch (_) { /* noop */ }
    console.log(`[push] 무효 토큰 → 비활성화 device=${device.id} status=${r.status || ''}`);
  } else if (r.err) {
    console.warn(`[push] ${provider} 발송 실패 device=${device.id} status=${r.status || ''} ${r.err}`);
  }
  return false;
}

module.exports = { registerDevice, unregisterDevice, sendToUser, providerConfigured };
