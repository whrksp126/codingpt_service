// main.js — 엔트리. 셸 마운트 + 상태 구독 + 이벤트/단축키 배선 + 초기 로드.
import "./theme.js"; // 모양(테마·글꼴) — 첫 페인트 전에 data-theme/폰트 변수 적용(최상단 유지)
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { mountSidebar, updateSidebar, refreshWsMeta, toggleLatestUnread } from "./sidebar.js";
import {
  mountWorkspaceView,
  updateWorkspaceView,
  focusNeighbor,
  focusCurrentPane,
} from "./workspace-view.js";
import { mountSettings, updateSettings, deepLinkPair } from "./settings.js";
import { mountLoginGate, updateLoginGate } from "./login-gate.js";
import { dispatchData, dispatchExit, getPane } from "./pane.js";
import { startUiChannel } from "./ui-channel.js";
import { startE2ee } from "./e2ee.js";
import { ideDirtyPaths } from "./ide.js";
import { initOsDrop } from "./os-drop.js";
import { mountApprovals, updateApprovals } from "./approvals.js";
// 기기 승인(계정 로그인 확인) — 설정 화면 밖 독립 표면(상단 중앙 카드). 설계 근거는 device-approval.js 헤더.
import { mountDeviceApprovals, updateDeviceApprovals } from "./device-approval.js";
import { maybeShowOnboarding } from "./agents-view.js";

// ── 앱 종료 가드 — Rust 가 미저장 변경을 감지해 종료를 막고 cpt-quit-guard 를 보낸다. ──
//  스펙(사용자 확정): 취소 / (저장 안 하고) 종료 2택. 저장은 탭의 ● 표시 + ⌘S(또는 자동저장 완료 대기).
function initQuitGuard() {
  api.onQuitGuard(() => {
    if (document.querySelector(".quit-guard-backdrop")) return; // 중복 방지
    const files = ideDirtyPaths();
    const list = files.slice(0, 6).map((p) => `<div class="qg-file">● ${p.split("/").pop()}</div>`).join("")
      + (files.length > 6 ? `<div class="qg-file">… 외 ${files.length - 6}개</div>` : "");
    const bd = document.createElement("div");
    bd.className = "quit-guard-backdrop";
    bd.innerHTML = `
      <div class="quit-guard">
        <div class="qg-title">저장되지 않은 변경이 있습니다</div>
        <div class="qg-desc">${files.length}개 파일이 아직 저장되지 않았습니다. 지금 종료하면 변경 내용이 사라집니다.</div>
        <div class="qg-files">${list}</div>
        <div class="qg-actions">
          <button class="qg-btn qg-cancel">취소</button>
          <button class="qg-btn qg-quit">저장 안 하고 종료</button>
        </div>
      </div>`;
    bd.querySelector(".qg-cancel").addEventListener("click", () => bd.remove());
    bd.querySelector(".qg-quit").addEventListener("click", () => { api.quitApp().catch(() => {}); });
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
    document.body.appendChild(bd);
  });
}

const shellEl = document.querySelector(".shell");
const sidebarEl = document.getElementById("sidebar");
const wsViewEl = document.getElementById("wsView");
const settingsEl = document.getElementById("settingsView");
const loginGateEl = document.getElementById("loginGate");

mountSidebar(sidebarEl, {});
mountWorkspaceView(wsViewEl);
mountSettings(settingsEl);
mountLoginGate(loginGateEl);
mountApprovals(); // 승인 카드 스택(하단 중앙) — 워크스페이스/설정 어느 화면에서도 응답 가능해야 한다
mountDeviceApprovals(); // 기기 승인 카드(상단 중앙) — 승인은 설정이 아니라 이 사건 표면에서 한다

