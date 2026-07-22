// overlay-host.js — 메인 창 쪽 오버레이 프레임워크(재사용).
//  프리뷰(네이티브 웹뷰)는 항상 DOM 위에 합성되므로, 그 위에 떠야 하는 UI(메뉴·알림 패널·토스트·
//  향후 다이얼로그/툴팁/커맨드 팔레트 등)를 투명 별도 웹뷰 창에 그린다. 창은 시작 시 미리 만들어
//  두고(웜) 재사용 → 클릭 시 즉시 표시. 콘텐츠는 여기서 만든 "그냥 DOM 요소" 를 outerHTML 로
//  넘기고(디자인=styles.css 그대로 공유), 클릭 액션만 이벤트로 되돌려 받아 메인이 실행한다.
//
//  새 오버레이 추가법(간단):
//    const { map, tag } = makeActions();
//    const el = document.createElement('div'); el.className = 'ctx-menu'; ... tag(btn, () => 무언가);
//    if (!(await openOverlay(el, map, { place }))) { /* DOM 폴백 */ }
import { api } from "./api.js";

const T = window.__TAURI__;
const event = T && T.event;

let ready = false;
let ensuring = null;
let handlers = new Map(); // id → 클릭 콜백(현재 표시 중인 오버레이)
let dismissCb = null;
let wired = false;

function available() { return !!(T && T.core && event); }

function wireOnce() {
  if (wired || !available()) return;
  wired = true;
  event.listen("ovl:action", ({ payload }) => {
    const fn = handlers.get(String(payload && payload.id));
    if (fn) { try { fn(); } catch (_) { /* noop */ } }
  });
  event.listen("ovl:dismiss", () => {
    const c = dismissCb; dismissCb = null; handlers = new Map();
    if (c) { try { c(); } catch (_) {} }
  });
}

// 오버레이 창을 (한 번만) 생성·웜업. 성공 시 true. 준비 신호(ovl:ready)를 기다리되 타임아웃 폴백.
export async function ensureOverlay() {
  if (ready) return true;
  if (!available()) return false;
  wireOnce();
  if (!ensuring) {
    ensuring = new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; ready = v; resolve(v); } };
      event.listen("ovl:ready", () => finish(true)).catch(() => {});
      api.overlayEnsure().catch(() => finish(false));
      setTimeout(() => finish(true), 1500); // ready 신호를 놓쳐도 진행(창은 생성됨)
    });
  }
  return ensuring;
}

// 액션 태거 — el 의 인터랙티브 노드에 data-ovl 부여 + 콜백 등록.
//  keep=true 면 클릭해도 오버레이를 닫지 않는다(예: "모두 읽음" 후 목록 갱신).
export function makeActions() {
  const map = new Map();
  let n = 0;
  const tag = (elm, fn, keep) => {
    const id = String(++n);
    elm.setAttribute("data-ovl", id);
    if (keep) elm.setAttribute("data-ovl-keep", "");
    map.set(id, fn);
    return elm;
  };
  return { map, tag };
}

// DOM 폴백용 — 같은 요소에 클릭 리스너 직접 부착(오버레이 미가용 시).
export function bindActions(rootEl, map, onAfter) {
  rootEl.querySelectorAll("[data-ovl]").forEach((elm) => {
    elm.addEventListener("click", () => {
      const fn = map.get(elm.getAttribute("data-ovl"));
      if (fn) { try { fn(); } catch (_) {} }
      if (!elm.hasAttribute("data-ovl-keep") && onAfter) onAfter();
    });
  });
}

// 오버레이로 팝업 표시. 성공 시 true, 미가용 시 false(호출부가 DOM 폴백).
//  place: {mode:'point',x,y,align?} | {mode:'anchor',x,y} | {mode:'toast'}
//  passthrough: 클릭 통과(토스트). autohideMs: 자동 닫힘(토스트). onDismiss: 바깥클릭/Esc 콜백.
export async function openOverlay(el, map, opts = {}) {
  if (!(await ensureOverlay())) return false;
  handlers = map || new Map();
  dismissCb = opts.onDismiss || null;
  event.emit("ovl:show", {
    html: el.outerHTML,
    place: opts.place || null,
    passthrough: !!opts.passthrough,
    autohideMs: opts.autohideMs || 0,
  });
  return true;
}

// 열린 상태에서 내용만 교체(keep 액션 후 갱신). 핸들러 맵도 갱신.
export function refreshOverlay(el, map, place) {
  handlers = map || handlers;
  event.emit("ovl:show", { html: el.outerHTML, place: place || null, passthrough: false, autohideMs: 0 });
}

export async function closeOverlay() {
  try { await api.overlayHide(); } catch (_) {}
  handlers = new Map(); dismissCb = null;
}
