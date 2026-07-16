// devtools.js — 프리뷰 개발자 도구를 모바일과 동일한 "진짜 Chrome DevTools"(chii 프론트엔드 +
//  페이지 내 CDP 구현 chobitsu)로 통일한다. (기존 네이티브 WebKit 인스펙터는 ⌥클릭 고급 경로로 유지)
//
//  구조(모바일 PaneView 데브툴 이식 — 실제 Chrome 임베더 아키텍처):
//   · DevTools 프론트엔드 = 메인 창 DOM 의 iframe(srcdoc, <base>=CDN) — pane 본문(previewHost) 전체를 덮음.
//   · 프론트엔드가 setInspectedPageBounds 로 "페이지가 놓일 영역"을 알려주면, 그 rect 에 슬롯(div)을
//     놓고 네이티브 프리뷰 webview 를 그 슬롯 위치로 동기화한다(도킹 UI/divider 는 DevTools 자체).
//   · CDP 릴레이: 프론트엔드 FakeWebSocket.send → postMessage → preview_eval(chobitsu.sendRawMessage)
//     / 페이지 chobitsu 출력 → 페이지 내 큐(__cptCdpQ) → preview_eval 폴링(120ms) → __cptDeliver.
//   · 페이지 리로드 시: chobitsu 재주입 + 켜져 있던 *.enable 리플레이(응답 드랍) + documentUpdated 통지.
import { api } from "./api.js";

const CDN_CHOBITSU = "https://cdn.jsdelivr.net/npm/chobitsu@1.8.6";
const CDN_CHII_FE = "https://cdn.jsdelivr.net/npm/chii@1.15.5/public/front_end/";
const REPLAY_ID_BASE = 900000000; // 리플레이 응답 식별 대역(프론트엔드로 안 보내고 드랍)

let chobitsuSrc = null;
async function loadChobitsu() {
  if (chobitsuSrc) return chobitsuSrc;
  try {
    const r = await fetch(CDN_CHOBITSU);
    if (!r.ok) return null;
    chobitsuSrc = await r.text();
  } catch (_) { return null; }
  return chobitsuSrc;
}

// 프리뷰 페이지 부트 — chobitsu 로드 + 나가는 CDP 를 페이지 내 큐로(메인 JS 가 폴링 드레인).
function chobitsuBootJs(src) {
  return (
    "(function(){if(window.__cptCdp)return;try{" + src +
    "\n;window.__cptCdp=1;window.__cptCdpQ=[];window.chobitsu.setOnMessage(function(s){window.__cptCdpQ.push(String(s));});" +
    "}catch(e){}})();0"
  );
}
const DRAIN_JS = "JSON.stringify(window.__cptCdpQ?window.__cptCdpQ.splice(0,window.__cptCdpQ.length):[])";

