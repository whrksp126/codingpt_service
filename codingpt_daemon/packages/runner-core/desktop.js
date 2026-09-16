'use strict';

/**
 * desktop — **에이전트 데스크톱**: 이 맥 안에서 에이전트가 쓰는 별도의 macOS(게스트 VM).
 *
 *  사용자는 자기 화면·마우스·키보드를 그대로 쓰고, 에이전트는 이 게스트에서 전면 컴퓨터 유즈를 한다.
 *  사용자는 PC·폰의 "모바일 화면" pane 과 같은 파이프로 이 화면을 보고 손댄다(기기 id `desktop:main`).
 *
 *  층:
 *   · 하이퍼바이저 = Lume(Virtualization.framework 래퍼) CLI. 우리는 run/stop/get/ssh 만 쓴다. 인터페이스를 여기
 *     한 파일 뒤로 좁혀 두어 나중에 자체 VZ 래퍼로 바꿀 수 있게 한다.
 *   · 화면·입력 = VNC(desktop-rfb.js). 게스트에 아무것도 설치하지 않아도 된다.
 *   · 셸 = `lume ssh`(게스트 sshd). 앱 열기·클립보드 타이핑·osascript 가 이 길로 간다.
 *
 *  단위: **맥 한 대에 데스크톱 1대**(macOS 가 게스트 macOS 를 동시 2대까지만 허용). 워크스페이스는 여기에
 *  "연결"(폴더 공유)할 뿐이다. 공유 폴더는 VM 시작 시 고정되므로 연결이 바뀌면 재기동한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const runtime = require('./runtime');
const { RfbClient } = require('./desktop-rfb');

const VM_NAME = 'cpt-agent-desktop';
const IMAGE = 'macos-tahoe-vanilla:latest';
const VNC_PORT = 5951;                       // 고정 — 재시작해도 뷰어가 같은 곳을 본다
const MIN_HOST_GB = 32;                      // 이 아래 맥에서는 기능을 켜지 않는다(호스트가 숨 막힌다)
const BOOT_TIMEOUT_MS = 120000;
const SSH_USER = 'lume';
const SSH_PASSWORD = 'lume';                 // vanilla 이미지 기본 — 자체 이미지에서 바꾼다

let toolCache = null;
function lumeBin() {
  if (toolCache !== null) return toolCache;
  const cands = [
    process.env.CPT_LUME,
    path.join(runtime.stateDir(), 'bin', 'lume'),
    process.env.CPT_SIDECAR_DIR ? path.join(process.env.CPT_SIDECAR_DIR, 'lume') : null,
    '/opt/homebrew/bin/lume', '/usr/local/bin/lume',
  ].filter(Boolean);
  toolCache = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
  return toolCache;
}
function _resetTools() { toolCache = null; }

function settingsFile() { return path.join(runtime.stateDir(), 'desktop.json'); }
function loadSettings() {
  try { return { sharedDirs: [], ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch (_) { return { sharedDirs: [] }; }
}
function saveSettings(s) {
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function run(bin, args, o = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(bin, args, { timeout: o.timeoutMs || 30000, maxBuffer: 32 * 1024 * 1024, encoding: o.encoding || 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8' } },
      (err, stdout, stderr) => {
        if (err) { err.stderr = String(stderr || ''); err.stdout = String(stdout || ''); reject(err); return; }
        resolve(stdout);
      });
  });
}
const lume = (args, o) => run(lumeBin(), args, o);

function hostGB() { return Math.round(os.totalmem() / 1024 / 1024 / 1024); }
function defaultResources() {
  const total = hostGB();
  const memGB = Math.max(8, Math.min(16, Math.floor(total / 4)));
  const cpu = Math.max(4, Math.min(8, Math.floor(os.cpus().length / 2)));
  return { memGB, cpu };
}

/** `lume get -f json` — 없으면 null. 필드 이름은 Lume 0.5 기준(status/ipAddress/vncUrl/cpuCount/memorySize). */
let _infoCache = { at: 0, v: null, p: null };
const INFO_TTL_MS = 1500;   // 기기 목록 폴링(pane 여러 개)이 `lume get` 프로세스를 초당 몇 번씩 띄우지 않게
async function vmInfo(fresh) {
  if (!lumeBin()) return null;
  const now = Date.now();
  if (!fresh && _infoCache.p) return _infoCache.p;
  if (!fresh && now - _infoCache.at < INFO_TTL_MS) return _infoCache.v;
  const p = (async () => {
    try {
      const out = await lume(['get', VM_NAME, '-f', 'json'], { timeoutMs: 15000 });
      //  Lume 0.5.3 실측: 로그 줄 뒤에 **배열** `[ {…} ]` 로 온다(한 VM 이어도). 첫 '[' 또는 '{' 부터 파싱.
      const str = String(out);
      const i = Math.min(...['[', '{'].map((ch) => str.indexOf(ch)).filter((n) => n >= 0));
      if (!Number.isFinite(i)) return null;
      const j = JSON.parse(str.slice(i));
      return Array.isArray(j) ? (j[0] || null) : j;
    } catch (_) { return null; }
  })();
  _infoCache.p = p;
  const v = await p;
  _infoCache = { at: Date.now(), v, p: null };
  return v;
}
function invalidateInfo() { _infoCache = { at: 0, v: null, p: null }; }

