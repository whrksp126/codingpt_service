// 명령 레지스트리 — 팔레트의 행 목록이자 단축키 설정의 표다(**같은 테이블 하나**).
//
// 왜 하나인가: 둘로 나누면 "팔레트에는 있는데 단축키는 못 거는 명령", "단축키는 있는데 팔레트에서
//  안 보이는 명령"이 생기고, 새 기능을 넣을 때마다 두 곳을 기억해야 한다(전례가 많다). 여기 한 줄을
//  더하면 팔레트와 설정에 동시에 나타난다.
//
// ⚠ 앱(codingpt_app/src/palette/commands.ts)에 같은 표가 있다 — id·기본 조합·범위·노출 플래그가
//   대조 테스트로 묶여 있다. 한쪽만 고치면 테스트가 깨진다.
//
// 규율:
//  · **문구는 여기 없다** — text/palette.js 사전이 정본이다(다국어 다음 차수 대비).
//  · `key` 는 기본값일 뿐이다. 사용자가 바꾼 값은 shortcuts.js 가 들고 있다.
//  · `palette:false` = 단축키로만 쓰는 것(팔레트 자신, 워크스페이스 1~8 이동). 팔레트 목록에
//    "팔레트 열기"가 있으면 우스꽝스럽고, 워크스페이스 이동 8줄은 목록을 덮어 버린다.
//  · `scope` 는 **언제 쓸 수 있나**다. 'workspace' 는 워크스페이스가 열려 있어야 하고,
//    'pane' 은 포커스된 pane 이 있어야 한다. 조건이 안 되면 팔레트에서 흐리게 보이고 실행되지 않는다.

/**
 * @typedef {{ id:string, key:string|null, scope:'global'|'workspace'|'pane',
 *             group:string, pc:boolean, app:boolean, palette:boolean }} CommandDef
 */

/** @type {CommandDef[]} */
export const COMMANDS = [
  // ── 열기/찾기 ──
  { id: "palette.open", key: "Mod+P", scope: "global", group: "open", pc: true, app: true, palette: false },
  // 앱은 pc:false 가 아니라 **app:false** 다 — 폰 IDE 는 트리 헤더에 검색창이 상시 떠 있어서
  //  "찾기를 연다"는 명령 자체가 필요 없다(늘 흐린 행이 하나 남는 것보다 없는 게 낫다).
  { id: "find.open", key: "Mod+F", scope: "pane", group: "open", pc: true, app: false, palette: true },
  //  ★ 2026-08-05: 옛 `실행` 묶음의 마지막 한 줄이었다(저장한 명령이 사라지면서 혼자 남음).
  //   한 줄짜리 묶음은 분류가 아니라 장식이라 `열기` 로 옮겼다 — 하는 일도 "열린 포트를 본다" 다.
  { id: "ws.ports", key: null, scope: "workspace", group: "open", pc: true, app: true, palette: true },

  // ── 워크스페이스에 추가 ──
  { id: "ws.addTerminal", key: "Mod+T", scope: "workspace", group: "add", pc: true, app: true, palette: true },
  { id: "ws.addIde", key: "Mod+E", scope: "workspace", group: "add", pc: true, app: true, palette: true },
  { id: "ws.addPreview", key: "Mod+Shift+E", scope: "workspace", group: "add", pc: true, app: true, palette: true },
  // 모바일 화면(에뮬레이터·시뮬레이터·붙어 있는 실기기) — 단축키는 안 준다(앱 commands.ts 주석 참조).
  { id: "ws.addEmulator", key: null, scope: "workspace", group: "add", pc: true, app: true, palette: true },

  // ── pane 조작 ──
  { id: "pane.splitRight", key: "Mod+D", scope: "pane", group: "pane", pc: true, app: false, palette: true },
  { id: "pane.splitDown", key: "Mod+Shift+D", scope: "pane", group: "pane", pc: true, app: false, palette: true },
  { id: "pane.close", key: "Mod+W", scope: "pane", group: "pane", pc: true, app: true, palette: true },
  { id: "pane.focusLeft", key: "Mod+Alt+ArrowLeft", scope: "pane", group: "pane", pc: true, app: false, palette: true },
  { id: "pane.focusRight", key: "Mod+Alt+ArrowRight", scope: "pane", group: "pane", pc: true, app: false, palette: true },
  { id: "pane.focusUp", key: "Mod+Alt+ArrowUp", scope: "pane", group: "pane", pc: true, app: false, palette: true },
  { id: "pane.focusDown", key: "Mod+Alt+ArrowDown", scope: "pane", group: "pane", pc: true, app: false, palette: true },

  // ── 보기 ──
  { id: "sidebar.toggle", key: "Mod+B", scope: "global", group: "view", pc: true, app: true, palette: true },
  { id: "notif.panel", key: null, scope: "global", group: "view", pc: true, app: true, palette: true },
  { id: "notif.latestUnread", key: "Mod+Shift+U", scope: "global", group: "view", pc: true, app: true, palette: true },

  // ── 설정 ──
  { id: "app.settings", key: "Mod+Comma", scope: "global", group: "settings", pc: true, app: true, palette: true },
  { id: "settings.shortcuts", key: null, scope: "global", group: "settings", pc: true, app: true, palette: true },

  // ── 워크스페이스 이동(단축키 전용) ──
  //  팔레트에 8줄을 깔면 목록이 이것만 남는다. 워크스페이스 전환은 사이드바가 정본이다.
  { id: "ws.select1", key: "Mod+1", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select2", key: "Mod+2", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select3", key: "Mod+3", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select4", key: "Mod+4", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select5", key: "Mod+5", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select6", key: "Mod+6", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select7", key: "Mod+7", scope: "global", group: "goto", pc: true, app: true, palette: false },
  { id: "ws.select8", key: "Mod+8", scope: "global", group: "goto", pc: true, app: true, palette: false },
];

