// sidebar.js — 좌측: 상단 컨트롤(사이드바 토글·알림·새 워크스페이스) + 워크스페이스 목록 + 하단 내 정보.
import { state, isLocal } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { getPane } from "./pane.js";
import { renderNotifPanel, jumpLatestUnread } from "./notifications.js";
import { openNewWorkspace } from "./folder-picker.js";
import lan from "./lan.js";

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
  // 기기 승인 알림(기능2)은 워크스페이스가 없다 — 설정>계정(종단간 암호화 카드)이 목적지다.
  if (n && n.kind === "device_approval") {
    import("./settings.js").then((m) => m.openAccountSection()).catch(() => S.setView("settings"));
    return;
  }
  // 대상 워크스페이스 활성화 — 서버 행(workspaceId → cwd 매칭) 우선, 로컬 폴백(wsId)도 지원.
  const ws =
    state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId)) ||
    (n.cwd ? state.workspaces.find((w) => w.localPath === n.cwd) : null);
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

export function updateSidebar() {
  if (!el) return;
  const totalUnread = state.notifications.filter((n) => !n.read).length;
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
  //  조작(추가/삭제/그룹핑)과 다른 기기 진입은 막혀 있다는 것을 한 줄로 알린다(오프라인 톤, 위험색 금지).
  if (state.wsStale) list.appendChild(note("오프라인 — 마지막으로 본 목록"));
  if (state.wsError && !state.workspaces.length) {
    list.appendChild(note(state.paired ? "목록을 불러오지 못했습니다" : "PC를 연결하세요"));
  } else if (!state.workspaces.length) {
    list.appendChild(note("+ 로 워크스페이스를 추가하세요"));
  }
  // 프로젝트 그룹 — projectId 가 같은 워크스페이스(다른 PC의 사본)를 인접 묶음으로.
  //  정렬 순서 유지(그룹 위치=첫 멤버), 단독 그룹은 기존 행 그대로. 항상 전부 펼침.
  const groups = [];
  {
    const byKey = new Map();
    for (const w of S.sortedWorkspaces()) {
      const key = w.projectId || w.id;
      let g = byKey.get(key);
      if (!g) { g = { key, members: [] }; byKey.set(key, g); groups.push(g); }
      g.members.push(w);
    }
  }
  for (const g of groups) {
    // 단독(사본 1개)도 같은 구조로 렌더(표현 통일 — 프로젝트명 ⊃ 기기 워크스페이스, 모바일 미러).
    const head = document.createElement("div");
    head.className = "ws-proj-head";
    head.innerHTML = `${icons.folder({ size: 13 })}<span class="wsp-nm">${escapeHtml(S.wsDisplayName(g.members[0]))}</span>`;
    list.appendChild(head);
    const wrap = document.createElement("div");
    wrap.className = "ws-proj-members";
    for (const m of g.members) wrap.appendChild(wsRow(m, g));
    list.appendChild(wrap);
  }
  el.appendChild(list);

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
  const name = me?.nickname || "내 정보";
  const sub = me
    ? me.email || state.daemon?.device_name || "로그인됨"
    : state.daemon?.device_name || (state.paired ? "연결됨" : "로그인 필요");
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
    "font-size:11px;color:var(--text-dim,#8b93a7);opacity:0;transition:height .12s,opacity .12s;user-select:none;";
  list.prepend(ind);

  const render = () => {
    const v = Math.min(pull, 96);
    if (__ptrBusy) return;
    ind.style.height = v > 3 ? Math.min(6 + v * 0.5, 44) + "px" : "0px";
    ind.style.opacity = v > 3 ? "1" : "0";
    ind.textContent = pull >= THRESH ? "놓으면 새로고침 ↑" : "당겨서 새로고침 ↓";
  };
  const reset = () => { pull = 0; render(); };
  const fire = () => {
    if (pull >= THRESH && !__ptrBusy) {
      __ptrBusy = true;
      ind.style.height = "30px";
      ind.style.opacity = "1";
      ind.textContent = "새로고침 중…";
      Promise.resolve(S.loadWorkspaces()).finally(() => {
        setTimeout(() => { __ptrBusy = false; }, 400);
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

function ctlBtn(iconName, title, onClick) {
  const b = document.createElement("button");
  b.className = "ic-btn";
  b.title = title;
  b.innerHTML = icons[iconName]({ size: 17 });
  b.addEventListener("click", onClick);
  return b;
}

// 상단 컨트롤(토글·알림·추가) — 사이드바 상단바 + 접힘 시 메인 상단바에서 공용 사용(정합성).
//  withAdd=false: 접힘 시 이식되는 축약판 — 워크스페이스 추가(+)는 사이드바를 열어야 보인다.
export function buildTopControls(withAdd = true) {
  const frag = document.createDocumentFragment();
  const totalUnread = state.notifications.filter((n) => !n.read).length;
  // 열림=채운 아이콘, 닫힘=빈 아이콘(색이 아니라 채움 유무로 상태 표현).
  const toggle = ctlBtn(state.sidebarCollapsed ? "sidebar" : "sidebarFilled", state.sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기", () => S.toggleSidebar());
  const bell = ctlBtn("bell", "알림", (e) => {
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
  frag.append(toggle, bell);
  if (withAdd) {
    const add = ctlBtn("plus", "새 워크스페이스", () => { if (S.blockedOffline("워크스페이스 추가")) return; openNewWorkspace(); });
    if (state.creatingWs) add.classList.add("busy");
    frag.append(add);
  }
  return frag;
}
function note(text) {
  const d = document.createElement("div");
  d.className = "sb-note";
  d.textContent = text;
  return d;
}

// ── 유령(폴더 소실) 감지 ──
//  서버 신선도 플래그(w.git.missing)와, 자기 호스트(이 PC) 행은 로컬 pathExists 즉시 판정을 OR
//  (서버 보고 주기 지연 보완). 로컬 판정은 행 렌더마다 IPC 를 부르지 않도록 refreshWsMeta
//  갱신 주기(시작+15s)에만 조회해 캐시한다. 원격 PC 행은 서버 플래그만.
const localMissing = new Map(); // wsId -> true(이 PC 에 폴더 없음)
function wsMissing(w) {
  return !!w?.git?.missing || localMissing.get(w.id) === true;
}

function wsRow(w, group) {
  const rt = S.wsRuntime(w.id);
  const unread = S.unreadForWs(w);
  const local = isLocal(w);
  const color = S.wsColor(w.id);
  const pinned = S.wsPinned(w.id);
  const grouped = !!group;
  const online = local ? (w.hostOnline !== false) : true;
  const hostLabel = local ? (w.hostName || "내 PC") : "클라우드";
  const row = document.createElement("button");
  row.className = "ws-row" + (w.id === state.activeWsId && state.view === "workspace" ? " active" : "") + (online ? "" : " ws-off");
  row.draggable = true;
  row.dataset.wsId = w.id;
  if (color) row.style.boxShadow = `inset 3px 0 0 ${color}`;

  const name = document.createElement("div");
  name.className = "wsr-name";
  // 그룹 멤버 행은 제목=호스트명(프로젝트 이름은 그룹 헤더에 1회) + 상태점.
  name.innerHTML =
    (pinned ? `<span class="wsr-pin" title="고정됨">${icons.pin({ size: 12 })}</span>` : "") +
    (grouped ? `<span class="wsr-kind">${local ? icons.monitor({ size: 12 }) : icons.cloud({ size: 12 })}</span>` : "") +
    `<span class="wsr-nm">${escapeHtml(grouped ? hostLabel : S.wsDisplayName(w))}</span>` +
    (grouped && online && lan.isDirect(w.hostDeviceId) ? `<span class="wsr-lan" title="같은 Wi-Fi 직접 연결">직결</span>` : "") +
    (grouped ? `<span class="wsr-dot ${online ? "on" : "off"}"></span>` : "") +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "");

  const meta = document.createElement("div");
  meta.className = "wsr-meta";
  const kindIc = local ? icons.monitor({ size: 12 }) : icons.cloud({ size: 12 });
  meta.innerHTML = grouped
    ? ""
    : `<span class="wsr-kind">${kindIc}${escapeHtml(hostLabel)}${online && lan.isDirect(w.hostDeviceId) ? `<span class="wsr-lan" title="같은 Wi-Fi 직접 연결">직결</span>` : ""}<span class="wsr-dot ${online ? "on" : "off"}"></span></span>`;

  // 원격 상태 스트림(ui_command status.changed) 최소 표시 — status[0].value 텍스트 + 진행률 %.
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
  if (meta.innerHTML) row.append(meta); // 빈 meta 줄(그룹 멤버 + 상태 배지 없음)은 여백만 남으니 생략
  const missing = wsMissing(w);
  if (missing) {
    // 유령 — 경로 서브라벨 대신 소실 라벨(오프라인 라벨 톤, 위험 뉘앙스 과하지 않게).
    const miss = document.createElement("div");
    miss.className = "wsr-path wsr-missing";
    miss.textContent = "폴더를 찾을 수 없음";
    row.appendChild(miss);
  } else if (w.localPath) {
    const path = document.createElement("div");
    path.className = "wsr-path";
    path.textContent = "~/" + w.localPath;
    row.appendChild(path);
  }
  const ports = (rt?.ports || []).slice(0, 3);
  if (ports.length) {
    const p = document.createElement("div");
    p.className = "wsr-ports";
    p.innerHTML = ports.map((x) => `<span class="port">:${x}</span>`).join("");
    row.appendChild(p);
  }
  row.addEventListener("click", (e) => {
    if (row.classList.contains("dragging")) return;
    // 유령(폴더 소실) — 열지 않고 안내 다이얼로그(목록에서 삭제 제안)만.
    if (wsMissing(w)) { showMissingDialog(w); return; }
    // 오프라인(캐시 목록): 이 PC 것만 진입. 캐시의 hostOnline 은 옛 판정이므로 "온라인 사본 제안"
    //  흐름(=거짓 정보)을 태우지 않고, 내 PC 워크스페이스는 로컬 직결로 그냥 연다.
    if (state.wsStale) {
      if (!S.isThisHost(w)) { S.blockedOffline("다른 기기의 워크스페이스 열기"); return; }
      S.setActive(w.id);
      return;
    }
    // 호스트가 꺼진 사본인데 같은 프로젝트의 켜진 사본이 있으면 원탭 폴백 제안.
    if (local && w.hostOnline === false) {
      const key = w.projectId || w.id;
      const alt = state.workspaces.find((x) => x.id !== w.id && (x.projectId || x.id) === key
        && (isLocal(x) ? x.hostOnline !== false : true));
      if (alt) { showOfflineFallback(e, w, alt); return; }
    }
    S.setActive(w.id);
  });
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, w); });
  bindWsDrag(row, w);
  return row;
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
  ["없음", ""], ["빨강", "#f87171"], ["주황", "#fb923c"], ["초록", "#34d399"],
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
    if (it.type === "sep") { const d = document.createElement("div"); d.className = "ctx-sep"; menu.appendChild(d); continue; }
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
        sw.title = c.title;
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
  return menu;
}

// 워크스페이스 우클릭 메뉴 항목 모델.
function wsMenuItems(w) {
  const pinned = S.wsPinned(w.id);
  const projKey = w.projectId || w.id;
  const hasSibling = state.workspaces.some((x) => x.id !== w.id && (x.projectId || x.id) === projKey);
  const items = [
    { icon: icons.edit({ size: 15 }), label: "이름 변경", onClick: () => inlineRename(w) },
    { icon: icons.pin({ size: 15 }), label: pinned ? "고정 해제" : "고정", onClick: () => S.togglePinWs(w.id) },
    { type: "colors", icon: icons.palette({ size: 15 }), label: "색상", colors: WS_COLORS.map(([title, c]) => ({ title, c, sel: (S.wsColor(w.id) || "") === c, onClick: () => S.setWsColor(w.id, c) })) },
    { type: "sep" },
    { icon: icons.arrowUp({ size: 15 }), label: "위로 이동", onClick: () => S.moveWs(w.id, "up") },
    { icon: icons.arrowDown({ size: 15 }), label: "아래로 이동", onClick: () => S.moveWs(w.id, "down") },
    { icon: icons.arrowTop({ size: 15 }), label: "맨 위로 이동", onClick: () => S.moveWs(w.id, "top") },
    { type: "sep" },
  ];
  // 서버가 원천인 조작 3종(분리/합치기/삭제)은 오프라인(캐시 목록)에서 막는다 — 캐시 기준으로
  //  실행하면 서버 메타를 옛 상태로 되돌리거나(그룹핑) 실패만 남는다.
  if (hasSibling) items.push({ icon: icons.folder({ size: 15 }), label: "프로젝트에서 분리", onClick: async () => { if (S.blockedOffline("프로젝트 분리")) return; try { await api.projectDetach(w.id); await S.loadWorkspaces(); } catch (_) {} } });
  else items.push({ icon: icons.folder({ size: 15 }), label: "다른 프로젝트와 합치기", onClick: () => { if (S.blockedOffline("프로젝트 합치기")) return; showAttachMenu(w); } });
  // 기기(호스트)/클라우드 행 공통 — 목록 메타만 삭제(폴더/파일 무영향). 그룹 헤더에는 메뉴 없음.
  items.push({ type: "sep" });
  items.push({ icon: icons.trash({ size: 15 }), label: "워크스페이스 삭제", danger: true, onClick: () => { if (S.blockedOffline("워크스페이스 삭제")) return; confirmDeleteWs(w); } });
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
        <button class="qg-btn qg-cancel">취소</button>
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
    title: "워크스페이스 삭제",
    lines: [`‘${S.wsDisplayName(w)}’을(를) 목록에서 삭제할까요? PC의 폴더와 파일은 그대로 유지됩니다.`],
    confirmLabel: "삭제",
    onConfirm: () => deleteWs(w),
  });
}

// 유령(폴더 소실) 행 클릭 — 열지 않고 안내 + 목록에서 삭제 제안(경로 다시 지정은 스코프 제외).
function showMissingDialog(w) {
  confirmDialog({
    title: "폴더를 찾을 수 없습니다",
    lines: [
      "~/" + (w.localPath || ""),
      "폴더가 이동되었거나 삭제된 것 같습니다. 목록에서 삭제해도 폴더/파일에는 영향이 없습니다.",
    ],
    confirmLabel: "목록에서 삭제",
    onConfirm: () => deleteWs(w),
  });
}

async function deleteWs(w) {
  if (S.blockedOffline("워크스페이스 삭제")) return;
  try {
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
function showPopupMenu(x, y, items) {
  showCtxDom(x, y, items);
}

// 꺼진 호스트 사본 클릭 — 같은 프로젝트의 켜진 사본으로 원탭 폴백 제안.
function showOfflineFallback(e, w, alt) {
  const altHost = isLocal(alt) ? (alt.hostName || "내 PC") : "클라우드";
  showPopupMenu(e.clientX, e.clientY, [
    { icon: isLocal(alt) ? icons.monitor({ size: 15 }) : icons.cloud({ size: 15 }), label: `${altHost}로 열기`, onClick: () => S.setActive(alt.id) },
    { icon: icons.monitor({ size: 15 }), label: "그냥 열기", onClick: () => S.setActive(w.id) },
  ]);
}

// 합칠 대상 프로젝트 선택(자기 그룹 제외, 그룹당 1항목).
function showAttachMenu(w) {
  const key = w.projectId || w.id;
  const seen = new Set();
  const items = [];
  for (const x of S.sortedWorkspaces()) {
    const k = x.projectId || x.id;
    if (k === key || seen.has(k)) continue;
    seen.add(k);
    items.push({
      icon: icons.folder({ size: 15 }),
      label: S.wsDisplayName(x),
      onClick: async () => {
        try { await api.projectAttach(w.id, x.id); await S.loadWorkspaces(); } catch (_) {}
      },
    });
  }
  if (!items.length) return;
  const r = el?.querySelector(`.ws-row[data-ws-id="${w.id}"]`)?.getBoundingClientRect();
  showPopupMenu(r ? r.right - 40 : 200, r ? r.top + 8 : 200, items);
}

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
