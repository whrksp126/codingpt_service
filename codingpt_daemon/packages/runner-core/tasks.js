/**
 * tasks.js — Agent Tasks(작업) 스토어 + 상태기계 + RPC 디스패치 + 오케스트레이션.
 *  설계 정본: codingpt_daemon/docs/agent-tasks-design.md (부록 Z 가 본문보다 우선).
 *
 * 한 줄 요약: "프롬프트 1개 → 저장소의 git worktree N개 → 보통 터미널 N개에서 에이전트 N개 → diff 리뷰 →
 *  커밋·푸시·PR·머지(원격 없으면 로컬 머지) → 나머지 폐기·정리".
 *
 * 경계(파일 소유권 §8.1):
 *  · git/gh 실행 규칙은 task-git.js 에만 있다. 여기서 git 을 직접 spawn 하지 않는다.
 *  · 터미널·에이전트 실행·채팅 입력·다이얼로그 응답·back REST 는 전부 **주입**(configure)으로만 쓴다 —
 *    cpt-server.wireTasks() 가 실제 구현을 넣고, 테스트는 스텁을 넣는다(tmux/back 없이 전이표 검증).
 *  · 영속 상태는 `<stateDir>/tasks.json`(0600) 하나. 메모리 사본이 정본이고 모든 변경은 save() 로 즉시 기록.
 *
 * 절대 규칙:
 *  · 프롬프트 전문·제목은 이벤트(tasks.changed)·알림·워크스페이스 이름·브랜치명에 싣지 않는다(§10) —
 *    와이어에는 의미 없는 식별자(`<repoSlug>-<t6>-<k>`, `cpt/<t6>-<k>`)만.
 *  · 폴더 신뢰를 대신 수락하지 않는다(부록 Z B-1) — 카드 1탭(task.run.trust)으로만 답한다.
 *  · 변이 RPC 는 전부 비동기 op(즉시 {accepted, opId}) + opId 멱등 재생(§2.12) — 봉인 타임아웃 뒤
 *    재전송이 worktree 중복·머지 2회가 되지 않게.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');
const taskGit = require('./task-git');

const { codedError } = taskGit;

// ── 상수 ─────────────────────────────────────────────────────────────────────
const STORE_V = 1;
const PROMPT_MAX_BYTES = 30000;
const TITLE_MAX = 200;
const RUNS_PER_TASK_MAX = 4;
const OPEN_TASKS_PER_REPO_MAX = 8;
const OPEN_RUNS_MAX = 12;
const OP_IDS_KEEP = 20;
const CREATE_OPS_KEEP = 50;
const CLOSED_HIDE_MS = 30 * 24 * 3600 * 1000;
const RECOVERY_KEEP_MS = 30 * 24 * 3600 * 1000;
const WS_RETRY_MIN_MS = 60 * 1000;
// 부록 Z B-5 — 이번 라운드의 작업 에이전트는 promptArg 가 있는 셋으로 한정한다.
const TASK_AGENTS = new Set(['claude', 'codex', 'gemini']);
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const TRUST_DIALOG_RE = /trust/i;
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh',
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe']);
const PR_BODY_MAX_BYTES = 64 * 1024; // gh 의 --body-file=- (stdin) — GitHub 본문 상한(65,536자)과 같은 자릿수
const ACTIVE_RUN_STATES = new Set(['creating', 'launching', 'running', 'review_ready', 'merging']);
const TERMINAL_TASK_STATES = new Set(['merged', 'closed', 'failed']);

// 와이어 에러 코드 정본(§2.13) — task-contract.test.js 가 픽스처와 대조한다.
const ERROR_CODES = [
  'BAD_PARAMS', 'PROMPT_TOO_LARGE',
  'TASK_NOT_FOUND', 'RUN_NOT_FOUND', 'TASK_CLOSED', 'TASKS_DISABLED',
  'NOT_A_REPO', 'BASE_NOT_FOUND', 'BASE_MOVED', 'TASK_LIMIT',
  'AGENT_NOT_INSTALLED',
  'GIT_MISSING', 'GIT_CLT_MISSING',
  'GH_MISSING', 'GH_NOT_AUTHED', 'GH_ERROR',
  'NOT_GITHUB', 'NO_REMOTE',
  'WORKTREE_ADD_FAILED', 'WORKTREE_MISSING', 'WORKTREE_REMOVE_FAILED',
  'AGENT_LAUNCH_FAILED', 'LAUNCH_BUSY', 'PROMPT_NOT_DELIVERED', 'TERMINAL_GONE',
  'UNCOMMITTED_CHANGES', 'UNMERGED_COMMITS',
  'NOTHING_TO_COMMIT', 'NOTHING_TO_PR', 'GIT_IDENTITY_MISSING', 'GIT_LOCKED', 'COMMIT_HOOK_FAILED', 'GIT_SIGN_FAILED',
  'PUSH_REJECTED', 'AUTH_FAILED',
  'PR_NOT_FOUND', 'PR_NOT_MERGEABLE', 'CHECKS_FAILING',
  'MAIN_DIRTY', 'AGENT_BUSY',
  'MERGE_CONFLICT',
  'RUN_BUSY', 'OP_INTERRUPTED',
  'TIMEOUT',
];

// 알림 subtitle(task_failed) — 에러 code 의 한국어 문구. stderr·경로를 싣지 않는다(서버 DB/로그에 남는다).
const FAIL_TEXT = {
  WORKTREE_ADD_FAILED: '작업 폴더를 만들지 못했어요',
  WORKTREE_MISSING: '작업 폴더가 사라졌어요',
  AGENT_LAUNCH_FAILED: '에이전트를 실행하지 못했어요',
  LAUNCH_BUSY: '터미널에서 다른 명령이 실행 중이에요',
  BASE_NOT_FOUND: 'base 브랜치를 찾을 수 없어요',
  OP_INTERRUPTED: 'PC 가 재시작되어 작업이 중단됐어요',
  TIMEOUT: '응답이 늦어요',
};

// 와이어 화이트리스트(§2.2) — 이 목록 밖의 필드는 저장돼 있어도 절대 내보내지 않는다.
const TASK_FIELDS = ['id', 'v', 'title', 'repo', 'base', 'workspaceId', 'state', 'winnerRunId', 'error',
  'createdAt', 'updatedAt', 'closedAt'];
const REPO_FIELDS = ['path', 'subdir', 'common', 'name', 'remoteUrl', 'github'];
const RUN_FIELDS = ['id', 'idx', 'agent', 'branch', 'dir', 'cwd', 'baseSha', 'workspaceId', 'tid', 'tsession',
  'terminalAlive', 'agentGone', 'trustPending', 'state', 'promptMode', 'promptDelivered', 'promptDeliveredAt',
  'launchedAt', 'copiedFiles', 'diff', 'commits', 'dirty', 'pushed', 'pr', 'op', 'lastOp',
  'lastTurnEndedAt', 'lastActivityAt', 'reviewNotifiedAt', 'lastTurnFailed', 'error', 'cleanup',
  'createdAt', 'updatedAt'];

// ── 주입 ─────────────────────────────────────────────────────────────────────
const noop = () => {};
let inj = {
  notify: noop,          // ({taskIds, reason}) → cpt-server.notifyTasksChanged(300ms 코얼레싱은 그쪽)
  poolChanged: noop,     // 터미널 생성/삭제 뒤 클라 리컨실(여기서 500ms 코얼레싱)
  launch: null,          // ({cwd, index, id, args?, timeoutMs}) → {ok, busy?, ready?}
  chatInput: null,       // ({cwd, tid, text, submit})
  chatDialog: null,      // ({cwd, tid, pick, expect})
  screen: null,          // ({cwd, tid}) → 화면 문자열(capture) — extractDialog 입력
  backFetch: null,       // (method, apiPath, body) → json
  now: () => Date.now(),
  log: (m) => console.log(m),
  deviceId: () => null,
};
// 테스트가 tmux/pty 를 건드리지 않게 교체 가능한 의존(기본 = 실제 모듈, 지연 로드).
let depOverride = {};
function dep(name) {
  if (depOverride[name]) return depOverride[name];
  switch (name) {
    case 'pty': return require('./pty');
    case 'termBackend': return require('./term-backend');
    case 'agents': return require('./agents');
    case 'agentState': return require('./agent-state');
    case 'agentWatch': return require('./agent-watch');
    case 'statusLine': return require('./status-line');
    case 'fsLib': return require('./fs');
    case 'manifest': return require('./terminal-manifest');
    default: throw new Error('unknown dep ' + name);
  }
}
let timings = {
  trustWindowMs: 20000, trustPollMs: 500, trustPendingPollMs: 5000,
  readyTimeoutMs: 30000, readyPollMs: 250, readyStableMs: 2000,
  stopDebounceMs: 1500, poolCoalesceMs: 500, shouldNotifyMaxMs: 3000,
  launchTimeoutMs: 12000,
};

function configure(opts = {}) {
  for (const k of ['notify', 'poolChanged', 'launch', 'chatInput', 'chatDialog', 'screen', 'backFetch', 'now', 'log', 'deviceId']) {
    if (opts[k] !== undefined) inj[k] = typeof opts[k] === 'function' ? opts[k] : (k === 'now' ? () => Date.now() : noop);
  }
  if (opts.deps && typeof opts.deps === 'object') depOverride = { ...depOverride, ...opts.deps };
  if (opts.timings && typeof opts.timings === 'object') timings = { ...timings, ...opts.timings };
  return module.exports;
}
const nowFn = () => inj.now();
const log = (m) => { try { inj.log(m); } catch (_) { /* noop */ } };
// 기다리는 sleep 은 unref 하지 않는다(기다리는 쪽이 있는 한 끝나야 한다). 배경 타이머만 unref.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── 경로 ─────────────────────────────────────────────────────────────────────
function rootReal() {
  const r = runtime.root();
  try { return fs.realpathSync(r); } catch (_) { return path.resolve(r); }
}
function worktreesDir() { return path.join(runtime.stateDir(), 'worktrees'); }
function promptsDir() { return path.join(runtime.stateDir(), 'tasks'); }
function storeFile() { return path.join(runtime.stateDir(), 'tasks.json'); }
function under(child, parent) { return child === parent || child.startsWith(parent + path.sep); }
function realish(p) {
  try { return fs.realpathSync(p); } catch (_) {
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_2) { return path.resolve(p); }
  }
}
/** 홈-기준 상대경로(`/` 구분). 홈 밖이면 null. */
function relHome(abs) {
  const root = rootReal();
  const r = realish(abs);
  if (!under(r, root)) return null;
  return path.relative(root, r).split(path.sep).join('/');
}
function absHome(rel) { return path.join(rootReal(), ...String(rel || '').split('/')); }

// §2.2 — worktree·프롬프트 루트가 홈 jail 안이어야 한다. 아니면 task.v1 을 광고하지 않고 TASKS_DISABLED.
//  (`sessionForCwd` 가 jail 밖 경로를 홈으로 폴백해 엉뚱한 세션에 붙는 사고를 막는다.)
let enabledCache = { key: null, val: false };
function enabled() {
  const key = `${runtime.root()}|${runtime.stateDir()}`;
  if (enabledCache.key === key) return enabledCache.val;
  let val = false;
  try {
    const root = rootReal();
    const wt = realish(worktreesDir());
    const pr = realish(promptsDir());
    val = under(wt, root) && under(pr, root) && wt !== root;
  } catch (_) { val = false; }
  enabledCache = { key, val };
  return val;
}

// ── 스토어 ───────────────────────────────────────────────────────────────────
let mem = null;              // { items:[Task], createOps:[{opId,taskId,at}] }
let tsIndex = new Map();     // tsession → { taskId, runId }

function validTask(t) {
  return t && typeof t === 'object' && typeof t.id === 'string' && /^t_[0-9a-z]{10}$/.test(t.id)
    && t.repo && typeof t.repo.path === 'string' && Array.isArray(t.runs)
    && t.runs.every((r) => r && typeof r.id === 'string' && typeof r.dir === 'string');
}

function load() {
  if (mem) return mem;
  mem = { items: [], createOps: [] };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch (e) {
    if (e && e.code !== 'ENOENT') log(`[tasks] tasks.json 읽기 실패(빈 스토어로 시작): ${e.message}`);
  }
  if (raw && Array.isArray(raw.items)) {
    for (const t of raw.items) {
      if (validTask(t)) mem.items.push(t);
      else log(`[tasks] 깨진 작업 레코드 버림: ${t && t.id}`);
    }
    if (Array.isArray(raw.createOps)) mem.createOps = raw.createOps.filter((o) => o && typeof o.opId === 'string');
  }
  rebuildIndex();
  return mem;
}

function save() {
  const s = load();
  const file = storeFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: STORE_V, savedAt: nowFn(), items: s.items, createOps: s.createOps }), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`[tasks] tasks.json 저장 실패: ${e.message}`);
  }
  rebuildIndex();
}

/** 스토어 변이 창구 — 동기 load → fn → 동기 save(§2.12). */
function mutate(fn) {
  const s = load();
  const r = fn(s);
  save();
  return r;
}

