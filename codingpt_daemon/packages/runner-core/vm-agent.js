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
const net = require('net');
const crypto = require('crypto');
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
    if (o.input != null) { try { p.stdin.end(Buffer.isBuffer(o.input) ? o.input : String(o.input)); } catch (_) { /* noop */ } }
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

// ── 화면 통로(호스트 데몬 → VM 안 에이전트) ───────────────────────────────────
// macOS 게스트는 ssh 세션에서 화면을 못 찍는다(실측 2026-10-04: `screencapture` = "could not create image from display",
//  화면 기록 권한이 ssh 에 없다). 호스트 데몬은 이미 VNC 로 그 화면을 찍고 조작한다 → 그 능력만 **제한된 소켓**으로 빌려준다.
//  ★ cpt.sock 을 통째로 넘기지 않는다 — VM 안 에이전트가 호스트의 터미널·파일을 건드릴 수 있게 된다. 이 소켓은
//   "자기 VM 의 화면 보기·입력" 여섯 가지만 받는다. ssh -R 로 게스트의 세션 전용 경로에 붙는다.
const screenSrv = {}; const lastShot = {};
function screenSockPath(o) { return path.join(vmRoot(), `screen-${osk(o)}.sock`); }
async function screenReq(k, line) {
  let q = null; try { q = JSON.parse(line); } catch (_) { return { ok: false, error: 'bad request' }; }
  const d = desktop(); const cmd = String(q.cmd || '');
  const norm = (v, max) => (max > 0 ? Math.max(0, Math.min(1, Number(v) / max)) : 0);
  try {
    if (cmd === 'shot') {
      const f = await d.handle('desktop.frame', { os: k, maxWidth: 1440, quality: 70 });
      // 좌표는 "보낸 그림의 픽셀" 로 받는다 — 그림 크기를 기억해 뒀다가 0~1 로 바꾼다.
      const w = Math.min(1440, f.width || 1440); lastShot[k] = { w, h: Math.round((f.height || 0) * (w / (f.width || w))) };
      return { ok: true, mime: f.mime, base64: f.base64, width: lastShot[k].w, height: lastShot[k].h };
    }
    const sz = lastShot[k] || { w: 1440, h: 900 };
    const xy = { x: norm(q.x, sz.w), y: norm(q.y, sz.h) };
    if (cmd === 'click') return { ok: true, ...(await d.handle('desktop.input', { os: k, type: 'tap', ...xy, button: q.right ? 'right' : 'left', count: q.count, from: 'agent' })) };
    if (cmd === 'scroll') return { ok: true, ...(await d.handle('desktop.input', { os: k, type: 'scroll', ...xy, dy: Number(q.dy) || 3, from: 'agent' })) };
    if (cmd === 'type') return { ok: true, ...(await d.handle('desktop.input', { os: k, type: 'text', text: String(q.text || '').slice(0, 4000), from: 'agent' })) };
    if (cmd === 'key') return { ok: true, ...(await d.handle('desktop.input', { os: k, type: 'key', key: String(q.key || '').slice(0, 60), from: 'agent' })) };
    if (cmd === 'ax') return { ok: true, tree: await d.handle('desktop.ax', { os: k, app: q.app ? String(q.app).slice(0, 80) : undefined }) };
    if (cmd === 'tap') return { ok: true, ...(await d.handle('desktop.tap', { os: k, text: String(q.text || '').slice(0, 200), app: q.app ? String(q.app).slice(0, 80) : undefined, from: 'agent' })) };
    return { ok: false, error: 'unknown command' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
}
function ensureScreenServer(o) {
  const k = osk(o); const sock = screenSockPath(k);
  if (screenSrv[k]) return sock;
  try { fs.mkdirSync(vmRoot(), { recursive: true, mode: 0o700 }); fs.unlinkSync(sock); } catch (_) { /* 없으면 그만 */ }
  // 게스트 쪽은 curl --unix-socket 으로 부른다(nc 는 응답을 기다리지 않고 끊는다 — 실측). 그래서 한 줄 HTTP.
  const srv = require('http').createServer((req, res) => {
    let buf = '';
    req.on('data', (dch) => { buf += dch; if (buf.length > 65536) req.destroy(); });
    req.on('end', () => {
      screenReq(k, buf).then((r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r) + '\n'); });
    });
  });
  srv.on('error', () => { screenSrv[k] = null; });
  srv.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch (_) { /* noop */ } });
  screenSrv[k] = srv;
  return sock;
}
/** 이 ssh 세션에 화면 통로를 붙이는 인자(-R)와 게스트 쪽 경로. macOS 게스트만(리눅스는 게스트 안 도구로 충분). */
function screenForward(o) {
  if (osk(o) !== 'macos') return { args: [], env: '' };
  const guestSock = `/tmp/cpt-screen-${crypto.randomBytes(5).toString('hex')}.sock`;
  return { args: ['-R', `${guestSock}:${ensureScreenServer(o)}`], env: `export CPT_SCREEN_SOCK=${guestSock}; ` };
}

