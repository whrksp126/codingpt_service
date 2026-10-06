/**
 * orch.js — 오케스트레이션(에이전트가 다른 에이전트를 부리는 조율 계층). 설계 정본: docs/orchestration-design.md
 *
 * 한 줄 요약: "코디네이터 에이전트가 묶음(Run)을 만들고 → 일(Task)마다 워커를 띄우고(Dispatch) → 워커는
 *  결과·질문·진행을 메시지로 보내고 → 코디네이터는 수신함을 기다렸다가 답하고 정리한다."
 *
 * 세 층:
 *  · Run      — 조율 한 묶음 + 코디네이터 수신함. 일정을 잡지 않는다(이름표와 우편함).
 *  · Task     — 할 일 하나(명세·의존 관계·결과).
 *  · Dispatch — 그 일의 시도 1회(워커 터미널 1개). 재시도는 새 Dispatch 다.
 *
 * 누가 부르는가: 호출자는 **터미널 좌표(tsession)** 로 식별한다 — 워커는 자기 Dispatch, 코디네이터는 자기 Run.
 *  사람(PC·폰 화면)은 좌표 없이 부른다(via='local'|'relay') → 답하기·멈추기·닫기만.
 *
 * 경계: 터미널·에이전트 실행·입력·알림·worktree 작업은 전부 주입(configure)이다. 여기서 tmux/git 을 직접
 *  만지지 않는다 — cpt-server.wireOrch() 가 실제 구현을 넣고 테스트는 스텁을 넣는다.
 *
 * 절대 규칙:
 *  · 명세·본문은 이벤트(orch.changed)에 싣지 않는다 — 식별자만. 내용은 orch.list(RPC)로 가져간다.
 *  · 없음(침묵·타임아웃)은 증거가 아니다 — 멈춤·포기·정리는 종료가 **확인된** 뒤에만 스스로 한다.
 *  · 상한(중첩 깊이·동시 워커 수)은 금지가 아니라 폭주 방지다 — daemon.json `orch` 로 바꿀 수 있다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');
const jsonStore = require('./json-store');

// ── 상수 ─────────────────────────────────────────────────────────────────────
const STORE_V = 1;
const SPEC_MAX_BYTES = 24000;
const BODY_MAX = 8000;
const SUBJECT_MAX = 200;
const OBJECTIVE_MAX = 2000;
const COMMENT_MAX = 200;
const DELIVERY_BATCH = 50;
const MESSAGES_PER_RUN_MAX = 600;
const CLOSED_KEEP_MS = 7 * 24 * 3600 * 1000;
const HEARTBEAT_MIN = 5;
const HEARTBEAT_STALE_MS = 12 * 60 * 1000;
const WAIT_DEFAULT_MS = 100000;   // 100초 — 에이전트 셸 도구의 **기본** 제한 시간(2분) 안쪽. 더 길게는 --timeout-ms 로(상한 1시간)
const WAIT_MAX_MS = 3600000;
const NUDGE_MIN_MS = 20000;
const REPORT_NUDGE_MAX = 2;
const MESSAGE_TYPES = ['status', 'worker_done', 'escalation', 'question', 'reply', 'decision_gate', 'handoff'];
const WORKER_ONLY_TYPES = new Set(['worker_done', 'escalation']);
const ACTIVE_DISPATCH = new Set(['starting', 'ready']);
const SETTLED_DISPATCH = new Set(['succeeded', 'failed', 'stopped', 'abandoned']);
const WS_STATUSES = ['todo', 'in-progress', 'in-review', 'completed'];
const DEFAULT_LIMITS = { maxDepth: 2, maxWorkersPerRun: 6, maxWorkers: 12 };
const ERROR_CODES = [
  'BAD_PARAMS', 'ORCH_DISABLED', 'NOT_IN_TERMINAL', 'NO_RUN', 'RUN_NOT_FOUND', 'RUN_CLOSED',
  'TASK_NOT_FOUND', 'TASK_NOT_READY', 'DISPATCH_NOT_FOUND', 'DISPATCH_INACTIVE', 'DISPATCH_ACTIVE', 'NOT_YOUR_DISPATCH',
  'DEPTH_EXCEEDED', 'WORKER_LIMIT', 'AGENT_UNSUPPORTED', 'WORKER_START_FAILED', 'TERMINAL_NOT_REUSABLE',
  'MESSAGE_NOT_FOUND', 'DELIVERY_NOT_FOUND', 'GATE_NOT_FOUND', 'NOT_LIVE_PROOF', 'SPEC_TOO_LARGE', 'MERGE_FAILED',
];

function codedError(code, message, extra) {
  return Object.assign(new Error(message || code), { code }, extra || {});
}

// ── 주입 ─────────────────────────────────────────────────────────────────────
const noop = () => {};
let inj = {
  notify: noop,           // ({runIds, reason}) → 화면 갱신 신호(식별자만)
  createTerminal: null,   // ({cwd, name}) → {tid, tsession}
  closeTerminal: null,    // ({cwd, tid}) → void
  launch: null,           // ({cwd, index, id, args?, fresh?, timeoutMs}) → {ok, busy?}
  chatInput: null,        // ({cwd, tid, text, submit})
  keys: null,             // ({cwd, tid, keys})
  read: null,             // ({cwd, tid, lines}) → 화면 문자열
  probe: null,            // ({tsession}) → {exists, shell, agentState, attached} | null(모름)
  shellOf: null,          // ({tsession}) → 전경 명령 이름(프롬프트 치환 문법 판정)
  agents: null,           // agents.js (CATALOG·list)
  agentModels: null,      // agent-models.js (launchArgs·valid)
  agentState: null,       // agent-state.js (subscribe)
  tasks: null,            // tasks.js (internalCreate·rpc·findRunByTsession)
  backFetch: null,        // (method, apiPath, body)
  config: () => ({}),     // daemon.json 의 orch 블록
  now: () => Date.now(),
  log: (m) => console.log(m),
};
let timings = { tickMs: 5000, launchTimeoutMs: 12000, readyTimeoutMs: 30000, readyPollMs: 400, reportNudgeMs: 6000 };

function configure(opts = {}) {
  for (const k of Object.keys(inj)) {
    if (opts[k] === undefined) continue;
    inj[k] = opts[k];
  }
  if (typeof inj.notify !== 'function') inj.notify = noop;
  if (typeof inj.now !== 'function') inj.now = () => Date.now();
  if (typeof inj.log !== 'function') inj.log = noop;
  if (typeof inj.config !== 'function') inj.config = () => ({});
  if (opts.timings && typeof opts.timings === 'object') timings = { ...timings, ...opts.timings };
  return module.exports;
}
const nowFn = () => inj.now();
const log = (m) => { try { inj.log(m); } catch (_) { /* noop */ } };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function limits() {
  let c = {};
  try { c = inj.config() || {}; } catch (_) { c = {}; }
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    if (Number.isInteger(c[k]) && c[k] >= 1 && c[k] <= 50) out[k] = c[k];
  }
  return out;
}
function enabled() { return process.env.CPT_ORCH !== '0'; }

// ── 스토어 ───────────────────────────────────────────────────────────────────
function orchDir() { return path.join(runtime.stateDir(), 'orch'); }
function storeFile() { return path.join(runtime.stateDir(), 'orch.json'); }
function promptFile(dispatchId) { return path.join(orchDir(), `${dispatchId}.prompt`); }
function emptyStore() {
  return { v: STORE_V, seq: 0, runs: [], tasks: [], dispatches: [], messages: [], deliveries: [], gates: [], notes: {} };
}
let mem = null;
function load() {
  if (mem) return mem;
  mem = jsonStore.readJson(storeFile(), {
    fallback: emptyStore,
    validate: (v) => v && v.v === STORE_V && Array.isArray(v.runs) && Array.isArray(v.dispatches),
    onError: (e) => log(`[orch] 스토어를 읽지 못해 비웁니다: ${e && e.message}`),
  });
  for (const k of ['tasks', 'messages', 'deliveries', 'gates']) if (!Array.isArray(mem[k])) mem[k] = [];
  if (!mem.notes || typeof mem.notes !== 'object') mem.notes = {};
  return mem;
}
function save() {
  try { jsonStore.writeJsonAtomic(storeFile(), load()); } catch (e) { log(`[orch] 저장 실패: ${e && e.message}`); }
}
function rid(prefix) { return `${prefix}_${crypto.randomBytes(5).toString('hex')}`; }
function emit(runIds, reason) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : [runIds]).filter(Boolean))];
  try { inj.notify({ runIds: ids, reason }); } catch (_) { /* noop */ }
}

const findRun = (id) => load().runs.find((r) => r.id === id) || null;
const findTask = (id) => load().tasks.find((t) => t.id === id) || null;
const findDispatch = (id) => load().dispatches.find((d) => d.id === id) || null;
const dispatchesOf = (runId) => load().dispatches.filter((d) => d.runId === runId);
const tasksOf = (runId) => load().tasks.filter((t) => t.runId === runId);
const runMailbox = (runId) => `run:${runId}`;
const dispatchMailbox = (id) => `dispatch:${id}`;

function titleOf(spec) {
  const line = String(spec || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 80);
}
function str(v, max, name, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw codedError('BAD_PARAMS', `${name} 이(가) 필요합니다`);
    return null;
  }
  if (typeof v !== 'string') throw codedError('BAD_PARAMS', `${name} 이(가) 올바르지 않습니다`);
  return v.length > max ? v.slice(0, max) : v;
}

// ── 호출자 식별 ──────────────────────────────────────────────────────────────
//  meta = { via:'cli'|'local'|'relay', tsession, cwd, tid, onClose(fn) }
//  워커 판정이 코디네이터 판정보다 먼저다 — 워커가 하위 묶음을 만들면 둘 다이기 때문(중첩).
function workerDispatchOf(tsession, { activeOnly = false } = {}) {
  if (!tsession) return null;
  const all = load().dispatches.filter((d) => d.worker && d.worker.tsession === tsession);
  const act = all.filter((d) => ACTIVE_DISPATCH.has(d.state));
  if (act.length) return act[act.length - 1];
  return activeOnly ? null : (all[all.length - 1] || null);
}
function coordinatorRunsOf(tsession) {
  if (!tsession) return [];
  return load().runs.filter((r) => r.state === 'active' && r.coordinator && r.coordinator.tsession === tsession);
}
function callerOf(meta) {
  const m = meta || {};
  if (m.via !== 'cli') return { kind: 'user', meta: m };
  if (!m.tsession) throw codedError('NOT_IN_TERMINAL', '오케스트레이션은 CodingPT 터미널 안에서만 쓸 수 있습니다');
  resolveWorktreeSessions();
  return { kind: 'agent', meta: m, dispatch: workerDispatchOf(m.tsession), runs: coordinatorRunsOf(m.tsession) };
}
function depthOf(caller) {
  if (caller.kind !== 'agent' || !caller.dispatch || !ACTIVE_DISPATCH.has(caller.dispatch.state)) return 0;
  const run = findRun(caller.dispatch.runId);
  return run ? run.depth + 1 : 1;
}
/** 호출자가 다루는 묶음 — 명시(--run) > 자기가 코디네이터인 가장 최근 묶음. */
function boundRun(caller, p, { mustActive = true } = {}) {
  let run = null;
  if (p && p.run) {
    run = findRun(String(p.run));
    if (!run) throw codedError('RUN_NOT_FOUND', '묶음을 찾을 수 없습니다');
  } else if (caller.kind === 'agent' && caller.runs.length) {
    run = caller.runs[caller.runs.length - 1];
  }
  if (!run) throw codedError('NO_RUN', '묶음이 없습니다 — 먼저 `cpt orch run-create --objective "…"` 로 만드세요');
  if (mustActive && run.state !== 'active') throw codedError('RUN_CLOSED', '닫힌 묶음입니다');
  return run;
}
function mustDispatch(id) {
  const d = findDispatch(String(id || ''));
  if (!d) throw codedError('DISPATCH_NOT_FOUND', '시도를 찾을 수 없습니다');
  return d;
}
/** 워커 자신의 생애 메시지 — 좌표가 그 Dispatch 의 워커와 같고, 넘긴 ID 가 일치해야 한다(지난 시도의 늦은 보고 차단). */
function ownDispatch(caller, p) {
  if (caller.kind !== 'agent') throw codedError('NOT_YOUR_DISPATCH', '워커 터미널에서만 보낼 수 있습니다');
  const want = p && (p.dispatch || p.dispatchId) ? String(p.dispatch || p.dispatchId) : null;
  const all = load().dispatches.filter((d) => d.worker && d.worker.tsession === caller.meta.tsession);
  const d = want ? all.find((x) => x.id === want) : workerDispatchOf(caller.meta.tsession);
  if (!d) throw codedError('NOT_YOUR_DISPATCH', want ? '이 터미널의 시도가 아닙니다' : '이 터미널은 워커가 아닙니다');
  return d;
}

