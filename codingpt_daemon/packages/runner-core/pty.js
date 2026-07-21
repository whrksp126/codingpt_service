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

// tmux -L codingpt (사용자 기본 tmux 서버와 격리). 기본은 'codingpt' — 프로덕션은 이 값을 절대
//  바꾸지 않는다. 격리 소켓(재연결 레이스 재현 테스트 등)만 CODINGPT_TMUX_SOCKET 로 덮어써 실사용
//  세션을 건드리지 않고 검증한다.
const TMUX_SOCKET = process.env.CODINGPT_TMUX_SOCKET || 'codingpt';
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

// pane 별 "독립" 세션명(레거시 — 리퍼 대상 식별에만 사용). 구 아키텍처(공유 풀 window + 기기별
//  뷰 세션 link-window)의 잔재로, 신 아키텍처(아래 termSession)는 뷰 세션을 아예 만들지 않는다.
function paneSession(primary, paneId, client) {
  const base = primary + '--p-' + String(paneId).replace(/[^A-Za-z0-9_-]+/g, '-');
  const c = client ? String(client).replace(/[^A-Za-z0-9_-]+/g, '-') : '';
  return c ? base + '--c-' + c : base;
}

// ── 터미널 = 전용 tmux 세션(신 아키텍처) ──────────────────────────────────
// 터미널 하나 = 자기 세션 "<ns>--t-<tid>" 하나(window 0 하나). ns = 워크스페이스 네임스페이스
//  (구 풀 세션명 'cpt-<ws>'). tid = 안정적 숫자 ID(랜덤 31-bit — 와이어/영속의 기존 "win 숫자" 자리에
//  그대로 실려 앱/백엔드 무수정, `|0` 을 쓰는 구 코드와도 안전).
//
// 이 모델이 "can't find window/session" 재발 클래스를 구조적으로 없애는 이유:
//  · 링크/인덱스/뷰세션 간접층이 없다 — attach 대상이 곧 터미널 실체라 중간 상태가 존재하지 않는다.
//  · 터미널 세션은 리퍼가 절대 건드리지 않는다(리퍼는 레거시 뷰 패턴만) — 앱이 몇 분을 죽어 있어도
//    tmux 서버가 durable 목록(세션들)을 그대로 보존하고, 재실행은 이름으로 다시 attach 만 한다.
//  · 세션이 없다 = 사용자가 명시적으로 닫았다(kill-session) — 에러가 아니라 결정적 상태다.
function termSession(ns, tid) {
  return ns + '--t-' + String(tid);
}
// 레거시 작은 인덱스(0~수십)와 절대 안 겹치게 1e6 이상. 31-bit 안이라 `|0` 경유에도 불변.
function newTid() {
  return 1000000 + Math.floor(Math.random() * (0x7fffffff - 1000000));
}

// 워크스페이스의 터미널 목록 — [{index(tid), name, command, session}] 생성순 정렬.
//  window name(자동 개명)이 곧 전 기기 공유 탭 이름. 서버 없음/오류 = [].
async function listTerminals(ns) {
  let out;
  try {
    out = await runTmux(['list-windows', '-a', '-F', '#{session_name}\t#{session_created}\t#{window_name}\t#{pane_current_command}']);
  } catch (_) { return []; }
  const prefix = ns + '--t-';
  const rows = [];
  const seen = new Set();
  for (const l of out.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const [sname, created, wname, cmd] = l.split('\t');
    if (!sname || !sname.startsWith(prefix)) continue;
    if (seen.has(sname)) continue; // 세션당 첫 window 만(사용자가 tmux 로 window 를 더 만들어도 1터미널)
    seen.add(sname);
    const tid = parseInt(sname.slice(prefix.length), 10);
    if (!Number.isFinite(tid)) continue;
    rows.push({ index: tid, name: wname || '', command: (cmd || '').trim(), session: sname, created: parseInt(created, 10) || 0 });
  }
  rows.sort((a, b) => (a.created - b.created) || (a.index - b.index));
  return rows;
}

