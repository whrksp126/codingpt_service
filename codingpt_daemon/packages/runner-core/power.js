/**
 * power.js — F4 PC 깨어 있기(automation-design §6). 설계 정본: codingpt_daemon/docs/automation-design.md.
 *
 * 두 층:
 *  A. `/usr/bin/caffeinate -i -s -w <데몬 pid>` — 권한 없음. 작업 활성 중 ∧ keepAwake 일 때만 자식으로 띄운다.
 *     `-w` 로 데몬이 SIGKILL 로 죽어도 caffeinate 가 따라 끝난다(고아 방지 — 문서 §6.3 의 기동 복구와 이중 방어).
 *  B. `sudo -n /usr/bin/pmset -a disablesleep {1,0}` — 덮개 닫힘까지 막는 유일한 수단(부록 Z-10). sudoers.d
 *     규칙(그 두 명령만 NOPASSWD)을 1회 설정(power.setup — macOS 암호 다이얼로그에 **사용자가 직접** 입력)한 뒤
 *     **활성 중 ∧ AC 전원**일 때만 1, 유휴·종료·기동 복구에서 항상 0. 우리가 켜지 않은 SleepDisabled 는 건드리지 않는다.
 *
 * 활성 판정 = tasks.activeReasons() ∪ automations.activeReasons() ∪ dispatch.activeReasons(). 활성 전이 즉시,
 *  비활성 전이는 120s 연속 유휴 뒤(히스테리시스). 실패는 lastError + power.changed(다음 틱 재시도, 알림 없음).
 *
 * ★ 테스트는 exec/spawn/execSync/kill 을 전부 주입한다 — 실제 caffeinate·pmset·sudo·osascript 를 부르지 않는다.
 *  darwin 이 아니면 handle 이 undefined(→ power.v1 미광고).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const runtime = require('./runtime');
const taskGit = require('./task-git');

const { codedError } = taskGit;

const ERROR_CODES = ['POWER_DISABLED', 'POWER_UNSUPPORTED', 'POWER_SETUP_REQUIRED', 'POWER_SUDO_MISSING', 'POWER_NO_GUI',
  'POWER_SETUP_CANCELLED', 'POWER_SETUP_FAILED'];
const STATUS_FIELDS = ['supported', 'keepAwake', 'lidClosed', 'setup', 'setupError', 'active', 'reasons', 'layers', 'power',
  'lidBlocked', 'lastError', 'since'];
const CAFFEINATE = '/usr/bin/caffeinate';
const PMSET = '/usr/bin/pmset';
const SUDO = '/usr/bin/sudo';
const OSASCRIPT = '/usr/bin/osascript';
const LAUNCHCTL = '/bin/launchctl';
const SUDOERS_TARGET = '/etc/sudoers.d/codingpt-pmset';
const SETUP_PROMPT = 'CodingPT: 덮개를 닫아도 작업을 계속하도록 설정합니다';
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._\/-]+$/;

// ── 주입 ─────────────────────────────────────────────────────────────────────
const noop = () => {};
function defaultExec(bin, args, opts = {}) { return taskGit.exec(bin, args, { timeout: opts.timeout || 15000, input: opts.input }); }
function defaultExecSync(bin, args, opts = {}) {
  const r = childProcess.spawnSync(bin, args, { encoding: 'utf8', timeout: opts.timeout || 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status == null ? -1 : r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}
function defaultSpawn(bin, args) {
  const c = childProcess.spawn(bin, args, { stdio: 'ignore' });
  c.on('error', () => { /* 없는 바이너리 — pid 없음으로 드러난다 */ });
  return c;
}
function defaultKill(pid, sig) { process.kill(pid, sig); }

