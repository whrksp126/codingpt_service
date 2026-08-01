// update-scheduler — 켜져 있는 동안의 자동 업데이트(발견 → 사전 다운로드 → 조용한 순간에 적용).
//
// 왜 필요한가(2026-08-01 사용자 지적):
//  이 제품은 **원격 접속을 위해 PC 를 며칠씩 켜 두는 것**이 정상 사용이다. 그런데 업데이트 확인이
//  부팅 시 1회(main.js) + 설정 화면을 직접 열었을 때뿐이라, PC 를 안 끄는 사용자는 사실상 영원히
//  업데이트를 모른다. 그 상태로 폰 앱만 새 버전이 되면 "기능이 안 되는 버그" 로 보인다.
//
// 재시작 비용에 대한 실측(중요):
//  터미널은 별도 tmux 서버 프로세스가 들고 있어 **앱/데몬이 재시작해도 죽지 않는다**(데몬보다
//  3시간 먼저 만들어진 세션이 살아 있는 것을 프로세스 시작 시각으로 확인). 안에서 돌던 에이전트도
//  계속 돈다. 즉 업데이트의 진짜 비용은 "작업 날림" 이 아니라 **20~30초 연결 끊김**이다.
//  → 전략은 "업데이트를 피하자" 가 아니라 "끊겨도 되는 순간을 골라 조용히 적용하자" 가 된다.
//
// 판정 원칙:
//  - 조용함 = 에이전트 미작업 + 승인 대기 없음 + 원격 화면 없음 + 이 창이 포커스 아님.
//    네 조건 모두 이미 우리가 아는 신호다(agentStates / approvals / ui.clients / document.hasFocus).
//  - 조용하면 묻지 않고 적용한다(아무도 안 보고 있으므로 알릴 대상 자체가 없다).
//  - 누군가 쓰고 있으면 **묻는다**. 문구에 "하던 작업은 그대로 유지됨" 을 반드시 넣는다 —
//    이 한 줄이 없으면 사용자는 작업이 날아갈까 봐 영원히 미룬다(실제 동작이 그러하므로 정직한 문구다).
//  - "나중에" 를 눌러도 유예 기간이 지나면 다음 유휴 순간에 적용한다(무한 연기 방지, 강제 아님).
import { api } from "./api.js";
import { state, agentStates } from "./state.js";
import { anyAgentWorking, judgeQuiet, remoteViewers } from "./update-policy.js";
import { announceUpdateReady, announceUpdating, isReallyFocused, setRemoteUpdateHandler } from "./ui-channel.js";

// 확인 주기 — 앱이 며칠씩 떠 있으므로 하루 1회면 충분하다. 실패는 1시간 뒤 재시도(6시간까지 백오프).
const CHECK_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;
// 준비가 끝난 뒤 "지금 조용한가" 를 살피는 주기.
const QUIET_POLL_MS = 60 * 1000;
// 사용자가 "나중에" 를 누른 뒤 다시 묻지 않는 기간. 이 뒤엔 유휴 순간에 조용히 적용한다.
const DEFER_MS = 3 * 24 * 60 * 60 * 1000;

let started = false;
let checkTimer = null;
let quietTimer = null;
let retryMs = RETRY_MS;
let stagedVersion = null; // 다운로드까지 끝난 버전
let deferUntil = 0; // 사용자가 미룬 시각(ms epoch)
let applying = false;
let onBanner = null; // (info|null) => void — 배너 렌더는 호출부(main.js)가 주입

// ── 조용함 판정 ────────────────────────────────────────────────────
// 규칙 자체는 update-policy.js(의존성 0, 테스트 대상). 여기선 지금 상태를 모아 넣기만 한다.
async function currentQuiet() {
  let clients = null;
  try {
    const r = await api.fetchUiClients();
    clients = (r && (r.clients || r.data?.clients)) || null;
  } catch (_) {
    clients = null; // 오프라인/미페어링 — 모름
  }
  return judgeQuiet({
    agentWorking: anyAgentWorking(agentStates),
    approvals: (state.approvals || []).length,
    viewers: remoteViewers(clients),
    // ⚠ document.hasFocus() 를 쓰지 않는다 — WKWebView 에서는 OS 앱 전환에 안 따라온다(실측).
    //  ui-channel 이 present 판정에 쓰는 것과 **같은 진실源**(NSWindow key 상태)을 쓴다.
    focused: isReallyFocused(),
  });
}

