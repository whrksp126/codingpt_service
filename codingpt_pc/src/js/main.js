// main.js — 엔트리. 셸 마운트 + 상태 구독 + 이벤트/단축키 배선 + 초기 로드.
import { bootLang } from "./theme.js"; // 모양(테마·글꼴·언어) — 첫 페인트 전에 data-theme/폰트/언어 적용(최상단 유지)
bootLang(); // ★ 어떤 화면 코드보다 먼저. 이 뒤에 그려지는 문구부터 선택된 언어로 나온다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { mountSidebar, updateSidebar, refreshWsMeta, toggleLatestUnread, toggleNotifPanel } from "./sidebar.js";
import {
  mountWorkspaceView,
  updateWorkspaceView,
  focusNeighbor,
  focusCurrentPane,
  smartAdd,
  headerButton,
} from "./workspace-view.js";
import { registerCommands, runCommand } from "./command-run.js";
import { commandForCombo } from "./commands.js";
import { bindings, comboOf, IS_WINDOWS } from "./shortcuts.js";
import { basename } from "./path-utils.js";
import { initWinCaption } from "./win-caption.js";
import { openPalette, isPaletteOpen } from "./palette.js";
import { mountSettings, updateSettings, deepLinkPair, openSettingsSection } from "./settings.js";
import {
  hideSetupUpdate,
  mountLoginGate,
  resetOnboardingForInstall,
  restorePendingSetup,
  showSetupUpdate,
  updateLoginGate,
  updateSetupProgress,
} from "./login-gate.js";
import { dispatchData, dispatchExit, getPane } from "./pane.js";
import { startUiChannel } from "./ui-channel.js";
import { startE2ee } from "./e2ee.js";
import { ideDirtyPaths } from "./ide.js";
import { initOsDrop } from "./os-drop.js";
import { mountApprovals, updateApprovals } from "./approvals.js";
// (★ 개정 12: 기기 승인 표면 삭제 — 승인 절차 자체가 없어졌다. 연동은 설정 > 계정 > 기기에서 코드로.)
import { maybeShowOnboarding } from "./agents-view.js";
import { startUpdateScheduler, applyNow, deferApply } from "./update-scheduler.js";
import * as i18n from './i18n/index.js';

// ── 앱 종료 가드 — Rust 가 미저장 변경을 감지해 종료를 막고 cpt-quit-guard 를 보낸다. ──
//  스펙(사용자 확정): 취소 / (저장 안 하고) 종료 2택. 저장은 탭의 ● 표시 + ⌘S(또는 자동저장 완료 대기).
function initQuitGuard() {
  api.onQuitGuard(() => {
    if (document.querySelector(".quit-guard-backdrop")) return; // 중복 방지
    const files = ideDirtyPaths();
    const list = files.slice(0, 6).map((p) => `<div class="qg-file">● ${basename(p) || p}</div>`).join("")
      + (files.length > 6 ? `<div class="qg-file">… 외 ${files.length - 6}개</div>` : "");
    const bd = document.createElement("div");
    bd.className = "quit-guard-backdrop";
    bd.innerHTML = `
      <div class="quit-guard">
        <div class="qg-title">${i18n.t('저장되지 않은 변경이 있습니다')}</div>
        <div class="qg-desc">${files.length}개 파일이 아직 저장되지 않았습니다. 지금 종료하면 변경 내용이 사라집니다.</div>
        <div class="qg-files">${list}</div>
        <div class="qg-actions">
          <button class="qg-btn qg-cancel">${i18n.t('취소')}</button>
          <button class="qg-btn qg-quit">${i18n.t('저장 안 하고 종료')}</button>
        </div>
      </div>`;
    bd.querySelector(".qg-cancel").addEventListener("click", () => bd.remove());
    bd.querySelector(".qg-quit").addEventListener("click", () => { api.quitApp().catch(() => {}); });
    bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
    document.body.appendChild(bd);
  });
}

// win32 표식 + 창틀 — styles.css 의 트래픽라이트 여백 변수(--titlebar-inset-*)가 이 속성을 보고,
//  decorations:false 창의 우측 상단 min/max/close 버튼(win-caption.js)을 단다. mac 은 아무 것도 안 한다.
if (IS_WINDOWS) {
  document.documentElement.dataset.os = "windows";
  initWinCaption();
}

const shellEl = document.querySelector(".shell");
const sidebarEl = document.getElementById("sidebar");
const wsViewEl = document.getElementById("wsView");
const settingsEl = document.getElementById("settingsView");
const loginGateEl = document.getElementById("loginGate");
const bootstrapGateEl = document.getElementById("bootstrapGate");
const bootstrapLabelEl = document.getElementById("bootstrapLabel");
const bootstrapBarEl = document.getElementById("bootstrapBar");

