// desktop-os — 에이전트 PC 게스트 OS 캐시(전역: 맥 1대 = 데스크톱 1대라 하나면 충분).
//  상태 폴링(emulator-view)·설정(desktop-sheet/추가메뉴)에서 갱신하고, pane 탭이 파비콘(OS 로고)과
//  이름("macOS · VM"/"Linux · VM")을 여기서 읽는다. 모르면 null → 기존 모니터 아이콘·"에이전트 PC" 로 폴백.
let _os = null;   // 'macos' | 'linux' | null(아직 모름)

export function getDesktopOs() { return _os; }

/** 알게 된 OS 를 저장한다. 값이 바뀌면 true(호출부가 탭을 다시 그리게). null/빈 값은 무시(기존 값 유지). */
export function setDesktopOs(k) {
  const v = k === "linux" ? "linux" : k === "macos" ? "macos" : null;
  if (!v || v === _os) return false;
  _os = v;
  return true;
}

/** 탭 이름 — "macOS · VM" / "Linux · VM". 인자 없으면 캐시 값 사용. */
export function osVmLabel(k) { return (((k || _os) === "linux") ? "Linux" : "macOS") + " · VM"; }