// ── 메시지·수신함 ────────────────────────────────────────────────────────────
const waiters = new Map();   // mailbox → Set<{types, resolve}>
const questionWaiters = new Map(); // messageId → Set<resolve>
const lastNudge = new Map(); // mailbox → ms

function addMessage(m) {
  const s = load();
  s.seq += 1;
  const msg = {
    id: rid('m'), seq: s.seq, runId: m.runId, type: m.type, to: m.to,
    from: m.from, subject: m.subject || '', body: m.body || '',
    taskId: m.taskId || null, dispatchId: m.dispatchId || null,
    priority: m.priority || 'normal', payload: m.payload || null,
    createdAt: nowFn(), acked: false,
  };
  s.messages.push(msg);
  const mine = s.messages.filter((x) => x.runId === m.runId);
  if (mine.length > MESSAGES_PER_RUN_MAX) {
    const drop = new Set(mine.filter((x) => x.acked).slice(0, mine.length - MESSAGES_PER_RUN_MAX).map((x) => x.id));
    if (drop.size) s.messages = s.messages.filter((x) => !drop.has(x.id));
  }
  save();
  wake(msg);
  return msg;
}
function unreadOf(mailbox) {
  return load().messages.filter((m) => m.to === mailbox && !m.acked).sort((a, b) => a.seq - b.seq);
}
function wake(msg) {
  const set = waiters.get(msg.to);
  let woke = false;
  if (set) {
    for (const w of [...set]) {
      if (w.types && !w.types.has(msg.type)) continue;
      set.delete(w);
      woke = true;
      try { w.resolve('message'); } catch (_) { /* noop */ }
    }
  }
  if (!woke) nudge(msg.to, msg).catch(() => {});
}
function pickMsg(m) {
  return {
    id: m.id, seq: m.seq, type: m.type, from: m.from, subject: m.subject, body: m.body,
    taskId: m.taskId, dispatchId: m.dispatchId, priority: m.priority, payload: m.payload, createdAt: m.createdAt,
  };
}
/** 수신함 주인의 터미널 좌표 — 깨우기(화면에 한 줄 넣기)에 쓴다. */
function mailboxOwner(mailbox) {
  if (mailbox.startsWith('run:')) {
    const run = findRun(mailbox.slice(4));
    return run && run.coordinator && run.coordinator.tsession ? run.coordinator : null;
  }
  const d = findDispatch(mailbox.slice('dispatch:'.length));
  return d && d.worker && d.worker.tsession && d.worker.tid != null ? d.worker : null;
}
/**
 * 깨우기 — 받는 쪽이 `check --wait` 로 기다리고 있지 않으면, 그 에이전트가 **한가할 때만** 입력창에 한 줄을 넣는다.
 *  일하는 중이면 넣지 않는다(쓰던 입력과 섞인다) — 다음 체크포인트의 `cpt orch check` 가 가져간다.
 *  넣는 것은 주의를 끄는 것일 뿐, 읽었다는 증거가 아니다.
 */
async function nudge(mailbox, msg) {
  if (!inj.chatInput || !inj.probe) return false;
  const owner = mailboxOwner(mailbox);
  if (!owner) return false;
  const last = lastNudge.get(mailbox) || 0;
  if (nowFn() - last < NUDGE_MIN_MS) return false;
  let pr = null;
  try { pr = await inj.probe({ tsession: owner.tsession }); } catch (_) { pr = null; }
  if (!pr || !pr.exists || pr.shell !== false || pr.agentState !== 'idle') return false;
  lastNudge.set(mailbox, nowFn());
  const what = msg.type === 'worker_done' ? '워커가 결과를 보냈습니다'
    : msg.type === 'question' ? '워커가 질문했습니다'
      : msg.type === 'escalation' ? '워커가 막혔다고 알렸습니다'
        : msg.type === 'reply' ? '질문에 답이 왔습니다'
          : msg.type === 'decision_gate' ? '결정이 내려졌습니다' : '새 메시지가 왔습니다';
  const text = `[오케스트레이션] ${what}. \`cpt orch check --json\` 으로 확인하세요.`;
  try { await inj.chatInput({ cwd: owner.cwd, tid: owner.tid, text, submit: true }); return true; } catch (_) { return false; }
}

// ── DAG ──────────────────────────────────────────────────────────────────────
function advanceDag(runId) {
  const ts = tasksOf(runId);
  const by = new Map(ts.map((t) => [t.id, t]));
  let changed = false;
  for (const t of ts) {
    if (t.status !== 'pending' && t.status !== 'blocked') continue;
    if (t.gateId) { const g = load().gates.find((x) => x.id === t.gateId); if (g && g.status === 'pending') continue; }
    const deps = (t.deps || []).map((id) => by.get(id)).filter(Boolean);
    const next = deps.some((d) => d.status === 'failed' || d.status === 'blocked') ? 'blocked'
      : deps.every((d) => d.status === 'completed') ? 'ready' : 'pending';
    if (next !== t.status) { t.status = next; t.updatedAt = nowFn(); changed = true; }
  }
  return changed;
}

// ── 워커 관찰 ────────────────────────────────────────────────────────────────
const probeCache = new Map();   // dispatchId → {at, liveness, reason, agentState}
/**
 * 생존 판정 — live(에이전트가 터미널에 있다) / exited(터미널이 없거나 셸로 돌아왔다) / unverifiable(모른다).
 *  ★ unverifiable 은 "죽었다" 가 아니다. 이걸 근거로 멈추거나 다시 띄우지 않는다.
 */
async function livenessOf(d) {
  const w = d.worker || {};
  if (!w.tsession) return { liveness: 'unverifiable', reason: d.state === 'starting' ? 'starting' : 'no_terminal', agentState: null };
  if (!inj.probe) return { liveness: 'unverifiable', reason: 'no_probe', agentState: null };
  let pr = null;
  try { pr = await inj.probe({ tsession: w.tsession }); } catch (_) { pr = null; }
  if (!pr) return { liveness: 'unverifiable', reason: 'probe_failed', agentState: null };
  if (pr.exists === false) return { liveness: 'exited', reason: 'terminal_gone', agentState: null };
  if (pr.shell === true && w.launchedAt && nowFn() - w.launchedAt > 8000) return { liveness: 'exited', reason: 'agent_exited', agentState: null };
  if (pr.shell === false) return { liveness: 'live', reason: null, agentState: pr.agentState || null };
  return { liveness: 'unverifiable', reason: 'unknown_foreground', agentState: pr.agentState || null };
}
async function observe(d) {
  const o = await livenessOf(d);
  probeCache.set(d.id, { at: nowFn(), ...o });
  return o;
}
function pendingQuestionOf(d) {
  return load().messages.find((m) => m.type === 'question' && m.dispatchId === d.id && m.payload && m.payload.status === 'pending') || null;
}
function workerUiState(d, obs) {
  if (d.state === 'starting') return 'starting';
  if (SETTLED_DISPATCH.has(d.state)) return d.state;
  if (pendingQuestionOf(d)) return 'asking';
  if (d.escalatedAt && !d.escalationSeenAt) return 'blocked';
  if (obs && obs.liveness === 'exited') return 'exited';
  if (obs && (obs.agentState === 'permission' || obs.agentState === 'needsInput')) return 'needs_input';
  if (obs && obs.agentState === 'idle' && d.idleSince && nowFn() - d.idleSince > timings.reportNudgeMs) return 'idle_no_report';
  return 'working';
}
function attentionOf(d, obs) {
  const cats = [];
  if (ACTIVE_DISPATCH.has(d.state)) {
    if (pendingQuestionOf(d)) cats.push('question_pending');
    if (d.escalatedAt && !d.escalationSeenAt) cats.push('escalated');
    if (obs.liveness === 'exited') cats.push('exited_without_report');
    else if (obs.agentState === 'permission' || obs.agentState === 'needsInput') cats.push('needs_user_input');
    else if (obs.agentState === 'idle' && d.idleSince && nowFn() - d.idleSince > timings.reportNudgeMs) cats.push('idle_without_report');
    const hb = d.heartbeatAt || (d.worker && d.worker.launchedAt) || d.createdAt;
    if (obs.liveness !== 'exited' && nowFn() - hb > HEARTBEAT_STALE_MS) cats.push('stale_heartbeat');
  } else if (d.terminal === 'owned') cats.push('settled_unreleased');
  return cats;
}
function nextActionOf(d, cats) {
  const a = (...argv) => ({ argv: ['cpt', 'orch', ...argv] });
  if (cats.includes('question_pending')) { const q = pendingQuestionOf(d); return a('reply', '--id', q.id, '--body', '<답>'); }
  if (cats.includes('exited_without_report')) return a('worker-abandon', '--dispatch', d.id);
  if (cats.includes('settled_unreleased')) return a('worker-release', '--dispatch', d.id);
  if (cats.includes('idle_without_report') || cats.includes('stale_heartbeat')) return a('worker-read', '--dispatch', d.id);
  if (cats.includes('escalated')) return a('check');
  return { argv: null, reason: ACTIVE_DISPATCH.has(d.state) ? 'keep_waiting' : 'none' };
}
async function projectWorker(d, { brief = false } = {}) {
  const obs = ACTIVE_DISPATCH.has(d.state) ? await observe(d) : { liveness: d.terminal === 'owned' || d.terminal === 'retained' ? 'unverifiable' : 'exited', reason: 'settled', agentState: null };
  const t = findTask(d.taskId);
  const cats = attentionOf(d, obs);
  const q = pendingQuestionOf(d);
  const w = d.worker || {};
  return {
    dispatchId: d.id, taskId: d.taskId, runId: d.runId, title: t ? t.title : '', state: d.state,
    uiState: workerUiState(d, obs), agent: w.agent || null, model: w.model || null, effort: w.effort || null,
    placement: w.placement || 'current', cwd: w.cwd || null, tid: w.tid == null ? null : w.tid, tsession: w.tsession || null,
    branch: w.branch || null, taskRef: w.taskRef || null,
    phase: d.phase || null, heartbeatAt: d.heartbeatAt || null, createdAt: d.createdAt, updatedAt: d.updatedAt,
    retryOf: d.retryOf || null, terminal: d.terminal,
    liveness: obs.liveness, livenessReason: obs.reason, agentState: obs.agentState,
    attention: { categories: cats, requiresAction: cats.length > 0 },
    nextAction: nextActionOf(d, cats),
    question: q ? { id: q.id, text: q.body, options: (q.payload && q.payload.options) || [], at: q.createdAt } : null,
    result: d.result ? (brief ? { outcome: d.result.outcome } : d.result) : null,
    error: d.error || null,
  };
}

