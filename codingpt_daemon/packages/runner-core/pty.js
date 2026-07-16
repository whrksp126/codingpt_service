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

// 스폰 실패 쿨다운 — node-pty 는 스폰 실패 경로에서 pty 마스터 fd 를 누수한다. 웹뷰 자동 재접속
//  (1~10s)과 결합하면 실패가 실패를 낳는 나선(pty 고갈 고착, 실측 75분에 마스터 459개 누수)이 되므로,
//  직전 스폰 실패 후 잠시는 스폰 시도 자체를 거부한다.
let lastSpawnFailAt = 0;

// back 지시(stream_open)에 대한 dial-back. 실패 시 throw → control 이 stream_fail 회신.
function openPtyStream({ serverUrl, deviceToken }, { streamToken, params }) {
  const tmux = findTmux();
  if (!tmux) throw new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)');

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });

  // 셋업(풀/뷰 준비·pty 스폰) 완료 전에 도착한 메시지 버퍼 — 클라이언트는 open 직후 곧바로 첫
  //  resize 를 보내는데, 실제 핸들러가 셋업 뒤에 붙으면 그 메시지가 통째로 유실된다. 유실되면
  //  창/클라이언트가 80x24 로 남고(keepalive 25s 가 올 때까지), select 리사이즈가 그 스테일 크기로
  //  동작해 실크기 리사이즈와 핑퐁 → 셸 프롬프트 무한 누적(실측 근원).
  const earlyMsgs = [];
  let onMsg = (data, isBinary) => { earlyMsgs.push([data, isBinary]); };
  ws.on('message', (d, b) => onMsg(d, b));

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
    // 실제 표시 중인 window 인덱스 — 재접속 시 URL 의 params.win 은 서버 재시작 전 인덱스라 스테일할
    //  수 있고, ensureView 가 풀 첫 터미널로 폴백하면 인덱스가 바뀐다. 리사이즈는 반드시 이 값 기준.
    let resolvedWin = (params && Number.isInteger(params.win)) ? params.win : 0;
    const psess = paneId ? paneSession(session, paneId, client) : '';
    if (paneId) {
      // 공유 풀 모델: 터미널 실체 = primary(풀) 세션의 window(전 기기 공유), pane = 이 기기 전용
      //  뷰 세션(link-window 로 풀 window 를 골라 표시). 배치는 기기별, 내역/내용은 전 기기 공유.
      const selWin = resolvedWin;
      try {
        await ensurePool(session, abs);
        resolvedWin = await ensureView(psess, session, selWin, abs);
      } catch (e) {
        try { ws.send(`\r\n\x1b[31m터미널 준비 실패: ${e.message}\x1b[0m\r\n`); ws.close(); } catch (_) { /* noop */ }
        return;
      }
      // -u: UTF-8. -d: 다른 클라이언트 detach — 죽은 앱/이전 스트림의 스테일 클라이언트가 남아
      //  화면 크기를 물고 늘어지는 것(점선 여백)을 자가치유. 세션은 ensureView 가 보장했다.
      spawnArgs = ['-L', TMUX_SOCKET, '-u', 'attach-session', '-d', '-t', '=' + psess, ';', 'set', '-g', 'window-size', 'latest'];
    } else {
      // 하위호환(paneId 없음): 기존 공유 세션에 직접 attach.
      spawnArgs = ['-L', TMUX_SOCKET, '-u', ...CONF_ARGS, 'new-session', '-A', '-s', session, '-c', abs, ';', 'set', '-g', 'window-size', 'latest'];
    }

    // 쿨다운 중이면 스폰 시도 없이 거절 — 실패 스폰마다 pty 마스터가 새는 것을 차단.
    if (Date.now() - lastSpawnFailAt < 3000) {
      try { ws.send('\r\n\x1b[33m터미널 준비 중입니다. 잠시 후 다시 연결돼요.\x1b[0m\r\n'); ws.close(); } catch (_) { /* noop */ }
      return;
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
      lastSpawnFailAt = Date.now();
      console.error(`[pty] 스폰 실패(3초 쿨다운 진입): ${e.message}`);
      try { ws.send(`\r\n\x1b[31m터미널 생성 실패: ${e.message}\x1b[0m\r\n`); ws.close(); } catch (_) { /* noop */ }
      return;
    }
    console.log(`[pty] 스트림 연결 (session=${session}${paneId ? ' view=' + viewSession(session, paneId) : ''}, cwd=${abs}, ${cols}x${rows})`);

    // 웹뷰가 fit 후 보내는 "첫" resize 크기로 표시 중인 window 를 맞춘다 — attach 직후엔 기본
    //  80x24 라 클라이언트 크기 조회가 이르고(80x24 로 고정되는 사고), 첫 resize 가 실제 pane 크기다.
    //  타깃은 resolvedWin(ensureView 폴백 반영) — 스테일 params.win 을 쓰면 없는 창에 쏴서
    //  새 창이 기본 크기(80x24)로 남는다(점선 반쪽 화면).
    const selForResize = resolvedWin;
    let firstResizeDone = !paneId;
    // 첫 resize 를 attach 안정화 후 재적용(nudge) — 첫 resize 가 tmux 클라이언트 초기화와 겹치면
    //  클라이언트 크기가 80x24 로 고착된다(같은 크기 재-ioctl 은 SIGWINCH 가 안 나가므로 한 칸
    //  줄였다 되돌려 강제로 다시 읽힌다). 고착되면 이 클라이언트에 80x24 화면만 그려지는(반쪽 화면)
    //  사고가 난다. 창 크기는 첫 resize 에서 manual 로 고정된 뒤라 nudge 는 클라이언트만 건드린다.
    let nudgeTimer = null;
    // 마지막으로 반영한 클라이언트 크기 — 크기가 "변할 때"만 표시 창을 따라 리사이즈한다.
    //  (키보드 노출/pane 분할선 드래그로 이 기기 화면이 바뀌면 창도 즉시 따라와야 TUI(claude 등)가
    //   이 기기 크기로 다시 그린다. keepalive 는 같은 크기를 재전송하므로 여기서 걸러진다 —
    //   안 거르면 25초마다 다른 기기가 잡아둔 크기를 도로 뺏는 플래핑이 된다.)
    let lastW = 0, lastH = 0;

    pty.onData((data) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (_) { /* noop */ }
    });
    pty.onExit(({ exitCode }) => {
      console.log(`[pty] tmux 클라이언트 종료 exitCode=${exitCode}`);
      try { ws.close(); } catch (_) { /* noop */ }
    });

    onMsg = (data, isBinary) => {
      if (isBinary) {
        try { pty.write(data.toString('utf8')); } catch (_) { /* noop */ }
        return;
      }
      const str = data.toString();
      try {
        const m = JSON.parse(str);
        if (m && m.type === 'resize' && m.cols && m.rows) {
          const w = m.cols | 0, h = m.rows | 0;
          try { pty.resize(w, h); } catch (_) { /* noop */ }
          // 이 pane 클라이언트의 실제 크기를 기록 — select(claim) 리사이즈가 tmux 클라이언트 크기
          //  조회 대신 이 값을 쓴다(attach 레이스로 클라이언트가 80x24 로 고착돼 있어도 정확).
          if (psess) paneClientSize.set(psess, { w, h });
          if (!firstResizeDone) {
            firstResizeDone = true;
            lastW = w; lastH = h;
            if (nudgeTimer) clearTimeout(nudgeTimer);
            nudgeTimer = setTimeout(() => {
              try { pty.resize(Math.max(2, lastW - 1), lastH); pty.resize(lastW, lastH); } catch (_) { /* noop */ }
            }, 600);
            // 부팅 초기화는 "아무도 안 잡은(virgin)" 창에만 — resize-window 를 거친 창은 window-size
            //  옵션이 manual 로 남으므로, 이미 어떤 기기가 잡은 창을 백그라운드 기기의 재접속이
            //  도로 뺏지 않는다(크기 주장은 포커스/조작 시점의 select 가 담당).
            (async () => {
              try {
                const mode = (await runTmux(['show-options', '-wv', '-t', `=${session}:${selForResize}`, 'window-size']).catch(() => '')).trim();
                if (mode !== 'manual') await runTmux(['resize-window', '-t', `=${session}:${selForResize}`, '-x', String(w), '-y', String(h)]);
              } catch (_) { /* noop */ }
            })();
          } else if (psess && (w !== lastW || h !== lastH)) {
            lastW = w; lastH = h;
            // 이 pane 이 "현재 보고 있는" 창을 이 기기 크기로 — 탭 전환으로 창이 바뀌었을 수 있으니
            //  뷰 세션의 활성 창을 조회해 리사이즈(창은 풀과 공유 객체라 어느 쪽으로 잡아도 동일).
            //  주의: display-message -t <세션> 은 빈 값을 주는 경우가 있어 list-windows 로 조회한다.
            (async () => {
              try {
                const out = await runTmux(['list-windows', '-t', '=' + psess, '-F', '#{window_index} #{window_active}']);
                const line = out.split('\n').find((l) => /\s1\s*$/.test(l));
                const idx = line ? line.trim().split(/\s+/)[0] : '';
                if (/^\d+$/.test(idx)) await runTmux(['resize-window', '-t', `=${psess}:${idx}`, '-x', String(w), '-y', String(h)]);
              } catch (_) { /* 세션 소멸 등 — 다음 select 에서 보정 */ }
            })();
          }
          return;
        }
      } catch (_) { /* JSON 아니면 일반 입력 */ }
      try { pty.write(str); } catch (_) { /* noop */ }
    };
    // 셋업 중 버퍼된 메시지(첫 resize 등)를 순서대로 재생.
    for (const [d, b] of earlyMsgs.splice(0)) onMsg(d, b);

    const cleanup = () => {
      // tmux 클라이언트만 종료(detach) — 세션은 tmux 서버에 살아남는다.
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
      try { pty.kill(); } catch (_) { /* noop */ }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  ws.on('error', (e) => console.error(`[pty] 스트림 WS 오류: ${e.message}`));
}