function rebuildIndex() {
  const next = new Map();
  for (const t of (mem ? mem.items : [])) {
    for (const r of t.runs) if (r.tsession) next.set(r.tsession, { taskId: t.id, runId: r.id });
  }
  tsIndex = next;
}

function findTask(taskId) { return load().items.find((t) => t.id === taskId) || null; }
function mustTask(p) {
  if (typeof p.taskId !== 'string' || !p.taskId) throw codedError('BAD_PARAMS', 'taskId 가 필요합니다');
  const t = findTask(p.taskId);
  if (!t) throw codedError('TASK_NOT_FOUND', '작업을 찾을 수 없습니다');
  return t;
}
function mustRun(p) {
  const t = mustTask(p);
  if (typeof p.runId !== 'string' || !p.runId) throw codedError('BAD_PARAMS', 'runId 가 필요합니다');
  const r = t.runs.find((x) => x.id === p.runId);
  if (!r) throw codedError('RUN_NOT_FOUND', '실행을 찾을 수 없습니다');
  return { t, r };
}
function touch(t, r) { const n = nowFn(); if (r) r.updatedAt = n; if (t) t.updatedAt = n; }

// ── 이름 ─────────────────────────────────────────────────────────────────────
function rand36(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += (bytes[i] % 36).toString(36);
  return s;
}
/** repoSlug(§2.2) — NFKD → [a-z0-9] 만, 구분자 '-' 하나로 접기(`--` 금지), 최대 32자, 비면 'repo'. */
function repoSlug(name) {
  const s = String(name || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/g, '');
  return s || 'repo';
}
function t6Of(taskId) { return String(taskId).slice(-6); }
function wsNameOf(t, r) { return `${repoSlug(t.repo.name)}-${t6Of(t.id)}-${r.idx}`; }
function promptFile(t, r) { return path.join(promptsDir(), t.id, `${r.id}.prompt`); }
function wtAbs(r) { return absHome(r.dir); }
function repoTopAbs(t) { return absHome(t.repo.path); }

// ── 와이어 ───────────────────────────────────────────────────────────────────
const liveCache = new Map(); // runId → { terminalAlive, agentGone } — 응답 시점 계산 결과(영속 안 함)

function pickRun(r) {
  const out = {};
  const live = liveCache.get(r.id) || { terminalAlive: false, agentGone: false };
  for (const f of RUN_FIELDS) {
    if (f === 'terminalAlive' || f === 'agentGone') out[f] = !!live[f];
    else out[f] = r[f] === undefined ? null : r[f];
  }
  if (!Array.isArray(out.copiedFiles)) out.copiedFiles = [];
  out.trustPending = !!r.trustPending;
  out.promptDelivered = !!r.promptDelivered;
  out.dirty = !!r.dirty;
  out.pushed = !!r.pushed;
  out.lastTurnFailed = !!r.lastTurnFailed;
  return out;
}

function pickTask(t, { prompt = false } = {}) {
  const out = {};
  for (const f of TASK_FIELDS) out[f] = t[f] === undefined ? null : t[f];
  const repo = {};
  for (const f of REPO_FIELDS) repo[f] = t.repo[f] === undefined ? null : t.repo[f];
  out.repo = repo;
  if (prompt) out.prompt = t.prompt;
  out.runs = t.runs.map(pickRun);
  return out;
}

/** 응답 시점 계산(§2.11) — 세션 목록 1회 조회로 terminalAlive/agentGone 을 일괄 갱신. */
async function refreshLive(tasks) {
  // 조회할 터미널이 없으면 백엔드(tmux)에 아예 묻지 않는다.
  if (!tasks.some((t) => t.runs.some((r) => r.tsession && r.state !== 'merged' && r.state !== 'discarded'))) {
    for (const t of tasks) for (const r of t.runs) liveCache.set(r.id, { terminalAlive: false, agentGone: false });
    return;
  }
  let names = null;
  try { names = new Set((await dep('termBackend').listSessionNames()).map((s) => String(s).trim())); } catch (_) { names = null; }
  for (const t of tasks) {
    for (const r of t.runs) {
      if (!r.tsession || r.state === 'merged' || r.state === 'discarded' || !names) {
        liveCache.set(r.id, { terminalAlive: false, agentGone: false });
        continue;
      }
      const alive = names.has(r.tsession);
      let gone = false;
      if (alive) {
        let info = null;
        try { info = await dep('termBackend').info(r.tsession); } catch (_) { info = null; }
        const cmd = info ? String(info.command || '').trim() : '';
        let att = { attached: false };
        try { att = dep('agentState').attachmentOf(r.tsession) || att; } catch (_) { /* noop */ }
        gone = !!info && SHELLS.has(cmd) && !att.attached;
      }
      liveCache.set(r.id, { terminalAlive: alive, agentGone: gone });
    }
  }
}

// ── 통지 ─────────────────────────────────────────────────────────────────────
function emit(taskIds, reason) {
  try { inj.notify({ taskIds: [...new Set(taskIds.filter(Boolean))], reason }); } catch (_) { /* noop */ }
}
let poolTimer = null;
function poolChangedSoon() {
  if (poolTimer) return;
  poolTimer = setTimeout(() => {
    poolTimer = null;
    try { inj.poolChanged(); } catch (_) { /* noop */ }
  }, timings.poolCoalesceMs);
  if (poolTimer.unref) poolTimer.unref();
}

/** 알림(§3.4) — 제목은 일반 문구, 작업 제목·프롬프트·브랜치명은 싣지 않는다. */
async function pushNotification(t, r, kind, subtitle) {
  if (!inj.backFetch) return;
  const host = inj.deviceId();
  const label = AGENT_LABEL[r.agent] || r.agent;
  const title = kind === 'task_ready' ? `리뷰 준비 · ${label}` : kind === 'task_merged' ? `머지 완료 · ${label}` : `작업 실패 · ${label}`;
  const payload = {
    source: 'agent', kind, title, subtitle,
    cwd: r.cwd, win: r.tid != null ? r.tid : undefined, wsName: wsNameOf(t, r),
    deeplink: `codingpt://task/${t.id}?host=${host == null ? '' : host}&run=${r.id}`,
    workspaceId: r.workspaceId || undefined,
  };
  try { await inj.backFetch('POST', '/api/notifications', payload); } catch (e) {
    log(`[tasks] 알림 실패(${kind}): ${e && e.message}`);
  }
}