let lastActive = null;
function render() {
  updateLoginGate(); // 미로그인 시 전체화면 게이트로 앱 차단
  shellEl.classList.toggle("sb-collapsed", state.sidebarCollapsed);
  updateSidebar();
  const settingsShown = state.view === "settings";
  // 설정은 모달 오버레이 → 워크스페이스는 항상 렌더(뒤에 보임).
  updateSettings();
  updateWorkspaceView();
  updateApprovals(); // 승인 카드는 Chat 뷰 슬롯 판정을 위해 workspace 렌더 뒤에 갱신
  updateDeviceApprovals(); // 기기 승인 카드(대기 요청이 있을 때만 존재)
  if (state.activeWsId !== lastActive) {
    lastActive = state.activeWsId;
    if (state.activeWsId && !settingsShown) setTimeout(focusCurrentPane, 40);
  }
}
S.subscribe(render);
// 작업 스냅샷(자동 체크포인트) 트리거는 MVP 범위 제외로 잠정 배선 해제(2026-07-21 결정) — 엔진 보존.

// ── PTY / 데몬 / 딥링크 이벤트 ──
api.onPtyData((p) => dispatchData(p.paneId, p.b64));
api.onPtyExit((p) => dispatchExit(p.paneId));
api.onDaemonChanged(async () => {
  state.daemon = await api.daemonStatus().catch(() => state.daemon);
  state.paired = !!state.daemon?.paired;
  // 로그인/로그아웃/계정 전환 시 daemon-changed 가 온다(재페어링=데몬 재기동).
  if (!state.paired) {
    // 로그아웃/언페어 → 이전 계정 컨텍스트 완전 정리(clean slate). loadWorkspaces 는 실패해도
    //  옛 목록을 안 지우므로 여기서 명시적으로 비운다 → 로그인 게이트로 전환된다.
    state.workspaces = [];
    state.activeWsId = null;
    state.me = null;
    state.devices = [];
    state.wsError = null;
    state.wsStale = null;
    S.emit();
    return;
  }
  // 로그인/계정 전환 → 새 계정 기준으로 워크스페이스·프로필·기기 새로고침. loadWorkspaces 는 활성
  //  워크스페이스가 새 목록에 없으면 자동으로 첫 항목으로 전환하므로 이전 계정 터미널이 정리된다.
  await S.loadWorkspaces().catch(() => {});
  S.loadMe();
  S.loadDevices();
  // 재페어링은 새 device 행을 만들 수 있다 → 옛 기기에 묶인 이 PC 워크스페이스를 즉시 재클레임
  //  (안 하면 터미널이 죽은 기기로 시작 요청 → 409 DAEMON_OFFLINE 영구화).
  S.reconcileWorkspaceHosts();
  S.emit();
});
api.onDeepLinkPair((payload) => deepLinkPair(payload));

function focusedPane() {
  const w = S.wsRuntime(state.activeWsId);
  return w?.focusId ? getPane(w.focusId) : null;
}

// (구) 앱 활성화 시 창 크기 회수(resize-window 클레임)는 폐지 — 전용 세션 모델에선 window-size
//  latest 가 입력/리사이즈하는 클라이언트를 자동으로 따라간다(수동 클레임 = 크기 뺏기 전쟁의 근원).

// ── 활성 영역 검색(⌘F / Ctrl+F) ──
//  ⌘F = 터미널·IDE 모두. Ctrl+F 는 터미널의 셸 forward-char 를 살리려 IDE 에서만.
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "f") return;
  if (state.view === "settings") return;
  const meta = e.metaKey && !e.ctrlKey;
  const ctrl = e.ctrlKey && !e.metaKey;
  if (!meta && !ctrl) return;
  const p = focusedPane();
  if (!p) return;
  if (ctrl && p.node.kind === "terminal") return; // 셸 Ctrl+F 보존
  e.preventDefault();
  p.openSearch?.();
});

// ── 키보드 단축키(cmux 유사) ──
window.addEventListener("keydown", (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  if (e.altKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)) {
    e.preventDefault();
    focusNeighbor(k.replace("arrow", ""));
    return;
  }
  if (k === "d" && !e.shiftKey) {
    e.preventDefault();
    S.splitFocused("h", "terminal");
  } else if (k === "d" && e.shiftKey) {
    e.preventDefault();
    S.splitFocused("v", "terminal");
  } else if (k === "w") {
    e.preventDefault();
    S.closeFocused();
  } else if (k === "u" && e.shiftKey) {
    e.preventDefault();
    toggleLatestUnread();
  } else if (k === "," ) {
    e.preventDefault();
    S.setView(state.view === "settings" ? "workspace" : "settings");
  } else if (/^[1-8]$/.test(e.key)) {
    const w = state.workspaces[parseInt(e.key, 10) - 1];
    if (w) {
      e.preventDefault();
      S.setActive(w.id);
    }
  }
});

