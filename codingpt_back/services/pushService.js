// 푸시 발송 서비스(M3-3).
// 기기 등록/해제 + 사용자별 발송. 실제 FCM/APNs 발송은 pushProviderService 가 담당.
// provider 자격증명(env)이 없으면 "would send" 로그만 남기고 스킵(앱/트리거 배관은 완성, 발송만 대기).

const { PushDevice } = require('../models');
const pushProvider = require('./pushProviderService');

// provider 자격증명이 설정돼 있는가(미설정이면 스킵). 실제 판정은 pushProviderService 로 위임.
function providerConfigured() {
  return pushProvider.configured();
}

function defaultProvider(_platform) {
  // 앱은 @react-native-firebase(FCM) 를 쓰므로 iOS/Android 모두 FCM 토큰(Firebase 가 APNs 릴레이).
  //  → 기본 FCM. 직접 APNs 토큰을 쓰는 경우에만 등록 시 provider='apns' 명시.
  return 'fcm';
}

// 기기 토큰 등록(upsert). token 재발급 시 같은 행을 갱신.
//  alertWhenPcActive: 앱의 로컬 설정을 서버에 미러(라우팅 토글). 미지정이면 기존값 유지(신규는 false).
async function registerDevice(userId, { token, platform, provider, alertWhenPcActive }) {
  if (!token || !platform) throw new Error('token, platform 이 필요합니다.');
  const payload = {
    user_id: userId, token, platform,
    provider: provider || defaultProvider(platform),
    enabled: true, last_seen_at: new Date(), updated_at: new Date(),
  };
  if (typeof alertWhenPcActive === 'boolean') payload.alert_when_pc_active = alertWhenPcActive;
  const existing = await PushDevice.findOne({ where: { token } });
  if (existing) { await existing.update(payload); return existing; }
  return PushDevice.create(payload);
}

// 라우팅 토글 갱신 — 사용자의 모든 기기에 일괄 적용(앱 설정 화면 토글). 반환 = 갱신된 행 수.
async function setAlertWhenPcActive(userId, value) {
  const [count] = await PushDevice.update(
    { alert_when_pc_active: !!value, updated_at: new Date() },
    { where: { user_id: userId } },
  );
  return count;
}

async function unregisterDevice(userId, token) {
  if (!token) return 0;
  return PushDevice.destroy({ where: { user_id: userId, token } });
}

// 사용자의 모든 활성 기기에 발송. payload = { kind, sessionId, workspaceId?, title, body?, deeplink }.
//  opts.pcActive: 지금 PC 를 실제로 쓰는 중(present=pc+fresh)이면 true → alert_when_pc_active=false 인
//   기기(기본)는 건너뛴다("PC 사용 중 이 폰 무음" 토글). 토글을 끈(=true) 기기만 그때도 푸시한다.
//  실패해도 throw 하지 않는다(호출부는 fire-and-forget). 반환 { sent, skipped }.
async function sendToUser(userId, payload, opts = {}) {
  let devices;
  try { devices = await PushDevice.findAll({ where: { user_id: userId, enabled: true } }); }
  catch (_) { return { sent: 0, skipped: 0 }; }
  if (!devices || !devices.length) return { sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;
  for (const d of devices) {
    if (opts.pcActive && !d.alert_when_pc_active) { skipped += 1; continue; } // PC 사용 중 무음 토글
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
  // 프로바이더 기준 라우팅(플랫폼 아님) — RN Firebase 는 iOS 도 FCM 토큰이므로 기본 FCM.
  //  직접 APNs 토큰(provider='apns')일 때만 APNs HTTP/2 로 보낸다.
  const provider = device.provider || defaultProvider(device.platform);
  const r = provider === 'apns'
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

module.exports = { registerDevice, unregisterDevice, setAlertWhenPcActive, sendToUser, providerConfigured };