// new-session 시점에 초기 셸에 바로 넣을 env(-e KEY=VAL) 목록.
//  ⚠ 핵심: set-environment(injectPoolEnv)는 "이미 뜬 셸"엔 안 먹는다(tmux 세션 env 는 이후 spawn 되는
//  프로세스만 상속). new-session 은 셸을 즉시 띄우므로, 나중에 set-environment 를 해도 그 초기 셸은
//  ZDOTDIR/PATH 를 못 받아 shim(open/claude/cpt PATH 프리펜드)이 비활성이 된다(실측: bare `open` →
//  /usr/bin/open). 그래서 spawn 시점에 -e 로 직접 넣어 초기 셸부터 shim 을 활성화한다. injectPoolEnv 는
//  세션 env 영속(재spawn/attach 대비)용으로 그대로 유지(멱등).
function poolEnvArgs(abs) {
  const out = [];
  const push = (k, v) => { out.push('-e', `${k}=${v}`); };
  try {
    const rel = fsLib.relOf ? fsLib.relOf(abs) : '';
    push('CPT_WS', rel == null ? '' : String(rel));
    push('CPT_SOCK', require('./cpt-server').sockPath());
    const tmuxBin = findTmux();
    if (tmuxBin) push('CPT_TMUX', tmuxBin);
    const shimBin = path.join(runtime.stateDir(), 'bin');
    push('PATH', `${shimBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`);
    const zdot = require('./shim').zdotDir();
    if (fs.existsSync(zdot)) {
      push('ZDOTDIR', zdot);
      const origZdot = process.env.ZDOTDIR || '';
      if (origZdot && origZdot !== zdot) push('CPT_ORIG_ZDOTDIR', origZdot);
    }
  } catch (_) { /* shim 미생성 등 — 넣을 수 있는 것만 */ }
  return out;
}

// 새 터미널 생성 — 전용 세션 detached 생성(+서버 첫 기동이면 conf 로드) + cpt env 주입.
//  tid 는 랜덤 31-bit — 극히 드문 기존 세션과의 충돌은 새 tid 로 재시도(기존 터미널 무접촉).
async function createTerminal(ns, abs) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newTid();
    const name = termSession(ns, id);
    try {
      await runTmux([...CONF_ARGS, 'new-session', '-d', '-s', name, '-c', abs, ...poolEnvArgs(abs)]);
    } catch (e) {
      lastErr = e;
      if (/duplicate session/.test(String(e.message || ''))) continue; // tid 충돌 — 재시도
      throw e;
    }
    await injectPoolEnv(name, abs).catch(() => {});
    await ensureAutoRename(name).catch(() => {});
    const w = (await poolWindows(name))[0];
    return { index: id, name: (w && w.name) || '', session: name };
  }
  throw lastErr || new Error('터미널 생성 실패');
}

