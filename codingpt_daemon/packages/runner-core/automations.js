/**
 * automations.js — 자동화(F3) 스토어 + 엔진 + RPC(`auto.*`). 설계 정본: docs/automation-design.md §5(부록 Z 우선).
 *
 * 한 줄 요약: "트리거 1개 → 액션 1~5개(순서열 = 매크로) + 가드". 트리거는 스케줄(cron/일회)·원격 커밋·GitHub 이슈
 *  (폴링) 과 이벤트 버스(pr.*·task.*) 뿐이고, 액션은 `task.create`(worktree 작업)·`terminal.prompt`(붙어 있는
 *  에이전트에게 지시)·`notify` 세 가지뿐이다. 임의 셸·파일 쓰기·push·merge 는 **표현할 방법 자체가 없다**(§5.3).
 *
 * 경계:
 *  · 작업 생성은 tasks.internalCreate(S2) 만 부른다 — worktree·TASK_LIMIT·메인 체크아웃 불가침은 tasks.js 가 보장.
 *  · git/gh 실행은 task-git 의 git()/gh() 로만(로그인 셸 PATH·기계 판독 접두·데드라인 규칙을 거기서 물려받는다).
 *  · 터미널 입력·back REST·서버 caps 는 **주입**(configure) — cpt-server.wireAutomationBundle 이 실제 구현을 넣고,
 *    테스트는 스텁을 넣는다(tmux/back 없이 엔진 검증).
 *  · 영속 상태는 `<stateDir>/automations.json`(0600) + 감사 로그 `automations.log`(NDJSON, 2MB 회전 1세대).
 *
 * 절대 규칙(§12):
 *  · 자동화 이름·템플릿·프롬프트는 알림·ui_command 에 싣지 않는다(봉인 RPC 로만). 알림은 트리거 유형 라벨뿐.
 *  · 감사 로그에 프롬프트 본문을 쓰지 않는다.
 *  · 루프 방지: 자기 유발 이벤트 무시 · 연쇄 깊이 ≤ 2(AUTO_DEPTH) · 자동화가 만든 작업의 에이전트는 자동화를
 *    못 만든다(AUTO_LOOP — 소켓 경로 cpt-server 가 판정) · 자동화 작업 프롬프트 끝에 금지 문구 한 줄.
 */
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');
const cron = require('./cron');
const tpl = require('./template');
const store = require('./json-store');

// ── 상수 ─────────────────────────────────────────────────────────────────────
const STORE_V = 1;
const AUTO_LIMITS = Object.freeze({
  maxItems: 30, maxActions: 5, maxRunsPerDayDefault: 10, maxRunsPerDayCap: 50, maxConcurrentCap: 2,
  minScheduleMs: 900000, pollMs: 300000, tickMs: 30000, firingDeadlineMs: 300000, templateMaxBytes: 20000, nameMax: 80,
});
const DEFAULT_COOLDOWN_MS = 300000;
const COOLDOWN_MAX_MS = 24 * 3600 * 1000;
const CREATE_OPS_KEEP = 50;
const RUN_OPS_KEEP = 50;
const MAX_CONSECUTIVE_FAILURES = 5;
const LATE_MS = 60 * 1000;                 // 이보다 늦으면 "놓친 스케줄"
const MISSED_WINDOW_MS = 24 * 3600 * 1000; // missed:'once' 가 따라잡는 창
const ISSUE_SEEN_KEEP = 500;
const ISSUE_PER_PAGE = 30;
const ISSUE_BODY_MAX = 4000;
const COMMITS_MAX = 50;
const LOG_TAIL_GET = 50;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const TASK_PROMPT_MAX_BYTES = 30000; // tasks.js PROMPT_MAX_BYTES 와 같은 값(넘으면 PROMPT_TOO_LARGE)
const TITLE_MAX = 200;
const NOTIFY_TITLE_MAX = 200;
const NOTIFY_SUBTITLE_MAX = 300;
const LABELS_MAX = 10;

const TRIGGER_TYPES = ['schedule', 'git.commits', 'github.issues', 'pr.ci_failed', 'pr.review_comments', 'task.event'];
const ACTION_TYPES = ['task.create', 'terminal.prompt', 'notify'];
const TASK_EVENTS = ['review_ready', 'merged', 'failed'];
const EVENT_TRIGGERS = new Set(['pr.ci_failed', 'pr.review_comments', 'task.event']);
const TASK_AGENTS = new Set(['claude', 'codex', 'gemini']); // tasks.js TASK_AGENTS 와 동일(부록 Z B-5)
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

// 와이어 에러 코드(§5.6 + 소켓 게이트 AUTO_OUT_OF_TERMINAL) — rpc-errors-automation.json 이 대조한다.
const ERROR_CODES = [
  'AUTO_DISABLED', 'AUTO_NOT_FOUND', 'AUTO_LIMIT', 'AUTO_LOOP', 'AUTO_DEPTH',
  'AUTO_BAD_TRIGGER', 'AUTO_BAD_ACTION', 'AUTO_TEMPLATE_TOO_LARGE',
  'AUTO_PAUSED', 'AUTO_RATE_LIMITED', 'AUTO_BUSY', 'AUTO_OUT_OF_TERMINAL',
];

// 알림 subtitle 의 트리거 라벨(§5.8 — §11 trig* 의 한국어 원문). 자동화 이름은 절대 싣지 않는다.
const TRIGGER_LABEL = {
  schedule: '매일 일정', once: '예약 일정', 'git.commits': '새 커밋', 'github.issues': '새 이슈',
  'pr.ci_failed': '검사 실패', 'pr.review_comments': '리뷰 코멘트', 'task.event': '작업 이벤트',
};
// auto_failed subtitle 의 실패 문구 — stderr·경로를 싣지 않는다(서버 DB 에 남는다).
const FAIL_TEXT = {
  TASK_LIMIT: '작업 수 상한에 걸렸어요',
  NOT_A_REPO: '저장소를 찾을 수 없어요',
  BASE_NOT_FOUND: 'base 브랜치를 찾을 수 없어요',
  AGENT_NOT_INSTALLED: '에이전트가 설치돼 있지 않아요',
  PROMPT_NOT_DELIVERED: '에이전트에게 전달하지 못했어요',
  TERMINAL_GONE: '대상 터미널이 없어요',
  AUTO_DEPTH: '자동화 연쇄가 너무 깊어요',
  TASKS_DISABLED: '이 PC 에서 작업 기능을 쓸 수 없어요',
  TIMEOUT: '응답이 늦어요',
  OP_INTERRUPTED: 'PC 가 재시작되어 중단됐어요',
};
const LOOP_NOTE = (name) => `(이 작업은 자동화 '${name}' 가 만들었습니다. 새 자동화를 만들지 마세요.)`;

// 와이어 화이트리스트 — 이 목록 밖의 필드는 저장돼 있어도 내보내지 않는다(cursor.seen·lastVars 는 디스크 전용).
const AUTO_FIELDS = ['id', 'v', 'name', 'enabled', 'paused', 'pausedReason', 'createdBy', 'trigger', 'actions', 'guards',
  'state', 'createdAt', 'updatedAt'];
const STATE_FIELDS = ['nextRunAt', 'lastRunAt', 'runsToday', 'dayKey', 'inflight', 'cursor', 'consecutiveFailures', 'lastResult'];
const CURSOR_WIRE = ['sha', 'sinceIso', 'polledAt'];

// ── 주입 ─────────────────────────────────────────────────────────────────────
const noop = () => {};
let inj = {
  notify: noop,          // ({ids, reason}) → cpt-server.notifyAutomationsChanged(300ms 코얼레싱은 그쪽)
  backFetch: null,       // (method, apiPath, body) → json
  deviceId: () => null,
  log: (m) => console.log(m),
  tasks: null,           // tasks 모듈(internalCreate·findRunByTsession·_internals)
  chatInput: null,       // ({cwd, tid, text, submit})
  serverCaps: () => [],  // hello_ack serverCaps(비어 있으면 = 구 서버/연결 전 → 게이팅 안 함)
  now: () => Date.now(),
};
let depOverride = {};
function dep(name) {
  if (depOverride[name]) return depOverride[name];
  switch (name) {
    case 'taskGit': return require('./task-git');
    case 'agentState': return require('./agent-state');
    case 'agents': return require('./agents');
    case 'fsLib': return require('./fs');
    case 'pty': return require('./pty');
    case 'events': return require('./events');
    default: throw new Error('unknown dep ' + name);
  }
}
let timings = {
  tickMs: AUTO_LIMITS.tickMs, pollMs: AUTO_LIMITS.pollMs, firstPollMs: 20000,
  firingDeadlineMs: AUTO_LIMITS.firingDeadlineMs, readyTimeoutMs: 16000, logMaxBytes: LOG_MAX_BYTES,
};