// pane 뷰 세션별 "스트림이 보고한" 클라이언트 크기 — psess → {w,h}.
//  tmux list-clients 는 attach 레이스로 스테일(80x24)일 수 있어 select 리사이즈의 원천으로 못 쓴다.
const paneClientSize = new Map();

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
// 주의: tmux -t 는 접두사 매칭 — 풀 세션이 없을 때 이름을 확장한 뷰 세션(--p-...)이 대신 매칭돼
//  명령이 엉뚱한 세션에 떨어진다. 세션 타겟은 반드시 '=' 정확 일치로 지정한다(이 파일 전체 규칙).
async function ensurePool(session, abs) {
  try {
    await runTmux(['has-session', '-t', '=' + session]);
    await injectPoolEnv(session, abs); // 기존 세션에도 cpt 좌표 env 보장(멱등)
    return false;
  } catch (_) { /* 생성 */ }
  try {
    await runTmux([...CONF_ARGS, 'new-session', '-d', '-s', session, '-c', abs]);
  } catch (e) {
    // 여러 스트림이 동시에 풀을 만들려는 레이스 — 이미 생겼으면 성공으로 간주.
    if (!/duplicate session/.test(String(e.message || ''))) throw e;
    await injectPoolEnv(session, abs).catch(() => {});
    return false;
  }
  await runTmux(['rename-window', '-t', `=${session}:0`, '터미널 1']).catch(() => {});
  await injectPoolEnv(session, abs).catch(() => {});
  return true;
}

