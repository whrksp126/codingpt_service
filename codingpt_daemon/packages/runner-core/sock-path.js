/**
 * sock-path.js — cpt 컨트롤 플레인 소켓/파이프 경로의 **단일 출처** (Windows 포팅 계약 2).
 *
 * 왜 생겼나(2026-08-10): 같은 경로 계산이 3벌 복제돼 있었다(cpt-server.js sockPath ·
 *  cpt-cli/bin/cpt.js sockPath 하드코딩 · statusline-relay.js sockPath 하드코딩). win32 에서
 *  유닉스 소켓이 named pipe 로 바뀌면 3곳이 각자 어긋날 수 있어 여기로 통합한다.
 *
 * 계약(docs/windows-port/design.md §계약 2):
 *  · win32 경로 = `\\.\pipe\codingpt-cpt-<sha256(homedir) 앞 8자>` — CPT_SOCK env 에 이 문자열을
 *    그대로 넣으면 기존 소비자(net.connect)가 무수정으로 동작한다.
 *  · 비표준 stateDir(테스트·클라우드 러너)는 stateDir 해시로 격리한다 — 파이프 이름은 머신 전역
 *    네임스페이스라 기본 이름을 공유하면 테스트 인스턴스가 실데몬과 충돌한다.
 *  · POSIX 는 기존 규칙 그대로: <stateDir>/cpt.sock, sun_path 한계(104B) 초과 시 /tmp 짧은 폴백.
 *  · win32 는 existsSync/unlink/chmod 대상이 아니다(파이프는 마지막 핸들이 닫히면 자동 소멸) —
 *    소비자는 isPipePath() 로 파일 정리 로직을 스킵한다.
 */
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PIPE_PREFIX = '\\\\.\\pipe\\';

function sha8(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }

/** named pipe 경로인가 — \\.\pipe\… / \\?\pipe\… 둘 다 인정. */
function isPipePath(p) { return typeof p === 'string' && /^\\\\[.?]\\pipe\\/.test(p); }

function defaultStateDir() { return path.join(os.homedir(), '.codingpt'); }

/**
 * 서버(데몬) 측 정본 경로. cpt-server 가 listen 하는 이름이며, pty env(CPT_SOCK) 주입의 원천.
 * @param {string} [stateDir] 기본 = ~/.codingpt
 * @param {string} [platform] 테스트 주입용(기본 process.platform)
 */
function serverSockPath(stateDir, platform) {
  const plat = platform || process.platform;
  const dir = stateDir || defaultStateDir();
  if (plat === 'win32') {
    // 계약 2 그대로: 기본 stateDir 는 sha8(homedir). 비표준 stateDir 만 stateDir 로 격리.
    const key = dir === defaultStateDir() ? os.homedir() : dir;
    return PIPE_PREFIX + 'codingpt-cpt-' + sha8(key);
  }
  // POSIX 분기는 path.posix 고정 — platform 파라미터가 진짜 크로스로 동작해야 한다(win32 호스트에서
  //  darwin 규칙을 검증하는 CI 가 path.join 의 '\\' 를 받으면 유령 경로가 된다. darwin 실행에선 동일).
  const p = path.posix.join(dir, 'cpt.sock');
  // sun_path 한계(macOS 104B) 초과 경로는 커널이 조용히 잘라 유령 소켓이 된다 → /tmp 짧은 폴백.
  if (Buffer.byteLength(p) <= 100) return p;
  const h = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
  return path.posix.join('/tmp', `cpt-${typeof process.getuid === 'function' ? process.getuid() : 0}-${h}.sock`);
}

/** 클라이언트(cpt CLI·statusline-relay) 측 — CPT_SOCK env 가 항상 우선(테스트/비표준 stateDir 탈출구). */
function clientSockPath(platform) {
  if (process.env.CPT_SOCK) return process.env.CPT_SOCK;
  return serverSockPath(null, platform);
}

/** BYO 에이전트 승인 소켓(agent.js) — win32 는 `\\.\pipe\cpt-approval-<pid>` (계약 2). */
function approvalSockPath(pid, platform) {
  const plat = platform || process.platform;
  if (plat === 'win32') return PIPE_PREFIX + 'cpt-approval-' + pid;
  return path.join(os.tmpdir(), `cpt-approval-${pid}.sock`);
}

module.exports = { serverSockPath, clientSockPath, approvalSockPath, isPipePath, defaultStateDir, _sha8: sha8 };
