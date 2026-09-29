/**
 * conv.js — 채팅 v2 구조화 대화 엔진(설계 정본 docs/chat-v2-design.md).
 *
 * 에이전트 CLI 를 공식 구조화 프로토콜로 직접 구동한다. 이 파일이 맡는 것:
 *   · RPC(conv.*) 디스패치                                   §4
 *   · 프로세스 수명 — thread 당 0|1, 동시 상한, idle 회수, 종료 정리   §5
 *   · 소유권(채팅 ↔ 터미널)과 이어받기                        §6
 *   · 세션 파일 가져오기(과거 표시 전용)                       §4.3
 *   · 알림                                                    §7
 *   · push(conv_event) — 힌트일 뿐이고 정본은 pull(conv.since)  §3
 *
 * 나눠 둔 것: 저장은 conv-store.js, 에이전트별 프로토콜은 어댑터(conv-engine-<id>.js).
 *  이 파일은 어댑터가 내는 중립 이벤트만 안다 — 새 에이전트는 어댑터만 추가하면 된다.
 *
 * 불변식:
 *  · 한 세션의 소유자는 항상 1명이다. 터미널이 쓰고 있는 세션에 프로세스를 띄우지 않는다(기록이 섞인다).
 *  · 승인 요청을 approvals.request 에 이중 등록하지 않는다(한 사실에 통로 하나). 요약·리댁션 함수만 빌린다.
 *  · 어떤 실패 경로에서도 허용(allow)을 만들어 내지 않는다. 응답이 없으면 요청은 열린 채로 남는다.
 */
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');
const store = require('./conv-store');

const CAP = 'conv.v1';
const MAX_LIVE = 4;
const TITLE_MAX = 60;
const PREVIEW_MAX = 120;
const MESSAGE_MAX = 64 * 1024;          // 사용자 입력 상한(ConvMsg 본문 상한과 같다)
const DETAIL_MAX = 1024 * 1024;         // conv.detail 전문 상한
const IMPORT_MAX_BYTES = 16 * 1024 * 1024; // 가져오기 1회 상한 — 넘으면 꼬리만(실측 최대 세션 파일 1.25GB)
const IMPORT_CHUNK = 4 * 1024 * 1024;
const IMPORT_BATCH = 200;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const NOTIFY_BODY_MAX = 200;
const STDERR_NOTE_MAX = 300;
const FILE_MAX = 8 * 1024 * 1024;       // conv.file 상한(§4.5)
const FILE_PATH_MAX = 4096;
const FILE_REFS_MAX = 20000;            // thread 당 기억할 참조 경로 수(오래된 것부터 버림)
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read']);
const SHELL_CMDS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh',
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe']); // agent-watch.js 와 같은 집합
const ERROR_CODES = ['CONV_DISABLED', 'AGENT_UNAVAILABLE', 'AGENT_NOT_LOGGED_IN', 'THREAD_NOT_FOUND', 'THREAD_BUSY',
  'THREAD_BUSY_IN_TERMINAL', 'REQ_NOT_PENDING', 'TOO_MANY_LIVE', 'BAD_REQUEST', 'START_FAILED', 'ADOPT_FAILED',
  'CONTROL_TIMEOUT', 'CONTROL_FAILED'];

const DEFAULT_TIMINGS = {
  idleMs: 10 * 60 * 1000,   // 이만큼 조용하면 프로세스를 내린다(대기 요청이 있으면 내리지 않는다)
  sweepMs: 30 * 1000,
  ackWaitMs: 4000,          // conv.send 가 도달 확인을 기다려 주는 시간(넘으면 'queued' 로 회신 — 확인은 push 로 뒤따른다)
  stopGraceMs: 3000,        // stdin end → 이만큼 → SIGTERM
  viewerMs: 30 * 1000,      // "보는 기기" 판정 창
  hintMs: 100,              // thread 힌트 프레임 코얼레싱
  adoptWaitMs: 5000,        // /exit 뒤 셸 복귀 대기
  adoptPollMs: 250,
  adoptKeyGapMs: 150,
  foreignWriteMs: 90 * 1000, // 세션 파일이 이 안에 바뀌었는데 우리가 쓴 게 아니면 다른 곳(우리 터미널이 아닌 터미널 앱)에서 사용 중으로 본다
};
let timings = { ...DEFAULT_TIMINGS };

// ── 지연 로드(순환·무거운 모듈 회피) ─────────────────────────────────────────
const lazy = (mod) => { try { return require(mod); } catch (_) { return null; } };
const fsLib = () => require('./fs');
const approvals = () => require('./approvals');
const transcript = () => require('./transcript');

// ── 주입 가능한 외부 의존 — 테스트는 back/제어 WS/tmux 없이 이 모듈만으로 전 경로를 돈다 ──
const defaults = {
  adapters: null,   // { id: adapter } — null 이면 내장(claude)
  send: null,       // (frame) → boolean. null = control.sendEvent(cap 게이팅)
  serverCaps: () => { const c = lazy('./control'); return c && typeof c.serverCaps === 'function' ? c.serverCaps() : []; },
  notify: (payload) => require('./cpt-server').backFetch('POST', '/api/notifications', payload),
  deviceId: () => { const c = require('./config').load(); return c && c.deviceId != null ? c.deviceId : null; },
  config: () => require('./config').load() || {},
  env: (adapter) => adapter.buildEnv(),
  terminalOf: null, // (sessionId) → { cwdRel, tid, state } | null. null = 훅 바인딩 + agent-state
  bindOf: (cwdRel, tid, agent) => transcript().lookupBind(cwdRel, tid, agent),
  termName: null,   // (cwdRel, tid) → 터미널 세션 이름. null = pty.termSession
  termState: (cwdRel, tid) => require('./agent-state').rawStateOf(termName(cwdRel, tid)),
  term: null,       // { sendKeys(name, spec), info(name) }. null = term-backend
  now: () => Date.now(),
  log: (m) => console.log(m),
};
let deps = { ...defaults };

const live = new Map();        // threadId → proc
const leaving = new Map();     // threadId → 내려가는 중인 프로세스의 종료 Promise(같은 세션을 겹쳐 띄우지 않게)
const sending = new Map();     // `${threadId}\n${clientId}` → 진행 중인 보내기(같은 clientId 재시도가 겹칠 때)
const creating = new Map();    // clientId → 진행 중인 만들기
const viewers = new Map();     // threadId → 마지막 open/since 시각
const released = new Map();    // threadId → 우리 프로세스가 마지막으로 끝난 시각(실시각 — 세션 파일 mtime 과 비교한다)
const healed = new Set();      // 이번 데몬 수명에 미결 정리를 끝낸 thread
const hintTimers = new Map();  // threadId → 힌트 코얼레싱 타이머
const catalog = new Map();     // agent → { commands, terminalCommands }  마지막 init 이 알려준 명령 목록
const fileRefs = new Map();    // threadId → { upto, abs:Set }  conv.file 권한 색인(이벤트에 등장한 경로의 절대경로)
let pushWs = null;             // 제어 WS 가 아닌 직접 호출자(종단 스크립트)의 sink
let sweeper = null;
let hooks = null;

function configure(opts = {}) {
  const { timings: t, ...rest } = opts;
  deps = { ...deps, ...rest };
  if (t) timings = { ...timings, ...t };
  store.configure({ now: () => deps.now(), pinned: (id) => live.has(id) });
  return module.exports;
}

function log(m) { try { deps.log(`[conv] ${m}`); } catch (_) { /* noop */ } }
function coded(code, message, extra) { return Object.assign(new Error(message), { code }, extra || {}); }
const oneLine = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (ms) => new Date(ms).toISOString();

function adapterOf(id) {
  const all = deps.adapters || { claude: require('./conv-engine-claude') };
  return all[String(id || 'claude')] || null;
}
function adapterIds() { return Object.keys(deps.adapters || { claude: true }); }

// ── 게이팅 ───────────────────────────────────────────────────────────────────
// 킬스위치 — env CPT_CONV=0 또는 daemon.json {conv:{enabled:false}}. 꺼지면 cap 도 광고하지 않는다.
function enabled() {
  if (process.env.CPT_CONV === '0') return false;
  let cfg = {};
  try { cfg = deps.config() || {}; } catch (_) { cfg = {}; }
  return !(cfg.conv && cfg.conv.enabled === false);
}
// 서버가 능력을 선언했는데 conv.v1 이 없다 = 서버 킬스위치. 봉투 RPC 는 서버가 메서드를 못 보므로
//  데몬이 교집합의 다른 한쪽을 지킨다(§4.0). 선언 자체가 없으면(연결 전·구 서버) 판정하지 않는다.
function serverCapOff() {
  let caps = [];
  try { caps = deps.serverCaps() || []; } catch (_) { caps = []; }
  return Array.isArray(caps) && caps.length > 0 && !caps.includes(CAP);
}

// ── push ─────────────────────────────────────────────────────────────────────
// 프레임 필드는 threadId/headSeq/events/delta/thread/control 뿐이다 — back 이 그 밖의 필드를 버린다(§3).
function push(frame) {
  const f = { type: 'conv_event', ...frame };
  if (deps.send) { try { return !!deps.send(f); } catch (_) { return false; } }
  const ctl = lazy('./control');
  if (ctl && typeof ctl.sendEvent === 'function' && ctl.sendEvent(f, CAP)) return true;
  const ws = pushWs;
  if (!ws || ws.readyState !== 1) return false;
  // 제어 WS 는 sendEvent(서버 cap 확인)로만 나간다 — 여기로 새면 처리 코드 없는 서버에 프레임을 던지게 된다.
  if (ctl && typeof ctl.isActiveWs === 'function' && ctl.isActiveWs(ws)) return false;
  try { ws.send(JSON.stringify(f)); return true; } catch (_) { return false; }
}

function publicThread(t) {
  if (!t) return null;
  const { x, ...rest } = t; // x = 내부 장부(clientId·가져오기 오프셋) — 와이어에 싣지 않는다
  return rest;
}

function pushEvents(id, events) {
  if (!events || !events.length) return;
  push({ threadId: id, headSeq: events[events.length - 1].seq, events });
}

