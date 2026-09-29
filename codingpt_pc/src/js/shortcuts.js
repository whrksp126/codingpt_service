// shortcuts.js — 사용자가 바꾼 단축키의 보관·적용(PC).
//
// 저장 자리가 둘인 이유:
//  · localStorage — **즉시** 적용되어야 한다. 서버 왕복을 기다리는 동안 단축키가 기본값으로
//    돌아가 있으면 눌린 키가 엉뚱한 일을 한다.
//  · 계정(appearance.shortcuts) — PC 를 여러 대 쓰면 한 대에서 바꾼 걸 다른 대에서 다시 잡을
//    이유가 없다. 글꼴·터미널 스타일과 같은 성격이라 **같은 경로**(PATCH /api/daemon/me
//    {appearance} → appearance_event 팬아웃)를 그대로 탄다.
//
// 규율:
//  · 값 `null` 은 "이 명령은 단축키 없음"이라는 **유효한 의사**다. 기본값으로 되살리지 않는다
//    (되살리면 지운 키가 유령처럼 다시 먹는다).
//  · 서버발 적용은 **되밀지 않는다**(theme.js 와 같은 규칙 — 안 그러면 두 기기가 서로에게
//    같은 값을 무한히 보낸다).
//  · 판정(정규화·충돌·병합)은 전부 commands.js 다. 여기는 보관과 배선만 한다.
import { api } from "./api.js";
import { resolveBindings, normalizeCombo, comboFromEvent, defaultBindings } from "./commands.js";
import { IS_APPLE as PU_IS_APPLE, IS_WINDOWS as PU_IS_WINDOWS } from "./path-utils.js";

const KEY = "cpt.shortcuts";

/** ⌘ 를 쓰는 플랫폼인가. 조합의 `Mod` 가 무엇으로 풀리는지를 정한다.
 *  판정 구현은 path-utils.js 한 곳이다(의존성 0 — 테스트에서도 같은 판정을 쓴다).
 *  구 폴백 "무조건 mac" 은 Windows 배포에서 결함이라 path-utils 쪽에서 수정됐다. */
export const IS_APPLE = PU_IS_APPLE;
/** Windows 인가 — win32 기본 바인딩 표(WIN_KEYS)·입력층 분기가 이 값 하나를 본다. */
export const IS_WINDOWS = PU_IS_WINDOWS;

/** 사용자가 바꾼 것만 담는다(안 바꾼 명령은 여기 없다 = 기본값). */
let overrides = {};
let resolved = resolveBindings("pc", null, IS_WINDOWS);
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) overrides = raw;
  } catch (_) { /* 손상된 값은 무시 — 기본값으로 시작한다 */ }
  resolved = resolveBindings("pc", overrides, IS_WINDOWS);
}
load();

function emit() {
  resolved = resolveBindings("pc", overrides, IS_WINDOWS);
  listeners.forEach((fn) => { try { fn(resolved); } catch (_) { /* noop */ } });
}

/** 지금 적용 중인 조합표(id → 조합|null). 읽기 전용으로 쓴다. */
export function bindings() {
  return resolved;
}

/** 사용자가 바꾼 것만(설정 화면의 "기본값과 다른가" 판정용). */
export function overridesSnapshot() {
  return { ...overrides };
}

export function isDefault(id) {
  return !Object.prototype.hasOwnProperty.call(overrides, id);
}

let pushTimer = 0;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // 구 서버는 이 키를 모른 채 버린다(화이트리스트) — 오류가 아니라 "동기화만 안 됨"이다.
    api.updateAppearance({ shortcuts: overrides }).catch(() => {});
  }, 400);
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch (_) { /* noop */ }
}

/**
 * 하나 바꾸기. `combo` 가 null 이면 "단축키 없음"(지우기), 기본값과 같아지면 override 를 뺀다
 *  (설정 파일에 의미 없는 줄이 쌓이지 않게).
 */
export function setBinding(id, combo) {
  const def = defaultBindings("pc", IS_WINDOWS);
  if (!Object.prototype.hasOwnProperty.call(def, id)) return;
  const next = combo == null ? null : normalizeCombo(combo);
  if (combo != null && next == null) return;      // 못 읽는 조합은 조용히 버리지 않고 아무것도 안 한다
  const defCombo = def[id] == null ? null : normalizeCombo(def[id]);
  if (next === defCombo) delete overrides[id];
  else overrides[id] = next;
  persist(); emit(); schedulePush();
}

export function resetBinding(id) {
  if (!Object.prototype.hasOwnProperty.call(overrides, id)) return;
  delete overrides[id];
  persist(); emit(); schedulePush();
}

export function resetAll() {
  if (!Object.keys(overrides).length) return;
  overrides = {};
  persist(); emit(); schedulePush();
}

/** 서버/타 기기발 적용(부트 fetch_me·appearance_event) — 되밀지 않는다. */
export function applyRemoteShortcuts(sc) {
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return;
  if (JSON.stringify(sc) === JSON.stringify(overrides)) return;
  overrides = { ...sc };
  persist(); emit();
}

export function onShortcutsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 이벤트 → 조합(이 플랫폼 기준). 설정 화면의 "새 조합 받기"와 실제 처리가 같은 함수를 쓴다. */
export function comboOf(e) {
  return comboFromEvent(e, IS_APPLE);
}
