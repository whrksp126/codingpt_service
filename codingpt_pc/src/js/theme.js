// theme.js — 모양(테마·글꼴·터미널 스타일) 설정.
//  · 테마(themeMode): 'system'|'light'|'dark' — 기기 로컬. matchMedia 로 OS 추종,
//    적용은 <html data-theme> 하나로 통일(styles.css 가 변수 오버라이드).
//  · 인터페이스 글꼴/코드·터미널 글꼴/터미널 스타일: **계정 전체 동기화** —
//    로컬 즉시 적용(+localStorage 캐시) 후 PATCH /api/daemon/me {appearance} 로 서버 저장,
//    서버가 appearance_event 로 전 기기 팬아웃(ui-channel.js → applyRemoteAppearance).
//  · 글꼴은 전부 앱 내장(styles.css @font-face) — 3플랫폼 동일 목록. 값 키는 백엔드
//    화이트리스트(daemonController.APPEARANCE_KEYS)와 반드시 일치.
import { api } from "./api.js";
import { IS_WINDOWS } from "./path-utils.js";
import * as I18N from "./i18n/index.js";

const KEY_THEME = "cpt.theme";
const KEY_UI_FONT = "cpt.uiFont";
const KEY_MONO_FONT = "cpt.monoFont";
const KEY_TERM_STYLE = "cpt.termStyle";

const SANS_TAIL = '-apple-system, system-ui, "Segoe UI", sans-serif';
const UI_FONT_DEFAULT = `"PretendardVariable", "Pretendard", ${SANS_TAIL}`;
// 기본 코드 글꼴 — mac=Menlo(종전 그대로), win32=Consolas + 한글 폴백(번들 D2Coding → Malgun Gothic).
//  설정값 키('default')는 플랫폼 공통이라 계정 동기화 값이 그대로 유효하다(계약 5).
const MONO_FONT_DEFAULT = IS_WINDOWS
  ? 'Consolas, "Cascadia Mono", "D2Coding", "Malgun Gothic", monospace'
  : 'Menlo, Monaco, "SF Mono", Consolas, monospace';

// 인터페이스 글꼴 — 결이 확연히 다른 4종(전부 내장). 기본 = Pretendard.
export const UI_FONT_OPTIONS = [
  { value: "pretendard", label: "Pretendard", stack: UI_FONT_DEFAULT },
  { value: "notoserif", label: "Noto Serif KR", stack: `"Noto Serif KR", "Apple Myungjo", Georgia, serif` },
  { value: "gowun", label: "Gowun Dodum", stack: `"Gowun Dodum", ${UI_FONT_DEFAULT}` },
  { value: "gmarket", label: "Gmarket Sans", stack: `"Gmarket Sans", ${UI_FONT_DEFAULT}` },
];

// 코드·터미널 글꼴 — 통일 목록(내장). "Symbols Nerd Font Mono"는 파워라인 글리프 폴백.
const MONO_FALLBACK = '"Symbols Nerd Font Mono", ' + MONO_FONT_DEFAULT;
export const MONO_FONT_OPTIONS = [
  {
    value: "default",
    label: IS_WINDOWS ? "기본 (Consolas)" : "기본 (Menlo)", // 라벨만 플랫폼 표기 — 값 키는 공통
    stack: IS_WINDOWS
      ? 'Consolas, "Cascadia Mono", "D2Coding", "Symbols Nerd Font Mono", "Malgun Gothic", monospace'
      : 'Menlo, Monaco, "SF Mono", Consolas, "Symbols Nerd Font Mono", monospace',
  },
  { value: "jetbrains", label: "JetBrains Mono", stack: `"JetBrains Mono", ${MONO_FALLBACK}` },
  { value: "fira", label: "Fira Code", stack: `"Fira Code", ${MONO_FALLBACK}` },
  { value: "d2coding", label: "D2Coding", stack: `"D2Coding", ${MONO_FALLBACK}` },
];

// 과거 로컬 저장값(구 키체계) 마이그레이션
const LEGACY_MONO = { "JetBrains Mono": "jetbrains", "Fira Code": "fira", D2Coding: "d2coding" };
const LEGACY_STYLE = { "one-dark": "one", "solarized-dark": "solarized", "solarized-light": "solarized" };
const UI_VALUES = UI_FONT_OPTIONS.map((o) => o.value);
const MONO_VALUES = MONO_FONT_OPTIONS.map((o) => o.value);
const STYLE_VALUES = ["auto", "ghostty", "one", "dracula", "solarized"];

