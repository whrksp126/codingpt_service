/**
 * PTY 스트림 — stream_open(kind:'pty') 처리
 *
 * back 의 dial-back 지시를 받아 스트림 전용 WS 를 아웃바운드로 열고,
 * node-pty 로 tmux 세션에 attach 해 양방향 브리지한다.
 *
 * 와이어 계약(기존 termproxy 와 동일 — 앱 TerminalWebView 무수정):
 *  · 클라→PTY: 바이너리 = 키 입력(stdin), 텍스트 JSON {type:'resize',cols,rows} = 리사이즈
 *  · PTY→클라: raw 출력 그대로
 *
 * tmux 격리: 사용자의 개인 tmux 서버를 건드리지 않도록 전용 소켓(-L codingpt)의
 * 별도 tmux 서버를 쓴다. 세션명 'codingpt'. 스트림마다 같은 세션에 attach(-A) →
 * 폰·Mac 이 같은 화면을 실시간 공유(미러). WS 가 끊겨도 세션은 tmux 서버에 생존.
 *  · 로컬에서 같은 세션 보기: `tmux -L codingpt attach -t codingpt`
 *  · window-size latest + aggressive-resize: 마지막으로 조작한 클라이언트 크기 기준.
 *
 * ToS 경계: 여기서 하는 일은 "터미널 바이트 릴레이"가 전부다. 이 프로세스는 어떤
 * AI 자격증명도 읽거나 전달하지 않는다. 사용자가 이 터미널에서 claude 를 실행하면
 * 그 API 트래픽은 이 PC → Anthropic 직결이다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const WebSocket = require('ws');
const nodePty = require('node-pty');
const fsLib = require('./fs');
const runtime = require('./runtime');

const TMUX_SOCKET = 'codingpt'; // tmux -L codingpt (사용자 기본 tmux 서버와 격리)
const TMUX_SESSION = 'codingpt';
// tmux.conf 위치 — 소스/번들 레이아웃이 달라 여러 후보를 탐색(첫 존재 파일). 없으면 null → '-f' 생략.
//  소스: codingpt_daemon/tmux.conf (runner-core→packages→daemon root).
//  번들: resources/daemon/tmux/tmux.conf (CODINGPT_TMUX=.../tmux/bin/tmux 기준 형제).
function resolveTmuxConf() {
  const c = [];
  if (process.env.CODINGPT_TMUX_CONF) c.push(process.env.CODINGPT_TMUX_CONF);
  if (process.env.CODINGPT_TMUX) {
    c.push(path.join(path.dirname(process.env.CODINGPT_TMUX), '..', 'tmux.conf'));
    c.push(path.join(path.dirname(process.env.CODINGPT_TMUX), 'tmux.conf'));
  }
  c.push(path.join(__dirname, '..', '..', 'tmux.conf'));
  c.push(path.join(__dirname, '..', 'tmux.conf'));
  for (const p of c) { try { if (fs.existsSync(p)) return p; } catch (_) { /* noop */ } }
  return null;
}
const TMUX_CONF = resolveTmuxConf(); // 서버 시작 시(-f) 로드 → alt-screen override 선적용. null 이면 -f 생략
const CONF_ARGS = TMUX_CONF ? ['-f', TMUX_CONF] : [];

// 열려는 워크스페이스 경로(홈-기준 상대)에 맞는 tmux 세션명 + 시작 절대경로.
//  · 홈 루트('') = 기존 공유 세션 'codingpt'(Mac attach 하위호환).
//  · 워크스페이스 = 경로별 전용 세션 'cpt-<sanitized>' 를 그 폴더에서 시작(-c) → 진입 시 터미널이 그 경로.
//  경로는 홈 jail(safeResolve) 로 검증하고, 없으면 홈으로 폴백(터미널은 항상 열림).
function sessionForCwd(cwdRel) {
  if (!cwdRel) return { session: TMUX_SESSION, abs: runtime.root() };
  let abs;
  try { abs = fsLib.safeResolve(cwdRel); } catch (_) { return { session: TMUX_SESSION, abs: runtime.root() }; }
  if (!fs.existsSync(abs)) return { session: TMUX_SESSION, abs: runtime.root() };
  const safe = String(cwdRel).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return { session: 'cpt-' + (safe || 'ws'), abs };
}

// pane 별 grouped view 세션명. primary 와 window 를 공유하되 current-window 는 독립.
function viewSession(primary, paneId) {
  return primary + '--v-' + String(paneId).replace(/[^A-Za-z0-9_-]+/g, '-');
}

let tmuxPathCache = null;
function findTmux() {
  if (tmuxPathCache) return tmuxPathCache;
  const candidates = [];
  // 번들 tmux(데스크톱 앱이 CODINGPT_TMUX 로 주입) 최우선 — 사용자 무설치.
  if (process.env.CODINGPT_TMUX) candidates.push(process.env.CODINGPT_TMUX);
  try {
    const p = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
    if (p) candidates.push(p);
  } catch (_) { /* PATH 에 없으면 후보 경로 탐색 */ }
  candidates.push('/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux');
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { tmuxPathCache = p; return p; } } catch (_) { /* noop */ }
  }
  return null;
}

