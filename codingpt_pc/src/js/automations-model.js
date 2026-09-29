// automations-model.js — 자동화 목록의 **순수 판정**(automation-design §8.2). import 0개 — node 에서 그대로 돈다.
//
// 앱(codingpt_app/src/workspace/automations/automationsModel.ts)에 같은 판정이 있고, 픽스처
//  docs/fixtures/automation/auto-*.json 로 두 구현을 같은 입력에서 대조한다(test/automations-crossimpl.mjs).
//
// 규율(§8.2 정본 — 여기서 새 규칙을 만들지 않는다):
//  · group = item.paused || !item.enabled → 'paused'. 전체 일시정지(input.paused)·hostOnline 은 행을 바꾸지 않는다
//    (배너·헤더만 — 행까지 흐리면 "무엇이 원래 멈춰 있었는지" 가 사라진다).
//  · attention = pausedReason ∈ {error, limit} ‖ lastResult.ok === false ‖ consecutiveFailures > 0.
//  · dot: attention → error, inflight > 0 → spin, 그 외 none(attention 이 spin 보다 먼저 — 실패가 가려지지 않게).
//  · 정렬: active = attention 먼저 → nextRunAt 오름(null 뒤) → name 코드포인트. paused = updatedAt 내림 → name.
//    localeCompare 금지(런타임마다 결과가 다르다).

const TRIGGER_KEY = {
  "git.commits": "trigCommits",
  "github.issues": "trigIssues",
  "pr.ci_failed": "trigCi",
  "pr.review_comments": "trigReviews",
  "task.event": "trigTaskEvent",
};

function num(v, d = 0) {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : d;
}
const cp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 트리거 → { key, vars } — 문장은 클라가 `at(key, vars)` 로 그린다(cron 은 원문 그대로, 사람 문장으로 풀지 않는다). */
export function triggerOf(trigger) {
  const t = trigger || {};
  const repo = t.repo == null ? null : String(t.repo);
  if (t.type === "schedule") {
    if (t.cron) return { key: "trigSchedule", vars: { cron: String(t.cron), tz: t.tz || "" } };
    return { key: "trigOnce", vars: { at: t.at == null ? null : num(t.at), tz: t.tz || "" } };
  }
  const key = TRIGGER_KEY[t.type] || "trigTaskEvent";
  const vars = { repo };
  if (t.type === "git.commits") { vars.branch = [t.remote || "origin", t.branch || ""].filter(Boolean).join("/"); }
  if (t.type === "github.issues") vars.labels = Array.isArray(t.labels) ? t.labels.join(", ") : "";
  if (t.type === "task.event" || !TRIGGER_KEY[t.type]) vars.event = t.event || t.type || "";
  return { key, vars };
}

/** 한 항목 → AutoRow(§8.2). */
export function autoRow(item) {
  const a = item || {};
  const st = a.state || {};
  const lr = st.lastResult || null;
  const cb = a.createdBy || {};
  const g = a.guards || {};
  const trig = triggerOf(a.trigger);
  const attention = a.pausedReason === "error" || a.pausedReason === "limit"
    || !!(lr && lr.ok === false) || num(st.consecutiveFailures) > 0;
  return {
    id: a.id,
    name: a.name == null ? "" : String(a.name),
    creator: cb.kind === "agent" || cb.kind === "dispatch" ? cb.kind : "user",
    creatorAgent: cb.agent || null,
    triggerKey: trig.key,
    triggerVars: trig.vars,
    dot: attention ? "error" : num(st.inflight) > 0 ? "spin" : "none",
    attention,
    group: a.paused || !a.enabled ? "paused" : "active",
    pausedReason: a.pausedReason || null,
    nextRunAt: st.nextRunAt == null ? null : num(st.nextRunAt),
    lastOk: lr ? lr.ok === true : null,
    lastAt: lr && lr.at != null ? num(lr.at) : st.lastRunAt != null ? num(st.lastRunAt) : null,
    lastCode: lr && lr.code ? String(lr.code) : null,
    taskIds: lr && Array.isArray(lr.taskIds) ? lr.taskIds.slice() : [],
    runsToday: num(st.runsToday),
    maxRunsPerDay: num(g.maxRunsPerDay, 10),
    sortAt: num(a.updatedAt, num(a.createdAt)),
  };
}

/**
 * @param {{now:number, tz?:string, items:object[], paused:boolean, hostOnline:boolean}} input
 * @returns {{ rows:object[], groups:{active:object[], paused:object[]}, counts:{total:number, paused:number, attention:number} }}
 */
export function buildAutomations(input) {
  const inp = input || {};
  const rows = (inp.items || []).filter((x) => x && x.id).map(autoRow);
  const active = rows.filter((r) => r.group === "active").sort((a, b) =>
    (Number(b.attention) - Number(a.attention))
    || (a.nextRunAt == null ? (b.nextRunAt == null ? 0 : 1) : b.nextRunAt == null ? -1 : a.nextRunAt - b.nextRunAt)
    || cp(a.name, b.name) || cp(String(a.id), String(b.id)));
  const paused = rows.filter((r) => r.group === "paused").sort((a, b) =>
    (b.sortAt - a.sortAt) || cp(a.name, b.name) || cp(String(a.id), String(b.id)));
  const all = [...active, ...paused];
  return {
    rows: all,
    groups: { active, paused },
    counts: { total: all.length, paused: paused.length, attention: all.filter((r) => r.attention).length },
  };
}