// ── 상태 ─────────────────────────────────────────────────────────────────────
/**
 * 화면·cpt 가 보는 단일 상태. `phase`:
 *  unsupported(인텔/램 부족/맥 아님) · no-tool(lume 없음) · no-image(VM 없음) · stopped · starting · running
 */
async function status() {
  const s = loadSettings();
  const base = {
    vm: VM_NAME, hostGB: hostGB(), minHostGB: MIN_HOST_GB, sharedDirs: s.sharedDirs, ...defaultResources(),
    vnc: { port: VNC_PORT }, lume: lumeBin() || null,
  };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { ...base, phase: 'unsupported', reason: 'Apple 실리콘 Mac 에서만 쓸 수 있어요' };
  if (base.hostGB < MIN_HOST_GB) return { ...base, phase: 'unsupported', reason: `메모리 ${MIN_HOST_GB}GB 이상인 Mac 에서만 켤 수 있어요 (이 Mac: ${base.hostGB}GB)` };
  if (!lumeBin()) return { ...base, phase: 'no-tool', reason: 'VM 도구(lume)가 없어요' };
  const info = await vmInfo();
  if (!info) return { ...base, phase: 'no-image', reason: `데스크톱 이미지가 없어요 (${IMAGE}, 약 21GB)`, image: IMAGE };
  const running = /running/i.test(String(info.status || ''));
  return {
    ...base,
    phase: _starting ? 'starting' : (running ? 'running' : 'stopped'),
    os: info.os, ip: info.ipAddress || null, cpuCount: info.cpuCount, memorySize: info.memorySize, diskSize: info.diskSize,
    display: info.display, vncUrl: running ? (info.vncUrl || null) : null,
    screen: rfb && rfb.ready ? { width: rfb.width, height: rfb.height } : null,
    paused: !!agentPaused,
  };
}

// ── 수명주기 ───────────────────────────────────────────────────────────────
let _starting = null;   // Promise | null
let rfb = null;         // RfbClient | null
let vncPassword = '';
let agentPaused = false; // 사용자가 화면을 만지는 동안 에이전트 입력을 막는다

async function pull(onProgress) {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  //  21GB — 진행률은 stderr 로 온다. 부르는 쪽이 로그 줄을 그대로 화면에 흘린다.
  return new Promise((resolve, reject) => {
    const child = cp.spawn(lumeBin(), ['pull', IMAGE, VM_NAME], { env: { ...process.env, LANG: 'en_US.UTF-8' } });
    let tail = '';
    const onChunk = (d) => { const s = String(d); tail = (tail + s).slice(-4000); if (onProgress) onProgress(s); };
    child.stdout.on('data', onChunk); child.stderr.on('data', onChunk);
    child.on('exit', (code) => (code === 0 ? resolve({ ok: true }) : reject(new Error(`이미지 내려받기 실패(${code}): ${tail.slice(-400)}`))));
    child.on('error', reject);
  });
}

