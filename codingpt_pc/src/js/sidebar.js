// sidebar.js — 좌측: 상단 컨트롤(사이드바 토글·알림·새 워크스페이스) + 워크스페이스 목록 + 하단 내 정보.
import { state, isLocal } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { getPane, stripAgentGlyph } from "./pane.js";
import { renderNotifPanel, jumpLatestUnread } from "./notifications.js";
import { openNewWorkspace } from "./folder-picker.js";
import lan from "./lan.js";
import { tasksIcon, dashboard, dashboardRows, scopedDashboard, needsInputPerHost, agentName, openTasksDashboard, openRunTerminal, findTask } from "./tasks-view.js";
import { buildSidebarTasks } from "./sidebar-tasks.js";
import { isLocalHostId, hostHasTasks, serverHasTasks } from "./tasks-api.js";
import { taskNotifTarget, autoNotifTarget, pcNotifTarget } from "./notifications.js";
import { autoAttentionCount, openAutomations } from "./automations-view.js";
import { hostHasAuto, hostAwake } from "./automations-api.js";
import { at } from "./text/automations.js";
import { tt } from "./text/tasks.js";
import { runsForCwd, noteFor, visibleWorkers, attentionCount, sessionTree, shortAgo, inWorktree, worktreeGroups } from "./orch-model.js";
import { agentGlyphHtml } from "./agent-glyph.js";
import { openIssues, issuesOpenCount, issuesProviders } from "./issues-view.js";
import { orchSnapshot, openOrchSheet, openWorkerTerminal } from "./orch-view.js";
import { ot, wsStatusText } from "./text/orch.js";
import * as i18n from './i18n/index.js';
import { openVm, leaveVmScope, vmOsOfPath, vmLabel, openImportMenu } from "./vm-view.js";

let el = null;
let notifPanel = null;
let notifOpen = false;

// 사이드바 폭 — 우측 테두리 드래그로 조절, localStorage 영속(기본 264, 200~420 클램프).
const SB_MIN = 200, SB_MAX = 420;
function applySbWidth(w) {
  const v = Math.max(SB_MIN, Math.min(SB_MAX, Math.round(w)));
  document.documentElement.style.setProperty("--sb-w", v + "px");
  return v;
}
let sbGrip = null; // updateSidebar 가 innerHTML 을 비워도 재부착할 수 있게 모듈 보관
function mountSbResizer() {
  const saved = parseInt(localStorage.getItem("cpt:sbW") || "", 10);
  if (saved) applySbWidth(saved);
  const grip = document.createElement("div");
  sbGrip = grip;
  grip.className = "sb-resizer";
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("resizing-col");
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    let cur = startW;
    const move = (ev) => { cur = applySbWidth(startW + (ev.clientX - startX)); };
    const up = () => {
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing-col");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      try { localStorage.setItem("cpt:sbW", String(Math.round(cur))); } catch (_) {}
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  el.appendChild(grip);
}

export function mountSidebar(container) {
  el = container;
  el.className = "sidebar";
  mountSbResizer();
  // LAN 직결 경로 변화 시 배지만 갱신(경로 상태는 호스트 온/오프라인과 무관 — 오프라인 UX 무간섭).
  lan.onLanChange(() => updateSidebar());
  startLanBadgePoll();
  notifPanel = document.createElement("div");
  notifPanel.className = "notif-panel hidden";
  document.body.appendChild(notifPanel);
  document.addEventListener("mousedown", (e) => {
    if (notifOpen && !notifPanel.contains(e.target) && !e.target.closest?.(".bell")) closeNotif();
  });
}

// "직결" 배지 폴링 — 경로 상태의 소유자는 데몬이므로 PC 는 물어보기만 한다(캐시 10s·쿨다운·미지원
//  휴면·승격 probe 는 전부 lan.js 안에 있고, 여기서는 **대상 고르기**만 한다).
//  ★ 실패는 전부 무음이다: 배지가 안 뜨는 것 말고 어떤 UX 도 바뀌지 않는다(lan.js 헤더 규율).
//  ★ 다른 PC(원격 호스트)만 대상이다 — 이 PC 자신의 워크스페이스는 로컬 fsapi/tmux 직결이라 LAN 무의미.
//  ★ 오프라인 호스트에는 쏘지 않는다(온/오프라인 판정은 기존 hostOnline 이 단독으로 한다).
let lanPollTimer = null;
function startLanBadgePoll() {
  if (lanPollTimer) return;
  const tick = () => {
    if (!state.paired) return;
    if (typeof document !== "undefined" && document.hidden) return; // 창이 안 보이면 IPC 낭비 금지
    const seen = new Set();
    for (const w of state.workspaces || []) {
      if (!isLocal(w) || S.isThisHost(w) || w.hostOnline === false) continue;
      const hid = Number(w.hostDeviceId);
      if (!Number.isFinite(hid) || seen.has(hid)) continue;
      seen.add(hid);
      void lan.refreshStatus(hid);
    }
  };
  lanPollTimer = setInterval(tick, 10000);
  tick();
}

export function jumpToNotification(n) {
  // Agent Tasks 알림(task_ready·task_merged·task_failed) — cwd/win 라우팅 대신 현황판의 그 작업 상세로(§4).
  //  작업 워크스페이스는 사이드바에 없는 곳이라 cwd 로 열면 "어디 있는지 모르는" 화면이 된다.
  const tgt = taskNotifTarget(n);
  if (tgt) {
    openTasksDashboard(tgt);
    closeNotif();
    return;
  }
  // 자동화 알림(auto_created·auto_failed·auto_paused·auto_notify) → 그 PC 의 자동화 장소, 그 항목(§5.8).
  const atgt = autoNotifTarget(n);
  if (atgt) {
    openAutomations(atgt);
    closeNotif();
    return;
  }
  // PC 잠자기·끊김(pc_sleeping·pc_disconnected) → 그 PC 의 진행 현황(§6.5 deeplink codingpt://tasks?host=).
  const ptgt = pcNotifTarget(n);
  if (ptgt) {
    openTasksDashboard(ptgt);
    closeNotif();
    return;
  }
  // 채팅 v2 알림(conv_request·conv_done·conv_error) — threadId 가 있으면 터미널이 아니라 **그 대화의 채팅 탭**이다
  //  (chat-v2-design §7). 이미 열려 있으면 그 탭으로 가고, 없으면 연다.
  if (n && n.threadId) {
    const ws =
      state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId)) ||
      (n.cwd ? state.workspaces.find((w) => w.localPath === n.cwd
        && (n.hostDeviceId == null || w.hostDeviceId == null || Number(w.hostDeviceId) === Number(n.hostDeviceId))) : null);
    if (ws) S.setActive(ws.id, { allowTask: true });
    closeNotif();
    // 워크스페이스를 방금 바꿨으면 pane 이 아직 없다 — 한 프레임 뒤에 연다.
    requestAnimationFrame(() => {
      import("./workspace-view.js").then((m) => m.openConvTab(String(n.threadId), "")).catch(() => {});
    });
    return;
  }
  // 기기 승인 알림(기능2)은 워크스페이스가 없다 — 설정>계정(종단간 암호화 카드)이 목적지다.
  if (n && n.kind === "device_approval") {
    import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings"));
    return;
  }
  //  에이전트 PC 개입 요청 — 그 워크스페이스에 데스크톱 탭을 띄운다(처리 후 탭의 [계속]).
  if (n && n.kind === "desktop_handoff") {
    const ws = state.workspaces.find((w) => w.localPath === n.cwd) || state.workspaces.find((w) => w.id === state.activeWsId);
    if (ws) {
      import("./ui-channel.js").then((m) => m.runUiCommandLocal("emulatorOpen", { ws: ws.localPath, device: "desktop:main" })).catch(() => {});
    }
    closeNotif();
    return;
  }
  // 대상 워크스페이스 활성화 — 서버 행(workspaceId → cwd 매칭) 우선, 로컬 폴백(wsId)도 지원.
  const ws =
    state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId)) ||
    (n.cwd ? state.workspaces.find((w) => w.localPath === n.cwd) : null);
  // 작업 run 터미널의 일반 에이전트 알림(입력 대기·권한·유휴) — setActive 는 작업 워크스페이스를 거부하므로
  //  (allowTask 없이) 그대로 두면 아무것도 안 열리거나 **지금 활성 워크스페이스의 같은 win** 을 잘못 짚는다.
  //  현황판 카드와 같은 경로(openRunTerminal, task:true)로 그 터미널을 연다.
  if (ws && S.isTaskWorkspace(ws)) {
    closeNotif();
    void openRunTerminal(ws.id, n.win != null ? Number(n.win) : null, { task: true }).then((ok) => {
      if (ok && n.cwd && n.win != null) S.readScope(n.cwd, Number(n.win));
    });
    return;
  }
  if (ws) S.setActive(ws.id);
  // 발생한 터미널(win)을 보여주는 leaf 로 점프 — 다른 pane 탭에 숨어 있으면 그 탭으로 전환.
  const rt = S.wsRuntime(state.activeWsId);
  if (rt && rt.layout && n.win != null) {
    let hit = null;
    T.eachLeaf(rt.layout, (l) => {
      if (!hit && l.kind === "terminal" && (l.tabs || []).some((t) => typeof t.win === "number" && t.win === Number(n.win))) hit = l;
    });
    if (hit) {
      const idx = hit.tabs.findIndex((t) => typeof t.win === "number" && t.win === Number(n.win));
      if (idx >= 0 && idx !== hit.active) getPane(hit.id)?.switchTab(idx);
      S.focusPane(hit.id);
      // 알림을 눌러 그 터미널로 왔다 = 사용자가 그 터미널을 봤다 → 그 터미널의 미읽음을 **전부**
      //  읽음 처리한다. 누른 한 건만 읽음으로 두면(readOne) 같은 터미널의 나머지 미읽음이 남아
      //  강조 테두리가 그대로다 — 사용자에겐 "눌렀는데 안 없어진다"로 보인다(2026-08-14).
      if (n.cwd) S.readScope(n.cwd, Number(n.win));
    }
  } else if (n.paneId) {
    S.focusPane(n.paneId); // 로컬 폴백 알림(구 형식)
  }
  closeNotif();
}
export function toggleLatestUnread() {
  jumpLatestUnread((n) => jumpToNotification(n));
}

/** 알림 패널 열고/닫기 — 명령 팔레트(notif.panel)가 벨 클릭과 같은 길을 타게 한다. */
export function toggleNotifPanel() {
  if (!notifPanel) return;
  notifOpen ? closeNotif() : openNotif();
}

// 알림 패널 — punch-through(프리뷰=아래층) 덕에 평범한 DOM 으로 프리뷰 위에 뜬다.
function openNotif() {
  notifOpen = true;
  notifPanel.classList.remove("hidden");
  renderNotifPanel(notifPanel, (n) => jumpToNotification(n));
  // 접힘 시 bell 은 메인 상단바에 있으므로 화면에 보이는 bell 을 기준으로 위치.
  const bell = [...document.querySelectorAll(".bell")].find((b) => b.offsetParent !== null) || el.querySelector(".bell");
  if (bell) {
    const r = bell.getBoundingClientRect();
    notifPanel.style.left = r.left + "px";
    notifPanel.style.top = r.bottom + 6 + "px";
  }
}
function closeNotif() {
  notifOpen = false;
  notifPanel.classList.add("hidden");
}

