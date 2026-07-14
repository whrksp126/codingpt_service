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
  render();
  refreshWsMeta();

  // 백그라운드 폴링: 데몬 상태 / 워크스페이스 메타(브랜치·포트).
  setInterval(async () => {
    const prev = JSON.stringify(state.daemon);
    state.daemon = await api.daemonStatus().catch(() => state.daemon);
    if (JSON.stringify(state.daemon) !== prev) S.emit();
  }, 4000);
  setInterval(() => refreshWsMeta(), 15000);
})();