/** 켠다(이미 켜져 있으면 VNC 만 확인). 공유 폴더는 설정의 sharedDirs. */
async function start(o = {}) {
  if (_starting) return _starting;
  _starting = (async () => {
    const st = await status();
    if (st.phase === 'unsupported' || st.phase === 'no-tool' || st.phase === 'no-image') throw new Error(st.reason);
    if (st.phase !== 'running') {
      const s = loadSettings();
      const res = defaultResources();
      try { await lume(['set', VM_NAME, '--cpu', String(s.cpu || res.cpu), '--memory', `${s.memGB || res.memGB}GB`], { timeoutMs: 20000 }); } catch (_) { /* 켜진 채면 실패 — 무시 */ }
      vncPassword = crypto.randomBytes(6).toString('base64url').slice(0, 8);
      const args = ['run', VM_NAME, '--display', 'none', '--vnc-port', String(VNC_PORT), '--vnc-password', vncPassword];
      for (const d of (o.sharedDirs || s.sharedDirs || [])) args.push('--shared-dir', `${d}:rw`);
      //  ★ `--detach` 대신 우리가 **자기 세션으로** 떼어 띄운다(detached + unref). 실측(2026-09-17): 같은 프로세스 그룹에
      //   남은 VM 이 부모 셸 정리에 휩쓸려 5분 만에 소리 없이 죽었다. 데몬이 재시작해도 VM 은 tmux 처럼 살아 있어야 한다.
      fs.mkdirSync(runtime.stateDir(), { recursive: true });
      const logFd = fs.openSync(path.join(runtime.stateDir(), 'desktop-vm.log'), 'a');
      const child = cp.spawn(lumeBin(), args, { detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, LANG: 'en_US.UTF-8' } });
      child.on('error', () => { /* waitRunning 이 시간 초과로 알린다 */ });
      child.unref();
      fs.closeSync(logFd);
      invalidateInfo();
    }
    await waitRunning();
    await connectRfb();
  })();
  try { await _starting; } finally { _starting = null; }
  return status();     // _starting 을 비운 뒤에 읽어야 phase 가 'running' 으로 나온다
}

async function waitRunning() {
  const t0 = Date.now();
  for (;;) {
    const info = await vmInfo(true);
    if (info && /running/i.test(String(info.status || '')) && info.vncUrl) return info;
    if (Date.now() - t0 > BOOT_TIMEOUT_MS) throw new Error('데스크톱이 시간 안에 켜지지 않았어요');
    await sleep(700);
  }
}

/** vncUrl = vnc://:password@host:port — 우리가 준 비밀번호가 아니면(이미 켜져 있던 VM) URL 의 것을 쓴다. */
function parseVncUrl(u) {
  const m = /^vnc:\/\/(?:([^:@]*):)?([^@]*)@([^:]+):(\d+)/.exec(String(u || ''));
  if (!m) return null;
  return { password: decodeURIComponent(m[2] || ''), host: m[3], port: Number(m[4]) };
}

async function connectRfb() {
  if (rfb && rfb.ready && !rfb.closed) return rfb;
  const info = await vmInfo();
  const v = parseVncUrl(info && info.vncUrl) || { host: '127.0.0.1', port: VNC_PORT, password: vncPassword };
  const t0 = Date.now();
  for (;;) {
    try {
      const c = new RfbClient({ host: v.host === '0.0.0.0' ? '127.0.0.1' : v.host, port: v.port, password: v.password || vncPassword });
      await c.connect();
      c.on('close', () => { if (rfb === c) rfb = null; });
      c.on('error', () => { /* close 가 뒤따른다 */ });
      rfb = c;
      await c.requestUpdate(false, 4000);
      return c;
    } catch (e) {
      if (Date.now() - t0 > 30000) throw new Error(`데스크톱 화면(VNC)에 붙을 수 없어요: ${e.message}`);
      await sleep(600);
    }
  }
}

/**
 * 끈다 — 게스트 안에서 정상 종료(`lume shutdown` = ssh `shutdown -h now`) 를 먼저, 30초 안에 안 내려가면 VM 프로세스에
 *  SIGINT → SIGKILL. `lume stop` 은 쓰지 않는다: 우리가 자기 세션으로 떼어 띄운 VM 에 대해 아무 로그 없이 exit 130 으로
 *  죽고 VM 은 그대로 남았다(2026-09-17 실측, 원인 미상). 정상 종료가 되면 어차피 그쪽이 더 안전하다(디스크 일관성).
 */
