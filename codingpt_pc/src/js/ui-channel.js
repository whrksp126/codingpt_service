// ui-channel.js — 백엔드 UI 실시간 채널(WS). 알림 이벤트(notif_event) 수신 + ui_command 원격 조작.
//  · 접속 URL(티켓 포함)은 Rust(ui_stream_url)가 발급 — deviceToken 은 JS 로 노출하지 않는다.
//  · 끊기면 3~10s 백오프로 재접속(티켓 재발급). 재접속 성공 시 목록 재로드로 놓친 이벤트 보충.
//  · ui_command: back 이 보내는 화면 조작 명령 프레임을 실행하고, executor=true 면 ui_result 회신.
//    {type:'ui_command', uiId, cmd, params, executor} → {type:'ui_result', uiId, ok, result?, error?}
//  · 접속 직후 ui_hello(clientKey=deviceKey, kind:'pc'), 사용자 입력 시 ui_activity(30s 스로틀) 송신.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";
import * as T from "./tiling.js";
import { getPane, smartUrl, newTid, paneForPreviewId } from "./pane.js";
import { toggleChiiDevtools, dtActive } from "./devtools.js";
import { smartAdd } from "./workspace-view.js";
import { PAGE_AGENT_JS } from "./page-agent.js";
import { startDesignPick, cancelDesignPick, isPicking } from "./design-pick.js";
import { applyChatEvent } from "./chat-view.js";
import { applyDeviceApprovalEvent, e2eeCaps, refreshE2ee } from "./e2ee.js";
import { applyRunnerStatus, resetHostLocks } from "./host-lock.js";
import { basename, IS_WINDOWS } from "./path-utils.js";
import * as i18n from './i18n/index.js';

// 원격 탈퇴 수신 — 로컬 자격 정리 후 로그인 게이트로(설정의 탈퇴 후처리와 동일 시퀀스).
async function onAccountDeleted() {
  try { await api.unpair(); } catch (_) { /* 이미 해제됐을 수 있음 */ }
  state.me = null;
  state.devices = [];
  resetHostLocks(); // 다음 계정 화면에 옛 계정 PC 의 자물쇠 배지가 새지 않게
  // ★ 열려 있던 화면(설정 모달 등)을 기본 화면으로 되돌린다(2026-07-28 실사고: 탈퇴 → 재가입 후
  //  로그인 게이트가 닫히자 이전 계정에서 열어 둔 설정 모달이 그대로 다시 나타났다 — 새 계정의
  //  첫 화면이 남의 잔상으로 시작되면 "간섭"으로 읽힌다).
  S.setView("workspace");
  state.daemon = await api.daemonStatus().catch(() => state.daemon);
  state.paired = !!state.daemon?.paired;
  S.emit();
}

let sock = null;
let retryMs = 3000;
let retryTimer = null;

// R1 — 화면(활성 pane) 폭이 이 값 미만이면 프리뷰/IDE 를 우측 분할(split) 대신 활성 터미널 pane 에
//  탭으로 편입한다(좁은 화면에서 분할하면 양쪽이 다 못 쓸 만큼 좁아지는 것 방지).
const NARROW_W = 720;

export function startUiChannel() {
  bindActivityReport();
  bindPreviewFocus(); // R4 — 프리뷰 native webview 내부 클릭 시 그 pane/탭 포커스
  startLocalUiChannel(); // 같은 기기(사이드카 데몬) 직결 — back 왕복 없는 ui_command 경로
  connect();
}

// ── 로컬 UI 채널 — 같은 기기 왕복 제거 ─────────────────────────────────────────
//  터미널의 `cpt preview open …` 은 이 PC 의 데몬에 들어간다. 지금까지는 그게 back WSS 를 한 바퀴 돌아
//  같은 기기의 이 앱으로 왔다. 데몬이 cpt.sock 으로 직접 밀어 주면 서버가 죽어 있어도 동작한다.
//  ⚠ 라우팅 결정은 **데몬 쪽**에 있다(명시 타겟이 이 머신 / back 오프라인 폴백 2경우만). 앱은 온 것을
//    실행하고 회신할 뿐이고, back 경로와 같은 handlers[] 한 벌을 쓴다(분기 이중화 금지).
let _localUiBound = false;
export function startLocalUiChannel() {
  if (_localUiBound) return;
  _localUiBound = true;
  api.onLocalUiCommand((f) => {
    if (!f || f.t !== "ui_command") return;
    // 로컬 경로는 항상 executor(이 화면이 유일한 수신자) — uiId 는 데몬이 'loc-' 접두사로 준다.
    handleUiCommand({ uiId: f.uiId, cmd: f.cmd, params: f.params, executor: true }, (frame) =>
      api.uiLocalSend({ t: "ui_result", uiId: frame.uiId, ok: !!frame.ok, result: frame.result, error: frame.error }).catch(() => {}),
    );
  }).catch(() => { /* 이벤트 API 미가용 — back 경로만으로 동작 */ });
  const attach = () =>
    api
      .uiLocalStart({
        clientKey: S.deviceKey(),
        deviceId: state.daemon?.deviceId ?? null,
        kind: "pc",
        foreground: isReallyFocused(),
      })
      .catch(() => {});
  attach();
  // deviceId 는 페어링/로그인 후에 채워진다 → daemon 상태가 바뀌면 attach 정보를 갱신(멱등).
  let lastKey = "";
  S.subscribe(() => {
    const k = `${state.daemon?.deviceId ?? ""}`;
    if (k === lastKey) return;
    lastKey = k;
    attach();
  });
}

// ── R4: 프리뷰 native webview 내부 사용자 클릭 → 그 pane/탭 포커스 ──
//  preview.rs 의 좌클릭 NSEvent 모니터가 "preview-focus"{pane:pvId} 를 emit(터미널 탭이 포커스여도
//  사용자가 프리뷰를 누르면 그 pane 이 활성이 되도록). AI 자동화 클릭은 페이지 안 JS dispatchEvent 라
//  NSEvent 를 만들지 않으므로 자연히 제외된다.
let _pvFocusBound = false;
function bindPreviewFocus() {
  if (_pvFocusBound) return;
  _pvFocusBound = true;
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) ev.listen("preview-focus", (e) => onPreviewFocus(e && e.payload));
  } catch (_) { /* 이벤트 API 미가용 — 무시 */ }
}
function onPreviewFocus(payload) {
  const pvId = payload && payload.pane;
  const hit = paneForPreviewId(pvId);
  if (!hit) return;
  // 혼합 프리뷰 탭이면 그 탭을 활성으로(이미 활성이면 스킵) — 독립 프리뷰 pane 은 탭 전환 없음.
  if (hit.tabIndex >= 0 && hit.pane.node.active !== hit.tabIndex) hit.pane.switchTab(hit.tabIndex);
  S.focusPane(hit.pane.id);
  hit.pane.focus?.();
}

// R1 — 프리뷰/IDE 를 "열기"(previewOpen/ideOpen) 시 폭 게이팅: 좁으면 탭 편입, 넓으면 기존처럼 분할.
//  대상 = 활성(포커스) 터미널 pane, 없으면 첫 터미널 pane. 터미널 pane 이 하나도 없으면 분할 폴백.
//  opts: preview={url}, ide={openPath,line}. 반환: 배치된 paneId.
function addSurfaceGated(rt, kind, opts) {
  opts = opts || {};
  const focusId = rt.focusId || T.firstLeafId(rt.layout);
  if (!focusId) throw new Error(i18n.t('분할할 pane 없음'));
  const focusLeaf = T.findLeaf(rt.layout, focusId);
  const rect = getPane(focusId)?.el?.getBoundingClientRect?.();
  const width = rect && rect.width > 1 ? rect.width : ((typeof window !== "undefined" && window.innerWidth) || 9999);
  if (width < NARROW_W) {
    let host = focusLeaf && focusLeaf.kind === "terminal" ? focusLeaf : null;
    if (!host) T.eachLeaf(rt.layout, (l) => { if (!host && l.kind === "terminal") host = l; });
    if (host) {
      const tab = kind === "ide"
        ? { kind: "ide", openPath: opts.openPath || null, tid: newTid() }
        : kind === "emulator"
          ? { kind: "emulator", deviceId: opts.deviceId || null, metaName: "", tid: newTid() }
          : { kind: "preview", url: opts.url || "", tid: newTid() };
      host.tabs.push(tab);
      host.active = host.tabs.length - 1;
      const pane = getPane(host.id);
      pane?.buildHead();
      pane?.showActiveTab?.(); // 혼합 탭 본문(IdeView/PreviewSurface) 생성 + 표시
      if (kind === "ide" && opts.line) pane?._mixed?.get(tab.tid)?.ide?.openFile(opts.openPath, opts.line);
      S.focusPane(host.id);
      S.emit();
      return host.id;
    }
  }
  const sopts = kind === "ide" ? { openPath: opts.openPath }
    : kind === "emulator" ? { deviceId: opts.deviceId || null }
      : { url: opts.url || "" };
  S.splitPane(focusId, "h", kind, sopts);
  return rt.focusId;
}

// 이 PC 앱의 버전(ui_hello 진단 필드). 1회만 조회해 캐시한다 — 실패는 빈 문자열(신고 생략).
let appVer = "";
async function ensureAppVer() {
  if (appVer) return appVer;
  try { appVer = String((await api.appVersion()) || ""); } catch (_) { appVer = ""; }
  return appVer;
}