// ── VM 안 에이전트의 화면 도구·안내문 ────────────────────────────────────────
// 에이전트는 VM **안에서** 돌기 때문에 호스트의 `cpt desktop` 을 못 쓴다 → 자기 화면을 보고 조작하는 작은 스크립트를 게스트에 둔다.
//  Linux = xdotool·xfce4-screenshooter·AT-SPI(desktop-atspi.py), macOS = screencapture·osascript(JXA CGEvent).
const SCREEN_TOOL = `#!/bin/sh
# cpt-screen — 이 컴퓨터(에이전트 PC)의 화면을 보고 조작한다. CodingPT 가 설치한다(고치지 말 것).
cmd="$1"; [ $# -gt 0 ] && shift
if [ "$(uname)" = Darwin ]; then
  # 맥 게스트는 ssh 세션에서 화면을 못 찍는다 — 호스트가 붙여 준 화면 통로(CPT_SCREEN_SOCK)로 본다·조작한다.
  [ -S "$CPT_SCREEN_SOCK" ] || { [ "$cmd" = open ] || { echo "화면 통로가 없어요 — CodingPT 가 연 터미널·채팅에서 실행하세요"; exit 1; }; }
  esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | tr '\\n' ' '; }
  req() { /usr/bin/curl -s --max-time 60 --unix-socket "$CPT_SCREEN_SOCK" -X POST --data-binary "$1" http://cpt/; }
  case "$cmd" in
    shot) f="\${1:-/tmp/cpt-shot.jpg}"; req '{"cmd":"shot"}' | sed -n 's/.*"base64":"\\([^"]*\\)".*/\\1/p' | /usr/bin/base64 --decode > "$f" && [ -s "$f" ] && echo "$f" ;;
    ax) req "{\\"cmd\\":\\"ax\\",\\"app\\":\\"$(esc "$1")\\"}" ;;
    tap) req "{\\"cmd\\":\\"tap\\",\\"text\\":\\"$(esc "$*")\\"}" ;;
    click) req "{\\"cmd\\":\\"click\\",\\"x\\":$1,\\"y\\":$2}" ;;
    scroll) req "{\\"cmd\\":\\"scroll\\",\\"x\\":$1,\\"y\\":$2,\\"dy\\":\${3:-3}}" ;;
    type) req "{\\"cmd\\":\\"type\\",\\"text\\":\\"$(esc "$*")\\"}" ;;
    key) req "{\\"cmd\\":\\"key\\",\\"key\\":\\"$(esc "$1")\\"}" ;;
    open) /usr/bin/open "$@" ;;
    *) echo "사용법: cpt-screen shot [파일] | ax [앱] | tap <글자> | click <x> <y> | scroll <x> <y> [dy] | type <글자> | key <조합 예: cmd+space> | open <앱·URL·파일>"; exit 2 ;;
  esac
else
  export DISPLAY=\${DISPLAY:-:0} XAUTHORITY=\${XAUTHORITY:-$HOME/.Xauthority}
  [ -n "$DBUS_SESSION_BUS_ADDRESS" ] || export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  case "$cmd" in
    shot) f="\${1:-/tmp/cpt-shot.png}"; rm -f "$f"; xfce4-screenshooter -f -s "$f" >/dev/null 2>&1 && echo "$f" ;;
    ax) [ -f "$HOME/.cpt/atspi.py" ] && GTK_MODULES=gail:atk-bridge python3 "$HOME/.cpt/atspi.py" "$@" || echo "접근성 트리를 읽을 수 없어요 — shot 으로 화면을 보세요" ;;
    click) xdotool mousemove "$1" "$2" click 1 ;;
    type) xdotool type --delay 20 -- "$*" ;;
    key) xdotool key -- "$@" ;;
    open) (setsid xdg-open "$@" >/dev/null 2>&1 &) ;;
    *) echo "사용법: cpt-screen shot [파일] | ax [앱] | click <x> <y> | type <글자> | key <조합 예: ctrl+l Return> | open <URL·파일>"; exit 2 ;;
  esac
fi
`;
const GUEST_GUIDE_MARK = '<!-- cpt-vm-guide -->';
const GUEST_GUIDE = `${GUEST_GUIDE_MARK}
# 이 컴퓨터에 대해 (CodingPT 에이전트 PC)

너는 사용자의 맥 안에 있는 **전용 가상 컴퓨터(VM)** 에서 돌고 있다. 이 컴퓨터는 통째로 네 것이다 — 사용자의 키보드·마우스·화면과 분리돼 있으니 마음껏 실행하고 설치하고 화면을 조작해도 된다(sudo 가능).

- 작업 폴더는 \`~/work/<이름>\` — 사용자의 저장소를 git 으로 가져온 사본이다. \`vm/<브랜치>\` 브랜치에서 일하고, **끝나면 커밋해라**(사용자는 커밋된 것만 가져간다). 사용자의 최신 코드는 \`host/<브랜치>\` 에 온다(필요하면 merge).
- 실제로 실행해서 확인해라: 의존성 설치 → 서버·앱 실행 → 브라우저로 열어 보고 → 화면으로 검증.
- 화면 보기·조작: \`cpt-screen shot\`(스크린샷 파일 경로를 출력 — 그 파일을 읽어서 본다), \`cpt-screen click <x> <y>\`, \`cpt-screen type <글자>\`, \`cpt-screen key <키>\`, \`cpt-screen open <URL·앱>\`. 좌표는 스크린샷 픽셀 기준.
- 사용자가 직접 해야 하는 일(외부 서비스 로그인·2단계 인증)은 멈추고 무엇이 필요한지 말해라.
`;
/** 화면 도구(~/.local/bin/cpt-screen)와 안내문(~/.claude/CLAUDE.md 의 우리 구역)을 게스트에 둔다. 표준입력으로만 보낸다. */
async function pushGuestTools(o) {
  await sh(o, 'mkdir -p ~/.local/bin && cat > ~/.local/bin/cpt-screen && chmod +x ~/.local/bin/cpt-screen', { input: SCREEN_TOOL, timeoutMs: 20000 });
  if (osk(o) === 'linux') {
    const py = fs.readFileSync(path.join(__dirname, 'desktop-atspi.py'), 'utf8');
    await sh(o, 'mkdir -p ~/.cpt && cat > ~/.cpt/atspi.py', { input: py, timeoutMs: 20000 }).catch(() => {});
  }
  // 사용자가 VM 안에서 직접 쓴 CLAUDE.md 는 건드리지 않는다 — 우리 표식이 없을 때만 뒤에 덧붙인다.
  await sh(o, `mkdir -p ~/.claude && { grep -qF ${shq(GUEST_GUIDE_MARK)} ~/.claude/CLAUDE.md 2>/dev/null || cat >> ~/.claude/CLAUDE.md; }`, { input: '\n' + GUEST_GUIDE, timeoutMs: 20000 });
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
    if (k === 'macos') await prepareMac(k);
    job.step = 'tools'; await pushGuestTools(k);
    job.step = 'done';
  })().catch((e) => { job.error = String((e && e.message) || e); }).finally(() => { job.running = false; });
  return job;
}