// ── 파라미터 검증 ────────────────────────────────────────────────────────────
function reqOpId(p) {
  const v = p.opId;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw codedError('BAD_PARAMS', 'opId(UUID)가 필요합니다');
  return v;
}
function reqString(p, k, max = 1024) {
  const v = p[k];
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw codedError('BAD_PARAMS', `${k} 가 필요합니다`);
  return v;
}
function validBranchName(b) {
  return typeof b === 'string' && b.length > 0 && b.length <= 200 && !b.startsWith('-') && !/[\s~^:?*[\\\x00-\x1f]/.test(b)
    && !b.includes('..') && !b.includes('@{') && !b.endsWith('/') && !b.endsWith('.lock') && !b.startsWith('/');
}

// 진행 중 비동기(생성·op·머지 후 정리) — 테스트의 _drain 이 기다린다. 프로덕션 동작에는 영향 없음.
const opPromises = new Set();
function track(p) {
  opPromises.add(p);
  p.finally(() => opPromises.delete(p)).catch(() => {});
  return p;
}

// ── 저장소 락(§2.12) — worktree add/remove, merge.local, fetch base 직렬화 ─────
const repoLocks = new Map(); // common → Promise
async function withRepoLock(key, fn) {
  const prev = repoLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const chain = prev.then(() => gate);
  repoLocks.set(key, chain);
  await prev.catch(() => {});
  try { return await fn(); } finally {
    release();
    if (repoLocks.get(key) === chain) repoLocks.delete(key);
  }
}

// ── 실행 상태 헬퍼 ───────────────────────────────────────────────────────────
function liveWorking(r) {
  if (!r.tsession) return false;
  try { return dep('agentState').rawStateOf(r.tsession) === 'working'; } catch (_) { return false; }
}

function failRun(t, r, code, message, { notifyPush = true } = {}) {
  r.state = 'failed';
  r.error = { code, message: String(message || FAIL_TEXT[code] || '실패했어요').slice(0, 300) };
  touch(t, r);
  save();
  emit([t.id], 'failed');
  if (notifyPush) pushNotification(t, r, 'task_failed', FAIL_TEXT[code] || '실패했어요').catch(() => {});
}

function maybeCloseTask(t) {
  if (t.state === 'open' && t.runs.length && t.runs.every((r) => r.state === 'discarded')) {
    t.state = 'closed';
    t.closedAt = nowFn();
    touch(t);
  }
}

// ── 작업 생성(§2.5) ──────────────────────────────────────────────────────────
const createInflight = new Map(); // opId → Promise

async function rpcCreate(p) {
  const opId = reqOpId(p);
  const s = load();
  const prev = s.createOps.find((o) => o.opId === opId);
  if (prev) {
    const t = findTask(prev.taskId);
    if (t) { await refreshLive([t]); return { task: pickTask(t), replay: true }; }
  }
  if (createInflight.has(opId)) {
    const r = await createInflight.get(opId);
    return { ...r, replay: true };
  }
  const pr = createSync(p, opId);
  createInflight.set(opId, pr);
  try { return await pr; } finally { createInflight.delete(opId); }
}

async function createSync(p, opId) {
  // 1. 파라미터 검증
  const repoParam = reqString(p, 'repo');
  const base = p.base;
  if (!validBranchName(base)) throw codedError('BAD_PARAMS', 'base 브랜치 이름이 올바르지 않습니다');
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw codedError('BAD_PARAMS', '프롬프트가 필요합니다');
  if (Buffer.byteLength(p.prompt, 'utf8') > PROMPT_MAX_BYTES) throw codedError('PROMPT_TOO_LARGE', '프롬프트가 너무 깁니다(30,000 바이트까지)');
  if (p.title != null && (typeof p.title !== 'string' || p.title.length > TITLE_MAX)) throw codedError('BAD_PARAMS', 'title 이 올바르지 않습니다');
  if (!Array.isArray(p.agents) || !p.agents.length) throw codedError('BAD_PARAMS', '에이전트를 1개 이상 선택하세요');
  const agentList = [];
  for (const a of p.agents) {
    const id = a && typeof a.id === 'string' ? a.id : '';
    const count = a && a.count == null ? 1 : a && a.count;
    if (!TASK_AGENTS.has(id)) throw codedError('BAD_PARAMS', `작업에 쓸 수 없는 에이전트입니다: ${id}`);
    if (!Number.isInteger(count) || count < 1 || count > RUNS_PER_TASK_MAX) throw codedError('BAD_PARAMS', 'count 는 1~4 입니다');
    for (let i = 0; i < count; i++) agentList.push(id);
  }
  if (agentList.length > RUNS_PER_TASK_MAX) throw codedError('TASK_LIMIT', '한 작업에 실행은 최대 4개입니다');
  if (p.workspaceId != null && typeof p.workspaceId !== 'string') throw codedError('BAD_PARAMS', 'workspaceId 가 올바르지 않습니다');
  const copyEnv = p.copyEnv !== false;
  const doFetch = p.fetch === true;

  const tools = await taskGit.baseTools(); // git 만 필요 — gh 인증 조사(네트워크)를 기다리지 않는다
  if (!tools.git.ok) throw codedError(tools.git.error || 'GIT_MISSING', tools.git.error === 'GIT_CLT_MISSING' ? 'Xcode 명령줄 도구가 필요합니다' : '이 PC 에 git 이 없습니다');

  let repoAbs;
  try { repoAbs = dep('fsLib').safeResolve(repoParam); } catch (_) { throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다'); }
  let st = null;
  try { st = fs.statSync(repoAbs); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  const info = await taskGit.repoInfo(repoAbs);
  if (!info) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  const topRel = relHome(info.top);
  const commonRel = relHome(info.common);
  if (topRel == null || commonRel == null) throw codedError('NOT_A_REPO', '홈 폴더 밖의 저장소는 쓸 수 없습니다');
  // worktree 안의 worktree 를 저장소로 고르는 것은 막는다(작업 워크스페이스는 셀렉터에서 숨겨지지만 방어).
  if (under(realish(info.top), realish(worktreesDir()))) throw codedError('NOT_A_REPO', '작업 폴더는 저장소로 쓸 수 없습니다');

  // 2. base
  const localSha = await taskGit.refExists(info.top, `refs/heads/${base}`);
  const remoteSha = localSha ? null : await taskGit.refExists(info.top, `refs/remotes/origin/${base}`);
  if (!localSha && !remoteSha) throw codedError('BASE_NOT_FOUND', 'base 브랜치를 찾을 수 없습니다');

  // 3. 상한 + 에이전트 설치
  const s = load();
  const openSameRepo = s.items.filter((t) => t.state === 'open' && t.repo.common === commonRel).length;
  if (openSameRepo >= OPEN_TASKS_PER_REPO_MAX) throw codedError('TASK_LIMIT', '이 저장소의 동시 작업 수를 넘었습니다');
  const activeRuns = s.items.reduce((n, t) => n + t.runs.filter((r) => ACTIVE_RUN_STATES.has(r.state)).length, 0);
  if (activeRuns + agentList.length > OPEN_RUNS_MAX) throw codedError('TASK_LIMIT', '동시에 실행할 수 있는 작업 수를 넘었습니다');
  const installed = await dep('agents').list({ version: false });
  for (const id of new Set(agentList)) {
    const hit = installed.find((a) => a.id === id);
    if (!hit || !hit.installed) throw codedError('AGENT_NOT_INSTALLED', `${AGENT_LABEL[id] || id} 이 이 PC 에 없습니다`);
  }

  // 4. 레코드 생성
  const now = nowFn();
  let id;
  do { id = 't_' + rand36(10); } while (findTask(id));
  const t6 = t6Of(id);
  const name = path.basename(info.top);
  const slug = repoSlug(name);
  const title = (typeof p.title === 'string' && p.title.trim())
    ? p.title.trim()
    : p.prompt.trim().split('\n')[0].trim().slice(0, 60);
  const catalog = dep('agents').CATALOG || [];
  const task = {
    id, v: 1, title, prompt: p.prompt,
    repo: {
      path: topRel, subdir: info.subdir, common: commonRel, name,
      remoteUrl: await taskGit.remoteUrl(info.top), github: null,
    },
    base, workspaceId: p.workspaceId || null, state: 'open', winnerRunId: null, error: null,
    createdAt: now, updatedAt: now, closedAt: null,
    opts: { copyEnv, fetch: doFetch },
    runs: agentList.map((agent, i) => {
      const idx = i + 1;
      const dirAbs = path.join(worktreesDir(), `${slug}-${t6}-${idx}`);
      const dir = relHome(dirAbs);
      const spec = catalog.find((c) => c.id === agent);
      return {
        id: 'r_' + rand36(8), idx, agent,
        branch: `cpt/${t6}-${idx}`, dir, cwd: info.subdir ? `${dir}/${info.subdir}` : dir,
        baseSha: null, workspaceId: null, tid: null, tsession: null,
        trustPending: false, state: 'creating',
        promptMode: spec && spec.promptArg ? 'arg' : 'paste',
        promptDelivered: false, promptDeliveredAt: null, launchedAt: null, copiedFiles: [],
        diff: null, commits: null, dirty: false, pushed: false, pr: null, op: null, lastOp: null,
        lastTurnEndedAt: null, lastActivityAt: now, reviewNotifiedAt: null, lastTurnFailed: false,
        error: null, cleanup: null, createdAt: now, updatedAt: now, opIds: [],
      };
    }),
  };
  // 프롬프트 파일(0600, 디렉토리 0700) — 런치 인자는 이 파일을 cat 한다(내용은 셸 평가를 거치지 않는다).
  const pdir = path.join(promptsDir(), id);
  fs.mkdirSync(pdir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(pdir, 0o700); } catch (_) { /* noop */ }
  for (const r of task.runs) {
    const f = promptFile(task, r);
    fs.writeFileSync(f, task.prompt, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch (_) { /* noop */ }
  }
  mutate((st2) => {
    st2.items.push(task);
    st2.createOps.push({ opId, taskId: id, at: now });
    if (st2.createOps.length > CREATE_OPS_KEEP) st2.createOps.splice(0, st2.createOps.length - CREATE_OPS_KEEP);
  });
  emit([id], 'created');
  log(`[tasks] 작업 생성 ${id} runs=${task.runs.length}`);
  // 비동기 구간 — 회신을 붙잡지 않는다.
  track(runCreate(task).catch((e) => log(`[tasks] ${id} 생성 비동기 실패: ${e && e.message}`)));
  for (const r of task.runs) liveCache.set(r.id, { terminalAlive: false, agentGone: false });
  return { task: pickTask(task) };
}

/** 5~6 단계(저장소 락) — fetch + 시작점 결정 + worktree add. 실패한 run 은 failed. */
async function addWorktrees(t, runs) {
  const top = repoTopAbs(t);
  await withRepoLock(t.repo.common, async () => {
    let fetched = false;
    if (t.opts && t.opts.fetch) {
      const f = await taskGit.git(['fetch', 'origin', t.base], { cwd: top, timeout: 60000 });
      fetched = f.ok;
      if (!f.ok) log(`[tasks] ${t.id} fetch 실패(로컬 base 로 진행)`);
    }
    let startPoint = null;
    if (fetched && await taskGit.refExists(top, `refs/remotes/origin/${t.base}`)) startPoint = `refs/remotes/origin/${t.base}`;
    else if (await taskGit.refExists(top, `refs/heads/${t.base}`)) startPoint = `refs/heads/${t.base}`;
    else if (await taskGit.refExists(top, `refs/remotes/origin/${t.base}`)) startPoint = `refs/remotes/origin/${t.base}`;
    const baseSha = startPoint ? await taskGit.refExists(top, startPoint) : null;
    for (const r of runs) {
      if (!baseSha) { failRun(t, r, 'BASE_NOT_FOUND', 'base 브랜치를 찾을 수 없습니다'); continue; }
      try {
        fs.mkdirSync(worktreesDir(), { recursive: true });
        await taskGit.worktreeAdd(top, { branch: r.branch, absDir: wtAbs(r), startPoint: baseSha });
        r.baseSha = baseSha;
        r.error = null;
        touch(t, r);
        save();
      } catch (e) {
        failRun(t, r, e.code === 'TIMEOUT' ? 'WORKTREE_ADD_FAILED' : (e.code || 'WORKTREE_ADD_FAILED'), e.message);
      }
    }
  });
}

async function runCreate(t) {
  const runs = t.runs.filter((r) => r.state === 'creating');
  await addWorktrees(t, runs);
  emit([t.id], 'run');
  const ok = runs.filter((r) => r.state === 'creating');
  await resumePrepared(t, ok);
  ensureGithub(t).catch(() => {});
}

/** 7~9 단계(병렬) → poolChanged 1회 → 10~11 단계(병렬). reconcile 의 creating 재개도 여기로 온다. */
async function resumePrepared(t, runs) {
  await Promise.all(runs.map((r) => prepareRun(t, r).catch((e) => failRun(t, r, e.code || 'AGENT_LAUNCH_FAILED', e.message))));
  const withTerm = runs.filter((r) => r.state === 'creating' && r.tid != null);
  if (withTerm.length) poolChangedSoon();
  await Promise.all(withTerm.map((r) => launchRun(t, r, { withPrompt: true }).catch((e) => failRun(t, r, 'AGENT_LAUNCH_FAILED', e.message))));
}

async function prepareRun(t, r) {
  const top = repoTopAbs(t);
  if (!t.opts || t.opts.copyEnv !== false) {
    try { r.copiedFiles = await taskGit.copyEnvFiles(top, t.repo.subdir, wtAbs(r)); } catch (_) { r.copiedFiles = r.copiedFiles || []; }
  }
  await registerWorkspace(t, r);
  await createRunTerminal(t, r);
  touch(t, r);
  save();
}

async function registerWorkspace(t, r) {
  if (r.workspaceId || !inj.backFetch) return;
  r.wsTriedAt = nowFn();
  try {
    const host = inj.deviceId();
    const res = await inj.backFetch('POST', '/api/daemon/workspaces', {
      name: wsNameOf(t, r), compute: 'local', localPath: r.cwd,
      ...(host != null ? { hostDeviceId: host } : {}),
      remoteUrl: null, stack: null,
    });
    const wid = res && (res.id || (res.workspace && res.workspace.id));
    r.workspaceId = wid != null ? String(wid) : null;
  } catch (e) {
    r.workspaceId = null;  // 치명 아님 — reconcile/목록 조회가 재시도
    log(`[tasks] ${t.id}/${r.id} 워크스페이스 등록 실패: ${e && e.message}`);
  }
}

async function createRunTerminal(t, r) {
  const pty = dep('pty');
  const { session, abs } = pty.sessionForCwd(r.cwd);
  if (session === 'codingpt') throw codedError('WORKTREE_MISSING', '작업 폴더를 찾을 수 없습니다');
  // 재개(reconcile creating → prepareRun) — 앞선 기동이 이미 만든 터미널이 tmux 에 살아 있으면 그대로 쓴다
  //  (새로 만들면 첫 셸 터미널이 풀에 고아로 남는다).
  if (r.tid != null && r.tsession) {
    let alive = false;
    try { alive = (await dep('termBackend').listSessionNames()).includes(r.tsession); } catch (_) { alive = false; }
    if (alive) {
      liveCache.set(r.id, { terminalAlive: true, agentGone: false });
      rebuildIndex();
      return;
    }
  }
  const term = await pty.createTerminal(session, abs);
  r.tid = term.index;
  r.tsession = term.session || pty.termSession(session, term.index);
  try { await dep('termBackend').rename(r.tsession, `${r.agent} #${r.idx}`); } catch (_) { /* 이름은 장식 */ }
  liveCache.set(r.id, { terminalAlive: true, agentGone: false });
  rebuildIndex();
}

/** 런치 인자(§2.5 10) — 셸 판정은 pane command 로. 만들 수 없으면 null(→ paste 경로). */
async function promptArgsFor(t, r) {
  const spec = (dep('agents').CATALOG || []).find((c) => c.id === r.agent);
  const pa = spec && spec.promptArg;
  if (!pa) return null;
  const file = promptFile(t, r);
  if (/['\n\r]/.test(file)) return null;
  // `-` 로 시작하는 프롬프트는 CLI 옵션으로 오해된다 — 위치 인자는 `--` 로 끊고, 플래그형은 paste 로 보낸다.
  const dash = /^\s*-/.test(t.prompt || '');
  if (dash && !pa.positional) return null;
  let cmd = '';
  try { cmd = String((await dep('termBackend').info(r.tsession)).command || '').trim(); } catch (_) { cmd = ''; }
  const fish = /(^|\/)-?fish$/.test(cmd);
  const sub = fish ? `(cat '${file}' | string collect)` : `"$(cat '${file}')"`;
  if (pa.positional) return dash ? ['--', sub] : [sub];
  return [pa.flag, sub];
}

/**
 * 10·10b·11 단계 — 런치 → (arg) 즉시 running / (paste) 준비 판정 뒤 붙여넣기 → 신뢰 다이얼로그 감시.
 *  withPrompt=false 면 재실행(reopen) — resumeArgs 로 대화를 잇는다.
 */
async function launchRun(t, r, { withPrompt }) {
  if (!inj.launch) throw codedError('AGENT_LAUNCH_FAILED', '에이전트 실행기가 없습니다');
  r.state = 'launching';
  r.launchedAt = nowFn();
  r.error = null;
  touch(t, r);
  save();
  emit([t.id], 'run');
  let args;
  let mode = 'resume';
  if (withPrompt) {
    args = r.promptMode === 'arg' ? await promptArgsFor(t, r) : null;
    if (r.promptMode === 'arg' && !args) r.promptMode = 'paste';
    mode = r.promptMode;
  } else {
    const spec = (dep('agents').CATALOG || []).find((c) => c.id === r.agent);
    args = spec && Array.isArray(spec.resumeArgs) ? spec.resumeArgs.slice() : undefined;
  }
  let res;
  try {
    res = await inj.launch({ cwd: r.cwd, index: r.tid, id: r.agent, ...(args && args.length ? { args } : {}), timeoutMs: timings.launchTimeoutMs });
  } catch (e) {
    failRun(t, r, 'AGENT_LAUNCH_FAILED', e && e.message);
    return;
  }
  if (res && res.busy) { failRun(t, r, 'LAUNCH_BUSY', '터미널에서 다른 명령이 실행 중입니다'); return; }
  r.state = 'running';
  r.lastActivityAt = nowFn();
  if (mode === 'arg') { r.promptDelivered = true; r.promptDeliveredAt = nowFn(); }
  touch(t, r);
  save();
  emit([t.id], 'run');
  startTrustWatch(t, r);
  if (mode === 'paste') {
    const ok = await waitAgentReady(r, { timeoutMs: timings.readyTimeoutMs, since: r.launchedAt });
    if (ok) await deliverPrompt(t, r, t.prompt);
    else {
      r.promptDelivered = false;
      r.error = { code: 'PROMPT_NOT_DELIVERED', message: '프롬프트가 전달되지 않았어요' };
      touch(t, r); save(); emit([t.id], 'run');
    }
  }
}

async function deliverPrompt(t, r, text) {
  if (!inj.chatInput) throw codedError('PROMPT_NOT_DELIVERED', '입력 경로가 없습니다');
  await inj.chatInput({ cwd: r.cwd, tid: r.tid, text, submit: true });
  r.promptDelivered = true;
  r.promptDeliveredAt = nowFn();
  if (r.error && r.error.code === 'PROMPT_NOT_DELIVERED') r.error = null;
  if (r.state === 'review_ready') r.state = 'running';
  touch(t, r); save(); emit([t.id], 'run');
}

/**
 * "에이전트 준비됨" 판정(§2.5 11) — 정확히 다음 셋 중 하나:
 *  (a) attachment attached && rawState !== 'launching'  (b) launchedAt 이후 SessionStart 도착
 *  (c) agentSignalOf(on) && pane command 가 셸 아님 && 선택 화면 없음 이 2s 유지.
 *  ★ 셸에 그냥 타이핑하지 않는다 — 준비가 안 되면 false(호출측이 PROMPT_NOT_DELIVERED).
 */
async function waitAgentReady(r, { timeoutMs, since }) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = null;
  for (;;) {
    const key = r.tsession;
    if (key) {
      // ★ 전경 명령이 셸(또는 알 수 없음)이면 (a)(b)(c) 어느 것도 "준비" 가 아니다 — 재부팅 복원된 빈 zsh·
      //   /exit 뒤의 셸에 프롬프트를 붙여넣으면 셸 명령으로 실행된다. sessionStartedAt 은 과거 기록일 수 있다.
      let info = null;
      try { info = await dep('termBackend').info(key); } catch (_) { info = null; }
      const cmd = info ? String(info.command || '').trim() : '';
      const agentFg = !!(info && cmd && !SHELLS.has(cmd));
      let att = { attached: false };
      let raw = null;
      try { att = dep('agentState').attachmentOf(key) || att; raw = dep('agentState').rawStateOf(key); } catch (_) { /* noop */ }
      if (agentFg && att.attached && raw != null && raw !== 'launching') return true;
      if (agentFg && r.sessionStartedAt && since && r.sessionStartedAt >= since) return true;
      let good = false;
      if (agentFg) {
        let sig = null;
        try { sig = dep('agentWatch').agentSignalOf(key, cmd, info.title || ''); } catch (_) { sig = null; }
        if (sig && sig.on === true) {
          const scr = await readScreen(r);
          if (scr != null && !dep('statusLine').extractDialog(scr)) good = true;
        }
      }
      if (good) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= timings.readyStableMs) return true;
      } else stableSince = null;
    }
    if (Date.now() >= deadline) return false;
    await sleep(timings.readyPollMs);
  }
}

async function readScreen(r) {
  if (!inj.screen || r.tid == null) return null;
  try {
    const s = await inj.screen({ cwd: r.cwd, tid: r.tid });
    if (s && typeof s === 'object') return typeof s.text === 'string' ? s.text : null;
    return typeof s === 'string' ? s : null;
  } catch (_) { return null; }
}

function trustDialogOf(screen) {
  if (screen == null) return null;
  const d = dep('statusLine').extractDialog(screen);
  if (!d) return null;
  // extractDialog 의 title 은 "옵션 바로 위 블록" 이라 claude 의 신뢰 화면에서는 폴더 경로가 된다
  //  (`Do you trust the files in this folder?` 는 그 위 블록). 그래서 선택 화면 아래쪽 30줄도 함께 본다.
  const tail = String(screen).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').split('\n').slice(-30).join('\n');
  const hay = [d.title, d.desc, ...(d.options || []).map((o) => o.label), tail].join('\n');
  return TRUST_DIALOG_RE.test(hay) ? d : null;
}

// ── 폴더 신뢰 감시(§2.5 10b) ─────────────────────────────────────────────────
const trustTimers = new Map(); // runId → timer
function stopTrustWatch(r) {
  const tm = trustTimers.get(r.id);
  if (tm) { clearTimeout(tm); trustTimers.delete(r.id); }
}
function startTrustWatch(t, r) {
  stopTrustWatch(r);
  const until = Date.now() + timings.trustWindowMs;
  const tick = async () => {
    trustTimers.delete(r.id);
    if (r.state !== 'running' && r.state !== 'review_ready') return;
    const d = trustDialogOf(await readScreen(r));
    if (d && !r.trustPending) {
      r.trustPending = true;
      r.trustTitle = d.title;
      r.lastActivityAt = nowFn();
      touch(t, r); save(); emit([t.id], 'run');
    } else if (!d && r.trustPending) {
      // 사용자가 터미널에서 직접 답했다.
      r.trustPending = false;
      r.trustTitle = null;
      touch(t, r); save(); emit([t.id], 'run');
      return;
    }
    if (r.trustPending) schedule(timings.trustPendingPollMs);
    else if (Date.now() < until) schedule(timings.trustPollMs);
  };
  const schedule = (ms) => {
    const tm = setTimeout(() => { tick().catch(() => {}); }, ms);
    if (tm.unref) tm.unref();
    trustTimers.set(r.id, tm);
  };
  schedule(timings.trustPollMs);
}

// ── review_ready 판정(§2.7) ──────────────────────────────────────────────────
const refreshing = new Map(); // runId → { promise, again }

/** refreshRun — run 당 1개만 진행, 겹치면 마지막 요청만 재실행(§2.9). */
function refreshRun(t, r) {
  const cur = refreshing.get(r.id);
  if (cur) { cur.again = true; return cur.promise; }
  const st = { again: false, promise: null };
  st.promise = (async () => {
    do {
      st.again = false;
      await doRefresh(t, r);
    } while (st.again);
  })().finally(() => { refreshing.delete(r.id); });
  refreshing.set(r.id, st);
  return st.promise;
}

async function doRefresh(t, r) {
  if (!r.baseSha || !fs.existsSync(wtAbs(r))) return;
  const s = await taskGit.runStat(wtAbs(r), r.baseSha);
  const at = nowFn();
  r.dirty = s.dirty;
  r.diff = { ...s.diff, at };
  r.commits = { ahead: s.ahead, at };
  r.pushed = s.pushed;
  touch(t, r);
  save();
  emit([t.id], 'diff');
}

function hasChanges(r) {
  return !!((r.diff && r.diff.files > 0) || (r.commits && r.commits.ahead > 0));
}

/** 턴 종료 평가 — 변경 있으면 review_ready + task_ready(턴당 1회). 멱등(여러 경로가 불러도 알림 1건). */
async function evaluateTurn(t, r, { notify }) {
  await refreshRun(t, r);
  const changed = hasChanges(r);
  if (changed && r.state === 'running') r.state = 'review_ready';
  let fire = false;
  if (changed && notify && r.state === 'review_ready'
    && (!r.reviewNotifiedAt || r.reviewNotifiedAt < (r.lastTurnEndedAt || 0))) {
    r.reviewNotifiedAt = nowFn();
    fire = true;
  }
  touch(t, r);
  save();
  emit([t.id], 'run');
  if (fire) await pushNotification(t, r, 'task_ready', `${repoSlug(t.repo.name)} · 파일 ${r.diff ? r.diff.files : 0}개`);
  return changed;
}

const turnTimers = new Map(); // runId → timer
function scheduleTurnEval(t, r, opts) {
  const old = turnTimers.get(r.id);
  if (old) clearTimeout(old);
  const tm = setTimeout(() => {
    turnTimers.delete(r.id);
    evaluateTurn(t, r, opts).catch((e) => log(`[tasks] ${r.id} 턴 평가 실패: ${e && e.message}`));
  }, timings.stopDebounceMs);
  if (tm.unref) tm.unref();
  turnTimers.set(r.id, tm);
}

function runByKey(key) {
  const hit = tsIndex.get(String(key || ''));
  if (!hit) return null;
  const t = findTask(hit.taskId);
  const r = t && t.runs.find((x) => x.id === hit.runId);
  return t && r ? { t, r } : null;
}

/** agent-state 구독자(§2.7 전이표). 동기 콜백 — 무거운 일은 타이머/비동기로 넘긴다. */
function onAgentState(rec, prev, ctx) {
  const hit = runByKey(rec && rec.key);
  if (!hit) return;
  const { t, r } = hit;
  if (r.state === 'merged' || r.state === 'discarded') return;
  const ev = ctx && ctx.ev;
  const now = nowFn();
  if (ev === 'session_start') { r.sessionStartedAt = now; save(); }
  // 세션이 끝났으면(session_end·셸 복귀·프로세스 종료) "SessionStart 도착" 은 더 이상 준비 근거가 아니다.
  if (rec.state === 'ended' && r.sessionStartedAt) { r.sessionStartedAt = null; save(); }
  if (rec.state === 'working' && prev !== 'working') {
    if (r.state === 'review_ready') r.state = 'running';
    // 재조정이 failed(OP_INTERRUPTED 등)로 접었지만 에이전트가 실제로 살아 일하고 있다 → running 으로 되살린다.
    if (r.state === 'failed' && r.dir && fs.existsSync(wtAbs(r))) { r.state = 'running'; r.error = null; }
    r.lastActivityAt = now;
    if (r.trustPending) { r.trustPending = false; r.trustTitle = null; stopTrustWatch(r); }
    touch(t, r); save(); emit([t.id], 'run');
    return;
  }
  const watchIdle = rec.source === 'watch' && prev === 'working' && rec.state === 'idle';
  if ((ev === 'stop' && rec.state === 'idle') || ev === 'stop_failure' || watchIdle) {
    r.lastTurnEndedAt = now;
    r.lastTurnFailed = ev === 'stop_failure';
    r.lastActivityAt = now;
    touch(t, r); save();
    scheduleTurnEval(t, r, { notify: ev !== 'stop_failure' });
    return;
  }
  if (rec.state === 'ended' && prev !== 'ended') {
    // 턴 도중 종료(크래시·강제 종료) = 그 턴의 끝이다. 유휴 중 /exit 는 새 턴이 아니다(같은 변경 재알림 금지).
    if (prev === 'working') { r.lastTurnEndedAt = now; r.lastActivityAt = now; touch(t, r); save(); }
    scheduleTurnEval(t, r, { notify: true });
    return;
  }
  if ((rec.state === 'permission' || rec.state === 'needsInput') && prev !== rec.state) {
    r.lastActivityAt = now;
    touch(t, r); save(); emit([t.id], 'run');
  }
}

/**
 * agent-state 알림 거부권(§2.7) — run 터미널의 done 은 "변경 있음" 이면 task_ready 로 대체한다.
 *  판정 전에 diff 를 새로 센다(캐시된 값은 턴 전의 것이다). 3초 안에 못 끝나면 캐시로 판정.
 */
function shouldNotify(rec, kind) {
  if (kind !== 'done') return true;
  const hit = runByKey(rec && rec.key);
  if (!hit) return true;
  const { t, r } = hit;
  let capTimer = null;
  // ★ done 을 막는 건 "이번 턴을 task_ready 가 덮었을 때" 뿐이다 — 변경이 있어도 run 이 failed 등이라
  //   task_ready 가 안 나가면 done 을 통과시킨다(아무 알림도 없는 턴 방지).
  const covered = () => !!(r.reviewNotifiedAt && r.reviewNotifiedAt >= (r.lastTurnEndedAt || 0) && r.state === 'review_ready');
  const predicted = () => hasChanges(r) && (r.state === 'running' || r.state === 'review_ready');
  const work = evaluateTurn(t, r, { notify: true }).then(() => !covered()).catch(() => !predicted());
  const cap = new Promise((res) => {
    capTimer = setTimeout(() => res(!(covered() || predicted())), timings.shouldNotifyMaxMs);
    if (capTimer.unref) capTimer.unref();
  });
  return Promise.race([work, cap]).finally(() => clearTimeout(capTimer));
}

// ── 비동기 op(§2.12) ─────────────────────────────────────────────────────────
const OP_DEADLINE = {
  commit: 5 * 60 * 1000, push: 3 * 60 * 1000, 'pr.create': 5 * 60 * 1000, 'pr.merge': 3 * 60 * 1000,
  'merge.local': 3 * 60 * 1000, discard: 3 * 60 * 1000, reopen: 2 * 60 * 1000, cleanup: 5 * 60 * 1000,
};
const KEEP_OP = Symbol('keepOp');

function recordOpId(r, opId, outcome) {
  if (!Array.isArray(r.opIds)) r.opIds = [];
  const hit = r.opIds.find((o) => o.opId === opId);
  if (hit) { hit.outcome = outcome; hit.at = nowFn(); } else r.opIds.push({ opId, at: nowFn(), outcome });
  if (r.opIds.length > OP_IDS_KEEP) r.opIds.splice(0, r.opIds.length - OP_IDS_KEEP);
}
function replayFor(r, opId) {
  const hit = Array.isArray(r.opIds) && r.opIds.find((o) => o.opId === opId);
  if (!hit) return null;
  if (hit.outcome === 'running') return { accepted: true, opId, replay: true, run: pickRun(r) };
  const lastOp = r.lastOp && r.lastOp.opId === opId ? r.lastOp : { opId, kind: null, ok: hit.outcome === 'ok', code: null, message: null, result: null, at: hit.at };
  return { accepted: true, opId, replay: true, run: pickRun(r), lastOp };
}

/** 사전검사(동기) — 상태·락·에이전트 작업 중. */
function opGuard(t, r, kind, { states, agentBusy }) {
  if (r.op) throw codedError('RUN_BUSY', '다른 작업이 진행 중입니다');
  if (r.state === 'creating' || r.state === 'launching' || r.state === 'merging') throw codedError('RUN_BUSY', '다른 작업이 진행 중입니다');
  if (r.state === 'merged' || r.state === 'discarded') throw codedError('TASK_CLOSED', '이미 종료된 실행입니다');
  if (kind !== 'discard' && t.state !== 'open') throw codedError('TASK_CLOSED', '이미 종료된 작업입니다');
  if (states && !states.includes(r.state)) throw codedError('RUN_BUSY', '지금 상태에서는 할 수 없습니다');
  if (agentBusy && liveWorking(r)) throw codedError('AGENT_BUSY', '에이전트가 아직 작업 중입니다');
}

function beginOp(t, r, opId, kind) {
  r.op = { opId, kind, startedAt: nowFn() };
  recordOpId(r, opId, 'running');
  touch(t, r); save(); emit([t.id], 'op');
}

function endOp(t, r, opId, kind, out) {
  r.lastOp = { opId, kind, ok: !!out.ok, code: out.code || null, message: out.message || null, result: out.result == null ? null : out.result, at: nowFn() };
  if (r.op && r.op.opId === opId && !out.keep) r.op = null;
  recordOpId(r, opId, out.ok ? 'ok' : 'error');
  touch(t, r); save(); emit([t.id], 'op');
}

/** op 실행 — body({t, r, deadline}) 의 반환: 결과 객체 | {[KEEP_OP]:true, ...lastOp 필드}(본문이 lastOp 를 직접 관리). */
function runOp(t, r, opId, kind, body) {
  beginOp(t, r, opId, kind);
  const deadline = Date.now() + (OP_DEADLINE[kind] || 3 * 60 * 1000);
  const p = (async () => {
    try {
      const res = await body({ t, r, deadline });
      if (res && res[KEEP_OP]) return;           // 본문이 lastOp/op 를 이미 기록(머지 완료 경로)
      if (res && res.opFailed) endOp(t, r, opId, kind, { ok: false, code: res.code, message: res.message, result: res.result });
      else endOp(t, r, opId, kind, { ok: true, result: res == null ? null : res });
    } catch (e) {
      const code = (e && e.code && ERROR_CODES.includes(e.code)) ? e.code : 'GH_ERROR';
      endOp(t, r, opId, kind, {
        ok: false, code, message: String((e && e.message) || e).slice(0, 300),
        result: e && e.stderrTail ? { stderrTail: e.stderrTail } : null,
      });
    }
  })();
  track(p);
  return { accepted: true, opId, run: pickRun(r) };
}

async function startRunOp(p, kind, { states, agentBusy = true }, body) {
  const opId = reqOpId(p);
  const { t, r } = mustRun(p);
  const rep = replayFor(r, opId);
  if (rep) return rep;
  opGuard(t, r, kind, { states, agentBusy });
  return runOp(t, r, opId, kind, body);
}

// ── git 변이 ─────────────────────────────────────────────────────────────────
async function freshStatus(t, r) {
  if (!fs.existsSync(wtAbs(r))) throw codedError('WORKTREE_MISSING', '작업 폴더가 사라졌습니다');
  await refreshRun(t, r);
  return r;
}

async function doCommit(t, r, { message, noVerify, deadline }) {
  const res = await taskGit.commit(wtAbs(r), { message, noVerify, exclude: r.copiedFiles || [], deadline });
  await refreshRun(t, r);
  return res;
}

async function ensureGithub(t, { required } = {}) {
  if (t.repo.github) return t.repo.github;
  if (!required) {
    const tl = taskGit.toolsCached();
    if (!tl || !tl.gh.authenticated || !t.repo.remoteUrl) return null;
  }
  if (!t.repo.remoteUrl && required) throw codedError('NOT_GITHUB', '원격 저장소가 없습니다');
  const run = t.runs.find((r) => fs.existsSync(wtAbs(r)));
  const cwd = run ? wtAbs(run) : repoTopAbs(t);
  try {
    const gh = await taskGit.githubRepo(cwd);
    t.repo.github = gh;
    touch(t); save(); emit([t.id], 'pr');
    return gh;
  } catch (e) {
    if (required) throw e;
    return null;
  }
}

async function doPush(t, r, deadline) {
  const res = await taskGit.push(wtAbs(r), r.branch, { timeout: Math.max(5000, deadline - Date.now()) });
  await refreshRun(t, r);
  return res;
}

// ── 정리(§2.10) ──────────────────────────────────────────────────────────────
function killTerminal(r) {
  if (r.tid == null) return Promise.resolve();
  const exists = fs.existsSync(absHome(r.cwd));
  if (exists) {
    return dep('pty').handleTerminalRpc('terminal.close', { cwd: r.cwd, index: r.tid }).catch(() => {});
  }
  // 폴더가 이미 없으면 sessionForCwd 가 홈으로 폴백한다 — 세션명으로 직접 닫고 매니페스트도 지운다.
  return Promise.resolve()
    .then(() => (r.tsession ? dep('termBackend').kill(r.tsession) : null))
    .catch(() => {})
    .then(() => { try { if (r.tsession) dep('manifest').forget(r.tsession); } catch (_) { /* noop */ } });
}

/**
 * cleanupRun — {force, skipUnmerged}. 성공 시 r.cleanup 기록. 거부는 throw(UNCOMMITTED_CHANGES|UNMERGED_COMMITS).
 *  ★ dirty 는 정리 시점에 다시 계산한다(캐시 금지).
 */
async function cleanupRun(t, r, { force = false, skipUnmerged = false } = {}) {
  const top = repoTopAbs(t);
  const dirAbs = wtAbs(r);
  const exists = fs.existsSync(dirAbs);
  if (exists && !force) {
    const st = await taskGit.statusItems(dirAbs);
    if (st.length) throw codedError('UNCOMMITTED_CHANGES', `미커밋 변경 ${st.length}개 파일이 있습니다`);
    if (!skipUnmerged && r.baseSha) {
      const s = await taskGit.runStat(dirAbs, r.baseSha);
      if (s.ahead > 0 && !s.pushed) {
        const anc = await taskGit.git(['merge-base', '--is-ancestor', r.branch, t.base], { cwd: top });
        if (!anc.ok) throw codedError('UNMERGED_COMMITS', `머지되지 않은 커밋 ${s.ahead}개가 있습니다`);
      }
    }
  }
  stopTrustWatch(r);
  // 2. 터미널(멱등) — worktree 를 지우기 **전에**(sessionForCwd 가 폴더 존재를 본다).
  await killTerminal(r);
  poolChangedSoon();
  const cleanup = { worktreeRemoved: false, branchDeleted: false, workspaceDeleted: false, recoveryRef: null, at: null };
  // 3. 복구 ref
  const head = await taskGit.refExists(top, `refs/heads/${r.branch}`);
  if (head) {
    const ref = `refs/codingpt/discarded/${r.id}`;
    const u = await taskGit.git(['update-ref', ref, head], { cwd: top });
    if (u.ok) cleanup.recoveryRef = ref;
  }
  // 4. worktree 제거(저장소 락)
  await withRepoLock(t.repo.common, async () => {
    if (fs.existsSync(dirAbs)) {
      const rm = await taskGit.git(['worktree', 'remove', '--force', '--', dirAbs], { cwd: top, timeout: 120000 });
      if (!rm.ok && fs.existsSync(dirAbs)) {
        // rm -rf 는 세 조건 모두 만족할 때만(§2.10 4).
        const real = realish(dirAbs);
        const wtRoot = realish(worktreesDir());
        let isLink = false;
        try { isLink = fs.lstatSync(dirAbs).isSymbolicLink(); } catch (_) { isLink = true; }
        const listed = (await taskGit.worktreeList(top)).some((w) => w.path === real);
        if (real !== wtRoot && under(real, wtRoot) && !isLink && listed) {
          try { fs.rmSync(dirAbs, { recursive: true, force: true }); } catch (_) { /* 아래에서 판정 */ }
        }
      }
    }
    await taskGit.git(['worktree', 'prune'], { cwd: top });
  });
  if (fs.existsSync(dirAbs)) throw codedError('WORKTREE_REMOVE_FAILED', '작업 폴더를 지우지 못했습니다');
  cleanup.worktreeRemoved = true;
  // 5. 브랜치
  const bd = await taskGit.git(['branch', '-D', r.branch], { cwd: top });
  cleanup.branchDeleted = bd.ok || !(await taskGit.refExists(top, `refs/heads/${r.branch}`));
  // 6. 프롬프트 파일 + 워크스페이스
  try { fs.rmSync(promptFile(t, r), { force: true }); } catch (_) { /* noop */ }
  if (r.workspaceId && inj.backFetch) {
    try {
      await inj.backFetch('DELETE', `/api/daemon/workspaces/${encodeURIComponent(r.workspaceId)}`);
      cleanup.workspaceDeleted = true;
    } catch (e) { log(`[tasks] ${r.id} 워크스페이스 삭제 실패(재시도 대상): ${e && e.message}`); }
  } else cleanup.workspaceDeleted = true;
  cleanup.at = nowFn();
  r.cleanup = cleanup;
  liveCache.set(r.id, { terminalAlive: false, agentGone: false });
  touch(t, r);
  save();
  return cleanup;
}

async function discardOne(t, r, opts) {
  await cleanupRun(t, r, opts);
  r.state = 'discarded';
  r.trustPending = false;
  maybeCloseTask(t);
  touch(t, r);
  save();
  emit([t.id], 'discarded');
}

// ── 작업당 승자 1명(원자성) ────────────────────────────────────────────────────
//  opGuard 의 t.state 검사는 op 시작 시점뿐이다 — 같은 작업의 두 run 을 거의 동시에 머지하면 둘 다 통과한다.
//  머지 본문은 시작하자마자(첫 await 전) 작업 단위 표식을 잡고, 락 안·gh 호출 직전에 다시 확인한다.
const mergingTasks = new Set(); // taskId
function claimMerge(t) {
  if (t.state !== 'open' || t.winnerRunId) throw codedError('TASK_CLOSED', '이미 종료된 작업입니다');
  if (mergingTasks.has(t.id)) throw codedError('RUN_BUSY', '이 작업의 다른 실행을 머지하는 중입니다');
  mergingTasks.add(t.id);
  return () => { mergingTasks.delete(t.id); };
}
function assertStillOpen(t) {
  if (t.state !== 'open' || t.winnerRunId) throw codedError('TASK_CLOSED', '이미 종료된 작업입니다');
}

// ── 머지 완료 경로(§2.9 pr.merge 성공·로컬 머지 성공·웹 머지 감지 공통) ─────────────
async function finishMerge(t, r, { opId, sha, viaPr, discardOthers = true, web = false, headOid = null }) {
  r.state = 'merged';
  r.error = null;
  t.state = 'merged';
  t.winnerRunId = r.id;
  t.closedAt = nowFn();
  const result = { ok: true, sha: sha || null, cleanup: 'pending', discarded: [], discardSkipped: [] };
  r.lastOp = { opId, kind: viaPr ? 'pr.merge' : 'merge.local', ok: true, code: null, message: null, result, at: nowFn() };
  r.op = { opId, kind: 'cleanup', startedAt: nowFn() };
  recordOpId(r, opId, 'ok');
  touch(t, r);
  save();
  emit([t.id], 'merged');
  pushNotification(t, r, 'task_merged', `${repoSlug(t.repo.name)} · ${t.base}`).catch(() => {});
  track(postMerge(t, r, { opId, viaPr, discardOthers, web, headOid }).catch((e) => log(`[tasks] ${t.id} 머지 후 정리 실패: ${e && e.message}`)));
  return result;
}

/**
 * 승자 정리를 미뤄야 하는가 — 에이전트가 아직 일하는 중이거나(웹 머지는 AGENT_BUSY 검사를 거치지 않는다),
 *  웹에서 머지된 PR head 뒤에 로컬 커밋이 더 있으면(푸시 안 한 후속 작업) 건드리지 않는다.
 *  확인할 수 없으면 보수적으로 "미룸".
 */
async function winnerKeepReason(t, r, { web, headOid }) {
  if (liveWorking(r)) return 'AGENT_BUSY';
  if (!web) return null;
  const dir = wtAbs(r);
  if (!fs.existsSync(dir)) return null;
  const h = await taskGit.git(['rev-parse', 'HEAD'], { cwd: dir });
  const head = h.ok ? h.out.trim() : null;
  if (!head) return 'UNMERGED_COMMITS';
  if (headOid && head === headOid) return null;
  const ref = headOid || '@{upstream}';
  const c = await taskGit.git(['rev-list', '--count', `${ref}..HEAD`], { cwd: dir });
  if (!c.ok) return 'UNMERGED_COMMITS';
  return parseInt(c.out.trim(), 10) === 0 ? null : 'UNMERGED_COMMITS';
}

async function postMerge(t, r, { opId, viaPr, discardOthers, web = false, headOid = null }) {
  const top = repoTopAbs(t);
  const result = r.lastOp && r.lastOp.result ? r.lastOp.result : { ok: true, sha: null, cleanup: 'pending', discarded: [], discardSkipped: [] };
  // 원격 브랜치 삭제·로컬 정리 전에 판정(삭제 뒤엔 @{upstream} 비교가 불가능하다).
  const keep = await winnerKeepReason(t, r, { web, headOid }).catch(() => 'UNMERGED_COMMITS');
  if (viaPr) {
    // (1) 원격 브랜치 삭제 (2) 로컬 base fast-forward — 다음 작업이 머지된 코드에서 시작하게.
    const del = await taskGit.git(['push', 'origin', '--delete', r.branch], { cwd: top, timeout: 60000 });
    if (!del.ok) log(`[tasks] ${r.id} 원격 브랜치 삭제 실패(무시)`);
    await withRepoLock(t.repo.common, async () => {
      const f = await taskGit.git(['fetch', 'origin', t.base], { cwd: top, timeout: 60000 });
      if (!f.ok) return;
      const wts = await taskGit.worktreeList(top);
      const holder = wts.find((w) => w.branch === `refs/heads/${t.base}`);
      if (!holder) {
        const ff = await taskGit.git(['fetch', 'origin', `${t.base}:${t.base}`], { cwd: top, timeout: 60000 });
        if (!ff.ok) log(`[tasks] ${t.id} 로컬 base 갱신 생략(fast-forward 불가)`);
      } else {
        const st = await taskGit.statusItems(holder.path).catch(() => [1]);
        if (!st.length) {
          const ff = await taskGit.git(['merge', '--ff-only', `refs/remotes/origin/${t.base}`], { cwd: holder.path, timeout: 60000 });
          if (!ff.ok) log(`[tasks] ${t.id} 로컬 base 갱신 생략(fast-forward 불가)`);
        }
      }
    });
  }
  // (3) 승자 정리 — 미커밋만 지킨다(머지된 커밋은 이미 base/원격에 있다).
  //  단, 에이전트 작업 중·PR head 뒤 로컬 커밋이 있으면 worktree·브랜치·터미널을 그대로 둔다(기록만).
  if (keep) {
    result.cleanupSkipped = keep;
    log(`[tasks] ${r.id} 승자 정리 보류: ${keep}`);
  } else {
    try { await cleanupRun(t, r, { force: false, skipUnmerged: true }); } catch (e) {
      result.cleanupSkipped = (e && e.code) || 'GH_ERROR';
      log(`[tasks] ${r.id} 승자 정리 건너뜀: ${e && e.code}`);
    }
  }
  emit([t.id], 'merged');
  // (4) 나머지 폐기
  if (discardOthers) {
    for (const o of t.runs) {
      if (o.id === r.id || !['running', 'review_ready', 'failed'].includes(o.state)) continue;
      if (o.op) { result.discardSkipped.push({ runId: o.id, code: 'RUN_BUSY' }); continue; }
      const oid = `${opId}:${o.id}`.slice(0, 80);
      beginOp(t, o, oid, 'discard');
      try {
        await discardOne(t, o, { force: false });
        result.discarded.push(o.id);
        endOp(t, o, oid, 'discard', { ok: true, result: { discarded: [o.id], skipped: [] } });
      } catch (e) {
        const code = e && e.code ? e.code : 'GH_ERROR';
        result.discardSkipped.push({ runId: o.id, code });
        endOp(t, o, oid, 'discard', { ok: true, result: { discarded: [], skipped: [{ runId: o.id, code }] } });
      }
    }
  }
  result.cleanup = 'done';
  if (r.lastOp && r.lastOp.opId === opId) r.lastOp.result = result;
  if (r.op && r.op.opId === opId) r.op = null;
  touch(t, r);
  save();
  emit([t.id], 'discarded');
}

// ── RPC 핸들러 ───────────────────────────────────────────────────────────────
async function ghLite() {
  let tl = taskGit.toolsCached();
  if (!tl) { try { tl = await taskGit.tools(); } catch (_) { tl = null; } }
  return { gitOk: !!(tl && tl.git.ok), ghInstalled: !!(tl && tl.gh.installed), ghAuthed: !!(tl && tl.gh.authenticated) };
}

async function rpcList(p) {
  const s = load();
  const now = nowFn();
  let repoFilter = null;
  if (typeof p.repo === 'string' && p.repo) {
    try { repoFilter = relHome(dep('fsLib').safeResolve(p.repo)); } catch (_) { repoFilter = p.repo; }
  }
  const items = s.items.filter((t) => {
    if (!p.includeClosed && TERMINAL_TASK_STATES.has(t.state) && t.closedAt && now - t.closedAt > CLOSED_HIDE_MS) return false;
    if (repoFilter) {
      const full = t.repo.subdir ? `${t.repo.path}/${t.repo.subdir}` : t.repo.path;
      if (t.repo.path !== repoFilter && full !== repoFilter) return false;
    }
    return true;
  });
  await refreshLive(items);
  retryWorkspaces(items);
  return { items: items.map((t) => pickTask(t)), caps: { gh: await ghLite() } };
}

async function rpcGet(p) {
  const t = mustTask(p);
  await refreshLive([t]);
  return { task: pickTask(t, { prompt: true }) };
}

async function rpcRunPrompt(p) {
  const { t, r } = mustRun(p);
  if (r.state === 'merged' || r.state === 'discarded') throw codedError('TASK_CLOSED', '이미 종료된 실행입니다');
  let text = t.prompt;
  if (p.text != null) {
    if (typeof p.text !== 'string' || !p.text.trim()) throw codedError('BAD_PARAMS', 'text 가 올바르지 않습니다');
    text = p.text;
  }
  if (Buffer.byteLength(text, 'utf8') > PROMPT_MAX_BYTES) throw codedError('PROMPT_TOO_LARGE', '프롬프트가 너무 깁니다(30,000 바이트까지)');
  if (r.tid == null || !r.tsession) throw codedError('TERMINAL_GONE', '터미널이 닫혔습니다');
  let alive = true;
  try { await dep('termBackend').info(r.tsession); } catch (_) { alive = false; }
  if (!alive) throw codedError('TERMINAL_GONE', '터미널이 닫혔습니다');
  // 20s 상한 안에 회신해야 한다 — 준비 대기는 16s 까지만.
  // since = 이번 런치 — 과거 런치의 SessionStart 는 근거가 안 된다(셸 게이트는 waitAgentReady 안에서).
  const ready = await waitAgentReady(r, { timeoutMs: Math.min(timings.readyTimeoutMs, 16000), since: r.launchedAt || 0 });
  if (!ready) {
    r.error = { code: 'PROMPT_NOT_DELIVERED', message: '프롬프트가 전달되지 않았어요' };
    touch(t, r); save(); emit([t.id], 'run');
    return { ok: false, delivered: false };
  }
  await deliverPrompt(t, r, text);
  return { ok: true, delivered: true };
}

async function rpcRunTrust(p) {
  const { t, r } = mustRun(p);
  const d = trustDialogOf(await readScreen(r));
  if (!d) {
    if (r.trustPending) { r.trustPending = false; r.trustTitle = null; touch(t, r); save(); emit([t.id], 'run'); }
    return { ok: true, dialog: null };
  }
  if (!inj.chatDialog) throw codedError('BAD_PARAMS', '다이얼로그 경로가 없습니다');
  // expect 대조 — 그 사이 다른 질문으로 바뀌었으면 driveDialog 가 DIALOG_MISMATCH 로 거부한다.
  const res = await inj.chatDialog({ cwd: r.cwd, tid: r.tid, pick: 1, expect: r.trustTitle || d.title });
  r.trustPending = false;
  r.trustTitle = null;
  stopTrustWatch(r);
  touch(t, r); save(); emit([t.id], 'run');
  return { ok: true, dialog: (res && res.dialog) || null };
}

async function rpcReopen(p) {
  return startRunOp(p, 'reopen', { states: ['failed', 'running', 'review_ready'], agentBusy: true }, async ({ t, r }) => {
    // worktree 가 한 번도 안 만들어진 run(생성 실패) — 6 단계부터 다시.
    if (!fs.existsSync(wtAbs(r))) {
      if (r.baseSha) throw codedError('WORKTREE_MISSING', '작업 폴더가 사라졌습니다');
      r.state = 'creating';
      await addWorktrees(t, [r]);
      if (r.state !== 'creating') throw codedError((r.error && r.error.code) || 'WORKTREE_ADD_FAILED', (r.error && r.error.message) || '작업 폴더를 만들지 못했습니다');
      await prepareRun(t, r);
      poolChangedSoon();
      await launchRun(t, r, { withPrompt: true });
      if (r.state === 'failed') throw codedError(r.error.code, r.error.message);
      return { tid: r.tid };
    }
    let alive = false;
    let paneCmd = '';
    if (r.tsession) {
      try { paneCmd = String((await dep('termBackend').info(r.tsession)).command || '').trim(); alive = true; } catch (_) { alive = false; }
    }
    // 터미널에서 뭔가(에이전트) 돌고 있으면 덮어 치지 않는다 — run 을 failed 로 떨어뜨리기 전에 거절.
    if (alive && paneCmd && !SHELLS.has(paneCmd)) throw codedError('LAUNCH_BUSY', '터미널에서 다른 명령이 실행 중입니다');
    if (!alive) {
      await createRunTerminal(t, r);
      if (!r.workspaceId) await registerWorkspace(t, r);
      touch(t, r); save();
      poolChangedSoon();
    }
    // 프롬프트가 한 번도 안 들어간 run 은 프롬프트로, 이미 들어간 run 은 대화 이어가기로.
    await launchRun(t, r, { withPrompt: !r.promptDelivered });
    if (r.state === 'failed') throw codedError(r.error.code, r.error.message);
    return { tid: r.tid };
  });
}

const DIFF_FILE_MAX = 64 * 1024;
const DIFF_TOTAL_MAX = 400 * 1024;
const DIFF_SINGLE_MAX = 1024 * 1024;
const DIFF_FILES_MAX = 500;

async function rpcDiff(p) {
  const { t, r } = mustRun(p);
  const dir = wtAbs(r);
  if (!fs.existsSync(dir) || !r.baseSha) throw codedError('WORKTREE_MISSING', '작업 폴더가 사라졌습니다');
  await refreshRun(t, r).catch(() => {});
  const { mergeBase, files } = await taskGit.changedFiles(dir, r.baseSha);
  const h = await taskGit.git(['rev-parse', 'HEAD'], { cwd: dir });
  const head = h.ok ? h.out.trim() : null;
  const totals = { files: files.length, additions: 0, deletions: 0 };
  for (const f of files) { totals.additions += f.additions; totals.deletions += f.deletions; }
  const out = { taskId: t.id, runId: r.id, base: t.base, baseSha: r.baseSha, head, mergeBase, uncommitted: !!r.dirty, files: [], totals, truncatedTotal: false };
  if (p.file != null) {
    // 허용 집합 정확 일치 + realpath 가 worktree 안(--no-index 는 저장소에 묶이지 않는다 — §2.9 3).
    if (typeof p.file !== 'string') throw codedError('BAD_PARAMS', 'file 이 올바르지 않습니다');
    const f = files.find((x) => x.path === p.file);
    if (!f) throw codedError('BAD_PARAMS', '변경 목록에 없는 파일입니다');
    const root = realish(dir);
    if (!under(realish(path.resolve(dir, p.file)), root)) throw codedError('BAD_PARAMS', '허용되지 않은 경로입니다');
    const item = { ...f };
    if (!f.binary) {
      const text = await taskGit.fileDiffText(dir, mergeBase, f.path, f.status === '?');
      if (text != null) {
        if (Buffer.byteLength(text, 'utf8') > DIFF_SINGLE_MAX) { item.diffText = Buffer.from(text, 'utf8').subarray(0, DIFF_SINGLE_MAX).toString('utf8'); item.truncated = true; } else item.diffText = text;
      }
    }
    out.files = [item];
    return out;
  }
  let total = 0;
  for (const f of files.slice(0, DIFF_FILES_MAX)) {
    const item = { ...f };
    if (!f.binary) {
      if (total >= DIFF_TOTAL_MAX) { item.omitted = true; out.truncatedTotal = true; } else {
        // 추적 파일의 realpath 가 worktree 밖(심링크)이면 본문을 싣지 않는다.
        const inside = under(realish(path.resolve(dir, f.path)), realish(dir));
        const text = inside ? await taskGit.fileDiffText(dir, mergeBase, f.path, f.status === '?') : null;
        if (text != null) {
          let tx = text;
          if (Buffer.byteLength(tx, 'utf8') > DIFF_FILE_MAX) { tx = Buffer.from(tx, 'utf8').subarray(0, DIFF_FILE_MAX).toString('utf8'); item.truncated = true; }
          item.diffText = tx;
          total += Buffer.byteLength(tx, 'utf8');
        }
      }
    }
    if (!item.binary) delete item.binary;
    out.files.push(item);
  }
  if (files.length > DIFF_FILES_MAX) out.truncatedTotal = true;
  return out;
}

async function rpcDiscard(p) {
  const opId = reqOpId(p);
  const t = mustTask(p);
  const force = p.force === true;
  if (p.runId != null) {
    return startRunOp(p, 'discard', { states: ['running', 'review_ready', 'failed'], agentBusy: !force }, async ({ t: tt, r }) => {
      try {
        await discardOne(tt, r, { force });
        return { discarded: [r.id], skipped: [] };
      } catch (e) {
        if (e && (e.code === 'UNCOMMITTED_CHANGES' || e.code === 'UNMERGED_COMMITS')) {
          return { opFailed: true, code: e.code, message: e.message, result: { discarded: [], skipped: [{ runId: r.id, code: e.code }] } };
        }
        throw e;
      }
    });
  }
  // 전 run 폐기 — 같은 opId 를 run 마다 기록(재전송 시 재생).
  const replayRun = t.runs.find((r) => replayFor(r, opId));
  if (replayRun) return replayFor(replayRun, opId);
  const targets = t.runs.filter((r) => ['running', 'review_ready', 'failed'].includes(r.state));
  if (!targets.length) {
    maybeCloseTask(t); save(); emit([t.id], 'discarded');
    return { accepted: true, opId, run: t.runs[0] ? pickRun(t.runs[0]) : null };
  }
  let first = null;
  for (const r of targets) {
    if (r.op) continue;
    if (!force && liveWorking(r)) continue;
    const acc = runOp(t, r, opId, 'discard', async () => {
      try {
        await discardOne(t, r, { force });
        return { discarded: [r.id], skipped: [] };
      } catch (e) {
        const code = e && e.code ? e.code : 'GH_ERROR';
        return { opFailed: true, code, message: e && e.message, result: { discarded: [], skipped: [{ runId: r.id, code }] } };
      }
    });
    if (!first) first = acc;
  }
  if (!first) throw codedError(targets.some((r) => r.op) ? 'RUN_BUSY' : 'AGENT_BUSY', '지금은 폐기할 수 없습니다');
  return first;
}

async function rpcDelete(p) {
  const t = mustTask(p);
  if (!TERMINAL_TASK_STATES.has(t.state)) throw codedError('BAD_PARAMS', '종료된 작업만 삭제할 수 있습니다');
  if (t.runs.some((r) => r.op || ACTIVE_RUN_STATES.has(r.state))) throw codedError('BAD_PARAMS', '남은 실행을 먼저 폐기하세요');
  // I-8 — 정리되지 않은 worktree(실패 run·정리 보류된 승자 등)가 남아 있으면 기록을 지우지 않는다(고아 방지).
  if (t.runs.some((r) => r.dir && fs.existsSync(wtAbs(r)))) throw codedError('BAD_PARAMS', '남은 실행을 먼저 폐기하세요');
  mutate((s) => {
    s.items = s.items.filter((x) => x.id !== t.id);
    s.createOps = s.createOps.filter((o) => o.taskId !== t.id);
  });
  try { fs.rmSync(path.join(promptsDir(), t.id), { recursive: true, force: true }); } catch (_) { /* noop */ }
  for (const r of t.runs) liveCache.delete(r.id);
  // 복구 ref(refs/codingpt/discarded/<rid>)는 기록과 함께 지운다 — 기록이 없으면 아무도 가리키지 않는다.
  const top = repoTopAbs(t);
  if (fs.existsSync(top)) {
    for (const r of t.runs) {
      if (r.cleanup && r.cleanup.recoveryRef) await taskGit.git(['update-ref', '-d', r.cleanup.recoveryRef], { cwd: top }).catch(() => {});
    }
  }
  emit([t.id], 'deleted');
  return { ok: true };
}

async function rpcBranches(p) {
  const repoParam = reqString(p, 'repo');
  let abs;
  try { abs = dep('fsLib').safeResolve(repoParam); } catch (_) { throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다'); }
  const tl = await taskGit.baseTools();
  if (!tl.git.ok) throw codedError(tl.git.error || 'GIT_MISSING', '이 PC 에 git 이 없습니다');
  if (!fs.existsSync(abs)) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  const info = await taskGit.repoInfo(abs);
  if (!info || relHome(info.top) == null) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  const b = await taskGit.branches(abs);
  const commonRel = relHome(info.common);
  const cached = load().items.find((t) => t.repo.common === commonRel && t.repo.github);
  return { ...b, github: cached ? cached.repo.github : null };
}

async function rpcStatus(p) {
  const { t, r } = mustRun(p);
  await freshStatus(t, r);
  const dir = wtAbs(r);
  const up = await taskGit.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: dir });
  let upstream = null; let aheadUpstream = null; let behindUpstream = null;
  if (up.ok && up.out.trim()) {
    upstream = up.out.trim();
    const c = await taskGit.git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd: dir });
    if (c.ok) {
      const [behind, ahead] = c.out.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      aheadUpstream = ahead; behindUpstream = behind;
    }
  }
  const lc = await taskGit.git(['log', '-1', '--format=%H%x00%s%x00%ct'], { cwd: dir });
  let lastCommit = null;
  if (lc.ok && lc.out.trim()) {
    const [sha, subject, ct] = lc.out.trim().split('\0');
    lastCommit = { sha, short: sha.slice(0, 7), subject: subject || '', at: (parseInt(ct, 10) || 0) * 1000 };
  }
  return { run: pickRun(r), branch: r.branch, base: t.base, baseSha: r.baseSha, upstream, aheadUpstream, behindUpstream, lastCommit };
}

