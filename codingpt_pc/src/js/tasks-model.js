// tasks-model.js — 작업 현황판의 **순수 판정**(설계 §5). import 0개 — node 에서 그대로 돈다.
//
// 왜 순수 모듈인가: 앱(codingpt_app/src/workspace/tasks/tasksModel.ts)에 같은 판정이 있고, 두 화면이
//  같은 입력에서 **다른 그룹·다른 순서**를 그리면 "폰에서는 입력 대기인데 PC 에서는 작업 중" 이 된다.
//  그래서 입력/기대 출력을 픽스처(docs/fixtures/agent-tasks/model-*.json)로 박고 양쪽이 같은 파일로 검증한다
//  (test/tasks-crossimpl.mjs · 앱 __tests__/tasksModel.test.ts).
//
// 규율(§5 정본 — 여기서 새 규칙을 만들지 않는다):
//  · host 는 숫자, **모름 = 0**. run 행의 host 는 tasks[].host. host 0 재시도는 두 곳뿐이다(§5.2 문언 그대로):
//    스냅을 run 행에 붙일 때(같은 k 가 없으면 `0|cwd|win`), 승인·미읽음을 host 를 아는 행에 붙일 때.
//    에이전트 행끼리는 정확한 k 로만 가른다(host 7 스냅과 host 0 스냅은 두 행 — 구 back 전환기의 과도 상태).
//  · 행 키 k = `${host}|${cwd}|${win}` (tid 없는 run 은 `-`). 종결 작업 행은 `${host}|task:${taskId}`.
//  · 그룹은 번호 순 첫 매치(§5.3). 정렬: 입력 대기는 기다린 시간 오래된 순, 나머지는 최근 활동 순.
//    동률은 k 오름차순(코드포인트 비교 — localeCompare 금지: 런타임마다 결과가 다르다).
//  · 오프라인 host(hosts[].online === false)의 행은 만들지 않고 `offline` 목록(호스트 id)으로만 남긴다.

/** 작업 run 이 데몬에 등록한 worktree 워크스페이스인가(§4 — 3 클라이언트 공통 술어). */
export function isTaskWorkspace(meta) {
  return !!meta && typeof meta.localPath === "string" && /^\.codingpt\/worktrees\//.test(meta.localPath);
}

export const GROUPS = ["needs_input", "working", "review_ready", "idle", "done"];
export const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const LIVE_STATES = ["idle", "working", "permission", "needsInput"];
const WAIT_LIVE = ["permission", "needsInput"];
const BUSY_RUN = ["creating", "launching", "merging"];
const HIDDEN_RUN = ["merged", "discarded"];
const TERMINAL_TASK = ["merged", "closed", "failed"];

/** host 정규화 — 숫자가 아니면 0(모름). */
export function normHost(h) {
  const n = Number(h);
  return h != null && h !== "" && Number.isFinite(n) ? n : 0;
}

export function rowKey(host, cwd, win) {
  return `${normHost(host)}|${cwd == null ? "" : String(cwd)}|${win == null || win === "" ? "-" : Number(win)}`;
}

function num(v, d = 0) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : d;
}

/**
 * 입력 대기 사유(§5.3 규칙 1 의 항목 순서 그대로 — 첫 매치). null = 입력 대기 아님.
 *  카드가 이 값으로 행동 버튼을 고른다(§5.4).
 */
export function needsInputReason(row) {
  const run = row.run;
  const live = row.live;
  if (run) {
    if (run.state === "failed") return "failed";
    const ec = run.error && run.error.code;
    if (ec === "PROMPT_NOT_DELIVERED") return "promptNotDelivered";
    if (ec === "OP_INTERRUPTED") return "interrupted";
    if (run.trustPending) return "trust";
    if (run.state === "running" && run.terminalAlive === false) return "terminalGone";
    if (run.agentGone) return "agentGone";
  }
  if (live && WAIT_LIVE.includes(live.state)) return live.state;
  if (row.approvals.length > 0) return "approval";
  if (run && row.task && row.task.state === "merged" && run.id !== row.task.winnerRunId) return "keptDirty";
  if (run && run.lastOp && run.lastOp.ok === false) return "opFailed";
  return null;
}

