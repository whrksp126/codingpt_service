// theme.js — 모양(테마·글꼴) 로컬 설정. display-scale.js 와 같은 구조:
//  localStorage 영속 + 모듈 로드 즉시 적용 + 변경 구독(onAppearanceChange)으로
//  열려있는 xterm/CodeMirror 에 실시간 반영(pane.js 가 구독).
//  · 테마: 'system' | 'light' | 'dark' — system 은 matchMedia(prefers-color-scheme) 추종.
//    적용은 <html data-theme="light|dark"> 하나로 통일(styles.css 가 변수 오버라이드).
//  · 글꼴: UI(본문)와 모노(코드·터미널) 각각 CSS 변수(--ui-font / --mono-font)로 주입.
const KEY_THEME = "cpt.theme";
const KEY_UI_FONT = "cpt.uiFont";
const KEY_MONO_FONT = "cpt.monoFont";

const UI_FONT_DEFAULT = '"PretendardVariable", "Pretendard", -apple-system, system-ui, "Segoe UI", sans-serif';
const MONO_FONT_DEFAULT = 'Menlo, Monaco, "SF Mono", Consolas, monospace';

// UI 글꼴 선택지 — value 'default'/'system'/'serif' 는 스택 고정, 그 외는 설치 감지된 개별 폰트.
export const UI_FONT_OPTIONS = [
  { value: "default", label: "기본 (Pretendard)", stack: UI_FONT_DEFAULT },
  { value: "system", label: "시스템", stack: '-apple-system, system-ui, "Segoe UI", "Apple SD Gothic Neo", sans-serif' },
  { value: "serif", label: "세리프", stack: 'ui-serif, Georgia, "Times New Roman", "Apple Myungjo", serif' },
];
const UI_FONT_CANDIDATES = ["Apple SD Gothic Neo", "Noto Sans KR", "Nanum Gothic"];

export const MONO_FONT_DEFAULT_OPTION = { value: "default", label: "기본 (Menlo)", stack: MONO_FONT_DEFAULT };
const MONO_FONT_CANDIDATES = [
  "JetBrains Mono", "SF Mono", "Menlo", "Monaco", "Fira Code", "Cascadia Code",
  "D2Coding", "IBM Plex Mono", "Source Code Pro", "Hack", "Consolas",
];

let themeMode = "system"; // 'system' | 'light' | 'dark'
let uiFont = "default";
let monoFont = "default";
try {
  const t = localStorage.getItem(KEY_THEME);
  if (t === "light" || t === "dark" || t === "system") themeMode = t;
  uiFont = localStorage.getItem(KEY_UI_FONT) || "default";
  monoFont = localStorage.getItem(KEY_MONO_FONT) || "default";
} catch (_) {}

const listeners = new Set();
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

export function getThemeMode() { return themeMode; }
export function getUiFont() { return uiFont; }
export function getMonoFont() { return monoFont; }

/** 실제 적용 테마('light'|'dark') — system 이면 OS 설정 추종. */
export function resolvedTheme() {
  if (themeMode === "light" || themeMode === "dark") return themeMode;
  return media && media.matches ? "light" : "dark";
}

/** 설치 감지(document.fonts.check) — 후보 중 사용 가능한 폰트만 선택지로. */
function fontAvailable(name) {
  try { return document.fonts.check(`12px "${name}"`); } catch (_) { return false; }
}
export function uiFontOptions() {
  const opts = [...UI_FONT_OPTIONS];
  for (const n of UI_FONT_CANDIDATES) {
    if (fontAvailable(n)) opts.push({ value: n, label: n, stack: `"${n}", ${UI_FONT_DEFAULT}` });
  }
  return opts;
}
export function monoFontOptions() {
  const opts = [MONO_FONT_DEFAULT_OPTION];
  for (const n of MONO_FONT_CANDIDATES) {
    if (fontAvailable(n)) opts.push({ value: n, label: n, stack: `"${n}", ${MONO_FONT_DEFAULT}` });
  }
  return opts;
}