async function connect() {
  clearTimeout(retryTimer);
  let url = null;
  try {
    url = await api.uiStreamUrl();
  } catch (_) {
    return scheduleRetry(); // 미페어링/서버 미가용 — 로컬 폴백으로 동작 유지
  }
  // hello 는 onopen 에서 동기로 나가므로 버전은 **소켓을 열기 전에** 확보해야 한다(첫 접속 누락 방지).
  await ensureAppVer();
  if (!url) return scheduleRetry();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (_) {
    return scheduleRetry();
  }
  sock = ws;
  ws.onopen = () => {
    retryMs = 3000;
    // ★ 에이전트 상태(기능3) push 는 재접속 시점에 **전량 폐기**한다(계약 §1.5). 끊긴 사이의 전이,
    //  특히 종료('gone')를 놓쳤을 수 있고 back 의 라스트-스테이트 리플레이는 '삭제'를 표현할 수 없다
    //  (gone 은 캐시에서 지워져 리플레이 대상이 아니다) → 안 지우면 끝난 에이전트가 유령으로 15분 남는다.
    //  폐기 후 ui_hello 를 보내면 리플레이가 살아 있는 것만 즉시 복원한다(앱 resetAgentStates 와 같은 순서).
    S.resetAgentStates();
    // ★ 호스트별 자물쇠(runner_status.e2eeEpoch)도 **같은 규율**로 폐기한다(계약 §2.7). 끊긴 사이 그 PC 가
    //  열쇠를 잃었거나(신뢰 해제) 세대를 회전했을 수 있고, 그러면 남아 있는 값은 근거가 사라진 사진이라
    //  '암호화됨' 을 유지하는 거짓 자물쇠가 된다. 폐기 후 ui_hello → back replayRunnerStatus 가 **붙어
    //  있는 러너 전부**를 (열쇠 없는 호스트도 e2eeEpoch:0 으로) 즉시 되보내므로 '확인 중' 고착이 없다.
    //  ⚠ 순서 불변식: 리플레이가 있는 back 에서만 안전하다 — 리셋만 있고 시드가 없으면 고착이 악화된다.
    if (resetHostLocks()) S.emit(); // 순수 모듈이라 emit 은 호출부 몫(applyRunnerStatus 와 같은 규약)
    // 이 클라이언트 식별(원격 조작 executor 선정 + 기기 타겟팅) — 기기 키 + 페어링된 기기 id/이름.
    //  caps = "이 화면이 실제로 그릴 수 있는 신규 기능"(capability 협상, config/caps.js). 서버는
    //  이 교집합으로 "승인 카드를 그릴 화면이 있는가"(countResponders)를 판단한다. 우리가 정말
    //  구현한 것만 신고한다 — 미구현을 선언하면 데몬이 기능을 켜고 응답할 화면이 없어 대기만 한다.
    send(ws, {
      type: "ui_hello", clientKey: S.deviceKey(), kind: "pc",
      deviceId: state.daemon?.deviceId ?? undefined,
      deviceName: state.daemon?.device_name || undefined, // daemon_status Status 는 device_name(snake) 로 노출
      //  e2ee.v1 은 이 PC 가 **실제로 봉인/복호할 수 있을 때만** 실린다(데몬 열쇠 승인 완료 상태).
      //  agentstate.v1 = 에이전트 상태 push(기능3) 수신기가 실제로 있다(아래 'agent_state' 케이스 →
      //   state.setAgentState). 팬아웃은 caps 로 게이팅하지 않으므로(모르는 type 은 무시) 이 신고는
      //   진단·통계용이지만, "구현한 것만 신고" 규약을 지켜 수신기와 같은 커밋에서만 실린다.
      caps: ["caps.v1", "approval.v1", "transcript.v1", "agentstate.v1", ...e2eeCaps()],
      // 진단 전용(분기 금지 — 분기는 항상 caps). 서버가 "누가 어떤 조합인지" 를 알 유일한 단서.
      appVersion: appVer || undefined,
      // 이 화면이 **실제로 실행할 수 있는** ui_command 이름. 서버는 이 목록으로 명령을 보낼 화면을
      //  고른다 — 예전엔 "방금 만진 기기" 만 보고 골라, 그 기기가 모르는 명령이면 조용히 실패했다
      //  (폰을 켜두면 PC 기능이 안 되는 비결정적 버그). 핸들러 테이블에서 직접 뽑으므로 어긋나지 않는다.
      uiCmds: [...Object.keys(handlers), "browser.*"],
    });
    sendPresence(); // 접속 시 현재 가시 상태를 present 신호로 보고
    S.loadNotifications(); // 끊긴 사이 놓친 알림 보충(재접속 시에도)
    S.loadApprovals();     // 승인은 push 가 힌트, pull 이 정본 — 재접속마다 재조회(유령/누락 방지)
    void refreshE2ee();    // 열쇠 상태/대기 목록도 같은 규율(재접속마다 pull)
  };
  ws.onmessage = (e) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "notif_event":
        if (msg.event) S.applyNotifEvent(msg.event);
        break;
      case "pc_update_request":
        // 폰에서 "지금 이 PC 업데이트" 를 눌렀다 — 준비된 바이트가 있으면 즉시 적용+재시작한다.
        //  요청자가 원격이므로 여기서 되묻지 않는다(물어볼 화면이 이 PC 앞에 없다).
        try { _onRemoteUpdate?.(); } catch (_) { /* noop */ }
        break;
      case "approval_event":
        // 원격 승인 인박스(기능1) — pending/resolved. 라이브 전용(버퍼 없음)이라 놓친 건 pull 이 메운다.
        if (msg.event) S.applyApprovalEvent(msg.event);
        break;
      case "device_approval_event":
        // 새 기기 열쇠 승인(기능2) — 요청 등장/해소. 구 클라이언트는 unknown type 이라 무시 = 안전.
        applyDeviceApprovalEvent(msg.event);
        break;
      case "device_updated":
        // 별칭 변경은 서버 목록이 정본 — 다른 기기에서 바뀐 이름도 즉시 다시 읽는다.
        S.loadDevices();
        break;
      case "chat_event":
        // 트랜스크립트(기능5) 라이브 델타 — 해당 chatId 를 구독 중인 Chat 뷰에만 배달.
        applyChatEvent(msg);
        break;
      case "agent_state":
        // 기능3(에이전트 상태머신) push — 토글 노출 판정의 **1순위**(폴백은 pane.js 의 tab.cmd).
        //  back 팬아웃 형태 = { type:'agent_state', event:{ cwd, win, state, agent, version, at,
        //  sessionId, source, since, hostDeviceId, kind } }(계약 §1.3-②). event 없이 평평하게 오는
        //  형태도 받아 준다(데몬 → back 원본 프레임과 같은 모양이라 중계 구현에 무관하게 동작).
        S.setAgentState(msg.event || msg);
        break;
      case "runner_status":
        // 호스트(내 PC)별 열쇠 세대 — 정직한 자물쇠 배지의 유일한 근거(계약 §2.7 "자물쇠 표시는 호스트별로").
        //  back 은 러너 접속/종료와 hello.e2eeEpoch 변화마다 이 프레임을 쏜다. **표시 전용**이다 —
        //  이 값으로 봉인 시도를 게이팅하면 구 back(필드 없음)에서 기능이 조용히 꺼진다.
        if (applyRunnerStatus(msg.event)) S.emit();
        break;
      case "ui_command":
        handleUiCommand(msg, (frame) => send(ws, { type: "ui_result", ...frame }));
        break;
      case "appearance_event":
        // 모양 설정(계정 동기화) — 다른 기기서 변경 → 즉시 반영(서버로 되밀지 않음)
        import("./theme.js").then((t) => t.applyRemoteAppearance(msg.event && msg.event.appearance)).catch(() => {});
        import("./shortcuts.js").then((s) => s.applyRemoteShortcuts(msg.event && msg.event.appearance && msg.event.appearance.shortcuts)).catch(() => {});
        break;
      case "account_deleted":
        // 다른 기기에서 회원 탈퇴 — 이 PC 도 즉시 페어링 해제(데몬 정지 포함) → 로그인 게이트.
        onAccountDeleted();
        break;
      default:
        break;
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  ws.onclose = () => {
    if (sock === ws) {
      sock = null;
      scheduleRetry();
    }
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = retryMs;
  retryMs = Math.min(10000, Math.round(retryMs * 1.6));
  retryTimer = setTimeout(connect, wait);
}

function send(ws, frame) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  } catch (_) {}
}

/**
 * 업데이트 적용으로 곧 재시작한다고 서버에 예고한다(재시작 직전 1회).
 *  이걸 보내 두면 이어지는 데몬 끊김이 원격 화면에 "업데이트 중 · 곧 다시 연결" 로 설명된다.
 *  같은 끊김이라도 이유를 알면 사람은 기다린다 — 모르면 고장으로 읽는다.
 *  전송 실패는 무시한다(일반 오프라인 문구로 안전 폴백 — 업데이트를 막을 이유가 못 된다).
 */
export function announceUpdating(version) {
  send(sock, { type: "host_updating", version: String(version || "") });
}

/**
 * 업데이트를 받아 두었음을 서버에 알린다(빈 값 = 이제 없음).
 *  이걸 알려야 **폰에서 원격으로** 적용을 걸 수 있다 — 사용자는 PC 앞에 없는 채로 일하는 일이 많고,
 *  그때 "PC 를 업데이트하세요" 안내만 주면 PC 앞에 갈 때까지 아무것도 못 한다.
 */
export function announceUpdateReady(version) {
  send(sock, { type: "host_update_ready", version: String(version || "") });
}

// 서버(폰의 원격 요청)가 "지금 적용" 을 지시했을 때 실행할 콜백. update-scheduler 가 등록한다.
let _onRemoteUpdate = null;
export function setRemoteUpdateHandler(fn) { _onRemoteUpdate = typeof fn === "function" ? fn : null; }

// 표면 닫힘 전파(surface_broadcast) 발신은 폐지됨 — 기기-타겟 라우팅에선 프리뷰가 기기마다 독립이라
//  한 기기에서 닫아도 다른 기기 것을 닫으면 안 된다(오동작). 수신측 previewClose 핸들러와
//  _applyingRemoteClose 가드는 구 클라 호환 + 핸드오프(P3) 복원 재사용 위해 유지한다.
let _applyingRemoteClose = false;

