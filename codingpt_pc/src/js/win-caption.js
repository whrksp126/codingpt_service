// win-caption.js — win32 창틀 버튼(최소화/최대화/닫기). 계약 5.
//
//  win32 는 decorations:false(B1 — tauri.windows.conf) 전제라 OS 캡션 버튼이 없다.
//  DOM 우측 상단에 우리가 단다. 규율:
//  · 무채색(포인트 컬러 금지 — 닫기 hover 의 빨강만 예외: Windows 관용이자 파괴적 동작 신호,
//    기존 토큰 --error 사용) · 이모지 금지(글리프는 인라인 SVG stroke) · 기존 디자인 토큰만.
//  · hover 는 Windows 관용(칸 전체 사각 하이라이트, 둥근 모서리 없음).
//  · 창 이동은 기존 data-tauri-drag-region(.sb-top/.main-top)이 담당 — 더블클릭 최대화는
//    Tauri drag region 의 기본 동작이다(별도 코드 없음). 이 버튼들은 드래그 영역이 아니다.
//  · 최대화 상태에 따라 가운데 글리프를 사각(최대화)/겹친 사각(이전 크기로)으로 바꾼다.
//  macOS 에서는 호출되지 않는다(main.js 가 IS_WINDOWS 일 때만 부른다).
import * as i18n from "./i18n/index.js";

const SVG_MIN = `<svg class="ic" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M0.5 5h9"/></svg>`;
const SVG_MAX = `<svg class="ic" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>`;
const SVG_RESTORE = `<svg class="ic" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5v-2h7v7h-2"/></svg>`;
const SVG_CLOSE = `<svg class="ic" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/></svg>`;

export function initWinCaption() {
  const w = (() => {
    try { return window.__TAURI__?.window?.getCurrentWindow?.() || null; } catch (_) { return null; }
  })();
  if (!w) return; // Tauri 밖(테스트 하네스 등) — 버튼을 달 창 자체가 없다
  const bar = document.createElement("div");
  bar.className = "win-caption";
  bar.innerHTML = `
    <button class="win-cap-btn" id="wcMin" aria-label="${i18n.t('최소화')}">${SVG_MIN}</button>
    <button class="win-cap-btn" id="wcMax" aria-label="${i18n.t('최대화')}">${SVG_MAX}</button>
    <button class="win-cap-btn win-cap-close" id="wcClose" aria-label="${i18n.t('닫기')}">${SVG_CLOSE}</button>`;
  document.body.appendChild(bar);
  const maxBtn = bar.querySelector("#wcMax");
  const paintMax = async () => {
    let maxed = false;
    try { maxed = await w.isMaximized(); } catch (_) { /* noop */ }
    maxBtn.innerHTML = maxed ? SVG_RESTORE : SVG_MAX;
    maxBtn.setAttribute("aria-label", maxed ? i18n.t('이전 크기로') : i18n.t('최대화'));
  };
  bar.querySelector("#wcMin").addEventListener("click", () => { w.minimize().catch(() => {}); });
  maxBtn.addEventListener("click", async () => {
    try { await w.toggleMaximize(); } catch (_) { /* noop */ }
    paintMax();
  });
  bar.querySelector("#wcClose").addEventListener("click", () => { w.close().catch(() => {}); });
  // 드래그 영역 더블클릭 최대화·OS 스냅(Win+화살표)로도 상태가 바뀐다 → 리사이즈 때 글리프 화해.
  try { w.onResized(() => { paintMax(); }); } catch (_) { /* noop */ }
  paintMax();
}