// 레거시 공유 풀(cpt-<ws> 세션의 window들) → 전용 세션 마이그레이션. move-window 라 실행 중인
//  셸/프로세스가 그대로 보존된다(앱 업데이트 직후 첫 호출에서 1회 수행, 멱등).
//  동시 실행(PC Rust 미러와 경쟁) 안전: window 이동은 tmux 서버에서 원자적 — 진 쪽은 자기가 만든
//  빈 세션만 회수한다. 창을 전부 옮기면 풀 세션은 tmux 가 자동 소멸시킨다.
const migratedNs = new Set(); // 프로세스 수명 동안 ns 당 1회(풀 부재 확인 후 캐시)
async function migrateLegacyPool(ns, abs) {
  if (migratedNs.has(ns)) return;
  // 홈 공유 세션(codingpt)은 풀이 아니라 레거시 직결 attach 세션(Mac attach 하위호환) — 옮기지 않는다.
  if (ns === TMUX_SESSION) { migratedNs.add(ns); return; }
  try { await runTmux(['has-session', '-t', '=' + ns]); } catch (_) { migratedNs.add(ns); return; }
  const wins = await poolWindows(ns);
  // 생성순(원래 인덱스순) 보존: 같은 초에 만들어져도 tid 오름차순이 원래 순서가 되게 연속 부여.
  //  기존 --t- tid 와의 충돌 회피 필수 — 충돌하면 아래 move-window -k 가 기존 터미널을 덮어쓴다.
  const taken = new Set((await listTerminals(ns)).map((t) => t.index));
  let base = newTid();
  for (let guard = 0; guard < 32; guard++) {
    const clash = wins.some((_, i) => taken.has(base + i)) || base + wins.length > 0x7fffffff;
    if (!clash) break;
    base = newTid();
  }
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    const name = termSession(ns, base + i);
    try {
      await runTmux(['new-session', '-d', '-s', name, '-c', abs, ...poolEnvArgs(abs)]);
      await runTmux(['move-window', '-k', '-s', `=${ns}:${w.index}`, '-t', `=${name}:0`]);
      // 구 모델의 resize-window 가 남긴 manual 고정 해제 → 전역 window-size latest 로 복귀.
      await runTmux(['set-option', '-w', '-u', '-t', `=${name}:0`, 'window-size']).catch(() => {});
      await injectPoolEnv(name, abs).catch(() => {});
    } catch (_) {
      // 다른 액터가 먼저 옮겼거나 창이 사라짐 — 내가 만든 자리(빈 세션)만 회수.
      await runTmux(['kill-session', '-t', '=' + name]).catch(() => {});
    }
  }
  migratedNs.add(ns);
}

// 요청 tid 확정 — 살아있으면 그대로, 죽었으면(닫힘/구버전 인덱스) 첫 터미널 폴백.
//  터미널이 하나도 없으면 null — 여기서 "생성"하면 안 된다: 죽은 pane 의 자동 재접속이 닫은
//  터미널을 유령으로 부활시킨다(터미널 0개 = 정식 상태, 생성은 terminal.new/시드의 명시 경로만).
async function resolveTid(ns, want) {
  const tid = Number(want);
  if (Number.isFinite(tid) && tid > 0) {
    try { await runTmux(['has-session', '-t', '=' + termSession(ns, tid)]); return tid; } catch (_) { /* 폴백 */ }
  }
  const list = await listTerminals(ns);
  return list.length ? list[0].index : null;
}

