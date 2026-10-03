/**
 * vm-agent.js — 에이전트 PC(VM) **안에서** 에이전트를 돌리는 층 (2026-10-04).
 *
 * 왜: 에이전트가 화면을 클릭하고 실행·테스트·QA 까지 하되 호스트의 키보드·마우스·화면은 뺏지 않게 —
 *  VM 을 "보이지 않는 두 번째 컴퓨터"로 쓰고 그 안에서 에이전트가 산다(사용자 확정).
 *
 * 구조(실측 2026-10-04, Linux 게스트):
 *  · 통로 = 진짜 ssh + 전용 키(`~/.codingpt/vm/id_ed25519`). `lume ssh` 는 한 번 실행·타임아웃 방식이라
 *    stream-json 을 계속 주고받는 채팅 엔진을 못 태운다. 키는 `desktop.exec`(lume ssh)로 한 번 심는다.
 *  · 로그인 = 사용자가 VM 안에서 **직접 한 번**(`claude auth login` — VM 디스크에 남아 다음부터는 묻지 않는다).
 *    ★ 호스트의 자격증명·토큰을 읽거나 VM 으로 옮기지 않는다(데몬 CLAUDE.md 절대 규칙). 우리는 로그인 **여부**만 묻는다.
 *  · 워크스페이스 = git 사본. 호스트 저장소 → 게스트 `~/work/<이름>` 으로 push(`host/<브랜치>`),
 *    에이전트는 `vm/<브랜치>` 에서 일하고, 호스트가 그 브랜치를 fetch 해 검토·머지한다. 공유 폴더가 아니라
 *    VM 재시작이 필요 없고 빌드 산출물이 호스트 폴더에 섞이지 않는다.
 *  · 호스트 쪽 자리 = `~/.codingpt/vm/<os>/ws/<이름>/` + 표식 `.cpt-vm.json`. 이 폴더가 보통 워크스페이스로
 *    등록되고, 채팅 엔진(conv.js)과 터미널(zsh shim)은 표식을 보고 VM 안으로 들어간다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const runtime = require('./runtime');

const MARK = '.cpt-vm.json';
const SSH_USER = 'lume';
const GUEST_PATH = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
const INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';

const desktop = () => require('./desktop');
const osk = (v) => (v === 'linux' ? 'linux' : 'macos');
function vmRoot() { return path.join(runtime.stateDir(), 'vm'); }
function keyFile() { return path.join(vmRoot(), 'id_ed25519'); }
function enterFile() { return path.join(vmRoot(), 'enter.sh'); }
function wsDir(o, name) { return path.join(vmRoot(), osk(o), 'ws', name); }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function coded(code, msg) { return Object.assign(new Error(msg), { code }); }
function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'workspace'; }

function run(bin, args, o = {}) {
  return new Promise((resolve, reject) => {
    const p = cp.execFile(bin, args, { encoding: 'utf8', timeout: o.timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024, env: o.env || process.env, cwd: o.cwd },
      (err, stdout, stderr) => (err ? reject(Object.assign(new Error(String(stderr || err.message).trim().slice(-600)), { code: 'VM_CMD_FAILED' })) : resolve(String(stdout))));
    if (o.input != null) { try { p.stdin.end(String(o.input)); } catch (_) { /* noop */ } }
  });
}

