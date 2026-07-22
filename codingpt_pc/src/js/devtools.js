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
  // 일부 페이지(구글 등)는 WKWebView 에서 localStorage 접근이 SecurityError("operation is insecure")라
  //  chobitsu 부트가 통째로 죽는다 → 접근 불가면 무해한 스텁으로 대체하고 부트를 계속한다.
  const lsShim =
    "try{localStorage.length}catch(e){try{var __n={getItem:function(){return null},setItem:function(){},removeItem:function(){},clear:function(){},key:function(){return null},length:0};" +
    "Object.defineProperty(window,'localStorage',{value:__n});Object.defineProperty(window,'sessionStorage',{value:__n})}catch(_){}}\n";
  return (
    "(function(){if(window.__cptCdp)return;try{" + lsShim + src +
    "\n;window.__cptCdp=1;window.__cptCdpQ=[];window.chobitsu.setOnMessage(function(s){window.__cptCdpQ.push(String(s));});" +
    "}catch(e){window.__cptCdpErr=String(e&&(e.message||e)).slice(0,200)}})();0"
  );
}
const DRAIN_JS = "JSON.stringify(window.__cptCdpQ?window.__cptCdpQ.splice(0,window.__cptCdpQ.length):[])";

// pvId → 세션 { host, wrap, iframe, slot, active, mode:'dock'|'window', poll, enableLog, replayId }
const sessions = new Map();

// 프론트엔드로 CDP 다운스트림 전달 — 도킹(iframe 직접 호출) / 별도 창(Tauri 이벤트).
function deliver(s, str) {
  if (s.mode === "window") {
    try { window.__TAURI__.event.emit("cpt-dt-in-" + s.pvId, str); } catch (_) {}
  } else {
    try { s.iframe?.contentWindow?.__cptDeliver?.(str); } catch (_) {}
  }
}

// 별도 창(Undock) 이벤트 배선 — 창의 브리지가 emit 하는 cpt-dt-out(pv 태그)과 창 파괴 통지.
let winEventsReady = false;
function initWinEvents() {
  if (winEventsReady) return;
  winEventsReady = true;
  const { listen } = window.__TAURI__.event;
  listen("cpt-dt-out", (e) => {
    const d = e.payload || {};
    const s = sessions.get(String(d.pv || ""));
    if (s && s.mode === "window") onFrameMessage(s, d);
  });
  listen("cpt-dt-closed", (e) => {
    const s = sessions.get(String(e.payload || ""));
    if (s && s.mode === "window") { s.mode = "dock"; setDtVisible(s, false); } // 창 닫힘 = 데브툴 종료
  });
}

// pane 동기화 tick 이 프리뷰 webview 를 놓을 기준 요소 — 데브툴이 열려 있으면 슬롯(bounds), 아니면 null.
export function dtPageSlot(pvId) {
  const s = sessions.get(pvId);
  return s && s.active && s.mode !== "window" && s.slot ? s.slot : null;
}
export function dtActive(pvId) {
  const s = sessions.get(pvId);
  return !!(s && s.active);
}

async function injectChobitsu(pvId) {
  const src = await loadChobitsu();
  const s = sessions.get(pvId);
  if (!s || !s.active) return;
  if (!src) { dtStatus(s, "chobitsu 소스 로드 실패(CDN)"); return; }
  try {
    await api.previewEval(pvId, chobitsuBootJs(src));
    // 주입 결과 확인 — 페이지 환경 문제(스토리지 차단 등)로 chobitsu 부트가 죽으면 사용자에게 표시.
    const chk = String(await api.previewEval(pvId, "typeof window.chobitsu + ' err=' + (window.__cptCdpErr||'-')"));
    if (!chk.startsWith("object") && !chk.startsWith("function")) dtStatus(s, "페이지 CDP 부트 실패: " + chk.slice(0, 140));
  } catch (e) {
    dtStatus(s, "주입 오류: " + String(e).slice(0, 120));
  }
}