// pane 스트림 레지스트리 — terminal.select 가 "그 pane 의 살아있는 스트림"의 attach 대상을 즉석
//  교체(swap)할 수 있게 한다(뷰 세션 select-window 의 대체). key = ns|paneId|client.
const paneStreams = new Map(); // key -> { tid, swap(tid) }
// pane 이 마지막으로 본 터미널 — 재접속(스트림 재수립) 시 select 이후 상태를 이어받는다.
const paneCurrent = new Map(); // key -> tid
function paneKeyOf(ns, paneId, client) {
  return ns + '|' + String(paneId || '') + '|' + String(client || '');
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
    // Nagle off — pty 출력(에코)이 작은 프레임이라 Nagle 이 매 키마다 지연을 얹는다(모바일 타자 렉).
    try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ }
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
    // 진입한 워크스페이스 경로에 맞는 네임스페이스/시작폴더 결정.
    const { session, abs } = sessionForCwd(params && params.cwd);
    const paneId = params && params.paneId ? String(params.paneId).replace(/[^A-Za-z0-9_-]+/g, '-') : '';
    const client = params && params.client ? String(params.client) : '';
    const pkey = paneId ? paneKeyOf(session, paneId, client) : '';

    let spawnArgs;
    // 이 스트림이 attach 하는 터미널(tid) — params.win 은 스테일(닫힘/구버전 인덱스)일 수 있어
    //  resolveTid 가 확정한다. select 이후 재접속이면 데몬이 기억하는 현재 터미널을 우선한다.
    let tid = 0;
    if (paneId) {
      try {
        await migrateLegacyPool(session, abs);
        const want = paneCurrent.has(pkey) ? paneCurrent.get(pkey) : (params ? params.win : undefined);
        tid = await resolveTid(session, want);
        if (tid == null) {
          // 터미널 0개(정식 상태) — 여기서 만들면 죽은 pane 재접속이 유령을 부활시킨다.
          //  앱 리컨실러가 곧 이 pane 을 정리한다(생성은 terminal.new 명시 경로만).
          try { ws.send('\r\n\x1b[90m[이 워크스페이스에 열린 터미널이 없습니다]\x1b[0m\r\n'); ws.close(); } catch (_) { /* noop */ }
          return;
        }
        paneCurrent.set(pkey, tid);
      } catch (e) {
        try { ws.send(`\r\n\x1b[31m터미널 준비 실패: ${e.message}\x1b[0m\r\n`); ws.close(); } catch (_) { /* noop */ }
        return;
      }
      // -u: UTF-8. -d 금지 — 터미널 세션은 전 기기가 같은 세션에 동시 attach 해 미러/이어받기 한다
      //  (죽은 앱의 스테일 클라이언트는 프로세스 종료와 함께 tmux 가 자동 제거). 크기는 전역
      //  window-size latest — 마지막으로 조작(입력/리사이즈)한 기기 크기를 따른다(수동 resize-window
      //  클레임 전면 폐지 — 기기 간 크기 뺏기/SIGWINCH 핑퐁의 근원이었다).
      spawnArgs = ['-L', TMUX_SOCKET, '-u', 'attach-session', '-t', '=' + termSession(session, tid), ';', 'set', '-g', 'window-size', 'latest'];
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
    console.log(`[pty] 스트림 연결 (session=${session}${paneId ? ' term=' + termSession(session, tid) : ''}, cwd=${abs}, ${cols}x${rows})`);

    // 마지막으로 반영한 클라이언트 크기 — 탭 전환(swap)으로 새 attach 를 만들 때 그대로 승계한다.
    let lastW = cols, lastH = rows;
    let firstResizeDone = !paneId;
    // 첫 resize 를 attach 안정화 후 재적용(nudge) — 첫 resize 가 tmux 클라이언트 초기화와 겹치면
    //  클라이언트 크기가 80x24 로 고착된다(같은 크기 재-ioctl 은 SIGWINCH 가 안 나가므로 한 칸
    //  줄였다 되돌려 강제로 다시 읽힌다). 고착되면 이 클라이언트에 80x24 화면만 그려지는(반쪽 화면)
    //  사고가 난다.
    let nudgeTimer = null;

    // pty 이벤트 배선 — swap(탭 전환)마다 새 pty 에 재배선. 구 pty 의 exit 는 무시(교체 정상경로).
    const wirePty = (p) => {
      p.onData((data) => {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (_) { /* noop */ }
      });
      p.onExit(({ exitCode }) => {
        if (p !== pty) return; // swap 으로 교체된 이전 클라이언트의 종료 — 스트림은 계속 산다
        console.log(`[pty] tmux 클라이언트 종료 exitCode=${exitCode}`);
        try { ws.close(); } catch (_) { /* noop */ }
      });
    };
    wirePty(pty);

    // terminal.select → 이 스트림의 attach 대상을 즉석 교체(구 모델의 select-window 대체).
    //  ws(앱 연결)는 유지한 채 tmux 클라이언트만 갈아끼운다 — attach 시 tmux 가 전체 화면을
    //  다시 그리므로 앱 쪽은 끊김 없이 새 터미널 내용으로 전환된다.
    let handle = null;
    if (pkey) {
      const swap = (newTid) => {
        const np = nodePty.spawn(tmux, ['-L', TMUX_SOCKET, '-u', 'attach-session', '-t', '=' + termSession(session, newTid)], {
          name: 'xterm-256color',
          cols: lastW || cols, rows: lastH || rows,
          cwd: abs,
          env,
        });
        const old = pty;
        pty = np;
        wirePty(np);
        tid = newTid;
        if (handle) handle.tid = newTid;
        paneCurrent.set(pkey, newTid);
        try { old.kill(); } catch (_) { /* noop */ }
      };
      handle = { tid, swap };
      paneStreams.set(pkey, handle);
    }

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
          lastW = w; lastH = h;
          // 창 크기는 window-size latest 가 클라이언트 리사이즈/입력을 따라 자동 반영 —
          //  구 모델의 resize-window 수동 클레임(기기 간 크기 뺏기 전쟁의 근원)은 전면 폐지.
          if (!firstResizeDone) {
            firstResizeDone = true;
            if (nudgeTimer) clearTimeout(nudgeTimer);
            nudgeTimer = setTimeout(() => {
              try { pty.resize(Math.max(2, lastW - 1), lastH); pty.resize(lastW, lastH); } catch (_) { /* noop */ }
            }, 600);
          }
          return;
        }
      } catch (_) { /* JSON 아니면 일반 입력 */ }
      try { pty.write(str); } catch (_) { /* noop */ }
    };
    // 셋업 중 버퍼된 메시지(첫 resize 등)를 순서대로 재생.
    for (const [d, b] of earlyMsgs.splice(0)) onMsg(d, b);

    const cleanup = () => {
      // tmux 클라이언트만 종료(detach) — 세션(터미널 실체)은 tmux 서버에 살아남는다.
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
      if (handle && paneStreams.get(pkey) === handle) paneStreams.delete(pkey);
      try { pty.kill(); } catch (_) { /* noop */ }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  ws.on('error', (e) => console.error(`[pty] 스트림 WS 오류: ${e.message}`));
}