// ── 초기화 ──
// punch-through 이벤트 실드 — DOM 오버레이(모달/메뉴/드롭다운/게이트)가 떠 있는 동안엔 프리뷰 구멍
//  안의 클릭·스크롤이 프리뷰로 내려가면 안 된다(오버레이가 위에 보이는데 뒤가 반응하는 사고).
//  셀렉터 존재 여부를 주기 폴링해 변화 시에만 Rust 에 통지(hitTest 가 참조).
function startPreviewShieldWatch() {
  // .approval-card — 승인 카드는 프리뷰 구멍 위에 뜰 수 있다. 실드가 없으면 카드가 보이는데
  //  클릭이 뒤의 프리뷰로 내려가 "허용 버튼이 안 눌리는" 사고가 난다(punch-through 규율).
  // .ag-sheet — 에이전트 설치 시트(설정 밖, 온보딩에서도 뜬다). 안에 실제 터미널이 있어 클릭·키
  //  입력이 뒤의 프리뷰로 새면 명령이 엉뚱한 곳에 들어간다.
  const SEL = ".settings-modal:not(.hidden), .ag-sheet, .pv-menu, .pv-suggest, .wv-sheet-overlay, .notif-panel:not(.hidden), .ctx-menu, .fd-menu:not(.hidden), .login-gate:not(.hidden), .quit-guard-backdrop, .drag-overlay, .approval-card, body.tab-dragging, body.resizing-col, body.resizing-row, body.os-dragging";
  let cur = null;
  setInterval(() => {
    const on = !!document.querySelector(SEL);
    if (on !== cur) { cur = on; api.previewShield(on); }
  }, 80);
}

(async function init() {
  await S.restorePersisted();
  state.daemon = await api.daemonStatus().catch(() => null);
  state.paired = !!state.daemon?.paired;
  await S.loadWorkspaces();
  S.loadMe();
  S.loadDevices();
  S.reconcileWorkspaceHosts(); // 무귀속 로컬 워크스페이스를 이 호스트로 백필
  S.loadNotifications(); // 서버 알림 미러(실패해도 부팅 진행)
  S.loadApprovals(); // 대기 중 승인 캐치업(부팅 중 폰이 아직 안 답한 카드가 있을 수 있다)
  startUiChannel(); // UI 실시간 채널(WS) — 알림/승인/채팅 이벤트 수신
  startE2ee(); // 종단간 암호화 상태(데몬 위임) — 실패해도 부팅/기능에 영향 없음(평문 폴백)
  startPreviewShieldWatch(); // punch-through: DOM 오버레이 열림 동안 프리뷰 이벤트 포워딩 차단
  initOsDrop(); // OS 파일 드래그앤드랍 → 터미널 pane 경로 삽입
  initQuitGuard(); // 미저장 IDE 변경이 있을 때 앱 종료(Cmd+Q·트레이) 확인 다이얼로그
  render();
  refreshWsMeta();
  // 첫 실행 1스텝: "이 PC 에서 찾은 에이전트 — 연동할까요?" (한 번만, 데몬이 기록).
  //  페어링 전이면 묻지 않는다(설정 저장 대상이 daemon.json 이라 페어링이 선행돼야 한다).
  if (state.paired) maybeShowOnboarding().catch(() => {});

  // 백그라운드 폴링: 데몬 상태 / 워크스페이스 메타(브랜치·포트).
  setInterval(async () => {
    const prev = JSON.stringify(state.daemon);
    state.daemon = await api.daemonStatus().catch(() => state.daemon);
    if (JSON.stringify(state.daemon) !== prev) S.emit();
  }, 4000);
  setInterval(() => refreshWsMeta(), 15000);
  // 신선도(미커밋/미푸시)·타 호스트 브랜치는 서버 메타에 실림 — 목록을 주기 재로드해 배지 갱신.
  setInterval(() => { S.loadWorkspaces().catch(() => {}); }, 60000);
})();
