// 열린 포트 목록 — PC 화면.
//
// 데이터 원천은 **데몬 한 벌**이다(net.ports → proxy.js listPorts). 종전엔 PC 에 같은 판정
//  로직의 Rust 사본이 있었고, 이번에 데몬 쪽에만 프로세스 이름을 붙이면서 갈릴 뻔했다 → 사본 제거.
//  이 PC 워크스페이스면 사이드카 소켓 직결, 다른 PC 면 back 릴레이(리뷰·에뮬레이터와 같은 구조).
//
// ★ 화면 규칙 하나가 실측에서 나왔다(2026-08-04): 사용자의 dev 서버(front 3400·back 5300·admin
//  3300)는 전부 **Docker** 가 띄운다. Docker 프로세스의 작업 폴더는 워크스페이스가 아니라서
//  "이 워크스페이스" 목록에 **한 개도 안 잡힌다**. 그래서 안쪽이 비면 '다른 곳'을 접지 않고
//  펼친 채로 보여준다 — 안 그러면 이 사용자에게는 늘 빈 목록이다.
import { api } from "./api.js";
import { activeWs, isThisHost } from "./state.js";
import { icons } from "./icons.js";
import { tx } from "./text/index.js";
import { PORTS_TEXT } from "./text/ports.js";

const TX = tx(PORTS_TEXT);

function unwrap(r) {
  return (r && typeof r === "object" && r.data && typeof r.data === "object") ? r.data : r;
}

/**
 * 이 워크스페이스 기준 포트 목록. 반환 { items, others } — 둘 다 [{port,pid,command}].
 *
 * 인자는 **워크스페이스 메타** 또는 **pane ctx** 둘 다 받는다. pane 은 자기 ctx 만 들고 있고
 *  (라이브 getter 라 재클레임도 따라간다) 워크스페이스 객체를 모른다 — 주소창 드롭다운이 그 경로다.
 */
function targetOf(arg) {
  const a = arg || activeWs();
  if (a && typeof a.isLocal === "boolean") {
    // pane ctx — isLocal 이 곧 "이 PC 인가"다(workspace-view paneCtx 의 isThisHost 결과).
    return { cwd: a.localPath || "", local: a.isLocal, host: a.hostDeviceId ?? null };
  }
  return { cwd: (a && a.localPath) || "", local: isThisHost(a), host: (a && a.hostDeviceId) ?? null };
}

export async function loadPorts(wsArg) {
  const { cwd, local, host } = targetOf(wsArg);
  const r = unwrap(local
    ? await api.portsLocal({ cwd })
    : await api.previewPortsRemote(cwd, host));
  return {
    items: Array.isArray(r && r.items) ? r.items
      // 구 데몬 폴백 — 번호만 올 수 있다(추가 필드는 전부 additive 였다).
      : (Array.isArray(r && r.ports) ? r.ports.map((p) => ({ port: p, command: "" })) : []),
    others: Array.isArray(r && r.others) ? r.others : [],
  };
}

/** 포트 → 프리뷰가 열 주소. loopback 만(데몬 터널도 loopback 전용이다). */
export function portUrl(port) {
  return `http://localhost:${port}`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 포트 드롭다운. "웹뷰 추가" 버튼과 빈 프리뷰의 "dev 열기"가 **같은 메뉴**를 연다.
 *  opts.blank 를 주면 맨 위에 [빈 웹뷰] 행을 넣는다(웹뷰 추가 버튼용).
 */
export function openPortsMenu(anchor, { ws, onPick, onBlank } = {}) {
  document.querySelectorAll(".pv-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "pv-menu";
  menu.style.minWidth = "244px";
  const close = () => { menu.remove(); document.removeEventListener("mousedown", closer, true); };
  const closer = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };

  const row = (html, onClick) => {
    const b = document.createElement("button");
    b.className = "pv-menu-item";
    b.innerHTML = html;
    b.addEventListener("click", () => { close(); onClick(); });
    menu.appendChild(b);
  };
  const head = (text, hint) => {
    const d = document.createElement("div");
    d.className = "pv-menu-head";
    d.textContent = text;
    menu.appendChild(d);
    if (hint) {
      const h = document.createElement("div");
      h.className = "pv-menu-note";
      h.textContent = hint;
      menu.appendChild(h);
    }
  };
  const note = (text) => {
    const d = document.createElement("div");
    d.className = "pv-menu-note";
    d.textContent = text;
    menu.appendChild(d);
  };
  const portRow = (p) => row(
    `<span class="pvm-ic">${icons.globe({ size: 15 })}</span>`
    + `<span class="pvm-label">${p.port}</span>`
    + (p.command ? `<span class="pvm-hint">${esc(p.command)}</span>` : ""),
    () => onPick?.(p.port),
  );

  const paint = (data) => {
    menu.innerHTML = "";
    if (onBlank) {
      row(`<span class="pvm-ic">${icons.plus({ size: 15 })}</span><span class="pvm-label">${esc(TX.blank)}</span>`,
        () => onBlank());
      const div = document.createElement("div");
      div.className = "pv-menu-div";
      menu.appendChild(div);
    }
    if (!data) { note(TX.loading); return; }
    const { items, others } = data;
    if (!items.length && !others.length) {
      note(TX.empty);
      note(TX.emptyHint);
      return;
    }
    if (items.length) {
      head(TX.thisWorkspace);
      items.forEach(portRow);
    }
    if (others.length) {
      // 안쪽이 비면 이게 유일한 목록이다 — 제목만 달고 그대로 보여준다(접지 않는다).
      head(TX.elsewhere, items.length ? null : TX.elsewhereHint);
      others.forEach(portRow);
    }
  };

  paint(null);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.right = Math.max(6, window.innerWidth - r.right) + "px";
  menu.style.maxHeight = "min(60vh, 420px)";
  menu.style.overflowY = "auto";
  document.body.append(menu);
  setTimeout(() => document.addEventListener("mousedown", closer, true), 0);
  loadPorts(ws)
    .then((d) => { if (menu.isConnected) paint(d); })
    .catch(() => { if (menu.isConnected) { menu.innerHTML = ""; note(TX.failed); } });
}

/**
 * 주소창 드롭다운에 얹을 포트 항목. 타이핑 중이면 그 문자열로 거른다(숫자를 치면 포트가 좁혀진다).
 *  실패는 빈 배열 — 주소창은 포트를 못 읽는다고 멈추면 안 된다(기록·검색 추천은 그대로 떠야 한다).
 */
export async function portSuggestItems(ws, q) {
  let data;
  try { data = await loadPorts(ws); } catch (_) { return []; }
  const all = [...data.items, ...data.others.map((p) => ({ ...p, other: true }))];
  const needle = String(q || "").trim().toLowerCase();
  const hit = needle
    ? all.filter((p) => String(p.port).includes(needle) || (p.command || "").toLowerCase().includes(needle))
    : all;
  return hit.slice(0, 8).map((p) => ({ kind: "p", port: p.port, command: p.command || "", other: !!p.other }));
}

export const PORTS_TX = TX;