// back 지시(stream_open)에 대한 dial-back. 실패 시 throw → control 이 stream_fail 회신.
function openPtyStream({ serverUrl, deviceToken }, { streamToken, params }) {
  const tmux = findTmux();
  if (!tmux) throw new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)');

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });

  ws.on('open', () => {
    const cols = (params && params.cols) || 80;
    const rows = (params && params.rows) || 24;

    // 데몬 자체가 tmux/cmux 안에서 실행돼도 attach 되도록 TMUX 해제(중첩 가드 우회 — 소켓이 달라 안전).
    const env = { ...process.env };
    delete env.TMUX;
    // UTF-8 로케일 강제 — 데스크톱 앱으로 데몬이 뜨면 셸 로케일(LANG)이 없어 tmux 클라이언트가
    //  non-UTF-8 로 attach → 한글 등 멀티바이트 출력이 '_' 로 뭉개진다. 로케일을 UTF-8 로 고정한다.
    if (!/UTF-?8/i.test(env.LANG || '')) env.LANG = 'en_US.UTF-8';
    if (!/UTF-?8/i.test(env.LC_CTYPE || '')) env.LC_CTYPE = 'en_US.UTF-8';

    // tmux 세션 옵션은 tmux.conf 에 있고 -f 로 서버 시작 시점에 로드된다.
    //  (alt-screen override 는 클라이언트 attach 전에 세팅돼야 스크롤백이 xterm 에 쌓임 —
    //   new-session 뒤에 set 하면 이미 smcup 을 보낸 뒤라 소급 안 됨.)
    // 매 attach 마다 실행하는 건 window-size 뿐(마지막 조작 클라이언트 크기 반영 보정).
    // 진입한 워크스페이스 경로에 맞는 세션/시작폴더 결정(홈=공유 세션, 워크스페이스=전용 세션 @ 그 폴더).
    const { session, abs } = sessionForCwd(params && params.cwd);
    // pane 별 grouped view 세션명(모바일 다중 터미널 pane 이 각자 다른 window 를 동시에 보게).
    const paneId = params && params.paneId ? String(params.paneId).replace(/[^A-Za-z0-9_-]+/g, '-') : '';

    let spawnArgs;
    if (paneId) {
      // primary 세션 보장(detached create-or-noop) → 이 pane 전용 grouped view 세션에 attach.
      //   grouped(-t): window 목록은 primary 와 공유, current-window/size 는 독립
      //   → PC 의 grouped session 방식과 동일하게 여러 pane 이 서로 다른 window 를 동시 표시.
      try {
        execFileSync(tmux, [
          '-L', TMUX_SOCKET, ...CONF_ARGS,
          'new-session', '-A', '-d', '-s', session, '-c', abs,
          ';', 'set', '-g', 'window-size', 'latest',
        ], { env, stdio: 'ignore' });
      } catch (_) { /* 이미 존재하면 무시 */ }
      const view = viewSession(session, paneId);
      // 이 pane 이 표시할 window(win). 앱이 pane 별로 자기 window 를 미리 확보해 넘긴다.
      //  grouped view 는 생성 시 primary 의 current-window 를 상속하므로, 명시 win 을 attach 와 같은
      //  tmux 명령에서 select-window 로 못박아 "여러 pane 이 같은 window 를 보는" 경쟁을 원천 차단한다.
      const selWin = (params && Number.isInteger(params.win)) ? params.win : null;
      // -u: UTF-8 출력 강제(로케일과 무관). 한글 등 멀티바이트가 '_' 로 뭉개지지 않게.
      // -A: view 가 있으면 attach(재연결 시 current-window 유지), 없으면 -t 로 grouped 생성.
      spawnArgs = ['-L', TMUX_SOCKET, '-u', 'new-session', '-A', '-t', session, '-s', view];
      if (selWin != null) spawnArgs.push(';', 'select-window', '-t', `${view}:${selWin}`);
      spawnArgs.push(';', 'set', '-g', 'window-size', 'latest');
    } else {
      // 하위호환(paneId 없음): 기존 공유 세션에 직접 attach.
      spawnArgs = ['-L', TMUX_SOCKET, '-u', ...CONF_ARGS, 'new-session', '-A', '-s', session, '-c', abs, ';', 'set', '-g', 'window-size', 'latest'];
    }

    let pty;
    try {
      pty = nodePty.spawn(tmux, spawnArgs, {
        name: 'xterm-256color',
        cols, rows,
        cwd: abs,
        env,
      });
    } catch (e) {
      try { ws.send(`\r\n\x1b[31m터미널 생성 실패: ${e.message}\x1b[0m\r\n`); ws.close(); } catch (_) { /* noop */ }
      return;
    }
    console.log(`[pty] 스트림 연결 (session=${session}${paneId ? ' view=' + viewSession(session, paneId) : ''}, cwd=${abs}, ${cols}x${rows})`);

    pty.onData((data) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (_) { /* noop */ }
    });
    pty.onExit(({ exitCode }) => {
      console.log(`[pty] tmux 클라이언트 종료 exitCode=${exitCode}`);
      try { ws.close(); } catch (_) { /* noop */ }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        try { pty.write(data.toString('utf8')); } catch (_) { /* noop */ }
        return;
      }
      const str = data.toString();
      try {
        const m = JSON.parse(str);
        if (m && m.type === 'resize' && m.cols && m.rows) {
          try { pty.resize(m.cols | 0, m.rows | 0); } catch (_) { /* noop */ }
          return;
        }
      } catch (_) { /* JSON 아니면 일반 입력 */ }
      try { pty.write(str); } catch (_) { /* noop */ }
    });

    const cleanup = () => {
      // tmux 클라이언트만 종료(detach) — 세션은 tmux 서버에 살아남는다.
      try { pty.kill(); } catch (_) { /* noop */ }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  ws.on('error', (e) => console.error(`[pty] 스트림 WS 오류: ${e.message}`));
}