// ── win32 기본값 오버라이드(2026-08, Windows 포팅 계약 5) ────────────────────
//  왜 표가 따로인가: 비-Apple 에서 `Mod` 는 Ctrl 로 풀리는데, 터미널 앱에서 Ctrl+글자는
//  셸 제어문자(^P ^F ^T ^D ^W ^B …)와 정면 충돌한다. 그래서 win32 기본값은 Windows Terminal/
//  VS Code 관용대로 **Ctrl+Shift 계열**로 옮긴다(팔레트 Ctrl+Shift+P, 검색 Ctrl+Shift+F …).
//  · Ctrl+Alt 조합은 win32 기본값으로 쓰지 않는다 — AltGr(유럽 자판의 문자 입력)가 곧
//    ctrl+alt 라서, 걸어 두면 문자 입력을 삼킨다. pane 포커스 이동은 WT 관용(Alt+화살표).
//  · 여기 없는 명령(Mod+Comma, Mod+1~8, Mod+Shift+U)은 Ctrl 로 풀려도 제어문자가 아니라
//    mac 표 그대로 쓴다.
//  ⚠ COMMANDS 의 `key` 는 앱(commands.ts)과 대조 테스트로 묶여 있어 건드리지 않는다 —
//    win32 차이는 이 오버라이드 한 겹으로만 표현한다.
const WIN_KEYS = {
  "palette.open": "Mod+Shift+P",
  "find.open": "Mod+Shift+F",
  "ws.addTerminal": "Mod+Shift+T",
  "ws.addIde": "Mod+Shift+E",
  "ws.addPreview": "Mod+Shift+O",
  "pane.splitRight": "Mod+Shift+D",
  "pane.splitDown": "Alt+Shift+D",
  "pane.close": "Mod+Shift+W",
  "pane.focusLeft": "Alt+ArrowLeft",
  "pane.focusRight": "Alt+ArrowRight",
  "pane.focusUp": "Alt+ArrowUp",
  "pane.focusDown": "Alt+ArrowDown",
  "sidebar.toggle": "Mod+Shift+B",
};

/** 이 플랫폼에서 쓰는 것만. platform: 'pc' | 'app' */
export function commandsFor(platform) {
  return COMMANDS.filter((c) => (platform === "app" ? c.app : c.pc));
}

export function commandById(id) {
  return COMMANDS.find((c) => c.id === id) || null;
}

/** id → 기본 조합. 사용자가 바꾸지 않은 값의 출처.
 *  `windows` 가 참이면 win32 오버라이드(WIN_KEYS)를 덮는다 — 생략 시 기존 동작 그대로. */
export function defaultBindings(platform, windows = false) {
  const out = {};
  for (const c of commandsFor(platform)) {
    out[c.id] = windows && Object.prototype.hasOwnProperty.call(WIN_KEYS, c.id) ? WIN_KEYS[c.id] : c.key;
  }
  return out;
}

// ── 키 조합 표기 ────────────────────────────────────────────────────────────
// 문자열 하나로 저장한다: `Mod+Shift+D`. 저장 형식이 사람이 읽을 수 있어야 설정 파일을 열어 봤을 때
//  무슨 일이 벌어지는지 알 수 있다(불투명한 키코드 배열 금지).
//
//  · `Mod` = macOS/iOS 의 ⌘, 그 외의 Ctrl. **플랫폼마다 다른 조합을 따로 저장하지 않는다** —
//    같은 설정이 두 기기에서 다르게 보이는 것보다, 한 이름이 각 OS 의 관용에 맞게 풀리는 게 낫다.
//  · 수식어 순서는 항상 Mod, Ctrl, Alt, Shift 다(정규화 — 같은 조합이 두 문자열이 되면 충돌 검사가
//    무너진다).

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