function ensureKey() {
  const k = keyFile();
  if (fs.existsSync(k)) return k;
  fs.mkdirSync(vmRoot(), { recursive: true, mode: 0o700 });
  cp.execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'codingpt-vm', '-f', k]);
  return k;
}
function sshOpts() {
  return ['-i', ensureKey(), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
}

/** 켜져 있는 VM 의 IP. start=true 면 꺼져 있을 때 켠다(수십 초). */
async function ipOf(o, { start = false } = {}) {
  let st = await desktop().handle('desktop.status', { os: osk(o) });
  if (st.phase !== 'running' && start) {
    if (st.phase !== 'starting') await desktop().handle('desktop.start', { os: osk(o) });
    for (let i = 0; i < 120 && st.phase !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      st = await desktop().handle('desktop.status', { os: osk(o) });
      if (st.phase === 'stopped' && st.reason) throw coded('VM_START_FAILED', st.reason);
    }
  }
  if (st.phase !== 'running') throw coded('VM_OFF', '에이전트 PC 가 꺼져 있어요');
  for (let i = 0; i < 20 && !st.ip; i++) { await new Promise((r) => setTimeout(r, 1500)); st = await desktop().handle('desktop.status', { os: osk(o) }); }
  if (!st.ip) throw coded('VM_NO_IP', '에이전트 PC 의 주소를 아직 알 수 없어요');
  return st.ip;
}

const keyed = new Set(); // 이 데몬 수명 동안 키 로그인이 확인된 `<os>@<ip>`
async function ensureKeyLogin(o, ip) {
  const tag = `${osk(o)}@${ip}`;
  if (keyed.has(tag)) return;
  try { await run('/usr/bin/ssh', [...sshOpts(), '-o', 'BatchMode=yes', `${SSH_USER}@${ip}`, 'true'], { timeoutMs: 15000 }); keyed.add(tag); return; } catch (_) { /* 아래에서 심는다 */ }
  const pub = fs.readFileSync(keyFile() + '.pub', 'utf8').trim();
  await desktop().handle('desktop.exec', { os: osk(o), timeoutMs: 20000,
    cmd: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qF ${shq(pub)} ~/.ssh/authorized_keys 2>/dev/null || echo ${shq(pub)} >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys` });
  await run('/usr/bin/ssh', [...sshOpts(), '-o', 'BatchMode=yes', `${SSH_USER}@${ip}`, 'true'], { timeoutMs: 15000 });
  keyed.add(tag);
}

/** 게스트 셸에서 한 번 실행(출력 반환). */
async function sh(o, cmd, opt = {}) {
  const ip = await ipOf(o, { start: !!opt.start });
  await ensureKeyLogin(o, ip);
  return run('/usr/bin/ssh', [...sshOpts(), `${SSH_USER}@${ip}`, `${GUEST_PATH}; ${cmd}`], { timeoutMs: opt.timeoutMs || 30000, input: opt.input });
}

// ── 로그인 여부(자격증명은 만지지 않는다 — CLI 에게 묻기만) ────────────────────
async function loggedIn(o) {
  try { const out = await sh(o, 'claude auth status 2>/dev/null || true', { timeoutMs: 20000 }); return /"loggedIn"\s*:\s*true/.test(out); } catch (_) { return false; }
}

// ── 준비(키·CLI·git) — 분 단위라 뒤에서 돌리고 status 로 본다 ─────────────────
const jobs = { macos: null, linux: null }; // { running, step, error }
async function cliVersion(o) {
  try { const out = await sh(o, 'claude --version 2>/dev/null || true', { timeoutMs: 15000 }); const m = /(\d+\.\d+\.\d+)/.exec(out); return m ? m[1] : null; } catch (_) { return null; }
}
function setup(o) {
  const k = osk(o);
  if (jobs[k] && jobs[k].running) return jobs[k];
  const job = jobs[k] = { running: true, step: 'boot', error: null };
  (async () => {
    await ipOf(k, { start: true });
    job.step = 'key'; await sh(k, 'true');
    job.step = 'cli';
    if (!(await cliVersion(k))) {
      await sh(k, `${INSTALL_CMD} >/tmp/cpt-claude-install.log 2>&1`, { timeoutMs: 10 * 60000 });
      if (!(await cliVersion(k))) throw coded('CLI_INSTALL_FAILED', '에이전트 CLI 를 설치하지 못했어요');
    }
    job.step = 'git';
    await sh(k, 'command -v git >/dev/null || (command -v apt-get >/dev/null && sudo -n apt-get install -y git >/dev/null 2>&1) || true', { timeoutMs: 5 * 60000 });
    job.step = 'done';
  })().catch((e) => { job.error = String((e && e.message) || e); }).finally(() => { job.running = false; });
  return job;
}

// ── 워크스페이스(git 사본) ───────────────────────────────────────────────────
function readMark(dir) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8')); return j && j.guest ? { ...j, dir } : null; } catch (_) { return null; } }
/** abs 가 VM 워크스페이스 자리(또는 그 하위)면 표식을, 아니면 null. */
function markerOf(abs) {
  const root = vmRoot() + path.sep;
  let d = path.resolve(String(abs || ''));
  if (!d.startsWith(root)) return null;
  for (let i = 0; i < 8 && d.startsWith(root); i++) { const m = readMark(d); if (m) return m; d = path.dirname(d); }
  return null;
}
function listWs(o) {
  const base = path.join(vmRoot(), osk(o), 'ws');
  let names = [];
  try { names = fs.readdirSync(base); } catch (_) { names = []; }
  return names.map((n) => readMark(path.join(base, n))).filter(Boolean);
}
async function gitEnv(ip) {
  let base = null;
  try { base = await require('./task-git').baseTools(); } catch (_) { base = null; }
  const env = { ...((base && base.env) || process.env) };
  env.GIT_SSH_COMMAND = ['/usr/bin/ssh', ...sshOpts()].map((a) => (/\s/.test(a) ? shq(a) : a)).join(' ');
  env.GIT_TERMINAL_PROMPT = '0';
  return { env, git: (base && base.git && base.git.path) || 'git', remote: (guest) => `${SSH_USER}@${ip}:${guest}` };
}
async function addWs(o, hostPath) {
  const k = osk(o);
  const raw = String(hostPath || '');
  const src = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(os.homedir(), raw); // 워크스페이스 경로는 홈 상대일 수 있다
  const ip = await ipOf(k, { start: true });
  await ensureKeyLogin(k, ip);
  const g = await gitEnv(ip);
  let top = '';
  try { top = (await run(g.git, ['-C', src, 'rev-parse', '--show-toplevel'], { env: g.env })).trim(); } catch (_) { throw coded('NOT_GIT', 'git 저장소가 아니에요 — VM 으로 가져가려면 git 저장소여야 해요'); }
  const branch = (await run(g.git, ['-C', top, 'rev-parse', '--abbrev-ref', 'HEAD'], { env: g.env })).trim().replace(/^HEAD$/, 'main');
  const name = safeName(path.basename(top));
  const guest = `work/${name}`;
  await sh(k, `mkdir -p ~/${guest} && cd ~/${guest} && { [ -d .git ] || git init -q -b _cpt; }`, { timeoutMs: 30000 });
  await run(g.git, ['-C', top, 'push', '-q', '--force', g.remote(guest), `HEAD:refs/heads/host/${branch}`], { env: g.env, timeoutMs: 20 * 60000 });
  const who = async (key, dflt) => { try { return (await run(g.git, ['-C', top, 'config', key], { env: g.env })).trim() || dflt; } catch (_) { return dflt; } };
  const [un, ue] = [await who('user.name', 'CodingPT Agent'), await who('user.email', 'agent@codingpt.local')];
  await sh(k, `cd ~/${guest} && git config user.name ${shq(un)} && git config user.email ${shq(ue)} && { git rev-parse -q --verify ${shq('vm/' + branch)} >/dev/null || git checkout -q -B ${shq('vm/' + branch)} ${shq('host/' + branch)}; }`, { timeoutMs: 120000 });
  const dir = wsDir(k, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARK), JSON.stringify({ os: k, name, guest, source: top, branch, createdAt: new Date().toISOString() }, null, 2));
  ensureEnterScript();
  return { ok: true, dir, name, guest, branch: 'vm/' + branch };
}
/** push = 호스트의 지금 커밋을 게스트 `host/<브랜치>` 로(에이전트가 가져다 쓴다). pull = 게스트의 작업 브랜치를 호스트 저장소로. */
async function syncWs(o, name, dirn) {
  const k = osk(o);
  const m = readMark(wsDir(k, safeName(name)));
  if (!m) throw coded('NOT_FOUND', '그 VM 워크스페이스가 없어요');
  const ip = await ipOf(k, { start: true });
  await ensureKeyLogin(k, ip);
  const g = await gitEnv(ip);
  if (dirn === 'push') {
    await run(g.git, ['-C', m.source, 'push', '-q', '--force', g.remote(m.guest), `HEAD:refs/heads/host/${m.branch}`], { env: g.env, timeoutMs: 20 * 60000 });
    return { ok: true, branch: 'host/' + m.branch };
  }
  const local = `vm/${k}/${m.branch}`;
  await run(g.git, ['-C', m.source, 'fetch', '-q', g.remote(m.guest), `+refs/heads/vm/${m.branch}:refs/heads/${local}`], { env: g.env, timeoutMs: 20 * 60000 });
  const ahead = (await run(g.git, ['-C', m.source, 'rev-list', '--count', `HEAD..${local}`], { env: g.env })).trim();
  return { ok: true, branch: local, ahead: Number(ahead) || 0 };
}
function removeWs(o, name) {
  const dir = wsDir(o, safeName(name));
  if (!readMark(dir)) throw coded('NOT_FOUND', '그 VM 워크스페이스가 없어요');
  fs.rmSync(dir, { recursive: true, force: true }); // 게스트 사본은 남긴다(되돌릴 수 있게) — VM 안에서 지운다
  return { ok: true };
}

// ── 채팅 엔진·터미널 진입 ────────────────────────────────────────────────────
/** 채팅 엔진이 VM 안의 CLI 를 띄울 좌표 — `ssh … 'cd <작업 폴더> && exec claude <인자>'`. 꺼져 있으면 켠다. */
async function spawnSpec(mark, args) {
  const ip = await ipOf(mark.os, { start: true });
  await ensureKeyLogin(mark.os, ip);
  const remote = `${GUEST_PATH}; cd ~/${mark.guest} && exec claude ${args.map(shq).join(' ')}`;
  return { bin: '/usr/bin/ssh', args: [...sshOpts(), `${SSH_USER}@${ip}`, remote], cwd: os.homedir() };
}
/** 터미널이 VM 자리에서 열리면 zsh shim 이 부르는 스크립트 — VM 을 켜고 그 작업 폴더로 ssh 한다. */
function ensureEnterScript() {
  const cpt = path.join(runtime.stateDir(), 'bin', 'cpt');
  const body = `#!/bin/sh
# CodingPT — VM 워크스페이스 터미널 진입(vm-agent.js 가 만든다. 고치지 말 것)
dir="$1"; mark="$dir/${MARK}"; [ -f "$mark" ] || exit 0
val() { /usr/bin/sed -n "s/.*\\"$1\\": *\\"\\([^\\"]*\\)\\".*/\\1/p" "$mark" | /usr/bin/head -1; }
os=$(val os); guest=$(val guest)
echo "에이전트 PC($os) 에 연결하는 중…"
${shq(cpt)} desktop --os "$os" start >/dev/null 2>&1
ip=$(${shq(cpt)} --json desktop --os "$os" status 2>/dev/null | /usr/bin/sed -n 's/.*"ip": *"\\([0-9.]*\\)".*/\\1/p' | /usr/bin/head -1)
[ -n "$ip" ] || { echo "에이전트 PC 의 주소를 알 수 없어요 — 사이드바에서 VM 을 켠 뒤 터미널을 다시 열어 주세요"; exit 1; }
exec /usr/bin/ssh -t ${sshOpts().map((a) => shq(a)).join(' ')} ${SSH_USER}@"$ip" "cd ~/$guest 2>/dev/null; exec \\$SHELL -l"
`;
  try {
    fs.mkdirSync(vmRoot(), { recursive: true, mode: 0o700 });
    let cur = ''; try { cur = fs.readFileSync(enterFile(), 'utf8'); } catch (_) { cur = ''; }
    if (cur !== body) fs.writeFileSync(enterFile(), body, { mode: 0o755 });
  } catch (_) { /* 무해 */ }
  return enterFile();
}
/** zsh shim 꼬리 — VM 자리에서 연 셸이면 한 번 VM 으로 들어간다(나오면 호스트 셸로 돌아온다). */
function zshTail() {
  return `if [ -z "$CPT_VM_IN" ] && [ -f "$PWD/${MARK}" ] && [ -x ${shq(enterFile())} ]; then CPT_VM_IN=1 ${shq(enterFile())} "$PWD"; fi`;
}

async function status(o) {
  const k = osk(o);
  const st = await desktop().handle('desktop.status', { os: k });
  const running = st.phase === 'running';
  return {
    os: k, phase: st.phase, cli: running ? await cliVersion(k) : null, loggedIn: running ? await loggedIn(k) : null,
    job: jobs[k] ? { ...jobs[k] } : null,
    workspaces: listWs(k).map((m) => ({ name: m.name, dir: m.dir, guest: m.guest, source: m.source, branch: 'vm/' + m.branch })),
  };
}

async function handle(method, p = {}) {
  const m = String(method);
  if (m === 'desktop.agent.status') return status(p.os);
  if (m === 'desktop.agent.setup') { setup(p.os); return status(p.os); }
  if (m === 'desktop.agent.ws.add') return addWs(p.os, p.path);
  if (m === 'desktop.agent.ws.sync') return syncWs(p.os, p.name, p.dir === 'push' ? 'push' : 'pull');
  if (m === 'desktop.agent.ws.remove') return removeWs(p.os, p.name);
  throw coded('BAD_REQUEST', `알 수 없는 명령: ${m}`);
}

module.exports = { handle, status, setup, markerOf, spawnSpec, sh, addWs, syncWs, listWs, loggedIn, zshTail, ensureEnterScript, vmRoot, MARK };
