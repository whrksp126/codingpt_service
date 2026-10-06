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

// ── 에이전트 행(Orca 방식, 2026-10-06) ─────────────────────────────────────────────────────────
//  워크스페이스 아래에 "그 폴더에서 돌아가는 에이전트" 를 한 줄씩 그린다. 일을 시킨 에이전트(코디네이터)가 부모 행이고
//  맡은 워커가 그 아래 자식 행이다 — 따로 "묶음" 이라는 행을 두지 않는다(무엇을 뜻하는지 읽히지 않았다).

/** 에이전트 세션 상태 → 표식. 끝난 턴의 글이 있으면 "끝"(체크), 없으면 한가함(회색 점). */
export function sessionGlyph(state, hasDetail) {
  if (state === "working") return "working";
  if (state === "permission" || state === "needsInput") return "waiting";
  if (state === "idle") return hasDetail ? "done" : "idle";
  return "idle";
}

/** 워커 상태 → 표식. 보고 없이 멈춘 것은 "끝" 도 "실패" 도 아니다 — 근거 없음(점선 고리). */
export function workerGlyph(ui) {
  return {
    starting: "working", working: "working", asking: "waiting", needs_input: "waiting", blocked: "blocked",
    idle_no_report: "unverifiable", exited: "unverifiable", succeeded: "done", failed: "failed",
    stopped: "interrupted", abandoned: "interrupted",
  }[ui] || "unverifiable";
}

const firstLine = (s) => String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
const SETTLED_UI = ["succeeded", "failed", "stopped", "abandoned"];

function workerRow(run, w) {
  const settled = SETTLED_UI.includes(w.uiState);
  const said = w.question ? firstLine(w.question.text) : settled ? firstLine(w.result && w.result.summary) : (w.phase || "");
  return {
    kind: "worker", key: "d:" + w.dispatchId, runId: run.id, dispatchId: w.dispatchId, glyph: workerGlyph(w.uiState), textKey: workerTextKey(w.uiState),
    agent: w.agent || null, lead: w.title || "", trail: said, model: w.model || "", at: (settled ? w.updatedAt : w.createdAt) || null,
    tid: w.tid == null ? null : w.tid, cwd: w.cwd || "", placement: w.placement || "current", terminal: w.terminal,
    branch: w.branch || "", taskId: (w.taskRef && w.taskRef.taskId) || null,
    needsReply: !!w.question, worker: w,
  };
}

/** 전용 작업 폴더(worktree)에서 도는 워커인가 — 그 워커는 시킨 에이전트의 폴더가 아니라 제 브랜치에 있다. */
export const inWorktree = (c) => !!c && c.placement === "worktree";
/**
 * 에이전트 행 트리 → 작업 폴더(worktree) 단위 묶음. [{ key, branch, taskId, workers:[워커 행…] }]
 *  사이드바는 워크스페이스 아래를 **작업 폴더 단위**로 그린다(Orca 와 같다): `로컬 · main` 과 그 안의 에이전트,
 *  그 옆에 브랜치마다 한 줄 + 그 안의 에이전트. 다른 브랜치의 워커를 main 아래에 그리면 main 에서 도는 것으로 읽힌다(2026-10-07 사용자 지적).
 *  브랜치가 아직 없으면(막 띄우는 중) 워커마다 한 묶음이다.
 */
export function worktreeGroups(rows) {
  const out = [];
  const by = new Map();
  for (const r of rows || []) for (const c of r.children || []) {
    if (!inWorktree(c)) continue;
    const key = c.branch ? "b:" + c.branch : "d:" + c.dispatchId;
    let g = by.get(key);
    if (!g) { g = { key, branch: c.branch || "", taskId: c.taskId || null, workers: [] }; by.set(key, g); out.push(g); }
    g.workers.push(c);
  }
  return out;
}