/** 화면에 그대로 쓰는 특수키 이름(값 = 저장 이름). */
export const NAMED_KEYS = [
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Enter", "Escape", "Space", "Tab", "Backspace", "Delete",
  "Home", "End", "PageUp", "PageDown",
  "Comma", "Period", "Slash", "Backslash", "Semicolon", "Quote",
  "BracketLeft", "BracketRight", "Backquote", "Minus", "Equal",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

const PUNCT_TO_NAME = {
  ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash", ";": "Semicolon",
  "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "`": "Backquote",
  "-": "Minus", "=": "Equal", " ": "Space",
};

const NAME_TO_SYMBOL = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Enter: "↩", Escape: "esc", Space: "space", Tab: "⇥", Backspace: "⌫", Delete: "⌦",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backquote: "`", Minus: "-", Equal: "=",
};

/**
 * 저장 문자열 정규화. 못 읽으면 null(= 조합 없음)이다.
 *  대소문자·수식어 순서·별칭(cmd/command/meta/option/ctrl)을 하나로 모은다.
 */
export function normalizeCombo(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "mod" || l === "cmd" || l === "command" || l === "meta" || l === "super") { mods.add("Mod"); continue; }
    if (l === "ctrl" || l === "control") { mods.add("Ctrl"); continue; }
    if (l === "alt" || l === "option" || l === "opt") { mods.add("Alt"); continue; }
    if (l === "shift") { mods.add("Shift"); continue; }
    if (key != null) return null;              // 키가 둘 = 못 읽는 조합
    key = canonicalKey(p);
    if (key == null) return null;
  }
  if (key == null) return null;
  // 수식어 없는 단일 문자 조합은 받지 않는다 — 터미널에 글자를 칠 수 없게 된다.
  if (!mods.size && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** 키 이름 한 조각을 저장 이름으로. 못 읽으면 null. */
export function canonicalKey(raw) {
  const s = String(raw || "");
  if (!s) return null;
  if (PUNCT_TO_NAME[s]) return PUNCT_TO_NAME[s];
  const named = NAMED_KEYS.find((n) => n.toLowerCase() === s.toLowerCase());
  if (named) return named;
  if (s.length === 1) {
    const c = s.toUpperCase();
    if (/[A-Z0-9]/.test(c)) return c;
    return null;
  }
  return null;
}

/**
 * 조합 → 화면 표기. mac 은 기호(⌘⌥⇧), 그 외는 낱말(Ctrl+Alt+Shift).
 *  `apple` = ⌘ 를 쓰는 플랫폼인가(macOS·iOS·iPadOS).
 */
export function formatCombo(combo, apple) {
  const norm = normalizeCombo(combo);
  if (!norm) return "";
  const parts = norm.split("+");
  const key = parts.pop();
  const sym = NAME_TO_SYMBOL[key] || key;
  if (apple) {
    let out = "";
    if (parts.includes("Mod")) out += "⌘";
    if (parts.includes("Ctrl")) out += "⌃";
    if (parts.includes("Alt")) out += "⌥";
    if (parts.includes("Shift")) out += "⇧";
    return out + sym;
  }
  // 비-Apple 은 Mod=Ctrl 이다. `Mod+Ctrl+X`(mac 의 ⌘⌃X 저장값)가 오면 Ctrl 이 두 번 찍히지
  //  않게 하나로 접는다(combo 포맷의 Ctrl 명시 수식어 허용 — Windows 포팅 계약 5).
  const words = [];
  for (const p of parts) {
    const w = p === "Mod" ? "Ctrl" : p;
    if (!words.includes(w)) words.push(w);
  }
  return [...words, sym].join("+");
}

/** formatCombo 의 키캡 분해판 — 설정 화면이 조합을 낱개 키캡(⌘ ⇧ E)으로 그릴 때 쓴다.
 *  표기 규칙(수식어 순서·Mod 접기)은 formatCombo 와 동일해야 한다 — 한쪽만 고치지 말 것. */
export function formatComboParts(combo, apple) {
  const norm = normalizeCombo(combo);
  if (!norm) return [];
  const parts = norm.split("+");
  const key = parts.pop();
  const sym = NAME_TO_SYMBOL[key] || key;
  if (apple) {
    const out = [];
    if (parts.includes("Mod")) out.push("⌘");
    if (parts.includes("Ctrl")) out.push("⌃");
    if (parts.includes("Alt")) out.push("⌥");
    if (parts.includes("Shift")) out.push("⇧");
    return [...out, sym];
  }
  const words = [];
  for (const p of parts) {
    const w = p === "Mod" ? "Ctrl" : p;
    if (!words.includes(w)) words.push(w);
  }
  return [...words, sym];
}

/**
 * 비-Apple(Mod=Ctrl) 정규화 — 명시 `Ctrl` 수식어를 `Mod` 로 접는다.
 *  손으로 적은 `Ctrl+Shift+P` 저장값이 실제 키 이벤트(comboFromEvent 는 Mod 로 보고)와
 *  같은 문자열이 되어야 매칭이 산다. Apple 에선 ⌘(Mod)과 ⌃(Ctrl)이 딴 키라 접지 않는다.
 */
export function foldCtrlIntoMod(combo) {
  const norm = normalizeCombo(combo);
  if (!norm) return null;
  const parts = norm.split("+");
  const key = parts.pop();
  const mods = new Set(parts.map((p) => (p === "Ctrl" ? "Mod" : p)));
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/**
 * 브라우저 KeyboardEvent → 저장 조합. 수식어만 눌린 상태면 null.
 *  ⚠ `e.key` 는 수식어에 따라 변한다(⌥+A → "å", Shift+1 → "!"). 그래서 **e.code 를 우선**한다 —
 *   같은 물리 키가 항상 같은 이름이 되어야 설정한 대로 눌린다.
 */
export function comboFromEvent(e, apple) {
  const code = e && e.code ? String(e.code) : "";
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (code && NAMED_KEYS.includes(code)) key = code;
  else if (code === "Minus" || code === "Equal") key = code;
  else key = canonicalKey(e && e.key);
  if (key == null) return null;
  // 수식어 키 자체는 조합이 아니다.
  if (["Shift", "Control", "Alt", "Meta"].includes(String(e && e.key))) return null;
  // AltGr(비-Apple 의 ctrl+alt 동시) = 문자 입력이다 — 조합으로 잡으면 유럽 자판의 글자를
  //  삼킨다. 항상 null 을 돌려 셸/입력칸으로 통과시킨다(Windows 포팅 계약 5).
  if (!apple && e && e.ctrlKey && e.altKey) return null;
  const mods = [];
  const modDown = apple ? !!(e && e.metaKey) : !!(e && e.ctrlKey);
  const ctrlDown = apple ? !!(e && e.ctrlKey) : false;
  if (modDown) mods.push("Mod");
  if (ctrlDown) mods.push("Ctrl");
  if (e && e.altKey) mods.push("Alt");
  if (e && e.shiftKey) mods.push("Shift");
  if (!mods.length && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...MOD_ORDER.filter((m) => mods.includes(m)), key].join("+");
}

/**
 * 충돌 검사 — 같은 조합에 둘 이상이 걸렸는가.
 *  범위(scope)로 봐주지 않는다. 실제 처리는 창 하나의 keydown 에서 갈리므로, 같은 조합이면
 *  어느 하나는 반드시 진다. "가끔 안 먹는 단축키"보다 "지금 겹쳤다"고 말하는 게 낫다.
 * @returns {Record<string,string[]>} 조합 → 겹친 id 들(2개 이상인 것만)
 */
export function findConflicts(bindings) {
  const byCombo = {};
  for (const id of Object.keys(bindings || {})) {
    const c = normalizeCombo(bindings[id]);
    if (!c) continue;
    (byCombo[c] || (byCombo[c] = [])).push(id);
  }
  const out = {};
  for (const c of Object.keys(byCombo)) {
    if (byCombo[c].length > 1) out[c] = byCombo[c].slice().sort();
  }
  return out;
}

/** 저장값 + 기본값 → 실제 적용 조합표. 사용자가 비운 것(null)은 "안 걸림"이다.
 *  `windows` 가 참이면 ① 기본값에 WIN_KEYS 를 덮고 ② 명시 Ctrl 을 Mod 로 접는다
 *  (comboFromEvent 가 비-Apple 에서 Ctrl 을 Mod 로 보고하므로 — 매칭 표기 통일). */
export function resolveBindings(platform, saved, windows = false) {
  const defaults = defaultBindings(platform, windows);
  const out = {};
  for (const c of commandsFor(platform)) {
    const has = saved && Object.prototype.hasOwnProperty.call(saved, c.id);
    const v = has ? saved[c.id] : defaults[c.id];
    out[c.id] = v == null ? null : (windows ? foldCtrlIntoMod(v) : normalizeCombo(v));
  }
  return out;
}

/** 적용 조합표에서 이 조합에 걸린 명령 id(없으면 null). */
export function commandForCombo(resolved, combo) {
  if (!combo) return null;
  for (const id of Object.keys(resolved || {})) {
    if (resolved[id] === combo) return id;
  }
  return null;
}