let themeMode = "system"; // 기기 로컬
let uiFont = "pretendard";
let monoFont = "default";
let termStyle = "auto";
function loadFromStorage() {
  try {
    const t = localStorage.getItem(KEY_THEME);
    themeMode = (t === "light" || t === "dark" || t === "system") ? t : "system";
    const u = localStorage.getItem(KEY_UI_FONT);
    uiFont = UI_VALUES.includes(u) ? u : "pretendard";
    const m0 = localStorage.getItem(KEY_MONO_FONT);
    const m = LEGACY_MONO[m0] || m0;
    monoFont = MONO_VALUES.includes(m) ? m : "default";
    const s0 = localStorage.getItem(KEY_TERM_STYLE) || localStorage.getItem("cpt.termScheme");
    const st = LEGACY_STYLE[s0] || s0;
    termStyle = STYLE_VALUES.includes(st) ? st : "auto";
  } catch (_) {}
}
loadFromStorage();
// 다른 창(오버레이 설정 등)에서 모양을 바꾸면 localStorage 가 바뀐다 → 이 창에도 즉시 반영.
//  storage 이벤트는 '변경을 일으킨 창'이 아닌 다른 창에서만 발생하므로 무한루프 없음.
try {
  window.addEventListener("storage", (e) => {
    if (e.key && !e.key.startsWith("cpt.")) return;
    loadFromStorage();
    emit();
  });
} catch (_) {}

const listeners = new Set();
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

export function getThemeMode() { return themeMode; }
export function getUiFont() { return uiFont; }
export function getMonoFont() { return monoFont; }
export function getTermStyle() { return termStyle; }

/** 실제 적용 테마('light'|'dark') — system 이면 OS 설정 추종. */
export function resolvedTheme() {
  if (themeMode === "light" || themeMode === "dark") return themeMode;
  return media && media.matches ? "light" : "dark";
}

export function uiFontOptions() { return UI_FONT_OPTIONS; }
export function monoFontOptions() { return MONO_FONT_OPTIONS; }

function stackFor(opts, value, fallback) {
  const hit = opts.find((o) => o.value === value);
  return hit ? hit.stack : fallback;
}
export function uiFontStack() { return stackFor(UI_FONT_OPTIONS, uiFont, UI_FONT_DEFAULT); }
/** 코드·터미널 폰트 스택(현재 설정) — xterm fontFamily 에 그대로 사용. */
export function monoFontStack() { return stackFor(MONO_FONT_OPTIONS, monoFont, MONO_FONT_DEFAULT); }

function apply() {
  const el = document.documentElement;
  el.dataset.theme = resolvedTheme();
  el.style.setProperty("--ui-font", uiFontStack());
  el.style.setProperty("--mono-font", monoFontStack());
  // punch-through: 앱 웹뷰가 투명이라 배경은 NSWindow 가 담당 — 테마 base 색으로 동기화.
  try {
    const base = getComputedStyle(el).getPropertyValue("--base").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(base)) api.windowSetBg(base).catch(() => {});
  } catch (_) { /* 오버레이 창 등 api 무관 컨텍스트 */ }
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

// ── 화면 언어(계정 동기화) ─────────────────────────────────────────────────────
// 'system' = 브라우저(=OS) 언어를 따른다. 기본값을 한국어로 박으면 해외 사용자가 읽을 수 없는
//  화면에서 설정을 찾아 들어가야 한다.
// 적용은 **창 새로고침**이다 — PC 화면은 명령형 DOM 이라 문구가 바뀌어도 저절로 다시 안 그려진다.
//  언어 전환은 드문 행위라 이 편이 화면마다 구독을 심는 것보다 확실하다(빠뜨린 화면이 없다).
const KEY_LANG = "cpt.lang";
let langSetting = "system";
try { const v = localStorage.getItem(KEY_LANG); if (v) langSetting = v; } catch (_) {}

