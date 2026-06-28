/**
 * 사용자별 샌드박스 컨테이너 관리 (M3-full Phase 2)
 *
 * 에이전트의 Bash 실행을 **사용자별 격리 컨테이너** 안에서 돌린다(arbitrary code 실행 격리).
 * 워커(오케스트레이터)가 docker.sock 으로 사용자당 long-lived 컨테이너를 ensure/exec/정리.
 *
 * 격리:
 *  - 이미지 = 워커/백엔드 이미지 재사용(전 언어 런타임 포함). `sleep infinity` 로 유지.
 *  - cgroup: Memory / NanoCpus / PidsLimit 하드 한도.
 *  - 볼륨 subpath: 공유 볼륨에서 **해당 사용자 하위 트리만** 마운트(타 사용자 파일 격리).
 *    워커와 동일 경로(/workspace/cpt-agent/<userId>)에 마운트 → cwd 변환 불필요.
 *  - 네트워크: 기본 none(egress 차단). AGENT_SANDBOX_NETWORK 로 조정.
 *  - idle TTL: 마지막 사용 후 일정 시간 지나면 stop/remove.
 *
 * 단일 워커(replica=1) 전제 — 세션 Map 이 프로세스 메모리.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
let Docker = null;

// 셸 인자 안전 따옴표(single-quote escape)
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
try { Docker = require('dockerode'); } catch (_) { /* 미설치 환경 폴백 */ }

const ENABLED = process.env.AGENT_SANDBOX_ENABLED === '1' && !!Docker;
const IMAGE = process.env.AGENT_SANDBOX_IMAGE || 'codingpt_service-agent-worker';
const VOLUME = process.env.AGENT_SANDBOX_VOLUME || 'codingpt_service_cpt_agent_workspace';
const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT || os.tmpdir();
const NETWORK = process.env.AGENT_SANDBOX_NETWORK || 'none';
const EGRESS_PROXY = process.env.AGENT_EGRESS_PROXY || ''; // 설정 시 샌드박스 egress 를 이 프록시로만
const MEM_BYTES = parseInt(process.env.AGENT_SANDBOX_MEM_MB || '512', 10) * 1024 * 1024;
const NANO_CPUS = Math.round(parseFloat(process.env.AGENT_SANDBOX_CPUS || '0.5') * 1e9);
const PIDS_LIMIT = parseInt(process.env.AGENT_SANDBOX_PIDS || '256', 10);
const IDLE_TTL_MS = parseInt(process.env.AGENT_SANDBOX_IDLE_MS || '600000', 10); // 10분
const EXEC_TIMEOUT_MS = parseInt(process.env.AGENT_SANDBOX_EXEC_MS || '120000', 10); // 2분
const MAX_SANDBOXES = parseInt(process.env.AGENT_SANDBOX_MAX || '20', 10); // 동시 컨테이너 상한

const docker = Docker ? new Docker() : null;

// userId → { container, name, lastUsed }
const sessions = new Map();

function isEnabled() {
  return ENABLED;
}

function safeUid(userId) {
  return String(userId == null ? 'anon' : userId).replace(/[^A-Za-z0-9_-]/g, '') || 'anon';
}

function containerName(uid) {
  return `cpt-sandbox-${uid}`;
}

// 사용자 워크스페이스 하위경로 (subpath 마운트 기준 + 워커 fs 경로). uid 입력은 항상 정규화.
function userSubpath(uid) {
  return path.posix.join('cpt-agent', safeUid(uid));
}
function userWorkspaceDir(uid) {
  return path.join(WORKSPACE_ROOT, 'cpt-agent', safeUid(uid));
}

// 사용자별 생성 in-flight 프로미스 — 동시 호출(터미널 WS 재연결 등)이 각자 createContainer 를 때려
// "(409) container name already in use" 가 나는 레이스를 막는다. 같은 uid 의 동시 ensure 는 1개만 실행.
const ensuring = new Map(); // uid -> Promise<container>

/**
 * 사용자 샌드박스 컨테이너 확보(없으면 생성, 멈춰있으면 시작). 동일 사용자는 재사용.
 * 동시 호출은 in-flight 프로미스로 합쳐 createContainer 경쟁(409)을 방지한다.
 * @returns {Promise<import('dockerode').Container>}
 */
async function ensureSandbox(userId) {
  if (!ENABLED) throw new Error('샌드박스가 비활성화되어 있습니다.');
  const uid = safeUid(userId);
  const inflight = ensuring.get(uid);
  if (inflight) return inflight;
  const p = _ensureSandboxInner(uid);
  ensuring.set(uid, p);
  try { return await p; } finally { ensuring.delete(uid); }
}