async function rpcCommit(p) {
  const message = reqString(p, 'message', 10000);
  const noVerify = p.noVerify === true;
  return startRunOp(p, 'commit', { states: ['running', 'review_ready', 'failed'] }, async ({ t, r, deadline }) => {
    await freshStatus(t, r);
    return doCommit(t, r, { message, noVerify, deadline });
  });
}

async function rpcPush(p) {
  return startRunOp(p, 'push', { states: ['running', 'review_ready', 'failed'] }, async ({ t, r, deadline }) => {
    await freshStatus(t, r);
    return doPush(t, r, deadline);
  });
}

async function rpcPrCreate(p) {
  const title = reqString(p, 'title', 256);
  if (p.body != null && typeof p.body !== 'string') throw codedError('BAD_PARAMS', 'body 가 올바르지 않습니다');
  if (p.body && Buffer.byteLength(p.body, 'utf8') > PR_BODY_MAX_BYTES) throw codedError('BAD_PARAMS', 'PR 본문이 너무 깁니다(64KB 까지)');
  if (p.commitMessage != null && (typeof p.commitMessage !== 'string' || !p.commitMessage.trim())) throw codedError('BAD_PARAMS', 'commitMessage 가 올바르지 않습니다');
  return startRunOp(p, 'pr.create', { states: ['running', 'review_ready'] }, async ({ t, r, deadline }) => {
    await taskGit.requireGh();
    const github = await ensureGithub(t, { required: true });
    await freshStatus(t, r);
    if (r.dirty) {
      if (!p.commitMessage) throw codedError('UNCOMMITTED_CHANGES', '먼저 커밋해야 합니다');
      await doCommit(t, r, { message: p.commitMessage, noVerify: false, deadline });
    }
    if (!r.commits || !r.commits.ahead) throw codedError('NOTHING_TO_PR', 'base 에 없는 커밋이 없습니다');
    if (!r.pushed && p.push !== false) await doPush(t, r, deadline);
    const res = await taskGit.prCreate(wtAbs(r), github, { branch: r.branch, base: t.base, title, body: p.body || '', draft: p.draft === true, now: nowFn() });
    r.pr = res.pr;
    touch(t, r); save(); emit([t.id], 'pr');
    return { pr: res.pr, existed: !!res.existed };
  });
}