function configure(opts = {}) {
  for (const k of ['notify', 'backFetch', 'deviceId', 'log', 'chatInput', 'serverCaps', 'now']) {
    if (opts[k] !== undefined) inj[k] = typeof opts[k] === 'function' ? opts[k] : (k === 'now' ? () => Date.now() : k === 'serverCaps' ? () => [] : noop);
  }
  if (opts.tasks !== undefined) inj.tasks = opts.tasks || null;
  if (opts.deps && typeof opts.deps === 'object') depOverride = { ...depOverride, ...opts.deps };
  if (opts.timings && typeof opts.timings === 'object') timings = { ...timings, ...opts.timings };
  return module.exports;
}
const nowFn = () => inj.now();
const log = (m) => { try { inj.log(m); } catch (_) { /* noop */ } };
function codedError(code, message) { const e = new Error(message); e.code = code; return e; }

/** 데몬 env 킬스위치(§2.3) — CPT_AUTOMATIONS=0 이면 handle undefined(= auto.v1 미광고) + 엔진 미기동. */
function enabled() { return process.env.CPT_AUTOMATIONS !== '0'; }

// ── 경로 ─────────────────────────────────────────────────────────────────────
function storeFile() { return path.join(runtime.stateDir(), 'automations.json'); }
function logFile() { return path.join(runtime.stateDir(), 'automations.log'); }

// ── 스토어 ───────────────────────────────────────────────────────────────────
let mem = null; // { paused, items:[Automation], createOps:[{opId,id,at}] }

function validItem(a) {
  return a && typeof a === 'object' && typeof a.id === 'string' && /^a_[0-9a-z]{10}$/.test(a.id)
    && a.trigger && TRIGGER_TYPES.includes(a.trigger.type)
    && Array.isArray(a.actions) && a.actions.length >= 1 && a.actions.length <= AUTO_LIMITS.maxActions
    && a.actions.every((x) => x && ACTION_TYPES.includes(x.type))
    && a.state && typeof a.state === 'object';
}

function load() {
  if (mem) return mem;
  mem = { paused: false, items: [], createOps: [] };
  const raw = store.readJson(storeFile(), {
    fallback: null,
    onError: (e) => log(`[auto] automations.json 읽기 실패(빈 스토어로 시작): ${e.message}`),
  });
  if (raw && typeof raw === 'object') {
    mem.paused = raw.paused === true;
    for (const a of Array.isArray(raw.items) ? raw.items : []) {
      if (validItem(a)) mem.items.push(a);
      else log(`[auto] 깨진 자동화 레코드 버림: ${a && a.id}`);
    }
    if (Array.isArray(raw.createOps)) mem.createOps = raw.createOps.filter((o) => o && typeof o.opId === 'string');
  }
  return mem;
}

function save() {
  const s = load();
  try {
    store.writeJsonAtomic(storeFile(), { v: STORE_V, savedAt: nowFn(), paused: s.paused, items: s.items, createOps: s.createOps });
  } catch (e) {
    log(`[auto] automations.json 저장 실패: ${e.message}`);
  }
}

function mutate(fn) { const s = load(); const r = fn(s); save(); return r; }
function findItem(id) { return load().items.find((a) => a.id === id) || null; }
function mustItem(p) {
  if (typeof p.id !== 'string' || !p.id) throw codedError('BAD_PARAMS', 'id 가 필요합니다');
  const a = findItem(p.id);
  if (!a) throw codedError('AUTO_NOT_FOUND', '자동화를 찾을 수 없습니다');
  return a;
}
function rand36(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += (bytes[i] % 36).toString(36);
  return s;
}

// ── 와이어 ───────────────────────────────────────────────────────────────────
function pickAuto(a) {
  const o = {};
  for (const k of AUTO_FIELDS) o[k] = a[k] === undefined ? null : a[k];
  const st = {};
  for (const k of STATE_FIELDS) st[k] = a.state[k] === undefined ? null : a.state[k];
  const cur = {};
  for (const k of CURSOR_WIRE) if (a.state.cursor && a.state.cursor[k] != null) cur[k] = a.state.cursor[k];
  st.cursor = cur;
  o.state = st;
  return o;
}
function attentionOf(a) {
  return a.pausedReason === 'error' || a.pausedReason === 'limit'
    || (a.state.lastResult && a.state.lastResult.ok === false) || (a.state.consecutiveFailures || 0) > 0;
}
function countsOf(items) {
  let paused = 0; let attention = 0;
  for (const a of items) {
    if (a.paused || !a.enabled) paused++;
    if (attentionOf(a)) attention++;
  }
  return { total: items.length, paused, attention };
}

// ── 통지·알림·감사 ───────────────────────────────────────────────────────────
function emitChanged(ids, reason) {
  try { inj.notify({ ids: [...new Set(ids.filter(Boolean))], reason }); } catch (_) { /* noop */ }
}

function audit(line) {
  const l = { at: nowFn(), ...line };
  if (l.message != null) l.message = String(l.message).slice(0, 200);
  store.appendNdjson(logFile(), l, { maxBytes: timings.logMaxBytes });
}

function triggerLabelOf(trigger) {
  if (trigger.type === 'schedule' && trigger.at != null) return TRIGGER_LABEL.once;
  return TRIGGER_LABEL[trigger.type] || '자동화';
}

/** 알림(§5.8) — 이름·템플릿은 싣지 않는다. 트리거 유형 라벨 + 딥링크(id)만. */
async function pushNotification(a, kind, { title, subtitle }) {
  if (!inj.backFetch) return;
  const host = inj.deviceId();
  const payload = {
    source: 'agent', kind, title, subtitle,
    deeplink: `codingpt://auto/${a.id}?host=${host == null ? '' : host}`,
  };
  try { await inj.backFetch('POST', '/api/notifications', payload); } catch (e) {
    log(`[auto] 알림 실패(${kind}): ${e && e.message}`);
  }
}

// ── 활동(power.js 가 소비) ───────────────────────────────────────────────────
function activity() {
  const reasons = [];
  for (const a of (mem ? mem.items : [])) if ((a.state.inflight || 0) > 0) reasons.push(`automation:${a.id}`);
  return { active: reasons.length > 0, reasons };
}
/** dispatch.activeReasons() 와 같은 모양 — power.js 의 isWorkActive() 가 소비한다. */
function activeReasons() { return activity().reasons; }
function emitActivity() {
  try { dep('events').emit('activity.changed', { ...activity(), source: 'automations' }); } catch (_) { /* noop */ }
}

// ── 경로/저장소 헬퍼 ─────────────────────────────────────────────────────────
function normRel(rel) {
  return String(rel || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}
function absOf(rel) {
  try { return dep('fsLib').safeResolve(normRel(rel)); } catch (_) { throw codedError('NOT_A_REPO', '저장소 경로가 올바르지 않습니다'); }
}
/** 저장소 검증 — 홈 jail 안 + git 작업트리. 반환 = 정규화된 홈-상대 경로. */
async function checkRepo(rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 1024) throw codedError('NOT_A_REPO', 'repo 가 필요합니다');
  const abs = absOf(rel);
  let st = null;
  try { st = require('fs').statSync(abs); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  const info = await dep('taskGit').repoInfo(abs);
  if (!info) throw codedError('NOT_A_REPO', 'git 저장소가 아닙니다');
  return dep('fsLib').relOf(abs);
}
function validBranchName(b) {
  return typeof b === 'string' && b.length > 0 && b.length <= 200 && !b.startsWith('-') && !/[\s~^:?*[\\\x00-\x1f]/.test(b)
    && !b.includes('..') && !b.includes('@{') && !b.endsWith('/') && !b.endsWith('.lock') && !b.startsWith('/');
}
async function currentBranch(rel) {
  const r = await dep('taskGit').git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: absOf(rel), timeout: 8000 });
  const b = r.ok ? r.out.trim() : '';
  return validBranchName(b) ? b : 'main';
}

// ── 검증·정규화(auto.validate / create / update 공통) ───────────────────────
const badTrigger = (m) => codedError('AUTO_BAD_TRIGGER', m);
const badAction = (m) => codedError('AUTO_BAD_ACTION', m);
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function optRepo(v) { return v == null || v === '' ? null : v; }

