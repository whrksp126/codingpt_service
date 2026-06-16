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

/**
 * 사용자 샌드박스 컨테이너 확보(없으면 생성, 멈춰있으면 시작). 동일 사용자는 재사용.
 * @returns {Promise<import('dockerode').Container>}
 */
async function ensureSandbox(userId) {
  if (!ENABLED) throw new Error('샌드박스가 비활성화되어 있습니다.');
  const uid = safeUid(userId);

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

// ── dev 서버(미리보기) lifecycle ──────────────────────────────────────
// 샌드박스 안에서 `npm run dev`(Vite 등)를 백그라운드(Detach exec)로 띄워 장기 유지한다.
// execBash 의 120s 동기 한계를 우회: Detach 로 즉시 반환하고, 준비완료는 HTTP 폴링으로 확인.
// userId → { projectId, port, dir, startedAt }
const devServers = new Map();
const DEV_LOG = '/tmp/devserver.log';
const DEV_PID_FILE = '/tmp/devserver.pid';

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
  // 이미 떠있던 dev 서버는 정리(사용자당 1개)
  await stopDevServer(uid).catch(() => {});

  const base = basePath || `/api/preview/${projectId}/`;

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

  const proxyEnv = EGRESS_PROXY
    ? `export HTTP_PROXY=${EGRESS_PROXY} HTTPS_PROXY=${EGRESS_PROXY} http_proxy=${EGRESS_PROXY} https_proxy=${EGRESS_PROXY} NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1; `
    : '';
  // 의존성 없으면 설치 후 dev 서버 실행. 전체를 한 detached 프로세스로(설치도 백그라운드).
  const cmd =
    `${proxyEnv}${hmrEnv}cd ${shq(dir)} && ` +
    // 기존 dev 서버/잔여 프로세스 정리(pkill 미존재 → /proc 스캔). 그 뒤 이 세션 리더 pid 를 기록(종료 시 그룹 kill).
    `${SWEEP_DEV}; echo $$ > ${DEV_PID_FILE}; ` +
    // 포트가 완전히 빌 때까지 대기(이전 프로세스 종료 직후 strictPort 충돌 방지). /dev/tcp 연결되면 아직 점유 중.
    `for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && { exec 3>&- 3<&- 2>/dev/null; sleep 0.5; } || break; done; ` +
    `{ [ -d node_modules ] || npm install; } && ` +
    // --strictPort: 포트 자동증가 금지(프록시 고정 포트와 어긋나지 않게). NODE_OPTIONS: 힙 여유.
    `exec env NODE_OPTIONS=--max-old-space-size=1536 npm run dev -- --host 0.0.0.0 --port ${port} --strictPort --base ${shq(base)}${configFlag}`;

  // setsid 로 새 세션에 백그라운드 기동 → exec 가 끝나도 dev 서버는 살아남는다.
  // (dockerode exec 의 Detach:true 는 이 환경에서 프로세스를 실제로 안 띄우는 경우가 있어 이 방식이 안전.)
  const wrapped = `setsid bash -lc ${shq(cmd)} > ${DEV_LOG} 2>&1 < /dev/null & echo launched`;
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
    // 이미지에 pkill 이 없으므로 기록한 프로세스 그룹을 kill + /proc 스캔으로 잔여 정리.
    await execBash(uid, `${KILL_DEV}; sleep 0.3; true`);
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

// idle TTL 정리 — 마지막 사용 후 IDLE_TTL_MS 경과 컨테이너 제거
let _sweeper = null;
function startIdleSweeper() {
  if (_sweeper || !ENABLED) return;
  _sweeper = setInterval(() => {
    const now = Date.now();
    for (const [uid, s] of sessions.entries()) {
      if (now - s.lastUsed > IDLE_TTL_MS) {
        sessions.delete(uid);
        s.container.remove({ force: true }).catch(() => {});
      }
    }
  }, 60000);
  if (_sweeper.unref) _sweeper.unref();
}
if (ENABLED) startIdleSweeper();

module.exports = {
  isEnabled, ensureSandbox, execBash, releaseSandbox, containerName, userWorkspaceDir,
  // dev 서버(미리보기) lifecycle
  startDevServer, isDevReady, readDevLog, stopDevServer, getDevServer,
};