async function rpcPrStatus(p) {
  const { t, r } = mustRun(p);
  await taskGit.requireGh();
  const github = await ensureGithub(t, { required: true });
  const dir = fs.existsSync(wtAbs(r)) ? wtAbs(r) : repoTopAbs(t);
  const v = await taskGit.prView(dir, github, r.pr ? r.pr.number : r.branch, nowFn());
  // 변화가 있을 때만 touch/emit — 상세가 30초마다 부르므로 무변화 통지는 모든 기기의 재조회·재렌더만 부른다.
  const sig = (x) => JSON.stringify(x, (k, y) => (k === 'at' ? undefined : y));
  const changed = sig(r.pr) !== sig(v ? v.pr : null);
  r.pr = v ? v.pr : null;
  if (changed) { touch(t, r); save(); emit([t.id], 'pr'); } else save();
  // GitHub 웹에서 머지된 것을 처음 봄 → pr.merge 성공과 같은 완료 경로.
  if (v && v.pr.state === 'merged' && t.state === 'open' && !t.winnerRunId && !mergingTasks.has(t.id)
    && r.state !== 'merged' && r.state !== 'discarded' && !r.op) {
    await finishMerge(t, r, { opId: `web-${r.id}`.slice(0, 80), sha: v.mergeSha, viaPr: true, discardOthers: true, web: true, headOid: v.headOid });
  }
  return { pr: r.pr, run: pickRun(r) };
}

