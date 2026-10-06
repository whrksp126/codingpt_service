// orch-model.js — 오케스트레이션 화면 판정(순수 함수). 앱의 `src/workspace/orchModel.ts` 와 **같은 규칙**이다
//  (픽스처 교차 검증: test/orch-crossimpl.mjs). 여기에 DOM·state 접근을 넣지 않는다.
//
// 입력 = 데몬 `orch.list` 응답 { runs:[{id, objective, cwd, coordinator:{cwd,tid}, workers:[…], gates:[…], tasks:[…]}], notes:[{cwd, comment, status}] }.
// 색은 상태 신호에만 쓴다(무채색 규칙): 확인이 필요하면 warn, 실패면 error, 나머지는 명암.

/** 워커 화면 상태(uiState) → 사람이 봐야 하는가. */
export const ATTENTION_STATES = ["asking", "blocked", "needs_input", "idle_no_report"];
const FAILED_STATES = ["failed", "exited", "abandoned"];
const LIVE_STATES = ["working", "starting"];

/** 워커 상태 점 — tv-dot 변형(none|spin|warn|error|off). */
export function workerDot(ui) {
  if (ATTENTION_STATES.includes(ui)) return "warn";
  if (FAILED_STATES.includes(ui)) return "error";
  if (LIVE_STATES.includes(ui)) return "spin";
  if (ui === "stopped") return "off";
  return "none";
}

/** 워커 상태 문구 키(text/orch) — 모르는 값은 작업 중으로 접지 않고 그대로 '알 수 없음'. */
export function workerTextKey(ui) {
  return {
    starting: "wStarting", working: "wWorking", asking: "wAsking", blocked: "wBlocked", needs_input: "wNeedsInput",
    idle_no_report: "wIdleNoReport", exited: "wExited", succeeded: "wSucceeded", failed: "wFailed",
    stopped: "wStopped", abandoned: "wAbandoned",
  }[ui] || "wUnknown";
}

/** 화면에 보일 워커 — 터미널을 다음 시도에 넘긴(transferred) 끝난 시도는 같은 터미널의 새 시도가 대신한다. */
export function visibleWorkers(run) {
  const ws = (run && run.workers) || [];
  return ws.filter((w) => !(w.terminal === "transferred" && w.state !== "ready" && w.state !== "starting"))
    .slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * 묶음 한 줄 요약 — 합산 순서는 "확인 필요 > 실패 > 진행 중 > 끝"(사람이 먼저 봐야 하는 순).
 *  → { dot, counts:{total, live, attention, ok, failed}, gates }
 */
export function runRollup(run) {
  const ws = visibleWorkers(run);
  const c = { total: ws.length, live: 0, attention: 0, ok: 0, failed: 0 };
  for (const w of ws) {
    const ui = w.uiState;
    if (ATTENTION_STATES.includes(ui)) c.attention += 1;
    else if (FAILED_STATES.includes(ui)) c.failed += 1;
    else if (LIVE_STATES.includes(ui)) c.live += 1;
    else if (ui === "succeeded") c.ok += 1;
  }
  const gates = ((run && run.gates) || []).length;
  const dot = c.attention || gates ? "warn" : c.failed ? "error" : c.live ? "spin" : "none";
  return { dot, counts: c, gates };
}

/** 그 폴더(홈-상대 경로)에서 코디네이터가 도는 진행 중 묶음들 — 오래된 것부터. */
export function runsForCwd(snapshot, cwd) {
  const runs = (snapshot && snapshot.runs) || [];
  return runs.filter((r) => r.state === "active" && (r.cwd || "") === (cwd || ""))
    .slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** 그 폴더의 한 줄 메모 — 없으면 null. */
export function noteFor(snapshot, cwd) {
  const n = ((snapshot && snapshot.notes) || []).find((x) => (x.cwd || "") === (cwd || ""));
  return n && (n.comment || n.status) ? { comment: n.comment || "", status: n.status || "" } : null;
}

/**
 * 터미널 좌표 → 역할. 키 = `${cwd}\n${tid}`.
 *  값 = { role:'coordinator'|'worker', runId, dispatchId?, uiState?, title?, dot }
 *  같은 터미널이 워커이면서 하위 묶음의 코디네이터이면 워커가 이긴다(그 터미널의 "지금 상태"는 맡은 일이다).
 */
export function terminalRoles(snapshot) {
  const out = new Map();
  for (const run of (snapshot && snapshot.runs) || []) {
    if (run.state !== "active") continue;
    const co = run.coordinator;
    if (co && co.tid != null) {
      const k = `${co.cwd || ""}\n${co.tid}`;
      if (!out.has(k)) out.set(k, { role: "coordinator", runId: run.id, dot: runRollup(run).dot, title: run.objective || "" });
    }
  }
  for (const run of (snapshot && snapshot.runs) || []) {
    if (run.state !== "active") continue;
    for (const w of visibleWorkers(run)) {
      if (w.tid == null || w.terminal === "released") continue;
      out.set(`${w.cwd || ""}\n${w.tid}`, { role: "worker", runId: run.id, dispatchId: w.dispatchId, uiState: w.uiState, title: w.title || "", dot: workerDot(w.uiState) });
    }
  }
  return out;
}

/**
 * 이 터미널이 같은 폴더 워커이면 그 묶음 코디네이터의 터미널 번호 — 아니면 null.
 *  새로 생긴 워커 탭을 "보고 있던 pane" 이 아니라 **시킨 에이전트가 있는 pane** 에 들이는 데 쓴다.
 */
export function coordinatorTidOf(snapshot, cwd, tid) {
  if (typeof tid !== "number") return null;
  for (const run of (snapshot && snapshot.runs) || []) {
    if (run.state !== "active") continue;
    const co = run.coordinator;
    if (!co || co.tid == null || (co.cwd || "") !== (cwd || "")) continue;
    if ((run.workers || []).some((w) => w.tid === tid && (w.cwd || "") === (cwd || "") && w.terminal !== "released")) return co.tid;
  }
  return null;
}

/** 사람이 답해야 하는 것의 수(질문 + 결정 + 사용자 입력 대기) — 사이드바 배지·접힌 머리 표시. */
export function attentionCount(snapshot, cwd) {
  let n = 0;
  for (const run of runsForCwd(snapshot, cwd)) {
    const r = runRollup(run);
    n += r.counts.attention + r.gates;
  }
  return n;
}

/** 목표 첫 줄(사이드바 제목). */
export function runTitle(run) {
  const line = String((run && run.objective) || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  return line.length > 60 ? line.slice(0, 59) + "…" : line;
}
