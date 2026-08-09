/**
 * term-host 경로 규칙 — 파이프/저널 위치를 한 곳에서 결정한다(설계 계약 1).
 *
 *  · win32: named pipe `\\.\pipe\cpt-termhost-<sha256(homedir) 앞 8자>` — homedir 기반이라
 *    같은 사용자의 모든 프로세스(데몬·PC 앱·CLI)가 같은 호스트를 본다. 파이프는 프로세스 종료와
 *    함께 자동 소멸하므로 unlink 정리가 없다.
 *  · 비-win32(개발/테스트): `<stateDir>/termhost.sock` 유닉스 소켓 폴백. sun_path 104바이트
 *    한계를 넘으면 /tmp 로 회피(cpt-server.sockPath 와 같은 규칙 — 어긋나면 유령 소켓을 본다).
 *  · env 오버라이드: CPT_TERMHOST_SOCK(테스트 격리·term-backend 가 spawn 시 전달),
 *    CODINGPT_STATE_DIR(runner-core runtime.init 과 동일한 상태 루트 주입).
 */
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function stateDir() {
  return process.env.CODINGPT_STATE_DIR || path.join(os.homedir(), '.codingpt');
}

// 저널 디렉토리/파일 — 크래시 대비 세션 메타(복원은 respawn 정책).
function journalDir() {
  return path.join(stateDir(), 'termhost');
}
function journalPath() {
  return path.join(journalDir(), 'sessions.json');
}

// homedir 해시 앞 8자 — 사용자별 파이프 격리(멀티 유저 Windows).
function homeHash8() {
  return crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 8);
}

/**
 * win32 파이프 경로 정규화 — env 오버라이드(CPT_TERMHOST_SOCK)에 파일 경로(유닉스 소켓 스타일)가
 * 오면 그 문자열을 해시해 파이프 이름으로 접는다. win32 net.listen 은 `\\.\pipe\` 접두사가 아니면
 * 실패하므로(EACCES/ENOENT), 테스트·격리 시나리오가 임시 디렉토리 경로를 그대로 넘겨도 클라이언트
 * (term-backend)와 호스트가 **같은 규칙**으로 같은 파이프를 보게 된다. 파이프 형식은 그대로 통과.
 */
function normalizeWinPipe(p) {
  if (/^\\\\[.?]\\pipe\\/.test(p)) return p;
  return `\\\\.\\pipe\\cpt-termhost-test-${crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 8)}`;
}

function pipePath() {
  if (process.env.CPT_TERMHOST_SOCK) {
    const p = process.env.CPT_TERMHOST_SOCK;
    return process.platform === 'win32' ? normalizeWinPipe(p) : p;
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\cpt-termhost-${homeHash8()}`;
  }
  const p = path.join(stateDir(), 'termhost.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  // sun_path 한계 폴백 — cpt-server.sockPath 와 동일 발상(uid + stateDir 해시로 충돌 회피).
  const h = crypto.createHash('sha1').update(stateDir()).digest('hex').slice(0, 8);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cpt-termhost-${uid}-${h}.sock`);
}

module.exports = { stateDir, journalDir, journalPath, pipePath, homeHash8, normalizeWinPipe };