// ── 멀티 터미널 RPC ──
// 터미널 = 전용 세션(termSession) 모델. list/new/close = 전 기기 공통 durable 목록(tmux 세션들),
// select = 이 pane 스트림의 attach 대상 교체. 전용 소켓 -L codingpt 규율 유지.
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

// 주의: tmux -t 는 접두사 매칭 — 세션 타겟은 반드시 '=' 정확 일치로 지정한다(이 파일 전체 규칙).

// 자동 개명(automatic-rename) 보장 — cmux 탭처럼 셸 대기=폴더명, 실행 중=앱 OSC 타이틀(pane_title)
//  → 프로세스명 폴백. 셸이 쏘는 "user@host:path" 타이틀은 걸러 폴더명/명령 유지(tmux.conf 주석 참조 —
//  포맷은 tmux.conf·PC tmux.rs 와 3벌 동기, 한쪽만 수정 금지).
//  tmux.conf 는 서버 시작 시에만 읽히므로, 이미 떠 있는 서버(구 conf 로 시작)에도 전역 옵션을
//  런타임 주입한다. 구 데몬이 -n 으로 만든 "터미널 N" window 는 per-window automatic-rename 이
//  꺼져 있어 개별로 다시 켠다(사용자 수동 이름 = "터미널 N" 패턴 밖 → 그대로 보존).
const AUTO_RENAME_FMT = '#{?#{||:#{==:#{pane_current_command},zsh},#{||:#{==:#{pane_current_command},bash},#{||:#{==:#{pane_current_command},sh},#{||:#{==:#{pane_current_command},fish},#{||:#{==:#{pane_current_command},-zsh},#{||:#{==:#{pane_current_command},-bash},#{==:#{pane_current_command},login}}}}}}},#{b:pane_current_path},#{?#{&&:#{!=:#{pane_title},},#{&&:#{!=:#{pane_title},#{host}},#{&&:#{!=:#{pane_title},#{host_short}},#{?#{m:*@#{host_short}*,#{pane_title}},0,1}}}},#{pane_title},#{pane_current_command}}}';
const autoRenameDone = new Set(); // 세션당 1회(데몬 수명 동안)
async function ensureAutoRename(session) {
  if (autoRenameDone.has(session)) return;
  await runTmux(['set-window-option', '-g', 'automatic-rename-format', AUTO_RENAME_FMT]).catch(() => {});
  await runTmux(['set-window-option', '-g', 'automatic-rename', 'on']).catch(() => {});
  const wins = await poolWindows(session);
  for (const w of wins) {
    if (/^터미널 \d+$/.test(w.name || '')) {
      await runTmux(['set-window-option', '-t', `=${session}:${w.index}`, 'automatic-rename', 'on']).catch(() => {});
    }
  }
  autoRenameDone.add(session);
}