// 풀 세션 환경에 cpt CLI 좌표 주입 — 이후 이 세션에서 생성되는 모든 window 의 셸이 상속한다.
//  CPT_WS = 워크스페이스(홈-상대 경로), CPT_SOCK = cpt 컨트롤 소켓, CPT_TMUX = tmux 바이너리(번들 대응),
//  PATH prepend(~/.codingpt/bin) 는 shim(P5)이 담당 — 여기서는 좌표만.
//  이미 떠 있는 셸은 env 변경을 못 받으므로 CLI 쪽에 show-environment 폴백이 있다.
const poolEnvDone = new Set(); // 세션당 1회(데몬 수명 동안) — set-environment 반복 호출 절약
async function injectPoolEnv(session, abs) {
  if (poolEnvDone.has(session)) return;
  const rel = fsLib.relOf ? fsLib.relOf(abs) : '';
  const sock = path.join(runtime.stateDir(), 'cpt.sock');
  const tmuxBin = findTmux();
  await runTmux(['set-environment', '-t', '=' + session, 'CPT_WS', rel == null ? '' : String(rel)]);
  await runTmux(['set-environment', '-t', '=' + session, 'CPT_SOCK', sock]);
  if (tmuxBin) await runTmux(['set-environment', '-t', '=' + session, 'CPT_TMUX', tmuxBin]);
  poolEnvDone.add(session);
}

