// sidebar-tasks.js — 사이드바 저장소 트리의 **순수 파생**(agent-tasks-sidebar.md §2). import 0개 — node 에서 그대로 돈다.
//
// 무엇을 하나: 고른 PC 의 워크스페이스 목록 + 그 PC 의 작업 버킷 + 현황판 모델 행(rows)으로
//  "워크스페이스 그룹 아래 어떤 작업 행을 어떤 순서·어떤 점·어떤 부제로 그리나" 를 정한다.
// 왜 순수 모듈인가: 앱(codingpt_app/src/workspace/tasks/sidebarTasks.ts)에 같은 함수가 있고, 폰과 PC 가
//  다른 트리를 그리면 "작업 vs 워크스페이스" 혼동이 더 커진다 → 픽스처(docs/fixtures/agent-tasks/sidebar-01.json)
//  하나로 양쪽을 대조한다(test/tasks-crossimpl.mjs).
//
// 규율(§2 정본 — 여기서 새 규칙을 만들지 않는다):
//  · 상태를 새로 판정하지 않는다. run 의 그룹/사유는 현황판 모델 행(rows, kind 'run')에서 run.id 로 찾아 쓴다.
//  · 대상 = task.state === 'open' + 살아 있는 run(merged/discarded 아님)이 1개 이상.
//  · 배정 = workspaceId 일치 → 경로(repo.path 또는 repo.path/subdir, 둘 다면 긴 쪽) → 없으면 어느 그룹에도 없음.
//  · 정렬 = 집계 그룹 순 → 최근 활동(run 행 sortAt 최대) 내림차순 → taskId 코드포인트 오름차순(localeCompare 금지).

const ORDER = ["needs_input", "working", "review_ready", "idle"];
const HIDDEN_RUN = ["merged", "discarded"];
const ERROR_REASONS = ["failed", "opFailed"];
const SUB_KEY = { needs_input: "groupNeedsInput", working: "groupWorking", review_ready: "groupReviewReady", idle: "groupIdle" };

function isTaskWs(w) {
  return !!w && typeof w.localPath === "string" && /^\.codingpt\/worktrees\//.test(w.localPath);
}
function num(v) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : 0;
}
function dotOf(group, reason) {
  if (group === "needs_input") return ERROR_REASONS.includes(reason) ? "error" : "warn";
  if (group === "working") return "spin";
  return "none";
}
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ host:number, workspaces:{id:string,localPath:string}[], tasks:object[], rows:object[] }} input
 * @returns {{ groups: Record<string, { wsId:string, openCount:number, needsInput:boolean, tasks:object[] }> }}
 */
export function buildSidebarTasks(input) {
  const inp = input || {};
  const host = num(inp.host);
  if (!host) return { groups: {} };

  const wss = (inp.workspaces || []).filter((w) => w && w.id != null && !isTaskWs(w));
  const groups = {};
  for (const w of wss) groups[w.id] = { wsId: w.id, openCount: 0, needsInput: false, tasks: [] };

  // run.id → 현황판 행(§2.4). kind 'run' 행만.
  const rowOf = new Map();
  for (const r of inp.rows || []) {
    if (r && r.kind === "run" && r.run && r.run.id != null && !rowOf.has(r.run.id)) rowOf.set(r.run.id, r);
  }

  const pickWs = (task) => {
    if (task.workspaceId != null && groups[task.workspaceId]) return task.workspaceId;
    const repo = task.repo || {};
    if (typeof repo.path !== "string" || !repo.path) return null;
    const cands = [repo.path];
    if (repo.subdir) cands.push(repo.path + "/" + repo.subdir);
    let best = null;
    for (const w of wss) {
      if (!cands.includes(w.localPath)) continue;
      if (!best || String(w.localPath).length > String(best.localPath).length) best = w;
    }
    return best ? best.id : null;
  };

  const placed = []; // { wsId, t, recent }
  for (const task of inp.tasks || []) {
    if (!task || task.state !== "open") continue;
    const live = (task.runs || []).filter((r) => r && !HIDDEN_RUN.includes(r.state));
    if (!live.length) continue;
    const wsId = pickWs(task);
    if (wsId == null) continue;

    const runs = live.slice().sort((a, b) => num(a.idx) - num(b.idx));
    let recent = 0;
    const info = runs.map((run) => {
      const row = rowOf.get(run.id);
      const group = row && ORDER.includes(row.group) ? row.group : "idle";
      if (row) recent = Math.max(recent, num(row.sortAt));
      return { run, group, dot: row ? dotOf(group, row.reason) : "none" };
    });
    const agg = ORDER.find((g) => info.some((x) => x.group === g)) || "idle";
    // 집계 점 = 그 집계 그룹에 속한 run 중 가장 강한 신호(error > warn) — 실패 사유가 있으면 error.
    let dot = dotOf(agg, null);
    if (agg === "needs_input" && info.some((x) => x.group === "needs_input" && x.dot === "error")) dot = "error";
    let key = SUB_KEY[agg];
    if (agg === "working" && runs.every((r) => r.state === "creating")) key = "stateCreating";
    let diff = null;
    if (agg === "review_ready") {
      const first = info.find((x) => x.group === "review_ready");
      const d = first && first.run.diff;
      if (d) diff = { a: num(d.additions), d: num(d.deletions) };
    }
    const t = {
      taskId: String(task.id), title: task.title || "",
      group: agg, dot, sub: { key, diff },
      fanout: runs.length,
      runs: runs.length >= 2 ? info.map((x) => ({
        runId: String(x.run.id), agent: x.run.agent || "", branch: x.run.branch || "",
        workspaceId: x.run.workspaceId || null, tid: x.run.tid == null ? null : Number(x.run.tid),
        group: x.group, dot: x.dot,
      })) : [],
    };
    placed.push({ wsId, t, recent });
  }

  placed.sort((a, b) =>
    ORDER.indexOf(a.t.group) - ORDER.indexOf(b.t.group) || b.recent - a.recent || byCode(a.t.taskId, b.t.taskId));
  for (const p of placed) {
    const g = groups[p.wsId];
    g.tasks.push(p.t);
    g.openCount++;
    if (p.t.group === "needs_input") g.needsInput = true;
  }
  return { groups };
}

/** 픽스처 대조용 요약(sidebar-01.json 의 expect 모양 — title·agent·branch 는 제외). 앱도 같은 모양을 만든다. */
export function summarizeSidebar(out) {
  const res = {};
  for (const [wsId, g] of Object.entries((out && out.groups) || {})) {
    res[wsId] = {
      openCount: g.openCount,
      needsInput: g.needsInput,
      tasks: g.tasks.map((t) => ({
        taskId: t.taskId, group: t.group, dot: t.dot, sub: { key: t.sub.key, diff: t.sub.diff },
        fanout: t.fanout, runs: t.runs.map((r) => ({ runId: r.runId, group: r.group, dot: r.dot })),
      })),
    };
  }
  return res;
}
