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
import { toggleChiiDevtools, dtActive } from "./devtools.js";
import { smartAdd } from "./workspace-view.js";
import { PAGE_AGENT_JS } from "./page-agent.js";

// 원격 탈퇴 수신 — 로컬 자격 정리 후 로그인 게이트로(설정의 탈퇴 후처리와 동일 시퀀스).
async function onAccountDeleted() {
  try { await api.unpair(); } catch (_) { /* 이미 해제됐을 수 있음 */ }
  state.me = null;
  state.devices = [];
  state.daemon = await api.daemonStatus().catch(() => state.daemon);
  state.paired = !!state.daemon?.paired;
  S.emit();
}

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
    sendPresence(); // 접속 시 현재 가시 상태를 present 신호로 보고
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
      case "appearance_event":
        // 모양 설정(계정 동기화) — 다른 기기서 변경 → 즉시 반영(서버로 되밀지 않음)
        import("./theme.js").then((t) => t.applyRemoteAppearance(msg.event && msg.event.appearance)).catch(() => {});
        break;
      case "account_deleted":
        // 다른 기기에서 회원 탈퇴 — 이 PC 도 즉시 페어링 해제(데몬 정지 포함) → 로그인 게이트.
        onAccountDeleted();
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

// ── 네이티브 창 포커스(Tauri) — present 판정의 진실源 ──
//  WKWebView 의 DOM window.blur / document.hasFocus() 는 "OS 앱 전환"(예: cmux 로 전환) 시 갱신되지
//  않는다(실측: 딴 앱에서 작업 중인데 CodingPT 가 present 로 잡혀 폰 푸시가 억제됨 → PC 로만 알림).
//  Tauri 의 onFocusChanged(= NSWindow key 상태)는 앱 전환에도 정확히 바뀌므로 이걸 진실源으로 쓴다.
let _nativeFocused = true;
let _nativeFocusWired = false;
function wireNativeFocus() {
  if (_nativeFocusWired) return;
  const setF = (v) => { _nativeFocused = !!v; sendPresence(); };
  let wired = false;
  // 0) Rust WindowEvent::Focused → "cpt-focus"(가장 신뢰: NSWindow key 상태, event API 는 앱에서 검증됨)
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) { ev.listen("cpt-focus", (e) => setF(e && e.payload)); wired = true; }
  } catch (_) { /* noop */ }
  // 1) 창 객체 onFocusChanged (권장 경로)
  try {
    const tw = window.__TAURI__ && window.__TAURI__.window;
    const w = tw && tw.getCurrentWindow && tw.getCurrentWindow();
    if (w && w.onFocusChanged) {
      w.onFocusChanged(({ payload }) => setF(payload));
      if (w.isFocused) w.isFocused().then(setF).catch(() => {});
      wired = true;
    }
  } catch (_) { /* noop */ }
  // 2) 폴백 — 전역 이벤트로 tauri://focus|blur 수신(event API 는 앱에서 이미 검증됨)
  try {
    const ev = window.__TAURI__ && window.__TAURI__.event;
    if (ev && ev.listen) {
      ev.listen("tauri://focus", () => setF(true));
      ev.listen("tauri://blur", () => setF(false));
      wired = true;
    }
  } catch (_) { /* noop */ }
  if (wired) _nativeFocusWired = true; // 하나라도 배선되면 네이티브를 진실源으로
}
// "지금 실제로 최전면(key)인가" — 네이티브 우선, 미배선 시 DOM 폴백.
function isReallyFocused() {
  if (_nativeFocusWired) return _nativeFocused;
  try { return typeof document.hasFocus === "function" ? document.hasFocus() : true; } catch (_) { return true; }
}

// ── 사용자 활동 보고(ui_activity) — 원격 조작 executor 선정에 쓰이는 "이 화면을 보는 중" 신호 ──
let _activityBound = false;
let _lastActivity = 0;
function bindActivityReport() {
  if (_activityBound) return;
  _activityBound = true;
  wireNativeFocus();
  const report = () => {
    // 포커스 가드 — ui_activity 는 서버에서 foreground=true 로 취급된다. 창이 최전면이 아닐 때(딴 앱
    //  사용, 옆에 떠 있어 마우스만 지나가는 경우 등) 보내면 present 판정이 다시 켜져 폰 알림을 가로챈다.
    //  네이티브 포커스로 판정(DOM hasFocus 는 앱 전환 시 못 믿음).
    if (!isReallyFocused()) return;
    const now = Date.now();
    if (now - _lastActivity < 30000) return; // 30s 스로틀
    if (!sock || sock.readyState !== 1) return;
    _lastActivity = now;
    send(sock, { type: "ui_activity" });
  };
  window.addEventListener("keydown", report, true);
  window.addEventListener("pointerdown", report, true);
  window.addEventListener("pointermove", report, true); // 보는 중(마우스 이동)도 활성 유지 → foregroundAt 갱신
  window.addEventListener("wheel", report, true);
  // present 신호(알림 라우팅) — 네이티브 포커스 변화가 주 트리거. DOM 이벤트는 폴백(웹/미배선 대비).
  window.addEventListener("focus", sendPresence);
  window.addEventListener("blur", sendPresence);
  document.addEventListener("visibilitychange", sendPresence);
}

