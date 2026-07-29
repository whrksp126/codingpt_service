// notifications.js — OSC 9/777/99·벨 → 서버 알림 기록 + 네이티브 알림 + pane 링 + 알림 패널.
//  알림 원천 = 백엔드(/api/notifications) 미러(state.notifications) — 전 기기 동기화.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";
import { icons } from "./icons.js";
import { approvalForNotif, isChoiceApproval } from "./approvals.js";
import { notifBodyText } from "./e2ee.js";

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
    // 승인 알림은 인박스에서도 바로 응답할 수 있어야 한다(알림 패널이 유일한 진입점인 경우가 있다).
    //  아직 대기 중인 승인(state.approvals 에 있는 것)만 버튼을 붙이고, 해소된 건 회색 처리.
    const appr = n.kind === "approval_request" ? approvalForNotif(n) : null;
    //  기기 승인(계정 로그인 확인)도 **알림 행에서 바로** 처리한다(2026-07-28 사용자 요구: "알림이
    //   오면 그 알림 목록 내부에서 승인 거절 할 수 있으면 좋겠는데?"). 대기 목록에 없으면(이미
    //   처리·만료) 버튼을 붙이지 않는다 — 눌러도 404 인 버튼을 남기지 않는다.
    const row = document.createElement("button");
    row.className = "notif-row" + (n.read ? "" : " unread") + (n.kind === "approval_request" ? " approval" : "") + (n.kind === "approval_request" && !appr ? " resolved" : "");
    row.innerHTML =
      `<div class="notif-title">${n.kind === "approval_request" || n.kind === "device_approval" ? `<span class="notif-ic">${icons.shield({ size: 12 })}</span>` : ""}${escapeHtml(n.title)}</div>` +
      (n.subtitle ? `<div class="notif-sub">${escapeHtml(n.subtitle)}</div>` : "") +
      // body 가 봉인문("cptenc:1:…")이면 데몬에 복호를 요청한다(비동기 → 도착 시 emit 으로 재렌더).
      //  잠금화면/배너는 subtitle(평문)로 도달하므로 알림 자체가 무내용이 되지는 않는다.
      ((n.body ? `<div class="notif-body">${escapeHtml(notifBodyText(n.body))}</div>` : "")) +
      `<div class="notif-meta">${wsName ? escapeHtml(wsName) + " · " : ""}${fmtTime(n.createdAt || n.ts)}` +
      (n.kind === "approval_request" && !appr ? " · 종료됨" : "") + `</div>`;
    if (appr) {
      const acts = document.createElement("div");
      acts.className = "notif-acts";
      // 선택형(AskUserQuestion 등)은 선택지가 여러 개라 이 좁은 행에 담을 수 없다 → 카드로 유도.
      if (isChoiceApproval(appr)) {
        acts.innerHTML = `<span class="notif-act-hint">선택형 요청 — 카드에서 응답</span>`;
      } else {
        // 순서는 TUI/카드와 동일: 허용 → (제안이 있으면) 묻지 않기 → 거절(2026-07-29 표면 통일).
        const always = appr.alwaysLabel
          ? `<span class="notif-act" data-act="always" title="${escapeHtml(appr.alwaysLabel)}">허용하고 묻지 않기</span>`
          : "";
        acts.innerHTML =
          `<span class="notif-act primary" data-act="allow">허용</span>` +
          always +
          `<span class="notif-act ghost" data-act="deny">거절</span>`;
        acts.addEventListener("click", (e) => {
          const b = e.target.closest?.("[data-act]");
          if (!b) return;
          e.stopPropagation();
          const act = b.dataset.act;
          S.respondApproval(appr.id, act === "deny"
            ? { decision: "deny" }
            : { decision: "allow", ...(act === "always" ? { always: true } : {}) });
        });
      }
      row.appendChild(acts);
    }
    // (★ 개정 12: 알림 행 인라인 승인 삭제 — 승인 절차 자체가 없어졌다. 연동은 설정에서 코드로.)
    row.addEventListener("click", () => {
      readOne(n);
      // 기기 승인 알림을 누르면 ✕ 로 닫아 둔 카드도 다시 보여 준다 — 알림을 눌렀는데 아무 일도
      //  일어나지 않으면(카드는 닫혀 있고 이 행은 점프 대상이 없다) 사용자는 승인할 곳을 못 찾는다.
      onJump?.(n);
    });
    el.appendChild(row);
  }
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
