// new-task-sheet.js — 새 작업 시트(설계 §6.3). `.wv-sheet-overlay` 패턴.
//
// PC(온라인 local 러너 2대 이상일 때만) → 저장소(그 PC 의 로컬 워크스페이스, 작업 워크스페이스 제외) →
//  base(git.branches, 기본 current) → 프롬프트(UTF-8 바이트 카운터, 30000 상한) → 에이전트 칩(×n, 총 run ≤ 4) →
//  고급(.env 복사·시작 전 fetch) → [시작] = task.create {opId} → 시트 닫고 현황판의 그 작업으로.
//
// 에이전트 선택지는 claude · codex · gemini 뿐이다(부록 Z B-5 — promptArg 를 가진 에이전트만. cursor-agent·opencode 는
//  붙여넣기 경로가 필요해서 이번 라운드 작업 선택지에서 뺐다).
//  칩 목록: 이 PC 면 agents-view.loadAgents()(로컬 데몬), 다른 PC 면 tasks-api.agentsRemote(hid) — api.agentsLocal 은
//  로컬 데몬만 본다(agents-view.js:46).
import { state } from "./state.js";
import * as S from "./state.js";
import { icons, agentMarkHtml } from "./icons.js";
import { loadAgents } from "./agents-view.js";
import { taskRpc, agentsRemote, hostHasTasks, serverHasTasks, newOpId, isLocalHostId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import { openTasksDashboard, agentName } from "./tasks-view.js";

export const TASK_AGENTS = ["claude", "codex", "gemini"];
export const PROMPT_MAX_BYTES = 30000;
export const MAX_RUNS = 4;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const utf8Bytes = (s) => new TextEncoder().encode(String(s || "")).length;

let open = null; // 열려 있는 시트(중복 방지)

/**
 * 에이전트별 모델·추론 강도 선택(2026-10-02 QA) — 목록은 **이 PC 의 CLI 가 아는 값**(agents.list 의 models/efforts).
 *  구 데몬(필드 없음)이거나 모르는 에이전트(gemini)면 null — 선택지를 그리지 않고 CLI 기본값을 쓴다.
 *  sel = { model, effort }(빈 문자열 = 기본값). 모델을 바꾸면 그 모델이 지원하지 않는 강도는 기본값으로 되돌린다(codex).
 */
export function agentModelRow(a, sel, onChange, opt = {}) {
  const models = Array.isArray(a.models) ? a.models : [];
  if (!models.length) return null;
  const w = document.createElement("div");
  w.className = "tk-model-row";
  const name = document.createElement("span");
  name.className = "tk-model-ag";
  name.textContent = a.name || agentName(a.id);
  const mk = (label, opts, value, set) => {
    const f = document.createElement("label");
    f.className = "tk-model-f";
    const l = document.createElement("span");
    l.textContent = label;
    const sl = document.createElement("select");
    sl.className = "tk-input";
    for (const [v, t] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sl.append(o);
    }
    sl.addEventListener("change", () => set(sl.value));
    f.append(l, sl);
    return f;
  };
  const cur = models.find((m) => m.id === sel.model);
  const defName = a.defaultModel || "";
  const modelOpts = [["", defName ? tt("modelDefaultN", { name: defName }) : tt("modelDefault")]]
    .concat(models.map((m) => [m.id, m.hint ? `${m.label} · ${m.hint}` : m.label]));
  // 강도 선택지 — 선택한 모델이 자기 목록(codex)을 가지면 그것, 아니면 에이전트 공통(claude).
  const effList = (cur && Array.isArray(cur.efforts) && cur.efforts.length ? cur.efforts : a.efforts) || [];
  const defEff = (cur && cur.defaultEffort) || a.defaultEffort || "";
  const effOpts = [["", defEff ? tt("modelDefaultN", { name: defEff }) : tt("modelDefault")]].concat(effList.map((e) => [e, e]));
  if (sel.effort && !effList.includes(sel.effort)) sel.effort = "";
  w.append(...(opt.noName ? [] : [name]),
    mk(tt("model"), modelOpts, sel.model || "", (v) => { sel.model = v; onChange(true); }),
    ...(effList.length ? [mk(tt("effort"), effOpts, sel.effort || "", (v) => { sel.effort = v; onChange(false); })] : []));
  return w;
}

/** prefill = { host?, wsId? } */
export function openNewTaskSheet(prefill) {
  if (open) { open.focus(); return; }
  const pf = prefill || {};
  const st = {
    host: null, wsId: null, base: "", branches: null, branchErr: null,
    prompt: "", agents: {}, sels: {}, agentList: null, agentErr: null,
    copyEnv: true, fetch: false, busy: false, err: null,
    // ★ 멱등 키(§2.12) — 결과가 불명한 실패(TIMEOUT·전송 실패)는 호스트가 이미 만들었을 수 있다. 다시 [시작] 해도
    //   같은 opId 를 보내야 데몬 createOps 재생이 중복 작업(worktree·에이전트 N개 더)을 막는다.
    //   호스트가 명확히 거절한 도메인 코드에서만 새로 만든다.
    opId: newOpId(),
  };
  // 비동기 조회 순서 보장 — 저장소/PC 를 빨리 바꾸면 앞선 느린 응답이 나중에 와서 덮어쓴다(엉뚱한 base·에이전트).
  let branchSeq = 0;
  let agentSeq = 0;
  // 서버 킬스위치면 다른 PC(서버 경유)는 고를 수 없다 — 이 PC 는 로컬 소켓 직결.
  const hosts = () => S.pcDevices().filter((d) => d.online !== false && typeof d.id === "number" && hostHasTasks(d.id) !== false
    && (serverHasTasks() !== false || isLocalHostId(state, d.id)));
  const hs = hosts();
  st.host = pf.host != null && hs.some((d) => Number(d.id) === Number(pf.host)) ? Number(pf.host)
    : (hs.find((d) => isLocalHostId(state, d.id)) || hs[0] || {}).id ?? null;

  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet tk-new";
  overlay.append(box);
  document.body.append(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onEsc, true); open = null; };
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const repos = () => S.workspacesForDevice(st.host).filter((w) => S.isLocal(w) && !S.isTaskWorkspace(w) && w.localPath);
  const pickDefaultRepo = () => {
    const list = repos();
    st.wsId = (pf.wsId && list.some((w) => w.id === pf.wsId)) ? pf.wsId : (list[0] || {}).id || null;
  };
  pickDefaultRepo();

  async function loadBranches() {
    const my = ++branchSeq;
    st.branches = null; st.branchErr = null; st.base = "";
    draw();
    const ws = repos().find((w) => w.id === st.wsId);
    if (!ws) return;
    const host = st.host;
    try {
      const r = await taskRpc("git.branches", { repo: ws.localPath }, host);
      if (my !== branchSeq || host !== st.host || ws.id !== st.wsId) return; // 이미 다른 저장소/PC 를 골랐다
      st.branches = r || {};
      st.base = r.current || ((r.branches || [])[0] || {}).name || "";
    } catch (e) {
      if (my !== branchSeq || host !== st.host || ws.id !== st.wsId) return;
      st.branchErr = (e && e.code) || "";
    }
    draw();
  }
  async function loadAgentChips() {
    const my = ++agentSeq;
    const host = st.host;
    st.agentList = null; st.agentErr = null;
    draw();
    try {
      const r = isLocalHostId(state, host) ? await loadAgents(false) : await agentsRemote(host);
      if (my !== agentSeq || host !== st.host) return;
      st.agentList = (r.agents || []).filter((a) => TASK_AGENTS.includes(a.id));
      // 기본 선택: 설치된 첫 에이전트 ×1(보통 claude).
      if (!Object.keys(st.agents).length) {
        const first = st.agentList.find((a) => a.installed);
        if (first) st.agents[first.id] = 1;
      }
      for (const id of Object.keys(st.agents)) if (!st.agentList.some((a) => a.id === id && a.installed)) delete st.agents[id];
    } catch (e) {
      if (my !== agentSeq || host !== st.host) return;
      st.agentErr = (e && e.code) || "x";
    }
    draw();
  }
  const total = () => Object.values(st.agents).reduce((n, c) => n + c, 0);

  function draw() {
    // 비동기 조회(브랜치·에이전트)가 끝나 다시 그릴 때 프롬프트를 치던 손을 끊지 않는다 — 포커스·커서 보존.
    const typing = open && document.activeElement === open;
    const caret = typing ? [open.selectionStart, open.selectionEnd] : null;
    box.innerHTML = "";
    const h = document.createElement("div");
    h.className = "wv-sheet-title";
    h.textContent = tt("newTask");
    box.append(h);
    const form = document.createElement("div");
    form.className = "tk-form";
    box.append(form);

    // PC — 온라인 로컬 러너가 2대 이상일 때만.
    if (hosts().length >= 2) {
      const sel = document.createElement("select");
      sel.className = "tk-input";
      for (const d of hosts()) {
        const o = document.createElement("option");
        o.value = String(d.id);
        o.textContent = d.name || tt("pc");
        if (Number(d.id) === st.host) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        st.host = Number(sel.value); st.agents = {};
        pickDefaultRepo(); void loadBranches(); void loadAgentChips();
      });
      form.append(row(tt("pc"), sel));
    }

    // 저장소
    const rs = document.createElement("select");
    rs.className = "tk-input";
    for (const w of repos()) {
      const o = document.createElement("option");
      o.value = w.id;
      o.textContent = S.wsDisplayName(w);
      if (w.id === st.wsId) o.selected = true;
      rs.append(o);
    }
    rs.disabled = !repos().length;
    rs.addEventListener("change", () => { st.wsId = rs.value; void loadBranches(); });
    form.append(row(tt("repo"), rs));

    // base
    const bs = document.createElement("select");
    bs.className = "tk-input";
    const names = st.branches ? (st.branches.branches || []).map((b) => b.name) : [];
    if (st.base && !names.includes(st.base)) names.unshift(st.base);
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      if (n === st.base) o.selected = true;
      bs.append(o);
    }
    bs.disabled = !names.length;
    bs.addEventListener("change", () => { st.base = bs.value; });
    const baseRow = row(tt("base"), bs);
    if (st.branchErr === "NOT_A_REPO") {
      // 비-git 폴더 — 이유만 알리고 아무것도 하지 않는다(2026-10-02 결정: 하위 repo 탐색·다중 repo 작업은 하지 않음).
      baseRow.append(note(tt("notRepoHint"), "err"));
    } else if (st.branchErr != null) baseRow.append(note(errText(st.branchErr), "err"));
    else if (!st.branches && st.wsId) baseRow.append(note(tt("checking")));
    else if (st.branches && st.branches.dirtyCount > 0) {
      baseRow.append(note(tt("baseDirtyHint", { name: st.branches.current || st.base, n: st.branches.dirtyCount })));
    }
    form.append(baseRow);

    // 프롬프트
    const ta = document.createElement("textarea");
    ta.className = "tk-input tk-prompt";
    ta.rows = 7;
    ta.placeholder = tt("promptPlaceholder");
    ta.value = st.prompt;
    const counter = note("");
    const syncCount = () => {
      const n = utf8Bytes(ta.value);
      counter.textContent = tt("promptBytes", { a: n.toLocaleString("en-US"), d: PROMPT_MAX_BYTES.toLocaleString("en-US") });
      counter.classList.toggle("err", n > PROMPT_MAX_BYTES);
    };
    ta.addEventListener("input", () => { st.prompt = ta.value; syncCount(); syncStart(); });
    ta.addEventListener("keydown", (e) => {
      // ⌘/Ctrl+Enter = 시작(프롬프트는 여러 줄이라 Enter 단독은 줄바꿈).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startBtn.click(); }
    });
    syncCount();
    const pr = row(tt("prompt"), ta);
    pr.append(counter);
    form.append(pr);

    // 에이전트 칩
    const chips = document.createElement("div");
    chips.className = "tk-chips";
    if (st.agentErr) chips.append(note(errText(""), "err"));
    else if (!st.agentList) chips.append(note(tt("checking")));
    else {
      for (const a of st.agentList) {
        const on = !!st.agents[a.id];
        const chip = document.createElement("div");
        chip.className = "tk-chip" + (on ? " on" : "") + (a.installed ? "" : " off");
        if (!a.installed) chip.title = tt("notInstalled");
        const lbl = document.createElement("button");
        lbl.className = "tk-chip-lbl";
        lbl.disabled = !a.installed;
        lbl.innerHTML = `${agentMarkHtml(a.id, { size: 14 }) || icons.terminal({ size: 14 })}<span>${esc(a.name || agentName(a.id))}</span>`;
        lbl.addEventListener("click", () => {
          if (on) delete st.agents[a.id];
          else if (total() < MAX_RUNS) st.agents[a.id] = 1;
          draw();
        });
        chip.append(lbl);
        if (on) {
          const step = document.createElement("span");
          step.className = "tk-step";
          const minus = document.createElement("button");
          minus.textContent = "−";
          minus.disabled = st.agents[a.id] <= 1;
          minus.addEventListener("click", () => { st.agents[a.id] = Math.max(1, st.agents[a.id] - 1); draw(); });
          const n = document.createElement("span");
          n.className = "tk-step-n";
          n.textContent = "×" + st.agents[a.id];
          const plus = document.createElement("button");
          plus.textContent = "+";
          plus.disabled = total() >= MAX_RUNS;
          plus.addEventListener("click", () => { if (total() < MAX_RUNS) st.agents[a.id] += 1; draw(); });
          step.append(minus, n, plus);
          chip.append(step);
        }
        chips.append(chip);
      }
    }
    form.append(row(tt("agents"), chips));
    // 고른 에이전트마다 모델·추론 강도(이 PC 의 CLI 가 아는 목록)
    for (const a of st.agentList || []) {
      if (!st.agents[a.id]) continue;
      const mr = agentModelRow(a, (st.sels[a.id] = st.sels[a.id] || { model: "", effort: "" }), () => draw());
      if (mr) form.append(mr);
    }

    // 고급
    const adv = document.createElement("details");
    adv.className = "tk-adv";
    adv.innerHTML = `<summary>${esc(tt("advanced"))}</summary>`;
    const ce = checkbox(tt("copyEnv"), st.copyEnv, (v) => { st.copyEnv = v; });
    const ff = checkbox(tt("fetchFirst"), st.fetch, (v) => { st.fetch = v; });
    adv.append(ce, ff);
    form.append(adv);

    const status = document.createElement("div");
    status.className = "tk-status" + (st.err ? " err" : "");
    status.textContent = st.err ? errText(st.err) : st.busy ? tt("opInProgress") : "";
    box.append(status);

    const foot = document.createElement("div");
    foot.className = "tk-foot";
    const cancel = document.createElement("button");
    cancel.className = "tv-btn ghost";
    cancel.textContent = tt("cancel");
    cancel.addEventListener("click", close);
    const startBtn = document.createElement("button");
    startBtn.className = "tv-btn";
    startBtn.textContent = tt("start");
    startBtn.addEventListener("click", start);
    foot.append(cancel, startBtn);
    box.append(foot);
    const syncStart = () => {
      startBtn.disabled = st.busy || !st.wsId || !st.base || !st.prompt.trim()
        || utf8Bytes(st.prompt) > PROMPT_MAX_BYTES || total() < 1 || total() > MAX_RUNS;
    };
    syncStart();
    open = ta;
    if (caret) { ta.focus(); try { ta.setSelectionRange(caret[0], caret[1]); } catch (_) { /* noop */ } }
    return ta;
  }

  async function start() {
    const ws = repos().find((w) => w.id === st.wsId);
    if (!ws || st.busy) return;
    st.busy = true; st.err = null;
    draw();
    try {
      const r = await taskRpc("task.create", {
        opId: st.opId,
        repo: ws.localPath,
        base: st.base,
        prompt: st.prompt,
        agents: Object.entries(st.agents).map(([id, count]) => {
          const m = st.sels[id] || {};
          return { id, count, ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) };
        }),
        copyEnv: st.copyEnv,
        fetch: st.fetch,
        workspaceId: ws.id,
      }, st.host);
      close();
      openTasksDashboard({ taskId: r && r.task && r.task.id, host: st.host });
    } catch (e) {
      st.busy = false;
      const code = (e && e.code) || "";
      // 결과 불명(TIMEOUT·코드 없음·뭉개진 릴레이 실패) = 같은 opId 유지. 호스트가 거절한 도메인 코드면 새 키.
      if (!isUncertain(code)) st.opId = newOpId();
      st.err = code || "x";
      draw();
    }
  }

  draw();
  setTimeout(() => open?.focus?.(), 30);
  void loadBranches();
  void loadAgentChips();
}

/** 결과 불명 실패 — 호스트가 이미 실행했을 수 있다(재시도는 같은 opId 로). */
export function isUncertain(code) {
  return !code || code === "TIMEOUT" || code === "E2EE_RELAY_FAILED" || code === "DAEMON_OFFLINE";
}

function row(label, input) {
  const w = document.createElement("div");
  w.className = "tk-field";
  const l = document.createElement("span");
  l.className = "tk-label";
  l.textContent = label;
  w.append(l, input);
  return w;
}
function note(text, cls) {
  const n = document.createElement("div");
  n.className = "tk-note" + (cls ? " " + cls : "");
  n.textContent = text;
  return n;
}
function checkbox(label, on, onChange) {
  const w = document.createElement("label");
  w.className = "tk-check";
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = !!on;
  c.addEventListener("change", () => onChange(c.checked));
  w.append(c, document.createTextNode(" " + label));
  return w;
}