/**
 * macOS 게스트 준비 — ① 이 VM 은 통째로 에이전트의 것이라 sudo 를 암호 없이(게스트 안에서만) ② git 이 없다
 *  (명령줄 개발 도구 미설치 — 실측 2026-10-04: `git` 이 설치 대화상자만 띄운다) → 명령줄 도구를 조용히 설치.
 *  암호는 표준입력으로만 넘긴다. 설치는 수 분(약 700MB).
 */
async function prepareMac(k) {
  const pw = String(desktop().GUEST_PASSWORD || '') + '\n';
  await sh(k, `sudo -S -p "" sh -c 'echo "${SSH_USER} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/cpt-agent && chmod 440 /etc/sudoers.d/cpt-agent'`, { input: pw, timeoutMs: 20000 });
  const has = await sh(k, 'xcode-select -p >/dev/null 2>&1 && echo yes || echo no', { timeoutMs: 15000 });
  if (/yes/.test(has)) return;
  // 설치는 게스트 안에서 **분리 실행**한다(ssh 가 끊겨도 계속) — 스크립트 파일로 두고 nohup, 끝났는지는 xcode-select 로 본다.
  const script = `#!/bin/sh
pkill -f "Install Command Line Developer Tools" 2>/dev/null
f=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress; touch $f
L=$(softwareupdate -l 2>/dev/null | sed -n 's/^.*Label: \\(Command Line Tools.*\\)$/\\1/p' | tail -1)
[ -n "$L" ] && sudo -n softwareupdate -i "$L" --agree-to-license
rm -f $f
`;
  await sh(k, 'cat > /tmp/cpt-clt.sh && chmod +x /tmp/cpt-clt.sh && { [ -f /tmp/cpt-clt.pid ] && kill -0 "$(cat /tmp/cpt-clt.pid)" 2>/dev/null || { nohup /tmp/cpt-clt.sh >/tmp/cpt-clt-install.log 2>&1 & echo $! > /tmp/cpt-clt.pid; }; }', { input: script, timeoutMs: 30000 });
  for (let i = 0; i < 180; i++) { // 최대 30분
    await new Promise((r) => setTimeout(r, 10000));
    const ok = await sh(k, 'xcode-select -p >/dev/null 2>&1 && echo yes || { kill -0 "$(cat /tmp/cpt-clt.pid 2>/dev/null)" 2>/dev/null && echo wait || echo dead; }', { timeoutMs: 15000 }).catch(() => 'wait');
    if (/yes/.test(ok)) return;
    if (/dead/.test(ok)) throw coded('CLT_INSTALL_FAILED', '개발 도구(git)를 설치하지 못했어요 — VM 화면에서 직접 설치해 주세요');
  }
  throw coded('CLT_INSTALL_FAILED', '개발 도구 설치가 너무 오래 걸려요');
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
/** 가져올 저장소 목록 — 폴더 자체가 저장소면 그것 하나(sub ''), 아니면 바로 아래의 저장소들(여러 저장소를 담은 폴더). */
async function findRepos(g, src) {
  const top = await run(g.git, ['-C', src, 'rev-parse', '--show-toplevel'], { env: g.env }).then((x) => x.trim()).catch(() => '');
  let real = src; try { real = fs.realpathSync(src); } catch (_) { real = src; }
  if (top && (top === src || top === real)) return [''];
  const subs = [];
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(src, d.name, '.git'))) subs.push(d.name);
  }
  if (!subs.length) throw coded('NOT_GIT', 'git 저장소가 아니에요 — VM 으로 가져가려면 폴더(또는 바로 아래 폴더)가 git 저장소여야 해요');
  return subs;
}
async function branchOf(g, dir) {
  return (await run(g.git, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { env: g.env })).trim().replace(/^HEAD$/, 'main');
}
async function addWs(o, hostPath) {
  const k = osk(o);
  const raw = String(hostPath || '');
  const src = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(os.homedir(), raw); // 워크스페이스 경로는 홈 상대일 수 있다
  const ip = await ipOf(k, { start: true });
  await ensureKeyLogin(k, ip);
  const g = await gitEnv(ip);
  const subs = await findRepos(g, src);
  const name = safeName(path.basename(src));
  const guest = `work/${name}`;
  await sh(k, `mkdir -p ~/${guest}`, { timeoutMs: 30000 });
  // 저장소 밖의 낱개 파일(루트의 CLAUDE.md·scripts 등) — 여러 저장소를 담은 폴더일 때만. 저장소·의존성 폴더는 뺀다.
  if (subs[0] !== '') {
    const ex = [...subs.map((x) => `./${x}`), 'node_modules', '.git', 'Pods', 'build', 'dist', 'target', '.gradle', 'DerivedData'].flatMap((x) => ['--exclude', x]);
    await new Promise((resolve, reject) => {
      const tar = cp.spawn('/usr/bin/tar', ['-C', src, ...ex, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const ssh = cp.spawn('/usr/bin/ssh', [...sshOpts(), `${SSH_USER}@${ip}`, `tar -C ~/${guest} -xf - 2>/dev/null; true`], { stdio: ['pipe', 'ignore', 'ignore'] });
      tar.stdout.pipe(ssh.stdin);
      const t = setTimeout(() => { try { tar.kill(); ssh.kill(); } catch (_) { /* noop */ } reject(coded('VM_CMD_FAILED', '파일 복사가 너무 오래 걸려요')); }, 10 * 60000);
      ssh.on('close', () => { clearTimeout(t); resolve(); });
      ssh.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }
  const repos = [];
  for (const sub of subs) {
    const dir = sub ? path.join(src, sub) : src;
    const gdir = sub ? `${guest}/${sub}` : guest;
    const branch = await branchOf(g, dir);
    await sh(k, `mkdir -p ~/${gdir} && cd ~/${gdir} && { git rev-parse --git-dir >/dev/null 2>&1 || { rm -rf .git; git init -q -b _cpt; }; }`, { timeoutMs: 30000 });
    const push = () => run(g.git, ['-C', dir, 'push', '-q', '--force', g.remote(gdir), `HEAD:refs/heads/host/${branch}`], { env: g.env, timeoutMs: 20 * 60000 });
    // 게스트 저장소가 깨져 있으면(갑자기 꺼진 VM — 객체 유실) 받지 못한다 → 저장소를 새로 만들고 한 번 더.
    //  ⚠ 게스트에만 있던 커밋은 사라진다 — 그래서 깨졌을 때(push 거부)만 한다.
    await push().catch(async () => { await sh(k, `cd ~/${gdir} && rm -rf .git && git init -q -b _cpt`, { timeoutMs: 60000 }); await push(); });
    const who = async (key, dflt) => { try { return (await run(g.git, ['-C', dir, 'config', key], { env: g.env })).trim() || dflt; } catch (_) { return dflt; } };
    const [un, ue] = [await who('user.name', 'CodingPT Agent'), await who('user.email', 'agent@codingpt.local')];
    await sh(k, `cd ~/${gdir} && git config user.name ${shq(un)} && git config user.email ${shq(ue)} && { git rev-parse -q --verify ${shq('vm/' + branch)} >/dev/null || git checkout -q -f -B ${shq('vm/' + branch)} ${shq('host/' + branch)}; }`, { timeoutMs: 180000 });
    repos.push({ sub, branch });
  }
  await sh(k, 'sync', { timeoutMs: 60000 }).catch(() => {}); // 디스크에 내려쓴다 — VM 이 갑자기 꺼져도 방금 가져온 저장소가 깨지지 않게
  const dir = wsDir(k, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MARK), JSON.stringify({ os: k, name, guest, source: src, branch: repos[0].branch, repos, createdAt: new Date().toISOString() }, null, 2));
  ensureEnterScript();
  return { ok: true, dir, name, guest, branch: 'vm/' + repos[0].branch, repos: repos.length };
}
/** push = 호스트의 지금 커밋을 게스트 `host/<브랜치>` 로(에이전트가 가져다 쓴다). pull = 게스트의 작업 브랜치를 호스트 저장소로. */
async function syncWs(o, name, dirn) {
  const k = osk(o);
  const m = readMark(wsDir(k, safeName(name)));
  if (!m) throw coded('NOT_FOUND', '그 VM 워크스페이스가 없어요');
  const ip = await ipOf(k, { start: true });
  await ensureKeyLogin(k, ip);
  const g = await gitEnv(ip);
  const repos = Array.isArray(m.repos) && m.repos.length ? m.repos : [{ sub: '', branch: m.branch }];
  let ahead = 0; const names = [];
  for (const r of repos) {
    const dir = r.sub ? path.join(m.source, r.sub) : m.source;
    const gdir = r.sub ? `${m.guest}/${r.sub}` : m.guest;
    if (dirn === 'push') {
      await run(g.git, ['-C', dir, 'push', '-q', '--force', g.remote(gdir), `HEAD:refs/heads/host/${r.branch}`], { env: g.env, timeoutMs: 20 * 60000 });
      names.push('host/' + r.branch);
      continue;
    }
    const local = `vm/${k}/${r.branch}`;
    await run(g.git, ['-C', dir, 'fetch', '-q', g.remote(gdir), `+refs/heads/vm/${r.branch}:refs/heads/${local}`], { env: g.env, timeoutMs: 20 * 60000 });
    ahead += Number((await run(g.git, ['-C', dir, 'rev-list', '--count', `HEAD..${local}`], { env: g.env })).trim()) || 0;
    names.push(local);
  }
  return { ok: true, branch: [...new Set(names)].join(', '), ahead };
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
  const fw = screenForward(mark.os);
  const remote = `${GUEST_PATH}; ${fw.env}cd ~/${mark.guest} && exec claude ${args.map(shq).join(' ')}`;
  return { bin: '/usr/bin/ssh', args: [...sshOpts(), ...fw.args, `${SSH_USER}@${ip}`, remote], cwd: os.homedir() };
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
getip() { ${shq(cpt)} desktop --json --os "$os" status 2>/dev/null | /usr/bin/sed -n 's/.*"ip": *"\\([0-9.]*\\)".*/\\1/p' | /usr/bin/head -1; }
ip=$(getip)
# 꺼져 있을 때만 켠다(켜진 VM 에 start 를 다시 보내지 않는다).
[ -n "$ip" ] || { ${shq(cpt)} desktop --os "$os" start >/dev/null 2>&1; ip=$(getip); }
[ -n "$ip" ] || { echo "에이전트 PC 의 주소를 알 수 없어요 — 사이드바에서 VM 을 켠 뒤 터미널을 다시 열어 주세요"; exit 1; }
# 맥 게스트는 화면 통로(호스트 데몬의 제한 소켓)를 이 세션에 붙인다 — cpt-screen 이 쓴다.
fw=""; envs=""
if [ "$os" = macos ] && [ -S ${shq(screenSockPath('macos'))} ]; then gs="/tmp/cpt-screen-$$.sock"; fw="-R $gs:${screenSockPath('macos')}"; envs="export CPT_SCREEN_SOCK=$gs; "; fi
exec /usr/bin/ssh -t ${sshOpts().map((a) => shq(a)).join(' ')} $fw ${SSH_USER}@"$ip" "\${envs}cd ~/$guest 2>/dev/null; exec \\$SHELL -l"
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

// ── VM 워크스페이스의 파일(fs.* 를 게스트로) ─────────────────────────────────
// 호스트 쪽 자리 폴더는 비어 있다 — 파일 트리·열기·저장은 게스트 `~/work/<이름>` 을 봐야 한다. fs.js 가 자리 안의 경로면
//  여기로 넘긴다(폰의 릴레이 fs.* 와 PC 의 `desktop.agent.fs` 가 같은 길).
const FS_PRUNE = ['node_modules', '.git', 'Pods', 'build', 'dist', 'target', '.next', '.gradle', 'DerivedData', '.venv', '__pycache__'];
const FS_TREE_MAX = 4000, FS_READ_MAX = 2 * 1024 * 1024, FS_B64_MAX = 6 * 1024 * 1024;
const TEXT_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|so|dylib|a|o|bin|exe|woff2?|ttf|otf|mp[34]|mov|wav|keystore|jks)$/i;
/** 자리 안의 절대경로 → 게스트 경로(`~` 기준 상대). 표식 파일 자체는 대상이 아니다. */
function guestOf(mark, abs) {
  const rel = path.relative(mark.dir, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) throw coded('BAD_REQUEST', '허용되지 않은 경로입니다');
  return rel ? `${mark.guest}/${rel}` : mark.guest;
}
async function fsHandle(method, params, mark, abs, relOf) {
  const o = mark.os;
  const gp = guestOf(mark, abs);
  const q = shq(gp);
  const hostRel = (sub) => relOf(sub ? path.join(abs, sub) : abs);
  if (method === 'fs.tree' || method === 'fs.list') {
    const flat = method === 'fs.tree';
    const prune = FS_PRUNE.map((n) => `-name ${shq(n)}`).join(' -o ');
    const cmd = flat
      ? `cd ~/${q} && find . \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${FS_TREE_MAX + 1}`
      : `cd ~/${q} && ls -1Ap 2>/dev/null`;
    const lines = (await sh(o, cmd, { timeoutMs: 30000, start: true })).split('\n').map((l) => l.replace(/^\.\//, '')).filter((l) => l && l !== MARK);
    if (flat) return { root: params.path || '', items: lines.slice(0, FS_TREE_MAX).map((l) => ({ path: l, text: !TEXT_RE.test(l) })), truncated: lines.length > FS_TREE_MAX };
    const items = lines.map((l) => { const dir = l.endsWith('/'); const name = dir ? l.slice(0, -1) : l; return { name, path: hostRel(name), dir, text: !dir && !TEXT_RE.test(name) }; })
      .filter((it) => !(it.dir && FS_PRUNE.includes(it.name)));
    items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    return { root: hostRel(''), items };
  }
  if (method === 'fs.read') {
    const max = params.base64 ? FS_B64_MAX : FS_READ_MAX;
    const out = await sh(o, `f=~/${q}; [ -d "$f" ] && { echo DIR; exit 0; }; n=$(wc -c < "$f") || exit 1; echo "$n"; [ "$n" -le ${max} ] && base64 < "$f" | tr -d '\\n'`, { timeoutMs: 30000, start: true });
    const nl = out.indexOf('\n');
    const head = (nl < 0 ? out : out.slice(0, nl)).trim();
    if (head === 'DIR') throw new Error('디렉토리는 열 수 없습니다.');
    const size = Number(head) || 0;
    if (size > max) return { path: hostRel(''), tooLarge: true, size };
    const b64 = nl < 0 ? '' : out.slice(nl + 1).trim();
    if (params.base64) return { path: hostRel(''), base64: b64, size };
    const buf = Buffer.from(b64, 'base64');
    if (buf.includes(0)) return { path: hostRel(''), binary: true, size };
    return { path: hostRel(''), content: buf.toString('utf8'), size };
  }
  if (method === 'fs.write') {
    if (typeof params.content !== 'string') throw new Error('content 가 필요합니다.');
    const buf = params.base64 ? Buffer.from(params.content, 'base64') : Buffer.from(params.content, 'utf8');
    if (buf.length > FS_B64_MAX) throw new Error('파일이 너무 큽니다(6MB 제한)');
    const home = (await sh(o, 'printf %s "$HOME"', { timeoutMs: 15000, start: true })).trim();
    await sh(o, `f=~/${q}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: buf, timeoutMs: 60000 });
    // absPath = **게스트의** 절대경로 — 채팅 첨부가 이 경로를 VM 안 에이전트에게 넘긴다.
    return { path: hostRel(''), absPath: `${home}/${gp}`, size: buf.length };
  }
  if (method === 'fs.grep') {
    const query = String(params.query || '');
    if (!query.trim()) return { matches: [], truncated: false };
    const ex = FS_PRUNE.map((n) => `--exclude-dir=${shq(n)}`).join(' ');
    const out = await sh(o, `cd ~/${q} && grep -rInFi ${ex} -- ${shq(query)} . 2>/dev/null | head -n 301`, { timeoutMs: 30000, start: true }).catch(() => '');
    const rows = out.split('\n').filter(Boolean).map((l) => /^\.\/(.+?):(\d+):(.*)$/.exec(l)).filter(Boolean);
    return { matches: rows.slice(0, 300).map((m) => ({ path: m[1], line: Number(m[2]), col: 1, text: m[3].slice(0, 300) })), truncated: rows.length > 300 };
  }
  if (method === 'fs.mkdir') { await sh(o, `mkdir -p ~/${q}`, { start: true }); return { path: hostRel('') }; }
  if (method === 'fs.createFile') { await sh(o, `f=~/${q}; [ -e "$f" ] && exit 3; mkdir -p "$(dirname "$f")" && : > "$f"`, { start: true }); return { path: hostRel('') }; }
  if (method === 'fs.rename') {
    const to = require('./fs').safeResolve(params.dest || '');
    await sh(o, `mv -n ~/${q} ~/${shq(guestOf(mark, to))}`, { start: true });
    return { path: relOf(to) };
  }
  if (method === 'fs.delete') {
    if (gp === mark.guest) throw coded('BAD_REQUEST', '워크스페이스 폴더 자체는 지울 수 없어요');
    await sh(o, `rm -rf ~/${q}`, { start: true });
    return { path: hostRel(''), deleted: true };
  }
  throw new Error('알 수 없는 메서드: ' + method);
}

async function status(o) {
  const k = osk(o);
  if (k === 'macos') { try { ensureScreenServer(k); } catch (_) { /* noop */ } }
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
  if (m === 'desktop.agent.fs') return require('./fs').handle(String(p.method || ''), p.params || {}); // PC 가 VM 워크스페이스 파일을 볼 때(자리 경로 → fs.js 가 여기로 되돌린다)
  if (m === 'desktop.agent.ws.add') return addWs(p.os, p.path);
  if (m === 'desktop.agent.ws.sync') return syncWs(p.os, p.name, p.dir === 'push' ? 'push' : 'pull');
  if (m === 'desktop.agent.ws.remove') return removeWs(p.os, p.name);
  throw coded('BAD_REQUEST', `알 수 없는 명령: ${m}`);
}

module.exports = { ensureScreenServer, screenReq, prepareMac, fsHandle, pushGuestTools, handle, status, setup, markerOf, spawnSpec, sh, addWs, syncWs, listWs, loggedIn, zshTail, ensureEnterScript, vmRoot, MARK };