// 풀 세션 환경에 cpt CLI 좌표 주입 — 이후 이 세션에서 생성되는 모든 window 의 셸이 상속한다.
//  CPT_WS = 워크스페이스(홈-상대 경로), CPT_SOCK = cpt 컨트롤 소켓, CPT_TMUX = tmux 바이너리(번들 대응),
//  PATH prepend(~/.codingpt/bin) 는 shim(P5)이 담당 — 여기서는 좌표만.
//  이미 떠 있는 셸은 env 변경을 못 받으므로 CLI 쪽에 show-environment 폴백이 있다.
const poolEnvDone = new Set(); // 세션당 1회(데몬 수명 동안) — set-environment 반복 호출 절약
async function injectPoolEnv(session, abs) {
  if (poolEnvDone.has(session)) return;
  const rel = fsLib.relOf ? fsLib.relOf(abs) : '';
  // 소켓 경로는 cpt-server 와 동일 규칙(sun_path 한계 폴백 포함) — 어긋나면 CLI 가 유령 소켓을 본다.
  const sock = require('./cpt-server').sockPath();
  const tmuxBin = findTmux();
  await runTmux(['set-environment', '-t', '=' + session, 'CPT_WS', rel == null ? '' : String(rel)]);
  await runTmux(['set-environment', '-t', '=' + session, 'CPT_SOCK', sock]);
  if (tmuxBin) await runTmux(['set-environment', '-t', '=' + session, 'CPT_TMUX', tmuxBin]);
  // shim(cpt/claude/codex 래퍼) 경로를 PATH 선두에 — 새 window 셸부터 적용.
  //  zsh 는 rc 가 PATH 를 재구성해 이 값이 밀린다(실측) → ZDOTDIR 체인으로 rc 이후에 재-prepend.
  const shimBin = path.join(runtime.stateDir(), 'bin');
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  await runTmux(['set-environment', '-t', '=' + session, 'PATH', `${shimBin}:${basePath}`]).catch(() => {});
  try {
    const shimLib = require('./shim');
    const zdot = shimLib.zdotDir();
    if (fs.existsSync(zdot)) {
      const origZdot = process.env.ZDOTDIR || '';
      await runTmux(['set-environment', '-t', '=' + session, 'ZDOTDIR', zdot]);
      if (origZdot && origZdot !== zdot) await runTmux(['set-environment', '-t', '=' + session, 'CPT_ORIG_ZDOTDIR', origZdot]);
    }
  } catch (_) { /* shim 미생성 — PATH 주입만으로 동작(제한적) */ }
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

// terminal.* — 전용 세션 모델: 터미널 실체 = termSession(전 기기 공유·durable), 배치만 기기별.
//  list/new/close = 전 기기 공통. select = 이 pane 의 살아있는 스트림 attach 대상 교체.
async function handleTerminalRpc(method, params) {
  const { session, abs } = sessionForCwd(params && params.cwd);
  const paneId = params && params.paneId ? String(params.paneId).replace(/[^A-Za-z0-9_-]+/g, '-') : '';
  const client = params && params.client ? String(params.client) : '';
  const pkey = paneId ? paneKeyOf(session, paneId, client) : '';
  await migrateLegacyPool(session, abs);
  if (method === 'terminal.list') {
    // durable 터미널 목록(tmux 세션들) — 모든 기기 "내역"의 원천(이름 포함, 생성순).
    const list = await listTerminals(session);
    return { windows: list.map((t) => ({ index: t.index, name: t.name, command: t.command })) };
  }
  if (method === 'terminal.new') {
    // 새 터미널 = 전용 세션 생성(전 기기에 나타남). 이름은 자동 개명(automatic-rename)이 부여.
    const t = await createTerminal(session, abs);
    return { index: t.index, name: t.name };
  }
  if (method === 'terminal.select') {
    // 이 pane 이 보는 터미널 전환. 요청 tid 가 스테일(닫힘)이면 첫 터미널 폴백(재생성 금지 —
    //  닫은 터미널이 부활하면 안 된다). 터미널 0개면 no-op. 크기는 window-size latest 가 자동 처리.
    const tid = await resolveTid(session, params && params.index);
    if (tid == null) return { ok: true };
    if (pkey) {
      paneCurrent.set(pkey, tid);
      const h = paneStreams.get(pkey);
      if (h && h.tid !== tid) {
        try { h.swap(tid); } catch (_) { /* 스트림 사망 직후 등 — 재접속 경로가 paneCurrent 로 잇는다 */ }
      }
    }
    return { ok: true, index: tid };
  }
  if (method === 'terminal.unview') {
    // pane 에서 탭 제거(터미널 세션은 보존) — 전용 세션 모델에선 서버 상태가 없어 기억만 정리.
    const tid = Number(params && params.index);
    if (pkey && paneCurrent.get(pkey) === tid) paneCurrent.delete(pkey);
    return { ok: true };
  }
  if (method === 'terminal.close') {
    // 완전 삭제(전 기기 공통) = kill-session. 세션이 이미 없거나 서버가 죽었어도 멱등 성공.
    const tid = Number(params && params.index);
    try {
      await runTmux(['kill-session', '-t', '=' + termSession(session, tid)]);
    } catch (e) {
      const msg = String(e.message || '');
      if (!/no server running|can't find session|session not found/i.test(msg)) throw e;
    }
    return { ok: true };
  }
  throw new Error('unknown terminal method: ' + method);
}

// ── 스테일 뷰 세션 리퍼(누적 예방) ─────────────────────────────────────
// 문제: pane 뷰 세션(--p-/--v-/--c-)은 클라이언트가 정상 경로(terminal.unview/close)로 끊을 때만
//  정리된다. 앱 강제종료·네트워크 단절·웹뷰 자동 재접속·다기기 테스트는 unview 를 안 보내므로,
//  버려진 뷰 세션이 영구 소켓(-L codingpt, 데몬보다 오래 산다)에 무한 누적된다(실측 며칠에 수십 개).
//  뷰 세션은 primary window 로의 "링크"일 뿐 고유 셸 상태가 없어(ensureView 가 언제든 재구성) attach
//  클라이언트가 하나도 없는 뷰는 안전하게 제거 가능. primary(마커 없는 cpt-<ws>/codingpt = 실제 셸)는
//  절대 건드리지 않는다.
//  grace(idleSec): ensureView 로 막 만들어져 stream attach 직전(수백 ms)인 뷰를 죽이지 않도록,
//   session_activity 가 idleSec 이상 지난(=아무도 안 붙은 채 방치된) 뷰만 대상으로 한다.
async function reapStaleViews(idleSec = 90) {
  let out;
  try {
    out = await runTmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_activity}']);
  } catch (_) { return 0; } // 서버 없음 = 정리할 것 없음
  const now = Math.floor(Date.now() / 1000);
  let reaped = 0;
  for (const line of out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)) {
    const [name, attached, activity] = line.split('\t');
    if (/--t-\d+$/.test(name || '')) continue;                     // 터미널 세션(전용 세션 모델) 절대 불가침
    if (!/--p-|--v-|--c-/.test(name || '')) continue;              // primary 보존
    if ((parseInt(attached, 10) || 0) > 0) continue;               // attach 중인 뷰 보존
    if (now - (parseInt(activity, 10) || 0) < idleSec) continue;   // grace — 방금 만든 뷰 보호
    try { await runTmux(['kill-session', '-t', '=' + name]); reaped++; } catch (_) { /* 이미 사라짐 */ }
  }
  return reaped;
}