function hintThread(id) {
  if (hintTimers.has(id)) return;
  const t = setTimeout(() => {
    hintTimers.delete(id);
    const th = store.getThread(id);
    if (th) push({ threadId: id, thread: publicThread(th) });
  }, timings.hintMs);
  if (t.unref) t.unref();
  hintTimers.set(id, t);
}

/** 이벤트 기록 + push. 돌려주는 값은 seq 가 붙은 이벤트들. */
function record(id, evs) {
  const out = store.appendMany(id, evs);
  pushEvents(id, out);
  return out;
}

function patch(id, fields, { event = false } = {}) {
  const changed = store.patchThread(id, fields);
  if (!changed) return false;
  // working/waiting/idle 전이는 turn·req 이벤트가 이미 말해 준다 — 로그에 또 적지 않고 힌트만 보낸다.
  if (event) record(id, [{ op: 'state', ...fields }]);
  hintThread(id);
  return true;
}

function notice(id, level, code, text) {
  return record(id, [{ op: 'notice', level, code, text: String(text || '').slice(0, 1000) }]);
}

// ── 알림(§7) ─────────────────────────────────────────────────────────────────
function viewed(id) { viewers.set(id, deps.now()); }
function hasViewer(id) {
  const at = viewers.get(id);
  return !!at && deps.now() - at < timings.viewerMs;
}

async function notify(thread, kind, { subtitle, body } = {}) {
  const adapter = adapterOf(thread.agent);
  let host = null;
  try { host = deps.deviceId(); } catch (_) { host = null; }
  const wsName = thread.cwd ? path.basename(thread.cwd) : '';
  const qs = new URLSearchParams();
  if (thread.cwd) qs.set('cwd', thread.cwd);
  if (host != null) qs.set('host', String(host));
  const payload = {
    source: 'agent', kind,
    title: (adapter && adapter.label()) || 'AI 에이전트',
    subtitle,
    body: body ? String(body).slice(0, NOTIFY_BODY_MAX) : undefined,
    cwd: thread.cwd || undefined,
    wsName: wsName || undefined,
    threadId: thread.id,
    deeplink: `codingpt://conv/${thread.id}${qs.toString() ? '?' + qs.toString() : ''}`,
    ...(host != null ? { push: { data: { hostDeviceId: host } } } : {}),
  };
  try { await deps.notify(payload); } catch (e) { log(`알림 실패(${kind}): ${e && e.message}`); }
}
const where = (thread) => (thread.cwd ? `「${path.basename(thread.cwd)}」` : '채팅');

// ── 경로 ─────────────────────────────────────────────────────────────────────
function normCwd(cwd) {
  if (typeof cwd !== 'string') throw coded('BAD_REQUEST', '작업 폴더(cwd)가 필요합니다');
  let abs;
  try { abs = fsLib().safeResolve(cwd); } catch (_) { throw coded('BAD_REQUEST', '허용되지 않은 경로입니다'); }
  let st = null;
  try { st = fs.statSync(abs); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) throw coded('BAD_REQUEST', '작업 폴더를 찾을 수 없습니다');
  return { abs, rel: fsLib().relOf(abs) };
}
function absOf(thread) {
  try { return fsLib().safeResolve(thread.cwd || ''); } catch (_) { return null; }
}
function termName(cwdRel, tid) {
  if (deps.termName) return deps.termName(cwdRel, tid);
  const pty = require('./pty');
  return pty.termSession(pty.sessionForCwd(String(cwdRel || '')).session, tid);
}

// ── 소유권(§6) ───────────────────────────────────────────────────────────────
// 이 세션을 지금 쓰고 있는 터미널 — 훅 바인딩이 그 세션을 가리키고, 그 터미널에 에이전트가 살아 있을 때만.
function terminalOf(sessionId) {
  if (deps.terminalOf) { try { return deps.terminalOf(sessionId) || null; } catch (_) { return null; } }
  try {
    const t = transcript();
    for (const b of t.listClaudeBinds()) {
      const bind = t.lookupBind(b.cwdRel, b.tid, 'claude');
      if (!bind || bind.sessionId !== sessionId) continue;
      const state = deps.termState(b.cwdRel, b.tid);
      if (!state || state === 'ended') continue; // 기록 없음·종료 = 에이전트가 떠 있지 않다
      return { cwdRel: b.cwdRel, tid: b.tid, state };
    }
  } catch (_) { /* 바인딩 파일 없음·tmux 없음 */ }
  return null;
}

// 훅 바인딩은 우리에게 통지되지 않는다 → 누가 볼 때마다 사실을 다시 확인해 owner 를 맞춘다.
function reconcileOwner(thread) {
  if (live.has(thread.id)) return thread;
  const term = terminalOf(thread.id);
  if (term) patch(thread.id, { owner: 'terminal', ownerTid: term.tid }, { event: thread.owner !== 'terminal' });
  else if (thread.owner === 'terminal') patch(thread.id, { owner: 'none', ownerTid: null }, { event: true });
  return store.getThread(thread.id);
}

// ── 미결 정리 — 데몬이 비정상 종료했을 때 남은 열린 턴·대기 요청·미도달 메시지 ──────────
function heal(id) {
  if (healed.has(id) || live.has(id)) return;
  healed.add(id);
  const d = store.dangling(id);
  const evs = [];
  const now = deps.now();
  for (const req of d.reqs) evs.push({ op: 'req', req: { ...req, status: 'canceled', reason: 'process_exit', resolvedAt: now } });
  for (const ev of d.queued) evs.push({ op: 'msg', uuid: ev.uuid, msg: { ...ev.msg, status: 'failed' } });
  if (d.openTurn != null) evs.push({ op: 'turn', phase: 'end', turn: d.openTurn, ok: false, subtype: 'daemon_restart', interrupted: true });
  if (evs.length) store.appendMany(id, evs);
}

// ── 프로세스 수명(§5) ────────────────────────────────────────────────────────
function busy(proc) { return proc.turnOpen || proc.reqs.size > 0; }

function makeRoom() {
  if (live.size < MAX_LIVE) return;
  const idle = [...live.values()].filter((p) => !busy(p) && !p.stopping).sort((a, b) => a.idleSince - b.idleSince);
  if (!idle.length) throw coded('TOO_MANY_LIVE', '동시에 진행할 수 있는 대화 수를 넘었습니다. 진행 중인 작업이 끝난 뒤 다시 시도하세요');
  const victim = idle[0];
  log(`동시 상한 — 가장 오래 쉰 대화를 내립니다(${victim.id})`);
  stopProc(victim, 'evicted').catch(() => {}); // 자리는 바로 빈다(정지는 뒤에서 끝난다)
}

async function ensureProc(thread) {
  const cur = live.get(thread.id);
  if (cur && !cur.exited && !cur.stopping) return cur;
  // 내려가는 중인 프로세스가 완전히 끝난 뒤에 띄운다 — 두 프로세스가 한 세션을 열면 기록이 섞인다.
  const gone = leaving.get(thread.id);
  if (gone) await gone;

  const term = terminalOf(thread.id);
  if (term) {
    patch(thread.id, { owner: 'terminal', ownerTid: term.tid }, { event: thread.owner !== 'terminal' });
    throw coded('THREAD_BUSY_IN_TERMINAL', '이 대화는 터미널에서 사용 중입니다', { tid: term.tid });
  }
  const adapter = adapterOf(thread.agent);
  if (!adapter) throw coded('AGENT_UNAVAILABLE', '지원하지 않는 에이전트입니다');
  const found = await adapter.locate();
  if (!found || !found.bin) throw coded('AGENT_UNAVAILABLE', '이 PC 에서 에이전트 실행 파일을 찾지 못했습니다');
  const abs = absOf(thread);
  if (!abs || !fs.existsSync(abs)) throw coded('START_FAILED', '작업 폴더를 찾을 수 없습니다');

  // 우리 터미널 밖(다른 터미널 앱)에서 같은 세션을 쓰는 중이면 띄우지 않는다 — 두 프로세스가 한 세션을 열면 기록이 섞인다.
  //  훅 바인딩이 없어 누가 쓰는지는 모른다. 세션 파일이 방금 바뀌었고 그게 우리 프로세스가 끝난 뒤라면 남이 쓴 것이다.
  if (timings.foreignWriteMs > 0) {
    let mtime = 0;
    try { const sf = adapter.sessionFile(abs, thread.id); if (sf) mtime = fs.statSync(sf).mtimeMs; } catch (_) { mtime = 0; }
    // 데몬이 재시작하면 released 는 비지만 색인의 lastAt(우리가 마지막으로 기록한 시각)은 남는다.
    const ours = Math.max(released.get(thread.id) || 0, Number(thread.lastAt) || 0);
    if (mtime && Date.now() - mtime < timings.foreignWriteMs && mtime > ours + 2000) {
      throw coded('THREAD_BUSY_IN_TERMINAL', '이 대화는 다른 곳에서 사용 중입니다. 잠시 후 다시 시도하세요');
    }
  }

  makeRoom();
  heal(thread.id);

  const x = thread.x || (thread.x = {});
  const resume = !!x.started || !!adapter.sessionFile(abs, thread.id);
  let env = null;
  try { env = await deps.env(adapter); } catch (_) { env = null; }

  const proc = {
    id: thread.id, adapter, engine: null,
    turn: thread.turn || 0, turnOpen: false, idleSince: deps.now(),
    reqs: new Map(),       // reqId → { rid, req, input, suggestions }
    drafts: new Map(),     // key → { kind, text }  완성 전 블록(conv.open 의 live)
    unacked: [],           // [{ clientId, uuid, text, waiters[] }]  도달 확인을 기다리는 메시지
    exited: false, stopping: null, stopReason: null, resume,
  };
  proc.engine = adapter.start({
    bin: found.bin, cwd: abs, sessionId: thread.id, resume,
    mode: thread.mode || 'default', model: thread.model || null, env,
  }, (ev) => onEngine(proc, ev));
  live.set(thread.id, proc);
  try { await proc.engine.ready; } catch (e) {
    // 'error' 가 exit 이벤트를 만들어 정리한다 — 여기서는 호출자에게 실패만 알린다.
    if (live.get(thread.id) === proc) live.delete(thread.id);
    throw coded('START_FAILED', e && e.code === 'ENOENT' ? '에이전트 실행 파일을 실행할 수 없습니다' : `에이전트를 시작하지 못했습니다: ${(e && e.message) || e}`);
  }
  patch(thread.id, { owner: 'chat', ownerTid: null, external: false }, { event: thread.owner !== 'chat' });
  log(`프로세스 기동 thread=${thread.id} pid=${proc.engine.pid} ${resume ? 'resume' : 'new'}`);
  return proc;
}