async function stop() {
  if (rfb) { try { rfb.close(); } catch (_) { /* noop */ } rfb = null; }
  if (!lumeBin()) return { ok: true };
  const info = await vmInfo(true);
  if (!info || !/running/i.test(String(info.status || ''))) { invalidateInfo(); return { ok: true, already: true }; }
  try { await lume(['shutdown', VM_NAME, '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', '20'], { timeoutMs: 30000 }); } catch (_) { /* ssh 가 안 되면 아래 신호로 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const i = await vmInfo(true);
    if (!i || !/running/i.test(String(i.status || ''))) { invalidateInfo(); return { ok: true, graceful: true }; }
    await sleep(1000);
  }
  const pid = vmPid();
  if (pid) {
    try { process.kill(pid, 'SIGINT'); } catch (_) { /* noop */ }
    for (let i = 0; i < 10; i++) { await sleep(1000); if (!alive(pid)) { invalidateInfo(); return { ok: true, forced: 'SIGINT' }; } }
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* noop */ }
    await sleep(500);
  }
  invalidateInfo();
  return { ok: true, forced: 'SIGKILL' };
}
/** VM 프로세스 pid — Lume 이 VM 디렉터리에 남기는 owner 파일(실측 `.native-display-owner.json`), 없으면 pgrep. */
function vmPid() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lume', VM_NAME, '.native-display-owner.json'), 'utf8'));
    if (j && j.processIdentifier > 0 && alive(j.processIdentifier)) return j.processIdentifier;
  } catch (_) { /* noop */ }
  try {
    const out = cp.execFileSync('/usr/bin/pgrep', ['-f', `lume run ${VM_NAME}\\b`], { encoding: 'utf8' });
    const n = Number(String(out).trim().split('\n')[0]);
    return n > 0 ? n : 0;
  } catch (_) { return 0; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }

/** 게스트 셸. 문자열 한 줄로 받는다(lume ssh 가 원격 셸에 그대로 넘긴다). */
async function exec(cmd, o = {}) {
  if (!lumeBin()) throw new Error('VM 도구(lume)가 없어요');
  const out = await lume(['ssh', VM_NAME, '--user', SSH_USER, '--password', SSH_PASSWORD, '--timeout', String(Math.ceil((o.timeoutMs || 30000) / 1000)), String(cmd)],
    { timeoutMs: (o.timeoutMs || 30000) + 5000 });
  return String(out);
}

// ── 화면 ─────────────────────────────────────────────────────────────────────
async function frame(o = {}) {
  const c = await connectRfb();
  await c.requestUpdate(true, o.waitMs || 400);
  const bmp = c.toBmp(o.maxWidth);          // 여기서 이미 줄였다 — toJpeg 에는 원본 크기라고 말해 재축소를 막는다
  const { toJpeg } = require('./emulator');
  const img = await toJpeg(bmp.buf, 'bmp', bmp.width, o.quality, { w: bmp.width, h: bmp.height });
  return { mime: img.mime, base64: img.buf.toString('base64'), width: c.width, height: c.height, bytes: img.buf.length };
}

// ── 입력 ─────────────────────────────────────────────────────────────────────
const B_LEFT = 1, B_RIGHT = 4, B_WHEEL_UP = 8, B_WHEEL_DOWN = 16;
function px(n, max) { const v = Number(n); return Math.max(0, Math.min(max - 1, Math.round((Number.isFinite(v) ? v : 0) * max))); }

/**
 * 좌표는 0~1 정규화(모바일 화면과 같은 계약). 타입:
 *  touch(phase begin/move/end) · tap · longPress(=우클릭) · swipe(드래그) · scroll(dy 눈금) · key("cmd+c") · text
 *  `from` 이 'agent' 인 입력은 사용자가 화면을 만지는 동안(agentPaused) 거절한다 — 손 아래에서 커서가 튀는 게 제일 나쁘다.
 */
