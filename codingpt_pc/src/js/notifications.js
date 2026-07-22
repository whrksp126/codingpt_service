// notifications.js — OSC 9/777/99·벨 → 서버 알림 기록 + 네이티브 알림 + pane 링 + 알림 패널.
//  알림 원천 = 백엔드(/api/notifications) 미러(state.notifications) — 전 기기 동기화.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";

// 터미널 OSC/벨 → 서버에 기록(reportNotification — 실패 시 로컬 폴백) + 즉시 피드백(pane 링).
//  win = 발생한 터미널의 풀 window 인덱스(스코프 읽음 처리·점프의 키).
//  OS 네이티브 알림은 새 알림이 state 에 편입되는 단일 지점(state.maybeOsNotify — 창 비포커스 시)에서만
//  발송한다 → 여기서 직접 api.notify 를 부르지 않아 이중 발송이 없다.
export function handleOsc(ws, paneId, win, title, body) {
  const t = (title || "").trim() || ws?.name || "CodingPT";
  const b = (body || "").trim();
  S.reportNotification({
    source: "osc",
    workspaceId: ws?.id,
    wsName: ws?.name,
    cwd: ws?.localPath,
    win: typeof win === "number" ? win : undefined,
    title: t,
    body: b,
  });
  flashPane(paneId);
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

// 알림 1건 읽음 — 낙관 반영 + 서버(숫자 id = 서버 행일 때만. 문자열 id 는 로컬 폴백분).
export function readNotif(n) { readOne(n); }
function readOne(n) {
  if (!n.read) {
    n.read = true;
    if (typeof n.id === "number") api.notifRead({ ids: [n.id] }).catch(() => {});
    S.emit();
  }
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
    // 워크스페이스 이름 — 서버 행의 wsName 우선, 없으면 목록에서 역참조.
    const ws = state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId));
    const wsName = n.wsName || ws?.name || "";
    const row = document.createElement("button");
    row.className = "notif-row" + (n.read ? "" : " unread");
    row.innerHTML =
      `<div class="notif-title">${escapeHtml(n.title)}</div>` +
      (n.subtitle ? `<div class="notif-sub">${escapeHtml(n.subtitle)}</div>` : "") +
      (n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : "") +
      `<div class="notif-meta">${wsName ? escapeHtml(wsName) + " · " : ""}${fmtTime(n.createdAt || n.ts)}</div>`;
    row.addEventListener("click", () => {
      readOne(n);
      onJump?.(n);
    });
    el.appendChild(row);
  }
}

// 오버레이용 알림 패널 요소 빌드 — 디자인(클래스)은 renderNotifPanel 과 동일. 액션은 tag 로 등록.
//  handlers: { tag(node,fn,keep), onRow(n), onMarkAll() }
export function buildNotifPanelEl({ tag, onRow, onMarkAll }) {
  const el = document.createElement("div");
  el.className = "notif-panel";
  const head = document.createElement("div");
  head.className = "notif-head";
  head.innerHTML = "<span>알림</span>";
  const clear = document.createElement("button");
  clear.className = "btn small ghost";
  clear.textContent = "모두 읽음";
  tag(clear, onMarkAll, true); // keep: 갱신 후에도 패널 유지
  head.appendChild(clear);
  el.appendChild(head);
  if (!state.notifications.length) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = "알림이 없습니다";
    el.appendChild(empty);
    return el;
  }
  for (const n of state.notifications.slice(0, 40)) {
    const ws = state.workspaces.find((w) => w.id === (n.workspaceId ?? n.wsId));
    const wsName = n.wsName || ws?.name || "";
    const row = document.createElement("button");
    row.className = "notif-row" + (n.read ? "" : " unread");
    row.innerHTML =
      `<div class="notif-title">${escapeHtml(n.title)}</div>` +
      (n.subtitle ? `<div class="notif-sub">${escapeHtml(n.subtitle)}</div>` : "") +
      (n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : "") +
      `<div class="notif-meta">${wsName ? escapeHtml(wsName) + " · " : ""}${fmtTime(n.createdAt || n.ts)}</div>`;
    tag(row, () => onRow(n));
    el.appendChild(row);
  }
  return el;
}

export function jumpLatestUnread(onJump) {
  const n = state.notifications.find((x) => !x.read);
  if (n) {
    readOne(n);
    onJump?.(n);
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