// ── 네이티브 창 포커스(Tauri) — present 판정의 진실源 ──
//  WKWebView 의 DOM window.blur / document.hasFocus() 는 "OS 앱 전환"(예: cmux 로 전환) 시 갱신되지
//  않는다(실측: 딴 앱에서 작업 중인데 CodingPT 가 present 로 잡혀 폰 푸시가 억제됨 → PC 로만 알림).
//  Tauri 의 onFocusChanged(= NSWindow key 상태)는 앱 전환에도 정확히 바뀌므로 이걸 진실源으로 쓴다.
let _nativeFocused = true;
let _nativeFocusWired = false;
function wireNativeFocus() {
  if (_nativeFocusWired) return;
  const setF = (v) => {
    const was = _nativeFocused;
    _nativeFocused = !!v;
    sendPresence();
    // 창을 다시 최전면으로 가져온 순간 = 사용자가 카드를 보러 온 순간. 대기 승인을 재조회한다
    //  (WS 가 끊겨 있던 사이 생긴 카드/이미 해소된 유령 카드를 pull 정본으로 바로잡는다).
    if (!was && _nativeFocused) S.loadApprovals();
  };
  let wired = false;
  // 0) Rust WindowEvent::Focused → "cpt-focus"(가장 신뢰: NSWindow key 상태, event API 는 앱에서 검증됨)
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) { ev.listen("cpt-focus", (e) => setF(e && e.payload)); wired = true; }
  } catch (_) { /* noop */ }
  // 1) 창 객체 onFocusChanged (권장 경로)
  try {
    const tw = window.__TAURI__ && window.__TAURI__.window;
    const w = tw && tw.getCurrentWindow && tw.getCurrentWindow();
    if (w && w.onFocusChanged) {
      w.onFocusChanged(({ payload }) => setF(payload));
      if (w.isFocused) w.isFocused().then(setF).catch(() => {});
      wired = true;
    }
  } catch (_) { /* noop */ }
  // 2) 폴백 — 전역 이벤트로 tauri://focus|blur 수신(event API 는 앱에서 이미 검증됨)
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) {
      ev.listen("tauri://focus", () => setF(true));
      ev.listen("tauri://blur", () => setF(false));
      wired = true;
    }
  } catch (_) { /* noop */ }
  if (wired) _nativeFocusWired = true; // 하나라도 배선되면 네이티브를 진실源으로
}
// "지금 실제로 최전면(key)인가" — 네이티브 우선, 미배선 시 DOM 폴백.
//  ⚠ export 되어 업데이트 스케줄러도 **같은 진실源**을 쓴다. WKWebView 의 document.hasFocus() 는
//   OS 앱 전환에 안 따라오므로(위 주석의 실측), 그걸 쓰면 "PC 앞에 있다" 를 오판해 조용한 순간을
//   영영 못 잡거나 반대로 보고 있는데 재시작하게 된다.
export function isReallyFocused() {
  if (_nativeFocusWired) return _nativeFocused;
  try { return typeof document.hasFocus === "function" ? document.hasFocus() : true; } catch (_) { return true; }
}

// ── 사용자 활동 보고(ui_activity) — 원격 조작 executor 선정에 쓰이는 "이 화면을 보는 중" 신호 ──
let _activityBound = false;
let _lastActivity = 0;
function bindActivityReport() {
  if (_activityBound) return;
  _activityBound = true;
  wireNativeFocus();
  //  strong = 의도적 상호작용(타이핑·클릭) → 짧은 스로틀로 executor 선정을 빠르게 갱신한다.
  //   두 기기 화면을 다 켜둔 환경에서 "지금 터미널에 입력하는 기기"가 곧바로 executor 가 되어야
  //   그 기기에서만 프리뷰가 분할로 뜨고 나머지는 조용한 탭이 된다(안 그러면 옆 기기가 executor 로
  //   뽑혀 엉뚱하게 분할됨). weak = 마우스 이동/휠 같은 연속 신호 → 30s(메시지 폭주·present 잔떨림 방지).
  const report = (strong) => {
    // 포커스 가드 — ui_activity 는 서버에서 foreground=true 로 취급된다. 창이 최전면이 아닐 때(딴 앱
    //  사용, 옆에 떠 있어 마우스만 지나가는 경우 등) 보내면 present 판정이 다시 켜져 폰 알림을 가로챈다.
    //  네이티브 포커스로 판정(DOM hasFocus 는 앱 전환 시 못 믿음).
    if (!isReallyFocused()) return;
    const now = Date.now();
    if (now - _lastActivity < (strong ? 1000 : 30000)) return;
    if (!sock || sock.readyState !== 1) return;
    _lastActivity = now;
    send(sock, { type: "ui_activity" });
  };
  window.addEventListener("keydown", () => report(true), true);
  window.addEventListener("pointerdown", () => report(true), true);
  window.addEventListener("pointermove", () => report(false), true); // 보는 중(마우스 이동)도 활성 유지 → foregroundAt 갱신
  window.addEventListener("wheel", () => report(false), true);
  // present 신호(알림 라우팅) — 네이티브 포커스 변화가 주 트리거. DOM 이벤트는 폴백(웹/미배선 대비).
  window.addEventListener("focus", sendPresence);
  window.addEventListener("blur", sendPresence);
  document.addEventListener("visibilitychange", sendPresence);
}

// 현재 "실제로 보고 있음" 여부를 present 신호로 전송. visible AND 네이티브 포커스 = present.
function sendPresence() {
  let active = true;
  try {
    const visible = document.visibilityState === "visible";
    active = visible && isReallyFocused();
  } catch (_) { active = true; }
  // 로컬 채널에도 같은 신호 — 데몬이 back 오프라인 폴백 시 "지금 보고 있는 화면"을 고른다.
  //  (알림 present 판정은 서버가 정본이고 여기서 바뀌지 않는다 — 로컬은 라우팅 힌트일 뿐)
  if (_localUiBound) api.uiLocalSend({ t: "presence", active }).catch(() => {});
  if (!sock || sock.readyState !== 1) return;
  send(sock, { type: "presence", active });
}

// ── ui_command 디스패처 ──
//  공통 규칙: params.ws(홈-상대 localPath)로 로컬 워크스페이스를 찾고, 활성이 아니면 setActive 먼저
//  (AI 조작을 화면에 보여주는 UX). 워크스페이스 없음/실행 실패는 executor 일 때 에러로 회신.
//  reply = 회신 전송 함수(전송 계층 주입). back WSS 경로와 로컬 cpt.sock 경로가 **같은 핸들러 한 벌**을
//  쓰도록 전송만 갈아끼운다. handlers[cmd] 의 반환 규약({ok,result})은 절대 변경 금지(과거 함정).
async function handleUiCommand(msg, reply) {
  const { uiId, cmd, params, executor } = msg;
  let res;
  try {
    if (typeof cmd === "string" && cmd.startsWith("browser.")) {
      // 프리뷰 브라우저 자동화 — 페이지 에이전트 주입 + preview_eval 결과 회수.
      res = await handleBrowserCommand(cmd.slice("browser.".length), params || {});
    } else {
      const handler = handlers[cmd];
      if (!handler) res = { ok: false, error: i18n.t('알 수 없는 명령: ') + cmd };
      else res = (await handler(params || {}, executor)) || { ok: true };
    }
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  // broadcast 명령도 executor 1곳만 회신 — executor=false 는 적용만.
  if (executor) reply({ uiId, ...res });
}

// cwd(홈-상대 localPath)로 로컬 워크스페이스 메타 찾기.
function wsByCwd(cwd) {
  return state.workspaces.find((w) => w.localPath === cwd) || null;
}

// 대상 워크스페이스 확보 + 활성화(setActive 는 동기 render 까지 수행 → pane DOM 접근 가능).
function requireWs(params) {
  const meta = wsByCwd(params.ws);
  if (!meta) throw new Error(i18n.t('워크스페이스 없음'));
  if (state.activeWsId !== meta.id || state.view !== "workspace") S.setActive(meta.id);
  return { meta, rt: S.ensureRuntime(meta.id) };
}

// 워크스페이스 상대 경로 정규화 — back 이 ws 상대 경로를 줘도 홈-상대(IDE jail 기준)로 맞춘다.
//  win32: 호스트발 경로에 `\` 가 섞여 올 수 있어 내부 표기(`/`)로 먼저 접는다(mac 은 무변환 —
//  macOS 파일명의 합법적 `\` 를 건드리지 않기 위한 플랫폼 가드).
function normPath(meta, path) {
  const raw = IS_WINDOWS ? String(path || "").replace(/\\/g, "/") : String(path || "");
  const p = raw.replace(/^\/+/, "");
  if (!p) return null;
  const root = (meta.localPath || "").replace(/\/+$/, "");
  if (!root || p === root || p.startsWith(root + "/")) return p;
  return root + "/" + p;
}

// 원격 URL 해석 — ':5173'/'5173' 같은 포트 지정은 로컬 데브서버, 그 외는 스마트 주소 규칙 재사용.
function resolveUrl(raw) {
  const v = String(raw || "").trim();
  const m = /^:?(\d{2,5})$/.exec(v);
  if (m) return "http://localhost:" + m[1];
  return smartUrl(v);
}

// 레이아웃 트리 직렬화 — leaf 는 {id,kind,tabs?,active?,url?,openPath?}만(함수/DOM 없는 순수 JSON).
function serializeNode(node) {
  if (!node) return null;
  if (T.isLeaf(node)) {
    const out = { id: node.id, kind: node.kind };
    if (node.kind === "terminal") {
      out.tabs = (node.tabs || []).map((t) => {
        const tab = { kind: t.kind || "term" };
        if (typeof t.win === "number") tab.win = t.win;
        if (t.title) tab.title = t.title;
        if (t.url) tab.url = t.url;
        if (t.openPath) tab.openPath = t.openPath;
        if (t.deviceId) tab.deviceId = t.deviceId;   // 모바일 화면 탭이 보고 있는 기기
        return tab;
      });
      out.active = node.active || 0;
    }
    if (node.url) out.url = node.url;
    if (node.openPath) out.openPath = node.openPath;
    //  ★ 모바일 화면은 **어느 기기를 보고 있는지**가 그 pane 의 내용이다 — url/openPath 와 같은 자리.
    //   빠뜨리면 `cpt layout tree` 로는 "emulator" 라는 것만 알고 무엇이 떠 있는지 알 수 없다.
    if (node.deviceId) out.deviceId = node.deviceId;
    return out;
  }
  return { dir: node.dir, ratio: node.ratio, first: serializeNode(node.first), second: serializeNode(node.second) };
}

// 프리뷰 대상 탐색 — 포커스 pane 우선, 독립 프리뷰 pane 또는 혼합 프리뷰 탭.
//  반환: { leaf, tab:null } | { leaf, tab, index } | null.
function findPreviewTarget(rt) {
  const check = (l) => {
    if (l.kind === "preview") return { leaf: l, tab: null };
    if (l.kind === "terminal") {
      const i = (l.tabs || []).findIndex((t) => t.kind === "preview");
      if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
    }
    return null;
  };
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (focusLeaf) hit = check(focusLeaf);
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit) hit = check(l); });
  return hit;
}

