/**
 * spawn-util.js — 자식 프로세스 실행의 win32 셔틀 (Windows 포팅 계약 4·§D-5).
 *
 * 왜 필요한가: win32 에서 claude/codex 는 npm 전역 설치 시 `.cmd` shim 이다. Node 는 보안 수정
 *  (CVE-2024-27980) 이후 `.cmd/.bat` 를 shell 없이 spawn 하면 **EINVAL 로 거부**한다. 그래서
 *  절대경로 확정 후 `cmd.exe /d /s /c "…"` 경유로만 실행한다(인자는 우리가 통제하는 값만 —
 *  사용자 자유 문자열을 이 경로에 넣지 말 것).
 *
 * darwin/linux 는 **무수정 통과**(cp.spawn/execFileSync 그대로) — macOS 무회귀가 최우선.
 */
const cp = require('child_process');

function isWin(platform) { return (platform || process.platform) === 'win32'; }

/** 이 파일을 shell(cmd.exe) 경유로만 실행할 수 있는가(.cmd/.bat). */
function needsCmdShell(file, platform) {
  return isWin(platform) && /\.(cmd|bat)$/i.test(String(file || ''));
}

function comspec() { return process.env.comspec || process.env.COMSPEC || 'cmd.exe'; }

/**
 * cmd.exe 명령줄 인용 — 공백/특수문자가 있으면 "…" 로 감싸고 내부 " 는 \" 로.
 *  (cmd 파서와 MSVCRT 인자 파싱의 교집합에서 안전한 최소 규칙. 통제된 인자 전제 — 임의 사용자
 *   입력을 이 경로로 흘리지 않는다.)
 */
function cmdQuote(a) {
  const s = String(a);
  if (s && !/[\s"^&|<>()%!;,=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

function cmdLine(file, args) {
  return [file, ...(args || [])].map(cmdQuote).join(' ');
}

/** spawn — win32 의 .cmd/.bat 만 cmd.exe /d /s /c 경유, 그 외(darwin 포함)는 cp.spawn 그대로. */
function spawnCli(file, args, opts) {
  if (!needsCmdShell(file)) return cp.spawn(file, args, opts);
  return cp.spawn(comspec(), ['/d', '/s', '/c', '"' + cmdLine(file, args) + '"'], {
    ...(opts || {}), windowsVerbatimArguments: true, windowsHide: true,
  });
}

/** execFileSync 등가 — win32 의 .cmd/.bat 만 cmd.exe 경유. */
function execFileCliSync(file, args, opts) {
  if (!needsCmdShell(file)) return cp.execFileSync(file, args, opts);
  return cp.execFileSync(comspec(), ['/d', '/s', '/c', '"' + cmdLine(file, args) + '"'], {
    ...(opts || {}), windowsVerbatimArguments: true, windowsHide: true,
  });
}

/**
 * node-pty 스폰 좌표 — win32 의 .cmd 는 ConPTY 도 직접 못 띄우므로 cmd.exe 경유 좌표로 변환.
 *  (node-pty 가 인자 인용(argsToCommandLine)을 스스로 하므로 여기선 배열만 만든다.)
 */
function ptyCommand(file, args) {
  if (!needsCmdShell(file)) return { file, args: args || [] };
  return { file: comspec(), args: ['/d', '/s', '/c', file, ...(args || [])] };
}

/**
 * 프로세스 (트리) 종료 — win32 는 시그널이 없어 taskkill /T /F(트리 강제 종료)로 대체.
 *  darwin/linux 는 기존 그대로 process.kill(signal).
 */
function killTree(pid, signal) {
  if (!pid) return;
  if (!isWin()) { try { process.kill(pid, signal || 'SIGTERM'); } catch (_) { /* 이미 죽음 */ } return; }
  try { cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => {}); }
  catch (_) { /* noop */ }
}

module.exports = { spawnCli, execFileCliSync, ptyCommand, killTree, needsCmdShell, comspec, _cmdQuote: cmdQuote };