async function _ensureSandboxInner(uid) {

  // 캐시된 세션이 살아있으면 재사용
  const cached = sessions.get(uid);
  if (cached) {
    try {
      const info = await cached.container.inspect();
      if (info.State && info.State.Running) {
        cached.lastUsed = Date.now();
        return cached.container;
      }
    } catch (_) {
      sessions.delete(uid); // 사라졌으면 재생성
    }
  }

  // 동시 컨테이너 상한 — 초과 시 가장 오래 안 쓴 샌드박스 1개 제거(LRU eviction)
  if (sessions.size >= MAX_SANDBOXES) {
    let lruUid = null;
    let lruAt = Infinity;
    for (const [u, s] of sessions.entries()) {
      if (s.lastUsed < lruAt) { lruAt = s.lastUsed; lruUid = u; }
    }
    if (lruUid && lruUid !== uid) {
      const ev = sessions.get(lruUid);
      sessions.delete(lruUid);
      try { await ev.container.remove({ force: true }); } catch (_) { /* noop */ }
    }
  }

  // subpath 마운트는 볼륨 내 해당 경로가 존재해야 함 → 워커가 먼저 생성(공유 볼륨)
  fs.mkdirSync(userWorkspaceDir(uid), { recursive: true });

  const name = containerName(uid);
  let container = docker.getContainer(name);
  let exists = true;
  try {
    await container.inspect();
  } catch (_) {
    exists = false;
  }

  if (!exists) {
    container = await docker.createContainer({
      name,
      Image: IMAGE,
      Cmd: ['sleep', 'infinity'],
      Tty: false,
      WorkingDir: userWorkspaceDir(uid),
      Labels: { 'cpt.role': 'agent-sandbox', 'cpt.userId': uid },
      HostConfig: {
        Memory: MEM_BYTES,
        NanoCpus: NANO_CPUS,
        PidsLimit: PIDS_LIMIT,
        NetworkMode: NETWORK,
        // 권한 강화(네트워크 무관): 모든 Linux capability 제거 + 권한 상승 차단.
        // npm/node/python 등 일반 코드 실행엔 영향 없음.
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        // 공유 볼륨에서 사용자 하위 트리만, 워커와 동일 경로에 마운트
        Mounts: [
          {
            Type: 'volume',
            Source: VOLUME,
            Target: userWorkspaceDir(uid),
            VolumeOptions: { Subpath: userSubpath(uid) },
          },
        ],
      },
    });
  }

  const info = await container.inspect();
  if (!info.State || !info.State.Running) {
    await container.start();
  }

  sessions.set(uid, { container, name, lastUsed: Date.now() });
  return container;
}

/**
 * 샌드박스 안에서 bash 명령 실행. stdout/stderr 를 합쳐 반환(+ exitCode).
 * @param {string|number} userId
 * @param {string} command
 * @param {object} [opts] { cwd, onData }
 * @returns {Promise<{ exitCode:number, output:string, timedOut:boolean }>}
 */
async function execBash(userId, command, opts = {}) {
  const uid = safeUid(userId);
  const container = await ensureSandbox(uid);
  const cwd = opts.cwd || userWorkspaceDir(uid);

  // egress 프록시가 설정되면 모든 패키지 매니저/도구가 그걸 통해서만 나가도록 표준 프록시 env 주입
  const proxyEnv = EGRESS_PROXY
    ? [
        `HTTP_PROXY=${EGRESS_PROXY}`, `HTTPS_PROXY=${EGRESS_PROXY}`,
        `http_proxy=${EGRESS_PROXY}`, `https_proxy=${EGRESS_PROXY}`,
        'NO_PROXY=localhost,127.0.0.1', 'no_proxy=localhost,127.0.0.1',
      ]
    : [];

  const exec = await container.exec({
    Cmd: ['bash', '-lc', command],
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
    Env: ['HOME=/root', 'CI=1', ...proxyEnv],
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  let output = '';
  let timedOut = false;
  const collector = {
    write: (chunk) => {
      const s = chunk.toString();
      output += s;
      if (opts.onData) { try { opts.onData(s); } catch (_) { /* noop */ } }
    },
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try { stream.destroy(); } catch (_) { /* noop */ }
    }, EXEC_TIMEOUT_MS);

    // 멀티플렉스(stdout/stderr) 디먹스 → 하나의 output 으로
    container.modem.demuxStream(stream, collector, collector);

    stream.on('end', async () => {
      clearTimeout(timer);
      let exitCode = timedOut ? 124 : 0;
      try {
        const ins = await exec.inspect();
        if (typeof ins.ExitCode === 'number') exitCode = ins.ExitCode;
      } catch (_) { /* noop */ }
      if (timedOut) output += `\n⏱️ 실행 시간(${EXEC_TIMEOUT_MS / 1000}s)을 초과해 중단되었습니다.\n`;
      const s = sessions.get(uid);
      if (s) s.lastUsed = Date.now();
      resolve({ exitCode, output, timedOut });
    });
    stream.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : -1, output, timedOut });
    });
  });
}