// 작업(worktree) 워커는 터미널이 나중에 생긴다 — 좌표를 뒤늦게 채운다.
function resolveWorktreeSessions() {
  if (!inj.tasks || typeof inj.tasks.pickTask !== 'function') return false;
  let changed = false;
  for (const d of load().dispatches) {
    const w = d.worker;
    if (!w || w.placement !== 'worktree' || !w.taskRef || w.tsession) continue;
    let t = null;
    try { t = inj.tasks._internals.load().items.find((x) => x.id === w.taskRef.taskId) || null; } catch (_) { t = null; }
    const r = t && t.runs && t.runs[0];
    if (!r) continue;
    if (r.tsession) { w.tsession = r.tsession; w.tid = r.tid; w.cwd = r.cwd; w.branch = r.branch; w.taskRef.runId = r.id; changed = true; }
    if (r.state === 'failed' && ACTIVE_DISPATCH.has(d.state)) {
      d.state = 'failed'; d.error = { code: 'WORKER_START_FAILED', message: (r.error && r.error.message) || '작업을 만들지 못했습니다' };
      d.terminal = 'none'; d.updatedAt = nowFn(); changed = true;
      const task = findTask(d.taskId);
      if (task) { task.status = 'failed'; task.updatedAt = nowFn(); }
      addMessage({ runId: d.runId, to: runMailbox(d.runId), type: 'worker_done', from: { kind: 'system' }, subject: '워커 시작 실패',
        body: d.error.message, taskId: d.taskId, dispatchId: d.id, payload: { outcome: 'failed', system: true } });
    } else if (r.state !== 'creating' && r.state !== 'launching' && d.state === 'starting') { d.state = 'ready'; w.launchedAt = w.launchedAt || nowFn(); d.updatedAt = nowFn(); changed = true; }
  }
  if (changed) save();
  return changed;
}

// ── 머리말(워커에게 주는 계약) ───────────────────────────────────────────────
function buildPreamble({ task, dispatch, run, placement, canDispatch }) {
  const D = dispatch.id;
  const lines = [
    '당신은 CodingPT 오케스트레이션의 **워커**입니다. 다른 터미널의 코디네이터 에이전트가 이 일을 맡겼습니다.',
    `작업 ID: ${task.id} · 시도 ID: ${D}`,
    '',
    '코디네이터는 이 터미널 화면을 보지 않습니다. 결과와 질문은 아래 명령으로 보낸 것만 전달됩니다.',
    '(이 안내는 CodingPT 가 붙인 것입니다 — 사용자가 코디네이터에게 조율을 맡겼기 때문에 붙습니다.)',
    '',
    '```sh',
    '# 끝나면 정확히 한 번 보고합니다(필수). 요약은 세 문장: 한 일 / 알아낸 것 / 남은 것.',
    '# 요청한 일을 다 못 했으면 --outcome failed 로 보냅니다. 실패를 문장 속에만 적지 마세요.',
    `cpt orch done --dispatch ${D} --outcome succeeded --summary "<세 문장 요약>"`,
    '#   바꾼 파일이 있으면 --files "a.js,b.js", 보고서를 남겼으면 --report <경로> 를 덧붙입니다(실제 값만).',
    '',
    '# 코디네이터에게 묻고 답을 기다립니다. 사용자에게 묻는 화면(AskUserQuestion)은 쓰지 마세요 —',
    '# 코디네이터가 볼 수도 답할 수도 없어서 일이 멈춥니다.',
    `cpt orch ask --dispatch ${D} --question "<질문>" --options "<선택지1>,<선택지2>"`,
    '#   기본 100초를 기다립니다. 답이 안 오면 같은 질문을 이어서 기다립니다: cpt orch ask --resume <messageId>',
    '',
    `# 일하는 동안 ${HEARTBEAT_MIN}분마다 진행 상황을 알립니다(ask·check --wait 로 기다리는 중에는 생략).`,
    `cpt orch heartbeat --dispatch ${D} --phase "<조사 중|구현 중|검증 중 …>"`,
    '',
    '# 코디네이터가 보낸 추가 지시를 확인합니다 — 새 파일을 시작하기 전, 테스트를 돌린 뒤, 그리고 done 직전에.',
    'cpt orch check --json',
    '',
    '# 혼자 풀 수 없게 막혔을 때만(끝내기 전에).',
    `cpt orch escalate --dispatch ${D} --subject "막힘: <이유>" --body "<자세히>"`,
    '```',
    '',
    '`done` 을 보낸 뒤에는 이 턴을 끝내고 기다리세요. 새 일을 시작하거나 터미널을 닫지 마세요.',
  ];
  if (placement === 'worktree') {
    lines.push('', '작업 폴더는 이 일 전용 git worktree(전용 브랜치)입니다. 변경은 이 브랜치에 **커밋**해 두세요 — 코디네이터가 머지합니다. base 브랜치로 직접 머지하거나 worktree 를 지우지 마세요.');
  } else {
    lines.push('', '작업 폴더는 코디네이터·다른 워커와 **같은 폴더**입니다. 맡은 범위의 파일만 고치세요. git 커밋·스태시·체크아웃·리셋은 하지 마세요(코디네이터가 합니다).');
  }
  if (canDispatch) lines.push('', '이 일을 더 쪼개야 하면 직접 하위 워커를 띄울 수 있습니다: `cpt skills get cpt-orch` 참고.');
  if (run && run.objective) lines.push('', `전체 목표(참고): ${String(run.objective).slice(0, 400)}`);
  lines.push('', '=== 맡은 일 ===', '', task.spec);
  return lines.join('\n');
}