async function input(a = {}) {
  const c = await connectRfb();
  const type = String(a.type || '');
  if (a.from === 'agent' && agentPaused) throw new Error('사용자가 데스크톱을 조작하는 동안에는 에이전트 입력이 멈춰 있어요 (cpt desktop resume)');
  const X = px(a.x, c.width), Y = px(a.y, c.height);
  if (type === 'touch') {
    const ph = String(a.phase || '');
    if (ph === 'begin') c.pointer(X, Y, B_LEFT);
    else if (ph === 'move') c.pointer(X, Y, c.buttons);
    else if (ph === 'end' || ph === 'cancel') c.pointer(X, Y, 0);
    else throw new Error('알 수 없는 터치 단계예요');
    return { ok: true, via: 'vnc' };
  }
  if (type === 'move') { c.pointer(X, Y, 0); return { ok: true, via: 'vnc' }; }
  if (type === 'tap' || type === 'click') {
    const btn = String(a.button || '') === 'right' ? B_RIGHT : B_LEFT;
    const n = Math.max(1, Math.min(3, Number(a.count) || 1));
    c.pointer(X, Y, 0); await sleep(20);
    for (let i = 0; i < n; i++) { c.pointer(X, Y, btn); await sleep(40); c.pointer(X, Y, 0); if (i < n - 1) await sleep(60); }
    return { ok: true, via: 'vnc' };
  }
  if (type === 'longPress' || type === 'rightClick') {
    c.pointer(X, Y, 0); await sleep(20); c.pointer(X, Y, B_RIGHT); await sleep(60); c.pointer(X, Y, 0);
    return { ok: true, via: 'vnc' };
  }
  if (type === 'swipe' || type === 'drag') {
    const ms = Math.max(60, Math.min(3000, Number(a.durationMs) || 300));
    const steps = Math.max(3, Math.min(40, Math.round(ms / 16)));
    const X2 = px(a.x2, c.width), Y2 = px(a.y2, c.height);
    c.pointer(X, Y, 0); await sleep(20); c.pointer(X, Y, B_LEFT); await sleep(40);
    for (let i = 1; i <= steps; i++) { await sleep(ms / steps); c.pointer(X + (X2 - X) * i / steps, Y + (Y2 - Y) * i / steps, B_LEFT); }
    await sleep(30); c.pointer(X2, Y2, 0);
    return { ok: true, via: 'vnc' };
  }
  if (type === 'scroll') {
    const dy = Number(a.dy) || 0;
    const clicks = Math.max(1, Math.min(30, Math.round(Math.abs(dy)) || 1));
    const b = dy < 0 ? B_WHEEL_UP : B_WHEEL_DOWN;
    c.pointer(X, Y, 0);
    for (let i = 0; i < clicks; i++) { c.pointer(X, Y, b); c.pointer(X, Y, 0); await sleep(8); }
    return { ok: true, via: 'vnc' };
  }
  if (type === 'key') { await c.chord(String(a.key || '')); return { ok: true, via: 'vnc' }; }
  if (type === 'text') return typeText(String(a.text || ''), c);
  throw new Error(`알 수 없는 입력 종류예요: ${type}`);
}

/** 글자 입력. ASCII 는 키로 치고, 그 밖(한글 등)은 게스트 클립보드에 넣고 ⌘V — IME 조합에 기대지 않는다. */
async function typeText(text, c) {
  if (!text) return { ok: true };
  if (/^[\x20-\x7e\n]*$/.test(text)) { await c.typeAscii(text); return { ok: true, via: 'vnc' }; }
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  //  LANG 이 없는 ssh 세션에서 pbcopy 는 입력을 MacRoman 으로 읽어 한글이 깨진다(실측) — UTF-8 을 명시한다.
  await exec(`printf %s '${b64}' | base64 -d | LANG=en_US.UTF-8 pbcopy`, { timeoutMs: 15000 });
  await c.chord('cmd+v');
  return { ok: true, via: 'clipboard' };
}