// ── 인터랙티브 PTY 터미널 ──────────────────────────────────────────────
// 실제 셸(TTY): 키 입력(stdin)과 raw 출력(ANSI/readline/탭완성)을 양방향. 워커의 WS 종단에서 사용.
// 단일 raw 듀플렉스(데먹스 X). EXEC_TIMEOUT 미적용 — 장수명, idle 스위퍼가 정리.
// userId → Set<stream> : 활성 터미널이 있으면 idle 스위퍼가 컨테이너를 지우지 않게 함.
const terminals = new Map();
function _trackTerm(uid, stream) {
  let set = terminals.get(uid);
  if (!set) { set = new Set(); terminals.set(uid, set); }
  set.add(stream);
  const drop = () => { try { set.delete(stream); } catch (_) { /* noop */ } if (!set.size) terminals.delete(uid); };
  stream.on('close', drop); stream.on('end', drop); stream.on('error', drop);
}

/**
 * 인터랙티브 PTY 셸 열기. TTY 모드라 stdout/stderr 가 합쳐진 단일 raw 듀플렉스.
 * 호출자가 stream.write(키입력), stream.on('data')(출력), exec.resize({h,w}).
 * @returns {Promise<{ exec:any, stream:import('stream').Duplex }>}
 */
async function openPty(userId, opts = {}) {
  const uid = safeUid(userId);
  const container = await ensureSandbox(uid);
  const cwd = opts.cwd || userWorkspaceDir(uid);
  const proxyEnv = EGRESS_PROXY
    ? [
        `HTTP_PROXY=${EGRESS_PROXY}`, `HTTPS_PROXY=${EGRESS_PROXY}`,
        `http_proxy=${EGRESS_PROXY}`, `https_proxy=${EGRESS_PROXY}`,
        'NO_PROXY=localhost,127.0.0.1', 'no_proxy=localhost,127.0.0.1',
      ]
    : [];
  // tmux 백킹 — Docker exec attach 가 유휴 ~80초에 끊겨도 컨테이너 안 tmux 세션(셸/실행중 프로세스)은 유지.
  // 재접속(attach) 시 같은 세션('cpt')에 다시 붙어 cwd·npm run dev 등이 그대로 복귀한다. tmux 미설치 시 bash 폴백.
  const startCmd = `cd ${JSON.stringify(cwd)} 2>/dev/null; if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s cpt -n shell; else exec bash -l; fi`;
  const exec = await container.exec({
    Cmd: ['bash', '-lc', startCmd],
    WorkingDir: cwd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ['HOME=/root', 'TERM=xterm-256color', ...proxyEnv],
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  if (opts.cols && opts.rows) { try { await exec.resize({ h: opts.rows, w: opts.cols }); } catch (_) { /* noop */ } }
  const s = sessions.get(uid); if (s) s.lastUsed = Date.now();
  // 출력이 흐르는 동안 컨테이너 활성 유지(스위퍼는 활성 터미널 set 으로도 보호).
  stream.on('data', () => { const ss = sessions.get(uid); if (ss) ss.lastUsed = Date.now(); });
  _trackTerm(uid, stream);
  return { exec, stream };
}

// ── 멀티 터미널 = tmux 윈도우 ──────────────────────────────────────────
// 세션 'cpt' 안의 tmux window 들이 곧 "터미널 탭". WebView 는 단일 PTY 로 'cpt' 에 attach 하고,
// 활성 윈도우를 따라간다. 탭 전환/생성/종료는 (PTY 와 무관한) execBash 로 tmux 명령을 날려
// tmux 서버 상태를 바꾸면, attach 중인 클라이언트가 즉시 그 윈도우로 리렌더된다.
const TMUX = 'cpt';

/** 세션 'cpt' 보장(없으면 detached 로 생성). 항상 윈도우 0=셸. */
async function ensureTmuxSession(uid, dir) {
  await execBash(
    uid,
    `command -v tmux >/dev/null 2>&1 || exit 0; `
    + `tmux has-session -t ${TMUX} 2>/dev/null || tmux new-session -d -s ${TMUX} -n shell -c ${shq(dir)}; true`,
  );
}

/** 윈도우(탭) 목록 — index/name/active/실행중 명령/pid. tmux 없으면 빈 배열.
 *  cwd: 세션이 아직 없을 때 윈도우 0 을 만들 디렉토리(프로젝트 dir). 미지정 시 워크스페이스 루트. */
async function listWindows(userId, cwd) {
  const uid = safeUid(userId);
  await ensureSandbox(uid);
  await ensureTmuxSession(uid, cwd || userWorkspaceDir(uid));
  const out = await execBash(
    uid,
    `command -v tmux >/dev/null 2>&1 && tmux list-windows -t ${TMUX} `
    + `-F '#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}|#{pane_pid}' 2>/dev/null || true`,
  );
  return (out.output || out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [index, name, active, command, pid] = l.split('|');
      return {
        index: Number(index),
        name: name || `win${index}`,
        active: active === '1',
        command: command || '',
        pid: Number(pid) || null,
      };
    });
}

/** 새 윈도우(탭) 생성 → 새 index 반환. select=true 면 그 윈도우로 전환. */
async function newWindow(userId, { name = 'shell', cwd, select = true } = {}) {
  const uid = safeUid(userId);
  await ensureSandbox(uid);
  const dir = cwd || userWorkspaceDir(uid);
  await ensureTmuxSession(uid, dir);
  const out = await execBash(
    uid,
    `command -v tmux >/dev/null 2>&1 || { echo NA; exit 0; }; `
    + `tmux new-window -t ${TMUX} -P -F '#{window_index}' -n ${shq(name)} -c ${shq(dir)}`,
  );
  const m = (out.output || '').match(/\d+/);
  const idx = m ? Number(m[0]) : null;
  if (select && idx != null) await selectWindow(uid, idx);
  return idx;
}

/** 윈도우(탭) 전환 — attach 중인 WebView 가 즉시 그 윈도우를 보여준다. */
async function selectWindow(userId, index) {
  await execBash(
    safeUid(userId),
    `command -v tmux >/dev/null 2>&1 && tmux select-window -t ${TMUX}:${Number(index)} 2>/dev/null; true`,
  );
}

/** 현재 윈도우 화면 + 스크롤백 비우기(IDE "지우기").
 *  포그라운드가 셸일 때만 C-l 을 보낸다 — vite 등 앱이 돌면 C-l 이 그 앱에 ^L 로 에코되므로(셸 프롬프트 없음).
 *  셸: C-l(화면 clear, 프롬프트 재그리기) + clear-history(스크롤백) → 전환 후에도 깨끗.
 *  앱: clear-history 만(앱 화면은 앱이 소유 → 키 안 보냄). */
async function clearActiveWindow(userId) {
  await execBash(
    safeUid(userId),
    `command -v tmux >/dev/null 2>&1 || exit 0; `
    + `tmux send-keys -t ${TMUX} -X cancel 2>/dev/null; `
    + `cmd=$(tmux display-message -p -t ${TMUX} '#{pane_current_command}' 2>/dev/null); `
    + `case "$cmd" in bash|sh|zsh|dash|-bash|-sh|-zsh|ash) tmux send-keys -t ${TMUX} C-l 2>/dev/null;; esac; `
    + `tmux clear-history -t ${TMUX} 2>/dev/null; true`,
  );
}

/** 윈도우(탭) 종료. 그 안에서 돌던 프로세스도 함께 종료된다(마지막 윈도우면 셸 하나는 남긴다). */
async function killWindow(userId, index) {
  const uid = safeUid(userId);
  const wins = await listWindows(uid);
  if (wins.length <= 1) {
    // 마지막 1개는 죽이지 않고 셸로 리셋(빈 세션 방지) — 윈도우 안 프로세스만 Ctrl-C.
    await execBash(uid, `command -v tmux >/dev/null 2>&1 && tmux send-keys -t ${TMUX}:${Number(index)} C-c 2>/dev/null; true`);
    return;
  }
  await execBash(uid, `command -v tmux >/dev/null 2>&1 && tmux kill-window -t ${TMUX}:${Number(index)} 2>/dev/null; true`);
}

/**
 * 샌드박스 안 LISTEN 중인 TCP 포트 감지(/proc/net/tcp(6) 파싱, procps 불필요).
 * 1024 초과만(시스템 포트 제외). 수동으로 띄운 서버까지 감지 → 미리보기/탭 매핑.
 */
async function detectListeningPorts(userId) {
  // LISTEN 중인 모든 포트(>1024). 사용자가 직접 띄운 서버(localhost 바인딩 포함)까지 다 보여준다 —
  //   "무엇이 실행 중인지" 가시성이 목적. 단 Docker 내부 DNS(127.0.0.11)·우리 포워더 포트는 노이즈라 제외.
  //   ipv4 local_address = 'IIIIIIII:PPPP'(IP little-endian hex). 127.0.0.11 = '0B00007F'.
  const script =
    "for f in /proc/net/tcp /proc/net/tcp6; do [ -f \"$f\" ] || continue; "
    + "awk 'NR>1 && $4==\"0A\" {split($2,a,\":\"); if (a[1]!=\"0B00007F\") print a[2]}' \"$f\"; done | sort -u";
  const r = await execBash(userId, script);
  const uid = safeUid(userId);
  const fwd = portForwarders.get(uid);
  const exposed = fwd ? new Set([...fwd.values()].map((v) => v.exposed)) : new Set();
  const ports = (r.output || '')
    .split('\n')
    .map((h) => parseInt(h.trim(), 16))
    .filter((p) => Number.isFinite(p) && p > 1024 && p < 65536 && !exposed.has(p));
  return [...new Set(ports)].sort((a, b) => a - b);
}

// ── 포트 포워더 ───────────────────────────────────────────────────────
// localhost(127.0.0.1) 에만 바인딩된 서버(예: --host 없는 vite)는 컨테이너 간 도달 불가.
// 0.0.0.0 에 바인딩되는 작은 node TCP 포워더를 띄워 127.0.0.1:port 로 중계 → 워커가 프록시할 수 있게.
//   uid → Map(targetPort → { exposed, startedAt })
const portForwarders = new Map();
function _exposedPortFor(port) {
  // 결정론적이고 충돌 적은 노출 포트.
  return port + 20000 <= 64000 ? port + 20000 : port - 20000;
}
/** port(127.0.0.1) 를 0.0.0.0:exposed 로 노출하는 포워더 보장. 노출 포트 반환. */
async function ensurePortForwarder(userId, port) {
  const uid = safeUid(userId);
  let map = portForwarders.get(uid);
  if (!map) { map = new Map(); portForwarders.set(uid, map); }
  const cached = map.get(port);
  const exposed = cached ? cached.exposed : _exposedPortFor(port);
  // 이미 노출 포트가 LISTEN 중이면 재사용(멱등). 아니면 detached node 포워더 기동.
  // 업스트림은 127.0.0.1/::1 둘 다 시도(vite 가 localhost=::1 에만 바인딩되는 경우가 있음).
  const fwd =
    `node -e 'const net=require("net");const L=+process.argv[1],R=+process.argv[2];`
    + `net.createServer(s=>{const hs=["127.0.0.1","::1"];const go=()=>{const h=hs.shift();`
    + `const u=net.connect(R,h);u.on("connect",()=>{s.pipe(u);u.pipe(s);});`
    + `u.on("error",()=>{hs.length?go():s.destroy();});s.on("error",()=>u.destroy());s.on("close",()=>u.destroy());};go();})`
    + `.listen(L,"0.0.0.0");' `
    + `${exposed} ${port}`;
  const launch =
    `if (exec 3<>/dev/tcp/127.0.0.1/${exposed}) 2>/dev/null; then exec 3>&- 3<&-; echo exists; `
    + `else setsid bash -lc ${shq(fwd)} > /tmp/cptfwd-${exposed}.log 2>&1 < /dev/null & echo started; fi`;
  await execBash(uid, launch).catch(() => {});
  map.set(port, { exposed, startedAt: Date.now() });
  return exposed;
}

// ── dev 서버(미리보기) lifecycle ──────────────────────────────────────
// 샌드박스 안에서 `npm run dev`(Vite 등)를 백그라운드(Detach exec)로 띄워 장기 유지한다.
// execBash 의 120s 동기 한계를 우회: Detach 로 즉시 반환하고, 준비완료는 HTTP 폴링으로 확인.
// userId → { projectId, port, dir, startedAt }
const devServers = new Map();
const DEV_LOG = '/tmp/devserver.log';
const DEV_PID_FILE = '/tmp/devserver.pid';
const DEV_WINDOW = 'dev';           // dev 서버 전용 tmux 윈도우 이름(셸과 분리된 탭)
const DEV_SCRIPT = '.cpt-dev.sh';   // 긴 실행 명령을 감싸는 래퍼 스크립트(터미널엔 짧게 'bash .cpt-dev.sh'만 보임)

// HMR(핫리로드) 설정 주입 파일 — 미리보기 프록시(WebSocket)를 통해 HMR 이 닿도록 Vite server.hmr 를 덮어쓴다.
// 사용자 vite.config 는 loadConfigFromFile 로 보존하고 hmr 만 병합. clientPort/protocol/path 는 CPT_HMR_* 로 주입.
const HMR_CONFIG_FILE = '.cpt-vite.config.mjs';
const HMR_CONFIG_JS = `import { mergeConfig, loadConfigFromFile } from "vite";
export default async () => {
  let loaded = null;
  try { loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, undefined, process.cwd()); } catch (_) {}
  const hmr = { path: process.env.CPT_HMR_PATH || "/" };
  if (process.env.CPT_HMR_PROTOCOL) hmr.protocol = process.env.CPT_HMR_PROTOCOL;
  if (process.env.CPT_HMR_CLIENT_PORT) hmr.clientPort = Number(process.env.CPT_HMR_CLIENT_PORT);
  return mergeConfig(loaded?.config ?? {}, { server: { hmr } });
};
`;

// 샌드박스 이미지에 procps(pkill/pgrep)가 없다 → /proc 스캔으로 dev 프로세스를 포터블하게 종료한다.
// 자기 자신($$)·부모($PPID)는 제외(이 스크립트의 cmdline 에도 'vite' 패턴이 들어가 자살 방지).
const SWEEP_DEV =
  'for d in /proc/[0-9]*; do p=${d#/proc/}; '
  + '[ "$p" = "$$" ] && continue; [ "$p" = "$PPID" ] && continue; '
  + `grep -qaE 'vite|esbuild' "$d/cmdline" 2>/dev/null && kill -9 "$p" 2>/dev/null; done; true`;
// 기록해 둔 프로세스 그룹(setsid 세션 리더 pid = pgid)을 통째로 죽이고, 잔여 orphan 은 스캔으로 정리.
const KILL_DEV =
  `{ [ -f ${DEV_PID_FILE} ] && kill -9 -"$(cat ${DEV_PID_FILE} 2>/dev/null)" 2>/dev/null; }; `
  + `rm -f ${DEV_PID_FILE} 2>/dev/null; ${SWEEP_DEV}`;

function getDevServer(userId) {
  return devServers.get(safeUid(userId)) || null;
}

/**
 * 샌드박스 안에서 dev 서버를 백그라운드로 기동.
 * Vite 기준: `--host 0.0.0.0`(컨테이너 외부에서 접근), `--base /api/preview/<pid>/`(프록시 경로 일치).
 * @param {string|number} userId
 * @param {{projectId:string, dir:string, port?:number, basePath?:string}} opts
 *   dir: 컨테이너 내 절대경로(워커 fs 와 동일). basePath: Vite base(기본 /api/preview/<projectId>/)
 */
async function startDevServer(userId, { projectId, dir, port = 5173, basePath, hmr } = {}) {
  const uid = safeUid(userId);
  if (!projectId || !dir) throw new Error('projectId 와 dir 이 필요합니다.');
  const container = await ensureSandbox(uid);

  const base = basePath || `/api/preview/${projectId}/`;

  // 재활용: 같은 프로젝트의 vite 가 이미 같은 base 로 살아있으면 죽이지 않고 그대로 재입양한다.
  //   워커가 재시작돼 devServers 상태를 잃었어도(샌드박스/vite 는 생존) 여기서 복구되어,
  //   프리뷰 재진입 시 "죽였다 재시작"하지 않고 이어서 본다(= 워크스페이스 유지).
  const cur = devServers.get(uid);
  if ((!cur || cur.projectId === projectId) && await isDevReady(uid, port, base)) {
    devServers.set(uid, { projectId, port, dir, basePath: base, startedAt: (cur && cur.startedAt) || Date.now() });
    const s0 = sessions.get(uid);
    if (s0) s0.lastUsed = Date.now();
    return { projectId, port, basePath: base, reused: true };
  }

  // 이미 떠있던 dev 서버(다른 프로젝트 등)는 정리(사용자당 1개)
  await stopDevServer(uid).catch(() => {});

  // HMR 설정 주입: 사용자 vite.config 를 보존하면서 hmr(clientPort/protocol/path)만 덮어쓰는 래퍼 config 작성.
  // 워커 fs == 샌드박스 fs(공유 볼륨)라 직접 파일을 써둔다. 실패해도 HMR 없이 정상 동작(폴백).
  let hmrEnv = '';
  let configFlag = '';
  try {
    fs.writeFileSync(path.join(dir, HMR_CONFIG_FILE), HMR_CONFIG_JS);
    hmrEnv =
      `export CPT_HMR_PATH=${shq(base)}`
      + (hmr && hmr.protocol ? ` CPT_HMR_PROTOCOL=${shq(String(hmr.protocol))}` : '')
      + (hmr && hmr.clientPort ? ` CPT_HMR_CLIENT_PORT=${shq(String(hmr.clientPort))}` : '')
      + '; ';
    configFlag = ` --config ${shq(HMR_CONFIG_FILE)}`;
  } catch (_) { /* HMR 주입 실패 → 기존대로(핫리로드 없이) */ }

  const proxyExports = EGRESS_PROXY
    ? `export HTTP_PROXY=${EGRESS_PROXY} HTTPS_PROXY=${EGRESS_PROXY} http_proxy=${EGRESS_PROXY} https_proxy=${EGRESS_PROXY} NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1\n`
    : '';
  const hmrExports = hmrEnv ? hmrEnv.replace(/; $/, '') + '\n' : '';
  // 포트가 완전히 빌 때까지 대기(이전 프로세스 종료 직후 strictPort 충돌 방지). /dev/tcp 연결되면 아직 점유 중.
  const portWait = `for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && { exec 3>&- 3<&- 2>/dev/null; sleep 0.5; } || break; done`;
  const devFlags = `--host 0.0.0.0 --port ${port} --strictPort --base ${shq(base)}${configFlag}`;

  // ── 긴 실행 명령을 래퍼 스크립트(.cpt-dev.sh)로 빼서, 터미널엔 짧고 읽기 쉬운 'bash .cpt-dev.sh' 만 보이게 ──
  //   exec 안 함 → Ctrl-C 로 npm 종료 시 dev 윈도우의 셸 프롬프트로 복귀(실제 dev 환경과 동일).
  //   (예전엔 거대한 한 줄을 tmux 에 그대로 타이핑해 "표현이 다름"·가독성 저하 → 스크립트로 해결)
  const scriptBody =
    `#!/usr/bin/env bash\n`
    + `${proxyExports}${hmrExports}`
    + `cd ${shq(dir)} || exit 1\n`
    + `${SWEEP_DEV}\n`
    + `${portWait}\n`
    + `[ -d node_modules ] || npm install\n`
    + `echo "▶ dev 서버 시작 (포트 ${port}) — 종료하려면 Ctrl-C"\n`
    + `NODE_OPTIONS=--max-old-space-size=1536 npm run dev -- ${devFlags}\n`;
  try { fs.writeFileSync(path.join(dir, DEV_SCRIPT), scriptBody, { mode: 0o755 }); } catch (_) { /* noop */ }
  const devCmd = `clear; bash ${DEV_SCRIPT}`;

  // ── setsid 폴백(tmux 미설치 환경): 기존 방식(pid 기록 + 로그파일로 백그라운드) ──
  const fallbackCmd =
    `${EGRESS_PROXY ? proxyExports.replace(/\n/g, '; ') : ''}${hmrEnv}cd ${shq(dir)} && ${SWEEP_DEV}; echo $$ > ${DEV_PID_FILE}; ${portWait}; ` +
    `{ [ -d node_modules ] || npm install; } && ` +
    `exec env NODE_OPTIONS=--max-old-space-size=1536 npm run dev -- ${devFlags}`;

  // tmux 있으면 dev 전용 윈도우에서 전면 실행(셸 윈도우와 분리된 탭 → 멀티 터미널), 없으면 setsid 백그라운드.
  //   기존 dev 윈도우가 있으면 Ctrl-C 후 재사용, 없으면 새로 만든다. 실행 후 그 윈도우로 전환.
  const wrapped =
    `if command -v tmux >/dev/null 2>&1; then `
    + `tmux has-session -t ${TMUX} 2>/dev/null || tmux new-session -d -s ${TMUX} -n shell -c ${shq(dir)}; `
    + `if tmux list-windows -t ${TMUX} -F '#{window_name}' 2>/dev/null | grep -qx ${shq(DEV_WINDOW)}; then `
    +   `tmux send-keys -t ${TMUX}:${shq(DEV_WINDOW)} C-c 2>/dev/null; sleep 0.2; `
    + `else `
    +   `tmux new-window -t ${TMUX} -n ${shq(DEV_WINDOW)} -c ${shq(dir)}; sleep 0.1; `
    + `fi; `
    + `tmux send-keys -t ${TMUX}:${shq(DEV_WINDOW)} -l ${shq(devCmd)}; tmux send-keys -t ${TMUX}:${shq(DEV_WINDOW)} Enter; `
    + `tmux select-window -t ${TMUX}:${shq(DEV_WINDOW)} 2>/dev/null; echo tmux-launched; `
    + `else `
    + `setsid bash -lc ${shq(fallbackCmd)} > ${DEV_LOG} 2>&1 < /dev/null & echo setsid-launched; `
    + `fi`;
  const exec = await container.exec({
    Cmd: ['bash', '-lc', wrapped],
    WorkingDir: dir,
    AttachStdout: true,
    AttachStderr: true,
    Env: ['HOME=/root', 'CI=1'],
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise((resolve) => {
    const sink = { write() {} };
    try { container.modem.demuxStream(stream, sink, sink); } catch (_) { /* noop */ }
    stream.on('end', resolve);
    stream.on('error', resolve);
    setTimeout(resolve, 4000); // 안전장치
  });

  devServers.set(uid, { projectId, port, dir, basePath: base, startedAt: Date.now() });
  const s = sessions.get(uid);
  if (s) s.lastUsed = Date.now();
  return { projectId, port, basePath: base };
}

/** dev 서버 준비 여부 단발 체크 — 워커가 컨테이너로 직접 HTTP(같은 네트워크 합류 전제) */
async function isDevReady(userId, port, basePath) {
  const uid = safeUid(userId);
  const host = containerName(uid);
  const reqPath = basePath || '/';
  return new Promise((resolve) => {
    // base(reqPath) 로 200 이 떠야 진짜 준비됨. 404 등은 "아직/잘못된 base"(예: 다른 base 로 떠있는
    // 서버, 재시작 중)이므로 ready 로 보지 않는다 — 그래야 base 일치까지 보장됨.
    // Host: localhost(컨테이너명은 Vite allowedHosts 403). Accept: text/html(없으면 Vite 가 SPA index 를 404 처리).
    const req = http.get({ host, port, path: reqPath, timeout: 2500, headers: { Host: `localhost:${port}`, Accept: 'text/html' } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (_) { /* noop */ } resolve(false); });
  });
}

/** dev 서버 로그 tail(준비 지연 진단/표시용) */
async function readDevLog(userId, lines = 40) {
  try {
    const r = await execBash(userId, `tail -n ${lines} ${DEV_LOG} 2>/dev/null || true`);
    return r.output || '';
  } catch (_) { return ''; }
}

/** dev 서버 종료 — 누적 orphan(여러 vite/node) 까지 강제 정리해 포트를 비운다. */
async function stopDevServer(userId) {
  const uid = safeUid(userId);
  devServers.delete(uid);
  try {
    // dev 전용 윈도우에서 전면 실행 중이면 Ctrl-C 로 우아하게 종료 후 그 윈도우(탭)를 닫는다.
    // 미설치/잔여는 KILL_DEV 폴백(이미지에 pkill 이 없으므로 기록 pid 그룹 kill + /proc 스캔).
    await execBash(
      uid,
      `command -v tmux >/dev/null 2>&1 && { `
      + `tmux send-keys -t ${TMUX}:${shq(DEV_WINDOW)} C-c 2>/dev/null; sleep 0.3; `
      + `tmux kill-window -t ${TMUX}:${shq(DEV_WINDOW)} 2>/dev/null; }; `
      + `sleep 0.1; ${KILL_DEV}; sleep 0.2; true`,
    );
  } catch (_) { /* noop */ }
}

/** 사용자 샌드박스 정지·제거 */
async function releaseSandbox(userId) {
  const uid = safeUid(userId);
  const s = sessions.get(uid);
  sessions.delete(uid);
  const container = (s && s.container) || (docker && docker.getContainer(containerName(uid)));
  if (!container) return;
  try { await container.remove({ force: true }); } catch (_) { /* noop */ }
}

// 워커 부팅 시 재입양 — 워커가 재시작되면 in-memory(sessions/devServers) 가 비워지지만,
// 샌드박스 컨테이너(+그 안의 tmux/vite/포워더)는 그대로 살아있다. 살아있는 샌드박스를 sessions 에
// 다시 등록해 (1) idle sweeper 가 추적하도록(고아 누수 방지) (2) 다음 사용 시 재활용되도록 복구한다.
async function adoptRunningSandboxes() {
  if (!ENABLED || !docker) return;
  try {
    const list = await docker.listContainers({
      filters: { label: ['cpt.role=agent-sandbox'], status: ['running'] },
    });
    const now = Date.now();
    for (const info of list) {
      const uid = (info.Labels && info.Labels['cpt.userId']) || null;
      if (!uid || sessions.has(uid)) continue;
      const name = containerName(uid);
      sessions.set(uid, { container: docker.getContainer(info.Id), name, lastUsed: now });
    }
    if (list.length) {
      console.log(`[sandbox] 부팅 재입양: 실행 중 샌드박스 ${list.length}개 복원`);
    }
  } catch (e) {
    console.error('[sandbox] adoptRunningSandboxes 실패:', e && e.message);
  }
}

// idle TTL 정리 — 마지막 사용 후 IDLE_TTL_MS 경과 컨테이너 제거
let _sweeper = null;
function startIdleSweeper() {
  if (_sweeper || !ENABLED) return;
  _sweeper = setInterval(() => {
    const now = Date.now();
    for (const [uid, s] of sessions.entries()) {
      // 활성 인터랙티브 터미널이 연결돼 있으면(출력 없어도) 컨테이너를 유지한다.
      const t = terminals.get(uid);
      if (t && t.size > 0) continue;
      // dev 서버(미리보기)가 도는 동안은 idle 로 보지 않는다 — 사용자가 IDE 를 닫아도
      // "워크스페이스 나가기 전까지 유지"(워크스페이스 이탈 시 stopDevServer 로 devServers 에서 제거됨).
      if (devServers.has(uid)) { s.lastUsed = now; continue; }
      if (now - s.lastUsed > IDLE_TTL_MS) {
        sessions.delete(uid);
        s.container.remove({ force: true }).catch(() => {});
      }
    }
  }, 60000);
  if (_sweeper.unref) _sweeper.unref();
}
if (ENABLED) { adoptRunningSandboxes().finally(startIdleSweeper); }

module.exports = {
  isEnabled, ensureSandbox, execBash, releaseSandbox, containerName, userWorkspaceDir,
  // 인터랙티브 PTY 터미널
  openPty,
  // 멀티 터미널(tmux 윈도우) + 포트 감지 + 포워더
  listWindows, newWindow, selectWindow, killWindow, clearActiveWindow, detectListeningPorts, ensurePortForwarder,
  // dev 서버(미리보기) lifecycle
  startDevServer, isDevReady, readDevLog, stopDevServer, getDevServer,
};
