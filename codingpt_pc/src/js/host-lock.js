// host-lock.js — 호스트(내 PC)별 열쇠 세대 보관소 = **정직한 자물쇠 표시**의 근거.
//
// 왜 이 모듈이 필요한가:
//  설정의 '종단간 암호화 켜짐' 은 이 기기(사이드카 데몬) 열쇠만 보고 있었다. 그런데 실제 트래픽이
//  암호화되는지는 **상대 호스트도 열쇠를 갖고 있느냐**에 달려 있다(교집합 게이팅). 열쇠 없는 PC 데몬으로
//  가는 fs/터미널 바이트는 100% 평문 릴레이인데 화면은 '켜짐' 이었다 = 거짓 자물쇠. 게다가 봉투 RPC
//  미지원 네거티브 캐시(10분, e2ee.js)가 재시도조차 억제해 사용자에게 어떤 신호도 남지 않는다.
//
//  back 은 이미 `runner_status.e2eeEpoch`(daemonRelayService.js:79/219 — hello.e2eeEpoch, 0=열쇠 없음)를
//  전 기기로 팬아웃한다(PC 의 ui 스트림 = agentWsClients 라 같은 프레임이 온다). 지금까지 PC 는 이 type 을
//  무시했다 — 여기서 받아 보관하고 `hostLockLabel()` 로 호스트별 배지를 그린다. 새 배관 0개.
//  ★ 모바일 `src/services/e2ee/hostLock.ts` + `e2eeState.ts hostLockLabel()` 의 미러다(라벨 문구까지 동일).
//
//  ⚠ 이 값은 **표시 전용**이다. 게이팅(봉인 시도 여부)은 그대로 실제 왕복 결과로 판단한다 — epoch 를
//   근거로 미리 막으면 구 back(필드 없음 = undefined)에서 기능이 조용히 꺼진다(무마찰 불변식).
//  ⚠ 호스트가 오프라인이면 항목을 지운다: 마지막 값은 근거가 사라진 사진이다(agent_state 규율 미러).
//  ⚠ 순수 모듈로 유지한다(state.js 를 import 하지 않는다) — 호출부가 반환값(변경됨)을 보고 emit 한다.

const epochs = new Map(); // hostDeviceId(number) → epoch(number, 0=열쇠 없음)

/**
 * runner_status 수신 반영.
 * @param {number} host hostDeviceId
 * @param {number|null|undefined} epoch 0/undefined = 열쇠 없음, null = 오프라인(항목 삭제)
 * @returns {boolean} 스토어가 바뀌었는지(호출부가 S.emit() 할지 판단)
 */
export function setHostE2eeEpoch(host, epoch) {
  const h = Number(host);
  if (!Number.isFinite(h)) return false;
  if (epoch == null) return epochs.delete(h);
  const v = Number(epoch) > 0 ? Number(epoch) : 0;
  if (epochs.get(h) === v) return false;
  epochs.set(h, v);
  return true;
}
/** back 의 runner_status 이벤트를 그대로 먹인다(online:false = 항목 삭제). @returns 변경됨 */
export function applyRunnerStatus(ev) {
  if (!ev || ev.deviceId == null) return false;
  return setHostE2eeEpoch(ev.deviceId, ev.online === false ? null : ev.e2eeEpoch);
}
/** 그 호스트의 열쇠 세대. undefined = 모름(구 back / 아직 프레임 없음) — '평문' 이라고 단정하지 않는다. */
export function hostE2eeEpoch(host) {
  const h = Number(host);
  if (host == null || !Number.isFinite(h)) return undefined;
  return epochs.get(h);
}
/** 로그아웃/계정 전환/탈퇴 — 전량 폐기(다음 계정의 배지로 새지 않게). @returns 변경됨 */
export function resetHostLocks() {
  if (!epochs.size) return false;
  epochs.clear();
  return true;
}

/**
 * **호스트별** 자물쇠 라벨 — 이 PC 로 가는 트래픽이 실제로 암호화되는가(교집합).
 *  근거 = `runner_status.e2eeEpoch`(0 = 그 호스트에 열쇠 없음, undefined = 구 back 이거나
 *  아직 프레임을 못 받았다 = 모름).
 *  ⚠ '모름' 을 '평문' 으로 단정하지 않는다 — 표시를 위해 있는 값이지 게이팅 근거가 아니다.
 *  문구는 모바일 `hostLockLabel()` 과 **글자까지 동일**해야 한다(사용자가 두 화면을 나란히 본다).
 *
 * ★ 세대(epoch)까지 교집합이다(2026-07-25 실측 결함 · 계약 §2.7). `hostEpoch > 0` 만 보고 '암호화됨' 을
 *   그리면 **회전 직후 최대 15분간 거짓 자물쇠**다: 데몬은 회전을 push 없이 폴링으로만 감지하므로
 *   (e2ee-account.js TRUSTED_MS=15분) back 이 팬아웃하는 e2eeEpoch 는 그 동안 옛 세대다. 그 사이 이 화면이
 *   새 세대로 봉인하면 데몬이 E2EE_EPOCH_MISMATCH → back 409 → 평문 REST 로 폴백하는데 배지는 초록이었다.
 *   그래서 `myEpoch` 를 받아 **세대가 일치할 때만** '암호화됨' 을 그린다(불일치 = '확인 중').
 *   `myEpoch` 를 넘기지 않으면(구 호출부) 세대 대조를 건너뛴다 — 기존 동작 그대로.
 *   ⚠ 모바일 `e2eeState.ts hostLockLabel()` 과 **같은 순서·같은 문구**여야 한다(판정 순서가 어긋나면
 *    같은 입력에서 두 화면이 다른 색을 그린다). PC↔앱 동치는 test/e2ee-crossimpl.mjs 가 고정한다.
 */
export function hostLockLabel(selfReady, hostEpoch, myEpoch) {
  if (!selfReady) return { text: "평문", tone: "off" };            // 이 기기에 열쇠가 없다
  if (hostEpoch == null) return { text: "확인 중", tone: "wait" }; // 아직 모름(구 back 포함)
  if (Number(hostEpoch) <= 0) return { text: "이 PC 는 평문(열쇠 없음)", tone: "off" };
  // 세대 불일치 = 지금 보내는 봉투가 그 PC 에서 거절된다(또는 그 PC 의 봉투를 내가 못 연다) = 평문 폴백.
  if (myEpoch != null && Number(myEpoch) > 0 && Number(myEpoch) !== Number(hostEpoch)) {
    return { text: "확인 중", tone: "wait" };
  }
  return { text: "암호화됨", tone: "on" };
}

export default { setHostE2eeEpoch, applyRunnerStatus, hostE2eeEpoch, resetHostLocks, hostLockLabel };