// 현재 "실제로 보고 있음" 여부를 present 신호로 전송. visible AND 네이티브 포커스 = present.
function sendPresence() {
  if (!sock || sock.readyState !== 1) return;
  let active = true;
  try {
    const visible = document.visibilityState === "visible";
    active = visible && isReallyFocused();
  } catch (_) { active = true; }
  send(sock, { type: "presence", active });
}

// ── ui_command 디스패처 ──
//  공통 규칙: params.ws(홈-상대 localPath)로 로컬 워크스페이스를 찾고, 활성이 아니면 setActive 먼저
//  (AI 조작을 화면에 보여주는 UX). 워크스페이스 없음/실행 실패는 executor 일 때 에러로 회신.
async function handleUiCommand(ws, msg) {
  const { uiId, cmd, params, executor } = msg;
  let res;
  try {
    if (typeof cmd === "string" && cmd.startsWith("browser.")) {
      // 프리뷰 브라우저 자동화 — 페이지 에이전트 주입 + preview_eval 결과 회수.
      res = await handleBrowserCommand(cmd.slice("browser.".length), params || {});
    } else {
      const handler = handlers[cmd];
      if (!handler) res = { ok: false, error: "알 수 없는 명령: " + cmd };
      else res = (await handler(params || {}, executor)) || { ok: true };
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

// IDE 대상 탐색(findPreviewTarget 미러) — 포커스 pane 우선, 독립 IDE pane 또는 혼합 IDE 탭.
//  반환: { leaf, tab:null } | { leaf, tab, index } | null.
function findIdeTarget(rt) {
  const check = (l) => {
    if (l.kind === "ide") return { leaf: l, tab: null };
    if (l.kind === "terminal") {
      const i = (l.tabs || []).findIndex((t) => t.kind === "ide");
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

// 표면 대상(findPreview/IdeTarget 결과) 닫기 — 독립 pane 은 통째 close, 혼합 탭은 그 탭만 제거.
//  (모바일 closeSurfaceHit 미러. Phase 1: 각 기기 로컬.)
function closeSurfaceTarget(meta, target) {
  if (!target.tab) { S.closePane(meta.id, target.leaf.id); return; }
  const pane = getPane(target.leaf.id);
  if (pane) pane.closeTab(target.index); // 마지막 탭이면 closeTab 내부에서 pane 통째 닫음
  else S.closePane(meta.id, target.leaf.id);
}

// IDE 대상의 살아있는 IdeView 인스턴스(없으면 null — 혼합 탭이 아직 한 번도 표시 안 됨 등).
function ideInstanceOf(target) {
  const pane = getPane(target.leaf.id);
  if (!pane) return null;
  if (target.tab) return target.tab.tid ? (pane._mixed?.get(target.tab.tid)?.ide || null) : null;
  return pane.ide || null;
}

// 홈-상대(IDE 내부) 경로 → ws 상대 경로(normPath 역변환) — ideList 출력용(모바일 rel 규칙과 정합).
function relPath(meta, full) {
  const root = (meta.localPath || "").replace(/\/+$/, "");
  const p = String(full || "");
  if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p.replace(/^\/+/, "");
}

// 프리뷰 대상의 표면 핸들(pvId/host/bar/title) — 없으면 surface:null(표면 미생성). target:null=프리뷰 자체 없음.
function findPreviewSurface(rt) {
  const target = findPreviewTarget(rt);
  if (!target) return { target: null, surface: null };
  const pane = getPane(target.leaf.id);
  if (!pane) return { target, surface: null };
  if (target.tab) {
    const sf = target.tab.tid ? pane._mixed?.get(target.tab.tid)?.preview : null;
    return { target, surface: sf ? { pvId: sf.id, host: sf.host, bar: sf.bar, title: target.tab.metaTitle || "" } : null };
  }
  return { target, surface: { pvId: pane._pvId, host: pane.previewHost, bar: pane.previewBar, title: pane.node.metaTitle || "" } };
}

// ── browser.* — 프리뷰 네이티브 WKWebView 자동화 ──
//  흐름: 대상 프리뷰 표면 찾기 → (조작이면) 오리진 가드 → 에이전트 주입(멱등) → 호출 → JSON 회수.
//  에이전트 메서드는 동기 반환(preview_eval 이 결과를 회수) — wait 만 여기서 500ms 폴링.

// 대상 프리뷰 표면 id — previewReload 와 동일 규칙("pv-"+tid). 혼합 탭이 아직 표시된 적 없으면
//  네이티브 webview 자체가 없으므로 에러.
function requirePreviewId(rt) {
  const target = findPreviewTarget(rt);
  if (!target) throw new Error("프리뷰 없음");
  if (target.tab && !target.tab.tid) throw new Error("프리뷰 표면 미생성(탭을 한 번 표시해야 함)");
  return target.tab ? "pv-" + target.tab.tid : "pv-" + (target.leaf.tid || target.leaf.id);
}

// 오리진 가드 — 조작(click/type/fill/eval)은 로컬 데브서버에서만 허용(외부 사이트 원격 조작 차단).
//  snapshot/get/screenshot 은 읽기 전용이라 허용.
async function assertLocalOrigin(pvId) {
  const info = await api.previewInfo(pvId);
  let host = "";
  try { host = new URL(info.url || "").hostname; } catch (_) {}
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new Error("로컬(localhost) 페이지가 아니어서 조작 거부: " + (info.url || "(URL 없음)"));
  }
}

// 에이전트 함수 1회 호출 — 주입(멱등) 후 JSON.stringify 로 감싼 결과를 회수해 파싱.
//  페이지 이동으로 에이전트가 사라져도 매 호출 재주입되므로 안전.
async function agentCall(pvId, expr) {
  await api.previewEval(pvId, PAGE_AGENT_JS);
  const js =
    "JSON.stringify((function(){try{return {ok:true,result:(" + expr + ")};}" +
    "catch(e){return {ok:false,error:String((e&&e.message)||e)};}})())";
  const raw = await api.previewEval(pvId, js);
  let out = null;
  try { out = JSON.parse(raw); } catch (_) {
    throw new Error("에이전트 응답 파싱 실패: " + String(raw).slice(0, 200));
  }
  if (!out || out.ok !== true) throw new Error((out && out.error) || "에이전트 실행 실패");
  return out.result;
}

const BROWSER_MUTATING = new Set(["click", "type", "fill", "eval"]);

async function handleBrowserCommand(op, p) {
  const { rt } = requireWs(p);
  const pvId = requirePreviewId(rt);
  // wait 도 {js} 조건은 페이지에서 임의 JS 를 돌리므로 조작과 동일하게 가드.
  if (BROWSER_MUTATING.has(op) || (op === "wait" && p.js)) await assertLocalOrigin(pvId);
  const q = (v) => JSON.stringify(v == null ? "" : String(v));
  const target = () => q(p.target || p.ref || p.selector);
  switch (op) {
    case "snapshot":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.snapshot()") };
    case "click":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.click(" + target() + ")") };
    case "type":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.type(" + target() + "," + q(p.text) + ")") };
    case "fill":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.fill(" + target() + "," + q(p.value ?? p.text) + ")") };
    case "eval":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.eval(" + q(p.js || p.code) + ")") };
    case "get":
      return { ok: true, result: await agentCall(pvId, "window.__cptAgent.get(" + q(p.what || "text") + "," + q(p.selector || "") + ")") };
    case "wait": {
      // 500ms 폴링(상한 25s) — 에이전트 wait 는 단발 검사만, 재-eval 은 여기서.
      const deadline = Date.now() + Math.min(Number(p.timeoutMs) || 25000, 25000);
      const spec = JSON.stringify({ selector: p.selector || "", text: p.text || "", js: p.js || "" });
      for (;;) {
        const r = await agentCall(pvId, "window.__cptAgent.wait(" + spec + ")").catch(() => null);
        if (r && r.ready) return { ok: true, result: { ready: true } };
        if (Date.now() >= deadline) return { ok: true, result: { ready: false, timeout: true } };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    case "screenshot": {
      const base64 = await api.previewScreenshot(pvId);
      return { ok: true, result: { format: "jpeg", base64 } };
    }
    default:
      return { ok: false, error: "알 수 없는 browser 명령: " + op };
  }
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

  // 열린 프리뷰가 있으면 그 pane 포커스+이동. 없으면 신규 생성:
  //  · executor(지금 조작 중인 기기) = 포커스 pane 우측 분할로 명시 배치(프리뷰가 잘 보이게).
  //  · 그 외 기기 = 강제 우측분할 금지, 터미널 추가와 동일 규칙(smartAdd)으로 편입
  //    (포커스 터미널 pane 있으면 혼합 프리뷰 탭, 공간 있으면 분할). 배치는 기기별 자율.
  previewOpen: async (p, executor) => {
    const { rt } = requireWs(p);
    const url = resolveUrl(p.url);
    if (!url) throw new Error("url 필요");
    const target = findPreviewTarget(rt);
    if (target) {
      navigatePreview(target, url);
      return { ok: true, paneId: target.leaf.id };
    }
    if (executor) {
      const focusId = rt.focusId || T.firstLeafId(rt.layout);
      if (!focusId) throw new Error("분할할 pane 없음");
      S.splitPane(focusId, "h", "preview", { url });
      return { ok: true, paneId: rt.focusId };
    }
    const paneId = smartAdd("preview", { url });
    return { ok: true, paneId };
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

  // 첫(포커스 우선) 프리뷰 표면(pane/혼합 탭) 닫기 — 없으면 멱등 성공. (Phase 1: 각 기기 로컬 — sid 무시)
  previewClose: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findPreviewTarget(rt);
    if (!target) return { ok: true }; // 없으면 멱등 성공
    closeSurfaceTarget(meta, target);
    return { ok: true };
  },

  // 개발자도구 토글(executor) — 보고 있는 기기의 프리뷰 인스턴스. on 생략 시 반전. 새 상태 회신.
  previewDevtools: async (p) => {
    const { rt } = requireWs(p);
    const { target, surface } = findPreviewSurface(rt);
    if (!target) throw new Error("프리뷰 없음");
    if (!surface) throw new Error("프리뷰가 아직 로드되지 않았어요");
    const on = typeof p.on === "boolean" ? p.on : undefined;
    const cur = dtActive(surface.pvId);
    const want = on === undefined ? !cur : on;
    let result = cur;
    if (want !== cur) result = await toggleChiiDevtools(surface.pvId, surface.host);
    return { ok: true, result: { on: !!result } };
  },

  // 프리뷰 현재 상태 조회(executor) — url/제목/뷰포트/기기. 표면 미로드면 url 빈 값.
  previewInfo: async (p) => {
    const { rt } = requireWs(p);
    const { target, surface } = findPreviewSurface(rt);
    if (!target) throw new Error("프리뷰 없음");
    if (!surface) return { ok: true, result: { url: "", device: "pc" } };
    const out = { url: surface.bar?.url || "", device: "pc" };
    if (surface.title) out.title = surface.title;
    const r = surface.host?.getBoundingClientRect?.();
    if (r && r.width > 2 && r.height > 2) out.viewport = { w: Math.round(r.width), h: Math.round(r.height) };
    return { ok: true, result: out };
  },

  // 첫(포커스 우선) IDE 표면(pane/혼합 탭) 닫기 — 없으면 멱등 성공. (Phase 1: 각 기기 로컬)
  ideClose: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findIdeTarget(rt);
    if (!target) return { ok: true }; // 없으면 멱등 성공
    closeSurfaceTarget(meta, target);
    return { ok: true };
  },

  // 열린 파일 탭 하나 닫기 — 첫 IDE 표면의 열린 파일에서 제거(라이브). skipped 회신.
  ideCloseFile: async (p) => {
    const { meta, rt } = requireWs(p);
    const path = normPath(meta, p.path);
    if (!path) throw new Error("path 필요");
    const target = findIdeTarget(rt);
    if (!target) throw new Error("IDE 없음");
    const ide = ideInstanceOf(target);
    const closed = ide?.closeFileByPath ? ide.closeFileByPath(path) : false;
    return { ok: true, result: { skipped: !closed } };
  },

  // 지금 열린 파일 목록(executor) — 첫 IDE 표면의 열린 파일(ws 상대 경로)+활성.
  ideList: async (p) => {
    const { meta, rt } = requireWs(p);
    const target = findIdeTarget(rt);
    if (!target) throw new Error("IDE 없음");
    const ide = ideInstanceOf(target);
    const list = ide?.listOpenFiles ? ide.listOpenFiles() : [];
    const files = list.map((f) => ({ path: relPath(meta, f.path), active: !!f.active }));
    return { ok: true, result: { files, device: "pc" } };
  },
};
