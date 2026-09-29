// task-detail.js — 작업 상세(설계 §6.2). 현황판 오른쪽(≥1100px) 또는 목록 대신(좁을 때) 그린다.
//
// 구성: 머리(제목·상태·base·저장소) → 프롬프트(접힘) → run 컬럼(최대 3 나란히, 넘치면 가로 스크롤) →
//  선택 run 의 PR/gh 블록 + 행동 바(결정표 §6.7 B) → diff 리뷰(review-view, source:'task').
//
// 변이는 전부 비동기 op(§2.12): `{accepted, opId}` 즉시 회신 → `run.op`/`lastOp` 로 마감. 시트는 accepted 뒤
//  "진행 중…" 을 그리고 waitOp 가 lastOp 를 가져오면 코드별 문구로 닫거나 남는다. RPC 자체가 실패하면
//  "확인 중…" 을 그리고 task.get 1회로 실제 결과를 그린다(호스트가 이미 끝냈을 수 있다 — §3.2).
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons, agentMarkHtml } from "./icons.js";
import { primaryAction, runLocked } from "./tasks-model.js";
import { taskRpc, newOpId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import { serializeReviewComments } from "./diff-parse.js";
import * as D from "./diff-parse.js";
import { createReview, renderReviewFile, renderReviewBar } from "./review-view.js";
import * as V from "./tasks-view.js";
import * as i18n from "./i18n/index.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 상세 캐시 ────────────────────────────────────────────────────────────────
//  key = `${host}|${taskId}` → { task(전문·prompt 포함), at, loading }
const full = new Map();
//  key = runId → { data:TaskDiff, rv:리뷰상태, loading, error, at }
const diffs = new Map();
//  key = runId → { busy:{kind, opId, phase:'progress'|'checking'|'error'|'conflict'|'done', code, files, stderrTail} }
const ops = new Map();
let prTimer = null;
let prFor = null; // 지금 PR 폴링 중인 `${host}|${taskId}|${runId}`

const keyOf = (host, taskId) => `${host}|${taskId}`;

async function loadFull(host, taskId) {
  const k = keyOf(host, taskId);
  const cur = full.get(k);
  if (cur && cur.loading) return;
  full.set(k, { ...(cur || {}), loading: true });
  // PR 폴링(30초)마다 tasks.changed → 여기로 온다. 보이는 내용이 그대로면(updatedAt·pr.at 만 바뀜) 상세를 다시
  //  그리지 않는다 — 다시 그리면 리뷰 스크롤·열린 입력칸이 날아간다.
  const same = (a, b) => JSON.stringify(a, (kk, x) => (kk === "updatedAt" || kk === "at" || kk === "lastActivityAt" ? undefined : x))
    === JSON.stringify(b, (kk, x) => (kk === "updatedAt" || kk === "at" || kk === "lastActivityAt" ? undefined : x));
  let changed = true;
  try {
    const r = await taskRpc("task.get", { taskId }, host);
    changed = !(cur && cur.task && !cur.error && same(cur.task, r && r.task));
    full.set(k, { task: r && r.task, at: Date.now(), loading: false });
  } catch (e) {
    full.set(k, { ...(cur || {}), loading: false, error: e && e.code });
  }
  if (changed) V.invalidate();
}

/** tasks.changed(그 작업) — 전문을 다시 받는다. reason 'diff' 면 리뷰 중이 아닌 run 의 diff 캐시를 버린다. */
export function onTaskChanged(host, taskId, reason) {
  void loadFull(host, taskId);
  if (reason === "diff" || reason === "op") {
    for (const [runId, d] of diffs) {
      // 사용자가 코멘트·판정을 달고 있는 리뷰는 갈아엎지 않는다([변경 확인] 으로 명시 갱신).
      if (d.rv && (d.rv.comments.length || Object.keys(d.rv.decisions).length)) continue;
      diffs.delete(runId);
    }
  }
}

async function loadDiff(host, task, run, { force = false } = {}) {
  const cur = diffs.get(run.id);
  if (cur && cur.loading) return;
  if (cur && cur.data && !force) return;
  diffs.set(run.id, { ...(cur || {}), loading: true, error: null });
  V.invalidate();
  try {
    const data = await taskRpc("task.diff", { taskId: task.id, runId: run.id }, host);
    const files = (data.files || []).map((f) => ({ path: f.path, diffText: f.diffText || "", truncated: !!f.truncated, omitted: !!f.omitted, binary: !!f.binary }));
    const rv = createReview({ reviewId: "task:" + run.id, title: task.title, files, source: "task" }, null);
    rv.files.forEach((f, i) => { f.omitted = files[i].omitted; f.binary = files[i].binary; });
    diffs.set(run.id, { data, rv, loading: false, error: null, at: Date.now() });
  } catch (e) {
    diffs.set(run.id, { loading: false, error: (e && e.code) || "", data: null, rv: null });
  }
  V.invalidate();
}

/** 전체 400KB 상한으로 생략된 파일(omitted)은 그 파일로 이동할 때 개별 조회한다(§2.9 4). */
async function ensureFileDiff(host, task, run, rv) {
  const f = rv.files[rv.index];
  if (!f || !f.omitted || f._loading) return;
  f._loading = true;
  try {
    const one = await taskRpc("task.diff", { taskId: task.id, runId: run.id, file: f.path }, host);
    const got = (one.files || []).find((x) => x.path === f.path);
    if (got) {
      f.diffText = got.diffText || "";
      f.hunkList = D.parseHunks(f.diffText);
      f.hunks = f.hunkList.length;
      f.truncated = !!got.truncated;
      f.omitted = false;
    }
  } catch (e) {
    V.toast(errText(e && e.code));
  } finally {
    f._loading = false;
    V.invalidate();
  }
}

// ── op 실행(§2.12) ───────────────────────────────────────────────────────────
/**
 * 변이 op 1건. ui = { onProgress?, onDone?(lastOp), onFail?(code) } — 시트가 자기 상태 줄을 그린다.
 *  시트 없이 부르면(푸시) 상세의 op 줄이 그린다.
 */
async function runOp(host, task, run, method, params, ui = {}) {
  const opId = newOpId();
  const set = (busy) => { ops.set(run.id, { busy }); V.invalidate(); };
  set({ kind: method, opId, phase: "progress" });
  ui.onProgress?.();
  let accepted = null;
  try {
    accepted = await taskRpc(method, { ...params, opId, taskId: task.id, runId: run.id }, host);
  } catch (e) {
    // 전송 실패 = 결과 불명. "확인 중…" → task.get 한 번으로 실제 상태를 본다(같은 opId 재전송은 안전하지만 자동으로 하지 않는다).
    set({ kind: method, opId, phase: "checking" });
    ui.onProgress?.("checking");
    const code = (e && e.code) || "";
    if (code !== "TIMEOUT" && code !== "" && code !== "E2EE_RELAY_FAILED") {
      // 도메인 거절(RUN_BUSY·AGENT_BUSY 등) — 호스트가 실행하지 않았다.
      set({ kind: method, opId, phase: "error", code });
      ui.onFail?.(code);
      void V.refreshHost(host);
      return null;
    }
  }
  if (accepted && accepted.replay && accepted.lastOp) return finish(host, task, run, method, opId, accepted.lastOp, ui);
  const done = await V.waitOp(host, task.id, run.id, opId);
  if (!done) {
    // 6분을 기다려도 마감을 못 봤다 — 시트를 "확인 중…" 에 영영 묶어 두지 않는다(다시 시도 가능하게 연다).
    //  상세 줄은 "확인 중…" + [확인] 으로 남고, 뒤늦게 task.list 가 마감된 lastOp 를 보여 주면 reconcileOps 가 정리한다.
    set({ kind: method, opId, phase: "checking", timedOut: true });
    ui.onFail?.("TIMEOUT");
    return null;
  }
  return finish(host, task, run, method, opId, done.lastOp, ui);
}

function finish(host, task, run, method, opId, lastOp, ui) {
  void V.refreshHost(host);
  void loadFull(host, task.id);
  const res = lastOp && lastOp.result;
  // 충돌은 MergeResult{ok:false, code:'MERGE_CONFLICT', files} — lastOp.ok 는 데몬에 따라 true/false 둘 다 올 수 있다
  //  (rpc-merge-result.json 'conflict' 는 ok:false). 판정은 결과 code 로만 한다(파일 목록을 잃지 않게).
  if (lastOp && ((res && res.code === "MERGE_CONFLICT") || lastOp.code === "MERGE_CONFLICT")) {
    ops.set(run.id, { busy: { kind: method, opId, phase: "conflict", code: "MERGE_CONFLICT", files: res.files || [] } });
    ui.onFail?.("MERGE_CONFLICT", lastOp);
  } else if (lastOp && lastOp.ok === false) {
    ops.set(run.id, { busy: { kind: method, opId, phase: "error", code: lastOp.code, stderrTail: res && res.stderrTail } });
    ui.onFail?.(lastOp.code, lastOp);
  } else {
    ops.delete(run.id);
    diffs.delete(run.id); // 커밋·머지 뒤 diff 는 달라진다
    ui.onDone?.(lastOp);
  }
  V.invalidate();
  return lastOp;
}

// ── 렌더 ──────────────────────────────────────────────────────────────────────
export function renderTaskDetail(host, sel) {
  host.innerHTML = "";
  host.className = "tv-detail td";
  if (!sel.taskId) { renderAgentDetail(host, sel); return; }
  const lite = V.findTask(sel.host, sel.taskId);
  const f = full.get(keyOf(sel.host, sel.taskId));
  if (!f || (!f.task && !f.loading && !f.error)) void loadFull(sel.host, sel.taskId);
  // 전문(prompt)은 task.get 에만 있다. run 상태는 task.list 가 더 자주 갱신되므로 lite 의 runs 를 우선한다.
  const task = lite ? { ...(f && f.task ? f.task : {}), ...lite } : (f && f.task) || null;
  if (!task) {
    host.innerHTML = `<div class="tv-detail-empty">${esc(f && f.error ? errText(f.error) : tt("checking"))}</div>`;
    return;
  }
  const prompt = f && f.task ? f.task.prompt : null;
  reconcileOps(task);
  const runs = task.runs || [];
  const run = runs.find((r) => r.id === sel.runId) || runs.find((r) => r.state !== "discarded") || runs[0] || null;

  // 머리
  const head = document.createElement("div");
  head.className = "td-head";
  const stKey = { open: "taskOpen", merged: "taskMerged", closed: "taskClosed", failed: "taskFailed" }[task.state] || "taskOpen";
  head.innerHTML = `<div class="td-title">${esc(task.title || tt("title"))}</div>`
    + `<div class="td-meta"><span class="td-chip">${esc(tt(stKey))}</span>`
    + `<span>${esc(tt("base"))} ${esc(task.base)}</span><span>${esc(task.repo && task.repo.name)}</span></div>`;
  if (task.state === "failed" && task.error) {
    const e = document.createElement("div");
    e.className = "td-err";
    e.textContent = errText(task.error.code);
    head.append(e);
  }
  host.append(head);

  // 프롬프트(접힘)
  const pd = document.createElement("details");
  pd.className = "td-prompt";
  pd.innerHTML = `<summary>${esc(tt("prompt"))}</summary><pre>${esc(prompt == null ? tt("checking") : prompt)}</pre>`;
  host.append(pd);

  // run 컬럼
  const cols = document.createElement("div");
  cols.className = "td-runs";
  for (const r of runs) cols.append(runColumn(sel.host, task, r, run && r.id === run.id));
  host.append(cols);

  if (run) renderSelectedRun(host, sel.host, task, run);
  syncPrPolling(sel.host, task, run);
}

function renderAgentDetail(host, sel) {
  const r = V.dashboard();
  const row = Object.values(r.groups).flat().find((x) => x.k === sel.k);
  if (!row) { host.innerHTML = `<div class="tv-detail-empty">${esc(tt("detail"))}</div>`; return; }
  const st = V.statusOf(row);
  const box = document.createElement("div");
  box.className = "td-head";
  box.innerHTML = `<div class="td-title">${agentMarkHtml(row.agent, { size: 16 }) || ""} ${esc(V.agentName(row.agent))}</div>`
    + `<div class="td-meta"><span>${esc(row.wsName || row.cwd)}</span><span>${esc(st.line)}</span></div>`;
  host.append(box);
  const acts = document.createElement("div");
  acts.className = "td-actions";
  acts.append(button("tv-btn", tt("openTerminal"), () => V.openRunTerminal(row.wsId, row.win)));
  host.append(acts);
}

function runColumn(host, task, r, selected) {
  const c = document.createElement("div");
  c.className = "td-run" + (selected ? " selected" : "") + (r.state === "discarded" ? " dim" : "");
  const winner = task.winnerRunId === r.id;
  const line = r.state === "review_ready" ? V.reviewLine(r) : tt(V.runStateKey(r.state));
  c.innerHTML =
    `<div class="td-run-head">${agentMarkHtml(r.agent, { size: 14 }) || icons.terminal({ size: 14 })}`
    + `<span>${esc(tt("runN", { n: r.idx }))} · ${esc(V.agentName(r.agent))}</span>`
    + (winner ? `<span class="td-chip">${esc(tt("winner"))}</span>` : "") + `</div>`
    + `<div class="td-run-line">${esc(line)}</div>`
    + (r.state === "failed" && r.error ? `<div class="td-run-line err">${esc(errText(r.error.code))}</div>` : "")
    + (r.state !== "review_ready" && r.diff
      ? `<div class="td-run-line">${esc(tt("filesSummary", { n: r.diff.files }))} · ${esc(tt("diffStat", { a: r.diff.additions, d: r.diff.deletions }))}`
        + (r.commits ? ` · ${esc(tt("commitsAhead", { n: r.commits.ahead }))}` : "") + `</div>` : "")
    + (r.state !== "review_ready" ? `<div class="td-run-line">${esc(V.prLine(r.pr))}</div>` : "")
    + `<div class="td-run-branch">${esc(r.branch)}</div>`;
  const acts = document.createElement("div");
  acts.className = "tvc-acts";
  if (r.state !== "discarded" && r.state !== "merged") {
    acts.append(button("tv-btn ghost", tt("review"), () => { V.setSelection({ runId: r.id }); void loadDiff(host, task, r); }));
    acts.append(button("tv-btn ghost", tt("openTerminal"), () => V.openRunTerminal(r.workspaceId, r.tid, { task: true }), {
      disabled: !r.workspaceId, title: r.workspaceId ? "" : tt("wsNotRegistered"),
    }));
  }
  if (r.state === "failed") {
    acts.append(button("tv-btn ghost", tt("reopen"), () => V.reopenRun(host, task.id, r.id)));
  }
  c.append(acts);
  c.addEventListener("click", () => { if (!selected) V.setSelection({ runId: r.id }); });
  return c;
}

function liveOf(host, run) {
  const snaps = S.listAgentSnaps();
  return snaps.find((s) => s.cwd === run.cwd && s.win === run.tid && (s.host === host || s.host === 0)) || null;
}

function renderSelectedRun(host, hostId, task, run) {
  const wrap = document.createElement("div");
  wrap.className = "td-sel";
  const live = liveOf(hostId, run);
  const locked = runLocked({ live, run });
  // gh 상태를 모르면(task.list 실패·아직 조회 전) "gh 가 없어요" 라고 단정하지 않는다 — 안내를 숨기고
  //  행동은 낙관적으로 그린다(실제 실패는 op 가 GH_MISSING/GH_NOT_AUTHED 로 알려 준다).
  const ghKnown = V.ghLiteOf(hostId);
  const gh = ghKnown || { ghInstalled: true, ghAuthed: true };
  const pa = primaryAction({ task, run, gh });
  const closed = run.state === "discarded" || run.state === "merged";

  // ── gh 안내 / PR 블록 ──
  const prBox = document.createElement("div");
  prBox.className = "td-pr";
  if (!ghKnown) {
    // 모름 — 안내 없음
  } else if (task.repo && task.repo.github && !gh.ghInstalled) {
    prBox.append(hint(tt("ghMissing"), tt("ghMissingHint")));
  } else if (task.repo && task.repo.github && !gh.ghAuthed) {
    const h = hint(tt("ghNotAuthed"), tt("ghNotAuthedHint"));
    h.append(button("tv-btn ghost", tt("checkAgain"), async () => {
      await V.act(hostId, "git.gh.status", { refresh: true });
      await V.refreshHost(hostId); // 새 gh 상태(task.list caps.gh)를 받아 상세를 다시 그린다
      V.invalidate();
    }));
    prBox.append(h);
  } else if (!task.repo || !task.repo.github) {
    prBox.append(hint(tt("notGithub"), null));
  }
  if (run.pr) prBox.append(prBlock(run.pr));
  if (prBox.childElementCount) wrap.append(prBox);

  // ── op 상태 줄 ──
  const st = ops.get(run.id);
  if (st && st.busy) wrap.append(opLine(hostId, task, run, st.busy));

  // ── 행동 바(§6.2 · 결정표 §6.7 B) ──
  //  git 행동(커밋·PR·머지)은 worktree 가 살아 있는 run(running/review_ready/merging)에만. 실패 run 은 §5.4 의
  //  [다시 열기][프롬프트 다시 보내기][폐기], 준비 중(creating/launching)은 아직 할 것이 없다.
  if (run.state === "failed") {
    const bar = document.createElement("div");
    bar.className = "td-actions";
    bar.append(
      button("tv-btn", tt("reopen"), () => V.reopenRun(hostId, task.id, run.id)),
      button("tv-btn ghost", tt("resendPrompt"), () => V.resendPrompt(hostId, task.id, run.id)),
      button("tv-btn ghost danger", tt("discard"), () => V.discardFlow(hostId, task, run)),
    );
    wrap.append(bar);
    host.append(wrap);
    return;
  }
  if (run.state === "creating" || run.state === "launching") { host.append(wrap); return; }
  if (!closed) {
    const bar = document.createElement("div");
    bar.className = "td-actions";
    const busyTitle = locked ? tt("agentBusy") : "";
    const mk = (key, fn, primary) => button(primary ? "tv-btn" : "tv-btn ghost", tt(key), fn, { disabled: locked, title: busyTitle });
    const want = new Set([pa.primary, ...pa.secondary]);
    // 주 행동 1개를 맨 앞에 굵게.
    if (pa.primary === "createPr") bar.append(mk("createPr", () => openPrSheet(hostId, task, run), true));
    if (pa.primary === "mergePr") {
      const b = mk("mergePr", () => openMergeSheet(hostId, task, run, "pr"), true);
      if (pa.mergeDisabled) { b.disabled = true; b.title = run.pr && run.pr.mergeable === "CONFLICTING" ? tt("prConflicting") : tt("errNotMergeable"); }
      bar.append(b);
    }
    if (pa.primary === "mergeLocal") bar.append(mk("mergeLocal", () => openMergeSheet(hostId, task, run, "local"), true));
    if (pa.primary === "ghLogin") {
      bar.append(button("tv-btn", tt("checkAgain"), async () => {
        await V.act(hostId, "git.gh.status", { refresh: true });
        await V.refreshHost(hostId);
        V.invalidate();
      }));
    }
    if (want.has("openPr") && run.pr) bar.append(button("tv-btn ghost", tt("openPr"), () => api.openExternal(run.pr.url).catch(() => {})));
    if (want.has("commit")) bar.append(mk("commit", () => openCommitSheet(hostId, task, run)));
    if (want.has("push")) bar.append(mk("push", () => runOp(hostId, task, run, "git.push", {})));
    if (want.has("mergeLocal") && pa.primary !== "mergeLocal") bar.append(mk("mergeLocal", () => openMergeSheet(hostId, task, run, "local")));
    if (pa.hint === "prClosed") {
      const n = document.createElement("span");
      n.className = "td-note";
      n.textContent = tt("prClosed");
      bar.append(n);
    }
    bar.append(button("tv-btn ghost", tt("checkChanges"), () => loadDiff(hostId, task, run, { force: true })));
    if (want.has("discard")) bar.append(button("tv-btn ghost danger", tt("discard"), () => V.discardFlow(hostId, task, run), { disabled: locked, title: busyTitle }));
    wrap.append(bar);
  } else if (run.state === "discarded" && run.cleanup && run.cleanup.recoveryRef) {
    const n = document.createElement("div");
    n.className = "td-note mono";
    n.textContent = run.cleanup.recoveryRef;
    wrap.append(n);
  }

  // ── diff 리뷰 ──
  if (!closed) wrap.append(reviewArea(hostId, task, run));
  host.append(wrap);
}

function hint(title, sub) {
  const h = document.createElement("div");
  h.className = "td-hint";
  h.innerHTML = `<div class="td-hint-title">${esc(title)}</div>` + (sub ? `<div class="td-hint-sub mono">${esc(sub)}</div>` : "");
  return h;
}

function prBlock(pr) {
  const b = document.createElement("div");
  b.className = "td-prblock";
  const head = document.createElement("div");
  head.className = "td-prhead";
  const link = document.createElement("button");
  link.className = "td-link";
  link.textContent = tt("prNumber", { n: pr.number });
  link.addEventListener("click", () => api.openExternal(pr.url).catch(() => {}));
  head.append(link);
  const bits = [];
  if (pr.state === "closed") bits.push(tt("prClosed"));
  if (pr.isDraft) bits.push(tt("prDraft"));
  if (pr.state === "open") bits.push(pr.mergeable === "MERGEABLE" ? tt("prMergeable") : pr.mergeable === "CONFLICTING" ? tt("prConflicting") : "");
  const c = pr.checks || { status: "none" };
  bits.push(tt({ none: "checksNone", pending: "checksPending", passing: "checksPassing", failing: "checksFailing" }[c.status] || "checksNone"));
  const meta = document.createElement("span");
  meta.className = "td-sub";
  meta.textContent = bits.filter(Boolean).join(" · ");
  head.append(meta);
  b.append(head);
  const items = (c.items || []).slice(0, 20);
  if (items.length) {
    const ul = document.createElement("div");
    ul.className = "td-checks";
    for (const it of items) {
      const dot = { failing: "error", passing: "cta", pending: "spin", skipped: "" }[it.status] || "";
      const lbl = { pending: "checkItemPending", passing: "checkItemPassing", failing: "checkItemFailing", skipped: "checkItemSkipped" }[it.status] || "checkItemPending";
      const row = document.createElement("div");
      row.className = "td-check";
      row.innerHTML = `<span class="tv-dot ${dot}"></span><span class="td-check-nm">${esc(it.name)}</span><span class="td-sub">${esc(tt(lbl))}</span>`;
      if (it.url) row.addEventListener("click", () => api.openExternal(it.url).catch(() => {}));
      ul.append(row);
    }
    b.append(ul);
  }
  return b;
}

function opLine(hostId, task, run, busy) {
  const d = document.createElement("div");
  d.className = "td-op" + (busy.phase === "error" || busy.phase === "conflict" ? " err" : "");
  if (busy.phase === "progress") d.textContent = tt("opInProgress");
  else if (busy.phase === "checking") d.textContent = tt("checking");
  else if (busy.phase === "conflict") {
    d.innerHTML = `<div>${esc(tt("errConflict"))}</div><div class="td-sub">${esc(tt("conflictHint"))}</div>`
      + `<div class="td-files mono">${(busy.files || []).map((f) => esc(f)).join("<br>")}</div>`;
    d.append(button("tv-btn ghost", tt("openTerminal"), () => V.openRunTerminal(run.workspaceId, run.tid, { task: true })));
  } else {
    d.innerHTML = `<div>${esc(errText(busy.code, { base: task.base }))}</div>`;
    if (busy.stderrTail) {
      const det = document.createElement("details");
      det.innerHTML = `<summary>stderr</summary><pre class="mono">${esc(busy.stderrTail)}</pre>`;
      d.append(det);
    }
    if (busy.code === "COMMIT_HOOK_FAILED") {
      d.append(button("tv-btn ghost", tt("retryCommitNoVerify"), () => openCommitSheet(hostId, task, run, { noVerify: true })));
    }
  }
  if (busy.phase === "error" || busy.phase === "conflict" || (busy.phase === "checking" && busy.timedOut)) {
    d.append(button("tv-btn ghost", tt("confirm"), () => { ops.delete(run.id); V.invalidate(); }));
  }
  return d;
}

/**
 * 뒤늦은 마감 반영 — waitOp 가 포기한("확인 중…") op 를 task.list 의 run 이 마감된 모습으로 보여 주면 정리한다.
 *  (run.op 이 그 opId 가 아니고 lastOp.opId 가 같으면 호스트가 끝낸 것) 상세 렌더마다 부른다.
 */
function reconcileOps(task) {
  for (const r of task.runs || []) {
    const st = ops.get(r.id);
    if (!st || !st.busy || st.busy.phase !== "checking") continue;
    const id = st.busy.opId;
    if (r.op && r.op.opId === id) continue;
    if (r.lastOp && r.lastOp.opId === id) {
      if (r.lastOp.ok === false) ops.set(r.id, { busy: { ...st.busy, phase: "error", code: r.lastOp.code, timedOut: false } });
      else ops.delete(r.id);
    }
  }
}

function reviewArea(hostId, task, run) {
  const area = document.createElement("div");
  area.className = "td-review";
  const d = diffs.get(run.id);
  if (!d) {
    area.append(button("tv-btn ghost", tt("review"), () => loadDiff(hostId, task, run)));
    return area;
  }
  if (d.loading) { area.innerHTML = `<div class="td-sub">${esc(tt("checking"))}</div>`; return area; }
  if (d.error != null && !d.rv) {
    area.innerHTML = `<div class="td-op err">${esc(errText(d.error))}</div>`;
    return area;
  }
  const rv = d.rv;
  if (!rv.files.length) { area.innerHTML = `<div class="td-sub">${esc(tt("errNothingToCommit"))}</div>`; return area; }
  const fileHost = document.createElement("div");
  const bar = document.createElement("div");
  const text = () => serializeReviewComments({ comments: rv.comments, decisions: rv.decisions, note: rv.note }, { title: task.title });
  const redraw = () => {
    renderReviewFile(fileHost, rv, () => renderReviewBar(bar, rv, cbs));
    renderReviewBar(bar, rv, cbs);
    const f = rv.files[rv.index];
    if (f && f.omitted) void ensureFileDiff(hostId, task, run, rv);
  };
  const cbs = {
    onNav: (dl) => { rv.index = Math.max(0, Math.min(rv.files.length - 1, rv.index + dl)); redraw(); },
    onApproveFile: () => { const f = rv.files[rv.index]; for (let i = 0; i < f.hunks; i++) rv.decisions[`${f.path}#${i}`] = "approve"; redraw(); },
    onApproveAll: () => { for (const f of rv.files) for (let i = 0; i < f.hunks; i++) rv.decisions[`${f.path}#${i}`] = "approve"; redraw(); },
    commentText: text,
    onSendComments: async () => {
      const t = text();
      if (!t) return;
      rv.sending = true; rv.error = null; redraw();
      try {
        const body = { cwd: run.cwd, tid: run.tid, text: t, submit: true };
        if (hostId != null) body.hostDeviceId = hostId;
        await api.chatInput(body);
        rv.comments = []; rv.decisions = {}; rv.note = "";
        V.toast(tt("sendComments"));
      } catch (e) {
        rv.error = String((e && e.message) || e);
      } finally {
        rv.sending = false;
        redraw();
      }
    },
  };
  redraw();
  area.append(fileHost, bar);
  if (d.data && d.data.truncatedTotal) {
    const n = document.createElement("div");
    n.className = "td-sub";
    n.textContent = i18n.t("변경이 너무 커서 앞부분만 보여요");
    area.append(n);
  }
  return area;
}

// ── PR 상태 폴링(상세 열림 중 30초, §6.2) ──────────────────────────────────────────
function syncPrPolling(host, task, run) {
  const want = run && task.repo && task.repo.github && run.state !== "discarded" && run.state !== "merged"
    && (run.pr || run.pushed) ? `${host}|${task.id}|${run.id}` : null;
  if (want === prFor) return;
  clearInterval(prTimer);
  prTimer = null;
  prFor = want;
  if (!want) return;
  const tick = async () => {
    if (state.view !== "tasks" || prFor !== want) { clearInterval(prTimer); prTimer = null; prFor = null; return; }
    try {
      await taskRpc("git.pr.status", { taskId: task.id, runId: run.id }, host);
      void V.refreshHost(host);
    } catch (_) { /* gh 안내는 task.list caps 가 그린다 */ }
  };
  void tick();
  prTimer = setInterval(tick, 30000);
}

// ── 시트(커밋·PR·머지) — .wv-sheet-overlay 패턴 ─────────────────────────────────
function sheet(title) {
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet";
  const h = document.createElement("div");
  h.className = "wv-sheet-title";
  h.textContent = title;
  const form = document.createElement("div");
  form.className = "tk-form";
  const status = document.createElement("div");
  status.className = "tk-status";
  const foot = document.createElement("div");
  foot.className = "tk-foot";
  box.append(h, form, status, foot);
  overlay.append(box);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onEsc, true); };
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  return { form, status, foot, close };
}
function field(label, input) {
  const w = document.createElement("label");
  w.className = "tk-field";
  const l = document.createElement("span");
  l.className = "tk-label";
  l.textContent = label;
  w.append(l, input);
  return w;
}
function textInput(v, { multiline = false } = {}) {
  const i = document.createElement(multiline ? "textarea" : "input");
  i.className = "tk-input";
  i.value = v || "";
  if (multiline) i.rows = 5;
  return i;
}
function check(label, on) {
  const w = document.createElement("label");
  w.className = "tk-check";
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = !!on;
  w.append(c, document.createTextNode(" " + label));
  return { el: w, input: c };
}
function select(options, value) {
  const s = document.createElement("select");
  s.className = "tk-input";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.append(o);
  }
  return s;
}
/** 시트 제출 → op. 성공이면 닫고, 실패면 코드별 문구를 시트 안에 남긴다(§6.2). */
function submitOp(sh, submitBtn, hostId, task, run, method, params, { onHookFail } = {}) {
  submitBtn.disabled = true;
  void runOp(hostId, task, run, method, params, {
    onProgress: (p) => { sh.status.className = "tk-status"; sh.status.textContent = p === "checking" ? tt("checking") : tt("opInProgress"); },
    onDone: () => sh.close(),
    onFail: (code, lastOp) => {
      submitBtn.disabled = false;
      sh.status.className = "tk-status err";
      sh.status.textContent = errText(code, { base: task.base });
      const tail = lastOp && lastOp.result && lastOp.result.stderrTail;
      if (tail) {
        const det = document.createElement("details");
        det.innerHTML = `<summary>stderr</summary><pre class="mono">${esc(tail)}</pre>`;
        sh.status.append(det);
      }
      if (code === "COMMIT_HOOK_FAILED" && onHookFail) sh.status.append(button("tv-btn ghost", tt("retryCommitNoVerify"), onHookFail));
      if (code === "MERGE_CONFLICT") {
        const files = (lastOp && lastOp.result && lastOp.result.files) || [];
        const f = document.createElement("div");
        f.className = "td-files mono";
        f.innerHTML = files.map(esc).join("<br>") + `<div class="td-sub">${esc(tt("conflictHint"))}</div>`;
        sh.status.append(f);
      }
    },
  });
}