// ── 낡은 터미널 자가 치유(shim 갱신 후 훅 배선 소급) ────────────────────
// 문제: 셸은 시작할 때 한 번만 rc(zdot)를 읽는다. shim 을 업데이트(예: claude 훅 함수 추가)해도
//  "그 전에 열려 있던 셸"은 낡은 배선 그대로라, 거기서 claude 를 켜면 우리 훅이 안 걸린다
//  (다른 툴(cmux)이 PATH 로 claude 를 가로채면 특히). 사용자는 "왜 안 오지"만 겪는다.
// 해결: shim 이 실제로 바뀐 시점(zdot/.zlogin mtime)보다 먼저 시작된 "idle 셸" pane 을 respawn 한다.
//  respawn 된 셸은 현재 세션 env(ZDOTDIR)로 zdot 를 다시 읽어 함수를 로드한다(실측 확인).
//  안전장치: primary 세션만 · 셸(idle) pane 만(claude/vim 등 실행 중은 절대 건드리지 않음) ·
//   최근 활동 idleSec 이내는 보존(타이핑 중 방해 방지) · cwd 보존.
const HEAL_SHELL_CMDS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh']);

function procStartMs(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(0);
    // LC_ALL=C 필수 — 한국어 등 로케일에선 lstart 가 "2026년 7월..."로 나와 Date.parse 가 NaN 이 된다(실측).
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 4000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, out) => {
      if (err) return resolve(0);
      const t = Date.parse(String(out).trim());
      resolve(Number.isFinite(t) ? t : 0);
    });
  });
}