// 프리뷰 대상에 URL 이동 — pane/PreviewSurface 의 onNavigate 경로와 동일하게 상태·키를 갱신.
//  ⚠️ 표면 승계 버그 근본수정: 예전엔 effUrl(_pvEffUrl) 갱신 없이 previewNavigate 만 직접 쐈다 →
//  직후 rAF previewSync 가 "옛 effUrl" 로 재내비게이트해 새 URL 이 즉시 되돌려졌다(no-op 처럼 보임).
//  표면 자체의 _applyEff/_applyPvEff(원격 프록시 치환 포함)를 태워 effUrl→키 리셋→navigate 순서를 보장한다.
// foreground=true(기본): 프리뷰 탭을 앞으로 끌어온다(사용자가 "처음 여는" previewOpen 신호).
// foreground=false: 활성 탭/포커스를 바꾸지 않고 url 로드/제어만 한다(previewNavigate·browser 계열).
//  프리뷰 native webview 는 숨겨져 있어도 살아 있어 pvId 로 계속 제어되므로 백그라운드로 이동 가능.
function navigatePreview(target, url, foreground = true) {
  if (isPicking()) cancelDesignPick(); // Design Mode 중 다른 명령(navigate 등) = 선택 모드 중단(계약)
  const pane = getPane(target.leaf.id);
  if (target.tab) {
    // 혼합 프리뷰 탭 — url 먼저 반영. foreground 일 때만 탭 활성화(표면 미생성이면 showActiveTab 이 생성).
    target.tab.url = url;
    if (foreground) {
      target.leaf.active = target.index;
      pane?.buildHead();
      pane?.showActiveTab?.();
    }
    const sf = target.tab.tid ? pane?._mixed?.get(target.tab.tid)?.preview : null;
    if (sf) {
      sf.url = url;
      sf._applyEff(url, true); // effUrl 갱신 + 키 리셋 + 즉시 이동(웹뷰 없으면 previewSync 가 생성)
    }
  } else if (pane) {
    // 독립 프리뷰 pane — _buildFrame onNavigate 와 동일 절차(자체 pane 이라 탭 포그라운드 개념 없음).
    pane.node.url = url;
    pane.previewUrl = url;
    pane._applyPvEff(url, true);
  }
  if (foreground) S.focusPane(target.leaf.id); // 백그라운드 명령은 사용자 화면(포커스)을 강제로 옮기지 않는다
  S.emit();
}

// IDE 대상 탐색(findPreviewTarget 미러) — 포커스 pane 우선, 독립 IDE pane 또는 혼합 IDE 탭.
//  반환: { leaf, tab:null } | { leaf, tab, index } | null.
function findIdeTarget(rt) {
  const check = (l) => {
    if (l.kind === "ide") return { leaf: l, tab: null };
    if (l.kind === "terminal") {
      const i = (l.tabs || []).findIndex((t) => t.kind === "ide");
      if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
    }
    return null;
  };
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (focusLeaf) hit = check(focusLeaf);
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit) hit = check(l); });
  return hit;
}

// 표면 대상(findPreview/IdeTarget 결과) 닫기 — 독립 pane 은 통째 close, 혼합 탭은 그 탭만 제거.
//  (모바일 closeSurfaceHit 미러. Phase 1: 각 기기 로컬.)
function closeSurfaceTarget(meta, target) {
  if (!target.tab) { S.closePane(meta.id, target.leaf.id); return; }
  const pane = getPane(target.leaf.id);
  if (pane) pane.closeTab(target.index); // 마지막 탭이면 closeTab 내부에서 pane 통째 닫음
  else S.closePane(meta.id, target.leaf.id);
}

// IDE 대상의 살아있는 IdeView 인스턴스(없으면 null — 혼합 탭이 아직 한 번도 표시 안 됨 등).
function ideInstanceOf(target) {
  const pane = getPane(target.leaf.id);
  if (!pane) return null;
  if (target.tab) return target.tab.tid ? (pane._mixed?.get(target.tab.tid)?.ide || null) : null;
  return pane.ide || null;
}

// 홈-상대(IDE 내부) 경로 → ws 상대 경로(normPath 역변환) — ideList 출력용(모바일 rel 규칙과 정합).
function relPath(meta, full) {
  const root = (meta.localPath || "").replace(/\/+$/, "");
  // win32 가드 — normPath 와 같은 이유(내부 표기 `/` 통일, mac 은 무변환).
  const p = IS_WINDOWS ? String(full || "").replace(/\\/g, "/") : String(full || "");
  if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p.replace(/^\/+/, "");
}

// 프리뷰 대상의 표면 핸들(pvId/host/bar/title) — 없으면 surface:null(표면 미생성). target:null=프리뷰 자체 없음.
function findPreviewSurface(rt) {
  const target = findPreviewTarget(rt);
  if (!target) return { target: null, surface: null };
  const pane = getPane(target.leaf.id);
  if (!pane) return { target, surface: null };
  if (target.tab) {
    const sf = target.tab.tid ? pane._mixed?.get(target.tab.tid)?.preview : null;
    return { target, surface: sf ? { pvId: sf.id, host: sf.host, bar: sf.bar, title: target.tab.metaTitle || "" } : null };
  }
  return { target, surface: { pvId: pane._pvId, host: pane.previewHost, bar: pane.previewBar, title: pane.node.metaTitle || "" } };
}

// ── browser.* — 프리뷰 네이티브 WKWebView 자동화 ──
//  흐름: 대상 프리뷰 표면 찾기 → (조작이면) 오리진 가드 → 에이전트 주입(멱등) → 호출 → JSON 회수.
//  에이전트 메서드는 동기 반환(preview_eval 이 결과를 회수) — wait 만 여기서 500ms 폴링.

// 대상 프리뷰 표면 id — previewReload 와 동일 규칙("pv-"+tid). 혼합 탭이 아직 표시된 적 없으면
//  네이티브 webview 자체가 없으므로 에러.
function requirePreviewId(rt) {
  const target = findPreviewTarget(rt);
  if (!target) throw new Error(i18n.t('프리뷰 없음'));
  if (target.tab && !target.tab.tid) throw new Error(i18n.t('프리뷰 표면 미생성(탭을 한 번 표시해야 함)'));
  return target.tab ? "pv-" + target.tab.tid : "pv-" + (target.leaf.tid || target.leaf.id);
}

// 오리진 가드 — 조작(click/type/fill/eval)은 로컬 데브서버에서만 허용(외부 사이트 원격 조작 차단).
//  snapshot/get/screenshot 은 읽기 전용이라 허용.
async function assertLocalOrigin(pvId) {
  const info = await api.previewInfo(pvId);
  let host = "";
  try { host = new URL(info.url || "").hostname; } catch (_) {}
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new Error(i18n.t('로컬(localhost) 페이지가 아니어서 조작 거부: ') + (info.url || i18n.t('(URL 없음)')));
  }
}

// 에이전트 함수 1회 호출 — 주입(멱등) 후 JSON.stringify 로 감싼 결과를 회수해 파싱.
//  페이지 이동으로 에이전트가 사라져도 매 호출 재주입되므로 안전.
async function agentCall(pvId, expr) {
  await api.previewEval(pvId, PAGE_AGENT_JS);
  const js =
    "JSON.stringify((function(){try{return {ok:true,result:(" + expr + ")};}" +
    "catch(e){return {ok:false,error:String((e&&e.message)||e)};}})())";
  const raw = await api.previewEval(pvId, js);
  let out = null;
  try { out = JSON.parse(raw); } catch (_) {
    throw new Error(i18n.t('에이전트 응답 파싱 실패: ') + String(raw).slice(0, 200));
  }
  if (!out || out.ok !== true) throw new Error((out && out.error) || i18n.t('에이전트 실행 실패'));
  return out.result;
}

const BROWSER_MUTATING = new Set(["click", "type", "fill", "eval", "press"]);