let inj = {
  notify: noop,          // ({reason}) → cpt-server.notifyPowerChanged
  backFetch: null,
  deviceId: () => null,
  log: (m) => console.log(m),
  tasks: null,           // activeReasons()/addChangeListener()
  sendControl: noop,     // (frame) → control.send
  now: () => Date.now(),
  exec: defaultExec,         // async (bin, args, {timeout, input}) → {ok, code, out, err, timedOut}
  execSync: defaultExecSync, // (bin, args, {timeout}) → {status, stdout, stderr}  — 종료 훅·기동 복구
  spawn: defaultSpawn,       // (bin, args) → ChildProcess(pid, kill, on)
  kill: defaultKill,         // (pid, sig)
  platform: null,            // 테스트 주입 — 기본 runtime.platform()
  username: () => os.userInfo().username,
  agentState: null,
  modules: null,             // 테스트 주입: [{activeReasons}] — 기본 = automations·dispatch 지연 로드
  installExitHooks: true,
  hostName: null,
};
let timings = { idleMs: 120000, tickMs: 30000, busyThrottleMs: 10000, powerCacheMs: 30000, setupTimeoutMs: 180000, evalDebounceMs: 200 };

function configure(opts = {}) {
  for (const k of ['notify', 'backFetch', 'deviceId', 'log', 'sendControl', 'now', 'exec', 'execSync', 'spawn', 'kill', 'username', 'hostName']) {
    if (opts[k] !== undefined) inj[k] = typeof opts[k] === 'function' ? opts[k] : null;
  }
  for (const k of ['tasks', 'platform', 'agentState', 'modules', 'installExitHooks']) if (opts[k] !== undefined) inj[k] = opts[k];
  if (!inj.notify) inj.notify = noop;
  if (!inj.sendControl) inj.sendControl = noop;
  if (!inj.deviceId) inj.deviceId = () => null;
  if (!inj.log) inj.log = noop;
  if (!inj.now) inj.now = () => Date.now();
  if (!inj.exec) inj.exec = defaultExec;
  if (!inj.execSync) inj.execSync = defaultExecSync;
  if (!inj.spawn) inj.spawn = defaultSpawn;
  if (!inj.kill) inj.kill = defaultKill;
  if (!inj.username) inj.username = () => os.userInfo().username;
  if (opts.timings && typeof opts.timings === 'object') timings = { ...timings, ...opts.timings };
  return module.exports;
}
const nowFn = () => inj.now();
const log = (m) => { try { inj.log(m); } catch (_) { /* noop */ } };
function platform() { return inj.platform || runtime.platform(); }
function supported() { return platform() === 'darwin'; }
function enabled() { return supported() && process.env.CPT_POWER !== '0'; }

// ── 영속(power.json) ─────────────────────────────────────────────────────────
function stateFile() { return path.join(runtime.stateDir(), 'power.json'); }
function defaults() {
  return { v: 1, keepAwake: false, lidClosed: false, setupAt: null, weSetDisableSleep: false, caffeinatePid: null, updatedAt: null };
}
let st = null;
function load() {
  if (st) return st;
  st = defaults();
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (j && typeof j === 'object') {
      st.keepAwake = j.keepAwake === true;
      st.lidClosed = j.lidClosed === true;
      st.setupAt = Number.isFinite(j.setupAt) ? j.setupAt : null;
      st.weSetDisableSleep = j.weSetDisableSleep === true;
      st.caffeinatePid = Number.isInteger(j.caffeinatePid) && j.caffeinatePid > 1 ? j.caffeinatePid : null;
      st.updatedAt = Number.isFinite(j.updatedAt) ? j.updatedAt : null;
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') log(`[power] power.json 읽기 실패(기본값): ${e.message}`);
  }
  return st;
}
function save() {
  const s = load();
  s.updatedAt = nowFn();
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* noop */ }
    fs.renameSync(tmp, file);
  } catch (e) { log(`[power] power.json 저장 실패: ${e.message}`); }
}

// ── 런타임 상태 ───────────────────────────────────────────────────────────────
function freshRt() {
  return {
    active: false, reasons: [], idleSince: null, since: null,
    layers: { caffeinate: false, disableSleep: false },
    power: 'unknown', powerAt: 0, lidBlocked: null, lastError: null,
    setup: 'none', setupError: null, foreign: false,
    caffChild: null,
    // hello 의 기본값(busy/awake false)을 "보낸 것" 으로 친다 — 첫 실제 변화는 즉시 나간다.
    busySent: { busy: false, awake: false }, busySentAt: 0, busyTimer: null,
  };
}
let rt = freshRt();