function dtStatus(s, msg) {
  console.log("[CPT-DevTools]", msg);
  if (s.status) { s.status.textContent = msg; s.status.style.display = ""; }
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
    deliver(s, msg);
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
          deliver(s, str);
        }
      }
    } catch (_) { /* webview 미생성/이동 중 — 다음 tick 재시도 */ }
    busy = false;
  }, 120);
}
function stopPoll(s) {
  if (s.poll) { clearInterval(s.poll); s.poll = null; }
}

function onFrameMessage(s, d) {
  if (!d || typeof d.__cptDt !== "string") return;
  if (d.__cptDt === "log") {
    console.log("[CPT-DevTools]", d.msg);
    if (s.status) { s.status.textContent = String(d.msg).slice(0, 160); s.status.style.display = ""; }
  } else if (d.__cptDt === "open") {
    s.opened = true;
    if (s.status) s.status.style.display = "none";
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
      s.lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      if (s.slot) {
        s.slot.style.left = b.x + "px";
        s.slot.style.top = b.y + "px";
        s.slot.style.width = b.width + "px";
        s.slot.style.height = b.height + "px";
      }
      // punch-through: 페이지 영역만큼 iframe 을 "도넛" clip-path(evenodd — 전체 사각형 - 구멍)로
      //  잘라내 그 자리 DOM 을 비운다 → 아래층 네이티브 프리뷰가 구멍으로 비친다.
      //  일반 도킹(변에 붙은 rect)뿐 아니라 디바이스 툴바 모드(중앙에 뜬 rect)도 커버 — 디바이스
      //  프레임/눈금(데브툴 DOM)은 구멍 밖이라 그대로 보이고, 화면 영역만 뚫린다.
      if (s.iframe) {
        const W = s.iframe.clientWidth, H = s.iframe.clientHeight;
        if (W > 2 && H > 2 && b.width > 1 && b.height > 1) {
          const x = Math.max(0, b.x), y = Math.max(0, b.y);
          const w = Math.min(b.width, W - x), h = Math.min(b.height, H - y);
          s.iframe.style.clipPath =
            `path(evenodd, "M0 0 H${W} V${H} H0 Z M${x} ${y} h${w} v${h} h-${w} Z")`;
        } else {
          s.iframe.style.clipPath = "";
        }
      }
      recomputeEmuZoom(s);
    }
  } else if (d.__cptDt === "emu") {
    // 디바이스 툴바(모바일 에뮬레이션) — 브리지가 툴바의 크기 입력(예: 370×607)을 보고.
    //  w=0 → 디바이스 모드 꺼짐.
    s.emu = d.w > 0 && d.h > 0 ? { w: d.w, h: d.h } : null;
    recomputeEmuZoom(s);
  } else if (d.__cptDt === "docked") {
    // InspectorFrontendHost.setIsDocked — Undock 선택(false) / 별도 창에서 재도킹(true).
    if (s.mode !== "window" && d.docked === false) undockToWindow(s);
    else if (s.mode === "window" && d.docked === true) redockFromWindow(s);
  } else if (d.__cptDt === "dock") {
    const side = String(d.side);
    if (s.mode === "window") {
      // 별도 창에서 Dock side(좌/하단/우) 선택 → 창 닫고 pane 안 iframe 으로 복귀.
      //  선택한 사이드는 공유 localStorage(currentDockState)에 이미 저장돼 새 iframe 이 그대로 적용.
      if (side !== "undocked") redockFromWindow(s);
    } else if (side === "undocked") {
      undockToWindow(s); // 도킹 iframe 에서 Undock 선택 → 진짜 별도 창
    }
  } else if (d.__cptDt === "close") {
    // DevTools 자체 ✕ — 도킹이면 패널 닫기, 별도 창이면 창 닫기(파괴 통지가 세션 정리).
    if (s.mode === "window") api.devtoolsWindow(s.pvId, false).catch(() => {});
    else setDtVisible(s, false);
  }
}