// 직전 렌더의 내용 시그니처 — 화면에 나가는 값이 그대로면 DOM 재구축을 통째로 건너뛴다.
//  (emit 은 agent_state·리컨실러 등으로 수시로 오는데, 사이드바는 매번 아바타 <img> 까지 새로
//   만들고 있었다 — 2026-08-15 성능 라운드. 여기 없는 값을 행 렌더에 새로 쓰면 반드시 추가할 것.)
let sbSig = "";
// 이번 렌더의 저장소 트리 파생(§2) — 시그니처 계산과 행 렌더가 같은 값을 쓴다(모델 1회 계산).
let sbTree = { groups: {} };
let sbTasksN = 0;
let sbNeedsByHost = {}; // host → 입력 대기 수(PC 행 배지)
export function updateSidebar() {
  if (!el) return;
  const totalUnread = state.notifications.filter((n) => !n.read).length;
  {
    const devices0 = S.pcDevices();
    const activeDev0 = S.activeDeviceId();
    const wss0 = devices0.length ? S.workspacesForDevice(activeDev0) : [];
    computeTree(activeDev0, wss0);
    const tasksN = sbTasksN;
    const autoN = autoAttentionCount();
    const sig = JSON.stringify([
      tasksN, autoN, issuesOpenCount(activeDev0), issuesProviders(activeDev0).join(),
      state.vmScope || "", JSON.stringify(vmPhase),
      state.sidebarCollapsed, state.view, state.activeWsId, !!state.wsStale, state.paired,
      !!state.daemon?.running, state.daemon?.device_name, state.creatingWs, totalUnread,
      state.me?.nickname, state.me?.email, state.me?.profileImg,
      notifOpen, state.notifications.length, state.notifications[0]?.id, state.notifications[0]?.read,
      activeDev0,
      devices0.map((d) => [d.id, d.name, d.online, S.workspacesForDevice(d.id).reduce((n, w) => n + S.unreadForWs(w), 0), sbNeedsByHost[d.id] || 0, hostAwake(d.id)]),
      wss0.map((w) => {
        const rt = S.wsRuntime(w.id);
        const st = w.localPath ? S.wsStatus.get(w.localPath) : null;
        const g = sbTree.groups[w.id];
        return [w.id, S.wsDisplayName(w), S.unreadForWs(w), S.wsPinned(w.id), S.wsColor(w.id),
          w.hostOnline, wsMissing(w), w.localPath, st?.status?.[0]?.value, st?.progress,
          (rt?.ports || []).slice(0, 3),
          // 저장소 트리(agent-tasks-sidebar.md §3.1) — 여기 없는 값은 화면에 반영되지 않는다.
          groupCollapsed(w.id), w.git?.branch || "", S.wsTerminalCount(w.id),
          g ? g.openCount : 0, g ? g.needsInput : false,
          // 오케스트레이션(묶음·워커·한 줄 메모) — 여기 없는 값은 화면에 반영되지 않는다.
          orchSig(activeDev0, w),
          (g ? g.tasks : []).map((t) => [t.taskId, t.title, t.group, t.dot, t.sub.key, t.sub.diff?.a, t.sub.diff?.d,
            t.fanout, fanExpanded.has(t.taskId), t.runs.map((r) => [r.runId, r.group, r.dot, r.agent, r.branch, r.workspaceId || null, r.tid || null])])];
      }),
    ]);
    if (sig === sbSig) return;
    sbSig = sig;
  }
  // 재구축은 목록(스크롤 컨테이너)을 새로 만든다 — 스크롤 위치와 키보드 포커스를 옮겨 심지 않으면
  //  그룹 토글·작업 상태 변화마다 맨 위로 튀고(더블클릭 두 번째 클릭이 엉뚱한 행에 떨어진다) 포커스가 사라진다.
  const prevScroll = el.querySelector(".sb-list")?.scrollTop || 0;
  const focusSel = focusKey(el);
  el.innerHTML = "";
  if (sbGrip) el.appendChild(sbGrip); // 리사이즈 핸들 재부착(innerHTML 초기화로 떨어짐)

  // 상단 컨트롤(트래픽 라이트 여백 + 토글/알림/추가). 드래그 영역.
  const top = document.createElement("div");
  top.className = "sb-top";
  top.setAttribute("data-tauri-drag-region", "");
  top.append(buildTopControls());
  el.appendChild(top);

  // 목록.
  const list = document.createElement("div");
  list.className = "sb-list";
  // 맨 위에서 아래로 당김(오버스크롤) → 워크스페이스 목록 새로고침(pull-to-refresh).
  attachPullToRefresh(list);

  // 서버 미가용 — 목록은 로컬 캐시(last-known)다. 이 PC 폴더 작업은 그대로 되지만 서버가 원천인
  //  조작(추가/삭제)과 다른 기기 진입은 막혀 있다는 것을 한 줄로 알린다(오프라인 톤, 위험색 금지).
  if (state.wsStale) list.appendChild(note(i18n.t('오프라인 — 마지막으로 본 목록')));

  // ── ① 내 PC (2026-08-14 기기 우선 개편) ────────────────────────────────
  //  예전엔 프로젝트(projectId) 묶음이 위, 그 안에 기기별 사본이 있었다. 사용자 지적: "이해도 안
  //  가고 사용성도 안 좋다". 실제 소유 관계는 반대다 — 워크스페이스는 **그 PC 의 로컬 폴더**다.
  //  그래서 PC 를 먼저 고르고, 고른 PC 의 워크스페이스만 아래에 그린다.
  const devices = S.pcDevices();
  const activeDev = S.activeDeviceId();
  // 새 PC 는 이 화면에서 만들 수 없다(그 PC 에 앱을 깔고 로그인해야 나타난다) → + 버튼 없음.
  //  ★ `PC 연결하기` 안내도 뺐다(2026-08-14 사용자 확정: "PC 에서는 필요 없을 것 같다") —
  //   PC 앱을 쓰고 있다는 것 자체가 이미 그 방법을 아는 것이다. 폰에서는 그 안내가 여전히 필요해
  //   앱(SidebarContent) 쪽에는 남겨 둔다.
  list.appendChild(sectionHead(i18n.t('내 PC'), [
    { icon: icons.sliders({ size: 15 }), label: i18n.t('기기 관리'), onClick: () => import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings")) },
    { icon: icons.apple({ size: 15 }), label: "macOS - VM…", onClick: () => import("./desktop-sheet.js").then((m) => m.openDesktopSheet("macos")).catch(() => {}) },
    { icon: icons.linux({ size: 15 }), label: "Linux - VM…", onClick: () => import("./desktop-sheet.js").then((m) => m.openDesktopSheet("linux")).catch(() => {}) },
    // 고른 PC 의 깨어 있기 설정(automation-design §6.6) — PC 행 우클릭 메뉴와 같은 시트.
    ...(activeDev != null ? [{ icon: icons.gear({ size: 15 }), label: at("pcSettings"), onClick: () => openPcSettings(activeDev) }] : []),
  ]));
  if (!devices.length) {
    list.appendChild(note(state.paired ? i18n.t('불러오는 중…') : i18n.t('PC를 연결하세요')));
  }
  for (const d of devices) {
    list.appendChild(deviceRow(d, activeDev));
    // 이 PC 에 만들어 둔 에이전트 PC(VM) — PC 의 하위 항목(2026-10-04 QA: 워크스페이스 아래 작업처럼). 누르면 그 화면을 연다.
    if (isLocalHostId(state, d.id)) { for (const os of VM_KINDS) if (vmPhase[os]) list.appendChild(vmRow(os)); refreshVms(); }
  }

  // ── ①-1 고른 PC 의 `진행 현황` — 진행 현황은 **PC 안의 장소**다(2026-09-29 사용자 확정: 에이전트는
  //  그 PC 에서 돈다). 예전엔 "내 PC" 위에서 모든 PC 를 합쳐 셌고, 누르면 켜고/끄는 버튼이었다.
  //  이제 워크스페이스 행처럼 "들어가는 곳" — 선택 배경은 들어가 있는 곳 하나에만.
  if (devices.length) {
    const dn = devices.find((d) => String(d.id) === String(activeDev));
    const devHead = sectionHead(state.vmScope ? vmLabel(state.vmScope) : ((dn && dn.name) || i18n.t('내 PC')), null);
    devHead.classList.add("sb-sec-dev"); // PC 이름은 고유명사 — 대문자 변환 없이, 위 PC 목록과는 선으로 가른다
    if (state.vmScope) {
      // VM 을 고른 상태 — 이 아래는 그 VM 의 것(화면·VM 워크스페이스). 진행 현황·자동화는 호스트의 것이라 여기서는 뺀다.
      list.appendChild(devHead);
      list.appendChild(vmScreenRow(state.vmScope));
    } else {
      list.appendChild(issuesRow());   // 이슈 장소 — 이 PC 의 할 일(자체 이슈 + 연결된 외부 서비스)
    }
    // `진행 현황`·`자동화` 행은 사이드바에서 뺐다(2026-10-06 사용자 결정) — 워크스페이스 아래 에이전트·작업 행이 같은 것을 말한다.
    //  장소 자체는 남아 있다: 작업 행을 누르면 그 상세가 열리고, 단축키·팔레트(tasks.dashboard · automations.open)와 알림도 그리로 간다.
    //  그 아래 둘 것이 없으니 PC 이름 머리도 그리지 않는다(위 PC 목록이 이미 말한다).
  }

  // ── ② 선택한 PC 의 워크스페이스 ───────────────────────────────────────
  //  VM 워크스페이스(~/.codingpt/vm/<os>/ws/…)는 그 VM 을 골랐을 때만, 호스트 워크스페이스는 호스트일 때만.
  const wss = (devices.length ? S.workspacesForDevice(activeDev) : []).filter((w) => (vmOsOfPath(w.localPath) || "") === (state.vmScope || ""));
  //  ★ [+] 와 ⋯ 을 함께 두지 않는다(2026-08-14 사용자 확정) — 둘 다 "워크스페이스 추가" 하나를
  //   가리켜서, 같은 일을 하는 버튼이 나란히 두 개 있는 꼴이었다. ⋯ 하나로 통일한다.
  list.appendChild(sectionHead(i18n.t('워크스페이스'), [
    state.vmScope
      ? { icon: icons.plus({ size: 14 }), label: i18n.t('워크스페이스 가져오기'), onClick: () => { const r = el.querySelector(".sb-list")?.getBoundingClientRect(); openImportMenu((r ? r.left : 0) + 24, (r ? r.top : 0) + 160, state.vmScope); } }
      : { icon: icons.plus({ size: 14 }), label: i18n.t('워크스페이스 추가'), onClick: () => startNewWorkspace(activeDev) },
  ]));
  if (state.vmScope && !wss.length) list.appendChild(note(i18n.t('+ 로 이 PC 의 워크스페이스를 VM 으로 가져오세요')));
  else if (devices.length && !wss.length) {
    if (state.wsError && !state.workspaces.length) list.appendChild(note(i18n.t('목록을 불러오지 못했습니다')));
    else list.appendChild(note(i18n.t('+ 로 이 PC의 폴더를 추가하세요')));
  }
  for (const w of wss) list.appendChild(wsGroup(w, sbTree.groups[w.id] || null));
  el.appendChild(list);
  if (prevScroll) list.scrollTop = prevScroll;
  if (focusSel) { try { list.querySelector(focusSel)?.focus({ preventScroll: true }); } catch (_) {} }

  // 하단: 내 정보.
  const online = state.daemon?.running && state.daemon?.paired;
  const foot = document.createElement("button");
  foot.className = "sb-me" + (state.view === "settings" ? " active" : "");
  const me = state.me;
  const av = document.createElement("span");
  av.className = "me-avatar";
  av.innerHTML = me?.profileImg
    ? `<img class="me-img" src="${escapeHtml(me.profileImg)}" alt="" />`
    : me?.nickname
      ? `<span class="me-initial">${escapeHtml((me.nickname || me.email || "U").trim().charAt(0).toUpperCase())}</span>`
      : icons.user({ size: 16 });
  const txt = document.createElement("span");
  txt.className = "me-text";
  const name = me?.nickname || i18n.t('내 정보');
  const sub = me
    ? me.email || state.daemon?.device_name || i18n.t('로그인됨')
    : state.daemon?.device_name || (state.paired ? i18n.t('연결됨') : i18n.t('로그인 필요'));
  txt.innerHTML = `<span class="me-name">${escapeHtml(name)}</span><span class="me-sub">${escapeHtml(sub)}</span>`;
  foot.append(av, txt);
  foot.addEventListener("click", () => S.setView(state.view === "settings" ? "workspace" : "settings"));
  el.appendChild(foot);

  if (notifOpen) renderNotifPanel(notifPanel, (n) => jumpToNotification(n));
}

// pull-to-refresh — 목록 맨 위에서 "잡고 아래로 당김"(마우스 드래그) 또는 트랙패드 오버스크롤 → 새로고침.
//  당기는 양만큼 상단 인디케이터가 커지고, 임계값을 넘겨 놓으면 loadWorkspaces() 실행.
let __ptrBusy = false;
function attachPullToRefresh(list) {
  const THRESH = 56;
  let pull = 0;

  // 상단 인디케이터(당길수록 높이가 커지며 내용을 밀어냄).
  const ind = document.createElement("div");
  ind.className = "ptr-indicator";
  ind.style.cssText =
    "height:0px;overflow:hidden;display:flex;align-items:center;justify-content:center;" +
    "font-size:11px;color:var(--dim);opacity:0;transition:height var(--dur-1) var(--ease-out),opacity var(--dur-1) var(--ease-out);user-select:none;";
  list.prepend(ind);

  const render = () => {
    const v = Math.min(pull, 96);
    if (__ptrBusy) return;
    ind.style.height = v > 3 ? Math.min(6 + v * 0.5, 44) + "px" : "0px";
    ind.style.opacity = v > 3 ? "1" : "0";
    ind.textContent = pull >= THRESH ? i18n.t('놓으면 새로고침 ↑') : i18n.t('당겨서 새로고침 ↓');
  };
  const reset = () => { pull = 0; render(); };
  const fire = () => {
    if (pull >= THRESH && !__ptrBusy) {
      __ptrBusy = true;
      ind.style.height = "30px";
      ind.style.opacity = "1";
      ind.textContent = i18n.t('새로고침 중…');
      // ★ 끝나면 **여기서** 인디케이터를 접는다(2026-09-16 사용자 신고 "새로고침 중… 이 계속 남는다").
      //  예전엔 loadWorkspaces → emit → updateSidebar 의 재렌더가 DOM 을 통째로 갈아 끼우며 지워 주길 기대했는데,
      //  updateSidebar 는 서명(sig)이 같으면 재렌더를 건너뛴다 — 새로고침 결과가 "그대로" 인 가장 흔한 경우에
      //  정확히 아무도 안 지워서 문구가 영구히 남았다. 실패했으면 그 사실도 잠깐 보여 준다(조용히 사라지면
      //  "됐나?" 를 알 수 없다).
      const t0 = Date.now();
      Promise.resolve(S.loadWorkspaces()).finally(() => {
        const failed = !!state.wsError;
        const hold = Math.max(0, 400 - (Date.now() - t0));   // 너무 빨리 끝나도 문구가 깜빡이지 않게 최소 400ms
        setTimeout(() => {
          if (failed) ind.textContent = i18n.t('새로고침 실패');
          setTimeout(() => { __ptrBusy = false; reset(); }, failed ? 1200 : 0);
        }, hold);
      });
    } else {
      reset();
    }
  };

  // 마우스로 잡고 당김.
  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || list.scrollTop > 0 || __ptrBusy) return;
    const startY = e.clientY;
    let active = true;
    const mv = (ev) => {
      if (!active) return;
      if (list.scrollTop > 0) { pull = 0; render(); return; }
      const dy = ev.clientY - startY;
      if (dy > 0) { ev.preventDefault(); pull = dy; render(); }
      else { pull = 0; render(); }
    };
    const up = () => {
      active = false;
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      fire();
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });

  // 트랙패드 오버스크롤(위로 튕김).
  let wt = null;
  list.addEventListener(
    "wheel",
    (e) => {
      if (list.scrollTop > 0 || __ptrBusy) return;
      if (e.deltaY < 0) {
        pull += -e.deltaY;
        render();
        clearTimeout(wt);
        wt = setTimeout(fire, 130);
      }
    },
    { passive: true }
  );
}

