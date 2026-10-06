// orch-view.js — 오케스트레이션 사본 유지(호스트별 orch.list) + 묶음 상세 시트.
//
// 화면이 하는 일은 셋뿐이다: ① 데몬이 아는 묶음·워커 상태를 그대로 보여 준다 ② 사람이 답해야 하는 것(질문·결정)에
//  답한다 ③ 멈추기·정리·닫기. 워커를 띄우고 일을 나누는 것은 터미널 안의 코디네이터 에이전트가 한다.
//
// 갱신 경로: ui_command `orch.changed {host, runIds, reason}`(주 경로, 300ms 디바운스) + 30초 폴링(놓친 통지의 안전망,
//  진행 중 묶음이 있을 때만). 상태는 state.orch.byHost — **pull 로 채운다**(push 만으로는 한 번 놓치면 영영 빈칸).
import { state } from "./state.js";
import * as S from "./state.js";
import { icons, agentMarkHtml } from "./icons.js";
import { orchRpc, hostHasOrch } from "./orch-api.js";
import { isLocalHostId } from "./tasks-api.js";
import { ot, orchErrText } from "./text/orch.js";
import { visibleWorkers, workerDot, workerTextKey, runRollup, runTitle } from "./orch-model.js";
import { orchRolesSig } from "./orch-roles.js";
import * as T from "./tiling.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const POLL_MS = 30000;
const inflight = new Map();
const timers = new Map();
let pollTimer = null;
let open = null;   // 열린 시트 { host, runId, draw, close }

function toast(msg) { import("./workspace-view.js").then((m) => m.wvToast(msg)).catch(() => {}); }

/** 조회할 호스트 — 온라인 PC 중 orch.v1 이 **없다고 확인된** 것은 뺀다(모름은 시도한다). */
function queryHosts() {
  return S.pcDevices()
    .filter((d) => d.online !== false && typeof d.id === "number")
    .filter((d) => hostHasOrch(d.id) !== false)
    .map((d) => d.id);
}

export function refreshOrchHost(host) {
  const h = Number(host);
  if (!Number.isFinite(h) || h <= 0) return Promise.resolve();
  if (inflight.has(h)) return inflight.get(h);
  const p = (async () => {
    try {
      const r = await orchRpc("orch.list", {}, h);
      const before = orchRolesSig(h);
      S.setOrchForHost(h, { runs: (r && r.runs) || [], notes: (r && r.notes) || [], at: Date.now() });
      if (orchRolesSig(h) !== before) refreshTabHeads();
    } catch (_) {
      // 구 데몬·오프라인 — 마지막으로 본 것을 지우지 않는다(잠깐의 끊김에 행이 깜빡이지 않게). 구 데몬이면 처음부터 비어 있다.
    } finally {
      inflight.delete(h);
      if (open && Number(open.host) === h) open.draw();
    }
  })();
  inflight.set(h, p);
  return p;
}
/** 역할 표식이 바뀌었다 — 지금 보이는 워크스페이스의 터미널 탭 머리만 다시 그린다. */
function refreshTabHeads() {
  const rt = state.activeWsId ? S.wsRuntime(state.activeWsId) : null;
  if (!rt || !rt.layout) return;
  import("./pane.js").then((m) => {
    T.eachLeaf(rt.layout, (l) => { if (l.kind === "terminal") m.getPane(l.id)?.buildHead(); });
  }).catch(() => {});
}
export async function refreshOrchAll() {
  await Promise.allSettled(queryHosts().map((h) => refreshOrchHost(h)));
}

/** ui_command `orch.changed {host, runIds, reason}`. */
export function onOrchChanged(p) {
  const raw = p ? p.host : null;
  const h = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(h) || h <= 0) { void refreshOrchAll(); return; }
  clearTimeout(timers.get(h));
  timers.set(h, setTimeout(() => { timers.delete(h); void refreshOrchHost(h); }, 300));
}

/** 부팅 후 1회(main.js). */
export function startOrchBackground() {
  void refreshOrchAll();
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !state.paired) return;
    const any = Object.values(state.orch.byHost).some((b) => (b.runs || []).some((r) => r.state === "active"));
    if (any) void refreshOrchAll();
  }, POLL_MS);
}

export function orchSnapshot(host) {
  return state.orch.byHost[String(Number(host))] || null;
}

async function act(host, method, params, okMsg) {
  try {
    const r = await orchRpc(method, params, host);
    if (okMsg) toast(okMsg);
    void refreshOrchHost(host);
    return r;
  } catch (e) {
    toast(orchErrText(e && e.code));
    void refreshOrchHost(host);
    return null;
  }
}

