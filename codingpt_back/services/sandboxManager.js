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
let Docker = null;
try { Docker = require('dockerode'); } catch (_) { /* 미설치 환경 폴백 */ }

const ENABLED = process.env.AGENT_SANDBOX_ENABLED === '1' && !!Docker;
const IMAGE = process.env.AGENT_SANDBOX_IMAGE || 'codingpt_service-agent-worker';
const VOLUME = process.env.AGENT_SANDBOX_VOLUME || 'codingpt_service_cpt_agent_workspace';
const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT || os.tmpdir();
const NETWORK = process.env.AGENT_SANDBOX_NETWORK || 'none';
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

  const exec = await container.exec({
    Cmd: ['bash', '-lc', command],
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
    Env: ['HOME=/root', 'CI=1'],
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

module.exports = { isEnabled, ensureSandbox, execBash, releaseSandbox, containerName, userWorkspaceDir };
