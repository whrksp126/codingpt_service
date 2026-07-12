// notifications.js — OSC 9/777/99·벨 → 상태 기록 + 네이티브 알림 + pane 링 + 알림 패널.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";

let lastNotifyTs = 0;

export function handleOsc(wsId, paneId, title, body) {
  const ws = state.workspaces.find((w) => w.id === wsId);
  const t = (title || "").trim() || ws?.name || "CodingPT";
  const b = (body || "").trim();
  S.pushNotification({ wsId, paneId, title: t, body: b });
  flashPane(paneId);
  const now = Date.now();
  if (now - lastNotifyTs > 400) {
    lastNotifyTs = now;
    api.notify(t, b);
  }
}

function flashPane(paneId) {
  try {
    const el = document.querySelector(`.pane[data-pane-id="${CSS.escape(paneId)}"]`);
    if (el) {
      el.classList.add("ring");
      setTimeout(() => el.classList.remove("ring"), 4000);
    }
  } catch (_) {}
}

// 알림 패널 렌더(사이드바 벨에서 토글).
export function renderNotifPanel(el, onJump) {
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notif-head";
  head.innerHTML = "<span>알림</span>";
  const clear = document.createElement("button");
  clear.className = "btn small ghost";
  clear.textContent = "모두 읽음";
  clear.addEventListener("click", () => {
    S.markAllRead();
    renderNotifPanel(el, onJump);
  });
  head.appendChild(clear);
  el.appendChild(head);

  if (!state.notifications.length) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = "알림이 없습니다";
    el.appendChild(empty);
    return;
  }
  for (const n of state.notifications.slice(0, 40)) {
    const ws = state.workspaces.find((w) => w.id === n.wsId);
    const row = document.createElement("button");
    row.className = "notif-row" + (n.read ? "" : " unread");
    row.innerHTML =
      `<div class="notif-title">${escapeHtml(n.title)}</div>` +
      (n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : "") +
      `<div class="notif-meta">${ws ? escapeHtml(ws.name) : ""} · ${fmtTime(n.ts)}</div>`;
    row.addEventListener("click", () => {
      n.read = true;
      onJump?.(n);
    });
    el.appendChild(row);
  }
}

export function jumpLatestUnread(onJump) {
  const n = state.notifications.find((x) => !x.read);
  if (n) {
    n.read = true;
    onJump?.(n);
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
