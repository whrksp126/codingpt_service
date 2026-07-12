// sidebar.js — 좌측: 상단 컨트롤(사이드바 토글·알림·새 워크스페이스) + 워크스페이스 목록 + 하단 내 정보.
import { state, isLocal } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { renderNotifPanel, jumpLatestUnread } from "./notifications.js";

let el = null;
let notifPanel = null;
let notifOpen = false;

export function mountSidebar(container) {
  el = container;
  el.className = "sidebar";
  notifPanel = document.createElement("div");
  notifPanel.className = "notif-panel hidden";
  document.body.appendChild(notifPanel);
  document.addEventListener("mousedown", (e) => {
    if (notifOpen && !notifPanel.contains(e.target) && !e.target.closest?.(".bell")) closeNotif();
  });
}

export function jumpToNotification(n) {
  S.setActive(n.wsId);
  if (n.paneId) S.focusPane(n.paneId);
  closeNotif();
}
export function toggleLatestUnread() {
  jumpLatestUnread((n) => jumpToNotification(n));
}

function openNotif() {
  notifOpen = true;
  notifPanel.classList.remove("hidden");
  renderNotifPanel(notifPanel, (n) => jumpToNotification(n));
  const bell = el.querySelector(".bell");
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

  // 상단 컨트롤(트래픽 라이트 여백 + 토글/알림/추가). 드래그 영역.
  const top = document.createElement("div");
  top.className = "sb-top";
  top.setAttribute("data-tauri-drag-region", "");
  const toggle = ctlBtn("sidebar", "사이드바 접기", () => S.toggleSidebar());
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
  const add = ctlBtn("plus", "새 워크스페이스", () => S.createLocalWorkspace());
  if (state.creatingWs) add.classList.add("busy");
  top.append(toggle, bell, add);
  el.appendChild(top);

  // 목록.
  const list = document.createElement("div");
  list.className = "sb-list";

  if (state.wsError && !state.workspaces.length) {
    list.appendChild(note(state.paired ? "목록을 불러오지 못했습니다" : "PC를 연결하세요"));
  } else if (!state.workspaces.length) {
    list.appendChild(note("+ 로 워크스페이스를 추가하세요"));
  }
  for (const w of state.workspaces) list.appendChild(wsRow(w));
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

function ctlBtn(iconName, title, onClick) {
  const b = document.createElement("button");
  b.className = "ic-btn";
  b.title = title;
  b.innerHTML = icons[iconName]({ size: 17 });
  b.addEventListener("click", onClick);
  return b;
}
function note(text) {
  const d = document.createElement("div");
  d.className = "sb-note";
  d.textContent = text;
  return d;
}

function wsRow(w) {
  const rt = S.wsRuntime(w.id);
  const unread = S.unreadForWs(w.id);
  const local = isLocal(w);
  const row = document.createElement("button");
  row.className = "ws-row" + (w.id === state.activeWsId && state.view === "workspace" ? " active" : "");

  const name = document.createElement("div");
  name.className = "wsr-name";
  name.innerHTML = `<span>${escapeHtml(w.name || "워크스페이스")}</span>` + (unread ? `<span class="wsr-badge">${unread}</span>` : "");

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
  row.addEventListener("click", () => S.setActive(w.id));
  return row;
}

export async function refreshWsMeta() {
  for (const w of state.workspaces) {
    if (!isLocal(w)) continue;
    const rt = S.wsRuntime(w.id) || S.ensureRuntime(w.id);
    try {
      rt.branch = await api.gitBranch(w.localPath || "");
    } catch (_) {}
  }
  try {
    const ports = await api.listenPorts();
    const rt = S.wsRuntime(state.activeWsId);
    if (rt) rt.ports = ports;
  } catch (_) {}
  S.emit();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
