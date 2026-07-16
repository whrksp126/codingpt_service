// sidebar.js — 좌측: 상단 컨트롤(사이드바 토글·알림·새 워크스페이스) + 워크스페이스 목록 + 하단 내 정보.
import { state, isLocal } from "./state.js";
import * as S from "./state.js";
import * as T from "./tiling.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { getPane } from "./pane.js";
import { renderNotifPanel, jumpLatestUnread } from "./notifications.js";

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
  notifPanel = document.createElement("div");
  notifPanel.className = "notif-panel hidden";
  document.body.appendChild(notifPanel);
  document.addEventListener("mousedown", (e) => {
    if (notifOpen && !notifPanel.contains(e.target) && !e.target.closest?.(".bell")) closeNotif();
  });
}

export function jumpToNotification(n) {
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

  if (state.wsError && !state.workspaces.length) {
    list.appendChild(note(state.paired ? "목록을 불러오지 못했습니다" : "PC를 연결하세요"));
  } else if (!state.workspaces.length) {
    list.appendChild(note("+ 로 워크스페이스를 추가하세요"));
  }
  for (const w of S.sortedWorkspaces()) list.appendChild(wsRow(w));
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
  const dot = document.createElement("span");
  dot.className = "me-dot " + (online ? "on" : "off");
  foot.append(av, txt, dot);
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
  const toggle = ctlBtn("sidebar", state.sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기", () => S.toggleSidebar());
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
    const add = ctlBtn("plus", "새 워크스페이스", () => S.createLocalWorkspace());
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

function wsRow(w) {
  const rt = S.wsRuntime(w.id);
  const unread = S.unreadForWs(w);
  const local = isLocal(w);
  const color = S.wsColor(w.id);
  const pinned = S.wsPinned(w.id);
  const row = document.createElement("button");
  row.className = "ws-row" + (w.id === state.activeWsId && state.view === "workspace" ? " active" : "");
  row.draggable = true;
  row.dataset.wsId = w.id;
  if (color) row.style.boxShadow = `inset 3px 0 0 ${color}`;

  const name = document.createElement("div");
  name.className = "wsr-name";
  name.innerHTML =
    (pinned ? `<span class="wsr-pin" title="고정됨">${icons.pin({ size: 12 })}</span>` : "") +
    `<span class="wsr-nm">${escapeHtml(S.wsDisplayName(w))}</span>` +
    (unread ? `<span class="wsr-badge">${unread}</span>` : "");

  const meta = document.createElement("div");
  meta.className = "wsr-meta";
  const kindIc = local ? icons.monitor({ size: 12 }) : icons.cloud({ size: 12 });
  const branch = rt?.branch ? `<span class="wsr-branch">${icons.gitBranch({ size: 11 })}${escapeHtml(rt.branch)}</span>` : "";
  meta.innerHTML = `<span class="wsr-kind">${kindIc}${local ? "내 PC" : "클라우드"}</span>${branch}`;

  row.append(name, meta);
  if (w.localPath) {
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
  row.addEventListener("click", () => { if (!row.classList.contains("dragging")) S.setActive(w.id); });
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

function showWsMenu(e, w) {
  closeWsMenu();
  const pinned = S.wsPinned(w.id);
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const item = (icon, label, onClick, opts = {}) => {
    const b = document.createElement("button");
    b.className = "ctx-item" + (opts.danger ? " danger" : "");
    b.innerHTML = `<span class="ctx-ic">${icon || ""}</span><span class="ctx-label">${label}</span>`;
    b.addEventListener("click", () => { closeWsMenu(); onClick(); });
    menu.appendChild(b);
    return b;
  };
  const sep = () => { const d = document.createElement("div"); d.className = "ctx-sep"; menu.appendChild(d); };

  item(icons.edit({ size: 15 }), "이름 변경", () => inlineRename(w));
  item(icons.pin({ size: 15 }), pinned ? "고정 해제" : "고정", () => S.togglePinWs(w.id));
  // 색상 스와치
  const colorWrap = document.createElement("div");
  colorWrap.className = "ctx-colors";
  for (const [title, c] of WS_COLORS) {
    const sw = document.createElement("button");
    sw.className = "ctx-sw" + (c ? "" : " none") + ((S.wsColor(w.id) || "") === c ? " sel" : "");
    sw.title = title;
    if (c) sw.style.background = c;
    sw.addEventListener("click", () => { closeWsMenu(); S.setWsColor(w.id, c); });
    colorWrap.appendChild(sw);
  }
  const colorRow = document.createElement("div");
  colorRow.className = "ctx-item ctx-static";
  colorRow.innerHTML = `<span class="ctx-ic">${icons.palette({ size: 15 })}</span><span class="ctx-label">색상</span>`;
  colorRow.appendChild(colorWrap);
  menu.appendChild(colorRow);
  sep();
  item(icons.arrowUp({ size: 15 }), "위로 이동", () => S.moveWs(w.id, "up"));
  item(icons.arrowDown({ size: 15 }), "아래로 이동", () => S.moveWs(w.id, "down"));
  item(icons.arrowTop({ size: 15 }), "맨 위로 이동", () => S.moveWs(w.id, "top"));

  document.body.appendChild(menu);
  wsMenuEl = menu;
  // 위치(뷰포트 넘치면 보정)
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = e.clientX, y = e.clientY;
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
    try {
      rt.branch = await api.gitBranch(w.localPath || "");
    } catch (_) {}
    // 그 워크스페이스 폴더 안에서 실제로 도는 dev 서버 포트만 감지(시스템/타 폴더 포트 제외).
    try {
      rt.ports = await api.listenPorts(w.localPath || "");
    } catch (_) {}
  }
  S.emit();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