async function handleBrowserCommand(op, p) {
  const { rt } = requireWs(p);
  const pvId = requirePreviewId(rt);
  // wait 도 {js} 조건은 페이지에서 임의 JS 를 돌리므로 조작과 동일하게 가드.
  if (BROWSER_MUTATING.has(op) || (op === "wait" && p.js)) await assertLocalOrigin(pvId);
  const q = (v) => JSON.stringify(v == null ? "" : String(v));
  const target = () => q(p.target || p.ref || p.selector);
  switch (op) {
    case "snapshot":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.snapshot()") };
    case "click": {
      const hasXY = typeof p.x === "number" && typeof p.y === "number";
      const args = hasXY ? (target() + "," + Number(p.x) + "," + Number(p.y)) : target();
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.click(" + args + ")") };
    }
    case "scroll": {
      const spec = JSON.stringify({
        target: p.target || p.ref || p.selector || "",
        x: typeof p.x === "number" ? p.x : undefined, y: typeof p.y === "number" ? p.y : undefined,
        dx: typeof p.dx === "number" ? p.dx : undefined, dy: typeof p.dy === "number" ? p.dy : undefined,
      });
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.scroll(" + spec + ")") };
    }
    case "press": {
      const spec = JSON.stringify({
        key: String(p.key || ""), target: p.target || p.selector || "",
        modifiers: Array.isArray(p.modifiers) ? p.modifiers : (p.mod ? String(p.mod).split(",") : []),
        text: p.text != null ? String(p.text) : undefined,
      });
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.press(" + spec + ")") };
    }
    case "type":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.type(" + target() + "," + q(p.text) + ")") };
    case "fill":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.fill(" + target() + "," + q(p.value ?? p.text) + ")") };
    case "eval":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.eval(" + q(p.js || p.code) + ")") };
    case "get":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.get(" + q(p.what || "text") + "," + q(p.selector || "") + ")") };
    case "wait": {
      // 500ms 폴링(상한 25s) — 에이전트 wait 는 단발 검사만, 재-eval 은 여기서.
      const deadline = Date.now() + Math.min(Number(p.timeoutMs) || 25000, 25000);
      const spec = JSON.stringify({ selector: p.selector || "", text: p.text || "", js: p.js || "" });
      for (;;) {
        const r = await agentCall(pvId, "window.__cptAgent.wait(" + spec + ")").catch(() => null);
        if (r && r.ready) return { ok: true, result: { ready: true } };
        if (Date.now() >= deadline) return { ok: true, result: { ready: false, timeout: true } };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    case "screenshot": {
      const base64 = await api.previewScreenshot(pvId);
      return { ok: true, result: { format: "jpeg", base64 } };
    }
    case "console": {
      // 상시 주입 콘솔 후크(window.__cptConsole — preview.rs initialization_script) 링버퍼 조회/비움.
      //  읽기 전용이라 오리진 가드 불필요(BROWSER_MUTATING 아님). 후크 미존재(구 웹뷰)면 빈 목록.
      if (p.clear) {
        await api.previewEval(pvId, "JSON.stringify((function(){try{window.__cptConsole&&window.__cptConsole.clear();}catch(e){}return true;})())");
        return { ok: true, result: { cleared: true } };
      }
      const raw = await api.previewEval(pvId, "JSON.stringify(window.__cptConsole?window.__cptConsole.dump():[])");
      let entries = [];
      try { entries = JSON.parse(raw) || []; } catch (_) { entries = []; }
      if (p.level) entries = entries.filter((en) => en && en.lv === String(p.level));
      if (p.pattern) {
        let re;
        try { re = new RegExp(String(p.pattern)); } catch (_) { throw new Error(i18n.t('pattern 정규식 오류: ') + p.pattern); }
        entries = entries.filter((en) => en && re.test(String(en.msg || "")));
      }
      const limit = Math.max(1, Math.min(Number(p.limit) || 100, 500));
      return { ok: true, result: { entries: entries.slice(-limit), device: "pc" } };
    }
    case "network": {
      // 상시 주입 네트워크 후크(window.__cptNet — 콘솔 후크와 같은 initialization_script) 링버퍼 조회/비움.
      //  console 미러 — 읽기 전용이라 오리진 가드 불필요. 후크 미존재(구 웹뷰)면 빈 목록.
      if (p.clear) {
        await api.previewEval(pvId, "JSON.stringify((function(){try{window.__cptNet&&window.__cptNet.clear();}catch(e){}return true;})())");
        return { ok: true, result: { cleared: true } };
      }
      const raw = await api.previewEval(pvId, "JSON.stringify(window.__cptNet?window.__cptNet.dump():[])");
      let entries = [];
      try { entries = JSON.parse(raw) || []; } catch (_) { entries = []; }
      if (p.pattern) {
        let re;
        try { re = new RegExp(String(p.pattern)); } catch (_) { throw new Error(i18n.t('pattern 정규식 오류: ') + p.pattern); }
        entries = entries.filter((en) => en && re.test(String(en.u || "")));
      }
      if (p.status != null && p.status !== "") {
        // status 필터: '4xx'=400~499, '5xx'=500~599, 'err'=(s===0||err), 숫자=정확 일치.
        const sv = String(p.status);
        const test =
          sv === "4xx" ? (en) => en.s >= 400 && en.s <= 499
          : sv === "5xx" ? (en) => en.s >= 500 && en.s <= 599
          : sv === "err" ? (en) => en.s === 0 || !!en.err
          : (en) => en.s === Number(sv);
        entries = entries.filter((en) => en && test(en));
      }
      const limit = Math.max(1, Math.min(Number(p.limit) || 50, 300));
      return { ok: true, result: { entries: entries.slice(-limit), device: "pc" } };
    }
    default:
      return { ok: false, error: i18n.t('알 수 없는 browser 명령: ') + op };
  }
}

// ── 프리뷰 세션 핸드오프(P3) — 캡처/오리진재작성/복원 ──────────────────────
//  프리뷰 오리진은 기기마다 다르다(PC=localhost 직결, 모바일=back 프록시) → "논리 오리진(localhost:port)"
//  으로 캡처한 뒤 타겟 기기의 실제 오리진으로 쿠키를 재작성해 심는다. httpOnly 는 네이티브 쿠키 브리지로.

// p.ws 있으면 그 워크스페이스, 없으면 활성 워크스페이스(핸드오프는 활성 프리뷰 대상).
function requireWsOrActive(p) {
  if (p && p.ws) {
    const m = wsByCwd(p.ws);
    if (m) { if (state.activeWsId !== m.id || state.view !== "workspace") S.setActive(m.id); return { meta: m, rt: S.ensureRuntime(m.id) }; }
  }
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) throw new Error(i18n.t('활성 워크스페이스 없음'));
  if (state.view !== "workspace") S.setActive(meta.id);
  return { meta, rt: S.ensureRuntime(meta.id) };
}

// 현재 프리뷰 표면 → 매니페스트(URL 논리화 + storage + 쿠키[httpOnly 포함]).
async function captureManifestPC(pvId) {
  const info = await api.previewInfo(pvId).catch(() => ({ url: "" }));
  const rawUrl = info && info.url ? info.url : "";
  let logical = null, externalUrl = null;
  try {
    const u = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
    if (local) logical = { port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search + u.hash, scheme: u.protocol.replace(":", "") };
    else externalUrl = rawUrl;
  } catch (_) { if (rawUrl) externalUrl = rawUrl; }
  // localStorage/sessionStorage
  const storeJs =
    "JSON.stringify((function(){var l={},s={};" +
    "try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);l[k]=localStorage.getItem(k);}}catch(e){}" +
    "try{for(var j=0;j<sessionStorage.length;j++){var m=sessionStorage.key(j);s[m]=sessionStorage.getItem(m);}}catch(e){}" +
    "return {local:l,session:s};})())";
  let storage = { local: {}, session: {} };
  try { storage = JSON.parse(await api.previewEval(pvId, storeJs)); } catch (_) { /* 빈 storage */ }
  // 캡처 대상 호스트 — WKHTTPCookieStore 는 전역(모든 사이트) 쿠키를 주므로 이 프리뷰 오리진 것만 남긴다.
  let pageHost = "";
  try { pageHost = new URL(rawUrl).hostname.toLowerCase(); } catch (_) {}
  const cookieMatchesHost = (c) => {
    if (!pageHost) return true;
    const d = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (!d) return true;
    return pageHost === d || pageHost.endsWith("." + d);
  };
  // 쿠키 — 네이티브(httpOnly 포함). 실패 시 document.cookie 폴백(비-httpOnly 만, partial).
  let cookies = [], partial = false;
  try {
    cookies = JSON.parse(await api.previewCookies(pvId)).filter(cookieMatchesHost);
  } catch (_) {
    partial = true;
    try {
      const raw = JSON.parse(await api.previewEval(pvId, "JSON.stringify(document.cookie||'')"));
      cookies = String(raw).split(";").map((c) => c.trim()).filter(Boolean).map((c) => {
        const eq = c.indexOf("=");
        return { name: eq >= 0 ? c.slice(0, eq) : c, value: eq >= 0 ? c.slice(eq + 1) : "", path: "/", session: true };
      });
    } catch (_) { /* 쿠키 없음 */ }
  }
  return { v: 1, kind: "preview", logical, externalUrl, host: null, storage, cookies, partial, attrsLossy: false };
}

// 캡처 쿠키를 타겟 오리진으로 재작성(domain/secure/path/__Host- 접두).
function rewriteCookiesForTarget(cookies, target) {
  const host = target.hostname;
  const isHttps = target.protocol === "https:";
  const out = [];
  for (const c of cookies || []) {
    let name = c.name || "";
    if (!name) continue;
    // __Host-/__Secure- 는 https 필수 → http(localhost) 이식 시 접두 제거(서버가 이름을 보므로 로그인 실패 가능=partial)
    if (!isHttps && (name.startsWith("__Host-") || name.startsWith("__Secure-"))) name = name.replace(/^__(Host|Secure)-/, "");
    out.push({
      name, value: c.value || "", domain: host, path: "/",
      expiresAt: c.expiresAt != null ? c.expiresAt : null,
      secure: isHttps ? !!c.secure : false, // http 이식 시 secure 드롭(안 그러면 미전송)
    });
  }
  return out;
}

// storage 주입 JS(eval) — 로드 후 setItem 일괄.
function storageInjectJs(storage) {
  const l = JSON.stringify((storage && storage.local) || {});
  const s = JSON.stringify((storage && storage.session) || {});
  return "(function(){try{var l=" + l + ";for(var k in l)localStorage.setItem(k,l[k]);}catch(e){}" +
    "try{var s=" + s + ";for(var m in s)sessionStorage.setItem(m,s[m]);}catch(e){}return 'ok';})()";
}

// 프리뷰 첫 로드(=webview 생성 완료) 대기 — pvId 매칭, 타임아웃이면 false.
function waitPreviewLoaded(pvId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false, un = null;
    const finish = (ok) => { if (done) return; done = true; try { un && un(); } catch (_) {} resolve(ok); };
    api.onPreviewLoaded((pl) => { if (pl && pl.pane === pvId) finish(true); }).then((u) => { un = u; if (done) { try { u(); } catch (_) {} } });
    setTimeout(() => finish(false), timeoutMs);
  });
}