function stackFor(kind, value) {
  const opts = kind === "ui" ? uiFontOptions() : monoFontOptions();
  const hit = opts.find((o) => o.value === value);
  if (hit) return hit.stack;
  return kind === "ui" ? UI_FONT_DEFAULT : MONO_FONT_DEFAULT;
}
/** 코드·터미널 폰트 스택(현재 설정) — xterm fontFamily 에 그대로 사용. */
export function monoFontStack() { return stackFor("mono", monoFont); }

function apply() {
  const el = document.documentElement;
  el.dataset.theme = resolvedTheme();
  el.style.setProperty("--ui-font", stackFor("ui", uiFont));
  el.style.setProperty("--mono-font", monoFontStack());
}
apply(); // 모듈 로드 시 저장값 즉시 반영(첫 페인트 전에 main.js 최상단 import 필수)

function emit() {
  apply();
  const t = resolvedTheme();
  listeners.forEach((fn) => { try { fn(t); } catch (_) {} });
}
// system 모드일 때 OS 테마 변경 실시간 추종
if (media) {
  const onMedia = () => { if (themeMode === "system") emit(); };
  media.addEventListener ? media.addEventListener("change", onMedia) : media.addListener(onMedia);
}

export function setThemeMode(m) {
  if (m !== "system" && m !== "light" && m !== "dark") return;
  if (m === themeMode) return;
  themeMode = m;
  try { localStorage.setItem(KEY_THEME, m); } catch (_) {}
  emit();
}
export function setUiFont(v) {
  if (v === uiFont) return;
  uiFont = v;
  try { localStorage.setItem(KEY_UI_FONT, v); } catch (_) {}
  emit();
}
export function setMonoFont(v) {
  if (v === monoFont) return;
  monoFont = v;
  try { localStorage.setItem(KEY_MONO_FONT, v); } catch (_) {}
  emit();
}

/** 모양(테마/글꼴) 변경 구독 — 인자로 resolved 테마('light'|'dark'). 반환값 = 해제 함수. */
export function onAppearanceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── 터미널(xterm)·에디터(CodeMirror) 테마 팔레트 ──
// 다크 = 기존 값 유지(pane.js TERM_THEME 이관). 라이트 = One Light 계열(밝은 배경 가독 팔레트).
const TERM_DARK = {
  background: "#0A0D14",
  foreground: "#E2E8F0",
  cursor: "#34D399",
  cursorAccent: "#0A0D14",
  selectionBackground: "#264F78",
  black: "#0A0D14",
  brightBlack: "#334155",
};
const TERM_LIGHT = {
  background: "#F2F4F8", // 라이트 --base 와 동일(pane 과 flush)
  foreground: "#1E293B",
  cursor: "#0B8F63",
  cursorAccent: "#FFFFFF",
  selectionBackground: "#BCD3F5",
  black: "#383A42",
  red: "#CA1243",
  green: "#50A14F",
  yellow: "#C18401",
  blue: "#4078F2",
  magenta: "#A626A4",
  cyan: "#0184BC",
  white: "#A0A1A7",
  brightBlack: "#696C77",
  brightRed: "#CA1243",
  brightGreen: "#50A14F",
  brightYellow: "#C18401",
  brightBlue: "#4078F2",
  brightMagenta: "#A626A4",
  brightCyan: "#0184BC",
  brightWhite: "#101012",
};
/** 현재 테마의 xterm 팔레트. */
export function termTheme() {
  return resolvedTheme() === "light" ? TERM_LIGHT : TERM_DARK;
}
/** 현재 테마의 CodeMirror theme 이름 — 라이트는 코어 내장 default(별도 CSS 불필요). */
export function cmThemeName() {
  return resolvedTheme() === "light" ? "default" : "material-darker";
}