// 타이틀바 컨트롤 — cmux classic 지표와 1:1(2026-09-16, 사용자 요청 "macOS 앱 상단 버튼들과 동일하게").
//  버튼 20 · 아이콘 = SF Symbol 12pt regular 등가. 우리 24-뷰박스 아이콘은 글리프가 뷰박스의 ~73% 라
//  size 16 이면 실제 글리프 ≈ 11.7px = SF 12pt 와 같은 눈높이.
//  ⚠ 선 굵기는 뷰박스 배율을 탄다 — 24-뷰박스를 16px 로 그리면 실제 선 = sw × 16/24. SF regular(≈1.1px)를
//   노리면 sw 1.6 이다. 1.3 을 줬던 0.1.329 는 실제 0.87px 짜리 실선이 돼 신호등 옆에서 흐릿했다(사용자 비교 스크린샷).
//  (styles.css `.sb-top .ic-btn` 이 상자·간격·호버를 같은 지표로 고정한다.)
const TITLEBAR_ICON = { size: 16, sw: 1.6 };
function ctlBtn(iconName, title, onClick) {
  const b = document.createElement("button");
  b.className = "ic-btn";
  b.title = title;
  b.innerHTML = icons[iconName](TITLEBAR_ICON);
  b.addEventListener("click", onClick);
  return b;
}

// 상단 컨트롤(토글·알림·추가) — 사이드바 상단바 + 접힘 시 메인 상단바에서 공용 사용(정합성).
//  withAdd=false: 접힘 시 이식되는 축약판 — 워크스페이스 추가(+)는 사이드바를 열어야 보인다.
// ★ 2026-08-14: `withAdd` 는 **더 이상 아무것도 하지 않는다**(사용자 확정으로 상단 + 제거).
//  워크스페이스 추가는 사이드바 안의 `워크스페이스` 섹션 머리에 산다 — 무엇을 어디에 만드는지가
//  그 자리에서 드러난다(옛 상단 + 는 "어느 PC 에?" 를 매번 다시 물어야 했다).
//  인자를 남겨 둔 이유는 접힌 사이드바의 상단바(main-top)가 같은 함수를 부르기 때문이다.
export function buildTopControls(_withAdd = true) {
  const frag = document.createDocumentFragment();
  const totalUnread = state.notifications.filter((n) => !n.read).length;
  // 글리프는 열림/닫힘 양쪽 같다(cmux 와 동일 — 사이드바가 보이느냐 자체가 상태다). 예전의 채움/빈 아이콘
  //  구분은 2026-09-16 cmux 1:1 정렬로 뺐다: 채운 글리프가 이웃 아이콘보다 무거워 줄이 고르지 않았다.
  const toggle = ctlBtn("sidebarTitlebar", state.sidebarCollapsed ? i18n.t('사이드바 펼치기') : i18n.t('사이드바 접기'), () => S.toggleSidebar());
  const bell = ctlBtn("bell", i18n.t('알림'), (e) => {
    e.stopPropagation();
    notifOpen ? closeNotif() : openNotif();
  });
  bell.classList.add("bell");
  if (totalUnread) {
    const badge = document.createElement("span");
    badge.className = "bell-badge";
    badge.textContent = totalUnread > 9 ? "9+" : String(totalUnread);
    bell.appendChild(badge);
  }
  //  작업 현황판 진입은 사이드바 행 하나로만(타이틀바 아이콘은 사용자 지시로 제거 2026-09-29 — 진입점 중복).
  frag.append(toggle, bell);
  return frag;
}

/** 사이드바 `진행 현황 [n]` 행 — 고른 PC 의 에이전트를 상태별로 보는 **장소**(워크스페이스와 같은 급).
 *  작업을 "만드는 곳" 은 워크스페이스 그룹의 `⋯` 메뉴 > 새 작업이다(agent-tasks-sidebar.md §0-1).
 *  선택(현황판이 열림)은 PC 행과 같은 배경 명암(--hover)으로만. */
function tasksRow() {
  const n = sbTasksN;
  const row = document.createElement("button");
  row.className = "pc-row tasks-row" + (state.view === "tasks" ? " active" : "");
  row.innerHTML =
    `<span class="pc-ic">${tasksIcon({ size: 15 })}</span>` +
    `<span class="pc-nm">${escapeHtml(tt("overview"))}</span>` +
    (n ? `<span class="wsr-badge">${n}</span>` : "");
  // 토글이 아니다 — 나가는 길은 다른 장소(워크스페이스 로컬 행 등)를 누르는 것(시안 확정 2026-09-29).
  row.addEventListener("click", () => { if (state.view !== "tasks") openTasksDashboard(); });
  return row;
}
/** 사이드바 `이슈 [n]` 행 — 고른 PC 의 이슈 장소. 배지 = 열린 이슈 수(목록을 한 번이라도 읽은 뒤부터). 토글이 아니다. */
function issuesRow() {
  const n = issuesOpenCount(S.activeDeviceId());
  const row = document.createElement("button");
  row.className = "pc-row issues-row" + (state.view === "issues" ? " active" : "");
  //  오른쪽 = 연결된 외부 서비스 표식(Orca 의 Tasks 행과 같다 — 무엇이 붙어 있는지 한눈에).
  const provs = issuesProviders(S.activeDeviceId());
  row.innerHTML = `<span class="pc-ic">${icons.tasksList({ size: 15 })}</span><span class="pc-nm">Tasks</span>` +
    provs.map((p) => (icons[p] ? `<span class="is-prov" title="${escapeHtml(p)}">${icons[p]({ size: 13 })}</span>` : "")).join("") + (n ? `<span class="wsr-badge">${n}</span>` : "");
  row.addEventListener("click", () => { if (state.view !== "issues") openIssues(); });
  return row;
}
/** 사이드바 `자동화 [n]` 행 — 고른 PC 의 자동화 장소(automation-design §5.9). `진행 현황` 바로 아래, 같은 장소 규칙:
 *  선택 배경은 들어가 있을 때만, 토글이 아니다(다시 눌러도 닫히지 않음). 배지 = 주의(실패·오류 일시정지) 수(error).
 *  auto.v1 이 없는 PC 는 행을 그리되 누르면 업데이트 안내(§5.9). */