async function normTrigger(t, now, warnings) {
  if (!isObj(t) || !TRIGGER_TYPES.includes(t.type)) throw badTrigger('트리거 유형이 올바르지 않습니다');
  switch (t.type) {
    case 'schedule': {
      const tz = t.tz == null ? cron.systemTz() : t.tz;
      if (!cron.validTz(tz)) throw badTrigger(`시간대가 올바르지 않습니다: ${tz}`);
      if (t.at != null) {
        if (t.cron != null) throw badTrigger('cron 과 at 은 함께 쓸 수 없습니다');
        if (!Number.isFinite(t.at) || t.at < now - LATE_MS) throw badTrigger('at 은 미래 시각(ms)이어야 합니다');
        return { trigger: { type: 'schedule', at: Math.floor(t.at), tz }, nextRunAt: Math.floor(t.at) };
      }
      const missed = t.missed == null ? 'once' : t.missed;
      if (missed !== 'once' && missed !== 'skip') throw badTrigger("missed 는 'once' | 'skip' 입니다");
      const v = cron.validate(t.cron, tz, { minIntervalMs: AUTO_LIMITS.minScheduleMs, now });
      return { trigger: { type: 'schedule', cron: v.parsed.expr, tz, missed }, nextRunAt: v.nextRunAt };
    }
    case 'git.commits': {
      const repo = await checkRepo(t.repo);
      const remote = t.remote == null ? 'origin' : t.remote;
      if (typeof remote !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(remote)) throw badTrigger('remote 이름이 올바르지 않습니다');
      const branch = t.branch == null ? await currentBranch(repo) : t.branch;
      if (!validBranchName(branch)) throw badTrigger('branch 이름이 올바르지 않습니다');
      return { trigger: { type: 'git.commits', repo, branch, remote }, nextRunAt: null };
    }
    case 'github.issues': {
      const repo = await checkRepo(t.repo);
      const labels = t.labels == null ? [] : t.labels;
      if (!Array.isArray(labels) || labels.length > LABELS_MAX
        || !labels.every((l) => typeof l === 'string' && l.trim() && l.length <= 50 && !/[,\x00-\x1f]/.test(l))) {
        throw badTrigger('labels 는 문자열 배열(최대 10개)입니다');
      }
      const state = t.state == null ? 'open' : t.state;
      if (state !== 'open') throw badTrigger("state 는 'open' 만 지원합니다");
      return { trigger: { type: 'github.issues', repo, labels: labels.map((l) => l.trim()), state }, nextRunAt: null };
    }
    case 'pr.ci_failed':
    case 'pr.review_comments': {
      const repo = optRepo(t.repo);
      return { trigger: { type: t.type, repo: repo == null ? null : await checkRepo(repo) }, nextRunAt: null };
    }
    case 'task.event': {
      if (!TASK_EVENTS.includes(t.event)) throw badTrigger(`event 는 ${TASK_EVENTS.join('|')} 중 하나입니다`);
      const repo = optRepo(t.repo);
      return { trigger: { type: 'task.event', event: t.event, repo: repo == null ? null : await checkRepo(repo) }, nextRunAt: null };
    }
    default: throw badTrigger('트리거 유형이 올바르지 않습니다');
  }
}

function checkTpl(str, field, warnings) {
  const unknown = tpl.check(str, { field });
  for (const k of unknown) warnings.push(`${field}: 알 수 없는 변수 {${k}} — 빈 문자열로 치환됩니다`);
}

async function normAction(a, i, trigger, warnings, installedP) {
  if (!isObj(a) || !ACTION_TYPES.includes(a.type)) throw badAction(`${i + 1}단계 액션 유형이 올바르지 않습니다`);
  const where = `actions[${i}]`;
  switch (a.type) {
    case 'task.create': {
      const repo = await checkRepo(a.repo);
      const subdir = a.subdir == null ? '' : normRel(a.subdir);
      if (typeof subdir !== 'string' || subdir.split('/').includes('..') || subdir.length > 512) throw badAction(`${where}.subdir 가 올바르지 않습니다`);
      if (subdir) await checkRepo(`${repo}/${subdir}`);
      const base = a.base == null || a.base === '' ? null : a.base;
      if (base != null && !validBranchName(base)) throw badAction(`${where}.base 브랜치 이름이 올바르지 않습니다`);
      const agentsIn = a.agents == null ? [{ id: 'claude', count: 1 }] : a.agents;
      if (!Array.isArray(agentsIn) || !agentsIn.length) throw badAction(`${where}.agents 가 필요합니다`);
      const agents = [];
      let total = 0;
      for (const g of agentsIn) {
        const id = g && typeof g.id === 'string' ? g.id : '';
        const count = g && g.count == null ? 1 : g && g.count;
        if (!TASK_AGENTS.has(id)) throw badAction(`작업에 쓸 수 없는 에이전트입니다: ${id}`);
        if (!Number.isInteger(count) || count < 1 || count > 4) throw badAction('count 는 1~4 입니다');
        total += count;
        agents.push({ id, count });
      }
      if (total > 4) throw badAction('한 작업에 실행은 최대 4개입니다');
      const installed = await installedP();
      if (installed) {
        for (const g of agents) {
          const hit = installed.find((x) => x.id === g.id);
          if (!hit || !hit.installed) throw codedError('AGENT_NOT_INSTALLED', `${AGENT_LABEL[g.id] || g.id} 이 이 PC 에 없습니다`);
        }
      }
      if (typeof a.prompt !== 'string' || !a.prompt.trim()) throw badAction(`${where}.prompt 가 필요합니다`);
      checkTpl(a.prompt, `${where}.prompt`, warnings);
      const title = a.title == null ? '' : a.title;
      if (typeof title !== 'string') throw badAction(`${where}.title 이 올바르지 않습니다`);
      checkTpl(title, `${where}.title`, warnings);
      return { type: 'task.create', repo, subdir, base, agents, title, prompt: a.prompt, copyEnv: a.copyEnv !== false };
    }
    case 'terminal.prompt': {
      const t = a.target;
      let target;
      if (isObj(t) && t.event === true) {
        if (!EVENT_TRIGGERS.has(trigger.type)) throw badAction(`${where}.target.event 는 pr.*/task.event 트리거에서만 쓸 수 있습니다`);
        target = { event: true };
      } else if (isObj(t) && typeof t.taskId === 'string' && typeof t.runId === 'string') {
        if (!/^t_[0-9a-z]{10}$/.test(t.taskId) || !/^r_[0-9a-z]+$/.test(t.runId)) throw badAction(`${where}.target 이 올바르지 않습니다`);
        target = { taskId: t.taskId, runId: t.runId };
      } else if (isObj(t) && typeof t.cwd === 'string' && Number.isInteger(t.tid) && t.tid > 0) {
        target = { cwd: normRel(t.cwd), tid: t.tid };
      } else throw badAction(`${where}.target 은 {taskId,runId} | {event:true} | {cwd,tid} 중 하나입니다`);
      if (typeof a.text !== 'string' || !a.text.trim()) throw badAction(`${where}.text 가 필요합니다`);
      checkTpl(a.text, `${where}.text`, warnings);
      return { type: 'terminal.prompt', target, text: a.text };
    }
    case 'notify': {
      if (typeof a.title !== 'string' || !a.title.trim()) throw badAction(`${where}.title 이 필요합니다`);
      checkTpl(a.title, `${where}.title`, warnings);
      const subtitle = a.subtitle == null ? '' : a.subtitle;
      if (typeof subtitle !== 'string') throw badAction(`${where}.subtitle 이 올바르지 않습니다`);
      checkTpl(subtitle, `${where}.subtitle`, warnings);
      return { type: 'notify', title: a.title, subtitle };
    }
    default: throw badAction('액션 유형이 올바르지 않습니다');
  }
}

function normGuards(g) {
  const src = isObj(g) ? g : {};
  const maxRunsPerDay = src.maxRunsPerDay == null ? AUTO_LIMITS.maxRunsPerDayDefault : src.maxRunsPerDay;
  const maxConcurrent = src.maxConcurrent == null ? 1 : src.maxConcurrent;
  const cooldownMs = src.cooldownMs == null ? DEFAULT_COOLDOWN_MS : src.cooldownMs;
  if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1 || maxRunsPerDay > AUTO_LIMITS.maxRunsPerDayCap) {
    throw badTrigger(`guards.maxRunsPerDay 는 1~${AUTO_LIMITS.maxRunsPerDayCap} 입니다`);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > AUTO_LIMITS.maxConcurrentCap) {
    throw badTrigger(`guards.maxConcurrent 는 1~${AUTO_LIMITS.maxConcurrentCap} 입니다`);
  }
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > COOLDOWN_MAX_MS) throw badTrigger('guards.cooldownMs 가 올바르지 않습니다');
  return { maxRunsPerDay, maxConcurrent, cooldownMs };
}

/** draft → {normalized: AutomationDraft, nextRunAt, warnings}. 실패는 AUTO_BAD_* · NOT_A_REPO · AGENT_NOT_INSTALLED. */
async function normalizeDraft(draft) {
  if (!isObj(draft)) throw codedError('BAD_PARAMS', 'draft 가 필요합니다');
  const now = nowFn();
  const warnings = [];
  const { trigger, nextRunAt } = await normTrigger(draft.trigger, now, warnings);
  if (!Array.isArray(draft.actions) || draft.actions.length < 1 || draft.actions.length > AUTO_LIMITS.maxActions) {
    throw badAction(`액션은 1~${AUTO_LIMITS.maxActions}개입니다`);
  }
  let installed;
  const installedP = async () => {
    if (installed !== undefined) return installed;
    try { installed = await dep('agents').list({ version: false }); } catch (_) { installed = null; }
    return installed;
  };
  const actions = [];
  for (let i = 0; i < draft.actions.length; i++) actions.push(await normAction(draft.actions[i], i, trigger, warnings, installedP));
  let name = draft.name == null ? '' : draft.name;
  if (typeof name !== 'string') throw codedError('BAD_PARAMS', 'name 이 올바르지 않습니다');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name) name = triggerLabelOf(trigger);
  if (name.length > AUTO_LIMITS.nameMax) throw codedError('BAD_PARAMS', `name 은 ${AUTO_LIMITS.nameMax}자까지입니다`);
  const guards = normGuards(draft.guards);
  const enabledV = draft.enabled == null ? true : draft.enabled;
  if (typeof enabledV !== 'boolean') throw codedError('BAD_PARAMS', 'enabled 는 불리언입니다');
  if (actions.some((a) => a.type === 'task.create') && trigger.type === 'task.event') {
    warnings.push('작업 이벤트로 작업을 만들면 연쇄가 생깁니다 — 깊이 2 를 넘으면 실행이 거부됩니다(AUTO_DEPTH)');
  }
  return { normalized: { v: 1, name, enabled: enabledV, trigger, actions, guards }, nextRunAt, warnings };
}