function beginTurn(proc) {
  if (proc.turnOpen) return;
  proc.turnOpen = true;
  proc.turn += 1;
  store.patchThread(proc.id, { turn: proc.turn });
  record(proc.id, [{ op: 'turn', phase: 'start', turn: proc.turn }]);
  patch(proc.id, { state: proc.reqs.size ? 'waiting' : 'working' });
}

function cancelReqs(proc, reason) {
  if (!proc.reqs.size) return [];
  const now = deps.now();
  const evs = [];
  for (const slot of proc.reqs.values()) {
    slot.req = { ...slot.req, status: 'canceled', reason, resolvedAt: now };
    evs.push({ op: 'req', req: slot.req });
  }
  proc.reqs.clear();
  return evs;
}

function failUnacked(proc) {
  const evs = [];
  for (const u of proc.unacked) {
    const cur = store.latestOf(proc.id, 'msg', 'u:' + u.clientId);
    if (cur && cur.msg) evs.push({ op: 'msg', msg: { ...cur.msg, status: 'failed' } });
    for (const w of u.waiters) w(false);
  }
  proc.unacked = [];
  return evs;
}

/** 프로세스를 내린다(대화는 남는다). 진행 중이던 턴은 중단으로 기록한다. */
function stopProc(proc, reason) {
  if (proc.exited) return Promise.resolve();
  if (proc.stopping) return proc.stopping;
  proc.stopReason = reason || 'stopped';
  if (live.get(proc.id) === proc) live.delete(proc.id);
  const done = proc.engine.stop({ graceMs: timings.stopGraceMs }).catch(() => {})
    .then(() => { if (leaving.get(proc.id) === done) leaving.delete(proc.id); });
  proc.stopping = done;
  leaving.set(proc.id, done);
  return done;
}

function onExit(proc, ev) {
  if (proc.exited) return;
  proc.exited = true;
  released.set(proc.id, Date.now());
  if (live.get(proc.id) === proc) live.delete(proc.id);
  const thread = store.getThread(proc.id);
  if (!thread) return; // 그 사이 삭제된 대화
  const wanted = !!proc.stopReason;          // 우리가 내렸다(stop·idle·축출·종료·이어받기)
  const quiet = wanted || (!proc.turnOpen && !proc.reqs.size && !proc.unacked.length && ev.code === 0 && !ev.spawnError);
  const evs = [...cancelReqs(proc, 'process_exit'), ...failUnacked(proc)];
  if (proc.turnOpen) {
    proc.turnOpen = false;
    evs.push({ op: 'turn', phase: 'end', turn: proc.turn, ok: false, subtype: wanted ? proc.stopReason : 'process_exit', interrupted: true });
  }
  proc.drafts.clear();
  if (!quiet) {
    const tail = oneLine(approvals().redactValues(ev.stderr || ''), STDERR_NOTE_MAX);
    const why = ev.spawnError ? '에이전트를 실행하지 못했습니다' : `에이전트가 예기치 않게 종료됐습니다(code=${ev.code == null ? ev.signal || '?' : ev.code})`;
    evs.push({ op: 'notice', level: 'error', code: ev.spawnError ? 'START_FAILED' : 'PROCESS_EXIT', text: tail ? `${why} — ${tail}` : why });
    // 이어받을 세션이 없다는 뜻이면 다음 기동은 새 세션으로(같은 id) — 영영 같은 실패를 되풀이하지 않게.
    if (/no conversation found/i.test(ev.stderr || '') && thread.x) thread.x.started = false;
  }
  if (evs.length) record(proc.id, evs);
  patch(proc.id, { state: quiet ? 'stopped' : 'error', pending: 0 }, { event: true });
  log(`프로세스 종료 thread=${proc.id} code=${ev.code} signal=${ev.signal || ''} ${wanted ? `(${proc.stopReason})` : ''}`);
  if (!quiet) notify(thread, 'conv_error', { subtitle: `${where(thread)}에서 오류`, body: '에이전트가 종료됐습니다' });
}

// ── 어댑터 이벤트 → 로그 ─────────────────────────────────────────────────────
function onEngine(proc, ev) {
  const id = proc.id;
  const thread = store.getThread(id);
  if (!thread && ev.type !== 'exit') return;
  switch (ev.type) {
    case 'init': {
      catalog.set(thread.agent, { commands: ev.commands || [], terminalCommands: ev.terminalCommands || [] });
      if (!thread.x || !thread.x.started) { thread.x = { ...(thread.x || {}), started: true }; store.putThread(thread); }
      const fields = {};
      if (ev.mode && ev.mode !== thread.mode) fields.mode = ev.mode;
      if (ev.model && ev.model !== thread.model) fields.model = ev.model;
      if (Object.keys(fields).length) patch(id, fields, { event: true });
      // init 은 턴마다 온다 — 대기열의 메시지로 시작된 턴(우리가 연 적 없는 턴)도 여기서 열린다.
      //  보낸 것이 없는데 온 init 으로는 열지 않는다(닫아 줄 result 가 온다는 보장이 없다) — 그런 턴은 첫 출력이 연다.
      if (proc.unacked.length) beginTurn(proc);
      return;
    }
    case 'ack': return onAck(proc, ev);
    case 'delta': {
      beginTurn(proc); // 에이전트가 스스로 시작한 턴(백그라운드 작업 완료 등)
      let d = proc.drafts.get(ev.key);
      if (!d) { d = { kind: ev.kind, text: '' }; proc.drafts.set(ev.key, d); }
      // 어댑터의 off 는 자기 누적 길이다. 우리 장부와 어긋나면(없어야 한다) 우리 것을 정본으로 다시 매긴다.
      const off = d.text.length;
      d.text += ev.text;
      push({ threadId: id, delta: { key: ev.key, kind: ev.kind, off, text: ev.text } });
      return;
    }
    case 'msgs': {
      if (ev.msgs.some((m) => m.role === 'assistant')) beginTurn(proc);
      const evs = [];
      let preview = null;
      for (const m of ev.msgs) {
        proc.drafts.delete(m.key);
        evs.push({ op: 'msg', ...(ev.uuid ? { uuid: ev.uuid } : {}), msg: { ...m, turn: proc.turn } });
        if (m.role === 'assistant' && m.kind === 'text' && !m.hidden && !m.parent && m.text) preview = oneLine(m.text, PREVIEW_MAX);
      }
      record(id, evs);
      if (preview) patch(id, { preview });
      return;
    }
    case 'request': return onRequest(proc, thread, ev);
    case 'request_gone': {
      for (const [reqId, slot] of proc.reqs) {
        if (slot.rid !== ev.rid) continue;
        proc.reqs.delete(reqId);
        record(id, [{ op: 'req', req: { ...slot.req, status: 'canceled', reason: 'turn_end', resolvedAt: deps.now() } }]);
      }
      patch(id, { pending: proc.reqs.size, state: proc.reqs.size ? 'waiting' : (proc.turnOpen ? 'working' : 'idle') });
      return;
    }
    case 'mode':
      if (ev.mode && ev.mode !== thread.mode) patch(id, { mode: ev.mode }, { event: true });
      return;
    case 'usage':
      // 턴 중간의 컨텍스트 갱신은 로그에 적지 않는다(응답마다 온다) — 힌트로만 알리고, 턴 끝(result)에 한 번 기록한다.
      patch(id, { usage: usageOf(thread.usage, ev) });
      return;
    case 'rate': {
      // 경고(한도 근접)는 안내하지 않는다 — thread.usage.rateLimit 에만 싣고(클라가 원하면 표시) 힌트로 알린다.
      //  실제 차단일 때만 notice. 같은 차단(같은 창·같은 해제 시각)이 이어서 와도 한 번만 남긴다.
      const prev = thread.usage && thread.usage.rateLimit;
      const rateLimit = { status: ev.status, kind: ev.kind || null, resetsAt: ev.resetsAt != null ? ev.resetsAt : null, utilization: ev.utilization != null ? ev.utilization : null };
      const again = prev && prev.blocked && prev.kind === rateLimit.kind && prev.resetsAt === rateLimit.resetsAt;
      patch(id, { usage: usageOf(thread.usage, { rateLimit: { ...rateLimit, blocked: !!ev.blocked } }) });
      if (ev.blocked && !again) notice(id, 'warn', 'RATE_LIMITED', '사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시도하세요');
      return;
    }
    case 'result': return onResult(proc, thread, ev);
    case 'exit': return onExit(proc, ev);
    default:
  }
}

function onAck(proc, ev) {
  // 우리가 실어 보낸 uuid 가 그대로 돌아오면 그것으로, 아니면 보낸 순서(같은 본문 우선)로 짝짓는다.
  let i = ev.uuid ? proc.unacked.findIndex((u) => u.uuid === ev.uuid) : -1;
  if (process.env.CPT_CONV_DEBUG) log(`도달 확인 thread=${proc.id} uuid 짝=${i >= 0}`);
  if (i < 0) i = proc.unacked.findIndex((u) => u.text === ev.text);
  if (i < 0 && proc.unacked.length) i = 0;
  if (i < 0) {
    // 우리가 보낸 적 없는 메시지(다른 경로로 들어온 입력) — 있는 그대로 남긴다.
    if (ev.uuid && store.hasUuid(proc.id, ev.uuid)) return;
    beginTurn(proc);
    record(proc.id, [{ op: 'msg', uuid: ev.uuid || undefined, msg: {
      key: 'u:' + (ev.uuid || crypto.randomUUID()), ts: ev.ts || iso(deps.now()), role: 'user', kind: 'text',
      text: String(ev.text || '').slice(0, MESSAGE_MAX), truncated: false, hidden: false, status: 'sent', turn: proc.turn,
    } }]);
    return;
  }
  const [u] = proc.unacked.splice(i, 1);
  beginTurn(proc);
  const cur = store.latestOf(proc.id, 'msg', 'u:' + u.clientId);
  if (cur && cur.msg) {
    record(proc.id, [{ op: 'msg', uuid: ev.uuid || u.uuid, msg: { ...cur.msg, status: 'sent', turn: proc.turn } }]);
  }
  for (const w of u.waiters) w(true);
}