async function rpcPrMerge(p) {
  const method = p.method;
  if (!['merge', 'squash', 'rebase'].includes(method)) throw codedError('BAD_PARAMS', 'method 가 올바르지 않습니다');
  const discardOthers = p.discardOthers !== false;
  const force = p.force === true;
  {
    const { r } = mustRun(p);
    if (!r.pr && !(Array.isArray(r.opIds) && r.opIds.some((o) => o.opId === p.opId))) throw codedError('PR_NOT_FOUND', 'PR 이 없습니다');
  }
  return startRunOp(p, 'pr.merge', { states: ['running', 'review_ready'] }, async ({ t, r, deadline }) => {
    const release = claimMerge(t); // ★ 첫 await 전 — 같은 작업의 다른 run 머지와 원자적으로 배타
    try {
      await taskGit.requireGh();
      const github = await ensureGithub(t, { required: true });
      await freshStatus(t, r);
      if (r.dirty) throw codedError('UNCOMMITTED_CHANGES', '먼저 커밋해야 합니다');
      r.state = 'merging';
      touch(t, r); save(); emit([t.id], 'run');
      try {
        const v = await taskGit.prView(wtAbs(r), github, r.pr.number, nowFn());
        if (!v) throw codedError('PR_NOT_FOUND', 'PR 을 찾을 수 없습니다');
        r.pr = v.pr;
        if (v.pr.state === 'closed') throw codedError('PR_NOT_FOUND', 'PR 이 닫혀 있습니다');
        if (v.pr.state !== 'merged') {
          if (v.pr.mergeable === 'CONFLICTING') throw codedError('PR_NOT_MERGEABLE', 'PR 에 충돌이 있습니다');
          if (!force && v.pr.checks.status === 'failing') throw codedError('CHECKS_FAILING', '검사가 실패한 상태입니다');
          if (Date.now() > deadline) throw codedError('TIMEOUT', '시간 초과');
          assertStillOpen(t);
          await taskGit.prMerge(wtAbs(r), github, v.pr.number, method);
        }
        const after = await taskGit.prView(wtAbs(r), github, v.pr.number, nowFn()).catch(() => null);
        if (after) r.pr = after.pr;
        // ★ gh 가 0 으로 끝나도 머지가 확정된 건 아니다(머지 큐·자동 머지 예약) — PR 이 merged 로 보일 때만 완료.
        //   아니면 run 은 review_ready 로 두고 git.pr.status 가 MERGED 를 볼 때 웹 머지 경로로 마무리한다.
        if (!after || after.pr.state !== 'merged') {
          if (r.state === 'merging') r.state = 'review_ready';
          touch(t, r); save(); emit([t.id], 'pr');
          return { merged: false, queued: true, pr: r.pr };
        }
        assertStillOpen(t);
        await finishMerge(t, r, { opId: p.opId, sha: after.mergeSha, viaPr: true, discardOthers });
        return { [KEEP_OP]: true };
      } catch (e) {
        if (r.state === 'merging') r.state = 'review_ready';
        r.error = { code: e.code || 'GH_ERROR', message: String(e.message || '').slice(0, 300) };
        touch(t, r); save();
        throw e;
      }
    } finally { release(); }
  });
}

