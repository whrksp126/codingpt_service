// path-utils.js — 경로 문자열 헬퍼 + 플랫폼 판정(의존성 0 — node --test 로 단독 검증 가능).
//
// 왜 필요한가(Windows 포팅, 2026-08):
//  · 본문 곳곳의 `p.split("/").pop()` 류는 구분자가 `/` 하나라는 가정이다. Windows 경로는
//    `C:\Users\x` 처럼 `\` 가 섞여 오므로(OS 드롭·클립보드·fsAbs) **양쪽 구분자를 항상 인식**한다.
//  · 내부 정규화(홈-상대 워크스페이스 경로)는 `/` 그대로다 — 여기 헬퍼는 `/` 경로에 대해
//    기존 split("/") 코드와 **동일한 결과**를 내도록 맞춰져 있다(macOS 회귀 0 원칙).
//  · 셸 인용(shellQuote)은 대상 셸이 갈린다: macOS(zsh/bash)=POSIX 작은따옴표, win32=PowerShell
//    작은따옴표(`'` 를 `''` 로 두 배). 호출부가 플랫폼을 신경 쓰지 않도록 여기서 분기한다.
//
// ⚠ 이 모듈은 브라우저 전역(window/navigator) 없이도 동작해야 한다(테스트가 node 로 돌린다).

/** 플랫폼 판정 — 웹뷰에선 UA, node(테스트)에선 process.platform. */
const PLATFORM_STR = (() => {
  try {
    if (typeof navigator !== "undefined") return `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  } catch (_) { /* noop */ }
  return "";
})();
export const IS_WINDOWS = (() => {
  if (/Windows|Win32|Win64/i.test(PLATFORM_STR)) return true;
  if (/Mac|iPhone|iPad|iPod/i.test(PLATFORM_STR)) return false;
  try { return typeof process !== "undefined" && process.platform === "win32"; } catch (_) { return false; }
})();
/** ⌘ 를 쓰는 플랫폼인가. 판정 불능(임베디드 웹뷰 이상 등)일 때만 mac 폴백 —
 *  단 Windows 로 확정되면 절대 apple 로 떨어지지 않는다(구 폴백 true 의 결함 수정). */
export const IS_APPLE = (() => {
  if (IS_WINDOWS) return false;
  if (/Mac|iPhone|iPad|iPod/i.test(PLATFORM_STR)) return true;
  try { if (typeof process !== "undefined" && process.platform) return process.platform === "darwin"; } catch (_) { /* noop */ }
  return true; // 판정 재료가 전혀 없으면 기존과 동일하게 mac(주 배포 대상)
})();

const SEP_RE = /[\\/]/;

/** 마지막 세그먼트(파일명). `/` 경로에선 기존 `p.split("/").pop()` 과 동일. */
export function basename(p) {
  const s = String(p == null ? "" : p);
  const parts = s.split(SEP_RE);
  return parts.pop() || "";
}

/** 부모 경로. `/` 경로에선 기존 `p.split("/").slice(0,-1).join("/")` 과 동일(구분자 보존). */
export function dirname(p) {
  const s = String(p == null ? "" : p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i < 0 ? "" : s.slice(0, i);
}

/** 빈 세그먼트를 걷어낸 경로 조각 배열 — 깊이 계산·표시용. */
export function splitSegs(p) {
  return String(p == null ? "" : p).split(SEP_RE).filter(Boolean);
}

/** 절대 경로인가 — POSIX(`/…`)·Windows 드라이브(`C:\…`/`C:/…`)·UNC(`\\…`) 모두. */
export function isAbs(p) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(String(p == null ? "" : p));
}

/**
 * 경로 결합. 내부 정규화 경로(`/`)는 `/` 로 잇고, Windows 스타일(드라이브/역슬래시) 기반이면
 *  `\` 로 잇는다. `/` 경로에선 기존 `a + "/" + b` 와 동일한 문자열을 낸다.
 */
export function joinPath(...parts) {
  const list = parts.map((p) => String(p == null ? "" : p)).filter((p) => p !== "");
  if (!list.length) return "";
  const winStyle = /^[A-Za-z]:[\\/]/.test(list[0]) || list[0].includes("\\");
  const sep = winStyle ? "\\" : "/";
  let out = list[0];
  for (let i = 1; i < list.length; i++) {
    const seg = list[i].replace(/^[\\/]+/, "");
    out = out.replace(/[\\/]+$/, "") + sep + seg;
  }
  return out;
}

/**
 * 터미널에 꽂을 경로의 셸 안전 인용.
 *  · POSIX(macOS 기본): `'` 감싸기 + 내부 `'` → `'\''`
 *  · PowerShell(win32 기본 셸): `'` 감싸기 + 내부 `'` → `''`
 *  테스트에서 플랫폼을 고정할 수 있게 두 번째 인자로 덮어쓸 수 있다.
 */
export function shellQuote(p, win = IS_WINDOWS) {
  const s = String(p == null ? "" : p);
  if (win) return "'" + s.replace(/'/g, "''") + "'";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