function status() {
  const s = load();
  return {
    supported: supported(),
    keepAwake: s.keepAwake,
    lidClosed: s.lidClosed,
    setup: rt.setup === 'pending' || rt.setup === 'failed' ? rt.setup : (s.setupAt ? 'done' : 'none'),
    setupError: rt.setupError,
    active: rt.active,
    reasons: rt.reasons.slice(),
    layers: { ...rt.layers },
    power: rt.power,
    lidBlocked: rt.lidBlocked,
    lastError: rt.lastError,
    since: rt.since,
  };
}
let lastSig = null;
function changed(reason) {
  const sig = JSON.stringify({ ...status(), since: 0 });
  if (sig === lastSig) return;
  lastSig = sig;
  try { inj.notify({ reason }); } catch (_) { /* noop */ }
}

// ── 활동 판정 ─────────────────────────────────────────────────────────────────
function reasonSources() {
  if (Array.isArray(inj.modules)) return inj.modules;
  const out = [];
  const t = inj.tasks || safeRequire('./tasks');
  if (t) out.push(t);
  for (const m of ['./automations', './dispatch']) { const lib = safeRequire(m); if (lib) out.push(lib); }
  return out;
}
function safeRequire(m) { try { return require(m); } catch (_) { return null; } }
function computeReasons() {
  const set = new Set();
  for (const m of reasonSources()) {
    if (!m || typeof m.activeReasons !== 'function') continue;
    try { for (const r of m.activeReasons() || []) if (typeof r === 'string') set.add(r); } catch (_) { /* noop */ }
  }
  return [...set].sort();
}
function isWorkActive() { return computeReasons().length > 0; }

// ── 층 A: caffeinate ─────────────────────────────────────────────────────────
function caffAlive() { return !!(rt.caffChild && rt.caffChild.exitCode == null && !rt.caffChild.killed && rt.caffChild.pid); }
function startCaff() {
  if (caffAlive()) return true;
  let c = null;
  try { c = inj.spawn(CAFFEINATE, ['-i', '-s', '-w', String(process.pid)]); } catch (e) { c = null; rt.lastError = `CAFFEINATE_FAILED`; log(`[power] caffeinate 실패: ${e && e.message}`); }
  if (!c || !c.pid) { rt.lastError = 'CAFFEINATE_FAILED'; return false; }
  rt.caffChild = c;
  if (typeof c.on === 'function') {
    c.on('exit', () => {
      if (rt.caffChild === c) {
        rt.caffChild = null; rt.layers.caffeinate = false;
        const s = load(); if (s.caffeinatePid === c.pid) { s.caffeinatePid = null; save(); }
        scheduleEval();
      }
    });
  }
  const s = load();
  s.caffeinatePid = c.pid;
  save();
  return true;
}
function stopCaff() {
  const c = rt.caffChild;
  rt.caffChild = null;
  if (c && c.pid) { try { if (typeof c.kill === 'function') c.kill('SIGTERM'); else inj.kill(c.pid, 'SIGTERM'); } catch (_) { /* 이미 끝남 */ } }
  const s = load();
  if (s.caffeinatePid != null) { s.caffeinatePid = null; save(); }
}