async function rpcMergeLocal(p) {
  const method = p.method;
  if (!['merge', 'squash', 'ff'].includes(method)) throw codedError('BAD_PARAMS', 'method 가 올바르지 않습니다');
  const discardOthers = p.discardOthers !== false;
  return startRunOp(p, 'merge.local', { states: ['running', 'review_ready'] }, async ({ t, r, deadline }) => {
    const release = claimMerge(t); // ★ 첫 await 전
    try { return await mergeLocalBody(t, r, { p, method, discardOthers, deadline }); } finally { release(); }
  });
}

async function mergeLocalBody(t, r, { p, method, discardOthers, deadline }) {
  {
    await freshStatus(t, r);
    if (r.dirty) throw codedError('UNCOMMITTED_CHANGES', '먼저 커밋해야 합니다');
    r.state = 'merging';
    touch(t, r); save(); emit([t.id], 'run');
    const top = repoTopAbs(t);
    const message = method === 'squash' ? (t.title || `Merge ${r.branch}`) : `Merge ${r.branch}`;
    let out;
    try {
      out = await withRepoLock(t.repo.common, async () => {
        assertStillOpen(t);
        const timeout = Math.max(5000, deadline - Date.now());
        const wts = await taskGit.worktreeList(top);
        const holder = wts.find((w) => w.branch === `refs/heads/${t.base}`);
        if (holder) {
          // (b)/(c) — base 가 어딘가에 체크아웃돼 있다.
          const st = await taskGit.statusItems(holder.path);
          if (st.length) throw codedError('MAIN_DIRTY', '저장소에 커밋되지 않은 변경이 있습니다');
          return taskGit.mergeIn(holder.path, { branch: r.branch, method, message, timeout });
        }
        // (a) — 어디에도 없음: 임시 detached worktree 에서 머지 후 CAS update-ref.
        const oldSha = await taskGit.refExists(top, `refs/heads/${t.base}`);
        if (!oldSha) throw codedError('BASE_NOT_FOUND', 'base 브랜치를 찾을 수 없습니다');
        const tmp = path.join(worktreesDir(), `.merge-${t6Of(t.id)}`);
        await taskGit.git(['worktree', 'remove', '--force', '--', tmp], { cwd: top }).catch(() => {});
        await taskGit.git(['worktree', 'prune'], { cwd: top });
        const add = await taskGit.git(['worktree', 'add', '--detach', '--', tmp, oldSha], { cwd: top, timeout });
        if (!add.ok) throw codedError('WORKTREE_ADD_FAILED', add.err.trim().slice(0, 300));
        try {
          const m = await taskGit.mergeIn(tmp, { branch: r.branch, method, message, timeout });
          if (!m.ok) return m;
          const u = await taskGit.git(['update-ref', `refs/heads/${t.base}`, m.sha, oldSha], { cwd: top });
          if (!u.ok) throw codedError('BASE_MOVED', `머지하는 사이 ${t.base} 가 바뀌었습니다`);
          return m;
        } finally {
          await taskGit.git(['worktree', 'remove', '--force', '--', tmp], { cwd: top }).catch(() => {});
          await taskGit.git(['worktree', 'prune'], { cwd: top }).catch(() => {});
        }
      });
    } catch (e) {
      if (r.state === 'merging') r.state = 'review_ready';
      r.error = { code: e.code || 'GH_ERROR', message: String(e.message || '').slice(0, 300) };
      touch(t, r); save();
      throw e;
    }
    if (!out.ok) {
      r.state = 'review_ready';
      touch(t, r); save();
      return { opFailed: true, code: 'MERGE_CONFLICT', message: '충돌이 났습니다', result: { ok: false, code: 'MERGE_CONFLICT', files: out.files || [] } };
    }
    await finishMerge(t, r, { opId: p.opId, sha: out.sha, viaPr: false, discardOthers });
    return { [KEEP_OP]: true };
  }
}