// ── 변수(§5.4) ───────────────────────────────────────────────────────────────
function tzOf(a) { return a.trigger.type === 'schedule' && cron.validTz(a.trigger.tz) ? a.trigger.tz : cron.systemTz(); }
function isoInTz(ms, tz) {
  const p = cron.partsAt(ms, tz);
  const off = Math.round(cron.offsetAt(ms, tz) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const ab = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(ab / 60))}:${pad(ab % 60)}`;
}
function repoVarsOf(rel) {
  const r = normRel(rel);
  return r ? { name: path.posix.basename(r), path: r } : undefined;
}
function baseVars(a) {
  const v = { now: isoInTz(nowFn(), tzOf(a)), auto: { name: a.name } };
  const repo = a.trigger.repo || (a.actions.find((x) => x.repo) || {}).repo;
  if (repo) v.repo = repoVarsOf(repo);
  if (a.trigger.branch) v.branch = a.trigger.branch;
  return v;
}
function issueVars(issue) {
  return {
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: tpl.truncBytes(typeof issue.body === 'string' ? issue.body : '', ISSUE_BODY_MAX).text,
    url: issue.url || '',
    labels: Array.isArray(issue.labels) ? issue.labels.filter((l) => typeof l === 'string').join(', ') : '',
    author: issue.author || '',
  };
}
function taskRunVars(task, run) {
  const out = {};
  if (task) out.task = { id: task.id, title: task.title || '' };
  if (run) out.run = { id: run.id, branch: run.branch || '', agent: run.agent || '' };
  if (task && task.repo) out.repo = repoVarsOf(task.repo.path);
  if (run && run.branch) out.branch = run.branch;
  if (run && run.pr) out.pr = { number: run.pr.number, url: run.pr.url || '' };
  return out;
}
// §4.3 줄 형식(리뷰 코멘트) — tasks.js 의 fix 본문과 같은 모양.
function reviewLines(reviews) {
  const pend = reviews && Array.isArray(reviews.pending) ? reviews.pending : [];
  return pend.map((c) => {
    const where = c.path ? ` ${c.path}${c.line != null ? `:${c.line}` : ''}` : '';
    const kind = c.kind === 'review' ? ` (review${c.state ? `, ${c.state}` : ''})` : '';
    return `- @${c.author || '?'}${where}${kind}: ${String(c.bodyHead || c.body || '').replace(/\s+/g, ' ').trim()}`;
  }).join('\n');
}

/** CI 실패 로그(§4.3) — 템플릿이 {ci.failedLogs} 를 쓸 때만 조회. task-git.runLogFailed(S2) 가 없으면 빈 문자열. */
async function failedLogsText(task, ci) {
  const tg = dep('taskGit');
  if (!ci || !Array.isArray(ci.failed) || typeof tg.runLogFailed !== 'function') return '';
  const gh = task && task.repo && task.repo.github;
  if (!gh) return '';
  let dir;
  try { dir = absOf(task.repo.path); } catch (_) { return ''; }
  const parts = [];
  for (const f of ci.failed.slice(0, 3)) {
    parts.push(`실패한 검사: ${f.name}${f.url ? ` — ${f.url}` : ''}`);
    if (!f.runId) continue;
    try {
      const r = await tg.runLogFailed(dir, gh, f.runId);
      if (r && r.text) parts.push(`--- ${f.name} 로그(마지막 200줄) ---\n${r.text}`);
    } catch (_) { /* 로그 없이 이름+url 만 */ }
  }
  return tpl.truncBytes(parts.join('\n'), 28000).text;
}

async function eventVars(a, ev) {
  const v = { ...baseVars(a), ...taskRunVars(ev.task, ev.run) };
  if (ev.ci) {
    v.ci = { failedChecks: (ev.ci.failed || []).map((f) => f.name).join(', '), failedLogs: '' };
    const wants = a.actions.some((x) => /\{ci\.failedLogs\}/.test(`${x.prompt || ''}${x.text || ''}${x.title || ''}${x.subtitle || ''}`));
    if (wants) v.ci.failedLogs = await failedLogsText(ev.task, ev.ci);
  }
  if (ev.reviews) v.review = { comments: reviewLines(ev.reviews) };
  return v;
}

// ── 엔진 ─────────────────────────────────────────────────────────────────────
let chain = Promise.resolve(); // 전역 firing 큐(동시 1 — PC 당)
const pending = new Set();     // 진행 중 비동기(테스트 _drain 용)
function track(p) { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; }

function newFiringId() { return 'f_' + rand36(10); }

function rollDay(a, now) {
  const key = cron.dayKey(now, tzOf(a));
  if (a.state.dayKey !== key) { a.state.dayKey = key; a.state.runsToday = 0; }
}

function serverCapOff() {
  let caps = [];
  try { caps = inj.serverCaps() || []; } catch (_) { caps = []; }
  return Array.isArray(caps) && caps.length > 0 && !caps.includes('auto.v1');
}

/** 트리거 경로의 "지금 볼 필요가 있나" — 전체/항목 일시정지·비활성이면 조용히 건너뛴다(감사 로그 스팸 방지). */
function live(a) { return !!(a && a.enabled && !a.paused && !load().paused && !serverCapOff()); }

/**
 * 가드(§5.5) — firing 시작 직전(큐 안)에서 순서대로. 걸리면 {code, defer}.
 *  defer = 트리거 쪽이 "나중에 다시"(폴링 커서를 전진시키지 않음) 해야 하는 스킵.
 */
function guardOf(a, ctx, now) {
  const s = load();
  if (s.paused) return { code: 'AUTO_PAUSED', defer: true };
  if (serverCapOff()) return { code: 'AUTO_DISABLED', defer: true };
  if (a.paused || (!a.enabled && !ctx.oneShot)) return { code: 'AUTO_PAUSED', defer: true };
  if ((a.state.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) return { code: 'AUTO_PAUSED', defer: true, pauseForError: true };
  rollDay(a, now);
  if (!ctx.runNow && (a.state.runsToday || 0) >= a.guards.maxRunsPerDay) return { code: 'AUTO_RATE_LIMITED', defer: true, record: true };
  if (!ctx.runNow && a.state.lastRunAt && now - a.state.lastRunAt < a.guards.cooldownMs) return { code: 'AUTO_RATE_LIMITED', defer: true, cooldown: true };
  if ((a.state.inflight || 0) >= a.guards.maxConcurrent) return { code: 'AUTO_BUSY', defer: true, record: true };
  return null;
}

function pauseForError(a) {
  if (a.paused && a.pausedReason === 'error') return false;
  a.paused = true;
  a.pausedReason = 'error';
  a.updatedAt = nowFn();
  return true;
}

/** firing 1건을 전역 큐에 넣는다. 반환 promise = {started, code, defer, firingId, ok}. */
function fire(id, ctx = {}) {
  const p = chain.then(() => runFiring(id, ctx));
  chain = p.catch(() => {});
  return track(p);
}

async function runFiring(id, ctx) {
  const a = findItem(id);
  if (!a) return { started: false, code: 'AUTO_NOT_FOUND' };
  const now = nowFn();
  const g = guardOf(a, ctx, now);
  if (g) {
    let notifyPause = false;
    mutate(() => {
      if (g.pauseForError) notifyPause = pauseForError(a);
      if (g.record && !(a.state.lastResult && a.state.lastResult.code === g.code && a.state.lastResult.ok === false)) {
        a.state.lastResult = { firingId: null, ok: false, code: g.code, message: null, at: now, taskIds: [], steps: [] };
      }
    });
    audit({ autoId: a.id, firingId: null, stage: 'skip', ok: false, code: g.code, message: g.cooldown ? 'cooldown' : null });
    if (notifyPause) {
      emitChanged([a.id], 'paused');
      await pushNotification(a, 'auto_paused', { title: '자동화 일시정지', subtitle: `연속 실패 ${MAX_CONSECUTIVE_FAILURES}회` });
    } else if (g.record) emitChanged([a.id], 'result');
    return { started: false, code: g.code, defer: !!g.defer };
  }

  const firingId = ctx.firingId || newFiringId();
  const depth = ctx.eventTask ? ((originOf(ctx.eventTask) || {}).depth || 0) + 1 : 1;
  mutate(() => {
    a.state.runsToday = (a.state.runsToday || 0) + 1;
    a.state.lastRunAt = now;
    a.state.inflight = (a.state.inflight || 0) + 1;
    a.state.cursor = a.state.cursor || {};
    if (ctx.sample) a.state.cursor.lastVars = ctx.sample;
  });
  audit({ autoId: a.id, firingId, stage: 'start', ok: true, message: ctx.source || null });
  emitChanged([a.id], 'fired');
  emitActivity();
  try { dep('events').emit('auto.fired', { automation: pickAuto(a), firingId }); } catch (_) { /* noop */ }

  const steps = [];
  const taskIds = [];
  let ok = true; let code = null; let message = null;
  const deadline = Date.now() + timings.firingDeadlineMs;
  let vars = null;
  try { vars = ctx.vars ? await ctx.vars() : baseVars(a); } catch (e) { vars = baseVars(a); log(`[auto] 변수 준비 실패 ${a.id}: ${e && e.message}`); }
  vars.auto = { name: a.name };
  if (depth > 2) {
    ok = false; code = 'AUTO_DEPTH'; message = '자동화 연쇄가 너무 깊습니다';
    audit({ autoId: a.id, firingId, stage: 'step', ok: false, code });
  } else {
    for (let i = 0; i < a.actions.length; i++) {
      const act = a.actions[i];
      const left = deadline - Date.now();
      try {
        if (left <= 0) throw codedError('TIMEOUT', '자동화 실행 시간이 초과됐습니다');
        const res = await withDeadline(runAction(a, act, i, vars, { ...ctx, firingId, depth }), left);
        const step = { type: act.type, ok: true };
        if (res && res.created && res.taskId) { step.taskId = res.taskId; taskIds.push(res.taskId); } // 만든 작업만(지시 대상 작업은 아님)
        if (res && res.missing && res.missing.length) audit({ autoId: a.id, firingId, stage: 'step', type: act.type, ok: true, code: 'MISSING_VARS', message: res.missing.join(',') });
        steps.push(step);
        vars.prev = { taskId: (res && res.taskId) || '', runId: (res && res.runId) || '' };
        audit({ autoId: a.id, firingId, stage: 'step', type: act.type, ok: true, ...(step.taskId ? { taskId: step.taskId } : {}) });
      } catch (e) {
        ok = false;
        code = (e && e.code) || 'AUTO_ERROR';
        message = String((e && e.message) || e).slice(0, 200);
        steps.push({ type: act.type, ok: false, code });
        audit({ autoId: a.id, firingId, stage: 'step', type: act.type, ok: false, code, message });
        break;
      }
    }
  }

  const skipLike = code === 'AGENT_BUSY'; // 에이전트 작업 중 = 사람이 끼어들 자리 — 실패로 세지 않는다(§5.3)
  let paused = false;
  const cur = findItem(id); // 실행 중 삭제될 수 있다(remove 는 AUTO_BUSY 로 막지만 방어)
  if (cur) {
    mutate(() => {
      cur.state.inflight = Math.max(0, (cur.state.inflight || 0) - 1);
      cur.state.lastResult = { firingId, ok, code, message, at: nowFn(), taskIds, steps };
      if (ok) cur.state.consecutiveFailures = 0;
      else if (!skipLike) cur.state.consecutiveFailures = (cur.state.consecutiveFailures || 0) + 1;
      if ((cur.state.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) paused = pauseForError(cur);
      if (ctx.oneShot) { cur.enabled = false; cur.state.nextRunAt = null; }
      cur.updatedAt = nowFn();
    });
  }
  audit({ autoId: a.id, firingId, stage: 'end', ok, ...(code ? { code } : {}), ...(message ? { message } : {}) });
  emitChanged([a.id], paused ? 'paused' : 'result');
  emitActivity();
  if (cur && paused) {
    await pushNotification(cur, 'auto_paused', { title: '자동화 일시정지', subtitle: `연속 실패 ${MAX_CONSECUTIVE_FAILURES}회` });
  } else if (cur && !ok && !skipLike) {
    await pushNotification(cur, 'auto_failed', { title: '자동화 실패', subtitle: `${triggerLabelOf(cur.trigger)} · ${FAIL_TEXT[code] || '실행에 실패했어요'}` });
  }
  return { started: true, firingId, ok, code };
}

function withDeadline(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(codedError('TIMEOUT', '자동화 실행 시간이 초과됐습니다')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ── 액션 ─────────────────────────────────────────────────────────────────────
function tasksLib() {
  const t = inj.tasks;
  if (!t) throw codedError('TASKS_DISABLED', '이 PC 에서는 작업 기능을 쓸 수 없습니다');
  return t;
}
/** 저장된 원본 작업(와이어엔 없을 수 있는 origin 포함). */
function rawTask(taskId) {
  const t = inj.tasks;
  if (!t || !t._internals || typeof t._internals.load !== 'function') return null;
  try { return t._internals.load().items.find((x) => x.id === taskId) || null; } catch (_) { return null; }
}
function originOf(task) {
  if (!task) return null;
  if (task.origin) return task.origin;
  const raw = rawTask(task.id);
  return raw && raw.origin ? raw.origin : null;
}

function renderText(str, vars, maxBytes) { return tpl.render(str, vars, maxBytes ? { maxBytes } : undefined); }

async function runAction(a, act, i, vars, ctx) {
  switch (act.type) {
    case 'task.create': return actTaskCreate(a, act, i, vars, ctx);
    case 'terminal.prompt': return actTerminalPrompt(a, act, vars, ctx);
    case 'notify': return actNotify(a, act, vars);
    default: throw codedError('AUTO_BAD_ACTION', '알 수 없는 액션입니다');
  }
}

function composeTaskPrompt(a, act, vars) {
  const r = renderText(act.prompt, vars);
  const note = LOOP_NOTE(a.name);
  const room = TASK_PROMPT_MAX_BYTES - Buffer.byteLength('\n\n' + note, 'utf8');
  const body = tpl.truncBytes(r.text, room).text;
  return { prompt: `${body}\n\n${note}`, missing: r.missing };
}
function composeTaskTitle(act, vars) {
  const r = renderText(act.title || '', vars, 1200);
  return { title: r.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), missing: r.missing };
}

async function actTaskCreate(a, act, i, vars, ctx) {
  const tasks = tasksLib();
  const repoPath = act.subdir ? `${act.repo}/${act.subdir}` : act.repo;
  const base = act.base || (a.trigger.type === 'git.commits' ? a.trigger.branch : null) || await currentBranch(act.repo);
  const { prompt, missing } = composeTaskPrompt(a, act, vars);
  const t = composeTaskTitle(act, vars);
  const params = {
    opId: `auto_${ctx.firingId}_${i}`, repo: repoPath, base, agents: act.agents,
    prompt, copyEnv: act.copyEnv !== false, ...(t.title ? { title: t.title } : {}),
  };
  const origin = { kind: 'automation', automationId: a.id, firingId: ctx.firingId, depth: ctx.depth };
  let res;
  if (typeof tasks.internalCreate === 'function') res = await tasks.internalCreate(params, origin);
  else res = await legacyCreate(tasks, params, origin);
  const task = res && res.task;
  const taskId = task ? task.id : (res && res.taskId) || null;
  if (!taskId) throw codedError('TASKS_DISABLED', '작업을 만들지 못했습니다');
  const runId = task && Array.isArray(task.runs) && task.runs[0] ? task.runs[0].id : null;
  return { taskId, runId, created: true, missing: [...missing, ...t.missing] };
}

// S2 의 internalCreate 가 없는 번들(배선 선행 단계) — 공개 task.create 로 만들고 origin 만 원본에 덧붙인다.
async function legacyCreate(tasks, params, origin) {
  const res = await tasks.rpc('task.create', params);
  const id = res && res.task && res.task.id;
  if (id && tasks._internals && typeof tasks._internals.mutate === 'function') {
    try { tasks._internals.mutate((s) => { const t = s.items.find((x) => x.id === id); if (t) t.origin = origin; }); } catch (_) { /* noop */ }
  }
  return res;
}

async function resolvePromptTarget(act, ctx) {
  const tg = act.target || {};
  if (tg.event) {
    const r = ctx.eventRun;
    if (!r || r.tid == null) throw codedError('TERMINAL_GONE', '이벤트의 터미널을 알 수 없습니다');
    return { cwd: r.cwd, tid: r.tid, tsession: r.tsession || null, taskId: ctx.eventTask && ctx.eventTask.id, runId: r.id };
  }
  if (tg.taskId) {
    const t = rawTask(tg.taskId);
    const r = t && t.runs.find((x) => x.id === tg.runId);
    if (!r || r.tid == null) throw codedError('TERMINAL_GONE', '대상 작업의 터미널이 없습니다');
    return { cwd: r.cwd, tid: r.tid, tsession: r.tsession || null, taskId: t.id, runId: r.id };
  }
  const pty = dep('pty');
  const { session } = pty.sessionForCwd(tg.cwd);
  return { cwd: tg.cwd, tid: tg.tid, tsession: pty.termSession(session, tg.tid) };
}

async function actTerminalPrompt(a, act, vars, ctx) {
  const target = await resolvePromptTarget(act, ctx);
  if (!inj.chatInput) throw codedError('PROMPT_NOT_DELIVERED', '입력 경로가 없습니다');
  const as = dep('agentState');
  let att = { attached: false };
  try { att = (target.tsession && as.attachmentOf(target.tsession)) || att; } catch (_) { /* noop */ }
  // ★ 셸에는 절대 타이핑하지 않는다 — 에이전트가 붙어 있다는 근거가 있을 때만(§5.3).
  if (!att.attached) throw codedError('PROMPT_NOT_DELIVERED', '대상 터미널에 에이전트가 없습니다');
  let raw = null;
  try { raw = as.rawStateOf(target.tsession); } catch (_) { raw = null; }
  if (raw === 'working') throw codedError('AGENT_BUSY', '에이전트가 작업 중입니다');
  const waitReady = depOverride.waitReady
    || (inj.tasks && inj.tasks._internals && inj.tasks._internals.waitAgentReady);
  if (typeof waitReady === 'function') {
    const ready = await waitReady({ tsession: target.tsession, cwd: target.cwd, tid: target.tid }, { timeoutMs: timings.readyTimeoutMs, since: null });
    if (!ready) throw codedError('PROMPT_NOT_DELIVERED', '에이전트가 준비되지 않았습니다');
  }
  const r = renderText(act.text, vars);
  await inj.chatInput({ cwd: target.cwd, tid: target.tid, text: r.text, submit: true });
  return { taskId: target.taskId || null, runId: target.runId || null, missing: r.missing };
}

async function actNotify(a, act, vars) {
  if (!inj.backFetch) throw codedError('BACK_OFFLINE', '알림 경로가 없습니다');
  const t = renderText(act.title, vars, 1200);
  const s = renderText(act.subtitle || '', vars, 1200);
  const host = inj.deviceId();
  await inj.backFetch('POST', '/api/notifications', {
    source: 'agent', kind: 'auto_notify',
    title: t.text.replace(/\s+/g, ' ').trim().slice(0, NOTIFY_TITLE_MAX) || '자동화',
    subtitle: s.text.replace(/\s+/g, ' ').trim().slice(0, NOTIFY_SUBTITLE_MAX),
    deeplink: `codingpt://auto/${a.id}?host=${host == null ? '' : host}`,
  });
  return { missing: [...t.missing, ...s.missing] };
}