// 도킹 UI(iframe/슬롯/상태줄) 생성·파괴 — undock↔재도킹에서 재사용.
function buildDockUi(s) {
  const host = s.host;
  host.style.position = "relative";
  const wrap = document.createElement("div");
  wrap.className = "cpt-dt-wrap";
  const iframe = document.createElement("iframe");
  iframe.className = "cpt-dt-frame";
  iframe.setAttribute("allow", "clipboard-read; clipboard-write");
  wrap.appendChild(iframe);
  const slot = document.createElement("div");
  slot.className = "cpt-dt-slot";
  const status = document.createElement("div");
  status.className = "cpt-dt-status";
  status.textContent = "DevTools 로딩 중…";
  wrap.appendChild(status);
  host.append(wrap, slot);
  s.wrap = wrap;
  s.iframe = iframe;
  s.slot = slot;
  s.status = status;
  s.boundsSeen = false;
  s.opened = false;
  s.msgHandler = (e) => { if (e.source === iframe.contentWindow) onFrameMessage(s, e.data); };
  window.addEventListener("message", s.msgHandler);
  iframe.src = "devtools-frame.html?ws=cpt&can_dock=true";
  setTimeout(() => {
    if (!s.opened && s.active && s.mode === "dock" && s.status) s.status.textContent = "DevTools 로드 실패 — 네트워크(CDN) 연결을 확인하세요";
  }, 8000);
}
function destroyDockUi(s) {
  if (s.msgHandler) window.removeEventListener("message", s.msgHandler);
  s.wrap?.remove();
  s.slot?.remove();
  s.wrap = s.iframe = s.slot = s.status = s.msgHandler = null;
}

// Undock — iframe 을 걷고 별도 OS 창으로. 페이지는 pane 전체를 되찾는다(dtPageSlot=null).
function undockToWindow(s) {
  initWinEvents();
  s.mode = "window";
  resetEmuZoom(s); // 별도 창 모드에선 페이지가 pane 전체 — 에뮬레이션 줌 복원
  destroyDockUi(s);
  stopPoll(s);
  api.devtoolsWindow(s.pvId, true).then(() => { startPoll(s); }).catch((e) => {
    // 창 생성 실패 → 도킹으로 원복 + 사유 표시
    s.mode = "dock";
    buildDockUi(s);
    startPoll(s);
    setTimeout(() => dtStatus(s, "별도 창 열기 실패: " + String(e).slice(0, 140)), 1200);
  });
}

// 재도킹 — 별도 창을 닫고 pane 안 iframe 을 새로 부팅(선택한 dock side 는 localStorage 로 이어짐).
function redockFromWindow(s) {
  api.devtoolsWindow(s.pvId, false).catch(() => {});
  s.mode = "dock";
  buildDockUi(s);
  startPoll(s);
}

// 디바이스 툴바 줌 — 화면 rect(bounds) 폭 ÷ 에뮬레이션 폭(툴바 입력값) = 데브툴 표시 배율.
//  네이티브 웹뷰 pageZoom 에 적용하면 프레임(=rect) 안에서 페이지가 "진짜 370px 뷰포트"로
//  레이아웃된다(미디어쿼리·반응형 실동작 — 스크린캐스트 아님). 모드 꺼짐/데브툴 닫힘 → 1 복원.
function recomputeEmuZoom(s) {
  let zoom = 1;
  if (s.emu && s.lastBounds && s.lastBounds.width > 1) {
    zoom = Math.min(5, Math.max(0.05, s.lastBounds.width / s.emu.w));
  }
  const rounded = Math.round(zoom * 1000) / 1000;
  if (s.zoomApplied === rounded) return;
  s.zoomApplied = rounded;
  api.previewZoom(s.pvId, rounded).catch(() => {});
}
function resetEmuZoom(s) {
  s.emu = null;
  if (s.zoomApplied !== undefined && s.zoomApplied !== 1) api.previewZoom(s.pvId, 1).catch(() => {});
  s.zoomApplied = 1;
}