/**
 * 그 폴더의 에이전트 행 트리. → [{ kind:"session", key, tid, agent, glyph, lead, trail, at, runIds, rollup, children:[worker…] }]
 *  · 워커로 돌고 있는 터미널은 최상위에 다시 그리지 않는다(시킨 에이전트 아래에 있다).
 *  · 코디네이터 터미널을 못 찾은 묶음(에이전트가 꺼졌다)도 부모 행을 만들어 워커를 잃지 않는다.
 */
export function sessionTree(snapshot, cwd) {
  const here = cwd || "";
  const runs = runsForCwd(snapshot, here);
  const workerTerms = new Set();
  for (const run of (snapshot && snapshot.runs) || []) {
    if (run.state !== "active") continue;
    for (const w of visibleWorkers(run)) if (w.tid != null && w.terminal !== "released") workerTerms.add(`${w.cwd || ""}\n${w.tid}`);
  }
  const rows = [];
  const byTid = new Map();
  // 터미널 에이전트 먼저(번호 순), 그다음 채팅 대화(만든 순 = ID 순). 상태가 바뀌어도 자리가 안 바뀌게 — since 는 정렬 키가 못 된다.
  const mine = ((snapshot && snapshot.sessions) || []).filter((x) => (x.cwd || "") === here);
  const terms = mine.filter((x) => !x.chat && x.tid != null && !workerTerms.has(`${here}\n${x.tid}`)).sort((a, b) => a.tid - b.tid);
  const chats = mine.filter((x) => x.chat && x.threadId).sort((a, b) => (String(a.threadId) < String(b.threadId) ? -1 : 1));
  for (const x of terms) {
    const row = { kind: "session", key: "s:" + x.tid, tid: x.tid, agent: x.agent || null, glyph: sessionGlyph(x.state, !!x.detail),
      lead: "", trail: x.detail || "", at: x.since || null, runIds: [], rollup: null, children: [] };
    rows.push(row);
    byTid.set(x.tid, row);
  }
  for (const x of chats) {
    rows.push({ kind: "session", key: "c:" + x.threadId, tid: null, threadId: x.threadId, chat: true, agent: x.agent || null, glyph: sessionGlyph(x.state, !!x.detail),
      lead: x.title || "", trail: x.detail || "", model: x.model || "", at: x.since || null, runIds: [], rollup: null, children: [] });
  }
  for (const run of runs) {
    const co = run.coordinator || {};
    let row = co.tid != null && (co.cwd || "") === here ? byTid.get(co.tid) : null;
    if (!row) {
      row = { kind: "session", key: "r:" + run.id, tid: co.tid == null || (co.cwd || "") !== here ? null : co.tid, agent: co.agent || null, glyph: "idle",
        lead: "", trail: "", at: run.createdAt || null, runIds: [], rollup: null, children: [], gone: true };
      rows.push(row);
    }
    row.runIds.push(run.id);
    if (!row.lead) row.lead = runTitle(run);
    const roll = runRollup(run);
    if (!row.rollup) row.rollup = { total: 0, live: 0, attention: 0, ok: 0, failed: 0, gates: 0 };
    for (const k of ["total", "live", "attention", "ok", "failed"]) row.rollup[k] += roll.counts[k];
    row.rollup.gates += roll.gates;
    for (const w of visibleWorkers(run)) row.children.push(workerRow(run, w));
    // 시킨 에이전트가 꺼졌거나 한가한데 사람이 답할 것이 남아 있으면 부모도 그것을 말한다(접혀 있어도 보이게).
    if ((row.gone || row.glyph === "idle" || row.glyph === "done") && row.rollup.attention + row.rollup.gates > 0) row.glyph = "waiting";
  }
  return rows;
}

/** 짧은 경과 시간 — "3m" "2h" "5d"(1분 안쪽은 "<1m"). 숫자와 단위뿐이라 번역이 필요 없다. */
export function shortAgo(at, now) {
  if (!at || !now || now < at) return "";
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
}