function setBootstrap(label, progress) {
  if (bootstrapLabelEl) bootstrapLabelEl.textContent = label;
  if (bootstrapBarEl) bootstrapBarEl.style.width = `${Math.max(4, Math.min(100, progress))}%`;
}

function finishBootstrap() {
  setBootstrap(i18n.t('준비됐어요'), 100);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bootstrapGateEl?.classList.add("done");
    setTimeout(() => bootstrapGateEl?.remove(), 220);
  }));
}

mountSidebar(sidebarEl, {});
mountWorkspaceView(wsViewEl);
mountSettings(settingsEl);
mountLoginGate(loginGateEl);
mountApprovals(); // 승인 카드 스택(하단 중앙) — 워크스페이스/설정 어느 화면에서도 응답 가능해야 한다

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
  await S.loadMe();
  restorePendingSetup();
  S.loadDevices();
  // 재페어링은 새 device 행을 만들 수 있다 → 옛 기기에 묶인 이 PC 워크스페이스를 즉시 재클레임
  //  (안 하면 터미널이 죽은 기기로 시작 요청 → 409 DAEMON_OFFLINE 영구화).
  S.reconcileWorkspaceHosts();
  S.emit();
});
api.onDeepLinkPair((payload) => deepLinkPair(payload));
api.onOpenSettings(() => openSettingsSection("appearance"));
api.onCheckUpdate(() => openSettingsSection("about"));

function focusedPane() {
  const w = S.wsRuntime(state.activeWsId);
  return w?.focusId ? getPane(w.focusId) : null;
}

// (구) 앱 활성화 시 창 크기 회수(resize-window 클레임)는 폐지 — 전용 세션 모델에선 window-size
//  latest 가 입력/리사이즈하는 클라이언트를 자동으로 따라간다(수동 클레임 = 크기 뺏기 전쟁의 근원).

// ── Ctrl+F(터미널 아닌 곳에서만) — macOS 전용 ──
//  ⌘F 는 아래 단축키 표(find.open)가 처리한다. Ctrl+F 만 여기 남는 이유: 터미널에서는 셸의
//  forward-char 를 살려야 해서 **pane 종류를 봐야** 하는데, 이건 조합이 아니라 상황 판정이라
//  재바인딩 표에 담기지 않는다.
//  win32 에선 걸지 않는다 — Ctrl 이 곧 Mod 라 사용자가 find.open 을 Ctrl+F 로 재바인딩하면
//  이 핸들러와 이중 처리가 되고, 기본값(Ctrl+Shift+F)은 표가 이미 처리한다(계약 5).
if (!IS_WINDOWS) window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "f") return;
  if (!e.ctrlKey || e.metaKey) return;
  if (state.view === "settings") return;
  const p = focusedPane();
  if (!p || p.node.kind === "terminal") return; // 셸 Ctrl+F 보존
  e.preventDefault();
  p.openSearch?.();
});

// ── 명령 동작 등록 ──
//  단축키와 팔레트가 **같은 함수**를 부른다. 예전엔 여기 if-else 사슬에 조합이 박혀 있어
//  재바인딩이 불가능했고, 팔레트에서 같은 일을 하려면 코드를 한 벌 더 써야 했다.
registerCommands({
  "palette.open": () => (isPaletteOpen() ? null : openPalette()),
  "find.open": () => focusedPane()?.openSearch?.(),

  // 추가 3종은 **바로 추가한다**(헤더 버튼의 드롭다운이 아니라). 단축키를 눌렀는데 메뉴가 뜨면
  //  손이 한 번 더 간다 — 에이전트 고르기·포트 고르기는 버튼에 그대로 남아 있다.
  "ws.addTerminal": () => smartAdd("terminal"),
  "ws.addIde": () => smartAdd("ide"),
  "ws.addPreview": () => smartAdd("preview"),
  "ws.addEmulator": () => smartAdd("emulator"),
  // 이 둘은 고르는 것이 목적이라 메뉴를 연다(헤더 버튼과 같은 자리에서).
  "ws.ports": () => headerButton("ws.ports")?.click(),

  "pane.splitRight": () => S.splitFocused("h", "terminal"),
  "pane.splitDown": () => S.splitFocused("v", "terminal"),
  "pane.close": () => S.closeFocused(),
  "pane.focusLeft": () => focusNeighbor("left"),
  "pane.focusRight": () => focusNeighbor("right"),
  "pane.focusUp": () => focusNeighbor("up"),
  "pane.focusDown": () => focusNeighbor("down"),

  "sidebar.toggle": () => S.toggleSidebar(),
  "notif.panel": () => toggleNotifPanel(),
  "notif.latestUnread": () => toggleLatestUnread(),

  "app.settings": () => S.setView(state.view === "settings" ? "workspace" : "settings"),
  "settings.shortcuts": () => openSettingsSection("shortcuts"),

  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
    `ws.select${n}`,
    () => { const w = state.workspaces[n - 1]; if (w) S.setActive(w.id); },
  ])),
});