function setDtVisible(s, on) {
  s.active = on;
  if (!on) resetEmuZoom(s); // 데브툴 닫힘 → 에뮬레이션 줌 복원
  if (s.wrap) s.wrap.style.display = on ? "" : "none";
  if (s.slot) s.slot.style.display = on ? "" : "none";
  if (!s.wrap) { if (on) startPoll(s); else stopPoll(s); return; }
  // bounds(setInspectedPageBounds) 수신 전 기본 배치 — 상단 60%=페이지, 하단=DevTools.
  //  (네이티브 프리뷰 webview 는 항상 DOM 위라, 슬롯을 먼저 줄여야 iframe/상태줄이 보인다)
  if (on && !s.boundsSeen) {
    s.slot.style.left = "0px";
    s.slot.style.top = "0px";
    s.slot.style.width = "100%";
    s.slot.style.height = "60%";
  }
  if (on) startPoll(s); else stopPoll(s);
}

// 토글 — host: .preview-host 요소(프리뷰 webview 가 이 rect 를 따라다님).
export async function toggleChiiDevtools(pvId, host) {
  let s = sessions.get(pvId);
  if (s && s.active) {
    // 닫기 — 별도 창 모드면 창까지 닫는다.
    if (s.mode === "window") { api.devtoolsWindow(pvId, false).catch(() => {}); s.mode = "dock"; }
    setDtVisible(s, false);
    return false;
  }
  if (s) {
    // 재열기 — 표면 승계로 UI 가 걷혔으면(iframe 없음) 새 host 에 다시 짓는다.
    s.host = host;
    if (!s.iframe) buildDockUi(s);
    setDtVisible(s, true);
    void injectChobitsu(pvId); // 닫힌 사이 페이지가 이동했을 수 있음(멱등)
    return true;
  }
  s = { pvId, host, active: true, mode: "dock", poll: null, enableLog: new Map(), replayId: REPLAY_ID_BASE, boundsSeen: false };
  sessions.set(pvId, s);
  // 래퍼 페이지(같은 오리진, ?ws= 쿼리 유지)가 CDN chii_app.html 을 받아 자기 자신을 교체한다 —
  //  srcdoc 은 쿼리를 못 가져 WS 트랜스포트가 선택되지 않는다(devtools-frame.html 참고).
  buildDockUi(s);
  setDtVisible(s, true);
  void injectChobitsu(pvId);
  return true;
}

// 표면 폐기(웹뷰 닫힘/탭 이동) — 세션 정리. keep=true 면(웹뷰 승계) 세션은 유지하되,
//  도킹 UI(iframe/슬롯)는 옛 pane DOM 과 함께 사라지므로 참조를 걷는다 — 안 걷으면
//  dtPageSlot 이 detached 슬롯(rect 0×0)을 반환해 승계된 웹뷰가 영영 숨는다(실측).
//  새 표면이 dtAttachHost 로 재부착하면 그때 새 host 안에 다시 짓는다.
export function dtDispose(pvId, keep) {
  const s = sessions.get(pvId);
  if (!s) return;
  stopPoll(s);
  if (keep) { destroyDockUi(s); return; }
  if (s.mode === "window") api.devtoolsWindow(pvId, false).catch(() => {});
  destroyDockUi(s);
  sessions.delete(pvId);
}

// 표면 재생성(탭↔독립 pane 전환·pane 간 탭 이동) — 새 host 에 데브툴 세션 재부착.
//  열려 있었으면 새 host 안에 도킹 UI 를 다시 짓는다(iframe 은 재부팅되지만 페이지 쪽
//  chobitsu·enable 리플레이 로그가 세션에 남아 있어 상태 손실 없음).
export function dtAttachHost(pvId, host) {
  const s = sessions.get(pvId);
  if (!s) return;
  s.host = host;
  if (!s.active) return;
  if (s.mode === "window") { startPoll(s); return; } // 별도 창 모드 — UI 없음, CDP 폴링만 재개
  if (!s.iframe) buildDockUi(s);
  setDtVisible(s, true);
  void injectChobitsu(pvId);
}