// 3번째 선택지("허용하고 다음부터 묻지 않기")의 라벨 — 에이전트가 제안을 줬을 때만 만든다(§2.4).
function alwaysLabelOf(suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) return undefined;
  const rule = approvals().alwaysRuleOf(suggestions);
  if (rule && rule.label) return rule.label;
  const mode = suggestions.find((s) => s && s.type === 'setMode' && s.mode);
  if (mode) return mode.mode === 'acceptEdits' ? '이번 대화에서 파일 수정 자동 허용' : `이번 대화에서 ${mode.mode} 모드로 전환`;
  const dirs = suggestions.find((s) => s && s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length);
  if (dirs) return `폴더 접근 허용: ${oneLine(dirs.directories.map((d) => path.basename(String(d))).join(', '), 120)}`;
  return '다음부터 묻지 않기';
}

function onRequest(proc, thread, ev) {
  beginTurn(proc);
  const A = approvals();
  const questions = ev.tool === 'AskUserQuestion' || ev.interactive ? A.questionsOf(ev.input) : null;
  const kind = questions ? 'question' : (ev.tool === 'ExitPlanMode' ? 'plan' : 'permission');
  const relPath = A.relPathOf(ev.input, thread.cwd);
  const req = {
    id: 'req_' + crypto.randomUUID(),
    kind, tool: ev.tool, toolUseId: ev.toolUseId || null,
    // 파일 도구의 요약은 워크스페이스 상대 경로로 — 이 값은 알림 본문으로도 나간다(홈 절대경로를 흘리지 않는다).
    summary: (relPath && FILE_TOOLS.has(ev.tool) ? relPath : A.summaryOf(ev.tool, ev.input)) || oneLine(ev.description, 200),
    detail: A.detailOf(ev.tool, ev.input),
    relPath,
    diff: A.diffOf(ev.tool, ev.input),
    inputPreview: A.inputPreviewOf(ev.input),
    ...(questions ? { questions } : {}),
    ...(kind === 'plan' ? { plan: String(A.redactValues((ev.input && ev.input.plan) || '')).slice(0, MESSAGE_MAX) } : {}),
    ...(kind === 'permission' && alwaysLabelOf(ev.suggestions) ? { alwaysLabel: alwaysLabelOf(ev.suggestions) } : {}),
    status: 'pending',
    requestedAt: deps.now(),
    turn: proc.turn,
  };
  for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k];
  proc.reqs.set(req.id, { rid: ev.rid, req, input: ev.input, suggestions: ev.suggestions || [] });
  record(proc.id, [{ op: 'req', req }]);
  patch(proc.id, { state: 'waiting', pending: proc.reqs.size });
  notify(thread, 'conv_request', {
    subtitle: `${where(thread)}에서 ${kind === 'question' ? '답변 대기' : (kind === 'plan' ? '계획 확인 대기' : '승인 대기')}`,
    body: req.relPath || req.summary,
  });
}

function onResult(proc, thread, ev) {
  const id = proc.id;
  const evs = cancelReqs(proc, ev.interrupted ? 'interrupted' : 'turn_end');
  proc.drafts.clear(); // 완성되지 못한 초안은 에이전트의 기록에도 없다 — 클라는 turn end 에서 남은 초안을 버린다
  beginTurn(proc); // 시작을 못 본 턴(방어) — 끝만 남기면 클라의 턴 짝이 어긋난다
  proc.turnOpen = false;
  proc.idleSince = deps.now();
  const failed = !ev.ok && !ev.interrupted;
  evs.push({
    op: 'turn', phase: 'end', turn: proc.turn, ok: !!ev.ok, subtype: ev.subtype || undefined,
    interrupted: !!ev.interrupted,
    ...(ev.durationMs != null ? { durationMs: ev.durationMs } : {}),
    ...(ev.usage ? { usage: ev.usage } : {}),
    ...(ev.costUsd != null ? { costUsd: ev.costUsd } : {}),
  });
  if (failed) {
    evs.push(ev.authFailed
      ? { op: 'notice', level: 'error', code: 'AGENT_NOT_LOGGED_IN', text: '에이전트에 로그인돼 있지 않습니다. PC 터미널에서 로그인한 뒤 다시 시도하세요' }
      : { op: 'notice', level: 'error', code: 'TURN_FAILED', text: oneLine(approvals().redactValues(ev.text || ''), 300) || '작업이 실패로 끝났습니다' });
  }
  record(id, evs);
  const usage = (ev.contextTokens || ev.contextMax || ev.costUsd != null || ev.model) ? usageOf(thread.usage, ev) : undefined;
  const usageChanged = !!usage && JSON.stringify(usage) !== JSON.stringify(thread.usage || null);
  patch(id, { state: failed ? 'error' : 'idle', pending: 0, ...(usage ? { usage } : {}) }, { event: failed || usageChanged });
  if (failed) notify(thread, 'conv_error', { subtitle: `${where(thread)}에서 오류`, body: ev.authFailed ? '로그인이 필요합니다' : '작업이 실패로 끝났습니다' });
  else if (!ev.interrupted && !hasViewer(id)) {
    const cur = store.getThread(id);
    notify(thread, 'conv_done', { subtitle: `${where(thread)}에서 완료`, body: (cur && cur.preview) || undefined });
  }
}

/**
 * thread.usage(§4.5) = { contextTokens, contextMax, contextPct, costUsd, model }. 어댑터가 준 값만 덮고 나머지는 앞 값을 잇는다.
 *  contextMax 는 에이전트가 알려 준 값만 쓴다(result.modelUsage.contextWindow) — 모델 id 로 추정하지 않는다.
 *  모델이 바뀌면 앞 모델의 창 크기는 버린다(다음 result 가 새 값을 줄 때까지 null → contextPct 도 null).
 */
function usageOf(prev, u) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const model = (u && u.model) || p.model || null;
  const sameModel = !(u && u.model) || !p.model || u.model === p.model;
  const contextTokens = num(u && u.contextTokens) != null ? u.contextTokens : num(p.contextTokens);
  const contextMax = num(u && u.contextMax) || (sameModel ? num(p.contextMax) : null) || null;
  const costUsd = num(u && u.costUsd) != null ? u.costUsd : num(p.costUsd);
  const contextPct = contextTokens != null && contextMax ? Math.max(0, Math.min(100, Math.round((contextTokens * 100) / contextMax))) : null;
  const rateLimit = u && u.rateLimit !== undefined ? u.rateLimit : (p.rateLimit || null);
  return { contextTokens, contextMax, contextPct, costUsd, model, ...(rateLimit ? { rateLimit } : {}) };
}

// ── 가져오기(§4.3) — 프로세스가 떠 있지 않을 때만 ─────────────────────────────
async function importSession(thread) {
  if (live.has(thread.id)) return 0;
  const adapter = adapterOf(thread.agent);
  const abs = absOf(thread);
  if (!adapter || !abs) return 0;
  const file = adapter.sessionFile(abs, thread.id);
  if (!file) return 0;
  let st = null;
  try { st = await fsp.stat(file); } catch (_) { return 0; }
  const x = thread.x || (thread.x = {});
  if (x.fileSize === st.size && x.fileMtime === st.mtimeMs) return 0;

  let from = Number.isInteger(x.fileOff) && x.fileOff <= st.size ? x.fileOff : 0;
  let skipFirst = false;
  const pre = [];
  if (st.size - from > IMPORT_MAX_BYTES) {
    from = st.size - IMPORT_MAX_BYTES; // 라인 중간일 수 있다 → 첫 줄은 버린다
    skipFirst = true;
    pre.push({ op: 'notice', level: 'info', code: 'IMPORT_TRUNCATED', text: '대화가 길어 최근 부분만 가져왔습니다' });
  }
  const counters = new Map();
  const ctx = {
    textCap: adapter.TEXT_CAP,
    blockIdx(mid) { const n = counters.get(mid) || 0; counters.set(mid, n + 1); return n; },
  };
  const t = transcript();
  let added = 0;
  let batch = pre;
  let title = null;
  let preview = null;
  // 가져온 과거는 push 하지 않는다(수천 건일 수 있다) — 힌트의 headSeq 를 본 클라가 conv.since 로 당겨 간다.
  const flush = () => { if (batch.length) { store.appendMany(thread.id, batch); batch = []; } };
  for (;;) {
    if (live.has(thread.id)) break; // 그 사이 프로세스가 떴다 — 이제부터는 stdout 이 정본이다
    const r = await t.readDelta(file, from, { maxBytes: IMPORT_CHUNK });
    for (const ln of r.lines) {
      if (skipFirst) { skipFirst = false; continue; }
      if (ln.overflow || !ln.bytes) continue;
      let o = null;
      try { o = JSON.parse(ln.buf.toString('utf8')); } catch (_) { continue; }
      if (!o || typeof o !== 'object') continue;
      const known = !!o.uuid && store.hasUuid(thread.id, o.uuid);
      const msgs = adapter.importLine(o, ctx); // 아는 줄도 돌린다(블록 인덱스를 이어 세야 한다)
      if (known || !o.uuid) continue;
      const ts = Date.parse(o.timestamp || '') || deps.now();
      for (const m of msgs) {
        let key = m.key;
        // 경계에 걸린 메시지가 기존 key 와 겹치면 다른 메시지를 덮어쓰게 된다 — 겹치면 uuid 로 가른다.
        const hit = store.latestOf(thread.id, 'msg', key);
        if (hit && hit.uuid !== o.uuid) key = `${key}~${String(o.uuid).slice(0, 8)}`;
        const msg = { ...m, key, ...(m.role === 'user' && m.kind === 'text' ? { status: 'sent' } : {}) };
        batch.push({ op: 'msg', ts, uuid: o.uuid, msg });
        added++;
        if (!title && msg.role === 'user' && (msg.kind === 'text' || msg.kind === 'slash') && !msg.hidden && msg.text) title = oneLine(msg.text, TITLE_MAX);
        if (msg.role === 'assistant' && msg.kind === 'text' && !msg.hidden && !msg.parent && msg.text) preview = oneLine(msg.text, PREVIEW_MAX);
      }
      if (batch.length >= IMPORT_BATCH) flush();
    }
    from = r.nextOffset;
    if (!r.more) break;
  }
  flush();
  x.fileOff = from; x.fileSize = st.size; x.fileMtime = st.mtimeMs;
  const fields = { external: false, lastAt: Math.max(thread.lastAt || 0, Math.floor(st.mtimeMs)) };
  if (title && !thread.titleSet && !thread.title) fields.title = title;
  if (preview) fields.preview = preview;
  store.patchThread(thread.id, fields);
  store.putThread(store.getThread(thread.id)); // x(오프셋) 저장
  if (added) { log(`가져오기 thread=${thread.id} +${added}`); hintThread(thread.id); }
  return added;
}

