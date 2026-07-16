// ui-channel.js — 백엔드 UI 실시간 채널(WS). 알림 이벤트(notif_event) 수신 + ui_command 원격 조작.
//  · 접속 URL(티켓 포함)은 Rust(ui_stream_url)가 발급 — deviceToken 은 JS 로 노출하지 않는다.
//  · 끊기면 3~10s 백오프로 재접속(티켓 재발급). 재접속 성공 시 목록 재로드로 놓친 이벤트 보충.
//  · ui_command: back 이 보내는 화면 조작 명령 프레임을 실행하고, executor=true 면 ui_result 회신.
//    {type:'ui_command', uiId, cmd, params, executor} → {type:'ui_result', uiId, ok, result?, error?}
//  · 접속 직후 ui_hello(clientKey=deviceKey, kind:'pc'), 사용자 입력 시 ui_activity(30s 스로틀) 송신.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";
import * as T from "./tiling.js";
import { getPane, smartUrl } from "./pane.js";
import { smartAdd } from "./workspace-view.js";

let sock = null;
let retryMs = 3000;
let retryTimer = null;

export function startUiChannel() {
  bindActivityReport();
  connect();
}

async function connect() {
  clearTimeout(retryTimer);
  let url = null;
  try {
    url = await api.uiStreamUrl();
  } catch (_) {
    return scheduleRetry(); // 미페어링/서버 미가용 — 로컬 폴백으로 동작 유지
  }
  if (!url) return scheduleRetry();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (_) {
    return scheduleRetry();
  }
  sock = ws;
  ws.onopen = () => {
    retryMs = 3000;
    // 이 클라이언트 식별(원격 조작 executor 선정용) — 기기 키 재사용.
    send(ws, { type: "ui_hello", clientKey: S.deviceKey(), kind: "pc" });
    S.loadNotifications(); // 끊긴 사이 놓친 알림 보충(재접속 시에도)
  };
  ws.onmessage = (e) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "notif_event":
        if (msg.event) S.applyNotifEvent(msg.event);
        break;
      case "ui_command":
        handleUiCommand(ws, msg);
        break;
      default:
        break;
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  ws.onclose = () => {
    if (sock === ws) {
      sock = null;
      scheduleRetry();
    }
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = retryMs;
  retryMs = Math.min(10000, Math.round(retryMs * 1.6));
  retryTimer = setTimeout(connect, wait);
}

function send(ws, frame) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  } catch (_) {}
}

// ── 사용자 활동 보고(ui_activity) — 원격 조작 executor 선정에 쓰이는 "이 화면을 보는 중" 신호 ──
let _activityBound = false;
let _lastActivity = 0;
function bindActivityReport() {
  if (_activityBound) return;
  _activityBound = true;
  const report = () => {
    const now = Date.now();
    if (now - _lastActivity < 30000) return; // 30s 스로틀
    if (!sock || sock.readyState !== 1) return;
    _lastActivity = now;
    send(sock, { type: "ui_activity" });
  };
  window.addEventListener("keydown", report, true);
  window.addEventListener("pointerdown", report, true);
}