/** 픽스처 대조용 요약(auto-*.json 의 expect 모양) — 앱도 같은 모양을 만든다. */
export function summarizeAuto(out) {
  return {
    rows: out.rows.map((r) => ({ id: r.id, group: r.group, dot: r.dot, attention: r.attention, triggerKey: r.triggerKey })),
    counts: { ...out.counts },
  };
}

// ── 한 줄 지시 플랜 카드(automation-design §3.3·§3.4) — 순수 판정 ─────────────────────────────
export const PLAN_AGENTS = ["claude", "codex", "gemini"];
export const PLAN_MAX_RUNS = 4;           // TASK_LIMIT 과 같다(§3.3 "합계 run ≤ 4")
export const PLAN_PROMPT_MAX_BYTES = 30000;
const utf8Len = (s) => new TextEncoder().encode(String(s || "")).length;

/** Plan(§3.3) → 카드가 고칠 수 있는 사본. 자동화 항목은 기본 포함(§3.4), 질문은 ≤ 3. */
export function normalizePlan(p) {
  const plan = p || {};
  const tasks = (plan.tasks || []).map((t, i) => ({
    key: `t${i}`, host: Number(t.host), workspaceId: t.workspaceId || null, repo: t.repo || "", subdir: t.subdir || "",
    base: t.base || "", title: t.title || "", prompt: t.prompt || "", why: t.why || "",
    agents: Object.fromEntries((t.agents || []).filter((a) => a && PLAN_AGENTS.includes(a.id)).map((a) => [a.id, Math.max(1, Number(a.count) || 1)])),
  }));
  const automations = (plan.automations || []).map((a, i) => ({ key: `a${i}`, host: Number(a.host), draft: a.draft || {}, why: a.why || "", include: true }));
  return { ...plan, tasks, automations, questions: (plan.questions || []).slice(0, 3) };
}

export function planRunTotal(plan) {
  return plan ? plan.tasks.reduce((n, t) => n + Object.values(t.agents).reduce((a, b) => a + b, 0), 0) : 0;
}

/** [시작] 가능 여부 — 저장소 미정(workspaceId:null)·에이전트 0·빈 프롬프트·상한 초과면 불가(§3.4). */
export function planStartable(plan) {
  if (!plan) return false;
  const autos = plan.automations.filter((a) => a.include);
  if (!plan.tasks.length && !autos.length) return false;
  if (planRunTotal(plan) > PLAN_MAX_RUNS) return false;
  return plan.tasks.every((t) => t.workspaceId && Object.keys(t.agents).length && t.prompt.trim() && utf8Len(t.prompt) <= PLAN_PROMPT_MAX_BYTES);
}

/** 폴백 사유 → 문구 필드(§3.4). 모르는 사유는 fallbackFailed. 폴백이 아니면 null. */
export function fallbackKey(planner) {
  if (!planner || planner.mode !== "fallback") return null;
  return { PLANNER_UNAVAILABLE: "fallbackNoAgent", PLANNER_TIMEOUT: "fallbackTimeout" }[planner.fallbackReason] || "fallbackFailed";
}

/** 플래너 PC(§3.1 3) — 활성 PC 가 대상 목록에 있으면 그것, 아니면 첫 PC. */
export function pickPlannerHost(hosts, activeId) {
  const hs = (hosts || []).map(Number);
  if (!hs.length) return null;
  return hs.includes(Number(activeId)) ? Number(activeId) : hs[0];
}

// ── PC 깨어 있기 상태 줄(§6.6) — 순수: 문구 필드와 변수만 돌려준다(화면이 at()/errText 로 그린다) ──────
/** @returns {{key:string, vars?:object, code?:string, kind:''|'err'}[]} */
export function powerStatusKeys(st) {
  const s = st || {};
  const out = [];
  if (s.active) {
    const reasons = Array.isArray(s.reasons) ? s.reasons : [];
    const n = reasons.filter((r) => /^task:/.test(String(r))).length || reasons.length;
    out.push({ key: "awakeStatus", vars: { n }, kind: "" });
  } else {
    out.push({ key: "asleepAllowed", kind: "" });
  }
  if (s.setup === "pending") out.push({ key: "setupPending", kind: "" });
  if (s.lidClosed && s.lidBlocked === "battery") out.push({ key: "onBattery", kind: "" });
  if (s.lidClosed && s.lidBlocked === "sudo") out.push({ code: "POWER_SUDO_MISSING", kind: "err" });
  if (s.setup === "failed" && s.setupError) out.push({ code: String(s.setupError.code || s.setupError), kind: "err" });
  return out;
}