function newThread({ id, agent, cwd, mode, model, title, owner, external }) {
  const now = deps.now();
  return {
    id, agent, cwd,
    title: title || '', titleSet: false,
    createdAt: now, lastAt: now,
    state: 'stopped', owner: owner || 'none', ownerTid: null,
    mode: mode || 'default', model: model || null,
    headSeq: 0, pending: 0, preview: '', usage: null,
    external: !!external, turn: 0,
    x: {},
  };
}

// 우리 색인에 없는 세션(터미널에서 만든 대화)을 thread 로 들인다 — 세션 파일이 실제로 있어야 한다.
async function adoptExternal(threadId, cwd, agent) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(threadId || ''))) throw coded('THREAD_NOT_FOUND', '대화를 찾을 수 없습니다');
  const adapter = adapterOf(agent || 'claude');
  if (!adapter) throw coded('AGENT_UNAVAILABLE', '지원하지 않는 에이전트입니다');
  let rel = null; let abs = null;
  if (typeof cwd === 'string') { const n = normCwd(cwd); rel = n.rel; abs = n.abs; } else {
    // cwd 를 안 준 호출 — 훅 바인딩이 그 세션을 아는 터미널의 폴더를 쓴다.
    try {
      const t = transcript();
      for (const b of t.listClaudeBinds()) {
        const bind = t.lookupBind(b.cwdRel, b.tid, 'claude');
        if (bind && bind.sessionId === threadId) { const n = normCwd(b.cwdRel); rel = n.rel; abs = n.abs; break; }
      }
    } catch (_) { /* 아래에서 THREAD_NOT_FOUND */ }
  }
  if (!abs || !adapter.sessionFile(abs, threadId)) throw coded('THREAD_NOT_FOUND', '대화를 찾을 수 없습니다');
  const thread = newThread({ id: threadId, agent: adapter.id, cwd: rel, external: true });
  thread.x.started = true; // 세션 파일이 있다 = 다음 기동은 이어받기
  store.putThread(thread);
  return thread;
}

function need(threadId) {
  const t = store.getThread(String(threadId || ''));
  if (!t) throw coded('THREAD_NOT_FOUND', '대화를 찾을 수 없습니다');
  return t;
}

function liveView(id) {
  const proc = live.get(id);
  if (!proc) return [];
  return [...proc.drafts.entries()].map(([key, d]) => ({ key, kind: d.kind, text: d.text }));
}
function pendingView(id) {
  const proc = live.get(id);
  return proc ? [...proc.reqs.values()].map((s) => s.req) : [];
}

// ── 보내기(§4.1) ─────────────────────────────────────────────────────────────
function composeText(text, attachments) {
  let out = String(text == null ? '' : text);
  const files = [];
  for (const a of Array.isArray(attachments) ? attachments.slice(0, 12) : []) {
    const p = a && typeof a === 'object' ? a.path : a;
    if (typeof p !== 'string' || !p) continue;
    let abs = null;
    try { abs = fsLib().safeResolve(p); } catch (_) { abs = null; } // jail 밖 경로는 인용하지 않는다
    if (!abs) continue;
    files.push({ path: abs, name: (a && a.name) || path.basename(abs), ...(a && a.mediaType ? { mediaType: String(a.mediaType) } : {}) });
  }
  if (files.length) out = `${out}${out ? '\n\n' : ''}${files.map((f) => `[첨부] ${f.path}`).join('\n')}`;
  return { text: out, files };
}

function terminalOnly(thread, text) {
  const m = /^\/([A-Za-z0-9_:-]+)/.exec(String(text || '').trim());
  if (!m) return null;
  const c = catalog.get(thread.agent);
  return c && c.terminalCommands.includes(m[1]) ? m[1] : null;
}

function sendInto(thread, args) {
  const k = `${thread.id}\n${args.clientId}`;
  const cur = sending.get(k);
  if (cur) return cur;
  const p = sendOnce(thread, args).finally(() => { if (sending.get(k) === p) sending.delete(k); });
  sending.set(k, p);
  return p;
}

async function sendOnce(thread, { clientId, text, attachments }) {
  const id = thread.id;
  const key = 'u:' + clientId;
  const prior = store.latestOf(id, 'msg', key);
  // 멱등 — 같은 clientId 의 재시도는 중복 전송이 되지 않는다. 실패한 메시지의 재시도만 다시 보낸다.
  if (prior && prior.msg && prior.msg.status !== 'failed') {
    return { ok: true, status: prior.msg.status === 'sent' ? 'sent' : 'queued', seq: prior.first || prior.seq };
  }
  const { text: full, files } = composeText(text, attachments);
  if (!full.trim()) throw coded('BAD_REQUEST', '보낼 내용이 없습니다');
  if (full.length > MESSAGE_MAX) throw coded('BAD_REQUEST', '메시지가 너무 깁니다');
  const base = {
    key, ts: iso(deps.now()), role: 'user', kind: 'text', text: full, truncated: false, hidden: false,
    clientId, ...(files.length ? { attachments: files.map((f, i) => ({ idx: i, name: f.name, path: f.path, mediaType: f.mediaType })) } : {}),
  };

  const cmd = terminalOnly(thread, full);
  if (cmd) {
    const out = record(id, [
      { op: 'msg', msg: { ...base, status: 'failed' } },
      { op: 'notice', level: 'info', code: 'TERMINAL_ONLY_COMMAND', text: `/${cmd} 는 터미널에서만 쓸 수 있는 명령입니다` },
    ]);
    return { ok: false, status: 'failed', seq: out[0].seq, code: 'TERMINAL_ONLY_COMMAND' };
  }

  let proc = null;
  try { proc = await ensureProc(thread); } catch (e) {
    // 기동 실패만 기록한다. 선결 조건 거절(터미널 사용 중·상한 초과)은 대화에 남길 사실이 아니다.
    if (e && e.code === 'START_FAILED') record(id, [{ op: 'msg', msg: { ...base, status: 'failed' } }]);
    throw e;
  }
  const wasIdle = !proc.turnOpen;
  if (wasIdle) beginTurn(proc);
  const fresh = store.getThread(id);
  if (fresh && !fresh.titleSet && !fresh.title) patch(id, { title: oneLine(text || full, TITLE_MAX) }, { event: true });
  const [ev] = record(id, [{ op: 'msg', msg: { ...base, status: 'queued', turn: proc.turn } }]);

  const slot = { clientId, uuid: crypto.randomUUID(), text: full, waiters: [] };
  proc.unacked.push(slot);
  if (!proc.engine.send({ text: full, uuid: slot.uuid })) {
    proc.unacked = proc.unacked.filter((u) => u !== slot);
    record(id, [{ op: 'msg', msg: { ...base, status: 'failed', turn: proc.turn } }]);
    throw coded('START_FAILED', '에이전트에 메시지를 전달하지 못했습니다');
  }
  // 턴 진행 중이면 에이전트가 다음 도구 경계에서 읽는다 — 기다리지 않는다.
  if (!wasIdle) return { ok: true, status: 'queued', seq: ev.seq };
  const acked = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timings.ackWaitMs);
    if (timer.unref) timer.unref();
    slot.waiters.push((ok) => { clearTimeout(timer); resolve(ok); });
  });
  if (acked === false) throw coded('START_FAILED', '에이전트가 시작 직후 종료됐습니다');
  return { ok: true, status: acked ? 'sent' : 'queued', seq: ev.seq };
}

// ── 응답(§4.2) ───────────────────────────────────────────────────────────────
// answers — { "<질문 문구>": "<라벨>" | ["<라벨>",…] | "<자유 텍스트>" } 맵(§4.4), 또는 v1 카드와 같은 배열
//  ([{questionIndex, labels|label|text}]). 에이전트에는 질문마다 문자열 하나로 넘긴다 — 다중 선택을 배열로 받는지는
//  실측하지 못했다. 단일 선택의 실측 형태(문자열)에 맞춰 라벨을 ', ' 로 잇는다.
function answersMap(answers, input) {
  const qs = Array.isArray(input && input.questions) ? input.questions : [];
  const out = {};
  const put = (q, v) => { const s = String(v == null ? '' : v).slice(0, 4000); if (q && s) out[String(q)] = s; };
  if (Array.isArray(answers)) {
    answers.slice(0, 8).forEach((a, i) => {
      if (a == null) return;
      const qi = a && Number.isInteger(a.questionIndex) ? a.questionIndex : i;
      const q = (a && typeof a === 'object' && a.question) || (qs[qi] && qs[qi].question);
      if (typeof a === 'string') return put(q, a);
      const labels = [].concat(Array.isArray(a.labels) ? a.labels : [], a.label != null ? [a.label] : []).map(String).filter(Boolean);
      put(q, labels.length ? labels.join(', ') : a.text);
    });
  } else if (answers && typeof answers === 'object') {
    for (const [q, v] of Object.entries(answers).slice(0, 8)) put(q, Array.isArray(v) ? v.join(', ') : v);
  }
  return out;
}