function promptArgs(agentId, file, shellCmd, dash) {
  const cat = (inj.agents && inj.agents.CATALOG) || [];
  const spec = cat.find((c) => c.id === agentId);
  const pa = spec && spec.promptArg;
  if (!pa || /['\n\r]/.test(file)) return null;
  if (dash && !pa.positional) return null;
  const fish = /(^|\/)-?fish$/.test(String(shellCmd || ''));
  const sub = fish ? `(cat '${file}' | string collect)` : `"$(cat '${file}')"`;
  if (pa.positional) return dash ? ['--', sub] : [sub];
  return [pa.flag, sub];
}
async function waitAgentLive(tsession, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stable = null;
  for (;;) {
    let pr = null;
    try { pr = inj.probe ? await inj.probe({ tsession }) : null; } catch (_) { pr = null; }
    if (pr && pr.exists && pr.shell === false && pr.attached) {
      if (stable == null) stable = Date.now();
      if (Date.now() - stable >= 1500) return true;
    } else stable = null;
    if (Date.now() >= deadline) return false;
    await sleep(timings.readyPollMs);
  }
}

// ── RPC: 묶음 ────────────────────────────────────────────────────────────────
function pickRun(run) {
  const ds = dispatchesOf(run.id);
  return {
    id: run.id, objective: run.objective, state: run.state, depth: run.depth, parentDispatchId: run.parentDispatchId || null,
    cwd: run.cwd, coordinator: run.coordinator ? { cwd: run.coordinator.cwd, tid: run.coordinator.tid, tsession: run.coordinator.tsession, agent: run.coordinator.agent || null } : null,
    createdAt: run.createdAt, updatedAt: run.updatedAt, closedAt: run.closedAt || null,
    counts: { tasks: tasksOf(run.id).length, active: ds.filter((d) => ACTIVE_DISPATCH.has(d.state)).length, succeeded: ds.filter((d) => d.state === 'succeeded').length, failed: ds.filter((d) => d.state === 'failed').length },
  };
}
function rpcStatus(p, caller) {
  const d = caller.kind === 'agent' ? caller.dispatch : null;
  const active = d && ACTIVE_DISPATCH.has(d.state) ? d : null;
  return {
    enabled: true, limits: limits(),
    caller: caller.kind === 'agent' ? {
      tsession: caller.meta.tsession, tid: caller.meta.tid == null ? null : caller.meta.tid, cwd: caller.meta.cwd,
      role: active ? (caller.runs.length ? 'worker+coordinator' : 'worker') : (caller.runs.length ? 'coordinator' : 'none'),
      depth: depthOf(caller),
      dispatch: active ? { dispatchId: active.id, taskId: active.taskId, runId: active.runId } : null,
      runs: caller.runs.map((r) => r.id),
    } : { role: 'user' },
  };
}
function rpcRunCreate(p, caller) {
  if (caller.kind !== 'agent') throw codedError('NOT_IN_TERMINAL', '묶음은 CodingPT 터미널 안의 에이전트가 만듭니다');
  const objective = str(p.objective, OBJECTIVE_MAX, 'objective', { required: true });
  const depth = depthOf(caller);
  const lim = limits();
  if (depth >= lim.maxDepth) throw codedError('DEPTH_EXCEEDED', `여기서는 하위 묶음을 만들 수 없습니다(중첩 ${lim.maxDepth}단계까지)`);
  const active = caller.dispatch && ACTIVE_DISPATCH.has(caller.dispatch.state) ? caller.dispatch : null;
  const run = {
    id: rid('run'), objective, state: 'active', depth, parentDispatchId: active ? active.id : null,
    cwd: caller.meta.cwd || '',
    coordinator: { tsession: caller.meta.tsession, tid: caller.meta.tid == null ? null : caller.meta.tid, cwd: caller.meta.cwd || '', agent: caller.meta.agent || null },
    createdAt: nowFn(), updatedAt: nowFn(), settledNotifiedAt: 0,
  };
  load().runs.push(run);
  save();
  emit(run.id, 'run');
  ensureTick();
  return { run: pickRun(run) };
}
function rpcRunList(p) {
  const all = load().runs.filter((r) => p.all || r.state === 'active');
  return { runs: all.map(pickRun) };
}
async function rpcRunShow(p, caller) {
  const run = boundRun(caller, p, { mustActive: false });
  const workers = [];
  for (const d of dispatchesOf(run.id)) workers.push(await projectWorker(d));
  return { run: pickRun(run), tasks: tasksOf(run.id).map(pickTask), workers, gates: load().gates.filter((g) => g.runId === run.id) };
}
async function rpcRunClose(p, caller) {
  const run = boundRun(caller, p, { mustActive: false });
  const act = dispatchesOf(run.id).filter((d) => ACTIVE_DISPATCH.has(d.state));
  if (act.length && !p.force) {
    throw codedError('DISPATCH_ACTIVE', `아직 끝나지 않은 워커가 ${act.length}개 있습니다 — 기다리거나, 멈춘 뒤(--force) 닫으세요`, { dispatches: act.map((d) => d.id) });
  }
  for (const d of act) await stopDispatch(d, { reason: 'run_closed' });
  const released = [];
  for (const d of dispatchesOf(run.id)) {
    if (d.terminal !== 'owned') continue;
    try { await releaseTerminal(d); released.push(d.id); } catch (e) { log(`[orch] ${d.id} 정리 실패: ${e && e.message}`); }
  }
  run.state = 'closed'; run.closedAt = nowFn(); run.updatedAt = nowFn();
  save();
  emit(run.id, 'run');
  return { run: pickRun(run), released };
}

// ── RPC: 일 ──────────────────────────────────────────────────────────────────
function pickTask(t, { brief = false } = {}) {
  const spec = brief ? String(t.spec).replace(/\s+/g, ' ').slice(0, 160) : t.spec;
  const ds = load().dispatches.filter((d) => d.taskId === t.id);
  const last = ds[ds.length - 1] || null;
  return {
    id: t.id, runId: t.runId, title: t.title, spec, ...(brief && String(t.spec).length > 160 ? { spec_truncated: true } : {}),
    status: t.status, deps: t.deps || [], gateId: t.gateId || null, dispatchId: last ? last.id : null,
    attempts: ds.length, result: t.result || null, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}
function createTask(run, p) {
  const spec = str(p.spec, 1e9, 'spec', { required: true });
  if (Buffer.byteLength(spec, 'utf8') > SPEC_MAX_BYTES) throw codedError('SPEC_TOO_LARGE', '명세가 너무 깁니다(24,000 바이트까지)');
  let deps = p.deps == null ? [] : p.deps;
  if (typeof deps === 'string') { try { deps = JSON.parse(deps); } catch (_) { deps = deps.split(',').map((s) => s.trim()).filter(Boolean); } }
  if (!Array.isArray(deps) || deps.some((x) => typeof x !== 'string')) throw codedError('BAD_PARAMS', 'deps 는 작업 ID 배열입니다');
  for (const id of deps) {
    const dt = findTask(id);
    if (!dt || dt.runId !== run.id) throw codedError('TASK_NOT_FOUND', `의존 작업을 찾을 수 없습니다: ${id}`);
  }
  const t = {
    id: rid('task'), runId: run.id, spec, title: str(p.title, 80, 'title') || titleOf(spec), deps,
    status: 'pending', gateId: null, result: null, createdAt: nowFn(), updatedAt: nowFn(),
  };
  load().tasks.push(t);
  advanceDag(run.id);
  run.updatedAt = nowFn();
  return t;
}
function rpcTaskCreate(p, caller) {
  const run = boundRun(caller, p);
  const t = createTask(run, p);
  save();
  emit(run.id, 'task');
  return { task: pickTask(t) };
}
function rpcTaskList(p, caller) {
  const run = boundRun(caller, p, { mustActive: false });
  let ts = tasksOf(run.id);
  if (p.ready) ts = ts.filter((t) => t.status === 'ready');
  return { runId: run.id, tasks: ts.map((t) => pickTask(t, { brief: !!p.brief })) };
}
function rpcTaskUpdate(p, caller) {
  const t = findTask(String(p.task || p.taskId || ''));
  if (!t) throw codedError('TASK_NOT_FOUND', '작업을 찾을 수 없습니다');
  const run = findRun(t.runId);
  if (p.status != null) {
    if (!['pending', 'completed', 'failed', 'blocked'].includes(p.status)) throw codedError('BAD_PARAMS', 'status 가 올바르지 않습니다');
    if (load().dispatches.some((d) => d.taskId === t.id && ACTIVE_DISPATCH.has(d.state))) throw codedError('DISPATCH_ACTIVE', '워커가 아직 이 일을 하고 있습니다');
    t.status = p.status;
  }
  if (p.spec != null) { t.spec = str(p.spec, 1e9, 'spec', { required: true }); if (!p.title) t.title = titleOf(t.spec); }
  if (p.title != null) t.title = str(p.title, 80, 'title') || t.title;
  t.updatedAt = nowFn();
  advanceDag(t.runId);
  save();
  emit(run ? run.id : null, 'task');
  return { task: pickTask(t) };
}

// ── RPC: 워커 ────────────────────────────────────────────────────────────────
function liveWorkerCount(runId) {
  const all = load().dispatches.filter((d) => ACTIVE_DISPATCH.has(d.state));
  return { run: all.filter((d) => d.runId === runId).length, all: all.length };
}
function agentSpec(id) {
  const cat = (inj.agents && inj.agents.CATALOG) || [];
  return cat.find((c) => c.id === id) || null;
}
async function rpcWorkerStart(p, caller) {
  if (caller.kind !== 'agent') throw codedError('NOT_IN_TERMINAL', '워커는 CodingPT 터미널 안의 에이전트가 띄웁니다');
  let run;
  if (!p.run && !caller.runs.length) {
    // 묶음 없이 바로 시작 — 명세 첫 줄을 목표로 묶음을 만들어 준다(한 번의 호출로 끝나게).
    run = findRun(rpcRunCreate({ objective: titleOf(p.spec || '') || '오케스트레이션' }, caller).run.id);
  } else run = boundRun(caller, p);
  const lim = limits();
  if (run.depth + 1 > lim.maxDepth) throw codedError('DEPTH_EXCEEDED', `중첩은 ${lim.maxDepth}단계까지입니다`);
  const cnt = liveWorkerCount(run.id);
  if (cnt.run >= lim.maxWorkersPerRun) throw codedError('WORKER_LIMIT', `한 묶음에서 동시에 도는 워커는 ${lim.maxWorkersPerRun}개까지입니다 — 끝난 뒤에 더 띄우세요`);
  if (cnt.all >= lim.maxWorkers) throw codedError('WORKER_LIMIT', `이 PC 에서 동시에 도는 워커는 ${lim.maxWorkers}개까지입니다`);

  let task;
  if (p.task) {
    task = findTask(String(p.task));
    if (!task || task.runId !== run.id) throw codedError('TASK_NOT_FOUND', '작업을 찾을 수 없습니다');
    if (load().dispatches.some((d) => d.taskId === task.id && ACTIVE_DISPATCH.has(d.state))) throw codedError('DISPATCH_ACTIVE', '이 일에는 이미 워커가 붙어 있습니다');
    advanceDag(run.id);
    const retry = task.status === 'failed' || p.retryOf;
    if (!retry && task.status !== 'ready' && !p.force) throw codedError('TASK_NOT_READY', `아직 시작할 수 없는 일입니다(${task.status}) — 먼저 끝나야 하는 일이 있습니다`, { deps: task.deps });
  } else task = createTask(run, p);

  const reuseTid = p.terminal != null && p.terminal !== '' ? Number(p.terminal) : null;
  const placement = reuseTid != null ? 'current' : (p.worktree === 'new' ? 'worktree' : 'current');
  if (p.worktree != null && !['current', 'new'].includes(p.worktree)) throw codedError('BAD_PARAMS', '--worktree 는 current 또는 new 입니다');
  const agent = str(p.agent, 40, 'agent') || (run.coordinator && run.coordinator.agent) || 'claude';
  const model = str(p.model, 80, 'model');
  const effort = str(p.effort, 40, 'effort');
  if (reuseTid == null) {
    const spec = agentSpec(agent);
    if (!spec) throw codedError('AGENT_UNSUPPORTED', `알 수 없는 에이전트입니다: ${agent}`);
    if (inj.agentModels && (!inj.agentModels.valid(model) || !inj.agentModels.valid(effort))) throw codedError('BAD_PARAMS', '모델 또는 추론 강도가 올바르지 않습니다');
    if (effort && !model) throw codedError('BAD_PARAMS', '--effort 는 --model 과 함께 씁니다');
  } else if (model || effort) throw codedError('BAD_PARAMS', '기존 터미널을 다시 쓸 때는 모델을 바꿀 수 없습니다');

  const d = {
    id: rid('dsp'), runId: run.id, taskId: task.id, state: 'starting', retryOf: p.retryOf ? String(p.retryOf) : null,
    worker: { agent, model, effort, placement, cwd: placement === 'current' ? run.cwd : null, tid: null, tsession: null, launchedAt: null },
    terminal: 'none', phase: null, heartbeatAt: null, result: null, error: null, reportNudges: 0, idleSince: null,
    createdAt: nowFn(), updatedAt: nowFn(),
  };
  load().dispatches.push(d);
  task.status = 'dispatched'; task.updatedAt = nowFn();
  run.updatedAt = nowFn(); run.settledNotifiedAt = 0;
  save();
  emit(run.id, 'worker');
  ensureTick();

  const prompt = buildPreamble({ task, dispatch: d, run, placement, canDispatch: run.depth + 2 <= lim.maxDepth });
  try {
    if (reuseTid != null) await startInExistingTerminal(run, d, reuseTid, prompt);
    else if (placement === 'worktree') await startInWorktree(run, task, d, prompt);
    else await startInNewTerminal(run, d, prompt);
  } catch (e) {
    d.state = 'failed';
    d.error = { code: (e && e.code) || 'WORKER_START_FAILED', message: String((e && e.message) || e).slice(0, 300) };
    d.updatedAt = nowFn();
    task.status = 'failed'; task.updatedAt = nowFn();
    save();
    emit(run.id, 'worker');
    throw codedError(d.error.code === 'BAD_PARAMS' ? 'BAD_PARAMS' : 'WORKER_START_FAILED', d.error.message, {
      failedStage: e && e.stage ? e.stage : 'launch', dispatchId: d.id, taskId: task.id,
      residualResources: d.worker.tid != null ? [{ kind: 'terminal', tid: d.worker.tid, cwd: d.worker.cwd }] : [],
    });
  }
  d.updatedAt = nowFn();
  save();
  emit(run.id, 'worker');
  return { run: pickRun(run), task: pickTask(task, { brief: true }), worker: await projectWorker(d, { brief: true }) };
}
async function startInNewTerminal(run, d, prompt) {
  if (!inj.createTerminal || !inj.launch) throw codedError('WORKER_START_FAILED', '터미널 실행 경로가 없습니다');
  const w = d.worker;
  let term;
  try { term = await inj.createTerminal({ cwd: w.cwd, name: `${w.agent} · 워커` }); } catch (e) { throw Object.assign(e, { stage: 'terminal' }); }
  w.tid = term.tid; w.tsession = term.tsession; d.terminal = 'owned';
  save();
  fs.mkdirSync(orchDir(), { recursive: true, mode: 0o700 });
  const file = promptFile(d.id);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  let shell = '';
  try { shell = inj.shellOf ? await inj.shellOf({ tsession: w.tsession }) : ''; } catch (_) { shell = ''; }
  const pArgs = promptArgs(w.agent, file, shell, /^\s*-/.test(prompt));
  const mArgs = inj.agentModels ? inj.agentModels.launchArgs(w.agent, w) : [];
  const args = [...mArgs, ...(pArgs || [])];
  const res = await inj.launch({ cwd: w.cwd, index: w.tid, id: w.agent, ...(args.length ? { args } : {}), fresh: true, timeoutMs: timings.launchTimeoutMs });
  if (res && res.busy) throw Object.assign(codedError('WORKER_START_FAILED', '터미널에서 다른 명령이 실행 중입니다'), { stage: 'launch' });
  w.launchedAt = nowFn();
  if (!pArgs) {
    // 실행 인자로 프롬프트를 못 받는 에이전트 — 뜬 것을 확인한 뒤 붙여넣는다. 셸에 그냥 타이핑하지 않는다.
    const ok = await waitAgentLive(w.tsession, timings.readyTimeoutMs);
    if (!ok || !inj.chatInput) throw Object.assign(codedError('WORKER_START_FAILED', '에이전트가 준비되지 않아 명세를 전달하지 못했습니다'), { stage: 'prompt' });
    await inj.chatInput({ cwd: w.cwd, tid: w.tid, text: prompt, submit: true });
  }
  d.state = 'ready';
}
async function startInExistingTerminal(run, d, tid, prompt) {
  if (!Number.isInteger(tid)) throw codedError('BAD_PARAMS', '--terminal 은 터미널 번호입니다');
  const prev = load().dispatches.filter((x) => x.runId === run.id && x.worker && x.worker.tid === tid && x.id !== d.id).pop();
  if (!prev || !SETTLED_DISPATCH.has(prev.state) || (prev.terminal !== 'owned' && prev.terminal !== 'retained')) {
    throw codedError('TERMINAL_NOT_REUSABLE', '끝난 워커의 터미널만 다시 쓸 수 있습니다');
  }
  let pr = null;
  try { pr = inj.probe ? await inj.probe({ tsession: prev.worker.tsession }) : null; } catch (_) { pr = null; }
  if (!pr || !pr.exists || pr.shell !== false) throw codedError('TERMINAL_NOT_REUSABLE', '그 터미널에 에이전트가 떠 있지 않습니다');
  if (!inj.chatInput) throw codedError('WORKER_START_FAILED', '입력 경로가 없습니다');
  Object.assign(d.worker, { agent: prev.worker.agent, model: prev.worker.model, effort: prev.worker.effort, cwd: prev.worker.cwd, tid: prev.worker.tid, tsession: prev.worker.tsession, placement: prev.worker.placement, taskRef: prev.worker.taskRef || null, branch: prev.worker.branch || null, launchedAt: nowFn() });
  prev.terminal = 'transferred';
  d.terminal = 'owned';
  await inj.chatInput({ cwd: d.worker.cwd, tid: d.worker.tid, text: prompt, submit: true });
  d.state = 'ready';
}
async function startInWorktree(run, task, d, prompt) {
  if (!inj.tasks || typeof inj.tasks.internalCreate !== 'function') throw codedError('WORKER_START_FAILED', '이 PC 에서는 작업 폴더(worktree)를 만들 수 없습니다');
  const w = d.worker;
  let res;
  try {
    res = await inj.tasks.internalCreate({
      repo: run.cwd, prompt, title: task.title, opId: `orch-${d.id}`,
      agents: [{ id: w.agent, model: w.model || null, effort: w.effort || null }],
    }, { kind: 'orch', planId: d.id });
  } catch (e) { throw Object.assign(e, { stage: 'worktree' }); }
  const t = res && res.task;
  const r = t && t.runs && t.runs[0];
  if (!t || !r) throw Object.assign(codedError('WORKER_START_FAILED', '작업을 만들지 못했습니다'), { stage: 'worktree' });
  w.taskRef = { taskId: t.id, runId: r.id };
  w.branch = r.branch || null;
  w.cwd = r.cwd || null;
  if (r.tsession) { w.tsession = r.tsession; w.tid = r.tid; }
  d.terminal = 'owned';
  w.launchedAt = nowFn();
  if (r.state && r.state !== 'creating' && r.state !== 'launching') d.state = 'ready';
}

async function rpcWorkerList(p, caller) {
  resolveWorktreeSessions();
  let ds;
  let scope;
  if (p.all) { ds = load().dispatches.slice(); scope = 'all'; }
  else { const run = boundRun(caller, p, { mustActive: false }); ds = dispatchesOf(run.id); scope = `run:${run.id}`; }
  if (p.terminalState === 'reclaimable') ds = ds.filter((d) => SETTLED_DISPATCH.has(d.state) && d.terminal === 'owned');
  ds.sort((a, b) => b.createdAt - a.createdAt);
  const workers = [];
  for (const d of ds.slice(0, 100)) workers.push(await projectWorker(d, { brief: true }));
  return { scope, workers, page: { hasMore: ds.length > 100 } };
}
async function rpcWorkerShow(p) {
  const d = mustDispatch(p.dispatch);
  resolveWorktreeSessions();
  const t = findTask(d.taskId);
  return { worker: await projectWorker(d), task: t ? pickTask(t) : null };
}
async function rpcWorkerRead(p) {
  const d = mustDispatch(p.dispatch);
  const w = d.worker || {};
  if (w.tid == null || !inj.read) return { dispatchId: d.id, text: '', source: 'none', reason: w.tid == null ? 'no_terminal' : 'no_reader' };
  const lines = Math.max(1, Math.min(2000, (p.limit | 0) || 80));
  let text = '';
  try { text = await inj.read({ cwd: w.cwd, tid: w.tid, lines }); } catch (e) { return { dispatchId: d.id, text: '', source: 'none', reason: 'terminal_gone' }; }
  return { dispatchId: d.id, text, source: 'terminal', lines };
}
async function releaseTerminal(d, { merge = null } = {}) {
  const w = d.worker || {};
  if (w.placement === 'worktree' && w.taskRef && inj.tasks) {
    const base = { taskId: w.taskRef.taskId, runId: w.taskRef.runId, opId: `orch-rel-${rid('o')}` };
    const title = (findTask(d.taskId) || {}).title || d.id;
    const out = merge
      ? await awaitTaskOp('git.merge.local', { ...base, method: merge.method || 'merge', commitMessage: merge.message || `orch: ${title}`, discardOthers: true })
      : await awaitTaskOp('task.discard', { ...base, force: true });
    if (out && out.failed) {
      // 실패하면 아무것도 지우지 않는다(작업 폴더·브랜치 그대로) — 이유와 다음 행동을 함께 돌려준다.
      const hint = out.code === 'MAIN_DIRTY' ? ' — base 브랜치가 열려 있는 폴더에 커밋 안 된 변경이 있습니다. 먼저 커밋한 뒤 다시 시도하세요'
        : out.code === 'MERGE_CONFLICT' ? ' — 충돌을 풀 워커를 다시 시키거나 사용자에게 알리세요'
          : out.code === 'UNCOMMITTED_CHANGES' ? ' — 워커 폴더에 커밋 안 된 변경이 있습니다. --message 로 커밋 메시지를 주세요' : '';
      throw codedError('MERGE_FAILED', (out.message || (merge ? '머지하지 못했습니다' : '정리하지 못했습니다')) + hint, { detail: { code: out.code || null, branch: w.branch || null, result: out.result || null } });
    }
  } else if (w.tid != null && inj.closeTerminal) {
    await inj.closeTerminal({ cwd: w.cwd, tid: w.tid });
  }
  d.terminal = 'released';
  d.updatedAt = nowFn();
  try { fs.unlinkSync(promptFile(d.id)); } catch (_) { /* 없음 */ }
}
/**
 * tasks.js 의 변이는 비동기 op({accepted, opId})다 — run.lastOp 에 같은 opId 가 찍힐 때까지 기다린다.
 *  워커가 방금 보고를 보낸 직후에는 에이전트가 아직 턴을 마무리하는 중일 수 있다(AGENT_BUSY) — 잠깐 다시 시도한다.
 */
async function awaitTaskOp(method, params) {
  let first = null;
  for (let i = 0; ; i++) {
    try { first = await inj.tasks.rpc(method, params); break; } catch (e) {
      if (e && (e.code === 'AGENT_BUSY' || e.code === 'RUN_BUSY') && i < 20) { await sleep(1500); continue; }
      if (e && e.code === 'TASK_CLOSED') return { ok: true, already: true };
      return { failed: true, code: e && e.code, message: e && e.message };
    }
  }
  const deadline = Date.now() + 200000;
  const done = (r) => (r && r.lastOp && r.lastOp.opId === params.opId ? r.lastOp : null);
  let lo = first && (first.lastOp || done(first.run));
  while (!lo) {
    if (Date.now() > deadline) return { failed: true, code: 'TIMEOUT', message: '시간 안에 끝나지 않았습니다' };
    await sleep(400);
    let g = null;
    try { g = await inj.tasks.rpc('task.get', { taskId: params.taskId }); } catch (e) { return { failed: true, code: e && e.code, message: e && e.message }; }
    const r = g && g.task && g.task.runs.find((x) => x.id === params.runId);
    if (!r) return { ok: true };
    lo = done(r);
    if (!lo && !r.op && (r.state === 'merged' || r.state === 'discarded')) return { ok: true, state: r.state };
  }
  return lo.ok ? { ok: true, result: lo.result } : { failed: true, code: lo.code, message: lo.message, result: lo.result };
}
async function rpcWorkerRelease(p) {
  const d = mustDispatch(p.dispatch);
  if (ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_ACTIVE', '아직 끝나지 않은 워커입니다 — 정리는 결과를 받은 뒤에 합니다(멈추려면 worker-stop)');
  if (d.terminal !== 'owned' && d.terminal !== 'retained') return { dispatchId: d.id, terminal: d.terminal, already: true };
  const merge = p.merge ? { method: typeof p.merge === 'string' && ['merge', 'squash', 'ff'].includes(p.merge) ? p.merge : 'merge', message: str(p.message, 2000, 'message') } : null;
  if (merge && (d.worker || {}).placement !== 'worktree') throw codedError('BAD_PARAMS', '--merge 는 전용 작업 폴더(--worktree new) 워커에만 씁니다');
  await releaseTerminal(d, { merge });
  save();
  emit(d.runId, 'worker');
  return { dispatchId: d.id, terminal: d.terminal, merged: !!merge };
}
function rpcWorkerRetain(p) {
  const d = mustDispatch(p.dispatch);
  if (ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_ACTIVE', '아직 끝나지 않은 워커입니다');
  if (d.terminal === 'owned') { d.terminal = 'retained'; d.updatedAt = nowFn(); save(); emit(d.runId, 'worker'); }
  return { dispatchId: d.id, terminal: d.terminal };
}
function settle(d, state, { result = null, error = null } = {}) {
  d.state = state;
  d.result = result;
  d.error = error;
  d.updatedAt = nowFn();
  d.settledAt = nowFn();
  const t = findTask(d.taskId);
  if (t) {
    t.status = state === 'succeeded' ? 'completed' : 'failed';
    t.result = result ? { outcome: result.outcome, summary: result.summary } : { outcome: 'failed', summary: (error && error.message) || state };
    t.updatedAt = nowFn();
  }
  // 답 못 받은 질문은 닫는다 — 끝난 워커에게 답이 가지 않는다.
  for (const m of load().messages) {
    if (m.type === 'question' && m.dispatchId === d.id && m.payload && m.payload.status === 'pending') { m.payload.status = 'closed'; wakeQuestion(m.id); }
  }
  advanceDag(d.runId);
  const run = findRun(d.runId);
  if (run) run.updatedAt = nowFn();
}
async function stopDispatch(d, { reason = 'stopped' } = {}) {
  const w = d.worker || {};
  if (w.tid != null && inj.keys) {
    try { await inj.keys({ cwd: w.cwd, tid: w.tid, keys: ['Escape'] }); } catch (_) { /* 터미널 없음 */ }
  }
  settle(d, 'stopped', { error: { code: 'STOPPED', message: reason } });
}
async function rpcWorkerStop(p) {
  const d = mustDispatch(p.dispatch);
  if (!ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_INACTIVE', '이미 끝난 워커입니다');
  await stopDispatch(d, { reason: str(p.reason, 200, 'reason') || '코디네이터가 멈췄습니다' });
  save();
  emit(d.runId, 'worker');
  addMessage({ runId: d.runId, to: dispatchMailbox(d.id), type: 'status', from: { kind: 'system' }, subject: '멈춤', body: '코디네이터가 이 일을 멈췄습니다. 더 진행하지 말고 기다리세요.', dispatchId: d.id, taskId: d.taskId });
  return { worker: await projectWorker(d, { brief: true }) };
}
/** 포기 — 워커가 **끝난 것이 확인된** 경우에만(터미널이 없거나 셸로 돌아옴). 모르는 상태에서는 거부한다. */
async function rpcWorkerAbandon(p) {
  const d = mustDispatch(p.dispatch);
  if (!ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_INACTIVE', '이미 끝난 워커입니다');
  const o = await observe(d);
  if (o.liveness !== 'exited' && !p.force) {
    throw codedError('NOT_LIVE_PROOF', `워커가 끝났다는 확인이 없습니다(${o.liveness}) — 살아 있으면 worker-stop, 화면은 worker-read 로 확인하세요`, { liveness: o.liveness, reason: o.reason });
  }
  settle(d, 'abandoned', { error: { code: 'ABANDONED', message: o.reason || 'abandoned' } });
  if (o.liveness === 'exited' && d.terminal === 'owned' && (d.worker || {}).placement !== 'worktree') d.terminal = o.reason === 'terminal_gone' ? 'released' : 'owned';
  save();
  emit(d.runId, 'worker');
  return { worker: await projectWorker(d, { brief: true }) };
}

// ── RPC: 메시지 ──────────────────────────────────────────────────────────────
function fromOf(caller, d) {
  if (caller.kind === 'user') return { kind: 'user' };
  if (d) return { kind: 'worker', dispatchId: d.id };
  return { kind: 'coordinator', tsession: caller.meta.tsession };
}
function rpcSend(p, caller) {
  const type = p.type == null ? 'status' : String(p.type);
  if (type === 'heartbeat') return rpcHeartbeat(p, caller);
  if (!MESSAGE_TYPES.includes(type) || type === 'question' || type === 'reply' || type === 'decision_gate') throw codedError('BAD_PARAMS', `보낼 수 없는 종류입니다: ${type}`);
  const subject = str(p.subject, SUBJECT_MAX, 'subject') || '';
  const body = str(p.body != null ? p.body : p.summary, BODY_MAX, 'body') || '';

  if (WORKER_ONLY_TYPES.has(type)) {
    const d = ownDispatch(caller, p);
    if (type === 'worker_done') return workerDone(d, p, { subject, body });
    if (!ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_INACTIVE', '이미 끝난 시도입니다');
    d.escalatedAt = nowFn(); d.escalationSeenAt = null; d.updatedAt = nowFn();
    const msg = addMessage({ runId: d.runId, to: runMailbox(d.runId), type, from: fromOf(caller, d), subject: subject || '막힘', body, taskId: d.taskId, dispatchId: d.id, priority: 'high' });
    emit(d.runId, 'message');
    notifyUser(findRun(d.runId), 'orch_escalation', `워커가 막혔어요 · ${(findTask(d.taskId) || {}).title || ''}`.trim(), d).catch(() => {});
    return { accepted: true, messageId: msg.id };
  }

  // 일반 메시지 — 받는 곳: 명시(--to) > 워커면 자기 묶음의 코디네이터.
  const own = caller.kind === 'agent' && caller.dispatch && ACTIVE_DISPATCH.has(caller.dispatch.state) ? caller.dispatch : null;
  const to = p.to == null || p.to === '' ? null : String(p.to);
  if (!to) {
    if (!own) throw codedError('BAD_PARAMS', '--to 가 필요합니다(예: dispatch:<id>, @all)');
    const msg = addMessage({ runId: own.runId, to: runMailbox(own.runId), type, from: fromOf(caller, own), subject, body, taskId: own.taskId, dispatchId: own.id });
    emit(own.runId, 'message');
    return { accepted: true, messageId: msg.id, to: [msg.to] };
  }
  const targets = resolveRecipients(to, caller, p);
  const ids = [];
  for (const t of targets) {
    const msg = addMessage({ runId: t.runId, to: t.mailbox, type, from: fromOf(caller, own), subject, body, taskId: t.taskId || null, dispatchId: t.dispatchId || null });
    ids.push(msg.id);
  }
  emit([...new Set(targets.map((t) => t.runId))], 'message');
  return { accepted: true, messageIds: ids, to: targets.map((t) => t.mailbox), note: '보관함에 넣었습니다 — 받는 쪽이 읽었다는 뜻은 아닙니다' };
}
function resolveRecipients(to, caller, p) {
  if (to.startsWith('dispatch:')) {
    const d = mustDispatch(to.slice('dispatch:'.length));
    return [{ mailbox: dispatchMailbox(d.id), runId: d.runId, dispatchId: d.id, taskId: d.taskId }];
  }
  if (to.startsWith('run:')) {
    const run = findRun(to.slice(4));
    if (!run) throw codedError('RUN_NOT_FOUND', '묶음을 찾을 수 없습니다');
    return [{ mailbox: runMailbox(run.id), runId: run.id }];
  }
  if (to.startsWith('@')) {
    const run = boundRun(caller, p);
    const g = to.slice(1);
    let ds = dispatchesOf(run.id).filter((d) => ACTIVE_DISPATCH.has(d.state));
    if (g === 'idle') ds = ds.filter((d) => { const c = probeCache.get(d.id); return c && c.agentState === 'idle'; });
    else if (g !== 'all') ds = ds.filter((d) => d.worker && d.worker.agent === g);
    return ds.map((d) => ({ mailbox: dispatchMailbox(d.id), runId: run.id, dispatchId: d.id, taskId: d.taskId }));
  }
  throw codedError('BAD_PARAMS', '받는 곳은 dispatch:<id> · run:<id> · @all · @idle · @<에이전트> 중 하나입니다');
}
function workerDone(d, p, { subject, body }) {
  const outcome = p.outcome;
  if (outcome !== 'succeeded' && outcome !== 'failed') throw codedError('BAD_PARAMS', '--outcome 은 succeeded 또는 failed 입니다');
  if (!body.trim()) throw codedError('BAD_PARAMS', '요약(--summary)이 비어 있습니다 — 한 일·알아낸 것·남은 것을 세 문장으로 적으세요');
  if (!ACTIVE_DISPATCH.has(d.state)) {
    if (d.state === 'succeeded' || d.state === 'failed') return { accepted: true, settlement: { action: 'settled', outcome: d.result ? d.result.outcome : outcome, duplicate: true } };
    return { accepted: false, settlement: { action: 'rejected', code: 'inactive_dispatch', reason: `이 시도는 이미 ${d.state} 상태입니다` } };
  }
  let files = p.files != null ? p.files : p.filesModified;
  if (typeof files === 'string') files = files.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(files)) files = [];
  const result = { outcome, summary: body, subject, filesModified: files.slice(0, 200).map((f) => String(f).slice(0, 400)), reportPath: str(p.report != null ? p.report : p.reportPath, 1000, 'report'), at: nowFn() };
  settle(d, outcome === 'succeeded' ? 'succeeded' : 'failed', { result });
  const msg = addMessage({
    runId: d.runId, to: runMailbox(d.runId), type: 'worker_done', from: { kind: 'worker', dispatchId: d.id },
    subject: subject || (outcome === 'succeeded' ? '완료' : '실패'), body, taskId: d.taskId, dispatchId: d.id,
    payload: { outcome, filesModified: result.filesModified, reportPath: result.reportPath },
  });
  emit(d.runId, 'worker');
  maybeNotifySettled(findRun(d.runId));
  return { accepted: true, messageId: msg.id, settlement: { action: 'settled', outcome, duplicate: false }, next: '이 턴을 끝내고 기다리세요.' };
}
function rpcHeartbeat(p, caller) {
  const d = ownDispatch(caller, p);
  if (!ACTIVE_DISPATCH.has(d.state)) return { accepted: false, reason: 'inactive_dispatch' };
  d.heartbeatAt = nowFn();
  d.phase = str(p.phase, 80, 'phase') || d.phase;
  d.updatedAt = nowFn();
  save();
  emit(d.runId, 'heartbeat');
  return { accepted: true, pendingMail: unreadOf(dispatchMailbox(d.id)).length };
}

function callerMailbox(caller, p) {
  if (caller.kind !== 'agent') throw codedError('NOT_IN_TERMINAL', '수신함은 CodingPT 터미널 안에서 확인합니다');
  if (p.run) return { mailbox: runMailbox(boundRun(caller, p, { mustActive: false }).id), role: 'coordinator' };
  const own = caller.dispatch && ACTIVE_DISPATCH.has(caller.dispatch.state) ? caller.dispatch : null;
  // 워커이면서 하위 묶음의 코디네이터이면 — 하위 묶음에 읽을 것이 있을 때 그쪽이 먼저다.
  if (caller.runs.length) {
    const run = caller.runs[caller.runs.length - 1];
    if (!own || p.as === 'coordinator' || unreadOf(runMailbox(run.id)).length || dispatchesOf(run.id).some((d) => ACTIVE_DISPATCH.has(d.state))) {
      if (p.as !== 'worker') return { mailbox: runMailbox(run.id), role: 'coordinator', run };
    }
  }
  if (own) return { mailbox: dispatchMailbox(own.id), role: 'worker', dispatch: own };
  if (caller.dispatch) return { mailbox: dispatchMailbox(caller.dispatch.id), role: 'worker', dispatch: caller.dispatch };
  throw codedError('NO_RUN', '이 터미널에는 수신함이 없습니다(묶음도 워커도 아님)');
}
async function workersBrief(runId) {
  const out = [];
  for (const d of dispatchesOf(runId)) {
    if (!ACTIVE_DISPATCH.has(d.state) && d.terminal !== 'owned') continue;
    const w = await projectWorker(d, { brief: true });
    out.push({ dispatchId: w.dispatchId, title: w.title, state: w.state, uiState: w.uiState, liveness: w.liveness, phase: w.phase, heartbeatAt: w.heartbeatAt, attention: w.attention.categories, nextAction: w.nextAction, terminal: w.terminal });
  }
  return out;
}
async function rpcCheck(p, caller) {
  const box = callerMailbox(caller, p);
  const s = load();
  if (p.ack) {
    const dl = s.deliveries.find((x) => x.id === String(p.ack));
    if (!dl || dl.mailbox !== box.mailbox) throw codedError('DELIVERY_NOT_FOUND', '그 배달을 찾을 수 없습니다');
    if (dl.status === 'outstanding') {
      const ids = new Set(dl.messageIds);
      for (const m of s.messages) {
        if (!ids.has(m.id)) continue;
        m.acked = true;
        if (m.type === 'escalation' && m.dispatchId) { const d = findDispatch(m.dispatchId); if (d) d.escalationSeenAt = nowFn(); }
      }
      dl.status = 'acknowledged'; dl.acknowledgedAt = nowFn();
      save();
      emit(box.run ? box.run.id : (box.dispatch ? box.dispatch.runId : null), 'message');
    }
  }
  const types = p.types ? new Set(String(p.types).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const tail = async (extra) => ({ mailbox: box.mailbox, role: box.role, ...extra, ...(box.role === 'coordinator' && box.run ? { workers: await workersBrief(box.run.id) } : {}) });
  if (p.peek || p.all) {
    const list = p.all ? s.messages.filter((m) => m.to === box.mailbox).slice(-100) : unreadOf(box.mailbox);
    return tail({ peek: true, messages: list.map(pickMsg) });
  }
  const deliver = async () => {
    const out = s.deliveries.find((x) => x.mailbox === box.mailbox && x.status === 'outstanding');
    if (out) {
      const ids = new Set(out.messageIds);
      return tail({ deliveryId: out.id, replay: true, messages: s.messages.filter((m) => ids.has(m.id)).sort((a, b) => a.seq - b.seq).map(pickMsg), ack: `cpt orch check --ack ${out.id}` });
    }
    const un = unreadOf(box.mailbox);
    if (!un.length) return null;
    if (p.wait && types && !un.some((m) => types.has(m.type))) return null;
    const batch = un.slice(0, DELIVERY_BATCH);
    const dl = { id: rid('dl'), mailbox: box.mailbox, messageIds: batch.map((m) => m.id), status: 'outstanding', createdAt: nowFn() };
    s.deliveries.push(dl);
    if (s.deliveries.length > 400) s.deliveries = s.deliveries.filter((x) => x.status === 'outstanding').concat(s.deliveries.filter((x) => x.status !== 'outstanding').slice(-200));
    save();
    return tail({ deliveryId: dl.id, replay: false, messages: batch.map(pickMsg), more: un.length > batch.length, ack: `cpt orch check --ack ${dl.id}` });
  };
  let r = await deliver();
  if (r) return r;
  if (!p.wait) return tail({ empty: true, messages: [] });
  const timeoutMs = Math.max(1000, Math.min(WAIT_MAX_MS, Number(p.timeoutMs) || WAIT_DEFAULT_MS));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const why = await waitMailbox(box.mailbox, types, left, caller.meta);
    if (why === 'closed') return tail({ cancelled: true, messages: [] });
    r = await deliver();
    if (r) return r;
    if (why === 'timeout') break;
  }
  return tail({ timeout: true, messages: [], note: '시간이 지났을 뿐 실패가 아닙니다 — 워커 상태를 보고 계속 기다리세요' });
}
function waitMailbox(mailbox, types, ms, meta) {
  return new Promise((resolve) => {
    let set = waiters.get(mailbox);
    if (!set) { set = new Set(); waiters.set(mailbox, set); }
    let done = false;
    const w = { types, resolve: (why) => finish(why) };
    const tm = setTimeout(() => finish('timeout'), ms);
    function finish(why) {
      if (done) return;
      done = true;
      clearTimeout(tm);
      set.delete(w);
      resolve(why);
    }
    set.add(w);
    if (meta && typeof meta.onClose === 'function') meta.onClose(() => finish('closed'));
  });
}

// ── RPC: 질문·답 ─────────────────────────────────────────────────────────────
function wakeQuestion(id) {
  const set = questionWaiters.get(id);
  if (!set) return false;
  questionWaiters.delete(id);
  const fns = [...set];   // 깨어난 쪽이 스스로 set 에서 빠지므로 먼저 떠 둔다
  for (const fn of fns) { try { fn('answered'); } catch (_) { /* noop */ } }
  return fns.length > 0;
}
function waitQuestion(id, ms, meta) {
  return new Promise((resolve) => {
    let set = questionWaiters.get(id);
    if (!set) { set = new Set(); questionWaiters.set(id, set); }
    let done = false;
    const fn = (why) => { if (done) return; done = true; clearTimeout(tm); set.delete(fn); resolve(why); };
    const tm = setTimeout(() => fn('timeout'), ms);
    set.add(fn);
    if (meta && typeof meta.onClose === 'function') meta.onClose(() => fn('closed'));
  });
}
async function rpcAsk(p, caller) {
  const timeoutMs = Math.max(1000, Math.min(WAIT_MAX_MS, Number(p.timeoutMs) || WAIT_DEFAULT_MS));
  let msg;
  if (p.resume) {
    msg = load().messages.find((m) => m.id === String(p.resume) && m.type === 'question');
    if (!msg) throw codedError('MESSAGE_NOT_FOUND', '그 질문을 찾을 수 없습니다');
    const d = findDispatch(msg.dispatchId);
    if (caller.kind !== 'agent' || !d || d.worker.tsession !== caller.meta.tsession) throw codedError('NOT_YOUR_DISPATCH', '이 터미널이 한 질문이 아닙니다');
  } else {
    const d = ownDispatch(caller, p);
    if (!ACTIVE_DISPATCH.has(d.state)) throw codedError('DISPATCH_INACTIVE', '이미 끝난 시도입니다');
    const question = str(p.question, BODY_MAX, 'question', { required: true });
    let options = p.options == null ? [] : p.options;
    if (typeof options === 'string') { try { const j = JSON.parse(options); options = Array.isArray(j) ? j : [options]; } catch (_) { options = options.split(',').map((s) => s.trim()).filter(Boolean); } }
    msg = addMessage({ runId: d.runId, to: runMailbox(d.runId), type: 'question', from: { kind: 'worker', dispatchId: d.id }, subject: question.split('\n')[0].slice(0, SUBJECT_MAX), body: question, taskId: d.taskId, dispatchId: d.id, priority: 'high', payload: { status: 'pending', options: options.slice(0, 8).map((o) => String(o).slice(0, 200)), answer: null } });
    emit(d.runId, 'question');
  }
  const answered = () => (msg.payload.status === 'answered' ? { answered: true, messageId: msg.id, answer: msg.payload.answer, answeredBy: msg.payload.answeredBy || null } : null);
  let r = answered();
  if (r) return r;
  if (msg.payload.status === 'closed') return { answered: false, closed: true, messageId: msg.id };
  const why = await waitQuestion(msg.id, timeoutMs, caller.meta);
  r = answered();
  if (r) return r;
  return { answered: false, messageId: msg.id, [why === 'closed' ? 'cancelled' : 'timeout']: true, resume: `cpt orch ask --resume ${msg.id}`, note: '질문은 남아 있습니다 — 같은 질문을 새로 만들지 말고 --resume 으로 이어서 기다리세요' };
}
function rpcReply(p, caller) {
  const msg = load().messages.find((m) => m.id === String(p.id || '') && m.type === 'question');
  if (!msg) throw codedError('MESSAGE_NOT_FOUND', '그 질문을 찾을 수 없습니다');
  const body = str(p.body, BODY_MAX, 'body', { required: true });
  if (msg.payload.status === 'answered') return { accepted: true, duplicate: true, messageId: msg.id };
  if (msg.payload.status === 'closed') throw codedError('DISPATCH_INACTIVE', '이미 끝난 워커의 질문입니다');
  msg.payload.status = 'answered';
  msg.payload.answer = body;
  msg.payload.answeredBy = caller.kind === 'user' ? 'user' : 'coordinator';
  msg.payload.answeredAt = nowFn();
  msg.acked = true;
  save();
  const hadWaiter = wakeQuestion(msg.id);
  // 워커가 기다리다 시간 초과로 빠져나갔으면 답을 수신함에 넣어 둔다(깨우기 포함).
  if (!hadWaiter) addMessage({ runId: msg.runId, to: dispatchMailbox(msg.dispatchId), type: 'reply', from: fromOf(caller, null), subject: `답: ${msg.subject}`, body, taskId: msg.taskId, dispatchId: msg.dispatchId, payload: { questionId: msg.id } });
  emit(msg.runId, 'question');
  return { accepted: true, messageId: msg.id, delivered: hadWaiter ? 'waiter' : 'mailbox' };
}

// ── RPC: 결정 게이트 ─────────────────────────────────────────────────────────
//  사람(또는 코디네이터)이 골라야 다음으로 넘어가는 갈림길. 만들면 폰·PC 에 알림이 가고, 그 일은 고를 때까지 멈춘다.
function rpcGateCreate(p, caller) {
  const run = boundRun(caller, p);
  const question = str(p.question, 2000, 'question', { required: true });
  let options = p.options == null ? [] : p.options;
  if (typeof options === 'string') { try { options = JSON.parse(options); } catch (_) { options = options.split(',').map((s) => s.trim()).filter(Boolean); } }
  if (!Array.isArray(options) || options.length < 2) throw codedError('BAD_PARAMS', '선택지는 2개 이상입니다');
  let task = null;
  if (p.task) {
    task = findTask(String(p.task));
    if (!task || task.runId !== run.id) throw codedError('TASK_NOT_FOUND', '작업을 찾을 수 없습니다');
  }
  const g = { id: rid('gate'), runId: run.id, taskId: task ? task.id : null, question, options: options.slice(0, 8).map((o) => String(o).slice(0, 200)), status: 'pending', resolution: null, createdAt: nowFn() };
  load().gates.push(g);
  if (task && (task.status === 'pending' || task.status === 'ready')) { task.gateId = g.id; task.status = 'pending'; task.updatedAt = nowFn(); }
  save();
  emit(run.id, 'gate');
  notifyUser(run, 'orch_gate', `결정이 필요해요 · ${question.split('\n')[0].slice(0, 60)}`).catch(() => {});
  return { gate: g };
}
function rpcGateResolve(p, caller) {
  const g = load().gates.find((x) => x.id === String(p.id || ''));
  if (!g) throw codedError('GATE_NOT_FOUND', '결정을 찾을 수 없습니다');
  if (g.status !== 'pending') return { gate: g, duplicate: true };
  g.status = 'resolved';
  g.resolution = str(p.resolution, 1000, 'resolution', { required: true });
  g.resolvedBy = caller.kind === 'user' ? 'user' : 'coordinator';
  g.resolvedAt = nowFn();
  advanceDag(g.runId);
  save();
  addMessage({ runId: g.runId, to: runMailbox(g.runId), type: 'decision_gate', from: fromOf(caller, null), subject: `결정: ${g.resolution}`, body: `${g.question}\n→ ${g.resolution}`, taskId: g.taskId, payload: { gateId: g.id, resolution: g.resolution, resolvedBy: g.resolvedBy } });
  emit(g.runId, 'gate');
  return { gate: g };
}
function rpcGateList(p, caller) {
  let gs = load().gates;
  if (p.task) gs = gs.filter((g) => g.taskId === String(p.task));
  else if (caller.kind === 'agent' || p.run) { const run = boundRun(caller, p, { mustActive: false }); gs = gs.filter((g) => g.runId === run.id); }
  if (p.pending) gs = gs.filter((g) => g.status === 'pending');
  return { gates: gs };
}

// ── 워크스페이스 한 줄 메모(카드에 보이는 상태 줄) ───────────────────────────
function rpcNoteSet(p, caller) {
  const cwd = typeof p.cwd === 'string' ? p.cwd : (caller.meta && caller.meta.cwd) || '';
  const s = load();
  const cur = s.notes[cwd] || {};
  if (p.comment !== undefined) cur.comment = p.comment == null || p.comment === '' ? null : str(String(p.comment), COMMENT_MAX, 'comment');
  if (p.status !== undefined) {
    if (p.status != null && p.status !== '' && !WS_STATUSES.includes(p.status)) throw codedError('BAD_PARAMS', `status 는 ${WS_STATUSES.join(' · ')} 중 하나입니다`);
    cur.status = p.status || null;
  }
  cur.at = nowFn();
  cur.by = caller.kind === 'agent' ? (caller.meta.agent || 'agent') : 'user';
  if (!cur.comment && !cur.status) delete s.notes[cwd]; else s.notes[cwd] = cur;
  save();
  emit(null, 'note');
  return { cwd, note: s.notes[cwd] || null };
}

// ── 화면용 한 벌(orch.list) ──────────────────────────────────────────────────
async function rpcList(p) {
  resolveWorktreeSessions();
  const s = load();
  const cutoff = nowFn() - 24 * 3600 * 1000;
  const runs = [];
  for (const run of s.runs) {
    if (run.state !== 'active' && !(p.includeClosed && (run.closedAt || 0) > cutoff)) continue;
    const workers = [];
    for (const d of dispatchesOf(run.id)) {
      const w = await projectWorker(d, { brief: false });
      if (w.result && w.result.summary) w.result = { outcome: w.result.outcome, summary: String(w.result.summary).slice(0, 600) };
      workers.push(w);
    }
    runs.push({
      ...pickRun(run),
      tasks: tasksOf(run.id).map((t) => ({ id: t.id, title: t.title, status: t.status, deps: t.deps || [], gateId: t.gateId || null })),
      workers,
      gates: s.gates.filter((g) => g.runId === run.id && g.status === 'pending'),
    });
  }
  const notes = Object.keys(s.notes).map((cwd) => ({ cwd, ...s.notes[cwd] }));
  return { runs, notes, limits: limits(), at: nowFn() };
}

// ── 사용자 알림 ──────────────────────────────────────────────────────────────
async function notifyUser(run, kind, title, d) {
  if (!inj.backFetch || !run) return;
  const co = run.coordinator || {};
  const payload = {
    source: 'agent', kind, title, subtitle: String(run.objective || '').split('\n')[0].slice(0, 80),
    cwd: (d && d.worker && d.worker.cwd) || co.cwd || run.cwd,
    win: d && d.worker && d.worker.tid != null ? d.worker.tid : (co.tid != null ? co.tid : undefined),
  };
  try { await inj.backFetch('POST', '/api/notifications', payload); } catch (e) { log(`[orch] 알림 실패(${kind}): ${e && e.message}`); }
}
function maybeNotifySettled(run) {
  if (!run || run.state !== 'active') return;
  const ds = dispatchesOf(run.id);
  if (!ds.length || ds.some((d) => ACTIVE_DISPATCH.has(d.state))) return;
  if (tasksOf(run.id).some((t) => t.status === 'ready' || t.status === 'pending')) return;
  if (run.settledNotifiedAt) return;
  run.settledNotifiedAt = nowFn();
  save();
  const ok = ds.filter((d) => d.state === 'succeeded').length;
  const bad = ds.length - ok;
  notifyUser(run, 'orch_settled', `워커가 모두 끝났어요 · 성공 ${ok}${bad ? ` · 실패 ${bad}` : ''}`).catch(() => {});
}

// ── 주기 점검 ────────────────────────────────────────────────────────────────
let tickTimer = null;
let ticking = false;
let unsubscribe = null;
function ensureTick() {
  if (tickTimer || !enabled()) return;
  tickTimer = setInterval(() => { tick().catch(() => {}); }, timings.tickMs);
  if (tickTimer.unref) tickTimer.unref();
}
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = load();
    const act = s.dispatches.filter((d) => ACTIVE_DISPATCH.has(d.state));
    if (!act.length) {
      prune();
      if (tickTimer && !s.runs.some((r) => r.state === 'active')) { clearInterval(tickTimer); tickTimer = null; }
      return;
    }
    let changed = resolveWorktreeSessions();
    const touched = new Set();
    for (const d of act) {
      if (!ACTIVE_DISPATCH.has(d.state)) continue;
      const before = probeCache.get(d.id);
      const o = await observe(d);
      const idle = o.liveness === 'live' && o.agentState === 'idle';
      if (idle && !d.idleSince) { d.idleSince = nowFn(); changed = true; }
      if (!idle && d.idleSince) { d.idleSince = null; changed = true; }
      if (!before || before.liveness !== o.liveness || before.agentState !== o.agentState) touched.add(d.runId);
      // 작업 폴더 워커의 폴더 신뢰 확인 — 사용자가 조율을 맡겼으므로 대신 수락한다(일반 작업은 종전대로 사람이 누른다).
      if (d.worker.placement === 'worktree' && d.worker.taskRef && d.worker.taskRef.runId && inj.tasks) {
        try {
          const t = inj.tasks._internals.load().items.find((x) => x.id === d.worker.taskRef.taskId);
          const r = t && t.runs.find((x) => x.id === d.worker.taskRef.runId);
          if (r && r.trustPending) await inj.tasks.rpc('task.run.trust', { taskId: t.id, runId: r.id });
        } catch (_) { /* 다음 틱에 다시 */ }
      }
      // 보고 없이 멈춘 워커 — 두 번까지 알려 준다(잊은 것일 뿐인 경우가 대부분).
      if (idle && d.idleSince && nowFn() - d.idleSince > timings.reportNudgeMs && !pendingQuestionOf(d) && d.reportNudges < REPORT_NUDGE_MAX && inj.chatInput && d.worker.tid != null) {
        if (!d.lastReportNudgeAt || nowFn() - d.lastReportNudgeAt > 60000) {
          d.reportNudges += 1; d.lastReportNudgeAt = nowFn(); changed = true;
          const text = `[오케스트레이션] 아직 결과 보고가 없습니다. 일을 마쳤으면 \`cpt orch done --dispatch ${d.id} --outcome succeeded --summary "…"\` 을, 못 마쳤으면 --outcome failed 로 보내세요.`;
          inj.chatInput({ cwd: d.worker.cwd, tid: d.worker.tid, text, submit: true }).catch(() => {});
        }
      }
    }
    if (changed) save();
    if (touched.size) emit([...touched], 'liveness');
  } finally { ticking = false; }
}
function prune() {
  const s = load();
  const cutoff = nowFn() - CLOSED_KEEP_MS;
  const dead = new Set(s.runs.filter((r) => r.state === 'closed' && (r.closedAt || 0) < cutoff).map((r) => r.id));
  if (!dead.size) return;
  for (const d of s.dispatches) if (dead.has(d.runId)) { try { fs.unlinkSync(promptFile(d.id)); } catch (_) { /* 없음 */ } }
  s.runs = s.runs.filter((r) => !dead.has(r.id));
  for (const k of ['tasks', 'dispatches', 'messages', 'gates']) s[k] = s[k].filter((x) => !dead.has(x.runId));
  save();
}

// ── 디스패치 ─────────────────────────────────────────────────────────────────
const METHODS = {
  'orch.status': rpcStatus,
  'orch.runCreate': rpcRunCreate, 'orch.runList': rpcRunList, 'orch.runShow': rpcRunShow, 'orch.runClose': rpcRunClose,
  'orch.taskCreate': rpcTaskCreate, 'orch.taskList': rpcTaskList, 'orch.taskUpdate': rpcTaskUpdate,
  'orch.workerStart': rpcWorkerStart, 'orch.workerList': rpcWorkerList, 'orch.workerShow': rpcWorkerShow, 'orch.workerRead': rpcWorkerRead,
  'orch.workerStop': rpcWorkerStop, 'orch.workerAbandon': rpcWorkerAbandon, 'orch.workerRelease': rpcWorkerRelease, 'orch.workerRetain': rpcWorkerRetain,
  'orch.send': rpcSend, 'orch.check': rpcCheck, 'orch.ask': rpcAsk, 'orch.reply': rpcReply,
  'orch.gateCreate': rpcGateCreate, 'orch.gateResolve': rpcGateResolve, 'orch.gateList': rpcGateList,
  'orch.noteSet': rpcNoteSet, 'orch.list': rpcList,
};
// 사람 화면(PC·폰)에서 부를 수 있는 것 — 보기와 "답하기·멈추기·닫기·정리".
const USER_METHODS = new Set(['orch.list', 'orch.runList', 'orch.runShow', 'orch.runClose', 'orch.workerList', 'orch.workerShow', 'orch.workerRead',
  'orch.workerStop', 'orch.workerRelease', 'orch.workerRetain', 'orch.reply', 'orch.gateResolve', 'orch.gateList', 'orch.noteSet', 'orch.status']);

async function rpc(method, params, meta) {
  if (!enabled()) throw codedError('ORCH_DISABLED', '이 PC 에서는 오케스트레이션이 꺼져 있습니다');
  const fn = METHODS[method];
  if (!fn) throw codedError('BAD_PARAMS', '알 수 없는 명령입니다: ' + method);
  const p = params && typeof params === 'object' ? params : {};
  const caller = callerOf(meta);
  if (caller.kind === 'user' && !USER_METHODS.has(method)) throw codedError('NOT_IN_TERMINAL', '이 명령은 CodingPT 터미널 안의 에이전트가 씁니다');
  if (caller.kind === 'user' && (method === 'orch.runShow' || method === 'orch.runClose' || method === 'orch.workerList') && !p.run && !p.all) throw codedError('BAD_PARAMS', 'run 이 필요합니다');
  return fn(p, caller);
}

// ── 수명 ─────────────────────────────────────────────────────────────────────
let started = false;
function start() {
  if (started || !enabled()) return;
  started = true;
  load();
  try { fs.mkdirSync(orchDir(), { recursive: true, mode: 0o700 }); } catch (_) { /* noop */ }
  if (inj.agentState && typeof inj.agentState.subscribe === 'function') {
    // 워커 에이전트의 상태가 바뀌면 화면을 바로 다시 그리게 한다(점검 주기를 기다리지 않는다).
    unsubscribe = inj.agentState.subscribe((rec) => {
      const d = rec && rec.key ? workerDispatchOf(rec.key, { activeOnly: true }) : null;
      if (d) emit(d.runId, 'liveness');
    });
  }
  if (load().runs.some((r) => r.state === 'active')) ensureTick();
}
function _reset() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (unsubscribe) { try { unsubscribe(); } catch (_) { /* noop */ } unsubscribe = null; }
  for (const set of waiters.values()) for (const w of set) { try { w.resolve('closed'); } catch (_) { /* noop */ } }
  waiters.clear(); questionWaiters.clear(); lastNudge.clear(); probeCache.clear();
  mem = null; started = false; ticking = false;
}

/** 이 터미널이 워커(진행 중이거나 방금 끝남)인가 — 워커의 "턴 끝" 알림을 사용자에게 보내지 않기 위한 판정. */
function quietSession(tsession) {
  if (!tsession || !enabled()) return false;
  const d = workerDispatchOf(String(tsession));
  if (!d) return false;
  return ACTIVE_DISPATCH.has(d.state) || nowFn() - (d.settledAt || d.updatedAt || 0) < 10 * 60 * 1000;
}

/** 터미널 좌표의 역할 — 자동화·다른 모듈이 "이 터미널이 워커인가" 를 물을 때. */
function roleOfSession(tsession) {
  const d = workerDispatchOf(tsession, { activeOnly: true });
  const runs = coordinatorRunsOf(tsession);
  return { worker: d ? { dispatchId: d.id, runId: d.runId, taskId: d.taskId } : null, coordinatorOf: runs.map((r) => r.id) };
}

module.exports = {
  configure, start, rpc, roleOfSession, quietSession, buildPreamble,
  ERROR_CODES, MESSAGE_TYPES, WS_STATUSES, DEFAULT_LIMITS, USER_METHODS, METHODS: Object.keys(METHODS),
  _internals: {
    load, save, tick, prune, advanceDag, livenessOf, storeFile, promptFile, orchDir, _reset, titleOf,
    get timings() { return timings; },
  },
};
// control.js OPTIONAL_CAPS 의 능력 판정 export — 꺼져 있으면 undefined 로 보여 `orch.v1` 을 광고하지 않는다.
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