// ── 앱·주소 ───────────────────────────────────────────────────────────────────
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
async function openApp(name) {
  if (!/^[\w .+-]{1,64}$/.test(String(name || ''))) throw new Error('앱 이름이 올바르지 않아요');
  await exec(`open -a ${shq(name)}`, { timeoutMs: 20000 });
  return { ok: true };
}
async function openUrl(url) {
  const u = String(url || '');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) throw new Error('주소가 올바르지 않아요');
  await exec(`open ${shq(guestUrl(u))}`, { timeoutMs: 20000 });
  return { ok: true, url: guestUrl(u) };
}
/** 호스트 localhost 는 게스트에서 NAT 게이트웨이(192.168.64.1)로 닿는다. */
function guestUrl(u) { return u.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i, '$1192.168.64.1'); }
/** 호스트 경로 → 게스트 공유 폴더 경로. 연결된 sharedDirs 중 하나 아래여야 한다. */
function guestPath(p) {
  const abs = path.resolve(String(p || ''));
  for (const d of loadSettings().sharedDirs) {
    const root = path.resolve(d);
    if (abs === root || abs.startsWith(root + path.sep)) return path.posix.join('/Volumes/My Shared Files', path.basename(root), path.relative(root, abs).split(path.sep).join('/'));
  }
  return null;
}

// ── 사용자 개입 ────────────────────────────────────────────────────────────────
let handoff = null; // {reason, at, resolve}
/** 에이전트가 "사용자가 대신 해 주세요"(로그인 등) — 카드가 뜨고, 사용자가 [계속] 을 누르면 풀린다. */
function requestHandoff(reason, o = {}) {
  if (handoff) handoff.resolve({ ok: false, superseded: true });
  agentPaused = true;
  return new Promise((resolve) => {
    handoff = { reason: String(reason || '사용자 조작이 필요해요'), at: Date.now(), resolve };
    if (o.timeoutMs) setTimeout(() => { if (handoff && handoff.resolve === resolve) { handoff = null; agentPaused = false; resolve({ ok: false, timeout: true }); } }, o.timeoutMs).unref();
  });
}
function resume() { agentPaused = false; if (handoff) { const h = handoff; handoff = null; h.resolve({ ok: true }); } return { ok: true }; }
function pause() { agentPaused = true; return { ok: true }; }
function pendingHandoff() { return handoff ? { reason: handoff.reason, at: handoff.at } : null; }

// ── 기기 목록에 끼워 넣기(모바일 화면 pane 재사용) ─────────────────────────────
const DEVICE_ID = 'desktop:main';
async function deviceRow() {
  if (process.platform !== 'darwin') return null;
  const st = await status();
  if (st.phase === 'unsupported' || st.phase === 'no-tool') return null;
  const running = st.phase === 'running';
  return {
    id: DEVICE_ID, kind: 'desktop', name: '에이전트 데스크톱', state: running ? 'booted' : 'shutdown', physical: false,
    desktop: { phase: st.phase, reason: st.reason || '', paused: st.paused, handoff: pendingHandoff() },
    caps: { frame: running, input: running, keys: [], inputHint: running ? '' : (st.reason || '데스크톱이 꺼져 있어요') },
  };
}

/** RPC — `desktop.*` 와, emulator.js 가 `desktop:` id 로 넘겨 주는 frame/input/openUrl. */
async function handle(method, p = {}) {
  const m = String(method);
  if (m === 'desktop.status') return { ...(await status()), handoff: pendingHandoff() };
  if (m === 'desktop.pull') return pull();
  if (m === 'desktop.start') return start(p);
  if (m === 'desktop.stop') return stop();
  if (m === 'desktop.exec') return { out: await exec(String(p.cmd || ''), { timeoutMs: p.timeoutMs }) };
  if (m === 'desktop.frame') return frame(p);
  if (m === 'desktop.input') return input(p);
  if (m === 'desktop.openApp') return openApp(p.name);
  if (m === 'desktop.openUrl') return openUrl(p.url);
  if (m === 'desktop.path') return { host: p.path, guest: guestPath(p.path) };
  if (m === 'desktop.handoff') return requestHandoff(p.reason, { timeoutMs: p.timeoutMs });
  if (m === 'desktop.resume') return resume();
  if (m === 'desktop.pause') return pause();
  if (m === 'desktop.settings.get') return loadSettings();
  if (m === 'desktop.settings.set') { const s = { ...loadSettings(), ...p }; saveSettings(s); return s; }
  throw new Error(`알 수 없는 메서드: ${m}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  handle, status, start, stop, exec, frame, input, openApp, openUrl, guestUrl, guestPath, deviceRow, DEVICE_ID, VM_NAME, IMAGE,
  requestHandoff, resume, pause, pendingHandoff, loadSettings, saveSettings, _resetTools, lumeBin,
};