// ── 적용 ──────────────────────────────────────────────────────────
export async function applyNow() {
  if (applying) return;
  applying = true;
  // 내려가기 **직전**에 사유를 알린다 — 원격 화면이 "연결 끊김" 대신 "업데이트 중" 을 보게.
  //  실패해도 그냥 진행한다(문구가 일반 오프라인으로 폴백될 뿐, 업데이트를 막을 이유가 못 된다).
  try { announceUpdating(stagedVersion || ""); } catch (_) { /* noop */ }
  try {
    await api.updateInstall(); // 준비돼 있으면 즉시 설치+재시작(성공 시 이 아래는 실행되지 않는다)
  } catch (e) {
    applying = false;
    throw e;
  }
}

// 사용자가 "나중에" — 유예를 두되 영구 무시는 아니다.
export function deferApply() {
  deferUntil = Date.now() + DEFER_MS;
  onBanner?.(null);
}

// ── 루프 ──────────────────────────────────────────────────────────
// 'staged'(받아 둠) | 'none'(최신) | 'error'(확인/다운로드 실패 → 백오프 재시도)
async function tryStage() {
  let r = null;
  try {
    r = await api.updateCheck();
  } catch (_) {
    return "error";
  }
  // updateCheck 는 실패도 { available:false, error } 로 정규화한다 — 그건 '최신' 이 아니라 '실패'다.
  if (!r || (!r.available && r.error)) return "error";
  if (!r.available) return "none";
  // 발견 즉시 받아만 둔다 — 적용 시점의 끊김을 십몇 초로 줄이는 핵심.
  try {
    const d = await api.updateDownload();
    stagedVersion = (d && d.version) || r.version || null;
  } catch (_) {
    return "error"; // 다음 주기에 재시도(부분 다운로드는 Rust 쪽에서 버려진다)
  }
  // 받아 두었음을 전 화면에 알린다 — 폰에서 원격으로 적용할 수 있게(사용자는 PC 앞에 없을 수 있다).
  try { announceUpdateReady(stagedVersion || ""); } catch (_) { /* noop */ }
  startQuietWatch();
  return "staged";
}

function startQuietWatch() {
  if (quietTimer) return;
  const tick = async () => {
    if (!stagedVersion || applying) return;
    const v = await currentQuiet();
    if (v.quiet) {
      // 아무도 안 보고 아무것도 안 돈다 → 묻지 않고 적용. 알릴 대상 자체가 없다.
      onBanner?.(null);
      try { await applyNow(); } catch (_) { /* 다음 틱에 재시도 */ }
      return;
    }
    // 사용자가 미뤄 뒀으면 유예가 끝날 때까지 배너를 다시 띄우지 않는다(유휴가 오면 위에서 적용됨).
    if (Date.now() < deferUntil) { onBanner?.(null); return; }
    onBanner?.({ version: stagedVersion, reason: v.reason });
  };
  quietTimer = setInterval(() => { void tick(); }, QUIET_POLL_MS);
  void tick();
}

function scheduleCheck(ms) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const r = await tryStage();
    if (r === "error") {
      // 네트워크·서버 장애 — 지수 백오프(6시간 상한)로 재시도. 정주기(24h)로 물러나면
      //  일시 장애 하나 때문에 하루를 통째로 놓친다.
      scheduleCheck(retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      return;
    }
    retryMs = RETRY_MS;
    if (r === "staged") return; // 받아 뒀으면 이제 조용한 순간만 기다린다(재확인 불필요)
    scheduleCheck(CHECK_MS);
  }, ms);
}

/**
 * 시작. renderBanner(info|null) 은 배너 UI 를 그리는 콜백(main.js 주입).
 *  부팅 직후 확인은 main.js 의 maybeInstallSetupUpdate 가 이미 한다 — 여기선 **그 이후**를 맡는다.
 */
export function startUpdateScheduler(renderBanner) {
  if (started) return;
  started = true;
  onBanner = typeof renderBanner === "function" ? renderBanner : null;
  // 폰에서 온 "지금 업데이트" 지시 — 준비된 게 있을 때만 의미가 있다(없으면 조용히 무시).
  setRemoteUpdateHandler(() => { if (stagedVersion) void applyNow().catch(() => {}); });
  // 이미 준비된 게 있으면(이전 세션에서 받아둔 건 메모리라 없지만, 방어적으로) 감시부터 건다.
  api.updateStaged().then((v) => { if (v) { stagedVersion = v; startQuietWatch(); } }).catch(() => {});
  scheduleCheck(CHECK_MS);
}

// 테스트/수동 트리거용 — 지금 즉시 확인한다(설정 화면의 "업데이트" 버튼과는 별개 경로).
export async function checkNow() {
  return tryStage();
}

export const _internals = { judgeQuiet, remoteViewers, anyAgentWorking, CHECK_MS, DEFER_MS, QUIET_POLL_MS };