async function respond(p) {
  const thread = need(p.threadId);
  const proc = live.get(thread.id);
  const slot = proc && proc.reqs.get(String(p.reqId || ''));
  if (!slot) throw coded('REQ_NOT_PENDING', '이미 닫힌 요청입니다');
  const decision = String(p.decision || '');
  const note = typeof p.message === 'string' ? p.message.trim().slice(0, 4000) : '';
  let reply = null; let status = null;
  if (decision === 'deny') {
    reply = { behavior: 'deny', message: note || '사용자가 거부했습니다' };
    status = 'denied';
  } else if (decision === 'allow' || decision === 'answer') {
    if (slot.req.kind === 'question') {
      const answers = answersMap(p.answers, slot.input);
      if (!Object.keys(answers).length) throw coded('BAD_REQUEST', '답변이 필요합니다');
      reply = { behavior: 'allow', updatedInput: { ...slot.input, answers } };
      status = 'answered';
    } else {
      reply = { behavior: 'allow', updatedInput: slot.input };
      // 에이전트가 준 제안만 되돌린다 — 클라가 보낸 규칙은 쓰지 않는다(원격에서 권한을 넓히는 통로가 된다).
      if (p.always && slot.suggestions.length) reply.updatedPermissions = slot.suggestions;
      status = decision === 'answer' ? 'answered' : 'allowed';
    }
  } else throw coded('BAD_REQUEST', '알 수 없는 결정입니다');

  proc.reqs.delete(slot.req.id); // 먼저 지운다 = 두 기기가 동시에 눌러도 한 번만 소비된다
  if (!proc.engine.respond(slot.rid, reply)) {
    proc.reqs.set(slot.req.id, slot);
    throw coded('REQ_NOT_PENDING', '에이전트가 이미 종료됐습니다');
  }
  slot.req = {
    ...slot.req, status, resolvedAt: deps.now(),
    ...(p.by ? { by: oneLine(p.by, 60) } : {}),
    ...(status === 'allowed' && reply.updatedPermissions ? { always: true } : {}),
  };
  record(thread.id, [{ op: 'req', req: slot.req }]);
  patch(thread.id, { pending: proc.reqs.size, state: proc.reqs.size ? 'waiting' : 'working' });
  // 허용하고 추가 지시 — 허용 응답 뒤에 사용자 메시지로 이어 쓴다.
  if (status !== 'denied' && note) {
    try { await sendInto(thread, { clientId: 'r-' + slot.req.id, text: note }); } catch (e) { log(`추가 지시 전달 실패: ${e && e.message}`); }
  }
  return { ok: true };
}