// ── ui_command 디스패처 ──
//  공통 규칙: params.ws(홈-상대 localPath)로 로컬 워크스페이스를 찾고, 활성이 아니면 setActive 먼저
//  (AI 조작을 화면에 보여주는 UX). 워크스페이스 없음/실행 실패는 executor 일 때 에러로 회신.
async function handleUiCommand(ws, msg) {
  const { uiId, cmd, params, executor } = msg;
  let res;
  try {
    if (typeof cmd === "string" && cmd.startsWith("browser.")) {
      // 브라우저 자동화는 P4 범위 — 명시적 미구현 응답.
      res = { ok: false, error: "browser 자동화 미구현(P4)", code: "NOT_IMPLEMENTED" };
    } else {
      const handler = handlers[cmd];
      if (!handler) res = { ok: false, error: "알 수 없는 명령: " + cmd };
      else res = (await handler(params || {})) || { ok: true };
    }
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  // broadcast 명령도 executor 1곳만 회신 — executor=false 는 적용만.
  if (executor) send(ws, { type: "ui_result", uiId, ...res });
}

// cwd(홈-상대 localPath)로 로컬 워크스페이스 메타 찾기.
function wsByCwd(cwd) {
  return state.workspaces.find((w) => w.localPath === cwd) || null;
}

// 대상 워크스페이스 확보 + 활성화(setActive 는 동기 render 까지 수행 → pane DOM 접근 가능).
function requireWs(params) {
  const meta = wsByCwd(params.ws);
  if (!meta) throw new Error("워크스페이스 없음");
  if (state.activeWsId !== meta.id || state.view !== "workspace") S.setActive(meta.id);
  return { meta, rt: S.ensureRuntime(meta.id) };
}

// 워크스페이스 상대 경로 정규화 — back 이 ws 상대 경로를 줘도 홈-상대(IDE jail 기준)로 맞춘다.
function normPath(meta, path) {
  const p = String(path || "").replace(/^\/+/, "");
  if (!p) return null;
  const root = (meta.localPath || "").replace(/\/+$/, "");
  if (!root || p === root || p.startsWith(root + "/")) return p;
  return root + "/" + p;
}

// 원격 URL 해석 — ':5173'/'5173' 같은 포트 지정은 로컬 데브서버, 그 외는 스마트 주소 규칙 재사용.
function resolveUrl(raw) {
  const v = String(raw || "").trim();
  const m = /^:?(\d{2,5})$/.exec(v);
  if (m) return "http://localhost:" + m[1];
  return smartUrl(v);
}

// 레이아웃 트리 직렬화 — leaf 는 {id,kind,tabs?,active?,url?,openPath?}만(함수/DOM 없는 순수 JSON).
function serializeNode(node) {
  if (!node) return null;
  if (T.isLeaf(node)) {
    const out = { id: node.id, kind: node.kind };
    if (node.kind === "terminal") {
      out.tabs = (node.tabs || []).map((t) => {
        const tab = { kind: t.kind || "term" };
        if (typeof t.win === "number") tab.win = t.win;
        if (t.title) tab.title = t.title;
        if (t.url) tab.url = t.url;
        if (t.openPath) tab.openPath = t.openPath;
        return tab;
      });
      out.active = node.active || 0;
    }
    if (node.url) out.url = node.url;
    if (node.openPath) out.openPath = node.openPath;
    return out;
  }
  return { dir: node.dir, ratio: node.ratio, first: serializeNode(node.first), second: serializeNode(node.second) };
}

// 프리뷰 대상 탐색 — 포커스 pane 우선, 독립 프리뷰 pane 또는 혼합 프리뷰 탭.
//  반환: { leaf, tab:null } | { leaf, tab, index } | null.
function findPreviewTarget(rt) {
  const check = (l) => {
    if (l.kind === "preview") return { leaf: l, tab: null };
    if (l.kind === "terminal") {
      const i = (l.tabs || []).findIndex((t) => t.kind === "preview");
      if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
    }
    return null;
  };
  let hit = null;
  const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
  if (focusLeaf) hit = check(focusLeaf);
  if (!hit) T.eachLeaf(rt.layout, (l) => { if (!hit) hit = check(l); });
  return hit;
}

// 프리뷰 대상에 URL 이동 — pane/PreviewSurface 의 onNavigate 경로와 동일하게 상태·키를 갱신.
function navigatePreview(target, url) {
  const pane = getPane(target.leaf.id);
  if (target.tab) {
    // 혼합 프리뷰 탭 — url 먼저 반영 후 탭 활성화(표면 미생성이면 showActiveTab 이 url 로 생성).
    target.tab.url = url;
    target.leaf.active = target.index;
    pane?.buildHead();
    pane?.showActiveTab?.();
    const sf = target.tab.tid ? pane?._mixed?.get(target.tab.tid)?.preview : null;
    if (sf) {
      sf.url = url;
      sf._key = ""; // 강제 재동기화(웹뷰 없으면 생성, 있으면 재고정)
      api.previewNavigate(sf.id, url).catch(() => {});
    }
  } else if (pane) {
    // 독립 프리뷰 pane — _buildFrame onNavigate 와 동일 절차.
    pane.node.url = url;
    pane.previewUrl = url;
    pane._previewKey = "";
    api.previewNavigate(pane._pvId, url).catch(() => {});
  }
  S.focusPane(target.leaf.id);
  S.emit();
}

const PANE_TYPES = ["terminal", "ide", "preview"];

// 명령 → 핸들러. 반환 객체가 ui_result 프레임에 그대로 병합된다({ok, ...}).
const handlers = {
  // 풀 변경 통지 — 즉시 리컨실(공유 터미널 풀 ↔ 레이아웃 동기화).
  "pool.changed": async () => {
    await S.reconcilePool();
    return { ok: true };
  },

  // 작업 상태 스트림 — cwd 키로 저장만(사이드바 뱃지 표시). 활성 전환은 하지 않는다(수동적 갱신).
  "status.changed": async (p) => {
    if (!p.ws) throw new Error("ws 필요");
    S.setWsStatus(p.ws, { status: p.status || [], progress: p.progress ?? null, logTail: p.logTail || "" });
    return { ok: true };
  },

  // 서버 워크스페이스 id 로 활성 전환.
  wsSelect: async (p) => {
    const meta = state.workspaces.find((w) => w.id === p.id);
    if (!meta) throw new Error("워크스페이스 없음");
    S.setActive(meta.id);
    return { ok: true };
  },

  // 현재 레이아웃 트리 회신(순수 JSON).
  layoutTree: async (p) => {
    const { rt } = requireWs(p);
    return { ok: true, result: { tree: serializeNode(rt.layout), focusId: rt.focusId || null, device: "pc" } };
  },

  // pane 분할 — paneId 생략 시 포커스 pane. 터미널={win:'new'}, preview=url, ide=openPath.
  layoutSplit: async (p) => {
    const { meta, rt } = requireWs(p);
    if (!PANE_TYPES.includes(p.type)) throw new Error("알 수 없는 type: " + p.type);
    const targetId = p.paneId || rt.focusId || T.firstLeafId(rt.layout);
    if (!targetId) throw new Error("분할할 pane 없음");
    if (!T.findLeaf(rt.layout, targetId)) throw new Error("pane 없음: " + targetId);
    const dir = p.direction === "v" || p.direction === "down" || p.direction === "bottom" ? "v" : "h";
    const opts =
      p.type === "preview" ? { url: p.url ? resolveUrl(p.url) : "" }
      : p.type === "ide" ? { openPath: normPath(meta, p.path) }
      : { fresh: true };
    S.splitPane(targetId, dir, p.type, opts);
    return { ok: true, paneId: rt.focusId };
  },

  // 포커스 pane 기준 자동 배치(헤더 통합 추가와 동일 규칙 — smartAdd 재사용).
  newPane: async (p) => {
    const { meta } = requireWs(p);
    if (!PANE_TYPES.includes(p.type)) throw new Error("알 수 없는 type: " + p.type);
    const extra =
      p.type === "preview" ? { url: p.url ? resolveUrl(p.url) : "" }
      : p.type === "ide" ? { openPath: normPath(meta, p.path) }
      : undefined;
    const paneId = smartAdd(p.type, extra);
    if (!paneId) throw new Error("pane 생성 실패");
    return { ok: true, paneId };
  },

  // pane 포커스 — 없으면 무시.
  focusPane: async (p) => {
    const { rt } = requireWs(p);
    if (!p.paneId || !T.findLeaf(rt.layout, p.paneId)) return { ok: true, skipped: true };
    S.focusPane(p.paneId);
    getPane(p.paneId)?.focus?.();
    return { ok: true };
  },

  // pane 닫기.
  closeSurface: async (p) => {
    const { meta, rt } = requireWs(p);
    if (!p.paneId || !T.findLeaf(rt.layout, p.paneId)) throw new Error("pane 없음: " + (p.paneId || ""));
    S.closePane(meta.id, p.paneId);
    return { ok: true };
  },

  // branch 분할 비율 조정 — path 는 루트부터 'first'|'second' 배열.
  setRatio: async (p) => {
    requireWs(p);
    if (!Array.isArray(p.path)) throw new Error("path 는 branch 경로 배열");
    const ratio = Number(p.ratio);
    if (!isFinite(ratio)) throw new Error("ratio 필요");
    S.setRatio(p.path, ratio);
    return { ok: true };
  },

  // 열린 프리뷰가 있으면 그 pane 포커스+이동, 없으면 포커스 pane 우측 분할로 프리뷰 생성.
  previewOpen: async (p) => {
    const { rt } = requireWs(p);
    const url = resolveUrl(p.url);
    if (!url) throw new Error("url 필요");
    const target = findPreviewTarget(rt);
    if (target) {
      navigatePreview(target, url);
      return { ok: true, paneId: target.leaf.id };
    }
    const focusId = rt.focusId || T.firstLeafId(rt.layout);
    if (!focusId) throw new Error("분할할 pane 없음");
    S.splitPane(focusId, "h", "preview", { url });
    return { ok: true, paneId: rt.focusId };
  },

  // 첫(포커스 우선) 프리뷰 대상에 URL 이동.
  previewNavigate: async (p) => {
    const { rt } = requireWs(p);
    const url = resolveUrl(p.url);
    if (!url) throw new Error("url 필요");
    const target = findPreviewTarget(rt);
    if (!target) throw new Error("프리뷰 없음");
    navigatePreview(target, url);
    return { ok: true };
  },

  // 첫(포커스 우선) 프리뷰 새로고침.
  previewReload: async (p) => {
    const { rt } = requireWs(p);
    const target = findPreviewTarget(rt);
    if (!target) throw new Error("프리뷰 없음");
    // 혼합 탭인데 표면이 아직 없으면(한 번도 안 띄움) 새로고침 대상 없음.
    if (target.tab && !target.tab.tid) return { ok: true, skipped: true };
    const pvId = target.tab ? "pv-" + target.tab.tid : "pv-" + (target.leaf.tid || target.leaf.id);
    api.previewControl(pvId, "reload").catch(() => {});
    return { ok: true };
  },

  // IDE 로 파일 열기 — 기존 IDE(pane/혼합 탭) 재사용, 없으면 IDE pane 분할 생성.
  ideOpen: async (p) => {
    const { meta, rt } = requireWs(p);
    const path = normPath(meta, p.path);
    if (!path) throw new Error("path 필요");
    const line = p.line || null;
    const check = (l) => {
      if (l.kind === "ide") return { leaf: l, tab: null };
      if (l.kind === "terminal") {
        const i = (l.tabs || []).findIndex((t) => t.kind === "ide");
        if (i >= 0) return { leaf: l, tab: l.tabs[i], index: i };
      }
      return null;
    };
    let target = null;
    const focusLeaf = rt.focusId ? T.findLeaf(rt.layout, rt.focusId) : null;
    if (focusLeaf) target = check(focusLeaf);
    if (!target) T.eachLeaf(rt.layout, (l) => { if (!target) target = check(l); });
    if (!target) {
      const focusId = rt.focusId || T.firstLeafId(rt.layout);
      if (!focusId) throw new Error("분할할 pane 없음");
      S.splitPane(focusId, "h", "ide", { openPath: path });
      return { ok: true, paneId: rt.focusId };
    }
    const pane = getPane(target.leaf.id);
    if (target.tab) {
      // 혼합 IDE 탭 활성화 → 본문(IdeView) 보장 후 파일 열기.
      target.leaf.active = target.index;
      pane?.buildHead();
      pane?.showActiveTab?.(); // _ensureMixed 가 tid 부여 + IdeView 생성
      const m = target.tab.tid ? pane?._mixed?.get(target.tab.tid) : null;
      m?.ide?.openFile(path, line);
    } else {
      pane?.ide?.openFile(path, line);
    }
    S.focusPane(target.leaf.id);
    S.emit();
    return { ok: true, paneId: target.leaf.id };
  },
};
