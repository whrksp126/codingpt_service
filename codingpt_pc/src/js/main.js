// main.js — 엔트리. 셸 마운트 + 상태 구독 + 이벤트/단축키 배선 + 초기 로드.
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
import { initAutoCheckpoint } from "./auto-checkpoint.js";
import { ideDirtyPaths } from "./ide.js";

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

let lastActive = null;
function render() {
  updateLoginGate(); // 미로그인 시 전체화면 게이트로 앱 차단
  shellEl.classList.toggle("sb-collapsed", state.sidebarCollapsed);
  updateSidebar();
  const settingsShown = state.view === "settings";
  // 설정은 모달 오버레이 → 워크스페이스는 항상 렌더(뒤에 보임).
  updateSettings();
  updateWorkspaceView();
  if (state.activeWsId !== lastActive) {
    lastActive = state.activeWsId;
    if (state.activeWsId && !settingsShown) setTimeout(focusCurrentPane, 40);
  }
}
S.subscribe(render);
initAutoCheckpoint(); // 작업 스냅샷(자동 체크포인트) 트리거 — 설정 꺼져 있으면 no-op

// ── PTY / 데몬 / 딥링크 이벤트 ──
api.onPtyData((p) => dispatchData(p.paneId, p.b64));
api.onPtyExit((p) => dispatchExit(p.paneId));
api.onDaemonChanged(async () => {
  state.daemon = await api.daemonStatus().catch(() => state.daemon);
  state.paired = !!state.daemon?.paired;
  S.emit();
});
api.onDeepLinkPair((payload) => deepLinkPair(payload));

function focusedPane() {
  const w = S.wsRuntime(state.activeWsId);
  return w?.focusId ? getPane(w.focusId) : null;
}

// ── 앱 창 활성화 시 포커스 터미널의 창 크기 회수 ──
//  다른 기기가 같은 터미널을 자기 크기로 잡아두면(창=manual 고정) PC 화면이 우측 잘림으로 남는다.
//  부팅 보정은 이미 잡힌(manual) 창을 건드리지 않으므로, "PC 앱을 앞으로 가져온 순간"을 사용자
//  의사로 보고 이 기기 크기로 회수한다(pane 내부 클릭·포커스와 같은 규칙, 1.2s 스로틀).
let lastWinClaim = 0;
function claimFocusedTerminalSize() {
  const n = Date.now();
  if (n - lastWinClaim < 1200) return;
  lastWinClaim = n;
  const p = focusedPane();
  if (!p || p.node.kind !== "terminal") return;
  const t = p.node.tabs?.[p.node.active];
  if (t && typeof t.win === "number") p._view(t.win);
}
window.addEventListener("focus", claimFocusedTerminalSize);
// 부팅 직후 1회 — attach(500ms 보정은 virgin 창만)가 끝난 뒤 잡힌 창도 이 기기 크기로.
setTimeout(claimFocusedTerminalSize, 1600);

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
(async function init() {
  await S.restorePersisted();
  state.daemon = await api.daemonStatus().catch(() => null);
  state.paired = !!state.daemon?.paired;
  await S.loadWorkspaces();
  S.loadMe();
  S.loadDevices();
  S.reconcileWorkspaceHosts(); // 무귀속 로컬 워크스페이스를 이 호스트로 백필
  S.loadNotifications(); // 서버 알림 미러(실패해도 부팅 진행)
  startUiChannel(); // UI 실시간 채널(WS) — 알림 이벤트 수신
  initQuitGuard(); // 미저장 IDE 변경이 있을 때 앱 종료(Cmd+Q·트레이) 확인 다이얼로그
  render();
  refreshWsMeta();

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
