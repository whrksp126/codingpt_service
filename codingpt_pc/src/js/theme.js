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
// 'solarized' 는 2026-08-15 4종 개편으로 은퇴 — 가장 가까운 페이퍼(dracula 키)로 이관.
const LEGACY_STYLE = { "one-dark": "one", "solarized-dark": "dracula", "solarized-light": "dracula", "solarized": "dracula" };
const UI_VALUES = UI_FONT_OPTIONS.map((o) => o.value);
const MONO_VALUES = MONO_FONT_OPTIONS.map((o) => o.value);
const STYLE_VALUES = ["auto", "ghostty", "one", "dracula"];

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
  const remoteStyle = LEGACY_STYLE[a.termStyle] || a.termStyle; // 타 기기(구버전)발 'solarized' 도 이관
  if (STYLE_VALUES.includes(remoteStyle) && remoteStyle !== termStyle) { termStyle = remoteStyle; changed = true; }
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
// ★ 2026-08-15 전면 교체(사용자 확정): 서드파티 이식(Ghostty/One/Dracula/Solarized)을 버리고
//   CodingPT 디자인 언어로 직접 설계한 4종으로 통일. 값 키(ghostty/one/dracula)는 **동기화
//   계약**(백엔드 APPEARANCE_KEYS 화이트리스트 + 기존 저장값)이라 그대로 두고 표시 이름/팔레트만
//   교체 — 키를 바꾸면 back 배포와 락스텝이 되고 구버전 클라이언트 동기화가 깨진다.
export const TERM_STYLE_OPTIONS = [
  { value: "auto", label: "CodingPT (권장)" },
  { value: "ghostty", label: "미드나이트" },
  { value: "one", label: "모노" },
  { value: "dracula", label: "페이퍼" },
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
    // 미드나이트 — CodingPT 보다 한 단계 깊은 한밤 톤. 배경을 거의 검정까지 내리고
    //  색은 전부 차가운 쪽(블루 틴트)으로 정렬 — OLED/야간 작업용 고대비.
    dark: {
      background: "#060810", foreground: "#DCE3EE", cursor: "#DCE3EE", cursorAccent: "#060810",
      selectionBackground: "#1E3A5F", selectionInactiveBackground: "#1E3A5F",
      black: "#111624", red: "#F26D6D", green: "#41CF8F", yellow: "#E8B94E",
      blue: "#5B9DFF", magenta: "#A98BF5", cyan: "#3EC5DE", white: "#C2CBD8",
      brightBlack: "#4E5A70", brightRed: "#FF9191", brightGreen: "#71E4AE", brightYellow: "#F4CE74",
      brightBlue: "#8CBAFF", brightMagenta: "#C7B0FA", brightCyan: "#6FD9EC", brightWhite: "#F4F7FB",
    },
    light: {
      // 라이트 변형 = 순백 배경 + 진한 잉크(고대비 쌍둥이)
      background: "#FFFFFF", foreground: "#111827", cursor: "#111827", cursorAccent: "#FFFFFF",
      selectionBackground: "#CBDFF7", selectionInactiveBackground: "#CBDFF7",
      black: "#1F2937", red: "#C81E1E", green: "#047857", yellow: "#A16207",
      blue: "#1D4ED8", magenta: "#7E22CE", cyan: "#0E7490", white: "#D1D5DB",
      brightBlack: "#4B5563", brightRed: "#DC2626", brightGreen: "#059669", brightYellow: "#B45309",
      brightBlue: "#2563EB", brightMagenta: "#9333EA", brightCyan: "#0891B2", brightWhite: "#111827",
    },
  },
  one: {
    // 모노 — 무채색 지향. "포인트 컬러는 신호 전용" 원칙의 터미널판: ANSI 색의 채도를 크게
    //  낮춰 화면 전체가 회색조로 가라앉되, diff/에러 판독에 필요한 색상 구분만 은은히 남긴다.
    dark: {
      background: "#0D0F13", foreground: "#D6DAE0", cursor: "#D6DAE0", cursorAccent: "#0D0F13",
      selectionBackground: "#39414F", selectionInactiveBackground: "#39414F",
      black: "#1A1E26", red: "#D99A94", green: "#9DC6AC", yellow: "#CFC09A",
      blue: "#9AB3CF", magenta: "#B8A8CC", cyan: "#98C2C8", white: "#B7BEC7",
      brightBlack: "#5A626E", brightRed: "#E8B4AF", brightGreen: "#B7D8C3", brightYellow: "#E0D3B0",
      brightBlue: "#B4C9E0", brightMagenta: "#CCBFDD", brightCyan: "#B0D4D9", brightWhite: "#EEF1F5",
    },
    light: {
      background: "#F6F7F9", foreground: "#252A31", cursor: "#252A31", cursorAccent: "#FFFFFF",
      selectionBackground: "#D5DBE3", selectionInactiveBackground: "#D5DBE3",
      black: "#3B424C", red: "#9C4F45", green: "#43705A", yellow: "#7D6A38",
      blue: "#4A6584", magenta: "#6F5C86", cyan: "#417983", white: "#C9CED5",
      brightBlack: "#6E7580", brightRed: "#B26055", brightGreen: "#52856C", brightYellow: "#94804A",
      brightBlue: "#5B7899", brightMagenta: "#836F9B", brightCyan: "#528D97", brightWhite: "#14181D",
    },
  },
  dracula: {
    // 페이퍼 — 따뜻한 종이 톤(구 Solarized 사용자의 이관처). 라이트=크림 종이,
    //  다크=따뜻한 차콜. 색도 전부 웜 쪽으로 정렬해 장시간 독서형 작업에 편하게.
    dark: {
      background: "#16120C", foreground: "#EAE3D4", cursor: "#EAE3D4", cursorAccent: "#16120C",
      selectionBackground: "#4A3E28", selectionInactiveBackground: "#4A3E28",
      black: "#262016", red: "#E07A5F", green: "#A3B368", yellow: "#DCA54C",
      blue: "#7E9CBF", magenta: "#C08FB3", cyan: "#82BCA9", white: "#D3CAB8",
      brightBlack: "#756B58", brightRed: "#EE9880", brightGreen: "#BBC989", brightYellow: "#E9BC6F",
      brightBlue: "#9FB7D4", brightMagenta: "#D2A9C7", brightCyan: "#9FD0C0", brightWhite: "#F8F3E7",
    },
    light: {
      background: "#FAF5EA", foreground: "#3E362A", cursor: "#3E362A", cursorAccent: "#FFFFFF",
      selectionBackground: "#E4D8BC", selectionInactiveBackground: "#E4D8BC",
      black: "#57503F", red: "#B54E3B", green: "#5F7D33", yellow: "#95712A",
      blue: "#41678F", magenta: "#95588C", cyan: "#3E8577", white: "#DCD3C0",
      brightBlack: "#7C725E", brightRed: "#C96047", brightGreen: "#6F9040", brightYellow: "#A98336",
      brightBlue: "#527AA3", brightMagenta: "#A96CA0", brightCyan: "#4E9788", brightWhite: "#2A251C",
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
/** 현재 xterm 팔레트 — 선택된 스타일 계열의 현재 테마(다크/라이트) 변형.
 *  extendedAnsi(66번 리맵)까지 실어 보낸다 — 아래 termExtendedAnsi 주석 참조. */
export function termTheme() {
  const p = termStylePalette(termStyle, resolvedTheme());
  return { ...p, extendedAnsi: termExtendedAnsi(p) };
}
/** 256색 확장 팔레트 리맵(인덱스 66) — claude 등 chalk 계열은 COLORTERM=truecolor 가 없던
 *  환경에서 자기 선택색 hex(#264F78)를 256색으로 강등하는데, 그 결과가 인덱스 66(#5F8787
 *  세이지)이다(2026-08-15 capture-pane 실측 + 변환식 검산). 데몬이 새 세션엔 COLORTERM 을
 *  주입하지만 **이미 떠 있는 셸/TUI 는 env 를 다시 못 받으므로**, 이 인덱스를 스타일의
 *  선택색으로 되돌려 그린다. 66 을 본색으로 쓰는 TUI 는 사실상 없어 부작용 무시 가능.
 *  (모바일 terminalSchemes.ts termExtendedAnsi 와 한 벌 — 한쪽만 수정 금지) */
export const TERM_REMAP_ANSI_IDX = 66;
export function termExtendedAnsi(palette) {
  const ext = [];
  ext[TERM_REMAP_ANSI_IDX - 16] = palette.selectionBackground;
  return ext;
}
/** 현재 테마의 CodeMirror theme 이름 — 라이트는 코어 내장 default(별도 CSS 불필요). */
export function cmThemeName() {
  return resolvedTheme() === "light" ? "default" : "material-darker";
}