function openCommitSheet(hostId, task, run, { noVerify = false } = {}) {
  const sh = sheet(tt("commit"));
  const msg = textInput(task.title || "", { multiline: true });
  const nv = check(tt("skipHooks"), noVerify);
  sh.form.append(field(tt("commitMessage"), msg), nv.el);
  const ok = button("tv-btn", tt("commit"), () => {
    if (!msg.value.trim()) return;
    submitOp(sh, ok, hostId, task, run, "git.commit", { message: msg.value.trim(), noVerify: nv.input.checked }, {
      onHookFail: () => { nv.input.checked = true; ok.click(); },
    });
  });
  sh.foot.append(button("tv-btn ghost", tt("cancel"), sh.close), ok);
  msg.focus();
}

function defaultPrBody(task, prompt) {
  const p = String(prompt || "").trim();
  const summary = p.length > 600 ? p.slice(0, 600) + "…" : p;
  return (summary ? summary + "\n\n" : "") + `Task ${task.id}`;
}

function openPrSheet(hostId, task, run) {
  const sh = sheet(tt("createPr"));
  const f = full.get(keyOf(hostId, task.id));
  const needCommit = !!run.dirty;
  const cm = needCommit ? textInput(task.title || "") : null;
  const title = textInput(task.title || "");
  const body = textInput(defaultPrBody(task, f && f.task && f.task.prompt), { multiline: true });
  const draft = check(tt("draftPr"), false);
  if (cm) sh.form.append(field(tt("commitMessage"), cm));
  sh.form.append(field(tt("prTitle"), title), field(tt("prBody"), body), draft.el);
  const ok = button("tv-btn", tt("createPr"), () => {
    if (!title.value.trim() || (cm && !cm.value.trim())) return;
    submitOp(sh, ok, hostId, task, run, "git.pr.create", {
      title: title.value.trim(), body: body.value, draft: draft.input.checked, push: true,
      ...(cm ? { commitMessage: cm.value.trim() } : {}),
    });
  });
  sh.foot.append(button("tv-btn ghost", tt("cancel"), sh.close), ok);
  (cm || title).focus();
}

