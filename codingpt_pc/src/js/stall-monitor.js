// stall-monitor — 화면(JS) 스레드가 멈춘 순간을 pc-ui.log 에 남긴다. 무엇이 그 직전에 돌았는지도 같이.
//  2026-10-23 "주기적으로 타이핑·스크롤이 끊긴다(1~5분 간격)" 재발 — 측정 창(45분)에선 재현이 안 돼
//  추측 대신 상시 기록으로 바꿨다. 끊겼다는 시각만 알면 이 로그 한 줄이 범인을 가리킨다.
//  · 감지 = 100ms 타이머의 지연. 150ms 이상 늦게 깨면 그동안 스레드가 붙들려 있었다는 뜻이다.
//  · 화면이 안 보일 때(숨김·가려짐)는 WebKit 이 타이머를 늦추므로 판정하지 않는다(가짜 멈춤).
//  · 주기 작업은 jobMark(이름) 으로 시작을 찍고, 렌더 같은 동기 작업은 noteSlow(이름, ms) 로 길이를 남긴다.
//    멈춤 한 줄에 "그 창 안에서 시작된 작업들"을 붙여 쓴다.
import { api } from "./api.js";

const TICK_MS = 100;
const STALL_MS = 150;          // 이만큼 늦게 깨면 멈춤으로 본다(체감 끊김 하한 근처)
const SLOW_MS = 50;            // 동기 작업이 이보다 길면 기록해 둔다(멈춤 줄에 붙는다)
const RING = 40;
const MAX_LINES_PER_MIN = 30;  // 폭주 시 로그가 앱을 방해하지 않게

const recent = []; // { name, at(performance.now), ms? }
function push(e) { recent.push(e); if (recent.length > RING) recent.shift(); }

/** 주기 작업 시작 표시 — 멈춤 줄에 "이 창 안에서 시작된 작업" 으로 나온다. */
export function jobMark(name) { push({ name, at: performance.now() }); }

/** 동기 구간 길이 기록 — SLOW_MS 이상만 남긴다. */
export function noteSlow(name, ms) { if (ms >= SLOW_MS) push({ name, at: performance.now() - ms, ms }); }

let started = false;
export function startStallMonitor() {
  if (started) return;
  started = true;
  let last = performance.now();
  let lastVisible = document.visibilityState === "visible";
  let windowStart = 0; let lines = 0;
  setInterval(() => {
    const now = performance.now();
    const gap = now - last - TICK_MS;
    const visible = document.visibilityState === "visible";
    if (gap >= STALL_MS && visible && lastVisible) {
      if (now - windowStart > 60_000) { windowStart = now; lines = 0; }
      if (lines++ < MAX_LINES_PER_MIN) {
        const from = last - 50;
        const jobs = recent.filter((e) => e.at >= from && e.at <= now)
          .map((e) => (e.ms != null ? `${e.name}(${Math.round(e.ms)}ms)` : e.name));
        api.debugLog(`[stall] web ${Math.round(gap)}ms focus=${document.hasFocus() ? 1 : 0} jobs=${jobs.join(",") || "-"}`);
      }
    }
    last = now;
    lastVisible = visible;
  }, TICK_MS);
}
