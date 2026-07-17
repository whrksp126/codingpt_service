// auto-checkpoint.js — 작업 스냅샷(자동 체크포인트) 설정 + 트리거.
//  모바일 useDaemonAutoCheckpoint 패리티: 주기(~30s) + 워크스페이스 전환 직전(handoff).
//  변경이 없으면 데몬이 트리 비교로 skip 하므로 트리거는 단순 발사(중복은 데몬이 흡수).
//  설정은 기기 로컬(localStorage, 기본 끔) — 모바일 AsyncStorage 와 동일 시맨틱.
import { state, activeWs, subscribe } from "./state.js";
import { api } from "./api.js";

const LS_KEY = "cpt.autoCheckpoint";
const PERIODIC_MS = 30_000;
const MIN_INTERVAL_MS = 8_000; // 트리거 겹칠 때 과호출 방지(전환직전은 예외로 강제)

export function getAutoCheckpointEnabled() {
  try { return localStorage.getItem(LS_KEY) === "1"; } catch (_) { return false; }
}
export function setAutoCheckpointEnabled(v) {
  try { localStorage.setItem(LS_KEY, v ? "1" : "0"); } catch (_) {}
}

let inFlight = false;
let lastAt = 0;
async function run(wsId, reason) {
  if (!getAutoCheckpointEnabled() || !wsId || !state.paired) return;
  const now = Date.now();
  if (now - lastAt < MIN_INTERVAL_MS) return;
  if (inFlight) return;
  inFlight = true; lastAt = now;
  try { await api.syncCheckpoint(wsId, reason); }
  catch (_) { /* 오프라인/일시오류는 조용히 — 다음 트리거가 재시도 */ }
  finally { inFlight = false; }
}

let inited = false;
export function initAutoCheckpoint() {
  if (inited) return;
  inited = true;
  // 주기 — 활성 워크스페이스 대상. cwd 미지정 = 백엔드가 ws.localPath 사용.
  setInterval(() => { const w = activeWs(); if (w) void run(w.id, "periodic"); }, PERIODIC_MS);
  // 전환 직전 — activeWsId 가 바뀌면 직전 워크스페이스를 강제 체크포인트(스로틀/인플라이트 무시).
  let prev = state.activeWsId;
  subscribe(() => {
    const cur = state.activeWsId;
    if (cur === prev) return;
    const leaving = prev;
    prev = cur;
    if (leaving && getAutoCheckpointEnabled() && state.paired) {
      api.syncCheckpoint(leaving, "handoff").catch(() => {});
    }
  });
}