// 매니페스트 복원 — 프리뷰 표면 확보 → 로드 대기 → 쿠키+storage 심기 → 최종 URL 이동.
async function restoreManifestPC(rt, manifest) {
  const url = manifest.externalUrl ||
    (manifest.logical ? "http://localhost:" + (manifest.logical.port || 80) + (manifest.logical.path || "/") : "");
  if (!url) throw new Error(i18n.t('복원할 URL 없음'));
  let target; try { target = new URL(url); } catch (_) { throw new Error(i18n.t('URL 파싱 실패')); }
  // 표면 확보 — 기존 프리뷰 재사용 or 우측 분할.
  let pvId;
  const existing = findPreviewTarget(rt);
  if (existing) {
    navigatePreview(existing, url);
    pvId = existing.tab ? "pv-" + existing.tab.tid : "pv-" + (existing.leaf.tid || existing.leaf.id);
  } else {
    const focusId = rt.focusId || T.firstLeafId(rt.layout);
    if (!focusId) throw new Error(i18n.t('분할할 pane 없음'));
    S.splitPane(focusId, "h", "preview", { url });
    const sf = findPreviewSurface(rt);
    pvId = sf.surface ? sf.surface.pvId : (sf.target ? ("pv-" + (sf.target.leaf.tid || sf.target.leaf.id)) : null);
  }
  if (!pvId) throw new Error(i18n.t('프리뷰 표면 생성 실패'));
  await waitPreviewLoaded(pvId, 6000); // webview 존재 보장
  const cookies = rewriteCookiesForTarget(manifest.cookies, target);
  if (cookies.length) { try { await api.previewSetCookies(pvId, JSON.stringify(cookies)); } catch (_) { /* 쿠키 실패 무시 */ } }
  try { await api.previewEval(pvId, storageInjectJs(manifest.storage)); } catch (_) { /* storage 실패 무시 */ }
  api.previewNavigate(pvId, url).catch(() => {}); // 쿠키·storage 반영된 상태로 최종 로드
  return { ok: true, result: { url, cookies: cookies.length, partial: !!manifest.partial } };
}

// ── PC 저장 스냅샷 모델 ──────────────────────────────────────────────
//  올리기 = 현재 프리뷰 캡처 → 이 PC(워크스페이스)에 파일 저장. 홈서버 미사용(쿠키=자격증명 PC 한정).
//   <ws>/.codingpt/snapshots/index.json + <id>.json,  <ws>/.codingpt/.gitignore="*"(커밋 방지)
const SNAP_MAX = 20;
const snapDir = (wsLocal) => String(wsLocal).replace(/\/+$/, "") + "/.codingpt/snapshots";
function snapLabel(url) {
  if (!url) return i18n.t('프리뷰');
  const m = /^:(\d+)(.*)$/.exec(url);
  if (m) return ":" + m[1] + (m[2] ? m[2].split(/[?#]/)[0] : "");
  return String(url).replace(/^https?:\/\//, "").slice(0, 40);
}
async function snapReadIndex(wsLocal) {
  try { const s = await api.fsRead(snapDir(wsLocal) + "/index.json"); const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

// 현재 활성 IDE 상태(열린 파일·커서 줄) 캡처 — ws 상대 경로로. 없으면 null.
function captureIdePC(meta, rt) {
  const target = findIdeTarget(rt);
  if (!target) return null;
  const ide = ideInstanceOf(target);
  const st = ide && ide.getActiveState ? ide.getActiveState() : null;
  if (!st || !st.path) return null;
  return { path: relPath(meta, st.path), line: st.line || 0 };
}

// 올리기 — 활성 프리뷰 + IDE 상태 캡처 → PC 워크스페이스에 스냅샷 저장(작업 전체 이어하기).
export async function saveSnapshotPC() {
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) return { ok: false, error: i18n.t('활성 워크스페이스 없음') };
  const rt = S.ensureRuntime(meta.id);
  // 프리뷰(있으면)
  let manifest = null;
  const tgt = findPreviewTarget(rt);
  if (tgt && !(tgt.tab && !tgt.tab.tid)) {
    const pvId = tgt.tab ? "pv-" + tgt.tab.tid : "pv-" + (tgt.leaf.tid || tgt.leaf.id);
    try { manifest = await captureManifestPC(pvId); } catch (_) { manifest = null; }
  }
  // IDE(있으면)
  const ide = captureIdePC(meta, rt);
  if (!manifest && !ide) return { ok: false, error: i18n.t('저장할 프리뷰나 IDE가 없어요') };
  try {
    const root = String(meta.localPath).replace(/\/+$/, "");
    // fs_mkdir 는 부모가 없으면 실패하고, 이미 있으면 "이미 존재해요"로 throw → 단계별 생성 + 존재 에러 무시.
    const okMkdir = async (p) => { try { await api.fsMkdir(p); } catch (e) { if (!/이미 존재/.test(String((e && e.message) || e || ""))) throw e; } };
    await okMkdir(root + "/.codingpt");
    await okMkdir(root + "/.codingpt/snapshots");
    try { await api.fsWrite(root + "/.codingpt/.gitignore", "*\n"); } catch (_) { /* gitignore 실패 무시 */ }
    const id = String(Date.now()) + "-" + Math.floor(Math.random() * 1e6).toString(36);
    const url = manifest ? (manifest.externalUrl || (manifest.logical ? ":" + manifest.logical.port + (manifest.logical.path || "") : "")) : "";
    const label = manifest ? snapLabel(url) : ("IDE · " + (basename(ide.path) || String(ide.path)));
    const m = { id, label, createdAt: Date.now(), device: state.daemon?.device_name || "PC", url, has: { preview: !!manifest, ide: !!ide } };
    await api.fsWrite(snapDir(meta.localPath) + "/" + id + ".json", JSON.stringify({ ...m, manifest, ide }));
    let list = [m, ...(await snapReadIndex(meta.localPath)).filter((s) => s.id !== id)];
    const pruned = list.slice(SNAP_MAX); list = list.slice(0, SNAP_MAX);
    for (const p of pruned) { try { await api.fsDelete(snapDir(meta.localPath) + "/" + p.id + ".json"); } catch (_) { /* noop */ } }
    await api.fsWrite(snapDir(meta.localPath) + "/index.json", JSON.stringify(list));
    return { ok: true, label: m.label };
  } catch (e) { return { ok: false, error: (e && e.message) || (typeof e === "string" ? e : "") || i18n.t('저장 실패') }; }
}

// dev 열기 — 활성 워크스페이스의 리스닝 포트를 감지해 활성 프리뷰를 그 포트로 이동.
/** 고른 포트를 활성 프리뷰로 연다 — 포트 목록 UI(빈 프리뷰의 "dev 열기")가 쓰는 길. */
export function openPortPC(port) {
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) return { ok: false, error: i18n.t('활성 워크스페이스 없음') };
  const rt = S.ensureRuntime(meta.id);
  const target = findPreviewTarget(rt);
  if (!target) return { ok: false, error: i18n.t('프리뷰 없음') };
  navigatePreview(target, "http://localhost:" + port);
  return { ok: true, port };
}

export async function openDevPortPC() {
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) return { ok: false, error: i18n.t('활성 워크스페이스 없음') };
  let ports = [];
  try { ports = (await api.listenPorts(meta.localPath)) || []; } catch (_) { ports = []; }
  if (!ports.length) return { ok: false, error: i18n.t('감지된 dev 포트가 없어요') };
  const rt = S.ensureRuntime(meta.id);
  const target = findPreviewTarget(rt);
  if (!target) return { ok: false, error: i18n.t('프리뷰 없음') };
  navigatePreview(target, "http://localhost:" + ports[0]);
  return { ok: true, port: ports[0] };
}

// 스냅샷 목록(내려받기 시트용).
export async function listSnapshotsPC() {
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) return [];
  return snapReadIndex(meta.localPath);
}

// 내려받기 — 선택한 스냅샷을 활성 워크스페이스로 복원(프리뷰 + IDE).
export async function applySnapshotPC(id) {
  const meta = state.workspaces.find((w) => w.id === state.activeWsId);
  if (!meta) return { ok: false, error: i18n.t('활성 워크스페이스 없음') };
  const rt = S.ensureRuntime(meta.id);
  let obj;
  try { const s = await api.fsRead(snapDir(meta.localPath) + "/" + id + ".json"); obj = JSON.parse(s || "{}"); }
  catch (_) { return { ok: false, error: i18n.t('스냅샷 로드 실패') }; }
  if (!obj || (!obj.manifest && !obj.ide)) return { ok: false, error: i18n.t('스냅샷 없음') };
  let err = null;
  if (obj.manifest) { try { await restoreManifestPC(rt, obj.manifest); } catch (e) { err = (e && e.message) || i18n.t('프리뷰 복원 실패'); } }
  if (obj.ide && obj.ide.path) {
    try { await handlers.ideOpen({ ws: meta.localPath, path: obj.ide.path, line: obj.ide.line }); } catch (_) { /* IDE 복원 실패는 무시(프리뷰 우선) */ }
  }
  return err ? { ok: false, error: err } : { ok: true };
}

const PANE_TYPES = ["terminal", "ide", "preview", "emulator"];

// 모바일 화면 표면 찾기 — 독립 pane 우선, 없으면 혼합 탭. (findPreviewTarget/findIdeTarget 미러)
function findEmulatorTarget(rt) {
  const check = (l) => {
    if (l.kind === "emulator") return { leaf: l, tab: null };
    if (l.kind === "terminal") {
      const i = (l.tabs || []).findIndex((t) => t.kind === "emulator");
      if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
    }
    return null;
  };
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (focusLeaf) hit = check(focusLeaf);
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit) hit = check(l); });
  return hit;
}