async function rpcGhStatus(p) {
  const tl = await taskGit.tools({ refresh: p.refresh === true });
  const g = { ok: tl.git.ok, path: tl.git.path, version: tl.git.version };
  if (tl.git.error) g.error = tl.git.error;
  const h = { installed: tl.gh.installed, path: tl.gh.path, version: tl.gh.version, authenticated: tl.gh.authenticated, user: tl.gh.user, host: 'github.com' };
  if (tl.gh.error) h.error = tl.gh.error;
  return { git: g, gh: h };
}

const HANDLERS = {
  'task.list': rpcList,
  'task.get': rpcGet,
  'task.create': rpcCreate,
  'task.run.prompt': rpcRunPrompt,
  'task.run.trust': rpcRunTrust,
  'task.run.reopen': rpcReopen,
  'task.diff': rpcDiff,
  'task.discard': rpcDiscard,
  'task.delete': rpcDelete,
  'git.branches': rpcBranches,
  'git.status': rpcStatus,
  'git.commit': rpcCommit,
  'git.push': rpcPush,
  'git.pr.create': rpcPrCreate,
  'git.pr.status': rpcPrStatus,
  'git.pr.merge': rpcPrMerge,
  'git.merge.local': rpcMergeLocal,
  'git.gh.status': rpcGhStatus,
};

/** RPC 진입점(로컬 소켓·릴레이·봉인 경로 공통). jail 밖이면 전부 TASKS_DISABLED. */
async function rpc(method, params) {
  if (!enabled()) throw codedError('TASKS_DISABLED', '이 PC 에서는 작업 기능을 쓸 수 없습니다');
  const h = HANDLERS[String(method || '')];
  if (!h) throw codedError('BAD_PARAMS', '알 수 없는 작업 명령입니다: ' + method);
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return h(p);
}

// ── 워크스페이스 등록 재시도(§2.11) ──────────────────────────────────────────
function retryWorkspaces(tasks) {
  const now = nowFn();
  for (const t of tasks) {
    for (const r of t.runs) {
      if (r.workspaceId || !['running', 'review_ready', 'failed'].includes(r.state)) continue;
      if (!fs.existsSync(absHome(r.cwd))) continue;
      if (r.wsTriedAt && now - r.wsTriedAt < WS_RETRY_MIN_MS) continue;
      registerWorkspace(t, r).then(() => { if (r.workspaceId) { touch(t, r); save(); emit([t.id], 'run'); } }).catch(() => {});
    }
  }
}

/**
 * 서버 재접속(hello_ack) — 워크스페이스 등록만 다시 시도한다(§2.11 "hello_ack 뒤에도 재등록 부분만").
 *  등록 실패의 흔한 원인이 "back 에 닿지 못함" 이라 재접속 직후가 가장 확실한 재시도 시점이다 →
 *  60s 스로틀(wsTriedAt)을 이번 한 번은 무시한다. 기동 전·jail 밖(TASKS_DISABLED)이면 아무것도 안 한다.
 */
function onReconnect() {
  if (!started || !enabled()) return 0;
  const items = load().items;
  let n = 0;
  for (const t of items) {
    for (const r of t.runs) if (!r.workspaceId && r.wsTriedAt) { r.wsTriedAt = 0; n++; }
  }
  retryWorkspaces(items);
  return n;
}

// ── 기동 reconcile(§2.11) ────────────────────────────────────────────────────
async function reconcile() {
  const s = load();
  const changed = new Set();
  const wtCache = new Map(); // top → realpath set
  const listed = async (t, r) => {
    const top = repoTopAbs(t);
    if (!wtCache.has(top)) wtCache.set(top, new Set((await taskGit.worktreeList(top)).map((w) => w.path)));
    return wtCache.get(top).has(realish(wtAbs(r)));
  };
  const resumes = new Map(); // taskId → runs[]
  for (const t of s.items) {
    for (const r of t.runs) {
      try {
        if (r.op) {
          if (r.state === 'merged' && r.op.kind === 'cleanup') {
            // 머지 후 정리 도중 재시작 — 멱등 정리를 다시 돈다.
            const opId = r.op.opId;
            postMerge(t, r, { opId, viaPr: !!(r.lastOp && r.lastOp.kind === 'pr.merge'), discardOthers: true }).catch(() => {});
          } else {
            const op = r.op;
            r.op = null;
            r.lastOp = { opId: op.opId, kind: op.kind, ok: false, code: 'OP_INTERRUPTED', message: 'PC 가 재시작되어 작업이 중단됐어요', result: null, at: nowFn() };
            recordOpId(r, op.opId, 'error');
            if (r.state === 'merging') r.state = 'review_ready';
          }
          changed.add(t.id);
        } else if (r.state === 'merging') { r.state = 'review_ready'; changed.add(t.id); }
        if (r.state === 'creating') {
          if (r.baseSha && fs.existsSync(wtAbs(r)) && await listed(t, r)) {
            if (!resumes.has(t.id)) resumes.set(t.id, []);
            resumes.get(t.id).push(r);
          } else {
            await taskGit.worktreeRevert(repoTopAbs(t), { branch: r.branch, absDir: wtAbs(r) });
            r.state = 'failed';
            r.error = { code: 'OP_INTERRUPTED', message: 'PC 가 재시작되어 작업이 중단됐어요' };
          }
          changed.add(t.id);
          continue;
        }
        if (r.state === 'launching') {
          r.state = 'failed';
          r.error = { code: 'OP_INTERRUPTED', message: 'PC 가 재시작되어 작업이 중단됐어요' };
          changed.add(t.id);
          continue;
        }
        if (r.state === 'running' || r.state === 'review_ready') {
          if (!fs.existsSync(wtAbs(r))) {
            r.state = 'failed';
            r.error = { code: 'WORKTREE_MISSING', message: '작업 폴더가 사라졌어요' };
            changed.add(t.id);
            continue;
          }
          if (!(await listed(t, r))) {
            await taskGit.git(['worktree', 'prune'], { cwd: repoTopAbs(t) });
            wtCache.delete(repoTopAbs(t));
            if (!(await listed(t, r))) {
              r.state = 'failed';
              r.error = { code: 'WORKTREE_MISSING', message: '작업 폴더가 사라졌어요' };
              changed.add(t.id);
              continue;
            }
          }
          if (r.trustPending) {
            const d = trustDialogOf(await readScreen(r));
            if (!d) { r.trustPending = false; r.trustTitle = null; changed.add(t.id); } else startTrustWatch(t, r);
          }
        }
        // 30일 지난 복구 ref 정리
        if (r.cleanup && r.cleanup.recoveryRef && r.cleanup.at && nowFn() - r.cleanup.at > RECOVERY_KEEP_MS) {
          await taskGit.git(['update-ref', '-d', r.cleanup.recoveryRef], { cwd: repoTopAbs(t) });
          r.cleanup.recoveryRef = null;
          changed.add(t.id);
        }
      } catch (e) {
        log(`[tasks] reconcile ${t.id}/${r.id} 실패: ${e && e.message}`);
      }
    }
  }
  save();
  for (const [taskId, runs] of resumes) {
    const t = findTask(taskId);
    if (t) resumePrepared(t, runs).catch((e) => log(`[tasks] ${taskId} 재개 실패: ${e && e.message}`));
  }
  await refreshLive(s.items).catch(() => {});
  retryWorkspaces(s.items);
  emit([...changed], 'reconciled');
  return { changed: [...changed], resumed: [...resumes.keys()] };
}

// ── 수명 ─────────────────────────────────────────────────────────────────────
let started = false;
let unsubscribe = null;
let reconcilePromise = null;

/** cpt-server.start() 에서 configure 직후 1회 — agent-state 구독 + 알림 거부권 + reconcile. */
function start() {
  if (started) return reconcilePromise;
  started = true;
  if (!enabled()) { log('[tasks] 작업 폴더가 홈 밖이라 작업 기능을 끕니다(TASKS_DISABLED)'); return Promise.resolve(null); }
  load();
  try {
    const as = dep('agentState');
    unsubscribe = as.subscribe(onAgentState);
    as.configure({ shouldNotify });
  } catch (e) { log(`[tasks] agent-state 구독 실패: ${e && e.message}`); }
  reconcilePromise = reconcile().catch((e) => { log(`[tasks] reconcile 실패: ${e && e.message}`); return null; });
  return reconcilePromise;
}

/** 테스트 전용 — 타이머·구독 해제 + 메모리 초기화(디스크는 그대로). */
async function _reset({ drain = true } = {}) {
  if (drain) await Promise.allSettled([...opPromises]);
  if (unsubscribe) { try { unsubscribe(); } catch (_) { /* noop */ } unsubscribe = null; }
  try { const as = dep('agentState'); if (as.configure) as.configure({ shouldNotify: null }); } catch (_) { /* noop */ }
  for (const tm of trustTimers.values()) clearTimeout(tm);
  for (const tm of turnTimers.values()) clearTimeout(tm);
  trustTimers.clear(); turnTimers.clear(); refreshing.clear(); liveCache.clear(); repoLocks.clear(); createInflight.clear(); mergingTasks.clear();
  if (poolTimer) { clearTimeout(poolTimer); poolTimer = null; }
  mem = null; tsIndex = new Map(); started = false; reconcilePromise = null; enabledCache = { key: null, val: false };
}

/** 테스트 전용 — 진행 중 비동기(op·생성·정리) 전부 끝날 때까지. */
async function _drain() {
  for (let i = 0; i < 100; i++) {
    const pend = [...opPromises, ...[...refreshing.values()].map((x) => x.promise)];
    if (!pend.length) return;
    await Promise.allSettled(pend);
  }
}

module.exports = {
  configure, start, rpc, onReconnect,
  pickTask, pickRun, repoSlug,
  TASK_FIELDS, REPO_FIELDS, RUN_FIELDS, ERROR_CODES, TASK_AGENTS,
  _internals: {
    load, save, mutate, reconcile, onAgentState, shouldNotify, waitAgentReady, refreshRun, evaluateTurn,
    cleanupRun, enabled, relHome, trustDialogOf, _reset, _drain, storeFile, worktreesDir, promptsDir,
    get timings() { return timings; },
  },
};
// `handle` 은 OPTIONAL_CAPS(control.js) 의 능력 판정 export 이기도 하다 — jail 밖(TASKS_DISABLED)이면
//  undefined 로 보여 `task.v1` 을 광고하지 않는다(클라가 "PC 앱 업데이트 필요/사용 불가" 로 그린다).
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