// DevTools 프론트엔드 브리지 — chii_app.html 최상단 삽입(모바일 DEVTOOLS_BRIDGE 의 PC 판):
//  ① ?ws=cpt 위장 → WebSocket 트랜스포트 선택 ② WebSocket → parent postMessage 릴레이
//  ③ __cptDeliver = 페이지→프론트엔드 CDP 진입점 ④ setInspectedPageBounds → bounds 통지
//  (모바일 전용이던 합성 포인터 리사이저/두꺼운 손잡이/customElement 폴리필은 PC에 불필요·유해라 제외)
const DT_BRIDGE = `<script>
(function(){
  function post(m) { try { parent.postMessage(Object.assign({ __cptDt: '' }, m), '*'); } catch (e) {} }
  var biv = setInterval(function () {
    var h = window.InspectorFrontendHost;
    if (!h || !h.setInspectedPageBounds || h.__cptPatched) return;
    h.__cptPatched = true;
    clearInterval(biv);
    var ob = h.setInspectedPageBounds.bind(h);
    h.setInspectedPageBounds = function (b) { post({ __cptDt: 'bounds', b: b }); return ob(b); };
    // 도킹 툴바의 ✕(임베더 창 닫기) → 패널 닫기.
    h.closeWindow = function () { post({ __cptDt: 'dock', side: 'undocked' }); };
  }, 50);
  try { localStorage.setItem('uiTheme', '"dark"'); } catch (e) {}
  try { if (localStorage.getItem('currentDockState') === '"undocked"') localStorage.setItem('currentDockState', '"bottom"'); } catch (e) {}
  try {
    var ols = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      ols.call(this, k, v);
      if (k === 'currentDockState') { try { post({ __cptDt: 'dock', side: JSON.parse(v) }); } catch (e) {} }
    };
  } catch (e) {}
  try { window.open = function () { return null; }; } catch (e) {}
  // screencast 토글(프리뷰가 바로 옆이라 무용)과 undock 메뉴(별도 창 없음) 숨김 — shadow DOM 포함 스캔.
  function sweep(root) {
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var a = (el.getAttribute && el.getAttribute('aria-label')) || '';
      if (a && (a === 'Toggle screencast' || /undock|도킹 해제/i.test(a))) el.style.display = 'none';
      if (el.shadowRoot) sweep(el.shadowRoot);
    }
  }
  setInterval(function () { try { sweep(document); } catch (e) {} }, 1200);
  document.addEventListener('click', function () { setTimeout(function () { try { sweep(document); } catch (e) {} }, 60); }, true);
  history.replaceState(null, '', location.pathname + '?ws=cpt&can_dock=true');
  function FakeWS(url) {
    var self = this;
    this.url = String(url || '');
    this.readyState = 0;
    this._ls = { open: [], message: [], close: [], error: [] };
    window.__cptWs = this;
    setTimeout(function () {
      self.readyState = 1;
      var ev = { type: 'open', target: self };
      if (self.onopen) self.onopen(ev);
      self._ls.open.slice().forEach(function (f) { try { f(ev); } catch (e) {} });
      post({ __cptDt: 'open' });
    }, 30);
  }
  FakeWS.prototype.send = function (d) { post({ __cptDt: 'cdp', data: String(d) }); };
  FakeWS.prototype.close = function () { this.readyState = 3; };
  FakeWS.prototype.addEventListener = function (t, f) { (this._ls[t] = this._ls[t] || []).push(f); };
  FakeWS.prototype.removeEventListener = function (t, f) { var a = this._ls[t] || []; var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); };
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.__cptDeliver = function (d) {
    var ws = window.__cptWs;
    if (!ws || ws.readyState !== 1) return;
    var ev = { type: 'message', data: d, target: ws };
    if (ws.onmessage) ws.onmessage(ev);
    (ws._ls.message || []).slice().forEach(function (f) { try { f(ev); } catch (e) {} });
  };
})();
</` + `script>`;

let chiiHtml = null;
async function loadChiiHtml() {
  if (chiiHtml) return chiiHtml;
  try {
    const r = await fetch(CDN_CHII_FE + "chii_app.html");
    if (!r.ok) return null;
    const raw = await r.text();
    // srcdoc 은 상대경로 기준이 없다 → <base> 로 CDN 을 기준 삼아 모듈 스크립트를 해석시킨다.
    chiiHtml = raw.replace('<meta charset="utf-8">', `<meta charset="utf-8"><base href="${CDN_CHII_FE}">` + DT_BRIDGE);
  } catch (_) { return null; }
  return chiiHtml;
}

// pvId → 세션 { host, wrap, iframe, slot, active, poll, enableLog, replayId }
const sessions = new Map();

// pane 동기화 tick 이 프리뷰 webview 를 놓을 기준 요소 — 데브툴이 열려 있으면 슬롯(bounds), 아니면 null.
export function dtPageSlot(pvId) {
  const s = sessions.get(pvId);
  return s && s.active && s.boundsSeen ? s.slot : null;
}
export function dtActive(pvId) {
  const s = sessions.get(pvId);
  return !!(s && s.active);
}

async function injectChobitsu(pvId) {
  const src = await loadChobitsu();
  const s = sessions.get(pvId);
  if (!src || !s || !s.active) return;
  try { await api.previewEval(pvId, chobitsuBootJs(src)); } catch (_) {}
}

// 페이지가 새 문서를 로드했을 때(내비게이션/리로드) DevTools 를 리로드 없이 재동기화.
export async function dtOnPageLoaded(pvId) {
  const s = sessions.get(pvId);
  if (!s || !s.active) return;
  await injectChobitsu(pvId);
  for (const raw of s.enableLog.values()) {
    try {
      const m = JSON.parse(raw);
      m.id = s.replayId++;
      await api.previewEval(pvId, "window.chobitsu&&window.chobitsu.sendRawMessage(" + JSON.stringify(JSON.stringify(m)) + ");0");
    } catch (_) {}
  }
  for (const msg of ['{"method":"Runtime.executionContextsCleared","params":{}}', '{"method":"DOM.documentUpdated","params":{}}']) {
    try { s.iframe?.contentWindow?.__cptDeliver?.(msg); } catch (_) {}
  }
}