function autoRow() {
  const n = autoAttentionCount();
  const row = document.createElement("button");
  row.className = "pc-row auto-row" + (state.view === "automations" ? " active" : "");
  row.innerHTML =
    `<span class="pc-ic">${icons.repeat({ size: 15 })}</span>` +
    `<span class="pc-nm">${escapeHtml(tt("automations"))}</span>` +
    (n ? `<span class="wsr-badge">${n}</span>` : "");
  row.addEventListener("click", () => {
    if (state.view === "automations") return;
    if (hostHasAuto(S.activeDeviceId()) === false) {
      import("./tasks-view.js").then((m) => m.toast(tt("pcNeedsUpdate"))).catch(() => {});
      return;
    }
    openAutomations();
  });
  return row;
}
function openPcSettings(hid) {
  import("./power-settings.js").then((m) => m.openPcSettingsSheet(hid)).catch(() => {});
}
function note(text) {
  const d = document.createElement("div");
  d.className = "sb-note";
  d.textContent = text;
  return d;
}

// ── 기기 우선 사이드바의 조각들 (2026-08-14) ────────────────────────────────
/**
 * 섹션 머리 — 제목 + ⋯ 메뉴.
 *  ★ [+] 는 두지 않는다(2026-08-14 사용자 확정: "그냥 옆에 ... 으로만 하자"). 처음엔 워크스페이스
 *   섹션에 [+] 와 ⋯ 을 나란히 뒀는데, ⋯ 안의 유일한 항목도 `워크스페이스 추가` 라서 **같은 일을
 *   하는 버튼이 두 개** 있는 꼴이었다.
 *  · 메뉴 항목은 워크스페이스 우클릭 메뉴(buildMenu)와 **같은 모양**을 쓴다 — 사이드바 안에서
 *    메뉴가 두 종류로 보이면 그건 디자인이 아니라 누락이다.
 */
function sectionHead(title, items) {
  const head = document.createElement("div");
  head.className = "sb-sec";
  const nm = document.createElement("span");
  nm.className = "sb-sec-nm";
  nm.textContent = title;
  head.appendChild(nm);
  const acts = document.createElement("span");
  acts.className = "sb-sec-acts";
  if (items && items.length) {
    const m = document.createElement("button");
    m.className = "sb-sec-btn" + (state.creatingWs && title === i18n.t('워크스페이스') ? " busy" : "");
    m.title = i18n.t('더 보기');
    m.innerHTML = icons.dots({ size: 15 });
    m.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = m.getBoundingClientRect();
      showPopupMenu(r.left, r.bottom + 4, items);
    });
    acts.appendChild(m);
  }
  head.appendChild(acts);
  return head;
}

/** PC 행 — 클릭 = 그 PC 로 전환(오프라인도 고를 수 있다: 뭘 등록해 뒀는지 볼 수 있어야 한다).
 *  ★ 상태 점은 그리지 않는다(2026-08-14 사용자 확정). 오프라인은 **행 전체가 흐려지는 것**으로 이미
 *   드러난다 — 같은 사실을 점으로 한 번 더 말하면 신호가 아니라 장식이다. */
// ── 에이전트 PC(VM) 하위 행 ──
//  만들어 둔 VM 만 그린다(이미지 없음·미지원은 행 없음 — 만들기는 `내 PC ⋯` 메뉴의 설정 시트). 상태는 15초에 한 번만 묻는다.
const VM_KINDS = ["macos", "linux"];
const VM_SHOWN = new Set(["running", "stopped", "starting", "stopping", "paused"]);
const vmPhase = { macos: null, linux: null };
let vmAskedAt = 0;
function refreshVms() {
  if (Date.now() - vmAskedAt < 15000) return;
  vmAskedAt = Date.now();
  Promise.all(VM_KINDS.map((os) => api.desktopStatus(os).then((st) => (st && VM_SHOWN.has(st.phase) ? st.phase : null)).catch(() => null)))
    .then((ph) => {
      let changed = false;
      VM_KINDS.forEach((os, i) => { if (vmPhase[os] !== ph[i]) { vmPhase[os] = ph[i]; changed = true; } });
      if (changed) updateSidebar();
    });
}
function vmScreenRow(os) {
  const row = document.createElement("button");
  row.className = "pc-row" + (state.view === "vm" ? " active" : "");
  row.innerHTML = `<span class="pc-ic">${icons.monitor({ size: 15 })}</span><span class="pc-nm">${escapeHtml(i18n.t('화면'))}</span>`;
  row.addEventListener("click", () => { if (state.view !== "vm") openVm(os); });
  return row;
}
function vmRow(os) {
  const row = document.createElement("button");
  row.className = "wsg-child pc-vm" + (state.vmScope === os ? " active" : "");
  row.dataset.os = os;
  row.innerHTML = `<span class="pc-ic">${(os === "linux" ? icons.linux : icons.apple)({ size: 14 })}</span>` +
    `<span class="pc-nm">${vmLabel(os)}</span>` +
    `<span class="emu-deskdot${vmPhase[os] === "running" ? " on" : ""}"></span>`;
  const sheet = () => import("./desktop-sheet.js").then((m) => m.openDesktopSheet(os)).catch(() => {});
  // VM 을 고르면 사이드바가 그 VM 기준으로 바뀌고 메인에 그 화면이 뜬다(vm-view.js).
  row.addEventListener("click", () => openVm(os));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showPopupMenu(e.clientX, e.clientY, [{ icon: icons.sliders({ size: 15 }), label: i18n.t('에이전트 PC 설정…'), onClick: sheet }]);
  });
  return row;
}

function deviceRow(d, activeId) {
  const on = d.online !== false;
  const sel = String(d.id) === String(activeId);
  const row = document.createElement("button");
  // ★ 고른 PC 는 배경이 아니라 체크로(2026-09-29) — 배경 명암은 "지금 들어가 있는 곳"(진행 현황·로컬 행)
  //  하나에만 쓴다. PC 는 장소가 아니라 그 아래 목록의 필터다.
  row.className = "pc-row" + (sel ? " picked" : "") + (on ? "" : " pc-off");
  row.dataset.devId = String(d.id);
  // 미읽음은 그 PC 의 워크스페이스 것을 합산한다 — 다른 PC 를 보고 있어도 "저기서 뭔가 왔다"를 안다.
  const unread = S.workspacesForDevice(d.id).reduce((n, w) => n + S.unreadForWs(w), 0);
  row.innerHTML =
    // ★ `이 PC` 라벨은 그리지 않는다(2026-08-14 사용자 확정) — 지금 이 앱이 도는 PC 라는 사실은
    //  목록에서 할 일이 없다(고르는 기준이 아니다). 이름만 남긴다.
    `<span class="pc-ic">${icons.monitor({ size: 15 })}</span>` +
    `<span class="pc-nm">${escapeHtml(d.name || i18n.t('내 PC'))}</span>` +
    // 다른 PC 에서 입력을 기다리는 에이전트 수(warn) — 고른 PC 의 수는 바로 아래 `진행 현황` 배지가 말한다.
    (!sel && sbNeedsByHost[d.id] ? `<span class="wsr-badge pc-needs">${sbNeedsByHost[d.id]}</span>` : "") +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "") +
    // 깨어 있기(잠자기 방지 층)가 지금 잡혀 있음 — 무채색 글리프(§6.6, 상태 신호지만 경고가 아니다).
    (hostAwake(d.id) ? `<span class="pc-awake" title="${escapeHtml(at("awakeNow"))}" aria-label="${escapeHtml(at("awakeNow"))}">${icons.sun({ size: 12 })}</span>` : "") +
    (sel ? `<span class="pc-check">${icons.check({ size: 15 })}</span>` : "");
  // PC 행 = 호스트 기준으로 돌아가기(VM 을 보고 있었다면 벗어난다).
  row.addEventListener("click", () => { if (state.vmScope) leaveVmScope(); if (!sel) S.setActiveDevice(d.id); });
  // PC 메뉴 — `PC 설정`(깨어 있기). 우클릭(워크스페이스 행과 같은 방식).
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showPopupMenu(e.clientX, e.clientY, [{ icon: icons.gear({ size: 15 }), label: at("pcSettings"), onClick: () => openPcSettings(d.id) }]);
  });
  return row;
}

/** 새 워크스페이스 — 고른 PC 를 대상으로 연다(다른 PC 를 보는 중이면 그 PC 의 폴더를 고른다). */
function startNewWorkspace(deviceId) {
  if (S.blockedOffline(i18n.t('워크스페이스 추가'))) return;
  openNewWorkspace({ hostDeviceId: deviceId });
}

// ── 유령(폴더 소실) 감지 ──
//  서버 신선도 플래그(w.git.missing)와, 자기 호스트(이 PC) 행은 로컬 pathExists 즉시 판정을 OR
//  (서버 보고 주기 지연 보완). 로컬 판정은 행 렌더마다 IPC 를 부르지 않도록 refreshWsMeta
//  갱신 주기(시작+15s)에만 조회해 캐시한다. 원격 PC 행은 서버 플래그만.
const localMissing = new Map(); // wsId -> true(이 PC 에 폴더 없음)
function wsMissing(w) {
  return !!w?.git?.missing || localMissing.get(w.id) === true;
}

