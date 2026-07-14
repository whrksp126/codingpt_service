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

// pane 별 grouped view 세션명(레거시). primary 와 window 공유·current-window 독립 — 이었으나
//  grouped 의 current-window 가 attach 타이밍/동시성에 취약해 여러 pane 이 같은 window 를 봤다(복제).
function viewSession(primary, paneId) {
  return primary + '--v-' + String(paneId).replace(/[^A-Za-z0-9_-]+/g, '-');
}

// pane 별 "독립" 세션명(현행). primary 와 window 를 공유하지 않는다 → current-window 경쟁 원천 소멸.
//  각 pane = 자기 세션 = 자기 셸(들). 탭 = 이 세션 안의 window. select 는 단일 세션·단일 클라이언트라 확실히 붙는다.
//  (대가: PC↔모바일 터미널 라이브미러는 없어진다 — 어차피 공유모델서도 신뢰 못했음. 파일은 여전히 공유.)
//  client(기기 키)가 있으면 세션을 기기별로도 분리('--c-') — 여러 기기가 같은 워크스페이스 레이아웃을
//  이어받아 같은 paneId 로 attach 하면 tmux 가 화면 크기를 클라이언트끼리 공유해(작은 기기 기준 점선
//  여백) 어느 기기도 풀사이즈를 못 쓴다 → 기기마다 자기 세션 = 자기 크기.
function paneSession(primary, paneId, client) {
  const base = primary + '--p-' + String(paneId).replace(/[^A-Za-z0-9_-]+/g, '-');
  const c = client ? String(client).replace(/[^A-Za-z0-9_-]+/g, '-') : '';
  return c ? base + '--c-' + c : base;
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

  ws.on('open', async () => {
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

    // 기기 키 — pane 세션을 기기별로 분리(기기마다 자기 화면 크기로 풀 사용).
    const client = params && params.client ? String(params.client) : '';

    let spawnArgs;
    if (paneId) {
      // 공유 풀 모델: 터미널 실체 = primary(풀) 세션의 window(전 기기 공유), pane = 이 기기 전용
      //  뷰 세션(link-window 로 풀 window 를 골라 표시). 배치는 기기별, 내역/내용은 전 기기 공유.
      const psess = paneSession(session, paneId, client);
      const selWin = (params && Number.isInteger(params.win)) ? params.win : 0;
      try {
        await ensurePool(session, abs);
        await ensureView(psess, session, selWin, abs);
      } catch (e) {
        try { ws.send(`\r\n\x1b[31m터미널 준비 실패: ${e.message}\x1b[0m\r\n`); ws.close(); } catch (_) { /* noop */ }
        return;
      }
      // -u: UTF-8. -d: 다른 클라이언트 detach — 죽은 앱/이전 스트림의 스테일 클라이언트가 남아
      //  화면 크기를 물고 늘어지는 것(점선 여백)을 자가치유. 세션은 ensureView 가 보장했다.
      spawnArgs = ['-L', TMUX_SOCKET, '-u', 'attach-session', '-d', '-t', psess, ';', 'set', '-g', 'window-size', 'latest'];
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

// ── 공유 터미널 풀 헬퍼 ──
// 풀(primary) 세션 보장 — 워크스페이스의 공유 터미널 풀. 없으면 detached 생성(window 0 = 첫 터미널).
async function ensurePool(session, abs) {
  try { await runTmux(['has-session', '-t', '=' + session]); return false; } catch (_) { /* 생성 */ }
  await runTmux([...CONF_ARGS, 'new-session', '-d', '-s', session, '-c', abs]);
  await runTmux(['rename-window', '-t', `${session}:0`, '터미널 1']).catch(() => {});
  return true;
}

// 풀 window 목록: [{index, name, command, id}] — 세션 미존재면 [].
async function poolWindows(session) {
  let out;
  try {
    out = await runTmux(['list-windows', '-t', session, '-F', '#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_id}']);
  } catch (_) { return []; }
  return out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((l) => {
    const p = l.split('\t');
    return { index: parseInt(p[0], 10) || 0, name: p[1] || '', command: (p[2] || '').trim(), id: p[3] || '' };
  });
}

// 다음 터미널 이름("터미널 N") — 이름이 tmux window 에 저장돼 전 기기 동일하게 보인다.
function nextPoolName(wins) {
  let max = 0;
  for (const w of wins) {
    const m = /^터미널 (\d+)$/.exec(w.name || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return '터미널 ' + (max + 1);
}

// pane 뷰 세션 보장 + 풀 window(win) 를 같은 인덱스로 link + select.
//  · 풀 window 가 없으면(스테일 win 자가치유) 그 인덱스에 새 터미널을 만든다.
//  · 뷰 세션 최초 생성 시 기본 셸(window 0)은 999 로 파킹했다가 링크 후 제거(불필요 셸 잔재 방지).
//  · 슬롯 인덱스 = 풀 인덱스(매핑 불필요). 같은 슬롯에 다른 window 가 링크돼 있으면 교체.
async function ensureView(psess, session, win, abs) {
  let wins = await poolWindows(session);
  let target = wins.find((w) => w.index === win);
  if (!target) {
    await runTmux(['new-window', '-d', '-t', `${session}:${win}`, '-n', nextPoolName(wins), '-c', abs]);
    wins = await poolWindows(session);
    target = wins.find((w) => w.index === win);
    if (!target) throw new Error('터미널 window 확보 실패');
  }
  try {
    await runTmux(['has-session', '-t', '=' + psess]);
  } catch (_) {
    await runTmux(['new-session', '-d', '-s', psess, '-c', abs]);
    await runTmux(['move-window', '-s', `${psess}:0`, '-t', `${psess}:999`]).catch(() => {});
  }
  const slotOut = await runTmux(['list-windows', '-t', psess, '-F', '#{window_index}\t#{window_id}']).catch(() => '');
  const slots = slotOut.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const slot = slots.find((p) => (parseInt(p[0], 10) || 0) === win);
  if (slot && slot[1] !== target.id) await runTmux(['unlink-window', '-t', `${psess}:${win}`]).catch(() => {});
  if (!slot || slot[1] !== target.id) await runTmux(['link-window', '-s', `${session}:${win}`, '-t', `${psess}:${win}`]);
  await runTmux(['select-window', '-t', `${psess}:${win}`]);
  // temp(999) 정리 — 링크가 하나 이상 있으니 안전(999 는 이 세션 전용 셸이라 전역 kill 무해).
  if (slots.some((p) => (parseInt(p[0], 10) || 0) === 999) || !slot) {
    await runTmux(['kill-window', '-t', `${psess}:999`]).catch(() => {});
  }
}

// terminal.* — 공유 풀 모델: 터미널 실체=풀(primary) window(전 기기 공유), pane=기기별 뷰 세션(링크).
//  list/new/close = 풀 대상(전 기기 공통 내역). select(view)/unview = 이 기기 pane 뷰 대상.
async function handleTerminalRpc(method, params) {
  const { session, abs } = sessionForCwd(params && params.cwd);
  const paneId = params && params.paneId ? String(params.paneId) : '';
  const client = params && params.client ? String(params.client) : '';
  const psess = paneId ? paneSession(session, paneId, client) : session;
  if (method === 'terminal.list') {
    // 공유 풀의 window 목록 — 모든 기기 "내역"의 원천(이름 포함).
    const wins = await poolWindows(session);
    return { windows: wins.map((w) => ({ index: w.index, name: w.name, command: w.command })) };
  }
  if (method === 'terminal.new') {
    // 풀에 새 터미널 생성(전 기기에 나타남). 풀이 없으면 생성된 window 0 이 곧 새 터미널.
    const created = await ensurePool(session, abs);
    if (created) return { index: 0, name: '터미널 1' };
    const wins = await poolWindows(session);
    const name = nextPoolName(wins);
    const out = await runTmux(['new-window', '-d', '-t', session, '-n', name, '-c', abs, '-P', '-F', '#{window_index}']);
    return { index: parseInt(out.trim(), 10) || 0, name };
  }
  if (method === 'terminal.select') {
    // = view: 이 pane 뷰 세션에 풀 window 를 링크 + 선택(탭 전환/드롭 이동 공용).
    const win = (params && params.index) | 0;
    if (!paneId) { await runTmux(['select-window', '-t', `${session}:${win}`]); return { ok: true }; }
    await ensurePool(session, abs);
    await ensureView(psess, session, win, abs);
    return { ok: true };
  }
  if (method === 'terminal.unview') {
    // pane 에서 탭 제거(풀 window 는 보존) — 드래그 이동의 src 측/레이아웃 정리.
    const win = (params && params.index) | 0;
    try {
      const n = (await runTmux(['list-windows', '-t', psess, '-F', 'x'])).split('\n').filter(Boolean).length;
      if (n <= 1) await runTmux(['kill-session', '-t', psess]);
      else await runTmux(['unlink-window', '-t', `${psess}:${win}`]);
    } catch (_) { /* 세션 없음 = 이미 정리됨 */ }
    return { ok: true };
  }
  if (method === 'terminal.close') {
    // 풀에서 완전 삭제(전 기기 공통). 모든 뷰에서 사라지고, 마지막 링크였던 뷰 세션은 자동 소멸.
    await runTmux(['kill-window', '-t', `${session}:${(params && params.index) | 0}`]);
    return { ok: true };
  }
  throw new Error('unknown terminal method: ' + method);
}

module.exports = { openPtyStream, findTmux, handleTerminalRpc, TMUX_SOCKET, TMUX_SESSION };