function startPoll(s) {
  stopPoll(s);
  let busy = false;
  s.poll = setInterval(async () => {
    if (!s.active || busy) return;
    busy = true;
    try {
      const out = await api.previewEval(s.pvId, DRAIN_JS);
      const arr = JSON.parse(String(out || "[]"));
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const str = String(raw);
          try {
            const m = JSON.parse(str);
            if (m && typeof m.id === "number" && m.id >= REPLAY_ID_BASE) continue; // 리플레이 응답 드랍
          } catch (_) {}
          try { s.iframe?.contentWindow?.__cptDeliver?.(str); } catch (_) {}
        }
      }
    } catch (_) { /* webview 미생성/이동 중 */ }
    busy = false;
  }, 120);
}
function stopPoll(s) {
  if (s.poll) { clearInterval(s.poll); s.poll = null; }
}

function onFrameMessage(s, d) {
  if (!d || typeof d.__cptDt !== "string") return;
  if (d.__cptDt === "open") {
    void injectChobitsu(s.pvId); // 프론트엔드 접속 시점에 페이지 쪽 CDP 준비 보장
  } else if (d.__cptDt === "cdp") {
    const data = String(d.data);
    try {
      const m = JSON.parse(data);
      if (m && typeof m.method === "string" && m.method.endsWith(".enable")) s.enableLog.set(m.method, data);
    } catch (_) {}
    api.previewEval(s.pvId, "window.chobitsu&&window.chobitsu.sendRawMessage(" + JSON.stringify(data) + ");0").catch(() => {});
  } else if (d.__cptDt === "bounds") {
    const b = d.b || {};
    if ([b.x, b.y, b.width, b.height].every((n) => typeof n === "number")) {
      s.boundsSeen = true;
      s.slot.style.left = b.x + "px";
      s.slot.style.top = b.y + "px";
      s.slot.style.width = b.width + "px";
      s.slot.style.height = b.height + "px";
    }
  } else if (d.__cptDt === "dock") {
    if (String(d.side) === "undocked") setDtVisible(s, false); // undock = 패널 닫기
  }
}

function setDtVisible(s, on) {
  s.active = on;
  s.wrap.style.display = on ? "" : "none";
  s.slot.style.display = on ? "" : "none";
  if (on) startPoll(s); else stopPoll(s);
}

// 토글 — host: .preview-host 요소(프리뷰 webview 가 이 rect 를 따라다님).
export async function toggleChiiDevtools(pvId, host) {
  let s = sessions.get(pvId);
  if (s && s.iframe) {
    setDtVisible(s, !s.active);
    return s.active;
  }
  const html = await loadChiiHtml();
  if (!html) return false;
  s = { pvId, host, active: true, poll: null, enableLog: new Map(), replayId: REPLAY_ID_BASE, boundsSeen: false };
  sessions.set(pvId, s);
  host.style.position = "relative";
  // 프론트엔드 iframe — host 전체를 덮는다(빈 영역=페이지 자리, 그 위에 네이티브 프리뷰가 겹침).
  const wrap = document.createElement("div");
  wrap.className = "cpt-dt-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "cpt-dt-frame";
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");
  wrap.appendChild(iframe);
  // 페이지 슬롯 — setInspectedPageBounds rect(host 기준 좌표)에 놓이는 투명 기준 요소.
  const slot = document.createElement("div");
  slot.className = "cpt-dt-slot";
  host.append(wrap, slot);
  s.wrap = wrap;
  s.iframe = iframe;
  s.slot = slot;
  s.msgHandler = (e) => { if (e.source === iframe.contentWindow) onFrameMessage(s, e.data); };
  window.addEventListener("message", s.msgHandler);
  iframe.srcdoc = html;
  setDtVisible(s, true);
  void injectChobitsu(pvId);
  return true;
}

// 표면 폐기(웹뷰 닫힘/탭 이동) — 세션 정리. keep=true 면(웹뷰 승계) 세션도 유지.
export function dtDispose(pvId, keep) {
  if (keep) return;
  const s = sessions.get(pvId);
  if (!s) return;
  stopPoll(s);
  window.removeEventListener("message", s.msgHandler);
  s.wrap?.remove();
  s.slot?.remove();
  sessions.delete(pvId);
}
