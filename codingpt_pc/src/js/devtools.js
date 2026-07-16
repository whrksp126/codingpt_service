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
    "}catch(e){window.__cptCdpErr=String(e&&(e.message||e)).slice(0,200)}})();0"
  );
}
const DRAIN_JS = "JSON.stringify(window.__cptCdpQ?window.__cptCdpQ.splice(0,window.__cptCdpQ.length):[])";

// pvId → 세션 { host, wrap, iframe, slot, active, poll, enableLog, replayId }
const sessions = new Map();

// pane 동기화 tick 이 프리뷰 webview 를 놓을 기준 요소 — 데브툴이 열려 있으면 슬롯(bounds), 아니면 null.
export function dtPageSlot(pvId) {
  const s = sessions.get(pvId);
  return s && s.active ? s.slot : null;
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
  if (s && s.iframe) {
    setDtVisible(s, !s.active);
    return s.active;
  }
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
  // 상태줄 — 프론트엔드 부팅 실패/오류를 화면에 표시(진단 겸 사용자 안내).
  const status = document.createElement("div");
  status.className = "cpt-dt-status";
  status.textContent = "DevTools 로딩 중…";
  wrap.appendChild(status);
  host.append(wrap, slot);
  s.wrap = wrap;
  s.iframe = iframe;
  s.slot = slot;
  s.status = status;
  setTimeout(() => {
    if (!s.opened && s.active && s.status) s.status.textContent = "DevTools 로드 실패 — 네트워크(CDN) 연결을 확인하세요";
  }, 8000);
  s.msgHandler = (e) => { if (e.source === iframe.contentWindow) onFrameMessage(s, e.data); };
  window.addEventListener("message", s.msgHandler);
  // 래퍼 페이지(같은 오리진, ?ws= 쿼리 유지)가 CDN chii_app.html 을 받아 자기 자신을 교체한다 —
  //  srcdoc 은 쿼리를 못 가져 WS 트랜스포트가 선택되지 않는다(devtools-frame.html 참고).
  iframe.src = "devtools-frame.html?ws=cpt&can_dock=true";
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