// ── 이어받기(§6) ─────────────────────────────────────────────────────────────
async function toTerminal(p) {
  const thread = need(p.threadId);
  const proc = live.get(thread.id);
  if (proc && busy(proc)) throw coded('THREAD_BUSY', '작업이 끝난 뒤 넘길 수 있습니다');
  if (proc) await stopProc(proc, 'handoff');
  const adapter = adapterOf(thread.agent);
  if (!adapter) throw coded('AGENT_UNAVAILABLE', '지원하지 않는 에이전트입니다');
  patch(thread.id, { owner: 'none', ownerTid: null }, { event: true });
  // command 는 표시용이다 — 클라는 args 만 기존 에이전트 실행 경로에 넘긴다(실행 파일은 카탈로그가 정한다).
  return { ok: true, cwd: thread.cwd, agent: adapter.id, command: adapter.resumeCommand(thread.id), args: adapter.resumeArgs(thread.id) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adopt(p) {
  const { rel } = normCwd(p.cwd);
  const tid = Number.isInteger(p.tid) ? p.tid : (typeof p.tid === 'string' && /^\d+$/.test(p.tid) ? parseInt(p.tid, 10) : null);
  if (tid == null) throw coded('BAD_REQUEST', '대상 터미널(tid)이 필요합니다');
  const agent = p.agent || 'claude';
  let bind = null;
  try { bind = deps.bindOf(rel, tid, agent); } catch (_) { bind = null; }
  if (!bind || !bind.sessionId) throw coded('THREAD_NOT_FOUND', '이 터미널에서 진행한 대화를 찾을 수 없습니다');
  let state = null;
  try { state = deps.termState(rel, tid); } catch (_) { state = null; }
  if (state === 'working' || state === 'permission') throw coded('THREAD_BUSY_IN_TERMINAL', '터미널에서 작업 중입니다. 끝난 뒤 가져올 수 있습니다');

  const term = deps.term || require('./term-backend');
  const name = termName(rel, tid);
  const shellNow = async () => {
    try { const i = await term.info(name); return SHELL_CMDS.has(String(i && i.command || '')); } catch (_) { return null; } // null = 터미널 자체가 없다
  };
  const first = await shellNow();
  if (first === false) {
    // TUI 를 끝낸다 — 입력칸에 남은 글자를 지우고 /exit. 실패하면 아무것도 바꾸지 않는다.
    try {
      await term.sendKeys(name, { keys: ['C-u'] });
      await term.sendKeys(name, { data: '/exit' });
      await sleep(timings.adoptKeyGapMs);
      await term.sendKeys(name, { keys: ['Enter'] });
    } catch (e) { throw coded('ADOPT_FAILED', '터미널에 종료 명령을 보내지 못했습니다'); }
    const until = Date.now() + timings.adoptWaitMs;
    let back = false;
    while (Date.now() < until) {
      await sleep(timings.adoptPollMs);
      if (await shellNow()) { back = true; break; }
    }
    if (!back) throw coded('ADOPT_FAILED', '터미널의 에이전트가 종료되지 않았습니다. 터미널에서 직접 종료한 뒤 다시 시도하세요');
  }
  let thread = store.getThread(bind.sessionId);
  if (!thread) thread = await adoptExternal(bind.sessionId, rel, agent);
  await importSession(thread);
  patch(thread.id, { owner: 'chat', ownerTid: null, external: false }, { event: true });
  return { thread: publicThread(store.getThread(thread.id)) };
}

// ── 전문 보기(conv.detail) — 잘린 본문·도구 입력/결과의 원본을 세션 파일에서 찾는다 ────
async function detail(p) {
  const thread = need(p.threadId);
  const ev = store.latestOf(thread.id, 'msg', String(p.key || ''));
  if (!ev || !ev.msg) throw coded('BAD_REQUEST', '메시지를 찾을 수 없습니다');
  const fallback = { text: ev.msg.text || '' };
  if (!ev.uuid) return fallback;
  const adapter = adapterOf(thread.agent);
  const abs = absOf(thread);
  const file = adapter && abs ? adapter.sessionFile(abs, thread.id) : null;
  if (!file) return fallback;
  const t = transcript();
  const needle = Buffer.from(`"${ev.uuid}"`);
  let from = 0;
  for (;;) {
    let r = null;
    try { r = await t.readDelta(file, from, { maxBytes: IMPORT_CHUNK }); } catch (_) { return fallback; }
    for (const ln of r.lines) {
      if (ln.overflow || !ln.bytes || ln.buf.indexOf(needle) < 0) continue;
      let o = null;
      try { o = JSON.parse(ln.buf.toString('utf8')); } catch (_) { continue; }
      if (!o || o.uuid !== ev.uuid) continue;
      const content = o.message && o.message.content;
      if (typeof content === 'string') return { text: content.slice(0, DETAIL_MAX) };
      const blocks = Array.isArray(content) ? content : [];
      const m = ev.msg;
      if (m.kind === 'tool_result') {
        const b = blocks.find((c) => c && c.type === 'tool_result' && (!m.result || c.tool_use_id === m.result.toolUseId));
        const body = b ? (typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n') : '')) : '';
        return { text: body.slice(0, DETAIL_MAX) };
      }
      if (m.tool && m.tool.id) {
        const b = blocks.find((c) => c && c.type === 'tool_use' && c.id === m.tool.id);
        return { text: m.text || '', raw: b ? approvals().inputPreviewOf(b.input) : undefined };
      }
      const text = blocks.filter((c) => c && c.type === 'text').map((c) => String(c.text || '')).join('');
      return { text: (text || m.text || '').slice(0, DETAIL_MAX) };
    }
    from = r.nextOffset;
    if (!r.more) return fallback;
  }
}

// ── 파일 바이트(conv.file, §4.5) ─────────────────────────────────────────────
// 권한 = "그 대화의 이벤트에 등장한 경로만"(v1 chat.file 의 "트랜스크립트가 곧 능력" 규칙). 임의 경로 열람 통로가 아니다.
//  v1 과 다른 점: 홈 jail(fs.safeResolve — realpath 로 심링크 탈출까지)도 통과해야 한다(§4.5). 그래서 홈 밖
//  (/var/folders 의 스크린샷 등)은 참조돼 있어도 거절(outside)이다.
const FILE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', html: 'text/html', htm: 'text/html',
  css: 'text/css', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  py: 'text/plain', sh: 'text/plain', go: 'text/plain', rs: 'text/plain', java: 'text/plain', kt: 'text/plain', swift: 'text/plain',
};
function fileMimeOf(abs) {
  const ext = String(path.extname(abs) || '').slice(1).toLowerCase();
  return FILE_MIME[ext] || 'application/octet-stream';
}

const ATTACH_LINE_RE = /^\[첨부\] (.+)$/gm;                      // composeText 가 붙이는 줄
const LINK_RE = /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^()\s]+))(?:\s+"[^"\n]*")?\)/g; // ![alt](t) · [text](t) · (<공백 있는 경로>) · (t "제목")
const PATH_TOKEN_RE = /(?:^|[\s'"`(=])((?:~\/|\/)[^\s'"`()<>]+)/g;           // argsPreview 안의 절대·~ 경로

/** 참조 원문 → 절대경로(존재·jail 검사는 호출측). base: 'cwd' | 'root'(fs.relOf 가 만든 홈 상대 = tool.path). */
function refAbs(raw, base, cwdAbs) {
  let t = String(raw || '').trim();
  if (!t || t.length > FILE_PATH_MAX) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t)) return null; // URL 은 클라가 직접 연다
  if (/^file:\/\//i.test(t)) { try { t = decodeURIComponent(t.slice(7)); } catch (_) { t = t.slice(7); } }
  t = t.replace(/#.*$/, '');
  if (!t) return null;
  if (t === '~' || t.startsWith('~/')) t = path.join(os.homedir(), t.slice(2));
  if (path.isAbsolute(t)) return path.resolve(t);
  if (base === 'root') { try { return path.resolve(fsLib().rootDir(), t); } catch (_) { return null; } }
  return cwdAbs ? path.resolve(cwdAbs, t) : null;
}

/** 이 이벤트가 말한 경로들 → [[원문, base]]. */
function refsOfEvent(ev) {
  const out = [];
  const m = ev && ev.op === 'msg' ? ev.msg : null;
  if (!m) return out;
  if (Array.isArray(m.attachments)) for (const a of m.attachments) if (a && typeof a.path === 'string') out.push([a.path, 'cwd']);
  const text = typeof m.text === 'string' ? m.text : '';
  if (m.role === 'user' && text.indexOf('[첨부] ') >= 0) {
    ATTACH_LINE_RE.lastIndex = 0;
    let hit;
    while ((hit = ATTACH_LINE_RE.exec(text))) out.push([hit[1].trim(), 'cwd']);
  }
  if (m.role === 'assistant' && text.indexOf('](') >= 0) {
    LINK_RE.lastIndex = 0;
    let hit;
    while ((hit = LINK_RE.exec(text))) out.push([hit[1] || hit[2], 'cwd']);
  }
  if (m.tool && typeof m.tool === 'object') {
    if (typeof m.tool.path === 'string') out.push([m.tool.path, 'root']);
    if (typeof m.tool.argsPreview === 'string') {
      PATH_TOKEN_RE.lastIndex = 0;
      let hit;
      while ((hit = PATH_TOKEN_RE.exec(m.tool.argsPreview))) out.push([hit[1].replace(/[.,;:]+$/, ''), 'cwd']);
    }
  }
  return out;
}

/** 참조 색인을 로그 끝까지 잇는다(증분 — 이미 훑은 seq 는 다시 보지 않는다). */
function refsOf(thread) {
  const head = store.headSeq(thread.id);
  let r = fileRefs.get(thread.id);
  if (!r || r.upto > head) { r = { upto: 0, abs: new Set() }; fileRefs.set(thread.id, r); } // 삭제 후 재생성 등
  if (r.upto === head) return r;
  const cwdAbs = absOf(thread);
  for (const ev of store.eventsAfter(thread.id, r.upto)) {
    for (const [raw, base] of refsOfEvent(ev)) {
      const abs = refAbs(raw, base, cwdAbs);
      if (!abs) continue;
      r.abs.delete(abs); // 최근 참조를 뒤로(상한에서 오래된 것부터 버린다)
      r.abs.add(abs);
      if (r.abs.size > FILE_REFS_MAX) r.abs.delete(r.abs.values().next().value);
    }
  }
  r.upto = head;
  return r;
}

async function fileOf(p) {
  const thread = need(p.threadId);
  const raw = typeof p.path === 'string' ? p.path.trim() : '';
  if (!raw || raw.length > FILE_PATH_MAX || raw.includes('\0')) throw coded('BAD_REQUEST', '파일 경로(path)가 필요합니다');
  const refs = refsOf(thread);
  // 클라는 화면에 보인 원문을 그대로 보낸다 — 원문이 어느 기준의 상대 경로인지 모르므로 두 기준을 다 대 본다.
  const cwdAbs = absOf(thread);
  const abs = [refAbs(raw, 'cwd', cwdAbs), refAbs(raw, 'root', cwdAbs)].find((a) => a && refs.abs.has(a));
  if (!abs) return { missing: true, reason: 'not_referenced' };
  try { fsLib().safeResolve(abs); } catch (_) { return { missing: true, reason: 'outside' } } // jail 밖·심링크 탈출
  let fh = null;
  try {
    fh = await fsp.open(abs, 'r');
    const st = await fh.stat(); // 연 핸들로 잰다 — 검사와 읽기 사이에 파일이 바뀌어도 읽는 것은 잰 그 파일이다
    if (!st.isFile()) return { missing: true, reason: 'not_found' };
    if (st.size > FILE_MAX) return { missing: true, reason: 'too_large', bytes: st.size };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { mediaType: fileMimeOf(abs), base64: buf.subarray(0, off).toString('base64'), bytes: off, name: path.basename(abs) };
  } catch (_) {
    return { missing: true, reason: 'not_found' };
  } finally {
    if (fh) { try { await fh.close(); } catch (_) { /* noop */ } }
  }
}

// ── 목록 ─────────────────────────────────────────────────────────────────────
async function externalThreads(rel, abs, limit) {
  const out = [];
  for (const id of adapterIds()) {
    const adapter = adapterOf(id);
    if (!adapter || typeof adapter.sessions !== 'function') continue;
    let rows = [];
    try { rows = await adapter.sessions(abs, limit); } catch (_) { rows = []; }
    for (const s of rows) {
      if (store.getThread(s.id)) continue;
      const term = terminalOf(s.id);
      out.push({
        ...publicThread(newThread({ id: s.id, agent: adapter.id, cwd: rel, external: true })),
        title: oneLine(s.title || '', TITLE_MAX),
        createdAt: s.lastAt, lastAt: s.lastAt,
        mode: adapter.modes.includes(s.mode) ? s.mode : 'default',
        owner: term ? 'terminal' : 'none', ownerTid: term ? term.tid : null,
      });
    }
  }
  return out;
}

async function createThread(p) {
  const { rel } = normCwd(p.cwd);
  const adapter = adapterOf(p.agent || 'claude');
  if (!adapter) throw coded('AGENT_UNAVAILABLE', '지원하지 않는 에이전트입니다');
  const mode = p.mode == null ? 'default' : String(p.mode);
  if (!adapter.modes.includes(mode)) throw coded('BAD_REQUEST', '알 수 없는 모드입니다');
  const clientId = p.clientId ? String(p.clientId).slice(0, 120) : null;
  if (clientId) {
    // 멱등 — 타임아웃 뒤의 재시도가 대화를 하나 더 만들지 않게.
    const hit = store.listThreads().find((t) => t && t.x && t.x.cid === clientId);
    if (hit) {
      const ev = store.latestOf(hit.id, 'msg', 'u:' + clientId);
      return { thread: publicThread(hit), ...(ev ? { seq: ev.first || ev.seq } : {}) };
    }
  }
  const found = await adapter.locate();
  if (!found || !found.bin) throw coded('AGENT_UNAVAILABLE', '이 PC 에서 에이전트 실행 파일을 찾지 못했습니다');
  if (await adapter.loginState() === 'out') throw coded('AGENT_NOT_LOGGED_IN', '에이전트에 로그인돼 있지 않습니다. PC 터미널에서 로그인한 뒤 다시 시도하세요');
  const thread = newThread({ id: crypto.randomUUID(), agent: adapter.id, cwd: rel, mode, model: p.model ? String(p.model).slice(0, 120) : null, owner: 'chat' });
  if (clientId) thread.x.cid = clientId;
  store.putThread(thread);
  healed.add(thread.id);
  viewed(thread.id);
  hintThread(thread.id);
  const hasText = (typeof p.text === 'string' && p.text.trim()) || (Array.isArray(p.attachments) && p.attachments.length);
  if (!hasText) return { thread: publicThread(thread) };
  const r = await sendInto(thread, { clientId: clientId || crypto.randomUUID(), text: p.text || '', attachments: p.attachments });
  return { thread: publicThread(store.getThread(thread.id)), seq: r.seq };
}

// ── RPC(§4) ──────────────────────────────────────────────────────────────────
const HANDLERS = {
  async 'conv.caps'() {
    const agents = [];
    for (const id of adapterIds()) {
      const a = adapterOf(id);
      if (!a) continue;
      let found = null;
      try { found = await a.locate(); } catch (_) { found = null; }
      agents.push({ id: a.id, label: a.label(), available: !!(found && found.bin), version: (found && found.version) || null });
    }
    const modes = (adapterOf('claude') || { modes: [] }).modes;
    return { enabled: true, agents, modes, maxLive: MAX_LIVE };
  },

  async 'conv.list'(p) {
    const limit = Math.min(Number.isInteger(p.limit) && p.limit > 0 ? p.limit : LIST_DEFAULT, LIST_MAX);
    let scope = null;
    if (typeof p.cwd === 'string') scope = normCwd(p.cwd);
    let threads = store.listThreads()
      .filter((t) => t && (!scope || t.cwd === scope.rel))
      .map((t) => publicThread(reconcileOwner(t)));
    if (p.includeExternal && scope) threads = threads.concat(await externalThreads(scope.rel, scope.abs, limit));
    threads.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    return { threads: threads.slice(0, limit) };
  },

  'conv.create'(p) {
    // 같은 clientId 의 만들기가 겹치면(타임아웃 뒤 재시도) 하나로 합친다.
    const cid = p.clientId ? String(p.clientId).slice(0, 120) : null;
    if (!cid) return createThread(p);
    const cur = creating.get(cid);
    if (cur) return cur;
    const job = createThread(p).finally(() => { if (creating.get(cid) === job) creating.delete(cid); });
    creating.set(cid, job);
    return job;
  },

  async 'conv.open'(p) {
    const id = String(p.threadId || '');
    let thread = store.getThread(id);
    if (!thread) thread = await adoptExternal(id, p.cwd, p.agent);
    heal(id);
    try { await importSession(thread); } catch (e) { log(`가져오기 실패 thread=${id}: ${e && e.message}`); }
    thread = reconcileOwner(store.getThread(id));
    viewed(id);
    const snap = store.open(id, { limit: p.limit });
    return { thread: publicThread(thread), ...snap, live: liveView(id), pending: pendingView(id) };
  },

  async 'conv.since'(p) {
    let thread = need(p.threadId);
    heal(thread.id);
    try { await importSession(thread); } catch (e) { log(`가져오기 실패 thread=${thread.id}: ${e && e.message}`); }
    thread = reconcileOwner(store.getThread(thread.id));
    viewed(thread.id);
    const r = store.since(thread.id, Number(p.sinceSeq) | 0);
    return { thread: publicThread(thread), ...r, live: liveView(thread.id), pending: pendingView(thread.id) };
  },

  async 'conv.before'(p) {
    const thread = need(p.threadId);
    return store.before(thread.id, { beforeSeq: Number(p.beforeSeq) | 0, limit: p.limit });
  },

  async 'conv.send'(p) {
    const thread = need(p.threadId);
    if (!p.clientId || typeof p.clientId !== 'string') throw coded('BAD_REQUEST', 'clientId 가 필요합니다');
    viewed(thread.id);
    heal(thread.id);
    return sendInto(thread, { clientId: p.clientId.slice(0, 120), text: p.text, attachments: p.attachments });
  },

  'conv.respond': respond,

  async 'conv.interrupt'(p) {
    const thread = need(p.threadId);
    const proc = live.get(thread.id);
    if (!proc || !proc.turnOpen) return { ok: true, interrupted: false };
    // 대기 중 요청은 중단과 함께 닫힌다 — 결과(result)를 기다리지 않고 카드부터 거둔다.
    const evs = cancelReqs(proc, 'interrupted');
    if (evs.length) { record(thread.id, evs); patch(thread.id, { pending: 0, state: 'working' }); }
    try { await proc.engine.interrupt(); } catch (e) {
      return { ok: false, interrupted: false, code: (e && e.code) || 'CONTROL_FAILED' };
    }
    return { ok: true, interrupted: true };
  },

  async 'conv.set'(p) {
    const thread = need(p.threadId);
    const adapter = adapterOf(thread.agent);
    const proc = live.get(thread.id);
    if (p.title != null) {
      const title = oneLine(p.title, TITLE_MAX);
      if (!title) throw coded('BAD_REQUEST', '제목이 비어 있습니다');
      patch(thread.id, { title, titleSet: true }, { event: true });
    }
    if (p.mode != null) {
      const mode = String(p.mode);
      if (!adapter || !adapter.modes.includes(mode)) throw coded('BAD_REQUEST', '알 수 없는 모드입니다');
      if (proc && !proc.exited) await proc.engine.setMode(mode);
      patch(thread.id, { mode }, { event: true });
    }
    if (p.model != null) {
      const model = String(p.model).slice(0, 120);
      if (proc && !proc.exited) {
        try { await proc.engine.setModel(model); } catch (_) {
          notice(thread.id, 'info', 'MODEL_NEXT_START', '모델 변경은 다음 시작부터 적용됩니다');
        }
      }
      patch(thread.id, { model }, { event: true });
    }
    return { thread: publicThread(store.getThread(thread.id)) };
  },

  async 'conv.stop'(p) {
    const thread = need(p.threadId);
    const proc = live.get(thread.id);
    if (proc) await stopProc(proc, 'stopped');
    return { ok: true };
  },

  async 'conv.remove'(p) {
    const id = String(p.threadId || '');
    const proc = live.get(id);
    if (proc) await stopProc(proc, 'removed');
    else if (leaving.has(id)) await leaving.get(id);
    const had = store.removeThread(id); // 에이전트의 세션 파일은 건드리지 않는다
    viewers.delete(id); healed.delete(id); fileRefs.delete(id);
    if (had) push({ control: { kind: 'deleted', threadId: id } });
    return { ok: true };
  },

  'conv.detail': detail,
  'conv.file': fileOf,

  async 'conv.commands'(p) {
    let thread = null;
    if (p.threadId) thread = need(p.threadId);
    const agent = (thread && thread.agent) || 'claude';
    const rel = thread ? thread.cwd : (typeof p.cwd === 'string' ? normCwd(p.cwd).rel : '');
    let abs = null;
    try { abs = fsLib().safeResolve(rel || ''); } catch (_) { abs = null; }
    let table = [];
    try { table = require('./commands').listCommands({ agent, cwdAbs: abs }).items || []; } catch (_) { table = []; }
    const desc = new Map(table.map((it) => [String(it.name).replace(/^\//, ''), it]));
    const c = catalog.get(agent);
    // 에이전트가 직접 알려준 목록이 정본이다. 아직 한 번도 안 띄웠으면 카탈로그 표로 대신한다.
    const names = c ? c.commands.filter((n) => !c.terminalCommands.includes(n))
      : table.filter((it) => it.chat !== 'tui' && it.chat !== 'dialog').map((it) => String(it.name).replace(/^\//, ''));
    return { items: names.map((n) => ({ name: '/' + n, desc: (desc.get(n) && desc.get(n).desc) || '' })) };
  },

  'conv.toTerminal': toTerminal,
  'conv.adopt': adopt,
};

async function rpc(method, params, ws) {
  if (ws && typeof ws.send === 'function') pushWs = ws;
  if (!enabled() || serverCapOff()) throw coded('CONV_DISABLED', '이 기능은 꺼져 있습니다');
  const fn = HANDLERS[method];
  if (!fn) throw coded('BAD_REQUEST', '알 수 없는 conv 메서드: ' + method);
  const p = params && typeof params === 'object' ? params : {};
  return fn(p);
}

// ── 수명 ─────────────────────────────────────────────────────────────────────
function sweep() {
  const now = deps.now();
  for (const proc of [...live.values()]) {
    if (proc.exited || proc.stopping || busy(proc)) continue;
    if (now - proc.idleSince < timings.idleMs) continue;
    log(`idle 회수 thread=${proc.id}`);
    stopProc(proc, 'idle').catch(() => {});
  }
}

// 종료 직전의 장부 정리(동기) — 열린 턴은 중단으로, 대기 요청은 취소로 남긴다.
function closeBooks(reason) {
  for (const proc of live.values()) {
    if (proc.exited) continue;
    proc.stopReason = proc.stopReason || reason;
    const evs = [...cancelReqs(proc, 'process_exit'), ...failUnacked(proc)];
    if (proc.turnOpen) {
      proc.turnOpen = false;
      evs.push({ op: 'turn', phase: 'end', turn: proc.turn, ok: false, subtype: reason, interrupted: true });
    }
    if (evs.length) store.appendMany(proc.id, evs);
    store.patchThread(proc.id, { state: 'stopped', pending: 0 });
  }
  store.flushSync();
}

/** 전부 정상 종료 — stdin end → stopGraceMs → SIGTERM(§5). */
async function shutdown({ graceMs } = {}) {
  closeBooks('daemon_shutdown');
  const procs = [...live.values()].filter((p) => !p.exited);
  await Promise.all(procs.map((p) => {
    p.stopping = p.stopping || p.engine.stop({ graceMs: graceMs == null ? timings.stopGraceMs : graceMs }).catch(() => {});
    return p.stopping;
  }));
  store.flushSync();
}

/** 기다릴 수 없는 종료 경로(process 'exit') — 장부를 닫고 신호만 보낸다. 부모가 죽으면 stdin 도 닫힌다. */
function shutdownSync() {
  try { closeBooks('daemon_shutdown'); } catch (_) { /* noop */ }
  for (const p of live.values()) { if (!p.exited) { try { p.engine.killNow(); } catch (_) { /* noop */ } } }
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
function installHooks() {
  if (hooks) return;
  const onExitHook = () => shutdownSync();
  const sigs = {};
  let leaving = false;
  for (const sig of SIGNALS) {
    sigs[sig] = () => {
      if (leaving) return;
      leaving = true;
      // 살아 있는 프로세스가 없으면 곧장, 있으면 정상 종료를 기다린 뒤 끝낸다(exit 훅이 나머지를 닫는다).
      const go = () => process.exit(0);
      if (![...live.values()].some((p) => !p.exited)) { go(); return; }
      shutdown().then(go, go);
    };
    process.on(sig, sigs[sig]);
  }
  process.on('exit', onExitHook);
  hooks = { onExitHook, sigs };
}
function removeHooks() {
  if (!hooks) return;
  process.removeListener('exit', hooks.onExitHook);
  for (const sig of SIGNALS) process.removeListener(sig, hooks.sigs[sig]);
  hooks = null;
}

/** 데몬 기동 시 1회 — 30일 정리 + idle 회수 타이머 + 종료 훅. */
function start(opts) {
  if (opts) configure(opts);
  else store.configure({ now: () => deps.now(), pinned: (id) => live.has(id) });
  if (!enabled()) return module.exports;
  try { const r = store.prune(); if (r.pruned) log(`오래된 대화 ${r.pruned}건 정리`); } catch (e) { log(`정리 실패: ${e && e.message}`); }
  if (!sweeper) {
    sweeper = setInterval(sweep, timings.sweepMs);
    if (sweeper.unref) sweeper.unref();
  }
  if (deps.installExitHooks !== false) installHooks();
  return module.exports;
}

function stop() {
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  removeHooks();
}

/** 제어 WS 끊김 — push 대상만 놓는다. 프로세스는 계속 돈다(재접속한 클라가 conv.since 로 따라잡는다). */
function detachAll() { pushWs = null; }

async function _reset() {
  stop();
  for (const t of hintTimers.values()) clearTimeout(t);
  hintTimers.clear();
  const procs = [...live.values()];
  for (const p of procs) p.stopReason = p.stopReason || 'reset';
  await Promise.all(procs.map((p) => (p.exited ? null : p.engine.stop({ graceMs: 200 }).catch(() => {}))));
  live.clear(); leaving.clear(); sending.clear(); creating.clear(); viewers.clear(); healed.clear(); catalog.clear(); fileRefs.clear();
  pushWs = null;
  deps = { ...defaults };
  timings = { ...DEFAULT_TIMINGS };
  store.flushSync();
  store._reset();
}

module.exports = {
  CAP, MAX_LIVE, ERROR_CODES,
  configure, start, stop, shutdown, shutdownSync, detachAll, rpc,
  _internals: {
    live, sweep, heal, importSession, answersMap, alwaysLabelOf, composeText, publicThread, terminalOf, usageOf, refsOfEvent,
    _reset,
    get timings() { return timings; },
  },
};
// OPTIONAL_CAPS(control.js) 능력 판정 — 킬스위치가 꺼 두면 undefined → conv.v1 미광고(dispatch.js 와 같은 규약).
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