// 풀 window 목록: [{index, name, command, id}] — 세션 미존재면 [].
async function poolWindows(session) {
  let out;
  try {
    out = await runTmux(['list-windows', '-t', '=' + session, '-F', '#{window_index}\t#{window_name}\t#{pane_current_command}\t#{window_id}']);
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
    // 재생성 금지 — "그 인덱스에 창을 다시 만들면" 다른 기기가 닫은 터미널이 스테일 참조/웹뷰
    //  자동 재연결마다 부활한다(1개만 남겨도 잠시 후 3개). 죽은 win 은 풀의 첫 터미널로 폴백하고,
    //  레이아웃 정리는 리컨실러가 한다. 풀이 완전히 비었을 때만 새 터미널 1개 생성.
    if (!wins.length) {
      await runTmux(['new-window', '-d', '-t', `=${session}:0`, '-n', '터미널 1', '-c', abs]).catch(() => {});
      wins = await poolWindows(session);
    }
    target = wins[0];
    if (!target) throw new Error('터미널 window 확보 실패');
    win = target.index;
  }
  try {
    await runTmux(['has-session', '-t', '=' + psess]);
  } catch (_) {
    try {
      await runTmux(['new-session', '-d', '-s', psess, '-c', abs]);
    } catch (e) {
      if (!/duplicate session/.test(String(e.message || ''))) throw e;
    }
    await runTmux(['move-window', '-s', `=${psess}:0`, '-t', `=${psess}:999`]).catch(() => {});
  }
  const slotOut = await runTmux(['list-windows', '-t', '=' + psess, '-F', '#{window_index}\t#{window_id}']).catch(() => '');
  const slots = slotOut.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const slot = slots.find((p) => (parseInt(p[0], 10) || 0) === win);
  if (slot && slot[1] !== target.id) await runTmux(['unlink-window', '-t', `=${psess}:${win}`]).catch(() => {});
  if (!slot || slot[1] !== target.id) await runTmux(['link-window', '-s', `=${session}:${win}`, '-t', `=${psess}:${win}`]);
  await runTmux(['select-window', '-t', `=${psess}:${win}`]);
  // temp(999) 정리 — 링크가 하나 이상 있으니 안전(999 는 이 세션 전용 셸이라 전역 kill 무해).
  if (slots.some((p) => (parseInt(p[0], 10) || 0) === 999) || !slot) {
    await runTmux(['kill-window', '-t', `=${psess}:999`]).catch(() => {});
  }
  return win; // 폴백으로 바뀌었을 수 있는 실제 표시 인덱스 — 호출측 리사이즈 타깃
}