/** 워커 터미널 열기 — 같은 폴더 워커는 그 워크스페이스의 터미널, 전용 작업 폴더 워커는 그 작업의 터미널. */
export async function openWorkerTerminal(host, w, wsId) {
  const tv = await import("./tasks-view.js");
  if (w.placement === "worktree" && w.taskRef) {
    const bucket = state.tasks.byHost[String(Number(host))];
    const t = ((bucket && bucket.items) || []).find((x) => x.id === w.taskRef.taskId);
    const r = t && (t.runs || []).find((x) => x.id === w.taskRef.runId);
    if (r && r.workspaceId) return tv.openRunTerminal(r.workspaceId, r.tid, { task: true });
    tv.openTasksDashboard({ taskId: w.taskRef.taskId, runId: w.taskRef.runId, host });
    return true;
  }
  const target = wsId || wsIdForCwd(host, w.cwd);
  if (!target) return false;
  return tv.openRunTerminal(target, w.tid);
}
function wsIdForCwd(host, cwd) {
  const w = S.workspacesForDevice(host).find((x) => (x.localPath || "") === (cwd || ""));
  return w ? w.id : null;
}

/** 묶음 상세 시트. */
export function openOrchSheet({ host, runId }) {
  if (open) open.close();
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet oc-sheet";
  overlay.append(box);
  document.body.append(overlay);
  const drafts = new Map();   // messageId → 쓰던 답(다시 그려도 남는다)
  let busy = false;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onEsc, true);
    open = null;
  };
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const run = () => ((orchSnapshot(host) || {}).runs || []).find((r) => r.id === runId) || null;
  const guard = async (fn) => { if (busy) return; busy = true; try { await fn(); } finally { busy = false; draw(); } };

  function draw() {
    const r = run();
    if (!r) { close(); return; }
    // 입력 중인 답은 다시 그리기 전에 떠 둔다 + 포커스 복원.
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.q || null : null;
    box.querySelectorAll("textarea[data-q]").forEach((t) => drafts.set(t.dataset.q, t.value));
    const roll = runRollup(r);
    const ws = visibleWorkers(r);
    const co = r.coordinator;
    const stat = [ot("workersN", { n: roll.counts.total }),
      roll.counts.live ? ot("liveN", { n: roll.counts.live }) : "",
      roll.counts.attention + roll.gates ? ot("attentionN", { n: roll.counts.attention + roll.gates }) : "",
      roll.counts.ok ? ot("okN", { n: roll.counts.ok }) : "",
      roll.counts.failed ? ot("failedN", { n: roll.counts.failed }) : ""].filter(Boolean).join(" · ");
    const gates = (r.gates || []).map((g) =>
      `<div class="oc-card oc-attn"><div class="oc-card-h">${esc(ot("decision"))}</div>` +
      `<div class="oc-q">${esc(g.question)}</div>` +
      `<div class="oc-opts">${g.options.map((o, i) => `<button class="btn small" data-gate="${esc(g.id)}" data-opt="${i}">${esc(o)}</button>`).join("")}</div></div>`).join("");
    const workers = ws.map((w) => {
      const dot = workerDot(w.uiState);
      const settled = ["succeeded", "failed", "stopped", "abandoned"].includes(w.state);
      const sub = [ot(workerTextKey(w.uiState)), w.phase && !settled ? w.phase : "", ot(w.placement === "worktree" ? "placeWorktree" : "placeCurrent")].filter(Boolean).join(" · ");
      const q = w.question
        ? `<div class="oc-qbox"><div class="oc-card-h">${esc(ot("question"))}</div><div class="oc-q">${esc(w.question.text)}</div>` +
          (w.question.options.length ? `<div class="oc-opts">${w.question.options.map((o, i) => `<button class="btn small" data-reply="${esc(w.question.id)}" data-opt="${i}">${esc(o)}</button>`).join("")}</div>` : "") +
          `<div class="oc-reply"><textarea class="tk-input" rows="2" data-q="${esc(w.question.id)}" placeholder="${esc(ot("replyPlaceholder"))}">${esc(drafts.get(w.question.id) || "")}</textarea>` +
          `<button class="btn small primary" data-send="${esc(w.question.id)}">${esc(ot("reply"))}</button></div></div>`
        : "";
      const res = w.result && w.result.summary ? `<div class="oc-res"><span class="oc-card-h">${esc(ot("result"))}</span> ${esc(w.result.summary)}</div>` : "";
      const acts = [
        w.tid != null && w.terminal !== "released" ? `<button class="btn small ghost" data-open="${esc(w.dispatchId)}">${esc(ot("openTerminal"))}</button>` : "",
        !settled ? `<button class="btn small ghost" data-stop="${esc(w.dispatchId)}">${esc(ot("stop"))}</button>` : "",
        settled && w.terminal === "owned" && w.placement === "worktree" && w.state === "succeeded" ? `<button class="btn small ghost" data-merge="${esc(w.dispatchId)}">${esc(ot("releaseMerge"))}</button>` : "",
        settled && w.terminal === "owned" ? `<button class="btn small ghost" data-release="${esc(w.dispatchId)}">${esc(ot("release"))}</button>` : "",
      ].join("");
      return `<div class="oc-w${w.question ? " oc-attn" : ""}">` +
        `<div class="oc-w-h"><span class="oc-w-ic">${agentMarkHtml(w.agent, { size: 15 }) || icons.terminal({ size: 15 })}</span>` +
        `<span class="oc-w-t">${esc(w.title || ot("worker"))}</span><span class="tv-dot${dot === "none" ? "" : " " + dot}"></span></div>` +
        `<div class="oc-w-sub">${esc(sub)}</div>${q}${res}` +
        (acts ? `<div class="oc-w-acts">${acts}</div>` : "") + `</div>`;
    }).join("");
    const tkey = { pending: "tPending", ready: "tReady", dispatched: "tDispatched", completed: "tCompleted", failed: "tFailed", blocked: "tBlocked" };
    const withDeps = (r.tasks || []).some((t) => (t.deps || []).length) || (r.tasks || []).some((t) => t.status === "pending" || t.status === "ready" || t.status === "blocked");
    const tasks = withDeps ? `<div class="oc-sec">${esc(ot("tasks"))}</div><div class="oc-tasks">` +
      (r.tasks || []).map((t) => `<div class="oc-task"><span class="oc-task-t">${esc(t.title)}</span><span class="oc-task-s">${esc(ot(tkey[t.status] || "wUnknown"))}</span></div>`).join("") + `</div>` : "";
    box.innerHTML =
      `<div class="wv-sheet-title oc-title"><span class="oc-title-t">${esc(runTitle(r) || ot("orchestration"))}</span>` +
      `<button class="btn small ghost oc-x" data-close="1" aria-label="close">${icons.x({ size: 14 })}</button></div>` +
      `<div class="oc-meta"><span>${esc(stat)}</span>` +
      (co && co.tid != null ? `<button class="btn small ghost" data-co="1">${esc(ot("openCoordinator"))}</button>` : "") + `</div>` +
      `<div class="oc-body">${gates}${workers || `<div class="tk-note">${esc(ot("noWorkers"))}</div>`}${tasks}</div>` +
      `<div class="oc-foot"><button class="btn small" data-runclose="1">${esc(ot("closeRun"))}</button></div>`;
    if (focused) { const t = box.querySelector(`textarea[data-q="${CSS.escape(focused)}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  }

  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const r = run();
    if (!r) return;
    const d = b.dataset;
    const w = (id) => (r.workers || []).find((x) => x.dispatchId === id);
    if (d.close) return close();
    if (d.co) { const co = r.coordinator; const wsId = wsIdForCwd(host, co.cwd); close(); if (wsId) void import("./tasks-view.js").then((m) => m.openRunTerminal(wsId, co.tid)); return; }
    if (d.open) { const x = w(d.open); close(); if (x) void openWorkerTerminal(host, x); return; }
    if (d.gate) { const g = (r.gates || []).find((x) => x.id === d.gate); if (g) void guard(() => act(host, "orch.gateResolve", { id: g.id, resolution: g.options[Number(d.opt)] }, ot("sent"))); return; }
    if (d.reply) { const x = (r.workers || []).find((y) => y.question && y.question.id === d.reply); if (x) void guard(() => act(host, "orch.reply", { id: d.reply, body: x.question.options[Number(d.opt)] }, ot("sent"))); return; }
    if (d.send) {
      const ta = box.querySelector(`textarea[data-q="${CSS.escape(d.send)}"]`);
      const body = ta ? ta.value.trim() : "";
      if (!body) { if (ta) ta.focus(); return; }
      void guard(async () => { const ok = await act(host, "orch.reply", { id: d.send, body }, ot("sent")); if (ok) drafts.delete(d.send); });
      return;
    }
    if (d.stop) { void guard(() => act(host, "orch.workerStop", { dispatch: d.stop }, ot("stopped"))); return; }
    if (d.release) { void guard(() => act(host, "orch.workerRelease", { dispatch: d.release }, ot("released"))); return; }
    if (d.merge) { void guard(() => act(host, "orch.workerRelease", { dispatch: d.merge, merge: true }, ot("released"))); return; }
    if (d.runclose) {
      const live = (r.workers || []).filter((x) => x.state === "ready" || x.state === "starting").length;
      if (live && !b.dataset.armed) {
        // 한 번 더 눌러야 실행 — 브라우저 confirm 창을 띄우지 않는다(웹뷰를 멈춘다).
        b.dataset.armed = "1"; b.textContent = ot("closeRunForce"); b.title = ot("closeRunConfirm", { n: live });
        return;
      }
      void guard(async () => { const ok = await act(host, "orch.runClose", { run: r.id, force: live > 0 }, ot("closed")); if (ok) close(); });
    }
  });

  open = { host, runId, draw, close };
  draw();
  void refreshOrchHost(host);
}

export { isLocalHostId };
