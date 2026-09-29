// dispatch-sheet.js — 한 줄 지시(automation-design §3). `.wv-sheet-overlay` 패턴(new-task-sheet.js 와 같은 모양).
//
// 클라이언트가 오케스트레이터다(§3.1):
//  1. hosts = 온라인 PC ∧ dispatch.v1(모름이면 시도) — 0대면 noHost 토스트 후 닫는다.
//  2. 각 host 에 병렬 dispatch.catalog {}(봉인, 30s) — 실패한 PC 는 빼고 카드 위에 `catalogFailed` 한 줄.
//  3. planner = 활성 PC(없으면 hosts[0]) → dispatch.plan {opId, instruction, catalog:{hosts}}.
//  4. dispatch.get {planId} 2초 폴링(최대 120초) — ui_command dispatch.changed {host, planId} 가 오면 즉시.
//  5. done → 플랜 카드(폴백이면 `간단 매칭` pill + 사유). failed → 사유 + [다시 계획].
//  6. [시작] → tasks[] 순서대로 task.create(origin:{kind:'dispatch', planId}), 포함한 automations[] 는 auto.create.
//     → 만든 첫 작업의 진행 현황(자동화만 있으면 자동화 장소)으로.
// 결정권은 사용자에게 있다(§3.4) — 자동 실행 없음. 카드에서 PC·저장소·에이전트·개수·프롬프트를 고칠 수 있다.
import { state } from "./state.js";
import * as S from "./state.js";
import { icons, agentMarkHtml } from "./icons.js";
import { autoRpc, hostHasDispatch } from "./automations-api.js";
import { taskRpc, newOpId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import { at } from "./text/automations.js";
import { triggerOf, normalizePlan, planRunTotal, planStartable, fallbackKey, pickPlannerHost } from "./automations-model.js";
import { whenText } from "./automations-view.js";
import { agentName, openTasksDashboard, toast } from "./tasks-view.js";
import { isUncertain, TASK_AGENTS, MAX_RUNS, utf8Bytes } from "./new-task-sheet.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const INSTRUCTION_MAX_BYTES = 4000;
const PLAN_POLL_MS = 2000;
const PLAN_DEADLINE_MS = 120000;

let open = null;        // 열린 시트의 상태(중복 방지 + dispatch.changed 수신)

/** ui_command `dispatch.changed {host, planId}` — 보고 있는 계획이면 즉시 다시 받는다. */
export function onDispatchChanged(p) {
  if (!open || !p) return;
  if (p.planId && open.st.planId && p.planId !== open.st.planId) return;
  open.pollNow();
}

/** 시트 열기. prefill = { text? } */
export function openDispatchSheet(prefill) {
  if (open) { open.focus(); return; }
  const pf = prefill || {};
  const st = {
    phase: "input",          // input | collecting | planning | plan | starting
    text: pf.text || "",
    collected: 0, total: 0,
    catalogs: [],            // [{host, hostName, agents, workspaces, …}]
    failedHosts: [],         // [name]
    planner: null,           // { host, agent }
    planId: null, planOpId: null,
    plan: null,              // Plan(§3.3) — 사용자가 고친 값으로 덮어 쓴다
    err: null,               // 코드
    startOps: {},            // 항목 키 → opId(결과 불명 재시도는 같은 opId)
    done: {},                // 항목 키 → true(이미 만든 것 — 재시도 때 건너뛴다)
  };
  let gen = 0;               // [다시 계획]·닫기가 진행 중인 흐름을 끊는다
  let pollKick = null;

  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet dp-sheet";
  overlay.append(box);
  document.body.append(overlay);
  const close = () => {
    gen++;
    overlay.remove();
    document.removeEventListener("keydown", onEsc, true);
    open = null;
  };
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const hosts = () => S.pcDevices().filter((d) => d.online !== false && typeof d.id === "number" && hostHasDispatch(d.id) !== false);
  const nameOf = (h) => (S.pcDevices().find((d) => Number(d.id) === Number(h)) || {}).name || tt("pc");
  const catOf = (h) => st.catalogs.find((c) => Number(c.host) === Number(h)) || null;

  // ── 흐름 ──
  async function plan() {
    const my = ++gen;
    const hs = hosts();
    if (!hs.length) { toast(tt("noHost")); close(); return; }
    const text = st.text.trim();
    if (!text || utf8Bytes(text) > INSTRUCTION_MAX_BYTES) return;
    st.phase = "collecting"; st.err = null; st.plan = null; st.catalogs = []; st.failedHosts = [];
    st.collected = 0; st.total = hs.length; st.startOps = {}; st.done = {};
    draw();
    await Promise.all(hs.map(async (d) => {
      try {
        const c = await autoRpc("dispatch.catalog", {}, d.id, 30000);
        if (my !== gen) return;
        st.catalogs.push({ ...(c || {}), host: Number((c && c.host) ?? d.id), hostName: (c && c.hostName) || d.name || "" });
      } catch (_) {
        if (my !== gen) return;
        st.failedHosts.push(d.name || tt("pc"));
      } finally {
        if (my === gen) { st.collected++; draw(); }
      }
    }));
    if (my !== gen) return;
    // 카드 순서가 흔들리지 않게 PC 목록 순서로.
    st.catalogs.sort((a, b) => hs.findIndex((d) => Number(d.id) === a.host) - hs.findIndex((d) => Number(d.id) === b.host));
    const plannerHost = pickPlannerHost(hs.map((d) => d.id), S.activeDeviceId());
    st.planOpId = newOpId();
    st.phase = "planning"; st.planner = { host: plannerHost, agent: null };
    draw();
    let acc;
    try {
      acc = await autoRpc("dispatch.plan", {
        opId: st.planOpId, instruction: text,
        catalog: { hosts: st.catalogs },
        prefer: {},
      }, plannerHost);
    } catch (e) {
      if (my !== gen) return;
      st.phase = "input"; st.err = (e && e.code) || "x"; draw(); return;
    }
    if (my !== gen) return;
    st.planId = acc && acc.planId;
    st.planner.agent = (acc && acc.planner && acc.planner.agent) || null;
    draw();
    const until = Date.now() + PLAN_DEADLINE_MS;
    while (my === gen && Date.now() < until) {
      await new Promise((r) => { pollKick = r; setTimeout(r, PLAN_POLL_MS); });
      pollKick = null;
      if (my !== gen) return;
      let g;
      try { g = await autoRpc("dispatch.get", { planId: st.planId }, plannerHost); } catch (e) {
        if (e && e.code && e.code !== "TIMEOUT") { st.phase = "input"; st.err = e.code; draw(); return; }
        continue;
      }
      if (my !== gen) return;
      if (g && g.state === "done" && g.plan) { st.plan = normalizePlan(g.plan); st.phase = "plan"; draw(); return; }
      if (g && g.state === "failed") { st.phase = "input"; st.err = (g.error && g.error.code) || "x"; draw(); return; }
    }
    if (my === gen) { st.phase = "input"; st.err = "TIMEOUT"; draw(); }
  }

  const totalRuns = () => planRunTotal(st.plan);
  const canStart = () => st.phase === "plan" && planStartable(st.plan);

  async function start() {
    if (!canStart()) return;
    st.phase = "starting"; st.err = null;
    draw();
    const planId = st.planId;
    let firstTask = null;
    let firstAuto = null;
    for (const t of st.plan.tasks) {
      if (st.done[t.key]) { firstTask = firstTask || st.done[t.key]; continue; }
      const ws = ((catOf(t.host) || {}).workspaces || []).find((w) => w.id === t.workspaceId) || {};
      const opId = st.startOps[t.key] || (st.startOps[t.key] = newOpId());
      try {
        const r = await taskRpc("task.create", {
          opId, repo: ws.path || t.repo, ...(t.subdir ? { subdir: t.subdir } : {}), base: t.base || ws.branch || "",
          prompt: t.prompt, title: t.title, agents: Object.entries(t.agents).map(([id, count]) => ({ id, count })),
          copyEnv: true, fetch: false, workspaceId: t.workspaceId, origin: { kind: "dispatch", planId },
        }, t.host);
        st.done[t.key] = { taskId: r && r.task && r.task.id, host: t.host };
        firstTask = firstTask || st.done[t.key];
      } catch (e) {
        const code = (e && e.code) || "";
        if (!isUncertain(code)) delete st.startOps[t.key];
        st.phase = "plan"; st.err = code || "x"; draw(); return;
      }
    }
    for (const a of st.plan.automations) {
      if (!a.include) continue;
      if (st.done[a.key]) { firstAuto = firstAuto || st.done[a.key]; continue; }
      const opId = st.startOps[a.key] || (st.startOps[a.key] = newOpId());
      try {
        const r = await autoRpc("auto.create", {
          opId, draft: a.draft, createdBy: { kind: "dispatch", deviceId: state.daemon?.deviceId ?? null, planId },
        }, a.host);
        st.done[a.key] = { id: r && r.automation && r.automation.id, host: a.host };
        firstAuto = firstAuto || st.done[a.key];
      } catch (e) {
        const code = (e && e.code) || "";
        if (!isUncertain(code)) delete st.startOps[a.key];
        st.phase = "plan"; st.err = code || "x"; draw(); return;
      }
    }
    close();
    if (firstTask) openTasksDashboard({ taskId: firstTask.taskId, host: firstTask.host });
    else if (firstAuto) import("./automations-view.js").then((m) => m.openAutomations({ id: firstAuto.id, host: firstAuto.host })).catch(() => {});
  }

  // ── 그리기 ──
  let ta = null;
  function draw() {
    const typing = ta && document.activeElement === ta;
    const caret = typing ? [ta.selectionStart, ta.selectionEnd] : null;
    box.innerHTML = "";
    const h = document.createElement("div");
    h.className = "wv-sheet-title dp-title";
    h.innerHTML = `${icons.zap({ size: 14 })}<span>${esc(at("dispatch"))}</span>`;
    box.append(h);
    const form = document.createElement("div");
    form.className = "tk-form";
    box.append(form);

    // 지시 문장 — 계획이 나온 뒤에도 고쳐서 [다시 계획] 할 수 있게 항상 위에 둔다.
    ta = document.createElement("textarea");
    ta.className = "tk-input dp-input";
    ta.rows = st.plan ? 2 : 3;
    ta.placeholder = at("dispatchPlaceholder");
    ta.value = st.text;
    ta.disabled = st.phase === "collecting" || st.phase === "planning" || st.phase === "starting";
    ta.addEventListener("input", () => { st.text = ta.value; syncFoot(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (st.phase === "plan" && canStart()) void start(); else void plan(); }
    });
    form.append(ta);

    if (st.phase === "collecting") form.append(progress(at("collecting", { n: st.collected, d: st.total })));
    if (st.phase === "planning") form.append(progress(at("planning", { agent: st.planner && st.planner.agent ? agentName(st.planner.agent) : "" }).replace(/ · $/, "")));
    if (st.plan) form.append(planCard());

    const status = document.createElement("div");
    status.className = "tk-status" + (st.err ? " err" : "");
    status.textContent = st.err ? errText(st.err) : st.phase === "starting" ? tt("opInProgress") : "";
    box.append(status);

    const foot = document.createElement("div");
    foot.className = "tk-foot";
    const cancel = mkBtn("tv-btn ghost", tt("cancel"), close);
    const planBtn = mkBtn(st.plan ? "tv-btn ghost" : "tv-btn", st.plan ? at("replan") : at("plan"), () => void plan());
    foot.append(cancel, planBtn);
    let startBtn = null;
    if (st.plan) { startBtn = mkBtn("tv-btn", tt("start"), () => void start()); foot.append(startBtn); }
    box.append(foot);
    function syncFoot() {
      const busy = st.phase === "collecting" || st.phase === "planning" || st.phase === "starting";
      const n = utf8Bytes(st.text.trim());
      planBtn.disabled = busy || !n || n > INSTRUCTION_MAX_BYTES;
      if (startBtn) startBtn.disabled = busy || !canStart();
    }
    syncFoot();
    open.syncFoot = syncFoot;
    if (caret) { ta.focus(); try { ta.setSelectionRange(caret[0], caret[1]); } catch (_) { /* noop */ } }
  }

  function progress(text) {
    const d = document.createElement("div");
    d.className = "dp-progress";
    d.innerHTML = `<span class="tv-dot spin"></span><span>${esc(text)}</span>`;
    return d;
  }

  function planCard() {
    const p = st.plan;
    const card = document.createElement("div");
    card.className = "dp-card";
    // 위 줄 — 카탈로그 실패 PC · 폴백 사유
    for (const n of st.failedHosts) card.append(line("dp-warnline", at("catalogFailed", { name: n })));
    const why = fallbackKey(p.planner);
    if (why) {
      const row = document.createElement("div");
      row.className = "dp-fallback";
      row.innerHTML = `<span class="dp-pill">${esc(at("simpleMatch"))}</span><span>${esc(at(why))}</span>`;
      card.append(row);
    }
    if (p.questions.length) {
      const q = document.createElement("div");
      q.className = "dp-questions";
      q.innerHTML = `<div class="dp-sec">${esc(at("planQuestions"))}</div>` + p.questions.map((x) => `<div class="dp-q">${esc(x)}</div>`).join("");
      card.append(q);
    }
    if (p.summary) {
      const s = document.createElement("div");
      s.className = "dp-summary";
      s.textContent = p.summary;
      card.append(s);
    }
    if (p.tasks.length) {
      card.append(line("dp-sec", at("planTasks")));
      for (const t of p.tasks) card.append(taskItem(t));
    }
    if (p.automations.length) {
      card.append(line("dp-sec", at("planAutomations")));
      for (const a of p.automations) card.append(autoItem(a));
    }
    return card;
  }

  function taskItem(t) {
    const it = document.createElement("div");
    it.className = "dp-item";
    const head = document.createElement("div");
    head.className = "dp-item-head";
    head.innerHTML = `<span class="dp-item-title">${esc(t.title || t.prompt.slice(0, 60))}</span>`;
    it.append(head);
    const grid = document.createElement("div");
    grid.className = "dp-grid";
    // PC — 카탈로그를 받은 PC 만(온라인). 바꾸면 저장소를 그 PC 의 것으로 다시 고른다.
    if (st.catalogs.length >= 2) {
      const ps = select(st.catalogs.map((c) => [String(c.host), c.hostName || nameOf(c.host)]), String(t.host));
      ps.addEventListener("change", () => {
        t.host = Number(ps.value);
        const ws = (catOf(t.host) || {}).workspaces || [];
        t.workspaceId = ws.length === 1 ? ws[0].id : null; t.subdir = "";
        const inst = installedAgents(t.host);
        for (const id of Object.keys(t.agents)) if (!inst.includes(id)) delete t.agents[id];
        if (!Object.keys(t.agents).length && inst[0]) t.agents[inst[0]] = 1;
        draw();
      });
      grid.append(field(tt("pc"), ps));
    }
    // 저장소 — 못 정해졌으면(workspaceId:null) 강조 + [시작] 비활성(§3.4).
    const wss = (catOf(t.host) || {}).workspaces || [];
    const opts = wss.map((w) => [w.id, w.name + (w.path ? `  ~/${w.path}` : "")]);
    if (!t.workspaceId) opts.unshift(["", at("pickRepo")]);
    const rs = select(opts, t.workspaceId || "");
    rs.classList.toggle("dp-need", !t.workspaceId);
    rs.addEventListener("change", () => {
      t.workspaceId = rs.value || null;
      const w = wss.find((x) => x.id === t.workspaceId);
      if (w && t.subdir && !(w.topDirs || []).includes(t.subdir)) t.subdir = "";
      draw();
    });
    const repoField = field(tt("repo"), rs);
    if (t.subdir) repoField.append(line("tk-note mono", t.subdir));
    grid.append(repoField);
    it.append(grid);
    // 에이전트 칩 + ×n
    const chips = document.createElement("div");
    chips.className = "tk-chips";
    for (const id of TASK_AGENTS) {
      const installed = installedAgents(t.host).includes(id);
      if (!installed && !t.agents[id]) continue;
      const on = !!t.agents[id];
      const chip = document.createElement("div");
      chip.className = "tk-chip" + (on ? " on" : "") + (installed ? "" : " off");
      const lbl = document.createElement("button");
      lbl.className = "tk-chip-lbl";
      lbl.disabled = !installed;
      lbl.innerHTML = `${agentMarkHtml(id, { size: 14 }) || icons.terminal({ size: 14 })}<span>${esc(agentName(id))}</span>`;
      lbl.addEventListener("click", () => {
        if (on) delete t.agents[id];
        else if (totalRuns() < MAX_RUNS) t.agents[id] = 1;
        draw();
      });
      chip.append(lbl);
      if (on) {
        const step = document.createElement("span");
        step.className = "tk-step";
        const minus = mkBtn("", "−", () => { t.agents[id] = Math.max(1, t.agents[id] - 1); draw(); });
        minus.disabled = t.agents[id] <= 1;
        const n = document.createElement("span");
        n.className = "tk-step-n";
        n.textContent = "×" + t.agents[id];
        const plus = mkBtn("", "+", () => { if (totalRuns() < MAX_RUNS) t.agents[id] += 1; draw(); });
        plus.disabled = totalRuns() >= MAX_RUNS;
        step.append(minus, n, plus);
        chip.append(step);
      }
      chips.append(chip);
    }
    it.append(field(tt("agents"), chips));
    // 프롬프트(접힘, 편집 가능)
    const dd = document.createElement("details");
    dd.className = "tk-adv dp-prompt";
    dd.innerHTML = `<summary>${esc(tt("prompt"))}</summary>`;
    const pta = document.createElement("textarea");
    pta.className = "tk-input";
    pta.rows = 5;
    pta.value = t.prompt;
    pta.addEventListener("input", () => { t.prompt = pta.value; open.syncFoot?.(); });
    dd.append(pta);
    it.append(dd);
    if (t.why) it.append(line("dp-why", t.why));
    return it;
  }

  function autoItem(a) {
    const it = document.createElement("div");
    it.className = "dp-item dp-auto" + (a.include ? "" : " off");
    const d = a.draft || {};
    const trig = triggerOf(d.trigger);
    const v = { ...trig.vars };
    if (trig.key === "trigOnce") v.t = whenText(v.at);
    const acts = (d.actions || []).map((x) => at({ "task.create": "actTaskCreate", "terminal.prompt": "actPrompt", notify: "actNotify" }[x.type] || "actNotify"));
    const lab = document.createElement("label");
    lab.className = "dp-item-head dp-include";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = a.include;
    cb.title = at("include");
    cb.setAttribute("aria-label", at("include"));
    cb.addEventListener("change", () => { a.include = cb.checked; draw(); });
    const nm = document.createElement("span");
    nm.className = "dp-item-title";
    nm.textContent = d.name || at(trig.key, v);
    lab.append(cb, nm);
    it.append(lab);
    const meta = document.createElement("div");
    meta.className = "dp-auto-meta";
    meta.innerHTML = `<span class="dp-auto-trig">${icons.repeat({ size: 12 })}<span>${esc(at(trig.key, v))}</span></span>`
      + (acts.length ? `<span>${esc(acts.join(" → "))}</span>` : "")
      + (st.catalogs.length >= 2 ? `<span>${esc(nameOf(a.host))}</span>` : "");
    it.append(meta);
    if (a.why) it.append(line("dp-why", a.why));
    return it;
  }

  function installedAgents(h) {
    const c = catOf(h);
    return ((c && c.agents) || []).filter((x) => x && x.installed).map((x) => x.id).filter((id) => TASK_AGENTS.includes(id));
  }

  open = {
    st,
    focus: () => ta?.focus(),
    pollNow: () => { try { pollKick?.(); } catch (_) { /* noop */ } },
    syncFoot: null,
  };
  draw();
  setTimeout(() => ta?.focus(), 30);
}

function line(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
function field(label, input) {
  const w = document.createElement("div");
  w.className = "tk-field";
  const l = document.createElement("span");
  l.className = "tk-label";
  l.textContent = label;
  w.append(l, input);
  return w;
}
function select(options, value) {
  const s = document.createElement("select");
  s.className = "tk-input";
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  return s;
}
function mkBtn(cls, label, onClick) {
  const b = document.createElement("button");
  if (cls) b.className = cls;
  b.textContent = label;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick?.(e); });
  return b;
}