// pane 뷰 세션의 클라이언트 크기로 풀 window 를 맞춘다 — "마지막 입력"이 아니라 "포커스" 기준 리사이즈.
//  resize-window 는 그 window 를 manual 크기로 고정하므로 이후 크기는 오직 포커스(select) 이동으로만 바뀐다.
async function resizeToClient(psess, session, win) {
  try {
    // 스트림이 보고한 실제 크기 우선 — tmux 클라이언트 크기는 attach 레이스로 80x24 에 고착될 수
    //  있어(첫 resize 유실), 그걸 믿으면 select(claim)마다 창을 80x24 로 줄여 스트림 리사이즈와
    //  핑퐁하며 셸 프롬프트가 무한 누적된다(실측 근원).
    let w = 0, h = 0;
    const known = paneClientSize.get(psess);
    if (known) { w = known.w; h = known.h; }
    else {
      const out = await runTmux(['list-clients', '-t', '=' + psess, '-F', '#{client_width} #{client_height}']);
      const first = out.split('\n').filter(Boolean)[0];
      if (!first) return;
      [w, h] = first.trim().split(/\s+/).map((n) => parseInt(n, 10));
    }
    if (!(w > 0 && h > 0)) return;
    // 이미 같은 크기면 스킵 — 같은 기기의 반복 터치(스크롤 등)가 매번 resize-window 를 때리면
    //  다른 기기와 크기 주장이 교차할 때 SIGWINCH 가 반복돼 셸 프롬프트가 스크롤백에 쌓인다.
    const cur = await runTmux(['list-windows', '-t', '=' + session, '-F', '#{window_index} #{window_width} #{window_height}']).catch(() => '');
    const line = cur.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => (parseInt(p[0], 10) || 0) === win);
    if (line && parseInt(line[1], 10) === w && parseInt(line[2], 10) === h) return;
    await runTmux(['resize-window', '-t', `=${session}:${win}`, '-x', String(w), '-y', String(h)]);
  } catch (_) { /* 클라이언트 미접속 등 — 다음 포커스에서 보정 */ }
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
    if (created) {
      if (paneId) await resizeToClient(psess, session, 0);
      return { index: 0, name: '터미널 1' };
    }
    const wins = await poolWindows(session);
    const name = nextPoolName(wins);
    const out = await runTmux(['new-window', '-d', '-t', '=' + session, '-n', name, '-c', abs, '-P', '-F', '#{window_index}']);
    const index = parseInt(out.trim(), 10) || 0;
    // 요청 pane 의 클라이언트 크기로 즉시 맞춤 — 기본 크기(80x24)→실크기 리사이즈로 새 터미널에
    //  재프롬프트가 쌓이는 것("내역처럼 보임")을 방지.
    if (paneId) await resizeToClient(psess, session, index);
    return { index, name };
  }
  if (method === 'terminal.select') {
    // = view: 이 pane 뷰 세션에 풀 window 를 링크 + 선택(탭 전환/포커스/드롭 이동 공용).
    //  claim=true(사용자 터치/포커스/탭 클릭)일 때만 이 pane 클라이언트 크기로 리사이즈.
    //  자동 경로(리컨실러 반영·재접속 보정 등)가 크기를 주장하면 기기 간 크기 뺏기가 반복돼
    //  셸이 SIGWINCH 마다 프롬프트를 다시 찍어 스크롤백에 쌓인다 — 뷰 전환만 수행한다.
    const win = (params && params.index) | 0;
    // claim 필드가 아예 없으면(구버전 백엔드가 필드를 안 넘김) 현행 동작(true) 유지 — 롤아웃 호환.
    const claim = params && 'claim' in params ? !!params.claim : true;
    if (!paneId) { await runTmux(['select-window', '-t', `=${session}:${win}`]); return { ok: true }; }
    await ensurePool(session, abs);
    // 리사이즈는 ensureView 가 실제로 링크한 인덱스 기준 — 요청 인덱스가 스테일(서버 재시작/타 기기
    //  삭제)이면 폴백된 창이 표시되는데, 스테일 인덱스로 resize 하면 표시 창이 기본 크기로 남는다.
    const resolved = await ensureView(psess, session, win, abs);
    if (claim) await resizeToClient(psess, session, resolved);
    return { ok: true, index: resolved };
  }
  if (method === 'terminal.unview') {
    // pane 에서 탭 제거(풀 window 는 보존) — 드래그 이동의 src 측/레이아웃 정리.
    const win = (params && params.index) | 0;
    try {
      const n = (await runTmux(['list-windows', '-t', '=' + psess, '-F', 'x'])).split('\n').filter(Boolean).length;
      if (n <= 1) await runTmux(['kill-session', '-t', '=' + psess]);
      else await runTmux(['unlink-window', '-t', `=${psess}:${win}`]);
    } catch (_) { /* 세션 없음 = 이미 정리됨 */ }
    return { ok: true };
  }
  if (method === 'terminal.close') {
    // 풀에서 완전 삭제(전 기기 공통). 모든 뷰에서 사라지고, 마지막 링크였던 뷰 세션은 자동 소멸.
    //  멱등 처리: 마지막 창을 닫으면 tmux 서버 자체가 죽으므로, 연달아 닫는 요청/이미 사라진 창은
    //  "no server running"/"can't find window" 로 실패한다 — 이미 닫힌 것이니 성공으로 간주.
    try {
      await runTmux(['kill-window', '-t', `=${session}:${(params && params.index) | 0}`]);
    } catch (e) {
      const msg = String(e.message || '');
      if (!/no server running|can't find window|session not found/i.test(msg)) throw e;
    }
    return { ok: true };
  }
  throw new Error('unknown terminal method: ' + method);
}

module.exports = { openPtyStream, findTmux, handleTerminalRpc, runTmux, poolWindows, sessionForCwd, TMUX_SOCKET, TMUX_SESSION };