// ── 저장소 트리(agent-tasks-sidebar.md, 2026-09-29) ─────────────────────────────
//  사용자가 "작업(worktree)" 과 "워크스페이스(폴더)" 를 구분하지 못했다 → 워크스페이스 = 그룹, 그 아래
//  첫 자식 `로컬 · <branch>`(폴더에서 직접 작업 = 예전 행 클릭) + 열린 worktree 작업 행들.
//  판정은 sidebar-tasks.js(앱과 픽스처로 교차 검증)가 하고, 여기는 입력을 모으고 그리기만 한다.
const GROUP_COLLAPSED_KEY = "cpt.sbGroupCollapsed.v1";
let collapsedGroups = null;             // { [wsId]: 1 } — 접힌 것만(기본 펼침). localStorage 영속.
const fanExpanded = new Set();          // 팬아웃을 펼친 taskId — 세션 한정(영속 X, §4)
function loadCollapsed() {
  if (collapsedGroups) return collapsedGroups;
  collapsedGroups = {};
  try {
    const v = JSON.parse(localStorage.getItem(GROUP_COLLAPSED_KEY) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) collapsedGroups = v;
  } catch (_) {}
  return collapsedGroups;
}
function groupCollapsed(wsId) { return !!loadCollapsed()[wsId]; }
/** 재구축 전 포커스가 트리 행에 있었다면 새 DOM 에서 같은 행을 찾을 선택자(없으면 null). */
function focusKey(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  const q = (v) => (window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, "\\$&"));
  if (a.classList.contains("wsg-head") && a.dataset.wsId) return `.wsg-head[data-ws-id="${q(a.dataset.wsId)}"]`;
  if (a.classList.contains("wsg-local") && a.dataset.wsLocal) return `.wsg-local[data-ws-local="${q(a.dataset.wsLocal)}"]`;
  if (a.classList.contains("wsg-wt") && a.dataset.wtKey) return `.wsg-wt[data-wt-key="${q(a.dataset.wtKey)}"]`;
  if (a.dataset.orchRun) return `.wsg-orch[data-orch-run="${q(a.dataset.orchRun)}"]`;
  if (a.dataset.dispatchId) return `.wsg-worker[data-dispatch-id="${q(a.dataset.dispatchId)}"]`;
  if (a.classList.contains("wsg-task") && a.dataset.taskId) return `.wsg-task[data-task-id="${q(a.dataset.taskId)}"]`;
  if (a.classList.contains("wsg-agent") && a.dataset.runId) return `.wsg-agent[data-run-id="${q(a.dataset.runId)}"]`;
  return null;
}
function toggleGroup(wsId) {
  const m = loadCollapsed();
  if (m[wsId]) delete m[wsId]; else m[wsId] = 1;
  try { localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify(m)); } catch (_) {}
  updateSidebar();
}
function toggleFan(taskId) {
  if (fanExpanded.has(taskId)) fanExpanded.delete(taskId); else fanExpanded.add(taskId);
  updateSidebar();
}

/** 이번 렌더의 트리 + `진행 현황` 배지 수를 계산한다(현황판 모델은 한 번만 돈다). */
function computeTree(activeDev, wss) {
  let dash = null;
  try { dash = dashboard(); } catch (_) { dash = null; }
  sbTasksN = dash ? scopedDashboard(dash).counts.needs_input : 0;
  sbNeedsByHost = dash ? needsInputPerHost(dash) : {};
  const host = Number(activeDev);
  if (!dash || !Number.isFinite(host) || host <= 0) { sbTree = { groups: {} }; return; }
  // 서버 미가용(캐시 목록) — 다른 PC 버킷은 조회할 수 없으니 이 PC 의 것만(§6).
  const bucket = state.wsStale && !isLocalHostId(state, host) ? null : state.tasks.byHost[String(host)];
  try {
    sbTree = buildSidebarTasks({
      host,
      workspaces: wss.map((w) => ({ id: w.id, localPath: w.localPath || "" })),
      tasks: (bucket && bucket.items) || [],
      rows: dashboardRows(dash),
    });
  } catch (_) { sbTree = { groups: {} }; }
}

/** 워크스페이스 열기 — 예전 wsRow 클릭 본문 그대로(로컬 행 클릭·머리 더블클릭). */
function openWs(w) {
  // 유령(폴더 소실) — 열지 않고 안내 다이얼로그(목록에서 삭제 제안)만.
  if (wsMissing(w)) { showMissingDialog(w); return; }
  // 오프라인(캐시 목록): 이 PC 것만 진입. 캐시의 hostOnline 은 옛 판정이므로 "온라인 사본 제안"
  //  흐름(=거짓 정보)을 태우지 않고, 내 PC 워크스페이스는 로컬 직결로 그냥 연다.
  if (state.wsStale) {
    if (!S.isThisHost(w)) { S.blockedOffline(i18n.t('다른 기기의 워크스페이스 열기')); return; }
    S.setActive(w.id);
    return;
  }
  // ★ 프로젝트 그룹핑 폐기(2026-08-14)로 "켜진 사본으로 갈아타기" 제안도 함께 없앴다 — 사본이라는
  //  개념 자체가 화면에서 사라졌으므로, 꺼진 PC 의 워크스페이스를 누르면 그냥 그것을 연다.
  //  (호스트가 꺼져 있다는 사실은 위 기기 행의 상태점과 이 행의 흐린 표시가 이미 말한다.)
  S.setActive(w.id);
}