/**
 * 표면(EmulatorView)이 붙을 때까지 기다린다. emulator-view.js 는 **동적 import** 라 pane 을 만든
 *  직후엔 `.emu` 가 아직 없다 — 동기로 조회하면 `?.select` 가 조용히 no-op 되고 "명령은 ok 인데
 *  기기가 안 바뀌는" 버그가 된다(previewOpen 의 waitPreviewControl 과 같은 이유·같은 처방).
 */
async function waitEmuView(getter, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = getter();
    if (v) return v;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 60));
  }
}

// 명령 → 핸들러. 반환 객체가 ui_result 프레임에 그대로 병합된다({ok, ...}).
const handlers = {
  // 풀 변경 통지 — 즉시 리컨실(공유 터미널 풀 ↔ 레이아웃 동기화).
  "pool.changed": async () => {
    await S.reconcilePool();
    return { ok: true };
  },

  // 작업 상태 스트림 — cwd 키로 저장만(사이드바 뱃지 표시). 활성 전환은 하지 않는다(수동적 갱신).
  "status.changed": async (p) => {
    if (!p.ws) throw new Error(i18n.t('ws 필요'));
    S.setWsStatus(p.ws, { status: p.status || [], progress: p.progress ?? null, logTail: p.logTail || "" });
    return { ok: true };
  },

  // 서버 워크스페이스 id 로 활성 전환.
  wsSelect: async (p) => {
    const meta = state.workspaces.find((w) => w.id === p.id);
    if (!meta) throw new Error(i18n.t('워크스페이스 없음'));
    S.setActive(meta.id);
    return { ok: true };
  },

  // 현재 레이아웃 트리 회신(순수 JSON).
  layoutTree: async (p) => {
    const { rt } = requireWs(p);
    return { ok: true, result: { tree: serializeNode(rt.layout), focusId: rt.focusId || null, device: "pc" } };
  },

  // pane 분할 — paneId 생략 시 포커스 pane. 터미널={win:'new'}, preview=url, ide=openPath.
  layoutSplit: async (p) => {
    const { meta, rt } = requireWs(p);
    if (!PANE_TYPES.includes(p.type)) throw new Error(i18n.t('알 수 없는 type: ') + p.type);
    const targetId = p.paneId || rt.focusId || T.firstLeafId(rt.layout);
    if (!targetId) throw new Error(i18n.t('분할할 pane 없음'));
    if (!T.findLeaf(rt.layout, targetId)) throw new Error(i18n.t('pane 없음: ') + targetId);
    const dir = p.direction === "v" || p.direction === "down" || p.direction === "bottom" ? "v" : "h";
    const opts =
      p.type === "preview" ? { url: p.url ? resolveUrl(p.url) : "" }
      : p.type === "ide" ? { openPath: normPath(meta, p.path) }
      : p.type === "emulator" ? { deviceId: p.device || null }
      : { fresh: true };
    S.splitPane(targetId, dir, p.type, opts);
    return { ok: true, paneId: rt.focusId };
  },

  // 포커스 pane 기준 자동 배치(헤더 통합 추가와 동일 규칙 — smartAdd 재사용).
  newPane: async (p) => {
    const { meta } = requireWs(p);
    if (!PANE_TYPES.includes(p.type)) throw new Error(i18n.t('알 수 없는 type: ') + p.type);
    const extra =
      p.type === "preview" ? { url: p.url ? resolveUrl(p.url) : "" }
      : p.type === "ide" ? { openPath: normPath(meta, p.path) }
      : p.type === "emulator" ? { deviceId: p.device || null }
      : undefined;
    const paneId = smartAdd(p.type, extra);
    if (!paneId) throw new Error(i18n.t('pane 생성 실패'));
    return { ok: true, paneId };
  },

  // pane 포커스 — 없으면 무시.
  focusPane: async (p) => {
    const { rt } = requireWs(p);
    if (!p.paneId || !T.findLeaf(rt.layout, p.paneId)) return { ok: true, skipped: true };
    S.focusPane(p.paneId);
    getPane(p.paneId)?.focus?.();
    return { ok: true };
  },

  // pane 닫기.
  closeSurface: async (p) => {
    const { meta, rt } = requireWs(p);
    if (!p.paneId || !T.findLeaf(rt.layout, p.paneId)) throw new Error(i18n.t('pane 없음: ') + (p.paneId || ""));
    // 원격에서 온 close 적용 — 프리뷰가 포함돼도 재전파하지 않는다(루프 차단).
    _applyingRemoteClose = true;
    try { S.closePane(meta.id, p.paneId); } finally { _applyingRemoteClose = false; }
    return { ok: true };
  },

  // branch 분할 비율 조정 — path 는 루트부터 'first'|'second' 배열.
  setRatio: async (p) => {
    requireWs(p);
    if (!Array.isArray(p.path)) throw new Error(i18n.t('path 는 branch 경로 배열'));
    const ratio = Number(p.ratio);
    if (!isFinite(ratio)) throw new Error(i18n.t('ratio 필요'));
    S.setRatio(p.path, ratio);
    return { ok: true };
  },

  // 열린 프리뷰가 있으면 그 pane 포커스+이동. 없으면 포커스 pane 우측 분할로 새로 연다.
  //  기기-타겟 라우팅이라 이 명령은 항상 "대상 기기 1곳"에서만 실행된다(구 broadcast 비-executor
  //  조용한 탭 편입 분기는 폐기 — 대상 기기에선 프리뷰를 눈에 띄게 여는 게 맞다).
  previewOpen: async (p) => {
    const { rt } = requireWs(p);
    const url = resolveUrl(p.url);
    if (!url) throw new Error(i18n.t('url 필요'));
    const target = findPreviewTarget(rt);
    if (target) {
      navigatePreview(target, url); // previewOpen = 처음 여는 신호 → 포그라운드(기본 foreground=true)
      return { ok: true, paneId: target.leaf.id };
    }
    // 신규 프리뷰 — 좁은 화면이면 분할 대신 활성 터미널 pane 에 탭으로(R1).
    const paneId = addSurfaceGated(rt, "preview", { url });
    return { ok: true, paneId };
  },

  /**
   * 모바일 화면 띄우기 — 에이전트가 "내가 고친 화면"을 사용자 눈앞에 올린다(previewOpen 미러).
   *  이미 열려 있으면 **그 표면의 기기만 바꾼다**(탭을 또 만들지 않는다). 기기 id 는 데몬이
   *  이미 켜진 것으로 골라 보내므로 여기서 목록을 다시 뒤지지 않는다.
   */
  emulatorOpen: async (p) => {
    const { rt } = requireWs(p);
    const device = typeof p.device === "string" && p.device ? p.device : null;
    const target = findEmulatorTarget(rt);
    if (target) {
      const pane = getPane(target.leaf.id);
      if (target.tab) {
        target.leaf.active = target.index;      // 뒤에 숨어 있었으면 앞으로 끌어온다
        pane?.buildHead();
        pane?.showActiveTab?.();                // _ensureMixed 가 tid 부여 + EmulatorView 생성
      }
      S.focusPane(target.leaf.id);
      S.emit();
      if (device) {
        const view = await waitEmuView(() => (target.tab
          ? (target.tab.tid ? pane?._mixed?.get(target.tab.tid)?.emu : null)
          : getPane(target.leaf.id)?.emu));
        if (!view) throw new Error(i18n.t('모바일 화면이 준비되지 않았어요'));
        view.select(device);
      }
      //  ★ 회신 알맹이는 `result` 에 담는다(layoutTree 와 같은 규약). 여기 밖에 두면 부르는 쪽에는
      //   `undefined` 만 간다 — 실제로 `cpt emulator show --json` 이 undefined 를 뱉었다(실측).
      return { ok: true, result: { paneId: target.leaf.id, device } };
    }
    const paneId = addSurfaceGated(rt, "emulator", { deviceId: device });
    return { ok: true, result: { paneId, device } };
  },

  // 모바일 화면 닫기 — 독립 pane 은 통째로, 혼합 탭이면 그 탭만.
  emulatorClose: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findEmulatorTarget(rt);
    if (!target) return { ok: true, skipped: true };
    closeSurfaceTarget(meta, target);
    return { ok: true };
  },

  // 첫(포커스 우선) 프리뷰 대상에 URL 이동 — 백그라운드(사용자 활성 탭을 강제 전환하지 않음, R2).
  previewNavigate: async (p) => {
    const { rt } = requireWs(p);
    const url = resolveUrl(p.url);
    if (!url) throw new Error(i18n.t('url 필요'));
    const target = findPreviewTarget(rt);
    if (!target) throw new Error(i18n.t('프리뷰 없음'));
    navigatePreview(target, url, false);
    return { ok: true };
  },

  // 첫(포커스 우선) 프리뷰 새로고침.
  previewReload: async (p) => {
    const { rt } = requireWs(p);
    const target = findPreviewTarget(rt);
    if (!target) throw new Error(i18n.t('프리뷰 없음'));
    // 혼합 탭인데 표면이 아직 없으면(한 번도 안 띄움) 새로고침 대상 없음.
    if (target.tab && !target.tab.tid) return { ok: true, skipped: true };
    const pvId = target.tab ? "pv-" + target.tab.tid : "pv-" + (target.leaf.tid || target.leaf.id);
    api.previewControl(pvId, "reload").catch(() => {});
    return { ok: true };
  },

  // IDE 로 파일 열기 — 기존 IDE(pane/혼합 탭) 재사용, 없으면 IDE pane 분할 생성.
  ideOpen: async (p) => {
    const { meta, rt } = requireWs(p);
    const path = normPath(meta, p.path);
    if (!path) throw new Error(i18n.t('path 필요'));
    const line = p.line || null;
    const check = (l) => {
      if (l.kind === "ide") return { leaf: l, tab: null };
      if (l.kind === "terminal") {
        const i = (l.tabs || []).findIndex((t) => t.kind === "ide");
        if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
      }
      return null;
    };
    let target = null;
    const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
    if (focusLeaf) target = check(focusLeaf);
    if (!target) T.eachLeaf(rt.layout, (l) => { if (!target) target = check(l); });
    if (!target) {
      // IDE 없음 — 좁은 화면이면 분할 대신 활성 터미널 pane 에 탭으로(R1).
      const paneId = addSurfaceGated(rt, "ide", { openPath: path, line });
      return { ok: true, paneId };
    }
    const pane = getPane(target.leaf.id);
    if (target.tab) {
      // 혼합 IDE 탭 활성화 → 본문(IdeView) 보장 후 파일 열기.
      target.leaf.active = target.index;
      pane?.buildHead();
      pane?.showActiveTab?.(); // _ensureMixed 가 tid 부여 + IdeView 생성
      const m = target.tab.tid ? pane?._mixed?.get(target.tab.tid) : null;
      m?.ide?.openFile(path, line);
    } else {
      pane?.ide?.openFile(path, line);
    }
    S.focusPane(target.leaf.id);
    S.emit();
    return { ok: true, paneId: target.leaf.id };
  },

  // git diff 를 읽기 전용 가상 문서로 표시(ui.ideDiff) — 대상 탐색/생성은 ideOpen 미러,
  //  저장·자동저장·리컨실러 격리는 IdeView.openDiff(virtual 플래그)가 책임진다. 같은 path 재호출=내용 갱신.
  ideDiff: async (p) => {
    const { meta, rt } = requireWs(p);
    const path = normPath(meta, p.path);
    if (!path) throw new Error(i18n.t('path 필요'));
    const diffText = typeof p.diffText === "string" ? p.diffText : "";
    const target = findIdeTarget(rt);
    if (!target) {
      // IDE 없음 → 포커스 pane 우측 분할로 생성 후 diff 문서 열기(splitPane 은 동기 render).
      const focusId = rt.focusId || T.firstLeafId(rt.layout);
      if (!focusId) throw new Error(i18n.t('분할할 pane 없음'));
      S.splitPane(focusId, "h", "ide", {});
      getPane(rt.focusId)?.ide?.openDiff(path, diffText);
      return { ok: true, result: { paneId: rt.focusId } };
    }
    const pane = getPane(target.leaf.id);
    if (target.tab) {
      // 혼합 IDE 탭 활성화 → 본문(IdeView) 보장 후 diff 열기(ideOpen 과 동일 절차).
      target.leaf.active = target.index;
      pane?.buildHead();
      pane?.showActiveTab?.(); // _ensureMixed 가 tid 부여 + IdeView 생성
      const m = target.tab.tid ? pane?._mixed?.get(target.tab.tid) : null;
      m?.ide?.openDiff(path, diffText);
    } else {
      pane?.ide?.openDiff(path, diffText);
    }
    S.focusPane(target.leaf.id);
    S.emit();
    return { ok: true, result: { paneId: target.leaf.id } };
  },

  /**
   * 코드 리뷰 띄우기(ui.review) — **에이전트가 스스로 요청했을 때만** 온다(사용자 확정: 강제
   *  관문이 아니라 도구). 대상 IDE 탐색·생성은 ideDiff 미러다.
   *
   * ★ 여기서는 **띄우기만** 한다. 결과는 사용자가 보내기를 누를 때 `review.submit` RPC 로
   *   따로 간다 — 한 번의 ui_command 왕복(최대 60초)으로 사람의 리뷰 시간을 기다릴 수 없기
   *   때문이다(daemon review.js 머리주석).
   */
  review: async (p) => {
    const { meta, rt } = requireWs(p);
    if (!p || !p.reviewId || !Array.isArray(p.files) || !p.files.length) throw new Error(i18n.t('리뷰 내용이 없습니다'));
    const target = findIdeTarget(rt);
    const open = (pane, m) => {
      const ide = m ? m.ide : pane?.ide;
      ide?.openReview(p, meta);
    };
    if (!target) {
      const focusId = rt.focusId || T.firstLeafId(rt.layout);
      if (!focusId) throw new Error(i18n.t('분할할 pane 없음'));
      S.splitPane(focusId, "h", "ide", {});
      open(getPane(rt.focusId), null);
      return { ok: true, result: { paneId: rt.focusId } };
    }
    const pane = getPane(target.leaf.id);
    if (target.tab) {
      target.leaf.active = target.index;
      pane?.buildHead();
      pane?.showActiveTab?.();
      open(pane, target.tab.tid ? pane?._mixed?.get(target.tab.tid) : null);
    } else {
      open(pane, null);
    }
    S.focusPane(target.leaf.id);
    S.emit();
    return { ok: true, result: { paneId: target.leaf.id } };
  },

  // 첫(포커스 우선) 프리뷰 표면(pane/혼합 탭) 닫기 — 없으면 멱등 성공. (Phase 1: 각 기기 로컬 — sid 무시)
  previewClose: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findPreviewTarget(rt);
    if (!target) return { ok: true }; // 없으면 멱등 성공
    // 원격에서 온 close 적용 — 이 닫힘은 재전파하지 않는다(루프 차단).
    _applyingRemoteClose = true;
    try { closeSurfaceTarget(meta, target); } finally { _applyingRemoteClose = false; }
    return { ok: true };
  },

  // 개발자도구 토글(executor) — 보고 있는 기기의 프리뷰 인스턴스. on 생략 시 반전. 새 상태 회신.
  previewDevtools: async (p) => {
    const { rt } = requireWs(p);
    const { target, surface } = findPreviewSurface(rt);
    if (!target) throw new Error(i18n.t('프리뷰 없음'));
    if (!surface) throw new Error(i18n.t('프리뷰가 아직 로드되지 않았어요'));
    const on = typeof p.on === "boolean" ? p.on : undefined;
    const cur = dtActive(surface.pvId);
    const want = on === undefined ? !cur : on;
    let result = cur;
    if (want !== cur) result = await toggleChiiDevtools(surface.pvId, surface.host);
    return { ok: true, result: { on: !!result } };
  },

  // Design Mode(ui.previewInspect) — executor 프리뷰에 요소 선택 모드 시작/취소(off). 선택 결과는
  //  비동기(design-pick 폴링 → 터미널 [디자인] 줄 삽입) — 여기선 모드 on/off 만 회신(result 키 필수).
  previewInspect: async (p) => {
    if (p && p.off) {
      await cancelDesignPick(); // 모드 없어도 멱등 성공
      return { ok: true, result: { on: false } };
    }
    const { meta, rt } = requireWs(p);
    const pvId = requirePreviewId(rt);
    const on = await startDesignPick({ pvId, localPath: meta.localPath || "" });
    return { ok: true, result: { on: !!on } };
  },

  // 프리뷰 현재 상태 조회(executor) — url/제목/뷰포트/기기. 표면 미로드면 url 빈 값.
  previewInfo: async (p) => {
    const { rt } = requireWs(p);
    const { target, surface } = findPreviewSurface(rt);
    if (!target) throw new Error(i18n.t('프리뷰 없음'));
    if (!surface) return { ok: true, result: { url: "", device: "pc" } };
    const out = { url: surface.bar?.url || "", device: "pc" };
    if (surface.title) out.title = surface.title;
    const r = surface.host?.getBoundingClientRect?.();
    if (r && r.width > 2 && r.height > 2) out.viewport = { w: Math.round(r.width), h: Math.round(r.height) };
    return { ok: true, result: out };
  },

  // 핸드오프: 현재 활성 프리뷰 표면을 매니페스트로 캡처(pull 소스/CLI). ws 없으면 활성 워크스페이스.
  surfaceCapture: async (p) => {
    const kind = p.kind === "ide" ? "ide" : "preview";
    const { rt } = requireWsOrActive(p);
    if (kind === "ide") return { ok: false, code: "NO_PREVIEW", error: i18n.t('IDE 핸드오프 미지원') };
    const target = findPreviewTarget(rt);
    if (!target) return { ok: false, code: "NO_PREVIEW", error: i18n.t('프리뷰 없음') };
    if (target.tab && !target.tab.tid) return { ok: false, code: "NO_PREVIEW", error: i18n.t('프리뷰 표면 미생성') };
    const pvId = target.tab ? "pv-" + target.tab.tid : "pv-" + (target.leaf.tid || target.leaf.id);
    const manifest = await captureManifestPC(pvId);
    return { ok: true, result: { manifest, kind: "preview" } };
  },

  // 핸드오프: 매니페스트를 이 기기에 복원(push 타겟/CLI). ws 있으면 그 워크스페이스, 없으면 활성.
  previewHandoff: async (p) => {
    if (!p.manifest || typeof p.manifest !== "object") throw new Error(i18n.t('manifest 필요'));
    const { rt } = requireWsOrActive(p);
    return await restoreManifestPC(rt, p.manifest);
  },

  // 첫(포커스 우선) IDE 표면(pane/혼합 탭) 닫기 — 없으면 멱등 성공. (Phase 1: 각 기기 로컬)
  ideClose: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findIdeTarget(rt);
    if (!target) return { ok: true }; // 없으면 멱등 성공
    closeSurfaceTarget(meta, target);
    return { ok: true };
  },

  // 열린 파일 탭 하나 닫기 — 첫 IDE 표면의 열린 파일에서 제거(라이브). skipped 회신.
  ideCloseFile: async (p) => {
    const { meta, rt } = requireWs(p);
    const path = normPath(meta, p.path);
    if (!path) throw new Error(i18n.t('path 필요'));
    const target = findIdeTarget(rt);
    if (!target) throw new Error(i18n.t('IDE 없음'));
    const ide = ideInstanceOf(target);
    const closed = ide?.closeFileByPath ? ide.closeFileByPath(path) : false;
    return { ok: true, result: { skipped: !closed } };
  },

  // 지금 열린 파일 목록(executor) — 첫 IDE 표면의 열린 파일(ws 상대 경로)+활성.
  ideList: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findIdeTarget(rt);
    if (!target) throw new Error(i18n.t('IDE 없음'));
    const ide = ideInstanceOf(target);
    const list = ide?.listOpenFiles ? ide.listOpenFiles() : [];
    const files = list.map((f) => ({ path: relPath(meta, f.path), active: !!f.active }));
    return { ok: true, result: { files, device: "pc" } };
  },
};