// ── 멀티 터미널(tmux window) RPC ──
// 클라우드(ideService)와 동일한 "window 스위칭" 모델을 데몬에서 미러한다: 앱의 단일 PTY 스트림이
// 세션에 attach 돼 있고, 여기서 select-window 로 활성 window 를 바꾸면 그 클라이언트가 따라 그린다.
// → 토큰/스트림/bridge 는 전혀 손대지 않고 window 관리 RPC 만 추가. 전용 소켓 -L codingpt 규율 유지.
function runTmux(args) {
  return new Promise((resolve, reject) => {
    const tmux = findTmux();
    if (!tmux) return reject(new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)'));
    const env = { ...process.env };
    delete env.TMUX; // 데몬이 tmux/cmux 안에서 돌아도 전용 소켓 조작 가능하게 중첩 가드 해제
    execFile(tmux, ['-L', TMUX_SOCKET, ...args], { env, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr || err.message || '')).trim() || 'tmux 오류'));
      resolve(String(stdout || ''));
    });
  });
}

// terminal.list/new/select/close — 진입 워크스페이스(cwd)에 해당하는 tmux 세션의 window 를 관리.
async function handleTerminalRpc(method, params) {
  const { session, abs } = sessionForCwd(params && params.cwd);
  if (method === 'terminal.list') {
    let out;
    try {
      out = await runTmux(['list-windows', '-t', session, '-F', '#{window_index}\t#{window_active}\t#{pane_current_command}']);
    } catch (_) {
      return { windows: [] }; // 세션 미존재(스트림 미개설) → 빈 목록
    }
    const windows = out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((l) => {
      const parts = l.split('\t');
      return { index: parseInt(parts[0], 10) || 0, active: parts[1] === '1', command: (parts.slice(2).join('\t') || '').trim() };
    });
    return { windows };
  }
  if (method === 'terminal.new') {
    try {
      // -d: 새 window 를 만들되 primary 의 current-window 를 바꾸지 않는다. 그래야 뒤이어 생성되는
      //  grouped view 세션이 엉뚱한(방금 만든) window 를 상속하지 않는다. 각 pane 은 자기 win 을 명시 select.
      const out = await runTmux(['new-window', '-d', '-t', session, '-c', abs, '-P', '-F', '#{window_index}']);
      return { index: parseInt(out.trim(), 10) || 0 };
    } catch (_) {
      // 세션이 아직 없으면 detached 로 생성(앱 스트림이 뒤이어 -A 로 attach). conf 는 서버 시작 시점에만 유효.
      const out = await runTmux(['-f', TMUX_CONF, 'new-session', '-d', '-s', session, '-c', abs, '-P', '-F', '#{window_index}']);
      return { index: parseInt(out.trim(), 10) || 0 };
    }
  }
  if (method === 'terminal.select') {
    // paneId 있으면 그 pane 의 grouped view 세션에서 window 선택(다른 pane 에 영향 없음).
    const paneId = params && params.paneId ? String(params.paneId) : '';
    const target = paneId ? viewSession(session, paneId) : session;
    await runTmux(['select-window', '-t', `${target}:${(params && params.index) | 0}`]);
    return { ok: true };
  }
  if (method === 'terminal.close') {
    await runTmux(['kill-window', '-t', `${session}:${(params && params.index) | 0}`]);
    return { ok: true };
  }
  throw new Error('unknown terminal method: ' + method);
}

module.exports = { openPtyStream, findTmux, handleTerminalRpc, TMUX_SOCKET, TMUX_SESSION };