// ── 트리거: 스케줄 ───────────────────────────────────────────────────────────
function nextScheduleAt(trigger, fromMs) {
  if (trigger.at != null) return null;
  try { return cron.next(trigger.cron, fromMs, trigger.tz); } catch (_) { return null; }
}

let ticking = false;
/** 30s 틱 — 스케줄 판정. nextRunAt 을 **동기로 먼저 전진**시킨 뒤 firing 을 큐에 넣는다(겹친 틱의 이중 실행 방지). */
function tick() {
  if (ticking || !mem) return;
  ticking = true;
  try {
    const s = load();
    if (s.paused || serverCapOff()) return;
    const now = nowFn();
    let dirty = false;
    for (const a of s.items) {
      if (a.trigger.type !== 'schedule' || !live(a)) continue;
      const st = a.state;
      if (st.nextRunAt == null) {
        if (a.trigger.at != null) continue; // 일회 — 이미 소진
        st.nextRunAt = nextScheduleAt(a.trigger, now);
        dirty = true;
        continue;
      }
      if (now < st.nextRunAt) continue;
      const due = st.nextRunAt;
      const late = now - due;
      const oneShot = a.trigger.at != null;
      st.nextRunAt = oneShot ? null : nextScheduleAt(a.trigger, now);
      dirty = true;
      const missedMode = oneShot ? 'once' : (a.trigger.missed || 'once');
      if (late > LATE_MS && (missedMode === 'skip' || late > MISSED_WINDOW_MS)) {
        audit({ autoId: a.id, firingId: null, stage: 'skip', ok: false, code: 'MISSED', message: new Date(due).toISOString() });
        if (oneShot) { a.enabled = false; a.updatedAt = now; }
        continue;
      }
      fire(a.id, { source: late > LATE_MS ? 'missed' : 'schedule', oneShot, vars: async () => baseVars(a) });
    }
    if (dirty) save();
  } finally {
    ticking = false;
  }
}