export function getLangSetting() { return langSetting; }
export function isValidLangSetting(v) { return v === "system" || I18N.isLang(v); }
export function effectiveLang(v = langSetting) {
  return v === "system" ? I18N.matchDeviceLang(navigator.language || "en") : v;
}
export function langOptions() {
  return [
    { value: "system", label: "시스템 언어" },
    ...I18N.LANGS.map((l) => ({ value: l, label: I18N.LANG_LABELS[l] })),
  ];
}
/** 부팅 시 1회 — 화면을 그리기 전에 불러야 한다(그 전에 그린 것은 한국어로 굳는다). */
export function bootLang() { I18N.setLangRuntime(effectiveLang()); }
export function setLangSetting(v) {
  if (!isValidLangSetting(v) || v === langSetting) return;
  langSetting = v;
  try { localStorage.setItem(KEY_LANG, v); } catch (_) {}
  I18N.setLangRuntime(effectiveLang());
  schedulePush();
  // 새로고침 전에 서버 저장이 나가도록 한 틱 준다(디바운스 400ms — 그보다 넉넉히).
  setTimeout(() => { try { location.reload(); } catch (_) {} }, 500);
}

// ── 계정 동기화 — 로컬 변경은 디바운스 후 서버로, 서버발(appearance_event)은 push 없이 적용만. ──
let pushTimer = 0;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    api.updateAppearance({ uiFont, codeFont: monoFont, termStyle, lang: langSetting }).catch(() => {});
  }, 400);
}
function persist() {
  try {
    localStorage.setItem(KEY_UI_FONT, uiFont);
    localStorage.setItem(KEY_MONO_FONT, monoFont);
    localStorage.setItem(KEY_TERM_STYLE, termStyle);
  } catch (_) {}
}
/** 서버/타 기기발 적용(부트 fetch_me·appearance_event) — 서버로 되밀지 않는다. */
export function applyRemoteAppearance(a) {
  if (!a || typeof a !== "object") return;
  let changed = false;
  if (UI_VALUES.includes(a.uiFont) && a.uiFont !== uiFont) { uiFont = a.uiFont; changed = true; }
  if (MONO_VALUES.includes(a.codeFont) && a.codeFont !== monoFont) { monoFont = a.codeFont; changed = true; }
  if (STYLE_VALUES.includes(a.termStyle) && a.termStyle !== termStyle) { termStyle = a.termStyle; changed = true; }
  // 언어는 다른 기기에서 바뀌어도 **여기서 새로고침하지 않는다** — 작업 중인 터미널을 남이 끊는
  //  꼴이 된다. 값만 저장해 두고 다음 실행부터 적용한다.
  if (isValidLangSetting(a.lang) && a.lang !== langSetting) {
    langSetting = a.lang;
    try { localStorage.setItem(KEY_LANG, langSetting); } catch (_) {}
  }
  if (changed) { persist(); emit(); }
}

export function setThemeMode(m) {
  if (m !== "system" && m !== "light" && m !== "dark") return;
  if (m === themeMode) return;
  themeMode = m;
  try { localStorage.setItem(KEY_THEME, m); } catch (_) {}
  emit();
}
export function setUiFont(v) {
  if (!UI_VALUES.includes(v) || v === uiFont) return;
  uiFont = v; persist(); emit(); schedulePush();
}
export function setMonoFont(v) {
  if (!MONO_VALUES.includes(v) || v === monoFont) return;
  monoFont = v; persist(); emit(); schedulePush();
}
export function setTermStyle(v) {
  if (!STYLE_VALUES.includes(v) || v === termStyle) return;
  termStyle = v; persist(); emit(); schedulePush();
}