/** 그룹 판정(§5.3). */
export function groupOf(row) {
  if (row.kind === "task") return "done";
  if (needsInputReason(row)) return "needs_input";
  const run = row.run;
  const live = row.live;
  if ((live && live.state === "working") || (run && (BUSY_RUN.includes(run.state) || run.op != null))) return "working";
  if (run && run.state === "review_ready") return "review_ready";
  return "idle";
}

/**
 * 현황판 계산.
 * @param {object} input §5.1 Input
 * @returns {{ groups: Record<string, object[]>, offline: number[], counts: Record<string, number> }}
 *  행 = { k, kind:'run'|'agent'|'task', source:'task'|'snap'|'fallback', group, reason, host, cwd, win,
 *         agent, task, run, live, approvals:string[], unread, waitSince, sortAt, wsId, wsName }
 */
export function buildDashboard(input) {
  const inp = input || {};
  const now = num(inp.now, Date.now());
  const offline = new Set();
  for (const h of inp.hosts || []) if (h && h.online === false) offline.add(normHost(h.id));
  const isOff = (h) => h !== 0 && offline.has(h);

  const workspaces = (inp.workspaces || []).map((w) => ({ ...w, host: normHost(w.host) }));
  const wsFor = (host, cwd) =>
    workspaces.find((w) => w.localPath === cwd && w.host === host) || workspaces.find((w) => w.localPath === cwd && w.host === 0) || null;

  const rows = new Map(); // k → row
  const order = [];       // 삽입 순서(정렬 전 안정 기준)
  const put = (row) => { rows.set(row.k, row); order.push(row.k); };
  const offlineWithTasks = new Set();

  // 스냅 색인 — **정확한 k** 로만 모은다(같은 k 가 둘이면 뒤엣것). host 0 재시도는 run 행에 붙일 때만(§5.2 (2)).
  const snaps = new Map();
  for (const s of inp.agentSnaps || []) {
    if (!s || typeof s.cwd !== "string" || s.win == null) continue;
    snaps.set(rowKey(s.host, s.cwd, s.win), s);
  }
  const usedSnap = new Set();
  const liveOf = (s) => ({
    state: LIVE_STATES.includes(s.state) ? s.state : "idle",
    agent: s.agent || null, at: num(s.at), since: s.since == null ? null : num(s.since),
  });

  // (1) task run 행 — 모든 task(상태 무관)의 run 중 merged/discarded 가 아닌 것. 같은 k 의 스냅(없으면 host 0 스냅)을 live 로.
  for (const block of inp.tasks || []) {
    const host = normHost(block && block.host);
    const items = (block && block.items) || [];
    if (isOff(host)) { if (items.length) offlineWithTasks.add(host); continue; }
    for (const task of items) {
      for (const run of task.runs || []) {
        if (!run || HIDDEN_RUN.includes(run.state)) continue;
        const win = run.tid == null ? null : Number(run.tid);
        const k = rowKey(host, run.cwd, win);
        if (rows.has(k)) continue; // 같은 터미널을 두 run 이 주장하는 건 데몬 버그 — 먼저 온 것 하나만
        let sk = k;
        let snap = snaps.get(k);
        if (!snap && win != null && host !== 0) { sk = rowKey(0, run.cwd, win); snap = snaps.get(sk); }
        if (snap) usedSnap.add(sk);
        put({
          k, kind: "run", source: "task", host, cwd: run.cwd, win, agent: run.agent || null,
          task, run, live: snap ? liveOf(snap) : null, approvals: [], unread: 0,
          wsId: run.workspaceId || null, wsName: null,
        });
      }
    }
  }

  // (2) 에이전트 행 — run 에 붙지 않은 스냅마다 1행(키는 스냅 자신의 k).
  for (const [k, s] of snaps) {
    if (usedSnap.has(k) || rows.has(k)) continue;
    const host = normHost(s.host);
    if (isOff(host)) continue;
    const w = wsFor(host, s.cwd);
    const live = liveOf(s);
    put({
      k, kind: "agent", source: "snap", host, cwd: s.cwd, win: Number(s.win),
      agent: live.agent, task: null, run: null, live, approvals: [], unread: 0,
      wsId: w ? w.id : null, wsName: w ? w.name : null,
    });
  }

  // (3) 터미널 폴백 — on:true 이고 (1)(2) 에 같은 k(또는 host 0 k)가 없는 것만. 상태를 모르면 live 없음.
  for (const t of inp.terminalsFallback || []) {
    if (!t || !t.on || typeof t.cwd !== "string" || t.win == null) continue;
    const host = normHost(t.host);
    if (isOff(host)) continue;
    const k = rowKey(host, t.cwd, t.win);
    if (rows.has(k) || rows.has(rowKey(0, t.cwd, t.win))) continue;
    const w = wsFor(host, t.cwd);
    put({
      k, kind: "agent", source: "fallback", host, cwd: t.cwd, win: Number(t.win),
      agent: t.agent || null, task: null, run: null,
      live: LIVE_STATES.includes(t.state) ? { state: t.state, agent: t.agent || null, at: 0, since: null } : null,
      approvals: [], unread: 0, wsId: w ? w.id : null, wsName: w ? w.name : null,
    });
  }

  // 승인·미읽음은 k 로 붙인다 — 행의 k 와, 행이 host 를 알면 같은 (cwd,win) 의 host 0 항목까지.
  const indexByK = (list) => {
    const m = new Map();
    for (const x of list || []) {
      if (!x || typeof x.cwd !== "string" || x.win == null) continue;
      const k = rowKey(x.host, x.cwd, x.win);
      (m.get(k) || m.set(k, []).get(k)).push(x);
    }
    return m;
  };
  const apByK = indexByK(inp.approvals);
  const unByK = indexByK(inp.unread);
  const approvalAt = new Map(); // k → 가장 오래된 createdAt
  for (const k of order) {
    const r = rows.get(k);
    if (r.kind === "task") continue;
    const keys = [k];
    if (r.host !== 0) keys.push(rowKey(0, r.cwd, r.win));
    for (const kk of keys) {
      for (const a of apByK.get(kk) || []) {
        r.approvals.push(String(a.id));
        const c = num(a.createdAt);
        if (!approvalAt.has(k) || c < approvalAt.get(k)) approvalAt.set(k, c);
      }
      for (const u of unByK.get(kk) || []) r.unread += num(u.count);
    }
  }

  // (4) 종결 작업 — closedAt(없으면 updatedAt) 7일 이내면 done 행 1개.
  for (const block of inp.tasks || []) {
    const host = normHost(block && block.host);
    if (isOff(host)) continue;
    for (const task of (block && block.items) || []) {
      if (!task || !TERMINAL_TASK.includes(task.state)) continue;
      const at = num(task.closedAt, num(task.updatedAt));
      if (now - at > DONE_KEEP_MS) continue;
      put({
        k: `${host}|task:${task.id}`, kind: "task", source: "task", host, cwd: null, win: null,
        agent: null, task, run: null, live: null, approvals: [], unread: 0,
        wsId: task.workspaceId || null, wsName: null, sortAt: at,
      });
    }
  }

  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const k of order) {
    const r = rows.get(k);
    if (!r || r._placed) continue;
    r._placed = true;
    r.reason = r.kind === "task" ? null : needsInputReason(r);
    r.group = groupOf(r);
    if (r.kind !== "task") {
      r.sortAt = Math.max(r.run ? num(r.run.lastActivityAt, num(r.run.updatedAt)) : 0, r.live ? r.live.at : 0);
    }
    // 기다린 시각 — 승인 createdAt → live.since → run.updatedAt → live.at(스냅만 있는 행).
    const ap = approvalAt.get(r.k);
    r.waitSince = ap != null && ap !== Infinity ? ap
      : r.live && r.live.since != null ? r.live.since
      : r.run ? num(r.run.updatedAt)
      : r.live ? r.live.at : 0;
    groups[r.group].push(r);
  }
  for (const r of rows.values()) delete r._placed;
  const byK = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  groups.needs_input.sort((a, b) => a.waitSince - b.waitSince || byK(a, b));
  for (const g of ["working", "review_ready", "idle", "done"]) groups[g].sort((a, b) => b.sortAt - a.sortAt || byK(a, b));

  const counts = Object.fromEntries(GROUPS.map((g) => [g, groups[g].length]));
  return { groups, offline: [...offlineWithTasks].sort((a, b) => a - b), counts };
}