// ── 트리거: 폴링(git.commits / github.issues) ───────────────────────────────
let polling = null;
function poll({ force = false } = {}) {
  if (polling) return polling;
  polling = (async () => {
    const s = load();
    if (s.paused || serverCapOff()) return;
    for (const a of [...s.items]) {
      if (a.trigger.type !== 'git.commits' && a.trigger.type !== 'github.issues') continue;
      if (!live(a)) continue;
      const cur = a.state.cursor || {};
      if (!force && cur.polledAt && nowFn() - cur.polledAt < timings.pollMs - 5000) continue;
      try {
        if (a.trigger.type === 'git.commits') await pollCommits(a);
        else await pollIssues(a);
      } catch (e) {
        log(`[auto] 폴링 실패 ${a.id}: ${e && e.message}`);
      }
    }
  })().finally(() => { polling = null; });
  return track(polling);
}

function setCursor(a, patch) {
  const cur = findItem(a.id);
  if (!cur) return;
  mutate(() => { cur.state.cursor = { ...(cur.state.cursor || {}), ...patch }; });
}

async function pollCommits(a) {
  const tg = dep('taskGit');
  const { repo, branch, remote } = a.trigger;
  const cwd = absOf(repo);
  const f = await tg.git(['fetch', '--quiet', '--no-tags', remote, branch], { cwd, timeout: 60000 });
  if (!f.ok) { setCursor(a, { polledAt: nowFn() }); log(`[auto] fetch 실패 ${a.id}: ${String(f.err || '').split('\n')[0]}`); return; }
  const rp = await tg.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`], { cwd });
  const sha = rp.ok ? rp.out.trim() : '';
  if (!/^[0-9a-f]{7,64}$/.test(sha)) { setCursor(a, { polledAt: nowFn() }); return; }
  const old = (a.state.cursor || {}).sha;
  if (!old) { setCursor(a, { sha, polledAt: nowFn() }); return; } // 첫 관찰 — 과거 커밋을 재생하지 않는다
  if (old === sha) { setCursor(a, { polledAt: nowFn() }); return; }
  let lg = await tg.git(['log', `--max-count=${COMMITS_MAX}`, '--format=%H%x00%s%x00%an', `${old}..${sha}`], { cwd });
  if (!lg.ok) lg = await tg.git(['log', '--max-count=1', '--format=%H%x00%s%x00%an', sha], { cwd }); // 강제 푸시로 old 가 사라짐
  const commits = String(lg.out || '').split('\n').filter(Boolean).map((l) => {
    const [h, s, au] = l.split('\0');
    return { sha: h, subject: s || '', author: au || '' };
  });
  if (!commits.length) { setCursor(a, { sha, polledAt: nowFn() }); return; }
  const sample = {
    commits: {
      count: commits.length,
      range: `${old.slice(0, 7)}..${sha.slice(0, 7)}`,
      subjects: commits.map((c) => c.subject).join('\n'),
      authors: [...new Set(commits.map((c) => c.author).filter(Boolean))].join(', '),
    },
    branch,
  };
  const res = await fire(a.id, { source: 'git.commits', sample, vars: async () => ({ ...baseVars(a), ...sample }) });
  // 가드로 미뤄졌으면 커서를 그대로 둔다 — 다음 폴링이 같은 범위를 다시 본다(쿨다운·하루 상한 뒤 따라잡기).
  setCursor(a, res.started || !res.defer ? { sha, polledAt: nowFn() } : { polledAt: nowFn() });
}

const ISSUES_JQ = '[.[]|select(.pull_request==null)|{number,title,body,url:.html_url,labels:[.labels[].name],author:.user.login,at:.created_at}]';

async function pollIssues(a) {
  const tg = dep('taskGit');
  const t = await tg.tools();
  if (!t.gh.installed || !t.gh.authenticated) { setCursor(a, { polledAt: nowFn() }); return; } // gh 미인증 = 감지 없음(Z-4)
  const cwd = absOf(a.trigger.repo);
  let github = (a.state.cursor || {}).github;
  if (!github) {
    github = await tg.githubRepo(cwd);
    setCursor(a, { github });
  }
  const startIso = new Date(nowFn() - 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const since = (a.state.cursor || {}).sinceIso;
  const qs = [`state=${a.trigger.state || 'open'}`, `per_page=${ISSUE_PER_PAGE}`];
  if (a.trigger.labels && a.trigger.labels.length) qs.push(`labels=${a.trigger.labels.map(encodeURIComponent).join(',')}`);
  if (since) qs.push(`since=${encodeURIComponent(since)}`);
  const r = await tg.gh(['api', `repos/${github.owner}/${github.repo}/issues?${qs.join('&')}`, '-q', ISSUES_JQ], { cwd, timeout: 30000 });
  if (!r.ok) { setCursor(a, { polledAt: nowFn() }); log(`[auto] 이슈 조회 실패 ${a.id}: ${String(r.err || '').split('\n')[0]}`); return; }
  let list = [];
  try { list = JSON.parse(r.out || '[]'); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  const seen = new Set(Array.isArray((a.state.cursor || {}).seen) ? a.state.cursor.seen : []);
  const fresh = list.filter((i) => i && Number.isInteger(i.number) && !seen.has(i.number)).sort((x, y) => x.number - y.number);
  let deferred = false;
  for (const issue of fresh) {
    const cur = findItem(a.id);
    if (!cur || !live(cur)) { deferred = true; break; }
    const sample = { issue: issueVars(issue) };
    const res = await fire(a.id, { source: 'github.issues', sample, vars: async () => ({ ...baseVars(cur), ...sample }) });
    if (!res.started && res.defer) { deferred = true; break; }
    // 시작된 firing(성공/실패 무관)과 영구 스킵은 본 것으로 — 자동 재시도 없음(§5.3).
    seen.add(issue.number);
    const keep = [...seen].slice(-ISSUE_SEEN_KEEP);
    setCursor(a, { seen: keep });
  }
  // 미뤄진 이슈가 남았으면 since 를 전진시키지 않는다(since 는 "그 뒤 갱신된 이슈"라 전진하면 영영 안 보인다).
  setCursor(a, deferred ? { polledAt: nowFn() } : { sinceIso: startIso, polledAt: nowFn() });
}

// ── 트리거: 이벤트 버스 ──────────────────────────────────────────────────────
function repoMatches(want, task) {
  if (want == null) return true;
  if (!task || !task.repo) return false;
  const w = normRel(want);
  const p = normRel(task.repo.path);
  return w === p || (task.repo.subdir && w === `${p}/${normRel(task.repo.subdir)}`);
}

function onBusEvent(kind, ev) {
  if (!mem || !ev || !ev.task) return;
  const s = load();
  if (s.paused || serverCapOff()) return;
  const origin = originOf(ev.task);
  for (const a of s.items) {
    if (!live(a)) continue;
    const t = a.trigger;
    const match = (t.type === 'pr.ci_failed' && kind === 'pr.ci_failed')
      || (t.type === 'pr.review_comments' && kind === 'pr.review_comments')
      || (t.type === 'task.event' && kind === `task.${t.event}`);
    if (!match || !repoMatches(t.repo, ev.task)) continue;
    if (origin && origin.automationId === a.id) continue; // 자기 유발 차단(§5.5-2)
    const eventTask = origin && !ev.task.origin ? { ...ev.task, origin } : ev.task;
    fire(a.id, {
      source: kind, eventTask, eventRun: ev.run || null,
      sample: taskRunVars(ev.task, ev.run),
      vars: () => eventVars(a, ev),
    });
  }
}

// ── RPC ──────────────────────────────────────────────────────────────────────
function reqOpId(p) {
  const v = p.opId;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw codedError('BAD_PARAMS', 'opId(UUID)가 필요합니다');
  return v;
}

function createdByOf(p, meta, now) {
  if (meta && meta.createdBy) return { planId: null, ...meta.createdBy, at: now };
  const src = isObj(p.createdBy) ? p.createdBy : {};
  const kind = src.kind === 'dispatch' ? 'dispatch' : 'user'; // 릴레이/앱 경로는 user|dispatch 만(§5.6)
  const devId = inj.deviceId();
  return {
    kind, agent: null, tsession: null, taskId: null,
    planId: kind === 'dispatch' && typeof src.planId === 'string' ? src.planId.slice(0, 80) : null,
    deviceId: Number.isInteger(src.deviceId) ? src.deviceId : (devId == null ? null : devId),
    at: now,
  };
}

function freshState(nextRunAt) {
  return {
    nextRunAt: nextRunAt == null ? null : nextRunAt, lastRunAt: null, runsToday: 0, dayKey: null,
    inflight: 0, cursor: {}, consecutiveFailures: 0, lastResult: null,
  };
}

async function rpcList() {
  const s = load();
  return { items: s.items.map(pickAuto), paused: s.paused, limits: AUTO_LIMITS, counts: countsOf(s.items) };
}

async function rpcGet(p) {
  const a = mustItem(p);
  return { automation: pickAuto(a), log: store.readNdjsonTail(logFile(), { limit: LOG_TAIL_GET, filter: (l) => l && l.autoId === a.id }) };
}

async function rpcValidate(p) {
  const { normalized, nextRunAt, warnings } = await normalizeDraft(p.draft);
  return { ok: true, normalized, nextRunAt, warnings };
}

const createInflight = new Map(); // opId → Promise
async function rpcCreate(p, meta) {
  const opId = reqOpId(p);
  const prev = load().createOps.find((o) => o.opId === opId);
  if (prev) { const a = findItem(prev.id); if (a) return { automation: pickAuto(a), replay: true }; }
  if (createInflight.has(opId)) { const r = await createInflight.get(opId); return { ...r, replay: true }; }
  const pr = (async () => {
    if (load().items.length >= AUTO_LIMITS.maxItems) throw codedError('AUTO_LIMIT', `자동화는 PC 당 ${AUTO_LIMITS.maxItems}개까지입니다`);
    const { normalized, nextRunAt } = await normalizeDraft(p.draft);
    const now = nowFn();
    let id;
    do { id = 'a_' + rand36(10); } while (findItem(id));
    const a = {
      id, ...normalized, paused: false, pausedReason: null,
      createdBy: createdByOf(p, meta, now), state: freshState(nextRunAt), createdAt: now, updatedAt: now,
    };
    mutate((s) => {
      if (s.items.length >= AUTO_LIMITS.maxItems) throw codedError('AUTO_LIMIT', `자동화는 PC 당 ${AUTO_LIMITS.maxItems}개까지입니다`);
      s.items.push(a);
      s.createOps.push({ opId, id, at: now });
      if (s.createOps.length > CREATE_OPS_KEEP) s.createOps.splice(0, s.createOps.length - CREATE_OPS_KEEP);
    });
    audit({ autoId: id, firingId: null, stage: 'created', ok: true, message: a.createdBy.kind });
    emitChanged([id], 'created');
    if (a.createdBy.kind === 'agent') {
      // AI 가 스스로 만든 자동화만 알린다 — 사용자/한 줄 지시는 사람이 방금 눌렀다(§5.8).
      track(pushNotification(a, 'auto_created', {
        title: `자동화 생성 · ${AGENT_LABEL[a.createdBy.agent] || '에이전트'}`, subtitle: triggerLabelOf(a.trigger),
      }));
    }
    log(`[auto] 자동화 생성 ${id} (${a.trigger.type}, ${a.createdBy.kind})`);
    return { automation: pickAuto(a) };
  })();
  createInflight.set(opId, pr);
  try { return await pr; } finally { createInflight.delete(opId); }
}

const PATCH_KEYS = ['name', 'trigger', 'actions', 'guards', 'enabled'];
async function rpcUpdate(p) {
  const a0 = mustItem(p);
  if (!isObj(p.patch)) throw codedError('BAD_PARAMS', 'patch 가 필요합니다');
  for (const k of Object.keys(p.patch)) if (!PATCH_KEYS.includes(k)) throw codedError('BAD_PARAMS', `바꿀 수 없는 필드입니다: ${k}`);
  if ((a0.state.inflight || 0) > 0) throw codedError('AUTO_BUSY', '실행 중이라 바꿀 수 없습니다');
  const draft = {
    name: p.patch.name !== undefined ? p.patch.name : a0.name,
    trigger: p.patch.trigger !== undefined ? p.patch.trigger : a0.trigger,
    actions: p.patch.actions !== undefined ? p.patch.actions : a0.actions,
    guards: p.patch.guards !== undefined ? { ...a0.guards, ...(isObj(p.patch.guards) ? p.patch.guards : {}) } : a0.guards,
    enabled: p.patch.enabled !== undefined ? p.patch.enabled : a0.enabled,
  };
  const { normalized, nextRunAt } = await normalizeDraft(draft);
  const a = mustItem(p); // 검증(비동기) 사이에 지워졌을 수 있다
  if ((a.state.inflight || 0) > 0) throw codedError('AUTO_BUSY', '실행 중이라 바꿀 수 없습니다');
  const triggerChanged = JSON.stringify(normalized.trigger) !== JSON.stringify(a.trigger);
  mutate(() => {
    Object.assign(a, normalized);
    if (triggerChanged) a.state.cursor = {};
    a.state.nextRunAt = a.trigger.type === 'schedule' ? (a.trigger.at != null ? (a.enabled ? nextRunAt : null) : nextRunAt) : null;
    a.updatedAt = nowFn();
  });
  emitChanged([a.id], 'updated');
  return { automation: pickAuto(a) };
}

async function rpcRemove(p) {
  const a = mustItem(p);
  if ((a.state.inflight || 0) > 0) throw codedError('AUTO_BUSY', '실행 중이라 지울 수 없습니다');
  mutate((s) => { s.items = s.items.filter((x) => x.id !== a.id); });
  audit({ autoId: a.id, firingId: null, stage: 'removed', ok: true });
  emitChanged([a.id], 'removed');
  return { ok: true };
}

/** 재개 시 스케줄은 "지금부터" 다시 센다 — 일시정지 동안 놓친 것을 한꺼번에 따라잡지 않는다. */
function reschedule(a, now) {
  if (a.trigger.type !== 'schedule') return;
  if (a.trigger.at != null) { a.state.nextRunAt = a.enabled && a.trigger.at > now ? a.trigger.at : a.state.nextRunAt; return; }
  a.state.nextRunAt = nextScheduleAt(a.trigger, now);
}

async function rpcPause(p) {
  const a = mustItem(p);
  mutate(() => { a.paused = true; a.pausedReason = 'user'; a.updatedAt = nowFn(); });
  emitChanged([a.id], 'paused');
  return { automation: pickAuto(a) };
}

async function rpcResume(p) {
  const a = mustItem(p);
  mutate(() => {
    const now = nowFn();
    a.paused = false; a.pausedReason = null; a.state.consecutiveFailures = 0; a.updatedAt = now;
    reschedule(a, now);
  });
  emitChanged([a.id], 'updated');
  return { automation: pickAuto(a) };
}

async function rpcPauseAll(p) {
  if (typeof p.paused !== 'boolean') throw codedError('BAD_PARAMS', 'paused 는 불리언입니다');
  const ids = [];
  mutate((s) => {
    const was = s.paused;
    s.paused = p.paused;
    if (was && !p.paused) { const now = nowFn(); for (const a of s.items) { reschedule(a, now); ids.push(a.id); } }
  });
  audit({ autoId: null, firingId: null, stage: 'pauseAll', ok: true, message: String(p.paused) });
  emitChanged(ids, p.paused ? 'paused' : 'updated');
  return { paused: load().paused };
}

const runOps = new Map(); // opId → firingId(메모리 — 데몬 재시작 뒤 재전송은 새 firing 이다)
async function rpcRunNow(p) {
  const a = mustItem(p);
  if (p.dryRun === true) return { rendered: await dryRun(a) };
  const opId = reqOpId(p);
  if (runOps.has(opId)) return { accepted: true, firingId: runOps.get(opId), replay: true };
  if (load().paused) throw codedError('AUTO_PAUSED', '모든 자동화가 일시정지돼 있습니다');
  if (serverCapOff()) throw codedError('AUTO_DISABLED', '이 서버에서 자동화가 꺼져 있습니다');
  if (a.paused || !a.enabled) throw codedError('AUTO_PAUSED', '일시정지된 자동화입니다');
  if ((a.state.inflight || 0) >= a.guards.maxConcurrent) throw codedError('AUTO_BUSY', '이미 실행 중입니다');
  const firingId = newFiringId();
  runOps.set(opId, firingId);
  if (runOps.size > RUN_OPS_KEEP) runOps.delete(runOps.keys().next().value);
  const sample = (a.state.cursor || {}).lastVars || null;
  fire(a.id, {
    source: 'runNow', runNow: true, firingId,
    vars: async () => ({ ...baseVars(a), ...(sample || {}) }),
  });
  return { accepted: true, firingId };
}

/** dryRun — 최근 트리거 표본(cursor.lastVars)으로 템플릿만 렌더(실행 없음). */
async function dryRun(a) {
  const sample = (a.state.cursor || {}).lastVars || {};
  const vars = { ...baseVars(a), ...sample, prev: { taskId: '', runId: '' }, auto: { name: a.name } };
  return a.actions.map((act) => {
    if (act.type === 'task.create') {
      const pr = composeTaskPrompt(a, act, vars);
      const t = composeTaskTitle(act, vars);
      return { type: act.type, repo: act.subdir ? `${act.repo}/${act.subdir}` : act.repo, title: t.title, prompt: pr.prompt, missing: [...pr.missing, ...t.missing] };
    }
    if (act.type === 'terminal.prompt') {
      const r = renderText(act.text, vars);
      return { type: act.type, target: act.target, text: r.text, missing: r.missing };
    }
    const t = renderText(act.title, vars, 1200);
    const s = renderText(act.subtitle || '', vars, 1200);
    return { type: act.type, title: t.text.slice(0, NOTIFY_TITLE_MAX), subtitle: s.text.slice(0, NOTIFY_SUBTITLE_MAX), missing: [...t.missing, ...s.missing] };
  });
}

async function rpcLog(p) {
  const limit = Number.isInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, 500) : 100;
  const id = typeof p.id === 'string' && p.id ? p.id : null;
  return { lines: store.readNdjsonTail(logFile(), { limit, filter: id ? (l) => l && l.autoId === id : null }) };
}

const HANDLERS = {
  'auto.list': rpcList,
  'auto.get': rpcGet,
  'auto.validate': rpcValidate,
  'auto.create': rpcCreate,
  'auto.update': rpcUpdate,
  'auto.remove': rpcRemove,
  'auto.pause': rpcPause,
  'auto.resume': rpcResume,
  'auto.pauseAll': rpcPauseAll,
  'auto.runNow': rpcRunNow,
  'auto.log': rpcLog,
};

/**
 * RPC 진입점(로컬 소켓·릴레이·봉인 경로 공통). meta = {via:'relay'|'local'|'cli', createdBy?} —
 *  createdBy 는 cpt-server 소켓 경로(에이전트 게이트 통과 후)만 채운다(§5.7).
 */
async function rpc(method, params, meta) {
  if (!enabled()) throw codedError('AUTO_DISABLED', '이 PC 에서는 자동화를 쓸 수 없습니다');
  const h = HANDLERS[String(method || '')];
  if (!h) throw codedError('BAD_PARAMS', '알 수 없는 자동화 명령입니다: ' + method);
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return h(p, meta || {});
}

// ── 수명 ─────────────────────────────────────────────────────────────────────
let started = false;
let tickTimer = null;
let pollTimer = null;
let firstPollTimer = null;
let unsubs = [];

/** cpt-server.wireAutomationBundle() 에서 configure 직후 1회 — 로드·복구·타이머·버스 구독. */
function start() {
  if (started) return;
  started = true;
  if (!enabled()) { log('[auto] CPT_AUTOMATIONS=0 — 자동화 엔진을 끕니다'); return; }
  const s = load();
  const now = nowFn();
  let dirty = false;
  const interrupted = [];
  for (const a of s.items) {
    if ((a.state.inflight || 0) > 0) {
      // 재시작 중이던 firing — 끝났는지 알 수 없다. 재실행하지 않고 중단으로 기록(§5.5).
      a.state.inflight = 0;
      a.state.lastResult = { firingId: null, ok: false, code: 'OP_INTERRUPTED', message: null, at: now, taskIds: [], steps: [] };
      interrupted.push(a.id);
      dirty = true;
    }
    if (a.trigger.type === 'schedule' && a.state.nextRunAt == null && a.trigger.at == null && a.enabled) {
      a.state.nextRunAt = nextScheduleAt(a.trigger, now);
      dirty = true;
    }
  }
  if (dirty) save();
  for (const id of interrupted) audit({ autoId: id, firingId: null, stage: 'end', ok: false, code: 'OP_INTERRUPTED' });
  const ev = dep('events');
  for (const kind of ['pr.ci_failed', 'pr.review_comments', 'task.review_ready', 'task.merged', 'task.failed']) {
    unsubs.push(ev.on(kind, (payload) => onBusEvent(kind, payload)));
  }
  tickTimer = setInterval(() => { try { tick(); } catch (e) { log(`[auto] 틱 실패: ${e && e.message}`); } }, timings.tickMs);
  if (tickTimer.unref) tickTimer.unref();
  pollTimer = setInterval(() => { poll().catch(() => {}); }, timings.pollMs);
  if (pollTimer.unref) pollTimer.unref();
  firstPollTimer = setTimeout(() => { poll().catch(() => {}); }, timings.firstPollMs);
  if (firstPollTimer.unref) firstPollTimer.unref();
  setImmediate(() => { try { tick(); } catch (_) { /* noop */ } }); // 기동 직후 놓친 스케줄 판정
  log(`[auto] 자동화 엔진 기동 — ${s.items.length}개${s.paused ? ' (전체 일시정지)' : ''}`);
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (firstPollTimer) clearTimeout(firstPollTimer);
  tickTimer = null; pollTimer = null; firstPollTimer = null;
  for (const u of unsubs) { try { u(); } catch (_) { /* noop */ } }
  unsubs = [];
  started = false;
}

/** 테스트 전용 — 진행 중 firing·폴링 전부 끝날 때까지. */
async function _drain() {
  for (let i = 0; i < 100; i++) {
    const pend = [...pending];
    if (!pend.length) return;
    await Promise.allSettled(pend);
  }
}

/** 테스트 전용 — 타이머·구독 해제 + 메모리 초기화(디스크는 그대로). */
async function _reset({ drain = true } = {}) {
  if (drain) await _drain();
  stop();
  mem = null; chain = Promise.resolve(); pending.clear(); createInflight.clear(); runOps.clear();
  ticking = false; polling = null;
}

module.exports = {
  configure, start, stop, rpc, activity, activeReasons,
  pickAuto, normalizeDraft,
  AUTO_LIMITS, AUTO_FIELDS, STATE_FIELDS, ERROR_CODES, TRIGGER_TYPES, ACTION_TYPES, TRIGGER_LABEL,
  _internals: {
    load, save, mutate, tick, poll, fire, onBusEvent, guardOf, storeFile, logFile, enabled, originOf,
    LOOP_NOTE, _reset, _drain,
    get timings() { return timings; },
  },
};
// `handle` = OPTIONAL_CAPS(control.js) 의 능력 판정 export — 킬스위치(CPT_AUTOMATIONS=0)면 undefined(auto.v1 미광고).
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