async function healStaleTerminals(idleSec = 45) {
  const ourZdot = path.join(runtime.stateDir(), 'shim', 'zdot');
  let shimMtime = 0;
  try { shimMtime = fs.statSync(path.join(ourZdot, '.zlogin')).mtimeMs; } catch (_) { return 0; }
  if (!shimMtime) return 0;
  let out;
  try { out = await runTmux(['list-sessions', '-F', '#{session_name}']); } catch (_) { return 0; }
  const sessions = out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)
    .filter((n) => !/--p-|--v-|--c-/.test(n)); // primary 만(뷰 세션 제외)
  const now = Date.now();
  let healed = 0;
  for (const session of sessions) {
    // 멀티 데몬 안전장치 — 이 세션이 "우리 shim"으로 설정된 경우에만 치유(남의 데몬 세션 respawn 금지).
    //  소켓(-L codingpt)을 여러 데몬이 공유할 수 있어(dev/demo home), 세션 ZDOTDIR 로 소유를 판정한다.
    try {
      const env = await runTmux(['show-environment', '-t', '=' + session, 'ZDOTDIR']);
      if (String(env).trim() !== `ZDOTDIR=${ourZdot}`) continue;
    } catch (_) { continue; } // env 조회 실패 = 건드리지 않음
    let wl;
    try {
      wl = await runTmux(['list-windows', '-t', '=' + session, '-F',
        '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{window_activity}']);
    } catch (_) { continue; }
    for (const line of wl.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)) {
      const [paneId, panePid, cmd, cpath, act] = line.split('\t');
      if (!HEAL_SHELL_CMDS.has((cmd || '').trim())) continue;            // 실행 중(claude 등) 보존
      if (now - (parseInt(act, 10) || 0) * 1000 < idleSec * 1000) continue; // 최근 활동 보존
      const start = await procStartMs(panePid);
      if (!start || start >= shimMtime - 3000) continue;                 // 최신 셸 = 스킵
      try {
        await runTmux(['respawn-pane', '-k', '-t', paneId, ...(cpath ? ['-c', cpath] : [])]);
        healed++;
      } catch (_) { /* 사라짐/실행중 전환 등 — 다음 주기 */ }
    }
  }
  return healed;
}

module.exports = { openPtyStream, findTmux, handleTerminalRpc, runTmux, poolWindows, sessionForCwd, paneSession, termSession, newTid, listTerminals, createTerminal, migrateLegacyPool, resolveTid, reapStaleViews, healStaleTerminals, TMUX_SOCKET, TMUX_SESSION };