// ── 층 B: pmset disablesleep ─────────────────────────────────────────────────
async function powerSource() {
  if (nowFn() - rt.powerAt < timings.powerCacheMs && rt.power !== 'unknown') return rt.power;
  let r = null;
  try { r = await inj.exec(PMSET, ['-g', 'batt'], { timeout: 5000 }); } catch (_) { r = null; }
  const first = r && r.ok ? String(r.out).split('\n')[0] : '';
  rt.power = /AC Power/i.test(first) ? 'ac' : /Battery Power/i.test(first) ? 'battery' : 'unknown';
  rt.powerAt = nowFn();
  return rt.power;
}
async function setDisableSleep(on) {
  let r = null;
  try { r = await inj.exec(SUDO, ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0'], { timeout: 10000 }); } catch (_) { r = null; }
  return !!(r && r.ok);
}

// ── 평가(직렬) ────────────────────────────────────────────────────────────────
let evalChain = Promise.resolve();
function evaluate() {
  const p = evalChain.then(() => doEvaluate()).catch((e) => log(`[power] 평가 실패: ${e && e.message}`));
  evalChain = p;
  return p;
}
let evalTimer = null;
function scheduleEval() {
  if (!started || evalTimer) return;
  evalTimer = setTimeout(() => { evalTimer = null; evaluate(); }, timings.evalDebounceMs);
  if (evalTimer.unref) evalTimer.unref();
}

async function doEvaluate() {
  const s = load();
  const now = nowFn();
  const reasons = computeReasons();
  const raw = reasons.length > 0;
  rt.reasons = reasons;
  if (raw) {
    rt.idleSince = null;
    if (!rt.active) { rt.active = true; rt.since = now; }
  } else if (rt.active) {
    if (rt.idleSince == null) rt.idleSince = now;
    if (now - rt.idleSince >= timings.idleMs) { rt.active = false; rt.since = now; rt.idleSince = null; }
  } else if (rt.since == null) rt.since = now;

  // 층 A
  const wantA = rt.active && s.keepAwake;
  if (wantA) rt.layers.caffeinate = startCaff();
  else { if (caffAlive() || rt.caffChild) stopCaff(); rt.layers.caffeinate = false; }

  // 층 B
  let wantB = false;
  rt.lidBlocked = null;
  if (s.lidClosed) {
    if (!s.setupAt) rt.lidBlocked = 'setup';
    else if (rt.active) {
      const pw = await powerSource();
      if (pw === 'battery') rt.lidBlocked = 'battery';
      else if (pw === 'ac') wantB = true;
    }
  }
  if (rt.foreign) wantB = false; // 사용자가 직접 켠 SleepDisabled — 우리 것으로 삼지 않는다
  if (wantB && !s.weSetDisableSleep) {
    if (await setDisableSleep(true)) {
      s.weSetDisableSleep = true; save();
      if (rt.lastError === 'POWER_SUDO_MISSING') rt.lastError = null;
    } else { rt.lastError = 'POWER_SUDO_MISSING'; rt.lidBlocked = 'sudo'; }
  } else if (!wantB && s.weSetDisableSleep) {
    if (await setDisableSleep(false)) { s.weSetDisableSleep = false; save(); } else rt.lastError = 'POWER_SUDO_MISSING';
  }
  rt.layers.disableSleep = !!s.weSetDisableSleep;
  if (rt.lastError === 'CAFFEINATE_FAILED' && rt.layers.caffeinate) rt.lastError = null;
  changed('state');
  sendBusy();
  return status();
}

// ── runner_busy(§6.3) — 10s 스로틀, 마지막 값은 반드시 보낸다 ────────────────────
function busyFrame() { return { busy: !!rt.active, awake: !!(rt.layers.caffeinate || rt.layers.disableSleep) }; }
function helloFields() { return busyFrame(); }
// control.js helloFrame(S1) 이 부르는 이름 — helloFields 와 같다.
function busyState() { return busyFrame(); }
function sendBusy() {
  const f = busyFrame();
  const same = rt.busySent && rt.busySent.busy === f.busy && rt.busySent.awake === f.awake;
  if (same) { if (rt.busyTimer) { clearTimeout(rt.busyTimer); rt.busyTimer = null; } return; }
  const now = nowFn();
  const wait = rt.busySentAt ? rt.busySentAt + timings.busyThrottleMs - now : 0;
  const fire = () => {
    rt.busyTimer = null;
    const g = busyFrame();
    rt.busySent = g;
    rt.busySentAt = nowFn();
    try { inj.sendControl({ type: 'runner_busy', busy: g.busy, awake: g.awake, at: rt.busySentAt }); } catch (_) { /* noop */ }
  };
  if (wait <= 0) { if (rt.busyTimer) { clearTimeout(rt.busyTimer); rt.busyTimer = null; } fire(); return; }
  if (!rt.busyTimer) {
    rt.busyTimer = setTimeout(fire, wait);
    if (rt.busyTimer.unref) rt.busyTimer.unref();
  }
}

// ── 1회 설정(§6.2) ────────────────────────────────────────────────────────────
function sudoersBody(user) {
  return `# CodingPT keep-awake (lid closed). Removable via CodingPT settings.\n${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0\n`;
}
function setupScript({ remove, tmp }) {
  if (remove) return `/bin/rm -f ${SUDOERS_TARGET}`;
  return `/usr/sbin/visudo -c -f ${tmp} && /usr/bin/install -o root -g wheel -m 0440 ${tmp} ${SUDOERS_TARGET}`;
}
function appleScriptOf(script) {
  // 경로는 데몬이 만든 것(SAFE_PATH_RE — 공백·따옴표·역슬래시 없음), 사용자 입력 0.
  return `do shell script "${script}" with administrator privileges with prompt "${SETUP_PROMPT}"`;
}

const running = new Set();
function track(p) { running.add(p); p.finally(() => running.delete(p)).catch(() => {}); return p; }

async function doSetup(remove) {
  const s = load();
  let tmp = null;
  try {
    if (remove && s.weSetDisableSleep) { if (await setDisableSleep(false)) { s.weSetDisableSleep = false; save(); } }
    if (!remove) {
      const user = String(inj.username() || '');
      tmp = path.join(runtime.stateDir(), `sudoers-${process.pid}.tmp`);
      if (!SAFE_PATH_RE.test(tmp)) tmp = path.join('/tmp', `codingpt-sudoers-${process.pid}.tmp`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, sudoersBody(user), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch (_) { /* noop */ }
    }
    const r = await inj.exec(OSASCRIPT, ['-e', appleScriptOf(setupScript({ remove, tmp }))], { timeout: timings.setupTimeoutMs });
    if (!r || !r.ok) {
      const all = `${(r && r.err) || ''}\n${(r && r.out) || ''}`;
      const code = /User canceled|사용자가 취소|\(-128\)/i.test(all) ? 'POWER_SETUP_CANCELLED' : 'POWER_SETUP_FAILED';
      rt.setup = 'failed';
      rt.setupError = code;
      log(`[power] 설정 실패(${code}): ${all.trim().slice(0, 200)}`);
      return;
    }
    if (remove) {
      s.setupAt = null; save();
      rt.setup = 'none'; rt.setupError = null;
      return;
    }
    // 검증 — 규칙이 실제로 먹는가(sudo -n 이 암호 없이 통과).
    if (await setDisableSleep(false)) {
      s.setupAt = nowFn(); s.weSetDisableSleep = false; save();
      rt.setup = 'done'; rt.setupError = null;
      if (rt.lastError === 'POWER_SUDO_MISSING') rt.lastError = null;
    } else {
      rt.setup = 'failed'; rt.setupError = 'POWER_SETUP_FAILED';
    }
  } catch (e) {
    rt.setup = 'failed'; rt.setupError = 'POWER_SETUP_FAILED';
    log(`[power] 설정 예외: ${e && e.message}`);
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* noop */ } }
    changed('setup');
    evaluate();
  }
}

// ── RPC(§6.4) ─────────────────────────────────────────────────────────────────
async function rpcStatus() { return status(); }

async function rpcSet(p) {
  const s = load();
  for (const k of ['keepAwake', 'lidClosed']) {
    if (p[k] == null) continue;
    if (typeof p[k] !== 'boolean') throw codedError('BAD_PARAMS', `${k} 는 true/false 입니다`);
    s[k] = p[k];
  }
  save();
  await evaluate();
  return { status: status() };
}

async function rpcSetup(p) {
  const remove = p.remove === true;
  if (rt.setup === 'pending') return { accepted: true };
  if (!USER_RE.test(String(inj.username() || ''))) throw codedError('POWER_SETUP_FAILED', '이 계정 이름으로는 설정할 수 없습니다');
  let gui = '';
  try { gui = String(inj.execSync(LAUNCHCTL, ['managername'], { timeout: 3000 }).stdout || '').trim(); } catch (_) { gui = ''; }
  if (gui !== 'Aqua') throw codedError('POWER_NO_GUI', 'PC 앱에서 설정하세요(로그인된 화면이 필요합니다)');
  rt.setup = 'pending';
  rt.setupError = null;
  changed('setup');
  track(doSetup(remove));
  return { accepted: true };
}

function hostNameOf() {
  if (inj.hostName) { try { const n = inj.hostName(); if (n) return String(n); } catch (_) { /* noop */ } }
  try { const c = require('./config').load(); if (c && c.deviceName) return String(c.deviceName); } catch (_) { /* noop */ }
  return os.hostname();
}

async function rpcEvent(p, ctx) {
  // 로컬 소켓 전용(부록 Z-13) — 원격 기기가 PC 의 잠자기를 주장할 이유가 없다.
  //  ctx = cpt-server.handleAutoRpc 의 meta({via:'local'|'relay'|'cli'}) — PC 앱 소켓(power_local)만 통과.
  if (!ctx || !(ctx.local === true || ctx.via === 'local')) throw codedError('BAD_PARAMS', 'power.event 는 이 PC 에서만 부를 수 있습니다');
  const kind = p.kind;
  if (kind !== 'willSleep' && kind !== 'didWake') throw codedError('BAD_PARAMS', 'kind 가 올바르지 않습니다');
  if (kind === 'willSleep') {
    const reasons = computeReasons();
    if (reasons.length && inj.backFetch) {
      const host = inj.deviceId();
      const n = reasons.filter((r) => r.startsWith('task:')).length || reasons.length;
      // best effort — macOS 가 주는 시간은 수 초. 실패 무시.
      inj.backFetch('POST', '/api/notifications', {
        source: 'system', kind: 'pc_sleeping', title: 'PC 가 잠자기에 들어가요',
        subtitle: `${hostNameOf()} · 작업 ${n}개 진행 중`,
        deeplink: `codingpt://tasks?host=${host == null ? '' : host}`,
        pushGate: 'ignore-pc-active', push: { data: { hostDeviceId: host } },
      }).catch((e) => log(`[power] pc_sleeping 알림 실패: ${e && e.message}`));
    }
  } else {
    rt.powerAt = 0; // 깨어난 뒤 전원 상태를 새로 본다
    evaluate();
  }
  return { ok: true };
}

async function rpc(method, params, ctx) {
  if (!enabled()) throw codedError(supported() ? 'POWER_DISABLED' : 'POWER_UNSUPPORTED', '이 PC 에서는 지원되지 않습니다');
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  switch (String(method || '')) {
    case 'power.status': return rpcStatus(p);
    case 'power.set': return rpcSet(p);
    case 'power.setup': return rpcSetup(p);
    case 'power.event': return rpcEvent(p, ctx);
    default: throw codedError('BAD_PARAMS', '알 수 없는 명령입니다: ' + method);
  }
}
/** 로컬 소켓(PC 앱 power_local) 전용 진입점 — power.event 를 허용한다. */
function handleLocal(method, params) { return rpc(method, params, { local: true }); }

// ── 기동 복구 · 종료 훅(§6.3) ─────────────────────────────────────────────────
function recoverOnStart() {
  const s = load();
  // (1) 지난 프로세스가 띄운 caffeinate — 이름을 확인하고서만 죽인다(pid 재사용 방어).
  if (s.caffeinatePid) {
    let comm = '';
    try { comm = String(inj.execSync('/bin/ps', ['-o', 'comm=', '-p', String(s.caffeinatePid)], { timeout: 3000 }).stdout || '').trim(); } catch (_) { comm = ''; }
    if (/caffeinate$/.test(comm)) { try { inj.kill(s.caffeinatePid, 'SIGTERM'); } catch (_) { /* noop */ } }
    s.caffeinatePid = null;
    save();
  }
  // (2) SleepDisabled — 우리가 켠 것만 0 으로. 남이 켠 것은 표시만.
  let out = '';
  try { out = String(inj.execSync(PMSET, ['-g'], { timeout: 5000 }).stdout || ''); } catch (_) { out = ''; }
  const on = /SleepDisabled\s+1/.test(out);
  if (on && s.weSetDisableSleep) {
    let r = null;
    try { r = inj.execSync(SUDO, ['-n', PMSET, '-a', 'disablesleep', '0'], { timeout: 10000 }); } catch (_) { r = null; }
    if (r && r.status === 0) { s.weSetDisableSleep = false; save(); } else rt.lastError = 'POWER_SUDO_MISSING';
  } else if (on) {
    rt.foreign = true;
    rt.lastError = 'FOREIGN_DISABLESLEEP';
  } else if (s.weSetDisableSleep) { s.weSetDisableSleep = false; save(); }
}

/** 동기 정리 — 종료 경로에서 부른다(비동기 불가). */
function cleanupSync() {
  const s = load();
  const pid = (rt.caffChild && rt.caffChild.pid) || s.caffeinatePid;
  if (pid) { try { inj.kill(pid, 'SIGTERM'); } catch (_) { /* noop */ } }
  rt.caffChild = null;
  s.caffeinatePid = null;
  if (s.weSetDisableSleep) {
    try {
      const r = inj.execSync(SUDO, ['-n', PMSET, '-a', 'disablesleep', '0'], { timeout: 5000 });
      if (r && r.status === 0) s.weSetDisableSleep = false;
    } catch (_) { /* noop */ }
  }
  save();
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
let hooks = null;
function installHooks() {
  if (hooks || inj.installExitHooks === false) return;
  const onExit = () => { try { cleanupSync(); } catch (_) { /* noop */ } };
  const sigs = {};
  for (const sig of SIGNALS) {
    sigs[sig] = () => {
      onExit();
      // 우리 리스너만 있으면 기본 동작(종료)이 사라진다 — 제거 후 같은 신호를 다시 보내 원래대로 끝나게.
      if (process.listenerCount(sig) <= 1) {
        process.removeListener(sig, sigs[sig]);
        try { process.kill(process.pid, sig); } catch (_) { process.exit(1); }
      }
    };
    process.on(sig, sigs[sig]);
  }
  process.on('exit', onExit);
  hooks = { onExit, sigs };
}
function removeHooks() {
  if (!hooks) return;
  process.removeListener('exit', hooks.onExit);
  for (const sig of SIGNALS) process.removeListener(sig, hooks.sigs[sig]);
  hooks = null;
}

// ── 수명 ─────────────────────────────────────────────────────────────────────
let started = false;
let tickTimer = null;
let unsubs = [];
function start() {
  if (started || !enabled()) return;
  started = true;
  load();
  try { recoverOnStart(); } catch (e) { log(`[power] 기동 복구 실패: ${e && e.message}`); }
  installHooks();
  // 재평가 트리거: 버스 activity.changed·task.*, agent-state 전이, tasks 변경, 30s 틱.
  const ev = safeRequire('./events');
  if (ev && typeof ev.on === 'function') {
    for (const type of ['activity.changed', 'task.created', 'task.review_ready', 'task.merged', 'task.failed']) {
      try { const off = ev.on(type, () => scheduleEval()); if (typeof off === 'function') unsubs.push(off); } catch (_) { /* noop */ }
    }
  }
  const as = inj.agentState || safeRequire('./agent-state');
  if (as && typeof as.subscribe === 'function') { try { unsubs.push(as.subscribe(() => scheduleEval())); } catch (_) { /* noop */ } }
  const t = inj.tasks || safeRequire('./tasks');
  if (t && typeof t.addChangeListener === 'function') { try { unsubs.push(t.addChangeListener(() => scheduleEval())); } catch (_) { /* noop */ } }
  tickTimer = setInterval(() => { evaluate(); }, timings.tickMs);
  if (tickTimer.unref) tickTimer.unref();
  evaluate();
}
function stop() {
  for (const off of unsubs) { try { off(); } catch (_) { /* noop */ } }
  unsubs = [];
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (evalTimer) { clearTimeout(evalTimer); evalTimer = null; }
  if (rt.busyTimer) { clearTimeout(rt.busyTimer); rt.busyTimer = null; }
  removeHooks();
  started = false;
}

async function _drain() { await evalChain; while (running.size) await Promise.allSettled([...running]); await evalChain; }
function _reset() { stop(); st = null; rt = freshRt(); lastSig = null; evalChain = Promise.resolve(); }

module.exports = {
  configure, start, stop, rpc, handleLocal, status, isWorkActive, helloFields, busyState, cleanupSync,
  ERROR_CODES, STATUS_FIELDS,
  _internals: {
    evaluate, recoverOnStart, computeReasons, sudoersBody, setupScript, appleScriptOf, stateFile, load, save,
    _drain, _reset, get rt() { return rt; }, get timings() { return timings; },
  },
};
// OPTIONAL_CAPS(control.js) — darwin 이 아니거나 CPT_POWER=0 이면 undefined → power.v1 미광고.
//  handle(method, params, ctx) — ctx.local===true 는 로컬 소켓 경로만 넘긴다(power.event 허용).
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