function openMergeSheet(hostId, task, run, kind) {
  const pr = kind === "pr";
  const sh = sheet(pr ? tt("mergePr") : tt("mergeLocal"));
  const methods = pr
    ? [["squash", tt("methodSquash")], ["merge", tt("methodMerge")], ["rebase", tt("methodRebase")]]
    : [["merge", tt("methodMerge")], ["squash", tt("methodSquash")], ["ff", tt("methodFf")]];
  const m = select(methods, pr ? "squash" : "merge");
  const others = check(tt("discardOthers"), true);
  sh.form.append(field(tt("mergeMethod"), m));
  if ((task.runs || []).filter((r) => r.id !== run.id && r.state !== "discarded").length) sh.form.append(others.el);
  if (pr && run.pr && run.pr.checks && run.pr.checks.status === "failing") {
    const w = document.createElement("div");
    w.className = "tk-status err";
    w.textContent = tt("errChecksFailing");
    sh.form.append(w);
  }
  const ok = button("tv-btn", pr ? tt("mergePr") : tt("mergeLocal"), () => {
    submitOp(sh, ok, hostId, task, run, pr ? "git.pr.merge" : "git.merge.local", {
      method: m.value, discardOthers: others.input.checked,
    });
  });
  sh.foot.append(button("tv-btn ghost", tt("cancel"), sh.close), ok);
}

function button(cls, label, onClick, { disabled = false, title = "" } = {}) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.disabled = !!disabled;
  if (title) b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick?.(e); });
  return b;
}