// ── 에이전트 행(orchestration-design.md §10, Orca 방식) — 로컬 행 아래 "에이전트 → 맡긴 워커" ─────────────
//  한 줄 = [상태 표식][에이전트 로고] 이름 - 지금 하는 말 · 모델 · 경과 시간. 일을 시킨 에이전트가 부모, 워커가 자식이다.
//  기본은 펼침이다(지금 돌아가는 것을 숨기지 않는다) — 접은 것만 기억한다.
const orchFolded = new Set();
function toggleOrch(key) {
  if (orchFolded.has(key)) orchFolded.delete(key); else orchFolded.add(key);
  updateSidebar();
}
function orchRuns(host, w) {
  const snap = orchSnapshot(host);
  return snap && w.localPath != null ? runsForCwd(snap, w.localPath || "") : [];
}
function agentTree(host, w) {
  const snap = orchSnapshot(host);
  return snap && w.localPath != null ? sessionTree(snap, w.localPath || "") : [];
}
/** 렌더 서명 — 에이전트·워커 행의 보이는 값 전부 + 한 줄 메모 + 분 단위 시각(경과 시간 표시). */
function orchSig(host, w) {
  const snap = orchSnapshot(host);
  if (!snap) return null;
  const n = noteFor(snap, w.localPath || "");
  const rows = sessionTree(snap, w.localPath || "");
  return [n ? [n.comment, n.status] : null, rows.length ? [state.activeWsId, Math.floor(Date.now() / 60000)] : null,
    rows.map((r) => [r.key, r.glyph, r.agent, r.lead || tabTitleOf(w.id, r.tid), r.trail, r.at, orchFolded.has(r.key), r.rollup ? [r.rollup.total, r.rollup.attention, r.rollup.gates] : null,
      r.children.map((c) => [c.key, c.glyph, c.agent, c.lead, c.trail, c.model, c.at, c.tid, c.terminal, c.needsReply, c.placement, c.branch])])];
}
/** 그 워크스페이스에서 사람이 답해야 하는 것의 수(질문·결정·입력 대기). */
function orchAttention(host, w) {
  const snap = orchSnapshot(host);
  return snap ? attentionCount(snap, w.localPath || "") : 0;
}
/** 진행 중 묶음이 워커로 쓰는 작업(전용 작업 폴더) ID — 작업 행으로 한 번 더 그리지 않는다. */
function orchTaskIds(host, w) {
  const ids = new Set();
  for (const r of orchRuns(host, w)) for (const x of r.workers || []) if (x.taskRef && x.taskRef.taskId) ids.add(x.taskRef.taskId);
  return ids;
}
const GLYPH_TEXT = { working: "wWorking", waiting: "wNeedsInput", blocked: "wBlocked", failed: "wFailed", interrupted: "wStopped", done: "wSucceeded", unverifiable: "wIdleNoReport" };
/** 그 터미널 탭에 적힌 이름(열어 본 워크스페이스만 안다) — 에이전트 행과 탭이 같은 이름을 쓰게. */
function tabTitleOf(wsId, tid) {
  const rt = S.wsRuntime(wsId);
  if (!rt || !rt.layout || tid == null) return "";
  let name = "";
  T.eachLeaf(rt.layout, (l) => { if (l.kind !== "terminal") return; for (const t of l.tabs || []) if (t && t.win === tid && !name) name = stripAgentGlyph(t.title) || ""; });
  return name;
}
/** 그 작업 폴더(worktree)를 연 워크스페이스 ID(등록돼 있을 때) — 작업 폴더 줄의 "여기 있음" 표시와 클릭에 쓴다. */
function wtWorkspaceId(host, g) {
  const bucket = state.tasks.byHost[String(Number(host))];
  for (const c of g.workers) {
    const ref = c.worker && c.worker.taskRef;
    const t = ref && ((bucket && bucket.items) || []).find((x) => x.id === ref.taskId);
    const r = t && (t.runs || []).find((x) => x.id === ref.runId);
    if (r && r.workspaceId) return r.workspaceId;
  }
  return null;
}
function agRowHtml({ glyph, glyphTitle, agent, lead, trail, model, at, extra }) {
  const ago = shortAgo(at, Date.now());
  return agentGlyphHtml(glyph, glyphTitle) +
    `<span class="wsg-ic">${agentMarkHtml(agent, { size: 13 }) || icons.terminal({ size: 13 })}</span>` +
    `<span class="ag-text"><span class="ag-lead">${escapeHtml(lead)}</span>${trail ? `<span class="ag-trail"> - ${escapeHtml(trail)}</span>` : ""}</span>` +
    (model ? `<span class="ag-model">${escapeHtml(model)}</span>` : "") + (extra || "") +
    (ago ? `<span class="ag-time">${ago}</span>` : "");
}
/** 에이전트 행(최상위) — 워커를 거느리면 부모 행(접기 + 묶음 시트 버튼). 클릭 = 그 터미널. */
function agentSessionRow(w, r) {
  const host = Number(S.activeDeviceId());
  const b = document.createElement("button");
  const parent = r.children.length > 0 || r.runIds.length > 0;
  const kidsHere = r.children.filter((c) => !inWorktree(c));   // 다른 브랜치의 워커는 제 작업 폴더 줄 아래에 있다
  const open = !orchFolded.has(r.key);
  //  "여기 있음" 표시는 작업 폴더 줄(로컬 · 브랜치)에만 둔다 — 에이전트 행마다 따로 칠하면 어느 폴더를 보고 있는지 읽히지 않는다(2026-10-07 사용자 확정).
  b.className = "wsg-child wsg-ag" + (parent ? " parent" : "");
  b.dataset.agSession = r.key;
  const ro = r.rollup;
  const trail = parent && ro
    ? [ro.attention + ro.gates ? ot("attentionN", { n: ro.attention + ro.gates }) : "", ro.live ? ot("liveN", { n: ro.live }) : "", ro.failed ? ot("failedN", { n: ro.failed }) : "",
      !ro.live && !ro.attention && !ro.gates && ro.ok ? ot("okN", { n: ro.ok }) : ""].filter(Boolean).join(" · ")
    : r.trail;
  const extra = parent
    ? (!open && kidsHere.length ? `<span class="ag-more">+${kidsHere.length}</span>` : "") +
      `<span class="ag-btn ag-run" title="${escapeHtml(ot("orchestration"))}">${icons.orch({ size: 12 })}</span>` +
      (kidsHere.length ? `<span class="ag-btn wsg-caret2">${open ? icons.chevronDown({ size: 12 }) : icons.chevronRight({ size: 12 })}</span>` : "")
    : "";
  b.innerHTML = agRowHtml({ glyph: r.glyph, glyphTitle: GLYPH_TEXT[r.glyph] ? ot(GLYPH_TEXT[r.glyph]) : "", agent: r.agent,
    lead: r.lead || tabTitleOf(w.id, r.tid) || agentName(r.agent || "") || ot("coordinator"), trail, model: r.model || "", at: r.at, extra });
  b.addEventListener("click", (e) => {
    if (e.target.closest?.(".wsg-caret2")) { e.stopPropagation(); toggleOrch(r.key); return; }
    if (r.runIds.length && (e.target.closest?.(".ag-run") || r.tid == null)) { e.stopPropagation(); openOrchSheet({ host, runId: r.runIds[0] }); return; }
    if (r.chat) { openChatRow(w, r); return; }
    if (r.tid != null) void openRunTerminal(w.id, r.tid);
  });
  b.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  return b;
}
/** 채팅 대화 행 — 그 워크스페이스로 간 뒤 그 대화의 탭을 앞으로(없으면 연다). */
function openChatRow(w, r) {
  const go = () => import("./workspace-view.js").then((m) => m.openConvTab(r.threadId, r.lead || "")).catch(() => {});
  if (w.id === state.activeWsId && state.view === "workspace") { void go(); return; }
  openWs(w);
  setTimeout(go, 120);   // 레이아웃이 선 뒤에 — 그 전에는 탭 후보가 없다
}
/** 워커 행(자식) — 클릭 = 그 터미널. 답이 필요하거나 터미널이 없으면 묶음 시트(답하는 자리). */
function agentWorkerRow(w, c) {
  const host = Number(S.activeDeviceId());
  const b = document.createElement("button");
  //  작업 폴더(브랜치) 줄 아래의 워커는 그 폴더의 에이전트다 — 시킨 에이전트의 자식 표시(가지 선)를 달지 않는다.
  b.className = "wsg-child wsg-ag" + (inWorktree(c) ? " in-wt" : " child");
  b.dataset.dispatchId = c.dispatchId;
  b.innerHTML = agRowHtml({ glyph: c.glyph, glyphTitle: ot(c.textKey), agent: c.agent, lead: c.lead || ot("worker"), trail: c.trail, model: c.model, at: c.at });
  b.addEventListener("click", () => {
    if (c.needsReply || c.tid == null || c.terminal === "released") { openOrchSheet({ host, runId: c.runId }); return; }
    void openWorkerTerminal(host, c.worker, c.placement === "worktree" ? null : w.id);
  });
  return b;
}
/** 작업 폴더(worktree) 줄 — 브랜치 이름. `로컬 · main` 과 같은 층이다. 클릭 = 그 작업 상세(없으면 그 워커의 터미널). */
function worktreeRow(w, g) {
  const host = Number(S.activeDeviceId());
  const b = document.createElement("button");
  const wsId = wtWorkspaceId(host, g);
  const active = wsId != null && wsId === state.activeWsId && state.view === "workspace";
  b.className = "wsg-child wsg-wt" + (active ? " active" : "");
  b.dataset.wtKey = g.key;
  const first = g.workers[0];
  b.innerHTML = `<span class="wsg-ic">${icons.gitBranch({ size: 15 })}</span><span class="wsg-title">${escapeHtml(g.branch || first.lead || ot("worker"))}</span>`;
  b.title = g.branch || "";
  b.addEventListener("click", () => {
    //  그 작업 폴더를 연다(오른쪽이 그 폴더의 터미널·파일로 바뀐다). 아직 워크스페이스로 안 잡혔으면 작업 상세로.
    if (first.worker && first.worker.taskRef) { void openWorkerTerminal(host, first.worker, null); return; }
    if (g.taskId) { openTasksDashboard({ taskId: g.taskId, host }); return; }
    openOrchSheet({ host, runId: first.runId });
  });
  b.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  return b;
}
/** 그룹 = 머리(.ws-row.wsg-head — 예전 워크스페이스 행 DOM) + 펼침이면 자식들. */
function wsGroup(w, g) {
  const local = isLocal(w);
  const online = local ? (w.hostOnline !== false) : true;
  const wrap = document.createElement("div");
  wrap.className = "ws-group" + (online ? "" : " ws-off");
  wrap.dataset.wsGroup = w.id;
  // 워크스페이스 색 = 그룹 전체의 아주 연한 배경 틴트(2026-10-02 QA — 왼쪽 점/띠는 어색하다는 지적).
  const tint = S.wsColor(w.id);
  if (tint) { wrap.classList.add("tinted"); wrap.style.setProperty("--wsg-tint", tint); }
  const folded = groupCollapsed(w.id);
  wrap.appendChild(wsHead(w, g, folded));
  if (!folded) {
    const kids = document.createElement("div");
    kids.className = "wsg-children";
    kids.appendChild(localRow(w));
    const ohost = Number(S.activeDeviceId());
    //  작업 폴더 단위(Orca 와 같다): `로컬 · <브랜치>` 아래에는 그 폴더에서 도는 에이전트만, 다른 브랜치의 워커는 제 브랜치 줄 아래에.
    const tree = agentTree(ohost, w);
    for (const r of tree) {
      kids.appendChild(agentSessionRow(w, r));
      if (!orchFolded.has(r.key)) for (const c of r.children) if (!inWorktree(c)) kids.appendChild(agentWorkerRow(w, c));
    }
    for (const g of worktreeGroups(tree)) {
      kids.appendChild(worktreeRow(w, g));
      for (const c of g.workers) kids.appendChild(agentWorkerRow(w, c));
    }
    const owned = orchTaskIds(ohost, w);
    for (const t of (g && g.tasks) || []) {
      if (owned.has(t.taskId)) continue;   // 묶음의 워커로 이미 위에 있다
      kids.appendChild(taskRow(w, t));
      if (t.runs.length && fanExpanded.has(t.taskId)) for (const r of t.runs) kids.appendChild(agentRow(w, t, r));
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

// ★ 2026-08-14: `group`(프로젝트 묶음) 인자는 없어졌다. 이제 행은 **고른 PC 의 워크스페이스** 하나이고,
//  호스트 이름·상태점·직결 배지는 위 기기 행이 이미 말한다 → 행에서 중복 제거(이름과 경로만 남는다).
// ★ 2026-09-29: 행은 그룹 머리가 됐다. 클릭 = 펼침/접힘, 더블클릭 = 열기(로컬 행과 동일). 활성 표시는 로컬 행이 갖는다.
//  안에 `⋯` 버튼이 들어가야 해서 <button> 이 아니라 role=button 인 div 다(버튼 안 버튼은 무효 HTML).
let lastHeadClick = null; // { w, at } — 머리 더블클릭 대상 고정(재구축 사이에도)
function wsHead(w, g, folded) {
  const rt = S.wsRuntime(w.id);
  const unread = S.unreadForWs(w);
  const color = S.wsColor(w.id);
  const pinned = S.wsPinned(w.id);
  const row = document.createElement("div");
  row.className = "ws-row wsg-head";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-expanded", folded ? "false" : "true");
  row.draggable = true;
  row.dataset.wsId = w.id;
  // 색 = 이름 앞 6px 점(.wsr-color). 옛 3px 안쪽 띠(box-shadow)는 선택 테두리와 겹쳐 폐기(디자인 리프레시 2026-09-30).

  const openN = g ? g.openCount : 0;
  const ohost = Number(S.activeDeviceId());
  const oWorkers = orchRuns(ohost, w).reduce((n, r) => n + visibleWorkers(r).filter((x) => x.terminal !== "released").length, 0);
  const oAttn = orchAttention(ohost, w);
  const name = document.createElement("div");
  name.className = "wsr-name";
  name.innerHTML =
    `<span class="wsg-caret">${folded ? icons.chevronRight({ size: 14 }) : icons.chevronDown({ size: 14 })}</span>` +
    (pinned ? `<span class="wsr-pin" title="${i18n.t('고정됨')}">${icons.pin({ size: 12 })}</span>` : "") +
    `<span class="wsr-nm">${escapeHtml(S.wsDisplayName(w))}</span>` +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "") +
    (folded && openN ? `<span class="wsg-cnt${g.needsInput ? " warn" : ""}" title="${escapeHtml(tt("openTasksN", { n: openN }))}">${icons.gitBranch({ size: 11 })}${openN}</span>` : "") +
    (folded && oWorkers ? `<span class="wsg-cnt${oAttn ? " warn" : ""}" title="${escapeHtml(ot("workersN", { n: oWorkers }))}">${icons.orch({ size: 11 })}${oWorkers}</span>` : "");
  // `⋯` — 워크스페이스 메뉴(우클릭과 같은 것). 옛 `+ 작업` 버튼을 대신한다(2026-10-05 사용자 확정):
  //  새 작업은 그 메뉴의 첫 항목이다. 호버 때만 보이되 **행 높이를 바꾸지 않는다**(styles.css .wsg-more).
  const more = document.createElement("button");
  more.className = "wsg-more";
  more.title = i18n.t('더보기');
  more.setAttribute("aria-label", i18n.t('더보기'));
  more.innerHTML = icons.dots({ size: 14 });
  more.addEventListener("click", (e) => {
    e.stopPropagation();   // 머리 토글 방지
    const r = more.getBoundingClientRect();
    showCtxDom(r.left, r.bottom + 4, wsMenuItems(w));
  });
  more.addEventListener("dblclick", (e) => e.stopPropagation());
  name.appendChild(more);

  const meta = document.createElement("div");
  meta.className = "wsr-meta";
  // 원격 상태 스트림(ui_command status.changed) 최소 표시 — status[0].value 텍스트 + 진행률 %.
  //  (상태 스트림·포트는 폴더의 것이라 머리에 남는다 — §3.1)
  const st = w.localPath ? S.wsStatus.get(w.localPath) : null;
  const stText = st?.status?.[0]?.value;
  if (stText || typeof st?.progress === "number") {
    const badge = document.createElement("span");
    badge.className = "wsr-status";
    badge.textContent =
      (stText || "") + (typeof st.progress === "number" ? ` ${Math.round(st.progress)}%` : "");
    meta.appendChild(badge);
  }

  row.append(name);
  if (meta.innerHTML) row.append(meta);
  if (wsMissing(w)) {
    // 유령 — 경로 서브라벨 대신 소실 라벨(오프라인 라벨 톤, 위험 뉘앙스 과하지 않게).
    const miss = document.createElement("div");
    miss.className = "wsr-path wsr-missing";
    miss.textContent = i18n.t('폴더를 찾을 수 없음');
    row.appendChild(miss);
  } else if (w.localPath) {
    const path = document.createElement("div");
    path.className = "wsr-path";
    path.textContent = "~/" + w.localPath;
    row.appendChild(path);
  }
  // 한 줄 메모(`cpt ws set --comment … --status …`) — 에이전트가 "지금 어디까지 왔는지" 남긴 것. 단계는 앞에 작은 꼬리표로.
  const note = (() => { const snap = orchSnapshot(ohost); return snap ? noteFor(snap, w.localPath || "") : null; })();
  if (note && !wsMissing(w)) {
    const n = document.createElement("div");
    n.className = "wsr-note";
    const stx = wsStatusText(note.status);
    n.innerHTML = (stx ? `<span class="wsr-note-st" data-st="${escapeHtml(note.status)}">${escapeHtml(stx)}</span>` : "") +
      (note.comment ? `<span class="wsr-note-tx">${escapeHtml(note.comment)}</span>` : "");
    n.title = note.comment || stx;
    row.appendChild(n);
  }
  const ports = (rt?.ports || []).slice(0, 3);
  if (ports.length) {
    const p = document.createElement("div");
    p.className = "wsr-ports";
    // 칩이 아니라 한 줄 보조 텍스트(`:3000 · :5173`) — 각 포트는 `.port` 스팬으로 남긴다.
    p.innerHTML = ports.map((x) => `<span class="port">:${escapeHtml(String(x))}</span>`).join(" · ");
    row.appendChild(p);
  }
  row.addEventListener("click", (e) => {
    if (row.classList.contains("dragging")) return;
    if (e.target.closest?.(".wsr-rename")) return;
    // 더블클릭의 두 번째 클릭이 (재구축으로) 다른 그룹 머리에 떨어졌다면 그 그룹은 건드리지 않는다.
    if (e.detail >= 2 && lastHeadClick && lastHeadClick.w.id !== w.id) return;
    lastHeadClick = { w, at: Date.now() };
    toggleGroup(w.id);
  });
  row.addEventListener("dblclick", (e) => {
    if (e.target.closest?.(".wsr-rename")) return;
    // 열기 대상 = 첫 클릭을 받은 머리(두 번째 클릭 위치가 아니라).
    const first = lastHeadClick && Date.now() - lastHeadClick.at < 800 ? lastHeadClick.w : w;
    openWs(first);
  });
  row.addEventListener("keydown", (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(w.id); }
  });
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  bindWsDrag(row, w);
  return row;
}

/** 워크스페이스 메뉴의 `새 작업` — 그 워크스페이스를 저장소로 미리 골라 새 작업 시트를 연다. */
function newTaskFor(w) {
  if (S.blockedOffline(tt("newTask"))) return;
  const host = Number(w.hostDeviceId ?? state.daemon?.deviceId);
  // 시트는 받을 수 없는 host 면 조용히 이 PC·첫 저장소로 바꿔 연다(new-task-sheet.js hosts()) —
  //  엉뚱한 저장소에 작업이 만들어지지 않게, 시트와 같은 조건으로 여기서 먼저 막고 이유를 말한다.
  const why = addTaskBlocked(w, host);
  if (why) { import("./workspace-view.js").then((m) => m.wvToast(tt(why))).catch(() => {}); return; }
  import("./new-task-sheet.js").then((m) => m.openNewTaskSheet({ host, wsId: w.id })).catch(() => {});
}

/** `새 작업` 을 이 host 로 열 수 없는 이유(tasks 문구 키) — 새 작업 시트 hosts() 필터와 같은 조건. */
function addTaskBlocked(w, host) {
  if (!Number.isFinite(host) || host <= 0) return "noHost";
  const dev = S.pcDevices().find((d) => typeof d.id === "number" && Number(d.id) === host);
  if (w.hostOnline === false || !dev || dev.online === false) return "hostOffline";
  if (hostHasTasks(host) === false) return "pcNeedsUpdate";
  if (serverHasTasks() === false && !isLocalHostId(state, host)) return "serverNeedsUpdate";
  return null;
}

/** 첫 자식 `로컬 · <branch>` — 폴더에서 직접 작업(= 예전 워크스페이스 행 클릭). 활성 표시는 여기. */
function localRow(w) {
  const b = document.createElement("button");
  const active = w.id === state.activeWsId && state.view === "workspace";
  b.className = "wsg-child wsg-local" + (active ? " active" : "");
  b.dataset.wsLocal = w.id;
  const branch = w.git?.branch || "";
  // 터미널 개수는 일부러 안 그린다(2026-10 QA) — 알림 신호가 아닌 숫자라 정보 가치가 없었다.
  b.innerHTML =
    `<span class="wsg-ic">${icons.folder({ size: 15 })}</span>` +
    `<span class="wsg-title">${escapeHtml(tt("local") + (branch ? " · " + branch : ""))}</span>`;
  b.addEventListener("click", () => openWs(w));
  // 우클릭 = 워크스페이스 메뉴(머리와 같은 것) — 웹뷰 기본 메뉴(다시 로드·요소 검사)가 뜨던 것 대체.
  b.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  return b;
}

/** 작업 행 — 제목 + (팬아웃 ×N · 캐럿) / 부제(상태 점 + 상태 문구 · diff). 클릭 = 현황판 그 작업 상세. */
function taskRow(w, t) {
  const host = Number(S.activeDeviceId());
  const b = document.createElement("button");
  b.className = "wsg-child wsg-task";
  b.dataset.taskId = t.taskId;
  const fan = t.runs.length > 0;
  const open = fan && fanExpanded.has(t.taskId);
  const subText = tt(t.sub.key) + (t.sub.diff ? " · " + tt("diffStat", { a: t.sub.diff.a, d: t.sub.diff.d }) : "");
  const dotCls = t.dot === "none" ? "" : " " + t.dot;
  // 자동화가 만든 작업 — 제목 앞 `자동` 칩(automation-design §5.9). 누르면 그 자동화로.
  const origin = (findTask(host, t.taskId) || {}).origin || null;
  const autoId = origin && origin.kind === "automation" ? origin.automationId || null : null;
  b.innerHTML =
    `<span class="wsg-line"><span class="wsg-ic">${icons.gitBranch({ size: 15 })}</span>` +
    (autoId ? `<span class="wsg-fan au-chip" title="${escapeHtml(at("automations"))}">${escapeHtml(at("autoBadge"))}</span>` : "") +
    `<span class="wsg-title">${escapeHtml(t.title || tt("title"))}</span>` +
    (fan ? `<span class="wsg-fan">×${t.fanout}</span><span class="wsg-caret2">${open ? icons.chevronDown({ size: 12 }) : icons.chevronRight({ size: 12 })}</span>` : "") +
    `</span>` +
    `<span class="wsg-sub"><span class="tv-dot${dotCls}"></span><span class="wsg-subtx">${escapeHtml(subText)}</span></span>`;
  b.addEventListener("click", (e) => {
    if (autoId && e.target.closest?.(".au-chip")) { e.stopPropagation(); openAutomations({ id: autoId, host }); return; }
    if (fan && e.target.closest?.(".wsg-fan, .wsg-caret2")) { e.stopPropagation(); toggleFan(t.taskId); return; }
    openTasksDashboard({ taskId: t.taskId, host });
  });
  return b;
}

/** 팬아웃 에이전트 자식 행 — 클릭 = 그 run 의 터미널(작업 워크스페이스 미등록이면 현황판 상세로). */
function agentRow(w, t, r) {
  const host = Number(S.activeDeviceId());
  const b = document.createElement("button");
  const active = !!r.workspaceId && r.workspaceId === state.activeWsId && state.view === "workspace";
  b.className = "wsg-child wsg-agent" + (active ? " active" : "");
  b.dataset.runId = r.runId;
  const dotCls = r.dot === "none" ? "" : " " + r.dot;
  b.innerHTML =
    `<span class="wsg-ic">${agentMarkHtml(r.agent, { size: 14 }) || icons.terminal({ size: 14 })}</span>` +
    `<span class="wsg-title">${escapeHtml(agentName(r.agent) + (r.branch ? " · " + r.branch : ""))}</span>` +
    `<span class="tv-dot${dotCls}"></span>`;
  b.addEventListener("click", () => {
    if (r.workspaceId) void openRunTerminal(r.workspaceId, r.tid, { task: true });
    else openTasksDashboard({ taskId: t.taskId, runId: r.runId, host });
  });
  return b;
}

// ── 워크스페이스 드래그앤드롭 순서 변경 ──
let dragSrcId = null;
function bindWsDrag(row, w) {
  row.addEventListener("dragstart", (e) => {
    dragSrcId = w.id;
    row.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", String(w.id)); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
  });
  row.addEventListener("dragend", () => {
    dragSrcId = null;
    row.classList.remove("dragging");
    el?.querySelectorAll(".ws-row.drop-before,.ws-row.drop-after").forEach((r) => r.classList.remove("drop-before", "drop-after"));
  });
  row.addEventListener("dragover", (e) => {
    if (dragSrcId == null || dragSrcId === w.id) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const after = row.classList.contains("drop-after");
    row.classList.remove("drop-before", "drop-after");
    if (dragSrcId == null || dragSrcId === w.id) return;
    const ids = S.sortedWorkspaces().map((x) => x.id).filter((id) => id !== dragSrcId);
    let idx = ids.indexOf(w.id);
    if (idx === -1) idx = ids.length; else if (after) idx += 1;
    ids.splice(idx, 0, dragSrcId);
    S.applyWsVisualOrder(ids);
  });
}

// ── 워크스페이스 우클릭 컨텍스트 메뉴 ──
const WS_COLORS = [
  ["없음", ""], ["빨강", "#f87171"], ["주황", "#fb923c"], ["초록", "#30D158"],
  ["파랑", "#60a5fa"], ["보라", "#a78bfa"], ["분홍", "#f472b6"],
];
let wsMenuEl = null;
function closeWsMenu() {
  if (wsMenuEl) { wsMenuEl.remove(); wsMenuEl = null; }
  document.removeEventListener("mousedown", onWsMenuOutside, true);
  document.removeEventListener("keydown", onWsMenuKey, true);
  window.removeEventListener("blur", closeWsMenu);
}
function onWsMenuOutside(e) { if (wsMenuEl && !wsMenuEl.contains(e.target)) closeWsMenu(); }
function onWsMenuKey(e) { if (e.key === "Escape") closeWsMenu(); }

// ctx-menu 요소 빌드(디자인=styles.css .ctx-menu). onAfter=항목 클릭 시 메뉴 닫기 콜백.
//  items: {icon,label,danger,onClick}(기본 항목) | {type:'sep'} | {type:'colors',icon,label,colors:[{title,c,sel,onClick}]}
function buildCtxEl(items, onAfter) {
  const tag = (elm, fn) => elm.addEventListener("click", () => { onAfter?.(); fn(); });
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (!it) continue;
    if (it.type === "sep") {
      // 연속·맨앞 구분선은 한 줄로 접는다(항목 모델이 조건부 묶음 경계마다 sep 을 넣어 두 줄이 겹쳐 그려지던 것).
      if (!menu.lastElementChild || menu.lastElementChild.classList.contains("ctx-sep")) continue;
      const d = document.createElement("div"); d.className = "ctx-sep"; menu.appendChild(d); continue;
    }
    if (it.type === "colors") {
      const row = document.createElement("div");
      row.className = "ctx-item ctx-static";
      row.innerHTML = `<span class="ctx-ic">${it.icon || ""}</span><span class="ctx-label">${escapeHtml(it.label)}</span>`;
      const wrap = document.createElement("div");
      wrap.className = "ctx-colors";
      for (const c of it.colors) {
        const sw = document.createElement("button");
        sw.className = "ctx-sw" + (c.c ? "" : " none") + (c.sel ? " sel" : "");
        if (c.c) sw.style.background = c.c;
        sw.title = i18n.t(c.title);
        tag(sw, c.onClick);
        wrap.appendChild(sw);
      }
      row.appendChild(wrap);
      menu.appendChild(row);
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.innerHTML = `<span class="ctx-ic">${it.icon || ""}</span><span class="ctx-label">${escapeHtml(it.label)}</span>`;
    tag(b, it.onClick);
    menu.appendChild(b);
  }
  if (menu.lastElementChild?.classList.contains("ctx-sep")) menu.lastElementChild.remove(); // 끝 구분선도 접는다
  return menu;
}

// 워크스페이스 우클릭 메뉴 항목 모델.
function wsMenuItems(w) {
  const pinned = S.wsPinned(w.id);
  const items = [
    // 새 작업 — 작업 워크스페이스에서는 뺀다(worktree 를 다시 저장소로 삼으면 작업 안의 작업이 된다).
    ...(S.isTaskWorkspace(w) ? [] : [
      { icon: icons.gitBranch({ size: 15 }), label: tt("newTask"), onClick: () => newTaskFor(w) },
      { type: "sep" },
    ]),
    { icon: icons.edit({ size: 15 }), label: i18n.t('이름 변경'), onClick: () => inlineRename(w) },
    { icon: icons.pin({ size: 15 }), label: pinned ? i18n.t('고정 해제') : i18n.t('고정'), onClick: () => S.togglePinWs(w.id) },
    { type: "colors", icon: icons.palette({ size: 15 }), label: i18n.t('색상'), colors: WS_COLORS.map(([title, c]) => ({ title, c, sel: (S.wsColor(w.id) || "") === c, onClick: () => S.setWsColor(w.id, c) })) },
    { type: "sep" },
    { icon: icons.arrowUp({ size: 15 }), label: i18n.t('위로 이동'), onClick: () => S.moveWs(w.id, "up") },
    { icon: icons.arrowDown({ size: 15 }), label: i18n.t('아래로 이동'), onClick: () => S.moveWs(w.id, "down") },
    { icon: icons.arrowTop({ size: 15 }), label: i18n.t('맨 위로 이동'), onClick: () => S.moveWs(w.id, "top") },
    { type: "sep" },
  ];
  // ★ 프로젝트 분리/합치기 제거(2026-08-14 사용자 확정) — 기기 우선 구조에서는 한 화면에 한 PC 의
  //  워크스페이스만 있어서 "무엇과 합칠지"가 화면에 없다. 서버의 projectId 필드는 그대로 두므로
  //  되돌리려면 이 두 항목만 다시 붙이면 된다(api.projectDetach/projectAttach 도 살아 있다).
  // 목록 메타만 삭제(폴더/파일 무영향). 서버가 원천이라 오프라인에서는 막는다.
  items.push({ type: "sep" });
  // VM 워크스페이스 — 에이전트가 VM 에서 한 작업을 호스트 저장소의 브랜치로 가져오거나, 호스트의 최신 커밋을 VM 으로 보낸다.
  const vmOs = vmOsOfPath(w.localPath);
  if (vmOs) {
    const nm = String(w.localPath).split("/").pop();
    const sync = (dir) => api.desktopAgent("ws.sync", { os: vmOs, name: nm, dir })
      .then((r) => window.alert(dir === "pull"
        ? i18n.t('호스트 저장소에 브랜치 「{b}」 로 가져왔어요 (새 커밋 {n}개)', { b: r.branch, n: r.ahead || 0 })
        : i18n.t('호스트의 지금 커밋을 VM 의 「{b}」 로 보냈어요', { b: r.branch })))
      .catch((e) => window.alert(String((e && e.message) || e).replace(/^[A-Z_]+:\s*/, "")));
    items.push({ icon: icons.arrowDown ? icons.arrowDown({ size: 15 }) : "", label: i18n.t('VM 작업 가져오기'), onClick: () => sync("pull") });
    items.push({ icon: icons.arrowUp ? icons.arrowUp({ size: 15 }) : "", label: i18n.t('호스트 최신 보내기'), onClick: () => sync("push") });
  }
  items.push({ icon: icons.trash({ size: 15 }), label: i18n.t('워크스페이스 삭제'), danger: true, onClick: () => { if (S.blockedOffline(i18n.t('워크스페이스 삭제'))) return; confirmDeleteWs(w); } });
  return items;
}

// ── 워크스페이스 삭제(서버 목록 메타만 — 로컬 폴더/파일은 절대 건드리지 않음) ──
// 확인 다이얼로그 — quit-guard 패턴/스타일 재사용(취소 / 위험색 확정 2택).
function confirmDialog({ title, lines, confirmLabel, onConfirm }) {
  if (document.querySelector(".quit-guard-backdrop")) return; // 중복 방지
  const bd = document.createElement("div");
  bd.className = "quit-guard-backdrop";
  bd.innerHTML = `
    <div class="quit-guard">
      <div class="qg-title">${escapeHtml(title)}</div>
      <div class="qg-desc">${lines.map((l) => escapeHtml(l)).join("<br/>")}</div>
      <div class="qg-actions">
        <button class="qg-btn qg-cancel">${i18n.t('취소')}</button>
        <button class="qg-btn qg-quit qg-confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  bd.querySelector(".qg-cancel").addEventListener("click", () => bd.remove());
  bd.querySelector(".qg-confirm").addEventListener("click", () => { bd.remove(); onConfirm(); });
  bd.addEventListener("click", (e) => { if (e.target === bd) bd.remove(); });
  document.body.appendChild(bd);
}

function confirmDeleteWs(w) {
  confirmDialog({
    title: i18n.t('워크스페이스 삭제'),
    lines: [i18n.t("‘{name}’을(를) 목록에서 삭제할까요? PC의 폴더와 파일은 그대로 유지됩니다.", { name: S.wsDisplayName(w) })],
    confirmLabel: i18n.t('삭제'),
    onConfirm: () => deleteWs(w),
  });
}

// 유령(폴더 소실) 행 클릭 — 열지 않고 안내 + 목록에서 삭제 제안(경로 다시 지정은 스코프 제외).
function showMissingDialog(w) {
  confirmDialog({
    title: i18n.t('폴더를 찾을 수 없습니다'),
    lines: [
      "~/" + (w.localPath || ""),
      i18n.t('폴더가 이동되었거나 삭제된 것 같습니다. 목록에서 삭제해도 폴더/파일에는 영향이 없습니다.'),
    ],
    confirmLabel: i18n.t('목록에서 삭제'),
    onConfirm: () => deleteWs(w),
  });
}

async function deleteWs(w) {
  if (S.blockedOffline(i18n.t('워크스페이스 삭제'))) return;
  try {
    // VM 워크스페이스면 호스트 쪽 자리(표식 폴더)도 치운다 — 남겨 두면 VM 화면이 다시 등록한다. VM 안의 사본은 그대로 둔다.
    const vmOsDel = vmOsOfPath(w.localPath);
    if (vmOsDel) await api.desktopAgent("ws.remove", { os: vmOsDel, name: String(w.localPath).split("/").pop() }).catch(() => {});
    await api.wsDelete(w.id);
    localMissing.delete(w.id);
    // 목록 리프레시 — 삭제된 ws 가 활성이었으면 loadWorkspaces 가 다른 ws 로 전환(없으면 빈 상태).
    await S.loadWorkspaces();
    refreshWsMeta();
  } catch (e) {
    console.error("워크스페이스 삭제 실패:", e);
    state.wsError = String(e);
    S.emit();
  }
}

// 우클릭 컨텍스트 메뉴 — DOM(punch-through 로 프리뷰 위에 뜸).
function showWsMenu(e, w) {
  showCtxDom(e.clientX, e.clientY, wsMenuItems(w));
}

function showCtxDom(x, y, items) {
  closeWsMenu();
  const menu = buildCtxEl(items, closeWsMenu);
  document.body.appendChild(menu);
  wsMenuEl = menu;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
  setTimeout(() => {
    document.addEventListener("mousedown", onWsMenuOutside, true);
    document.addEventListener("keydown", onWsMenuKey, true);
    window.addEventListener("blur", closeWsMenu);
  }, 0);
}

// 지정 좌표 팝업 메뉴 — items: [{icon,label,onClick}].
export function showPopupMenu(x, y, items) {
  showCtxDom(x, y, items);
}

// ★ showOfflineFallback / showAttachMenu 삭제(2026-08-14) — 둘 다 **프로젝트 그룹핑 전용**이었다
//  ("같은 프로젝트의 켜진 사본으로 열기" / "다른 프로젝트와 합치기"). 그룹핑을 없앤 이상 화면에
//  근거가 없는 기능이라 죽은 코드로 남기지 않는다(살릴 땐 api.projectAttach/Detach 가 그대로 있다).

// 인라인 이름 변경 — 해당 행의 이름을 입력창으로 교체.
function inlineRename(w) {
  const row = el?.querySelector(`.ws-row[data-ws-id="${w.id}"]`);
  const nm = row?.querySelector(".wsr-nm");
  if (!nm) return;
  const input = document.createElement("input");
  input.className = "wsr-rename";
  input.value = S.wsDisplayName(w);
  input.spellcheck = false;
  nm.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => { S.renameWs(w.id, input.value); };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); S.emit(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (e) => e.stopPropagation());
}

export async function refreshWsMeta() {
  for (const w of state.workspaces) {
    if (!isLocal(w)) continue;
    const rt = S.wsRuntime(w.id) || S.ensureRuntime(w.id);
    if (S.isThisHost(w)) {
      // 유령 감지(로컬 즉시 판정) — 갱신 주기에만 조회해 캐시(행 렌더마다 IPC 금지).
      if (w.localPath) {
        try {
          localMissing.set(w.id, !(await api.pathExists(w.localPath)));
        } catch (_) {}
      }
      // 그 워크스페이스 폴더 안에서 실제로 도는 dev 서버 포트만 감지(시스템/타 폴더 포트 제외).
      try {
        rt.ports = await api.listenPorts(w.localPath || "");
      } catch (_) {}
    } else if (state.wsStale) {
      rt.ports = []; // 오프라인(캐시 목록) — 릴레이 조회가 불가하므로 무의미한 호출을 하지 않는다
    } else {
      // 다른 PC 워크스페이스 — 포트는 그 호스트 데몬에 조회(브랜치는 신선도 메타 w.git 폴백이 이미 있음).
      //  로컬 lsof 를 원격 사본 경로에 돌리면 "이 기기의" 포트가 잡히는 오답이라 반드시 릴레이로.
      try {
        const r = await api.backApi(
          "GET",
          `/api/daemon/preview/ports?cwd=${encodeURIComponent(w.localPath || "")}&hostDeviceId=${w.hostDeviceId}`,
        );
        rt.ports = r?.ports || [];
      } catch (_) { rt.ports = []; } // 호스트 오프라인 등 — 배지 없음
    }
  }
  S.emit();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