// ── 단축키 배선 ──
//  조합 → 명령 id → 동작. 표는 commands.js, 사용자가 바꾼 값은 shortcuts.js 가 들고 있다.
//  ★ 팔레트가 떠 있으면 아무것도 가로채지 않는다 — 팔레트 입력창에서 ⌘W 를 치면 pane 이 닫히는
//    식의 사고를 막는다(팔레트는 자기 키를 스스로 처리한다).
window.addEventListener("keydown", (e) => {
  if (isPaletteOpen()) return;
  const combo = comboOf(e);
  if (!combo) return;
  const id = commandForCombo(bindings(), combo);
  if (!id) return;
  // 처리할 수 있을 때만 기본 동작을 막는다. 못 쓰는 상황에서 preventDefault 만 하면
  //  "브라우저 기본 동작도 안 되고 우리 동작도 안 되는" 죽은 키가 된다.
  if (runCommand(id)) e.preventDefault();
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
  const SEL = ".bootstrap-gate, .settings-modal:not(.hidden), .ag-sheet, .pv-menu, .pv-suggest, .wv-sheet-overlay, .notif-panel:not(.hidden), .ctx-menu, .fd-menu:not(.hidden), .login-gate:not(.hidden), .quit-guard-backdrop, .drag-overlay, .approval-card, body.tab-dragging, body.resizing-col, body.resizing-row, body.os-dragging";
  let cur = null;
  setInterval(() => {
    const on = !!document.querySelector(SEL);
    // win32 프리뷰(B2 preview_win)가 아직 없는 빌드에서도 폴링이 콘솔 오류를 쏟지 않게 삼킨다.
    if (on !== cur) { cur = on; Promise.resolve(api.previewShield(on)).catch(() => {}); }
  }, 80);
}

// 설치본이 오래됐어도 로그인 여부와 관계없이 다른 초기 데이터보다 먼저 최신판으로 맞춘다.
// 앱 번들을 지워도 ~/.codingpt/daemon.json 은 남으므로 재설치 직후 paired=true 일 수 있다.
// 여기서 paired 를 업데이트 생략 조건으로 쓰면 바로 그 재설치 사용자가 구버전에 고정된다.
// 네트워크/업데이트 서버 장애만 현재 버전으로 계속 진행하고, 업데이트가 있으면 본 화면을 열기 전에
// 다운로드·설치·재시작까지 완료한다.
async function maybeInstallSetupUpdate() {
  setBootstrap(i18n.t('최신 버전을 확인하는 중'), 18);
  let result;
  try {
    result = await api.updateCheck();
  } catch (_) {
    return;
  }
  if (!result?.available) return;
  setBootstrap(`CodingPT ${result.version} 다운로드 중`, 22);
  showSetupUpdate(result.version);
  let unlisten = null;
  try {
    unlisten = await api.onUpdateProgress((payload) => {
      updateSetupProgress(payload);
      const pct = payload?.total ? Math.min(100, Math.round((payload.chunk / payload.total) * 100)) : null;
      setBootstrap(
        pct == null ? `CodingPT ${result.version} 다운로드 중` : `CodingPT ${result.version} 다운로드 중 · ${pct}%`,
        pct == null ? 22 : 22 + (pct * 0.62),
      );
    });
    await api.updateInstall(); // 성공하면 네이티브가 앱을 재시작한다.
  } catch (_) {
    hideSetupUpdate(); // 오프라인·검증 실패 시 현재 버전으로 계속 진행
  } finally {
    unlisten?.();
  }
}

(async function init() {
  setBootstrap(i18n.t('앱 설정을 불러오는 중'), 7);
  // DMG 재설치 시 WebKit 저장소 위치를 네이티브가 추측해 지우지 않는다. 웹뷰가 자기 설치 단위
  // 온보딩 키만 직접 정리한다(테마 등 일반 설정과 서버 작업 공간은 보존).
  const resetOnboarding = await api.consumeInstallOnboardingReset().catch(() => false);
  if (resetOnboarding) resetOnboardingForInstall();
  await S.restorePersisted();
  setBootstrap(i18n.t('PC 연결 상태를 확인하는 중'), 13);
  state.daemon = await api.daemonStatus().catch(() => null);
  state.paired = !!state.daemon?.paired;
  await maybeInstallSetupUpdate();

  setBootstrap(i18n.t('계정과 작업 공간을 불러오는 중'), 38);
  await Promise.allSettled([S.loadWorkspaces(), S.loadMe()]);
  setBootstrap(i18n.t('연결된 기기와 알림을 불러오는 중'), 64);
  await Promise.allSettled([S.loadDevices(), S.loadNotifications(), S.loadApprovals()]);
  setBootstrap(i18n.t('권한과 보안 상태를 확인하는 중'), 82);
  await api.notifPermissionState().catch(() => null); // 권한 요청 없이 현재 OS 상태만 읽는다.

  const setupPending = restorePendingSetup();
  await S.reconcileWorkspaceHosts(); // 무귀속 로컬 워크스페이스를 이 호스트로 백필
  startUiChannel(); // UI 실시간 채널(WS) — 알림/승인/채팅 이벤트 수신
  startE2ee(); // 종단간 암호화 상태(데몬 위임) — 실패해도 부팅/기능에 영향 없음(평문 폴백)
  startPreviewShieldWatch(); // punch-through: DOM 오버레이 열림 동안 프리뷰 이벤트 포워딩 차단
  initOsDrop(); // OS 파일 드래그앤드랍 → 터미널 pane 경로 삽입
  initQuitGuard(); // 미저장 IDE 변경이 있을 때 앱 종료(Cmd+Q·트레이) 확인 다이얼로그
  setBootstrap(i18n.t('화면을 준비하는 중'), 94);
  render();
  refreshWsMeta();
  finishBootstrap();
  // 첫 실행 1스텝: "이 PC 에서 찾은 에이전트 — 연동할까요?" (한 번만, 데몬이 기록).
  //  페어링 전이면 묻지 않는다(설정 저장 대상이 daemon.json 이라 페어링이 선행돼야 한다).
  if (state.paired && !setupPending) maybeShowOnboarding().catch(() => {});

  // 백그라운드 폴링: 데몬 상태 / 워크스페이스 메타(브랜치·포트).
  setInterval(async () => {
    const prev = JSON.stringify(state.daemon);
    state.daemon = await api.daemonStatus().catch(() => state.daemon);
    if (JSON.stringify(state.daemon) !== prev) S.emit();
  }, 4000);
  setInterval(() => refreshWsMeta(), 15000);
  // 신선도(미커밋/미푸시)·타 호스트 브랜치는 서버 메타에 실림 — 목록을 주기 재로드해 배지 갱신.
  setInterval(() => { S.loadWorkspaces().catch(() => {}); }, 60000);

  // 켜져 있는 동안의 자동 업데이트. 부팅 확인(maybeInstallSetupUpdate)은 위에서 이미 했고,
  //  여기서부터는 "며칠씩 안 끄는 PC" 를 맡는다 — 주기 확인 → 사전 다운로드 → 조용한 순간에 적용.
  startUpdateScheduler(renderUpdateBanner);
})();

// 업데이트 준비 배너 — **누군가 쓰고 있을 때만** 나온다(조용하면 묻지 않고 적용).
//  문구에 "작업은 그대로 유지" 를 넣는 것이 핵심이다: tmux 가 세션을 들고 있어 재시작해도
//  터미널·에이전트가 죽지 않는다(실측). 이 사실을 안 알리면 사용자는 영원히 미룬다.
function renderUpdateBanner(info) {
  const el = document.getElementById("updateBanner");
  if (!el) return;
  if (!info) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="ub-title">업데이트 준비됨 · ${info.version}</div>
    <div class="ub-body">${i18n.t('지금 적용하면 약 20초 연결이 끊겨요.')} <b>${i18n.t('하던 터미널 작업은 그대로 유지')}</b>${i18n.t('됩니다.')}</div>
    <div class="ub-row">
      <button id="ubLater">${i18n.t('나중에')}</button>
      <button id="ubNow" class="primary">${i18n.t('지금 적용')}</button>
    </div>`;
  el.classList.remove("hidden");
  el.querySelector("#ubLater").onclick = () => deferApply();
  el.querySelector("#ubNow").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = i18n.t('적용 중…');
    try { await applyNow(); } catch (err) {
      btn.disabled = false;
      btn.textContent = i18n.t('지금 적용');
      el.querySelector(".ub-body").textContent = i18n.t('적용 실패: ') + err;
    }
  };
}