/** 모양(테마/글꼴/스타일) 변경 구독 — 인자로 resolved 테마('light'|'dark'). 반환값 = 해제 함수. */
export function onAppearanceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── 터미널 스타일(xterm 팔레트) — 스타일 "계열" × 앱 테마(다크/라이트) 변형 자동 선택. ──
//    claude/codex/vim 등 모든 TUI 는 ANSI 색 번호로만 그리므로 이 팔레트가 곧 TUI 스타일이 된다.
//    값은 모바일(terminalSchemes.ts)과 반드시 동일하게 유지.
export const TERM_STYLE_OPTIONS = [
  { value: "auto", label: "CodingPT (권장)" },
  { value: "ghostty", label: "Ghostty (cmux)" },
  { value: "one", label: "One" },
  { value: "dracula", label: "Dracula" },
  { value: "solarized", label: "Solarized" },
];
const TERM_AUTO_DARK = {
  // CodingPT 다크 — 배경=앱 배경(--base), 16색 전부 가독 튜닝
  //  ★ 커서는 **글자색**이다(2026-08-15 사용자 확정). 예전엔 액센트 민트였는데, 액센트는 상태 신호
  //   전용이라는 규칙에 어긋난다 — 늘 깜빡이는 커서는 신호가 아니라 장식이다(cmux·Ghostty 도 글자색).
  //  ★ selectionInactiveBackground 를 반드시 함께 준다. 안 주면 xterm 이 선택색을 30% 로 깔아
  //   포커스를 옮기는 순간 드래그한 자리가 배경에 묻힌다("선택이 사라졌다"로 보인다).
  background: "#0A0D14", foreground: "#E2E8F0", cursor: "#E2E8F0", cursorAccent: "#0A0D14",
  selectionBackground: "#264F78", selectionInactiveBackground: "#264F78",
  black: "#1B2230", red: "#F87171", green: "#34D399", yellow: "#FBBF24",
  blue: "#60A5FA", magenta: "#C084FC", cyan: "#22D3EE", white: "#CBD5E1",
  brightBlack: "#475569", brightRed: "#FCA5A5", brightGreen: "#6EE7B7", brightYellow: "#FCD34D",
  brightBlue: "#93C5FD", brightMagenta: "#D8B4FE", brightCyan: "#67E8F9", brightWhite: "#F8FAFC",
};
const TERM_AUTO_LIGHT = {
  // CodingPT 라이트 — 배경=앱 라이트 배경(--base), 밝은 배경 가독 팔레트
  background: "#F2F4F8", foreground: "#1E293B", cursor: "#1E293B", cursorAccent: "#FFFFFF",
  selectionBackground: "#BCD3F5", selectionInactiveBackground: "#BCD3F5",
  black: "#334155", red: "#DC2626", green: "#059669", yellow: "#B45309",
  blue: "#2563EB", magenta: "#9333EA", cyan: "#0891B2", white: "#CBD5E1",
  brightBlack: "#64748B", brightRed: "#EF4444", brightGreen: "#10B981", brightYellow: "#D97706",
  brightBlue: "#3B82F6", brightMagenta: "#A855F7", brightCyan: "#06B6D4", brightWhite: "#0F172A",
};
export const TERM_STYLES = {
  auto: { dark: TERM_AUTO_DARK, light: TERM_AUTO_LIGHT },
  ghostty: {
    // 다크 = Ghostty Default Style Dark(cmux 기본), 라이트 = Ghostty Builtin Light
    dark: {
      background: "#282C34", foreground: "#FFFFFF", cursor: "#FFFFFF", cursorAccent: "#353A44",
      selectionBackground: "#FFFFFF", selectionForeground: "#282C34",
      black: "#1D1F21", red: "#CC6566", green: "#B6BD68", yellow: "#F0C674",
      blue: "#82A2BE", magenta: "#B294BB", cyan: "#8ABEB7", white: "#C4C8C6",
      brightBlack: "#666666", brightRed: "#D54E53", brightGreen: "#B9CA4B", brightYellow: "#E7C547",
      brightBlue: "#7AA6DA", brightMagenta: "#C397D8", brightCyan: "#70C0B1", brightWhite: "#EAEAEA",
    },
    light: {
      background: "#FFFFFF", foreground: "#000000", cursor: "#000000", cursorAccent: "#FFFFFF",
      selectionBackground: "#B5D5FF", selectionForeground: "#000000",
      black: "#000000", red: "#BB0000", green: "#00BB00", yellow: "#BBBB00",
      blue: "#0000BB", magenta: "#BB00BB", cyan: "#00BBBB", white: "#BBBBBB",
      brightBlack: "#555555", brightRed: "#FF5555", brightGreen: "#2FD92F", brightYellow: "#BFBF15",
      brightBlue: "#5555FF", brightMagenta: "#FF55FF", brightCyan: "#22CCCC", brightWhite: "#FFFFFF",
    },
  },
  one: {
    dark: {
      background: "#282C34", foreground: "#ABB2BF", cursor: "#528BFF", cursorAccent: "#282C34",
      selectionBackground: "#3E4451",
      black: "#282C34", red: "#E06C75", green: "#98C379", yellow: "#E5C07B",
      blue: "#61AFEF", magenta: "#C678DD", cyan: "#56B6C2", white: "#ABB2BF",
      brightBlack: "#5C6370", brightRed: "#E06C75", brightGreen: "#98C379", brightYellow: "#E5C07B",
      brightBlue: "#61AFEF", brightMagenta: "#C678DD", brightCyan: "#56B6C2", brightWhite: "#FFFFFF",
    },
    light: {
      // One Light(Atom) — Ghostty 'Atom One Light' 팔레트
      background: "#F9F9F9", foreground: "#2A2C33", cursor: "#2A2C33", cursorAccent: "#FFFFFF",
      selectionBackground: "#EDEDED", selectionForeground: "#2A2C33",
      black: "#000000", red: "#DE3E35", green: "#3F953A", yellow: "#D2B67C",
      blue: "#2F5AF3", magenta: "#950095", cyan: "#3F953A", white: "#BBBBBB",
      brightBlack: "#000000", brightRed: "#DE3E35", brightGreen: "#3F953A", brightYellow: "#D2B67C",
      brightBlue: "#2F5AF3", brightMagenta: "#A00095", brightCyan: "#3F953A", brightWhite: "#FFFFFF",
    },
  },
  dracula: {
    dark: {
      background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2", cursorAccent: "#282A36",
      selectionBackground: "#44475A",
      black: "#21222C", red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C",
      blue: "#BD93F9", magenta: "#FF79C6", cyan: "#8BE9FD", white: "#F8F8F2",
      brightBlack: "#6272A4", brightRed: "#FF6E6E", brightGreen: "#69FF94", brightYellow: "#FFFFA5",
      brightBlue: "#D6ACFF", brightMagenta: "#FF92DF", brightCyan: "#A4FFFF", brightWhite: "#FFFFFF",
    },
    light: {
      // Alucard(Dracula 공식 라이트) — draculatheme.com/spec ANSI 매핑
      background: "#FFFBEB", foreground: "#1F1F1F", cursor: "#1F1F1F", cursorAccent: "#FFFBEB",
      selectionBackground: "#CFCFDE",
      black: "#FFFBEB", red: "#CB3A2A", green: "#14710A", yellow: "#846E15",
      blue: "#644AC9", magenta: "#A3144D", cyan: "#036A96", white: "#1F1F1F",
      brightBlack: "#6C664B", brightRed: "#D74C3D", brightGreen: "#198D0C", brightYellow: "#9E841A",
      brightBlue: "#7862D0", brightMagenta: "#BF185A", brightCyan: "#047FB4", brightWhite: "#2C2B31",
    },
  },
  solarized: {
    dark: {
      background: "#002B36", foreground: "#839496", cursor: "#839496", cursorAccent: "#002B36",
      selectionBackground: "#073642",
      black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900",
      blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
      brightBlack: "#586E75", brightRed: "#CB4B16", brightGreen: "#586E75", brightYellow: "#657B83",
      brightBlue: "#839496", brightMagenta: "#6C71C4", brightCyan: "#93A1A1", brightWhite: "#FDF6E3",
    },
    light: {
      background: "#FDF6E3", foreground: "#657B83", cursor: "#657B83", cursorAccent: "#FDF6E3",
      selectionBackground: "#EEE8D5",
      black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900",
      blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
      brightBlack: "#586E75", brightRed: "#CB4B16", brightGreen: "#93A1A1", brightYellow: "#839496",
      brightBlue: "#657B83", brightMagenta: "#6C71C4", brightCyan: "#586E75", brightWhite: "#FDF6E3",
    },
  },
};


/** xterm 최소 대비 자동 보정 — 프롬프트가 256색(팔레트 밖) 배경을 써도 글자가 항상 읽히게.
 *  라이트는 다크용으로 설정된 프롬프트(p10k 등)가 흔해 더 강하게 보정한다. */
export function termMinContrast() {
  return resolvedTheme() === "light" ? 4.5 : 3;
}
/** 스타일 계열의 특정 변형 팔레트(미리보기용). */
export function termStylePalette(style, variant) {
  const fam = TERM_STYLES[style] || TERM_STYLES.auto;
  return fam[variant] || fam.dark;
}
/** 현재 xterm 팔레트 — 선택된 스타일 계열의 현재 테마(다크/라이트) 변형. */
export function termTheme() {
  return termStylePalette(termStyle, resolvedTheme());
}
/** 현재 테마의 CodeMirror theme 이름 — 라이트는 코어 내장 default(별도 CSS 불필요). */
export function cmThemeName() {
  return resolvedTheme() === "light" ? "default" : "material-darker";
}
