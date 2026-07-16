// display-scale.js — 기기별 표시 배율(이 PC 로컬 설정).
//  터미널(xterm fontSize)과 IDE 에디터(CodeMirror font-size)에 곱해 "더 넓게(작게) ↔ 더 좁게(크게)"
//  보이게 한다. 프리뷰 줌은 대상 아님. 영속은 localStorage(기존 "cpt.server" 패턴과 동일 — pc-ui.json
//  은 state.js 가 통째로 소유하므로 건드리지 않는다).
const KEY = "cpt.displayScale";
const MIN = 0.7;
const MAX = 1.5;

/** 설정 UI 프리셋(5단계). 1.0 = 현행 유지(기본). */
export const SCALE_PRESETS = [0.8, 0.9, 1.0, 1.15, 1.3];

/** 배율 1.0 기준 크기 — pane.js 터미널(13px), styles.css .ide-editor .CodeMirror(12.5px)와 일치해야 함 */
export const TERM_BASE_FONT = 13;
export const IDE_BASE_FONT = 12.5;

let scale = 1.0;
try {
  const v = parseFloat(localStorage.getItem(KEY));
  if (isFinite(v) && v >= MIN && v <= MAX) scale = v;
} catch (_) {}

const listeners = new Set();

export function getScale() {
  return scale;
}

/** 현재 배율 적용된 터미널 폰트(px). 0.5px 단위 반올림 — 배율 1.0이면 기준값 그대로. */
export function termFontPx() {
  return Math.max(8, Math.round(TERM_BASE_FONT * scale * 2) / 2);
}

// IDE 는 CSS 변수로 일괄 적용(styles.css: .ide-editor .CodeMirror { font-size: var(--cpt-ide-font, 12.5px) }).
function applyIdeCssVar() {
  try {
    const px = Math.max(8, Math.round(IDE_BASE_FONT * scale * 2) / 2);
    document.documentElement.style.setProperty("--cpt-ide-font", px + "px");
  } catch (_) {}
}
applyIdeCssVar(); // 모듈 로드 시 저장값 즉시 반영

export function setScale(v) {
  const next = Math.min(MAX, Math.max(MIN, v));
  if (!isFinite(next) || next === scale) return;
  scale = next;
  try { localStorage.setItem(KEY, String(next)); } catch (_) {}
  applyIdeCssVar();
  listeners.forEach((fn) => { try { fn(scale); } catch (_) {} });
}

/** 배율 변경 구독(열린 터미널/에디터 즉시 반영용). 반환값 = 해제 함수. */
export function onScaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