/**
 * 픽스처 대조용 요약(model-*.json 의 expect 모양) — 앱도 같은 모양을 만든다.
 *  groups: 그룹별 k 순서 · reasons: 입력 대기 행의 사유 · unread: 미읽음이 붙은 행(k → 수) · offline: 오프라인 host.
 */
export function summarize(result) {
  const groups = {};
  const reasons = {};
  const unread = {};
  for (const g of GROUPS) {
    groups[g] = result.groups[g].map((r) => r.k);
    for (const r of result.groups[g]) {
      if (g === "needs_input") reasons[r.k] = r.reason;
      if (r.unread) unread[r.k] = r.unread;
    }
  }
  return { groups, reasons, unread, offline: result.offline };
}

/**
 * review_ready 카드의 주 행동 결정표(§6.7 B).
 * @param {{ task:object, run:object, gh:{ghInstalled:boolean, ghAuthed:boolean}|null }} o
 * @returns {{ primary:'mergeLocal'|'ghLogin'|'createPr'|'mergePr'|'none', hint:'ghMissing'|'prClosed'|null,
 *             mergeDisabled:boolean, secondary:string[] }}
 *  secondary 원소: 'mergeLocal' | 'commit' | 'push' | 'discard' | 'openPr'
 */
export function primaryAction(o) {
  const task = (o && o.task) || {};
  const run = (o && o.run) || {};
  const gh = (o && o.gh) || {};
  const github = task.repo && task.repo.github ? task.repo.github : null;
  if (!github) return { primary: "mergeLocal", hint: null, mergeDisabled: false, secondary: ["commit", "discard"] };
  if (!gh.ghInstalled) return { primary: "mergeLocal", hint: "ghMissing", mergeDisabled: false, secondary: ["commit", "push", "discard"] };
  if (!gh.ghAuthed) return { primary: "ghLogin", hint: null, mergeDisabled: false, secondary: ["mergeLocal", "commit", "push", "discard"] };
  const pr = run.pr || null;
  if (!pr) return { primary: "createPr", hint: null, mergeDisabled: false, secondary: ["mergeLocal", "commit", "push", "discard"] };
  if (pr.state === "merged") return { primary: "none", hint: null, mergeDisabled: false, secondary: [] };
  if (pr.state === "closed") return { primary: "createPr", hint: "prClosed", mergeDisabled: false, secondary: ["mergeLocal", "discard"] };
  return { primary: "mergePr", hint: null, mergeDisabled: pr.mergeable !== "MERGEABLE", secondary: ["openPr", "push", "discard"] };
}

/** 변이 버튼 잠금(§6.0) — 라이브 working 이거나 op 진행 중이면 커밋·푸시·PR·머지·폐기 비활성. */
export function runLocked(row) {
  return !!((row && row.live && row.live.state === "working") || (row && row.run && row.run.op != null));
}
