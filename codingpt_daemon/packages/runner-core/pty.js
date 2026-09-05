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
 * E2EE(기능2 D단계, 설계서 §2.4) — 위 계약을 "표현만 바꿔" 보존한다:
 *  · params.sid 가 있으면 이 스트림은 봉인 모드다(세션키는 제어채널 e2ee.begin 으로 **이미** 확정됨 —
 *    인스트림 핸드셰이크는 영구 금지: 구 데몬이 그 JSON 을 셸에 타이핑한다).
 *  · 봉인 모드의 모든 프레임은 binary 다. 평문에서 isBinary 가 하던 구분은 헤더의 kind 비트가 이어받는다:
 *      kind=data(0x0) ↔ 옛 "바이너리 프레임" = stdin
 *      kind=ctrl(0x1) ↔ 옛 "텍스트 JSON 프레임" = {"type":"resize",…} **원문 그대로**
 *    그래서 resize 처리 코드(첫 resize nudge·lastW/H 승계·window-size latest 규율)는 여전히 한 벌이고,
 *    평문/봉인 두 모드가 같은 함수를 탄다(분기 이중화 금지 — 어긋나면 80x24 고착이 한쪽에서만 재발한다).
 *  · 봉인 모드에서 도착한 **평문 텍스트 프레임은 전부 폐기**한다(셸 인젝션 차단).
 *  · sid 는 있는데 세션을 못 찾으면(데몬 재기동 등) 평문으로 내려가지 않고 소켓을 닫는다 —
 *    클라는 토큰을 재발급받아 다시 협상한다(평문으로 몰래 내려가면 화면에 암호문 쓰레기가 뿌려진다).
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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const WebSocket = require('ws');
const fsLib = require('./fs');
const runtime = require('./runtime');
const e2eeGate = require('./e2ee-gate');
const terminalV2 = require('./terminal-stream-v2');
const controllerLease = require('./terminal-controller-lease');
const { CanonicalTerminalRegistry } = require('./canonical-terminal');
const { openCanonicalStream } = require('./canonical-stream');
// 터미널 세션 백엔드 유일 진입점(웨이브2) — darwin: tmux 구현(term-backend-tmux, 동작 불변),
//  win32/CPT_TERMHOST_SOCK: term-host 파이프. tmux 전용 유지보수(레거시 풀 마이그레이션·리퍼·
//  자가치유·automatic-rename 주입)만 runTmux 직행으로 남고 usingHost() 에서 건너뛴다.
const termBackend = require('./term-backend');
const usingHost = () => termBackend.isHostBackend();
const canonicalRegistry = new CanonicalTerminalRegistry(termBackend);
const canonicalEnabled = () => process.env.CPT_CANONICAL_TERMINAL === '1';
// 뷰어가 주장할 수 있는 최소 격자. 이보다 작으면 "화면이 없는 상태에서 계산된 값"이라 본다.
const MIN_VIEWER_COLS = 8;
const MIN_VIEWER_ROWS = 3;

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

// 목록 한 줄의 에이전트 신호 — 판정은 agent-watch(정본) 에 위임한다. lazy require 로 순환 회피
//  (agent-watch 는 pty 를 lazy 로 쓴다). 어떤 실패도 목록 자체를 깨지 않는다(목록은 터미널 UI 의 근간).
//
// ★★ 와이어 `agent` 는 **3값**이다: `true`=에이전트 / `false`=**셸 확정만** / `null`=모름
//  (근거 0 · 판정 조회 실패). 클라 사다리는 `false` 를 "명시적 부정" 으로 읽으므로 근거 0 을 false 로
//  접으면 그 순간 토글이 사라진다 — 제목 글리프가 없는 claude 화면(/resume·agents·폴더 신뢰 ·
//  CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 · showStatusInTerminalTab)에 훅 미주입이 겹치면 **영구**다.
//  `null` 은 앱·PC 의 normalizeDaemonAgentFlag 가 "필드 부재" 와 같게 접어 아래 폴백 칸으로 내려간다
//  (클라 수정 0, 구 클라도 그대로 동작). 이 필드는 폴백을 대체하는 게 아니라 폴백이 비는 구멍을
//  메우는 추가 근거이므로, **모름을 부정으로 승격시키지 말 것**(2026-07-25 합성 교차검증 blocker).
function agentSignal(session, cmd, title) {
  try {
    const s = require('./agent-watch').agentSignalOf(session, cmd, title);
    // 3값 정규화 — true/false 외의 값(null·undefined)은 전부 모름으로 접는다.
    if (s) {
      const on = s.on === true ? true : (s.on === false ? false : null);
      return { on, agent: s.agent || null, state: s.state || null, source: s.source || null, ready: typeof s.ready === 'boolean' ? s.ready : null };
    }
  } catch (_) { /* noop */ }
  return { on: null, agent: null, state: null, source: null, ready: null };   // 조회 실패 = 모름(부정 아님)
}

// 워크스페이스의 터미널 목록 — [{index(tid), name, command, session, agent, agentName, agentState, agentSource}]
//  생성순 정렬. window name(자동 개명)이 곧 전 기기 공유 탭 이름. 서버 없음/오류 = [].
//
// ★ agent* 4필드는 **추가 전용**(2026-07-25) — 구 앱/구 PC 는 모르는 키를 무시하므로 그대로 동작한다.
//  `agent` 는 3값(true / false=셸 확정만 / null=모름) — agentSignal 의 ★★ 항이 정본이다.
//  목적: "이 터미널에 에이전트가 붙어 있는가" 를 **데몬이 판정해서** 실어 보낸다. 클라가 command 를
//  이름 패턴으로 매칭하는 구조를 끝내기 위함이다(최신 claude 의 pane_current_command = `2.1.219`).
//  판정 규칙 정본은 agent-watch.agentSignalOf 한 곳(= isAgentPane/titleStatus 공유).
//  pane_title 을 **format 에 추가로 조회**하는 이유: 판정 근거가 제목 글리프인데 window_name 은 사용자가
//  수동 rename 하면 automatic-rename 이 꺼져 얼어붙는다(그 터미널만 영구 미감지가 된다). 제목 원문은
//  사용자 프롬프트가 들어 있어 응답에 싣지 않는다 — 판정 입력으로만 쓰고 버린다.
async function listTerminals(ns) {
  let sessions;
  try {
    // 백엔드 list = tmux list-windows -a 5필드 포맷(darwin, 종전과 동일) / term-host meta(win32).
    //  cmd/title 매핑은 웨이브1 주의점 6: pane_current_command→command, pane_title→title.
    sessions = await termBackend.list();
  } catch (_) { return []; }
  const prefix = ns + '--t-';
  const rows = [];
  for (const s of sessions) {
    const sname = String(s.name || '');
    if (!sname.startsWith(prefix)) continue;
    const tid = parseInt(sname.slice(prefix.length), 10);
    if (!Number.isFinite(tid)) continue;
    const sig = agentSignal(sname, s.command, s.title);
    rows.push({
      index: tid, name: s.windowName || '', command: (s.command || '').trim(), session: sname, created: s.createdAt || 0,
      agent: sig.on, agentName: sig.agent, agentState: sig.state, agentSource: sig.source, agentReady: sig.ready,
    });
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
//  tid/tsession 은 이 터미널의 좌표 — 넘기면 CPT_TID/CPT_TSESSION 도 함께 주입한다(cpt CLI 가
//  tmux display-message 서브프로세스 없이 자기 좌표를 알게 된다. 훅은 한 턴에 여러 번 뜨므로 그 비용이
//  그대로 체감 지연이다). ⚠ 넘기지 않으면 아예 주입하지 않는다 — 잘못된/undefined tid 를 주입하면 CLI 가
//  틀린 터미널을 자기라고 보고해 알림 win·읽음 처리 scope 가 어긋난다.
function poolEnvMap(abs, tid, tsession) {
  const out = {};
  try {
    const rel = fsLib.relOf ? fsLib.relOf(abs) : '';
    out.CPT_WS = rel == null ? '' : String(rel);
    out.CPT_SOCK = require('./cpt-server').sockPath();
    // 트루컬러 광고 — chalk 계열(claude 등)은 COLORTERM=truecolor 없이는 TERM=xterm-256color 를
    //  256색으로 판정해 hex 색을 근사 인덱스로 강등한다(#264F78 → 48;5;66 세이지 실측). tmux 쪽
    //  RGB 관통은 tmux.conf terminal-features 가 담당 — 이 한 쌍이어야 색이 끝까지 산다.
    out.COLORTERM = 'truecolor';
    if (Number.isFinite(Number(tid)) && Number(tid) > 0 && tsession) {
      out.CPT_TID = String(Number(tid));
      out.CPT_TSESSION = String(tsession);
    }
    if (process.platform === 'win32') {
      // win32 최소셋(PC 앱의 create 주입 규칙과 정합 — 계약 4): CPT_WS·CPT_SOCK·좌표·PATH prepend.
      //  ZDOTDIR(zsh 전용)·CPT_TMUX(tmux 없음)는 제외. 셸 프로필 주입은 term-host defaultShell 이 담당.
      const shimBin = path.join(runtime.stateDir(), 'bin');
      out.PATH = `${shimBin}${path.delimiter}${process.env.PATH || ''}`;
      // 격리 소켓 오버라이드(테스트/멀티 인스턴스)만 명시 전파 — 기본 파이프명은 homedir 로 계산 가능.
      if (process.env.CPT_TERMHOST_SOCK) out.CPT_TERMHOST_SOCK = process.env.CPT_TERMHOST_SOCK;
      return out;
    }
    if (process.env.CPT_TERMHOST_SOCK) out.CPT_TERMHOST_SOCK = process.env.CPT_TERMHOST_SOCK;
    const tmuxBin = usingHost() ? null : findTmux();
    if (tmuxBin) out.CPT_TMUX = tmuxBin;
    const shimBin = path.join(runtime.stateDir(), 'bin');
    out.PATH = `${shimBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
    const zdot = require('./shim').zdotDir();
    if (fs.existsSync(zdot)) {
      out.ZDOTDIR = zdot;
      const origZdot = process.env.ZDOTDIR || '';
      if (origZdot && origZdot !== zdot) out.CPT_ORIG_ZDOTDIR = origZdot;
    }
  } catch (_) { /* shim 미생성 등 — 넣을 수 있는 것만 */ }
  return out;
}

// 레거시 풀 마이그레이션(tmux 직행 new-session)용 -e 인자 형태 — poolEnvMap 과 한 벌.
function poolEnvArgs(abs, tid, tsession) {
  const out = [];
  for (const [k, v] of Object.entries(poolEnvMap(abs, tid, tsession))) out.push('-e', `${k}=${v}`);
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
      await termBackend.create({ name, cwd: abs, env: poolEnvMap(abs, id, name) });
    } catch (e) {
      lastErr = e;
      if (/duplicate session/i.test(String(e.message || ''))) continue; // tid 충돌 — 재시도
      throw e;
    }
    await injectPoolEnv(name, abs).catch(() => {});
    await ensureAutoRename(name).catch(() => {});
    const inf = await termBackend.info(name).catch(() => null);
    return { index: id, name: (inf && inf.windowName) || '', session: name };
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
  // term-host 백엔드(win32/env)엔 레거시 tmux 풀이 존재할 수 없다 — tmux 직행 경로 전체 스킵.
  if (usingHost()) { migratedNs.add(ns); return; }
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
      await runTmux(['new-session', '-d', '-s', name, '-c', abs, ...poolEnvArgs(abs, base + i, name)]);
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
    if (await termBackend.has(termSession(ns, tid)).catch(() => false)) return tid;
  }
  const list = await listTerminals(ns);
  return list.length ? list[0].index : null;
}

// pane 스트림 레지스트리 — terminal.select 가 "그 pane 의 살아있는 스트림"의 attach 대상을 즉석
//  교체(swap)할 수 있게 한다(뷰 세션 select-window 의 대체). key = ns|paneId|client.
const paneStreams = new Map(); // key -> { tid, swap(tid) }

// 서로 다른 크기의 tmux 클라이언트가 번갈아 latest 가 되던 구버전은 SIGWINCH 때 zsh/p10k가
// 같은 프롬프트를 history 에 여러 번 밀어 넣었다. 일반 명령 출력은 절대 접지 않고,
// `user@host` + 경로가 있는 동일 프롬프트가 연속될 때만 한 줄로 정규화한다.
function normalizeResizePromptHistory(text) {
  const lines = String(text || '').replace(/\n$/, '').split('\n');
  const plain = (s) => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').trim();
  const out = [];
  let prevPrompt = null;
  for (const line of lines) {
    const p = plain(line);
    const isShellPrompt = /\S+@\S+/.test(p) && /(?:^|\s)(?:~|\/)[^\s]*/.test(p);
    if (isShellPrompt && p === prevPrompt) continue;
    out.push(line);
    prevPrompt = isShellPrompt ? p : null;
  }
  return out.join('\n');
}
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

// tmux 자식 프로세스 env 정본 — 두 규율을 한 곳에서만 집행한다(경로가 늘어도 규율은 하나다).
//  ① TMUX 제거: 데몬이 tmux/cmux 안에서 돌아도 전용 소켓을 조작할 수 있게 중첩 가드 해제(소켓이 달라 안전).
//  ② UTF-8 로케일 강제: 이건 표시 문제가 아니라 **`-F` 출력 파싱의 생존 조건**이다. 데스크톱 앱
//     (Finder/launchd)이 데몬을 띄우면 LANG 이 아예 없고, 그러면 tmux 는 멀티바이트뿐 아니라
//     **구분자 TAB(0x09)까지 '_' 로 이스케이프**한다(실측 2026-07-25, 사용자 Mac:
//     `#{session_name}\t#{session_created}\t…` → `cpt-…--t-958257768_1784919305_…`).
//     결과는 조용한 전멸이다 — listTerminals 는 탭이 0개라 name/command 가 전부 빈 값이 되고
//     (`cpt terminal list --json` 실측: name:"" command:""), agent-watch 의 세션 필터 `/--t-\d+$/` 는
//     한 줄도 통과하지 못해 **에이전트 감지가 통째로 죽는다**(에러 0건·로그 0건).
//     attachPty 는 0.1.29 에서 고쳤는데 execFile 경로(runTmux)에 미러가 빠져 재발했다 → 여기로 통합.
function tmuxEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  if (!/UTF-?8/i.test(env.LANG || '')) env.LANG = 'en_US.UTF-8';
  if (!/UTF-?8/i.test(env.LC_CTYPE || '')) env.LC_CTYPE = 'en_US.UTF-8';
  return env;
}

// 스폰 실패 쿨다운 — node-pty 는 스폰 실패 경로에서 pty 마스터 fd 를 누수한다. 웹뷰 자동 재접속
//  (1~10s)과 결합하면 실패가 실패를 낳는 나선(pty 고갈 고착, 실측 75분에 마스터 459개 누수)이 되므로,
//  직전 스폰 실패 후 잠시는 스폰 시도 자체를 거부한다.
let lastSpawnFailAt = 0;

// ── 전송 어댑터(io) 계약 — attachPty 는 전송을 모른다 ─────────────────────
// 릴레이(back dial-back WS)와 LAN 직결(lan.js 채널)이 **같은 attachPty 한 벌**을 타게 하는 이음쇠다.
// 분기 이중화 금지: tmux 세션/tid 결정·window-size latest·첫 resize nudge·early 버퍼는 한 곳에만 있다.
//
//   io.send(chunk)     데몬→뷰어 출력(string|Buffer). 프레이밍/봉인은 어댑터 책임.
//   io.onMessage(cb)   cb('stdin', Buffer) | cb('text', string).
//                      ⚠ **등록 전에 도착한 메시지를 어댑터가 버퍼**해 등록 즉시 순서대로 재생해야 한다.
//                        클라이언트는 연결 직후 첫 resize 를 쏘는데 attachPty 의 셋업은 async 다.
//                        유실되면 창이 80x24 로 고착되고 이후 리사이즈와 핑퐁 → 프롬프트 무한 누적
//                        (12R/17R 에서 실측한 그 사고). LAN 경로엔 back early 버퍼가 없어 특히 필수.
//   io.onClose(cb)     전송 종료 → cleanup. 이미 닫혀 있으면 즉시 호출해야 한다(셋업 중 종료 누수 방지).
//   io.close()         스트림 종료 요청
//   io.transport       'relay' | 'lan' (로그용)

// 릴레이(WS) 어댑터 — E2EE 봉투(D단계)의 모든 판단이 여기 산다(attachPty 는 평문 의미만 다룬다).
//  sid 가 있는데 세션을 못 찾으면 null 을 돌려준다 → 호출측이 4090 으로 닫아 재협상을 유도한다
//  (평문으로 몰래 내려가면 뷰어 화면에 암호문 쓰레기가 뿌려진다).
function wsPtyIo(ws, sid) {
  const enc = !!sid;
  if (enc && !(e2eeGate.allows('stream') && e2eeGate.sessionExists(sid, 'host'))) return null;
  // 봉인 채널은 **첫 수신 프레임에서 학습**한다 — connId 는 연결을 여는 쪽(뷰어)이 정하고,
  //  호스트가 자기 connId 로 보내면 뷰어의 open() 이 connId 불일치로 전부 거부한다.
  //  그래서 채널 확립 전 출력(tmux attach 리페인트)은 버퍼에 담아 두고 확립 직후 순서대로 흘린다.
  let ch = null;
  const outQ = [];
  let outQBytes = 0;
  const OUT_Q_MAX = 1024 * 1024;
  const sealSend = (buf) => {
    try { ws.send(ch.seal(buf, e2eeGate.KIND_DATA), { binary: true }); } catch (_) { /* 이 청크만 버림 */ }
  };
  const flushOut = () => { const q = outQ.splice(0); outQBytes = 0; for (const b of q) sealSend(b); };
  let cb = null;
  const inQ = [];
  const deliver = (kind, payload) => { if (cb) cb(kind, payload); else inQ.push([kind, payload]); };
  // 리스너는 **즉시** 붙인다(open 핸들러의 첫 동기 구간) — 이후 어떤 await 도 메시지를 잃지 않는다.
  ws.on('message', (data, isBinary) => {
    if (!enc) {
      if (isBinary) deliver('stdin', data);
      else deliver('text', data.toString());
      return;
    }
    // 봉인 모드: 평문 프레임은 전부 폐기(셸 인젝션 차단 — 함정 #1 의 거울상).
    if (!isBinary) { console.warn('[pty] 봉인 모드에서 평문 프레임 수신 — 폐기'); return; }
    if (!ch) {
      ch = e2eeGate.hostChannelFromFrame(sid, data);
      if (!ch) { console.warn('[pty] 봉인 채널 확립 실패 — 프레임 폐기'); return; }
      flushOut(); // 채널 확립 전 쌓인 출력(리페인트)을 순서대로 방출
    }
    const f = e2eeGate.openFrame(ch, data);
    // 복호 실패(변조/카운터 역행/방향 혼동) — 프레임만 버리고 소켓은 유지한다(프레임 하나로
    //  소켓을 죽이면 재연결 백오프/하드캡을 오염시킨다).
    if (!f) { console.warn('[pty] 프레임 복호 실패 — 폐기(스트림 유지)'); return; }
    if (f.kind === e2eeGate.KIND_CTRL) deliver('text', f.payload.toString('utf8'));
    else deliver('stdin', f.payload);
  });
  let closed = false;
  const closeCbs = [];
  const fireClose = () => { if (closed) return; closed = true; for (const f of closeCbs.splice(0)) { try { f(); } catch (_) { /* noop */ } } };
  ws.on('close', fireClose);
  ws.on('error', fireClose);
  return {
    transport: 'relay',
    label: enc ? ', e2ee' : '',
    // 평문 모드는 기존과 완전 동일(문자열 = 텍스트 프레임).
    //  ⚠ 봉인 모드에서 "즉시 닫는" 안내 문구(터미널 0개/스폰 실패 등)는 채널이 아직 없으면 전달되지
    //   못한다(뷰어가 connId 를 정하기 전이라 봉인할 수 없다). 클라는 close 를 보고 재시도한다.
    send(chunk) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!enc) { try { ws.send(chunk); } catch (_) { /* noop */ } return; }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (ch) { sealSend(buf); return; }
      if (outQBytes + buf.length > OUT_Q_MAX) { console.warn('[pty] 봉인 채널 확립 전 출력 버퍼 초과 — 청크 폐기'); return; }
      outQ.push(buf); outQBytes += buf.length;
    },
    onMessage(fn) { cb = fn; for (const [k, p] of inQ.splice(0)) fn(k, p); },
    onClose(fn) { if (closed) { try { fn(); } catch (_) { /* noop */ } return; } closeCbs.push(fn); },
    close() { try { ws.close(); } catch (_) { /* noop */ } },
    dispose() {
      // 봉인 채널을 닫아 connId 를 회수한다(재사용 거부 목록으로 이동 = nonce 재사용 방지).
      if (ch && typeof ch.close === 'function') { try { ch.close(); } catch (_) { /* noop */ } }
    },
  };
}

// back 지시(stream_open)에 대한 dial-back. 실패 시 throw → control 이 stream_fail 회신.
function openPtyStream({ serverUrl, deviceToken }, { streamToken, params }) {
  if (!usingHost() && !findTmux()) throw new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)');

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });

  // 봉인 세션 식별자 — back 이 e2ee.begin 결과의 sid 를 스트림 params 에 심어 보낸다(둘 중 어느 형태든 수용).
  const sid = (params && (params.sid || (params.e2ee && params.e2ee.sid))) || null;

  ws.on('open', () => {
    // Nagle off — pty 출력(에코)이 작은 프레임이라 Nagle 이 매 키마다 지연을 얹는다(모바일 타자 렉).
    try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ }
    // io 생성은 이 핸들러의 **첫 동기 구간**에서 끝난다 → ws.on('message') 가 붙기 전에 처리되는
    //  메시지가 존재할 수 없다(이후 셋업 지연분은 io 가 버퍼한다).
    const io = wsPtyIo(ws, sid);
    if (!io) {
      console.warn(`[pty] E2EE 세션을 찾을 수 없어 스트림을 닫습니다(sid=${String(sid).slice(0, 8)}… scope=${e2eeGate.scope()})`);
      try { ws.close(4090, 'E2EE_SESSION_UNKNOWN'); } catch (_) { /* noop */ }
      return;
    }
    attachPty(params, io).catch((e) => {
      console.error(`[pty] attach 실패: ${(e && e.message) || e}`);
      try { io.send(`\r\n\x1b[31m터미널 준비 실패: ${(e && e.message) || e}\x1b[0m\r\n`); io.close(); } catch (_) { /* noop */ }
    });
  });

  ws.on('error', (e) => console.error(`[pty] 스트림 WS 오류: ${e.message}`));
}

/**
 * 전송 독립 PTY attach — 릴레이(WS)와 LAN 직결이 공유하는 유일 구현.
 *
 * params 는 릴레이가 openStream 에 넘기는 것과 **완전 동일한 키**여야 한다
 *  { cwd, paneId, client, win, cols, rows } — paneId/client 가 paneKeyOf(pkey)의 재료이고,
 *  pkey 는 terminal.select 가 "살아있는 스트림"을 찾는 유일한 좌표다. LAN 이 다른 client 를 보내면
 *  select 가 그 스트림을 못 찾아 "탭 전환이 안 되는" 유령 상태가 된다.
 *
 * 경로 전환(릴레이↔LAN) 안전장치: 같은 pkey 의 기존 스트림이 남아 있으면 **먼저 displace** 한다.
 *  겹치면 같은 전용 세션에 tmux 클라이언트가 2개 붙고 `window-size latest` 가 두 크기를 번갈아
 *  채택해 SIGWINCH 핑퐁(프롬프트 누적)이 난다 — 12R/17R 에서 실측한 사고. 뷰어가 "닫고-열기"를
 *  지키는 것이 정석이지만, 데몬이 마지막 방어선을 갖는다(클라 순서 역전에도 클라이언트는 항상 1개).
 */
// 실행 중인 tmux 서버에 트루컬러 광고 소급 — tmux.conf 는 서버 "첫 기동" 때(-f)만 읽히는데,
//  tmux 서버는 데몬/앱 재시작을 넘어 살아남는다. 그래서 업데이트로 conf 에 RGB 를 넣어도 기존
//  서버엔 영영 반영이 안 된다(설정만 고치고 "왜 그대로지" 하는 함정). 데몬 수명당 1회, 이미
//  들어가 있으면 no-op. 서버가 아직 없으면 조용히 넘어간다(첫 create 가 conf 로 커버).
let tcApplied = false;
async function ensureTruecolor() {
  if (tcApplied || usingHost()) return;
  try {
    const cur = await runTmux(['show-options', '-s', '-v', 'terminal-features']).catch(() => '');
    if (!/xterm-256color:RGB/.test(String(cur))) {
      await runTmux(['set-option', '-s', '-a', 'terminal-features', ',xterm-256color:RGB']);
    }
    // 기존 전용 tmux 서버는 업데이트된 conf를 다시 읽지 않는다. attach 전에 공통
    // 스크롤백 필수 옵션을 소급해 새 모바일도 tmux history 정본을 받게 한다.
    // ⚠ alternate-screen 은 반드시 on — off 면 tmux 가 alternate 상태를 추적하지 않아
    //   #{alternate_on} 이 less/vim 안에서도 0 이 되고, 스크롤 라우팅이 풀스크린 앱을
    //   일반 셸로 오판한다(회귀: terminal-modes.test.js). 클라이언트로 1049 가 새는 건
    //   terminal-overrides 의 smcup@:rmcup@ 가 이미 막는다.
    await runTmux(['set-option', '-gw', 'alternate-screen', 'on']);
    // scroll-on-clear off — `clear` 가 과거를 정말 지우게 한다. on 이면 tmux 가 E3(`\e[3J`)로 history 를
    //  비운 **직후** ED2 를 만나 방금 지운 화면을 history 로 도로 밀어 넣는다(실측 2026-09-04:
    //  clear 전 42줄 → on 이면 23줄 / off 면 0줄). 구버전 tmux 엔 없는 옵션이라 실패해도 무시한다.
    await runTmux(['set-option', '-gw', 'scroll-on-clear', 'off']).catch(() => {});
    await runTmux(['set-option', '-g', 'mouse', 'off']);
    await runTmux(['set-option', '-g', 'history-limit', '10000']);
    tcApplied = true;
  } catch (_) { /* 서버 미기동/구버전 tmux — conf 폴백 */ }
}

async function attachPty(params, io) {
  if (!usingHost() && !findTmux()) throw new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)');
  await ensureTruecolor();
  const cols = (params && params.cols) || 80;
  const rows = (params && params.rows) || 24;
  const protocolV2 = Number(params && params.terminalProtocol) === 2;
  let streamSeq = 0;
  let streamEpoch = crypto.randomBytes(8).toString('hex');
  const sendFrame = (opcode, payload) => {
    try { io.send(terminalV2.encode(opcode, ++streamSeq, payload)); } catch (_) { /* noop */ }
  };
  const sendOut = (chunk) => {
    if (protocolV2) { sendFrame(terminalV2.OPCODE.OUTPUT, chunk); return; }
    try { io.send(chunk); } catch (_) { /* noop */ }
  };
  const sendSnapshot = (chunks, meta = {}) => {
    if (!protocolV2) {
      for (const chunk of chunks) { try { io.send(chunk); } catch (_) { /* noop */ } }
      return;
    }
    streamEpoch = crypto.randomBytes(8).toString('hex');
    // serverHistory = "과거는 서버에 물어봐라"(`{type:'history'}`). 정본이 tmux 격자라 canonical VT
    //  가 꺼져 있어도 답할 수 있다 — 클라이언트는 이 값만 보고 자기 스크롤백 대신 서버를 쓴다.
    sendFrame(terminalV2.OPCODE.SNAPSHOT_START,
      JSON.stringify({ epoch: streamEpoch, serverHistory: !usingHost(), ...meta }));
    for (const chunk of chunks) sendFrame(terminalV2.OPCODE.SNAPSHOT_CHUNK, chunk);
    sendFrame(terminalV2.OPCODE.SNAPSHOT_END, JSON.stringify({ epoch: streamEpoch }));
  };

  // tmux 세션 옵션은 tmux.conf 에 있고 -f 로 서버 시작 시점에 로드된다.
  //  (alt-screen override 는 클라이언트 attach 전에 세팅돼야 스크롤백이 xterm 에 쌓임 —
  //   new-session 뒤에 set 하면 이미 smcup 을 보낸 뒤라 소급 안 됨.)
  // 진입한 워크스페이스 경로에 맞는 네임스페이스/시작폴더 결정.
  const { session, abs } = sessionForCwd(params && params.cwd);
  const paneId = params && params.paneId ? String(params.paneId).replace(/[^A-Za-z0-9_-]+/g, '-') : '';
  const client = params && params.client ? String(params.client) : '';
  const pkey = paneId ? paneKeyOf(session, paneId, client) : '';

  // 이 스트림이 attach 하는 터미널(tid) — params.win 은 스테일(닫힘/구버전 인덱스)일 수 있어
  //  resolveTid 가 확정한다. select 이후 재접속이면 데몬이 기억하는 현재 터미널을 우선한다.
  let tid = 0;
  let attachName;   // 백엔드 attach 대상 세션명
  let shared = false; // 하위호환(paneId 없음) — 공유 세션 create-or-attach
  if (paneId) {
    await migrateLegacyPool(session, abs);
    const want = paneCurrent.has(pkey) ? paneCurrent.get(pkey) : (params ? params.win : undefined);
    tid = await resolveTid(session, want);
    if (tid == null) {
      // 터미널 0개(정식 상태) — 여기서 만들면 죽은 pane 재접속이 유령을 부활시킨다.
      //  앱 리컨실러가 곧 이 pane 을 정리한다(생성은 terminal.new 명시 경로만).
      sendOut('\r\n\x1b[90m[이 워크스페이스에 열린 터미널이 없습니다]\x1b[0m\r\n');
      try { io.close(); } catch (_) { /* noop */ }
      return;
    }
    paneCurrent.set(pkey, tid);
    // 터미널 세션은 전 기기가 같은 세션에 동시 attach 해 미러/이어받기 한다(-d 금지 등가 —
    //  term-host 는 다중 attach 브로드캐스트가 기본). 크기는 window-size latest 등가 —
    //  마지막으로 조작(입력/리사이즈)한 기기 크기를 따른다(수동 클레임 전면 폐지).
    attachName = termSession(session, tid);
  } else {
    // 하위호환(paneId 없음): 기존 공유 세션에 직접 attach(tmux: new-session -A 등가).
    attachName = session;
    shared = true;
    // term-host 백엔드엔 -A(create-or-attach)가 없다 — 없으면 만들어 항상 열리게 한다.
    if (usingHost() && !(await termBackend.has(session).catch(() => false))) {
      await termBackend.create({ name: session, cwd: abs, env: poolEnvMap(abs) }).catch(() => { /* 경쟁 생성 등 — attach 가 판정 */ });
    }
  }

  // ── v3(CPT3): 데몬 VT 가 정본, 크기 주체는 소유자 1명 — 아래 lease/nudge/스냅샷 경로를 전혀 타지 않는다.
  //  (docs/terminal-v3-design.md. v2 경로는 구 클라이언트 호환용으로만 남는다.)
  if (Number(params && params.terminalProtocol) === 3) {
    if (usingHost()) { sendOut('\r\n\x1b[31m[이 호스트는 아직 v3 터미널을 지원하지 않습니다]\x1b[0m\r\n'); try { io.close(); } catch (_) { /* noop */ } return; }
    const { attachV3 } = require('./pty-v3');
    const deviceName = params && typeof params.deviceName === 'string' ? params.deviceName : '';
    return attachV3({
      name: attachName, cols, rows,
      device: client ? { deviceId: client, name: deviceName || client } : null,
      deps: { tmux: findTmux(), socket: TMUX_SOCKET, env: tmuxEnv(), runTmux },
    }, io);
  }

  // 하나의 PTY는 cols×rows 한 벌만 가진다. tmux window option을 PC 네이티브 클라이언트와 공유해
  // 실제 입력/명시 claim을 한 기기만 15초 동안 resize 주체로 인정한다.
  const leaseOwner = String(client || 'remote').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'remote';
  const leaseTarget = () => `=${attachName}:0`;
  const readControllerLease = async () => {
    if (usingHost()) return null;
    const raw = String(await runTmux(['show-options', '-w', '-v', '-t', leaseTarget(), '@codingpt_controller']).catch(() => '')).trim();
    return controllerLease.parse(raw);
  };
  let leaseClaimedAt = 0;
  const claimControllerLease = async () => {
    if (usingHost()) return;
    leaseClaimedAt = Date.now();
    await runTmux(['set-option', '-w', '-t', leaseTarget(), '@codingpt_controller', controllerLease.format(leaseOwner)]).catch(() => {});
  };
  // 입력 경로 전용 리스 갱신 — 리스는 15초짜리라 키마다 갱신할 이유가 없다. 유효기간의 1/3 이
  //  지났을 때만 스폰하고, **절대 await 하지 않는다**. 입력 write 가 이 비동기 완료를 기다리면
  //  키마다 독립 체인이 생겨 완료 순서가 뒤집힌다(§ terminal-input-order 회귀 참조).
  const refreshControllerLease = () => {
    if (usingHost()) return;
    if (Date.now() - leaseClaimedAt < controllerLease.LEASE_MS / 3) return;
    claimControllerLease().catch(() => {});
  };
  const mayResizeForLease = async () => {
    const lease = await readControllerLease();
    return !lease || lease.expiresAt <= Date.now() || lease.owner === leaseOwner;
  };

  // 쿨다운 중이면 스폰 시도 없이 거절 — 실패 스폰마다 pty 마스터가 새는 것을 차단.
  if (Date.now() - lastSpawnFailAt < 3000) {
    sendOut('\r\n\x1b[33m터미널 준비 중입니다. 잠시 후 다시 연결돼요.\x1b[0m\r\n');
    try { io.close(); } catch (_) { /* noop */ }
    return;
  }

  // 첫 attach 크기 = tmux 가 기억하는 **현재 창 크기**(조회되면) — 릴레이 params 는 항상 80x24
  //  (back ptyStreamParams 고정 기본값)라, 그 크기로 붙였다가 클라이언트의 실크기 resize 가 오면
  //  전체 화면 재도장이 연달아 났다(TUI 는 레이아웃이 통째로 깨졌다 다시 그려짐 — 2026-08-15
  //  "떴는데 새로 그린다" 진단). window-size latest 덕에 창 크기는 대개 "마지막으로 이 터미널을
  //  보던 기기"의 크기 = 재접속하는 그 기기의 직전 크기다. 조회 실패/0 은 params 폴백.
  let attachW = cols, attachH = rows;
  if (paneId) {
    try {
      const inf = await termBackend.info(attachName);
      if (inf && inf.cols > 1 && inf.rows > 1) { attachW = inf.cols; attachH = inf.rows; }
    } catch (_) { /* 폴백: params 크기 */ }
  }
  // 마지막으로 반영한 클라이언트 크기 — 탭 전환(swap)으로 새 attach 를 만들 때 그대로 승계한다.
  let lastW = attachW, lastH = attachH;
  let firstResizeDone = !paneId;
  // 첫 resize 를 attach 안정화 후 재적용(nudge) — 첫 resize 가 tmux 클라이언트 초기화와 겹치면
  //  클라이언트 크기가 attach 크기로 고착된다(같은 크기 재-ioctl 은 SIGWINCH 가 안 나가므로 한 칸
  //  줄였다 되돌려 강제로 다시 읽힌다). 고착되면 이 클라이언트에 옛 크기 화면만 그려지는(반쪽 화면)
  //  사고가 난다. ⚠ 첫 resize 가 attach 크기와 **같으면 고착이 곧 정답**이라 nudge 를 걸지 않는다
  //  — 무조건 걸던 시절엔 화면이 뜨고 0.6초 뒤 SIGWINCH 2회로 멀쩡한 TUI 를 두 번 재도장했다.
  let nudgeTimer = null;
  let resizeSeq = 0;
  let syncSeq = 0;
  let resizeBarrier = Promise.resolve();
  let lastInputAt = 0;
  let lastV1SnapshotSize = '';

  // 각 기기는 같은 tmux pane을 보되, 마지막으로 실제 viewport resize를 보낸 기기의 크기로
  // 정본을 맞춘다. 그래야 tmux가 만든 커서 이동과 해당 기기의 xterm 열 수가 일치한다.
  // keepalive/단순 focus는 이 함수를 호출하지 않으므로 예전의 주기적 크기 왕복은 재발하지 않는다.
  const applyViewerResize = (w, h) => {
    resizeSeq++;
    try { term.resize(w, h); } catch (_) { /* noop */ }
    if (!usingHost()) {
      // tmux window-size=latest는 "마지막 입력 클라이언트"가 아니라 마지막으로 선택된 크기를 계속
      // 유지할 수 있다. pane을 실제 모바일 열 수로 먼저 확정해야 이후 커서 이동과 xterm 좌표가 같다.
      resizeBarrier = resizeBarrier.then(() => runTmux([
        'resize-window', '-t', `=${attachName}:0`, '-x', String(w), '-y', String(h),
      ])).catch(() => {});
    }
  };


  // 이 클라이언트의 로컬 xterm을 PC tmux 정본으로 다시 맞춘다. TUI는 capture-pane 텍스트로
  // 복원하면 커서/모드가 깨지므로 라이브 미러를 유지하고, 일반 셸에서만 전체 정본을 보낸다.
  const sendShellSnapshot = async () => {
    if (usingHost()) return;
    const mine = ++syncSeq;
    try {
      const alt = await runTmux(['display-message', '-p', '-t', `=${attachName}:0`, '#{alternate_on}']);
      if (mine !== syncSeq || String(alt).trim() === '1') return;
      const target = `=${attachName}:0`;
      const [histRaw, screenRaw, cursorRaw] = await Promise.all([
        runTmux(['capture-pane', '-p', '-e', '-t', target, '-S', '-10000', '-E', '-1']),
        runTmux(['capture-pane', '-p', '-e', '-t', target]),
        runTmux(['display-message', '-p', '-t', target, '#{cursor_x},#{cursor_y}']),
      ]);
      if (mine !== syncSeq) return;
      const history = normalizeResizePromptHistory(String(histRaw || '')).replace(/\n/g, '\r\n');
      const screen = String(screenRaw || '').replace(/\n/g, '\r\n');
      const cm = /^(\d+),(\d+)$/.exec(String(cursorRaw || '').trim());
      const cursor = cm ? `\x1b[${Number(cm[2]) + 1};${Number(cm[1]) + 1}H` : '\x1b[H';
      const bootstrap = '\x1b[3J\x1b[H\x1b[2J' + (history ? history + '\r\n' : '');
      const repaint = '\x1b[H\x1b[2J' + screen + cursor;
      sendSnapshot([bootstrap, repaint], { cols: lastW || cols, rows: lastH || rows, historyBootstrap: true });
    } catch (_) { /* 세션 전환/종료 경쟁 */ }
  };

  const sendCanonicalSnapshot = async () => {
    if (!canonicalEnabled() || !term || !term.model) return false;
    try {
      const snapshot = await term.model.snapshot();
      sendSnapshot([snapshot.ansi], {
        cols: snapshot.cols, rows: snapshot.rows, canonicalModel: true, serverHistory: true, modelSeq: snapshot.seq,
      });
      return true;
    } catch (_) { return false; }
  };

  // 구 운영 릴레이(v1)는 SNAPSHOT_START 메타를 전달하지 않는다. 첫 실제 모바일 resize를 받은 뒤
  // 그 뷰어의 정확한 rows로 history를 scrollback에 밀어 올리고 현재 pane을 다시 그린다.
  // 서버/PC 높이로 패딩하면 큰 화면에서 N-rows만 남는 문제가 재발한다.
  const sendV1ViewerSnapshot = async (viewerRows) => {
    if (protocolV2 || usingHost()) return;
    try {
      const target = `=${attachName}:0`;
      const [histRaw, screenRaw, cursorRaw] = await Promise.all([
        runTmux(['capture-pane', '-p', '-e', '-t', target, '-S', '-10000', '-E', '-1']),
        runTmux(['capture-pane', '-p', '-e', '-t', target]),
        runTmux(['display-message', '-p', '-t', target, '#{cursor_x},#{cursor_y}']),
      ]);
      const history = normalizeResizePromptHistory(String(histRaw || '')).replace(/\n/g, '\r\n');
      const screen = String(screenRaw || '').replace(/\n/g, '\r\n');
      const cm = /^(\d+),(\d+)$/.exec(String(cursorRaw || '').trim());
      const cursor = cm ? `\x1b[${Number(cm[2]) + 1};${Number(cm[1]) + 1}H` : '\x1b[H';
      const pad = '\r\n'.repeat(Math.max(1, viewerRows | 0));
      sendSnapshot(['\x1b[3J\x1b[H\x1b[2J' + (history ? history + '\r\n' : '') + pad + '\x1b[H\x1b[2J' + screen + cursor], {
        cols: lastW || cols, rows: viewerRows | 0,
      });
    } catch (_) { /* 라이브 스트림은 유지 — 다음 재접속/출력이 안전망 */ }
  };

  // xterm 의 스크롤백은 뷰어마다 따로 쌓인다. 새 PC attach 는 과거가 없고 오래 살아 있던 폰은
  // 낡은 과거가 남는 불일치를 없애기 위해, 매 attach/swap 직전에 로컬 버퍼를 지우고 터미널
  // 백엔드의 정본 history(현재 화면 제외)를 주입한다. attach 자체가 곧 현재 화면을 다시 그린다.
  const buildTerminalSnapshotPayload = async (name, visibleRows) => {
    let history = '';
    try {
      if (!usingHost()) {
        // tmux 의 -E -1 = 보이는 화면 바로 위까지만. 화면 높이/줄바꿈 추측 없이 history 만 정확히 얻는다.
        history = normalizeResizePromptHistory(String(await runTmux([
          'capture-pane', '-p', '-e', '-t', `=${name}:0`, '-S', '-10000', '-E', '-1',
        ]) || '')).replace(/\n/g, '\r\n');
      } else {
        // term-host capture API 는 end-line 이 없으므로 전체 버퍼에서 현재 물리 행만 제외한다.
        const captured = String(await termBackend.capture(name, { escapes: true, lines: 10000 }) || '');
        const lines = captured.replace(/\n$/, '').split('\n');
        const keep = Math.max(0, lines.length - Math.max(0, visibleRows | 0));
        history = lines.slice(0, keep).join('\r\n');
      }
    } catch (_) { /* attach 는 살리고 버퍼만 빈 상태로 시작 */ }
    return '\x1b[3J\x1b[H\x1b[2J' + (history ? history + '\r\n' : '');
  };

  // tmux attach의 최초 리페인트에는 ED3(스크롤백 삭제)가 들어올 수 있다. history를 attach 전에
  // 보내면 이 리페인트가 곧바로 지워 새 모바일 xterm의 baseY가 0이 된다. 최초 출력만 잠깐
  // 버퍼링한 뒤 history → ED3를 제거한 현재화면 리페인트 순으로 전달한다.
  const stripScrollbackErase = (chunk) => {
    // ED3뿐 아니라 RIS(ESC c)도 xterm의 로컬 scrollback을 전부 지운다. history를 먼저
    // 주입한 뒤 오는 tmux 최초 repaint에서 둘 다 제거해야 기기별 viewport 패딩이 보존된다.
    if (!Buffer.isBuffer(chunk)) return String(chunk).replace(/\x1b(?:\[3J|c)/g, '');
    let out = chunk;
    for (const needle of [Buffer.from('\x1b[3J'), Buffer.from('\x1bc')]) {
      const parts = [];
      let start = 0, at;
      while ((at = out.indexOf(needle, start)) !== -1) {
        if (at > start) parts.push(out.subarray(start, at));
        start = at + needle.length;
      }
      if (start !== 0) {
        if (start < out.length) parts.push(out.subarray(start));
        out = Buffer.concat(parts);
      }
    }
    return out;
  };
  const finishHistoryBootstrap = async (myGen, boot, bootstrap, snapshotName) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (myGen !== gen) return;
    boot.active = false;
    const chunks = boot.chunks.splice(0);
    const snapshotChunks = [bootstrap];
    // tmux attach의 raw 최초 repaint에는 환경/버전에 따라 scrollback을 재설정하는 제어가 섞인다.
    // 최초 snapshot은 capture-pane 현재 화면+커서로 안전하게 재구성하고, raw 청크는 버린다.
    if (!usingHost()) {
      try {
        const target = `=${snapshotName}:0`;
        const [screenRaw, cursorRaw] = await Promise.all([
          runTmux(['capture-pane', '-p', '-e', '-t', target]),
          runTmux(['display-message', '-p', '-t', target, '#{cursor_x},#{cursor_y}']),
        ]);
        const screen = String(screenRaw || '').replace(/\n/g, '\r\n');
        const cm = /^(\d+),(\d+)$/.exec(String(cursorRaw || '').trim());
        const cursor = cm ? `\x1b[${Number(cm[2]) + 1};${Number(cm[1]) + 1}H` : '\x1b[H';
        snapshotChunks.push('\x1b[H\x1b[2J' + screen + cursor);
      } catch (_) { /* 아래 raw repaint 폴백 */ }
      if (snapshotChunks.length > 1) {
        sendSnapshot(snapshotChunks, { cols: lastW || cols, rows: lastH || rows, historyBootstrap: true });
        return;
      }
    }
    // tmux 최초 repaint의 ED3/RIS가 PTY 데이터 청크 경계에서 갈라질 수 있다. 청크별 필터는
    // ESC[ / 3J를 놓쳐 history를 다시 지우므로 먼저 합친 뒤 한 번만 제거한다.
    if (chunks.length) {
      const merged = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')));
      const clean = stripScrollbackErase(merged);
      if (clean.length) snapshotChunks.push(clean);
    }
    // 첫 청크는 history 전용이다. 서버의 rows(현재 PC/tmux 높이)로 viewport를 패딩하면 화면이 더
    // 큰 모바일에서 history가 다시 현재화면으로 소비된다. 각 클라이언트가 자기 term.rows만큼
    // 밀어 올릴 수 있도록 메타로 구분한다.
    sendSnapshot(snapshotChunks, { cols: lastW || cols, rows: lastH || rows, historyBootstrap: true });
  };

  // 백엔드 attach 핸들 + 세대 토큰 — swap(탭 전환)으로 교체된 구 핸들의 exit/close 는 무시한다
  //  (구 nodePty 시절의 `p !== pty` 가드 등가. 콜백이 핸들 확정 전에 발화해도 안전하게 gen 으로 판정).
  let term = null;
  let gen = 0;
  const mkHandlers = (myGen, boot = null) => ({
    onData: (data) => {
      // 탭 전환은 먼저 세대를 올리고 정본 history를 보낸다. 그 짧은 동안 이전 터미널이
      // 출력하면 clear/history 사이에 섞여 기기별 로컬 스크롤백이 다시 달라지므로 폐기한다.
      if (myGen !== gen) return;
      if (boot && boot.active) { boot.chunks.push(data); return; }
      // 출력은 어댑터가 전송 형태를 결정한다(릴레이 평문=텍스트 프레임, 봉인/LAN=바이너리).
      //  멀티바이트 분할은 백엔드(node-pty/term-host) 단계에서 이미 결정되므로 어느 경로든 동일하다.
      sendOut(data);
    },
    onExit: (exitCode) => {
      if (myGen !== gen) return; // swap 으로 교체된 이전 클라이언트의 종료 — 스트림은 계속 산다
      console.log(`[pty] tmux 클라이언트 종료 exitCode=${exitCode}`);
      try { io.close(); } catch (_) { /* noop */ }
    },
    onClose: () => {
      if (myGen !== gen) return; // 교체된 구 attach 의 소켓 정리(win32) — 무시
      try { io.close(); } catch (_) { /* noop */ }
    },
  });
  try {
    gen = 1;
    if (canonicalEnabled()) {
      term = await openCanonicalStream(canonicalRegistry, attachName, {
        cols: attachW, rows: attachH, cwd: abs,
        onSnapshot: (snapshot) => sendSnapshot([snapshot.ansi], {
          cols: snapshot.cols, rows: snapshot.rows, canonicalModel: true, serverHistory: true, modelSeq: snapshot.seq,
        }),
        onOutput: (frame) => sendOut(frame.payload),
        onExit: (code) => mkHandlers(1).onExit(code),
      });
    } else {
      const bootstrap = await buildTerminalSnapshotPayload(attachName, attachH);
      const boot = { active: true, chunks: [] };
      term = await termBackend.attach(attachName, {
        cols, rows, cwd: abs, setLatest: !usingHost(), sharedCreate: shared && !usingHost(),
        ignoreSize: !usingHost(),
        ...mkHandlers(1, boot),
      });
      await finishHistoryBootstrap(1, boot, bootstrap, attachName);
    }
  } catch (e) {
    lastSpawnFailAt = Date.now();
    console.error(`[pty] 스폰 실패(3초 쿨다운 진입): ${e.message}`);
    sendOut(`\r\n\x1b[31m터미널 생성 실패: ${e.message}\x1b[0m\r\n`);
    try { io.close(); } catch (_) { /* noop */ }
    return;
  }
  console.log(`[pty] 스트림 연결 (transport=${io.transport || 'relay'}, session=${session}${paneId ? ' term=' + attachName : ''}, cwd=${abs}, ${attachW}x${attachH}${io.label || ''})`);

  // (선언 순서 주의: cleanup 이 handle 을 참조하므로 먼저 선언한다 — TDZ 사고 방지)
  let handle = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // 터미널 클라이언트만 종료(detach) — 세션(터미널 실체)은 백엔드(tmux 서버/term-host)에 살아남는다.
    if (typeof io.dispose === 'function') { try { io.dispose(); } catch (_) { /* noop */ } }
    if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
    if (handle && paneStreams.get(pkey) === handle) paneStreams.delete(pkey);
    if (idleReaper) { clearInterval(idleReaper); idleReaper = null; }
    try { term.close(); } catch (_) { /* noop */ }
  };

  // ★ 릴레이 스트림은 뷰어가 죽어도 곧바로 닫히지 않는다 — 앱을 강제 종료하고 4분이 지나도
  //   데몬 쪽 소켓이 살아 있었다(2026-09-04 실측). 그동안 canonical VT 와 backend attach 가
  //   붙잡혀 있어 터미널마다 하나씩 샌다(8월에 13일 묵은 attach 가 남아 있던 원인).
  //   keepalive 를 보내던 클라이언트가 갑자기 조용해지면 그 스트림은 죽은 것으로 본다.
  //   ⚠ keepalive 를 한 번도 안 보낸 클라이언트(PC 원격 뷰어)는 대상이 아니다 — 조용한 게 정상이다.
  //  (테스트는 CPT_STREAM_IDLE_MS 로 상한을 낮춰 실제 정리 동작을 관찰한다)
  const STREAM_IDLE_MS = Math.max(500, Number(process.env.CPT_STREAM_IDLE_MS) || 90000);
  const streamOpenedAt = Date.now();
  let lastClientMsgAt = streamOpenedAt;
  let clientMsgs = 0;
  let sawKeepalive = false;
  const noteClientAlive = () => { clientMsgs++; lastClientMsgAt = Date.now(); };
  // 죽은 스트림 판정은 두 가지다. 둘 다 실측에서 나온 경우다:
  //  (1) keepalive 를 보내던 뷰어가 조용해졌다 — 앱이 죽었는데 릴레이 소켓만 살아 있는 경우.
  //  (2) 열리고 나서 **한 마디도 없다** — 폰이 죽은 뒤 백이 스트림만 다시 열어 주는 좀비.
  //      살아 있는 뷰어는 PC 든 모바일이든 접속 직후 반드시 resize 를 보낸다(그게 없으면 유령).
  //  ⚠ "조용함" 하나로만 끊으면 안 된다 — PC 원격 뷰어는 resize 뒤 계속 조용한 게 정상이다.
  //  (3) keepalive 를 아직/전혀 안 보낸 뷰어라도 아주 오래 조용하면 죽은 것으로 본다.
  //      접속 25초(=keepalive 주기) 안에 죽은 폰은 resize 만 남기고 사라져 (1)(2) 어디에도
  //      안 걸린다 — 실측에서 이 스트림이 영구히 남았다. 구버전 뷰어를 잘못 끊지 않도록
  //      상한을 넉넉히(기본 6분) 두고, 끊겨도 클라이언트가 알아서 재접속한다.
  const NO_KA_IDLE_MS = STREAM_IDLE_MS * 4;
  const deadStreamReason = (now) => {
    const silent = now - lastClientMsgAt;
    if (sawKeepalive) return silent >= STREAM_IDLE_MS ? `keepalive 끊김 ${Math.round(silent / 1000)}초` : null;
    if (clientMsgs === 0 && now - streamOpenedAt >= STREAM_IDLE_MS) return '접속 후 무응답(유령 스트림)';
    if (silent >= NO_KA_IDLE_MS) return `무응답 ${Math.round(silent / 1000)}초(keepalive 미사용 뷰어)`;
    return null;
  };
  let idleReaper = setInterval(() => {
    if (cleaned) return;
    const why = deadStreamReason(Date.now());
    if (!why) return;
    console.warn(`[pty] 스트림 정리 — ${why}`);
    try { io.close(); } catch (_) { /* noop */ }
    cleanup();
  }, Math.max(200, Math.min(15000, Math.floor(STREAM_IDLE_MS / 4))));
  if (typeof idleReaper.unref === 'function') idleReaper.unref();

  // terminal.select → 이 스트림의 attach 대상을 즉석 교체(구 모델의 select-window 대체).
  //  뷰어 연결은 유지한 채 백엔드 attach 만 갈아끼운다 — attach 가 전체 화면을 다시 그리므로
  //  (tmux 리페인트 / term-host serializeRepaint) 앱 쪽은 끊김 없이 새 터미널 내용으로 전환된다.
  if (pkey) {
    const swap = async (newTid) => {
      const myGen = ++gen; // 이 시점부터 구 핸들의 exit/close 는 무시된다
      const nextName = termSession(session, newTid);
      if (canonicalEnabled()) {
        try {
          const np = await openCanonicalStream(canonicalRegistry, nextName, {
            cols: lastW || cols, rows: lastH || rows, cwd: abs,
            onSnapshot: (snapshot) => sendSnapshot([snapshot.ansi], {
              cols: snapshot.cols, rows: snapshot.rows, canonicalModel: true, serverHistory: true, modelSeq: snapshot.seq,
            }),
            onOutput: (frame) => { if (myGen === gen) sendOut(frame.payload); },
            onExit: (code) => mkHandlers(myGen).onExit(code),
          });
          if (myGen !== gen || cleaned) { np.close(); return; }
          const old = term;
          term = np; attachName = nextName; tid = newTid;
          if (handle) handle.tid = newTid;
          paneCurrent.set(pkey, newTid);
          try { old.close(); } catch (_) { /* noop */ }
        } catch (e) {
          console.warn(`[pty] canonical 탭 전환 실패: ${(e && e.message) || e}`);
        }
        return;
      }
      const bootstrap = await buildTerminalSnapshotPayload(nextName, lastH || rows);
      const boot = { active: true, chunks: [] };
      termBackend.attach(nextName, {
        cols: lastW || cols, rows: lastH || rows, cwd: abs,
        setLatest: !usingHost(),
        ignoreSize: !usingHost(),
        ...mkHandlers(myGen, boot),
      }).then((np) => {
        if (myGen !== gen || cleaned) { try { np.close(); } catch (_) { /* noop */ } return; }
        const old = term;
        term = np;
        attachName = nextName;
        tid = newTid;
        if (handle) handle.tid = newTid;
        paneCurrent.set(pkey, newTid);
        try { old.close(); } catch (_) { /* noop */ }
        finishHistoryBootstrap(myGen, boot, bootstrap, nextName).catch(() => {});
      }).catch((e) => {
        // 스트림 사망/세션 소멸 직후 등 — 재접속 경로가 paneCurrent 로 잇는다.
        console.warn(`[pty] 탭 전환 attach 실패: ${(e && e.message) || e}`);
      });
    };
    // 같은 pane 아이덴티티의 기존 스트림 축출 — 경로 전환/재접속이 겹쳐도 tmux 클라이언트는 1개.
    const prev = paneStreams.get(pkey);
    if (prev && typeof prev.displace === 'function') {
      console.log(`[pty] 같은 pane 의 기존 스트림 축출(경로 전환/재접속) pkey=${pkey}`);
      try { prev.displace(); } catch (_) { /* noop */ }
    }
    handle = {
      tid,
      swap,
      sync: () => sendCanonicalSnapshot().then((sent) => sent || sendShellSnapshot()),
      async claim() {
        let changed = false;
        if (!usingHost()) {
          try {
            const size = String(await runTmux([
              'display-message', '-p', '-t', `=${attachName}:0`, '#{window_width}x#{window_height}',
            ])).trim();
            changed = size !== `${lastW || cols}x${lastH || rows}`;
          } catch (_) { /* 종료 경합이면 기존 resize 경로가 처리 */ }
        }
        await claimControllerLease();
        applyViewerResize(lastW || cols, lastH || rows);
        await resizeBarrier;
        // 다른 기기 크기에서 이 기기 크기로 실제 전환된 경우, tmux의 커서 좌표와 이 xterm의
        // 로컬 행 배치가 달라진다. 이때만 정본으로 한 번 재동기화한다. 같은 크기 터치마다
        // snapshot을 보내면 scrollback 복제·캡처 비용이 생기므로 changed=false에서는 금지.
        if (changed) {
          await new Promise((resolve) => setTimeout(resolve, 80)); // 셸 SIGWINCH redraw가 pane에 반영될 시간
          if (!(await sendCanonicalSnapshot())) await sendShellSnapshot();
        }
      },
      // 축출: 옛 전송을 닫고 tmux 클라이언트를 즉시 정리한다(cleanup 이 paneStreams 도 비운다).
      displace() { try { io.close(); } catch (_) { /* noop */ } cleanup(); },
    };
    paneStreams.set(pkey, handle);
  }

  // ── 와이어 의미(stdin / text) 처리기 한 벌 — 모든 전송·암호 모드가 공유한다 ──
  // 옛 "바이너리 프레임" 경로.
  // 입력이 지나갈 때 **모드 감시자에게 알린다** — shift+tab(CSI Z)이면 그 터미널을 즉시 다시 읽어
  //  채팅 알약이 3초 폴링을 기다리지 않고 곧바로 따라온다(사용자 요청 2026-08-02). 다른 키는 무시.
  //  ⚠ 우리 입력 경로를 지나가는 키만 보인다 — 사용자가 Mac 터미널에서 직접 누른 건 폴링/캐치업이 잡는다.
  const notifyInput = (payload) => {
    if (!paneId) return;
    try { require('./status-line').onTerminalInput(termSession(session, tid), payload); } catch (_) { /* noop */ }
  };
  const handleStdin = (buf) => {
    syncSeq++;
    noteClientAlive();
    notifyInput(buf);
    const input = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    const now = Date.now();
    refreshControllerLease();
    // 크기 재주장은 tmux 프로세스를 스폰한다(실측 5.5ms). 연속 타이핑마다 걸면 그 왕복이 입력에
    //  쌓이므로, 입력이 한 번 끊겼다 재개될 때만 이 기기 크기를 되찾는다.
    if (now - lastInputAt > 500) applyViewerResize(lastW || cols, lastH || rows);
    lastInputAt = now;
    // ⚠ 입력 write 는 반드시 **공유 resizeBarrier 한 줄**에만 매단다. 같은 프라미스에 등록된
    //   콜백은 등록 순서대로 실행되므로 이것이 곧 키 순서 보장이다. 여기에 입력별 비동기 단계를
    //   하나라도 끼우면 순서가 뒤집힌다(2026-09-04: 리스 클레임을 await 해 실제로 뒤집혔다 —
    //   `echo 0123…` 가 `mlkjihgfedcba9876543210 ohcesqrpontuv` 로 도착).
    resizeBarrier.then(() => { try { term.write(input); } catch (_) { /* noop */ } });
  };
  // 옛 "텍스트 프레임" 경로 — JSON 이면 resize, 아니면 일반 입력(폴스루). 봉인 모드/LAN TEXT 프레임의
  //  payload 가 **그대로** 이 함수로 들어온다(원문 JSON 보존 = 리사이즈 의미 불변).
  const handleTextFrame = (str) => {
    noteClientAlive();
    try {
      const m = JSON.parse(str);
      // 연결 유지 프레임은 터미널 입력도, 크기 주장도 아니다. 예전 모바일은 keepalive 로 resize 를
      // 재전송해 크기가 다른 세 기기가 25초마다 window-size latest 를 서로 빼앗았고, 그 SIGWINCH
      // 재도장이 tmux history 와 기기별 xterm scrollback 에 반복 적재됐다.
      if (m && m.type === 'keepalive') { sawKeepalive = true; noteClientAlive(); return; }
      if (m && m.type === 'sync') { sendCanonicalSnapshot().then((sent) => { if (!sent) sendShellSnapshot(); }); return; }
      // 스크롤 라우팅 모드 정본 — 클라이언트가 DECSET 을 엿보며 추측하지 않게 서버가 알려준다.
      //  tmux 는 alternate-screen off + smcup@ 로 1049 를 클라이언트에도 서버 VT 에도 보내지 않으므로
      //  "지금 풀스크린 앱인가"는 tmux 의 #{alternate_on} 만 알 수 있다. 그 값을 override 로 얹는다.
      if (m && m.type === 'modes' && protocolV2) {
        (async () => {
          // tmux 는 pane 의 alternate/mouse 상태를 자기가 들고 있고, smcup@ 때문에 그 전환을
          //  클라이언트에도 서버 VT 에도 보내지 않는다. 그래서 tmux 값이 이 둘의 정본이다.
          //  ⚠ alternate-screen 옵션이 off 이면 tmux 도 추적을 안 해 늘 0 이 된다(ensureTruecolor 가 on 강제).
          let tmuxModes = null;
          if (!usingHost()) {
            try {
              const raw = await runTmux(['display-message', '-p', '-t', `=${attachName}:0`, '#{alternate_on},#{mouse_any_flag}']);
              const [alt, mouse] = String(raw).trim().split(',');
              tmuxModes = { altScreen: alt === '1', mouseTracking: mouse === '1' };
            } catch (_) { /* 세션 전환 경쟁 — 아래 폴백 */ }
          }
          let modes;
          if (term && term.model && typeof term.model.modes === 'function') {
            // canonical VT 가 있으면 appCursor/bracketedPaste 까지 정확하다. mouse/alt 만 tmux 로 덮는다.
            modes = await term.model.modes(tmuxModes || {});
          } else if (tmuxModes) {
            modes = { appCursor: false, bracketedPaste: false, ...tmuxModes };
          } else {
            return; // 알 수 없으면 침묵 — 클라이언트가 로컬 추론으로 폴백한다.
          }
          sendFrame(terminalV2.OPCODE.METADATA, JSON.stringify({ kind: 'modes', ...modes }));
        })().catch(() => {});
        return;
      }
      if (m && m.type === 'history' && protocolV2) {
        // 과거의 정본은 **tmux 격자**다(canonical VT 스크롤백이 아니라). tmux 는 리사이즈마다 pane 을
        //  다시 그리는데, 그 스트림을 먹는 VT 는 재도장 잔재까지 과거로 쌓는다(실측: 리사이즈 7회에
        //  43줄 과다). 그래서 canonical 플래그와 **무관하게** 백엔드에서 바로 읽는다 — 그래야
        //  프로덕션 기본값(canonical off)에서도 PC 원격·모바일이 같은 과거를 본다.
        (async () => {
          let page = null;
          if (typeof termBackend.historyPage === 'function') {
            page = await termBackend.historyPage(attachName, { before: m.before, limit: m.limit }).catch(() => null);
          }
          if (!page && term && term.model && typeof term.model.historyPage === 'function') {
            page = await term.model.historyPage({ before: m.before, limit: m.limit }).catch(() => null);
          }
          if (page) sendFrame(terminalV2.OPCODE.HISTORY_PAGE, JSON.stringify(page));
        })().catch(() => {});
        return;
      }
      if (m && m.type === 'resize' && m.cols && m.rows) {
        const w = m.cols | 0, h = m.rows | 0;
        // ★ 퇴화 크기는 받지 않는다(2026-09-05 안드로이드 실기 실측). 클라이언트의 격자가 숨겨진
        //   상태에서 fit 하면 xterm FitAddon 이 자기 최소값(MINIMUM_COLS=2, MINIMUM_ROWS=1)을
        //   돌려주는데, tmux 는 `window-size latest` 라 그 값이 **공유 window 를 2x1 로 접고**
        //   그 창을 보는 모든 기기가 같이 무너진다(실측: win=2x1, history 가 2자짜리 줄로 폭발).
        //   실제 기기 중 8x3 보다 작은 뷰어는 없다 — 이건 오직 버그 신호다. 클라 방어와 이중으로 둔다.
        if (w < MIN_VIEWER_COLS || h < MIN_VIEWER_ROWS) {
          console.warn(`[pty] 퇴화 resize 무시 — ${w}x${h} (뷰어 격자가 숨겨진 상태의 fit 으로 추정)`);
          return;
        }
        lastW = w; lastH = h;
        mayResizeForLease().then(async (allowed) => {
          const wasFirstResize = !firstResizeDone;
          const v1Size = `${w}x${h}`;
          const needsV1Snapshot = !protocolV2 && v1Size !== lastV1SnapshotSize;
          if (needsV1Snapshot) lastV1SnapshotSize = v1Size;
          if (wasFirstResize) firstResizeDone = true;
          // 컨트롤러 lease는 공유 PTY 크기만 보호한다. 로컬 xterm history 복원까지 막으면
          // PC가 활성인 동안 새 Android/iOS는 baseY≈0으로 영구 고착된다.
          if (!allowed) {
            if (needsV1Snapshot) await sendV1ViewerSnapshot(h);
            return;
          }
          await claimControllerLease();
          applyViewerResize(w, h);
          await resizeBarrier;
          if (protocolV2) sendFrame(terminalV2.OPCODE.RESIZED, JSON.stringify({ epoch: streamEpoch, cols: w, rows: h, owner: leaseOwner }));
          if (wasFirstResize) {
            if (w !== attachW || h !== attachH) {
              if (nudgeTimer) clearTimeout(nudgeTimer);
              nudgeTimer = setTimeout(() => {
                const nudge = () => { try { term.resize(Math.max(2, lastW - 1), lastH); term.resize(lastW, lastH); } catch (_) { /* noop */ } };
                if (usingHost()) nudge();
                else runTmux(['display-message', '-p', '-t', `=${attachName}:0`, '#{alternate_on}'])
                  .then((v) => { if (String(v).trim() === '1') nudge(); }).catch(() => {});
              }, 600);
            }
          }
          if (needsV1Snapshot) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            await sendV1ViewerSnapshot(h);
          }
        }).catch(() => {});
        return;
      }
    } catch (_) { /* JSON 아니면 일반 입력 */ }
    handleStdin(str);
  };

  // 핸들러 등록 = 어댑터가 버퍼해 둔 셋업 중 메시지(첫 resize 등)의 순서 재생 시점.
  io.onMessage((kind, payload) => {
    if (kind === 'text') handleTextFrame(typeof payload === 'string' ? payload : payload.toString('utf8'));
    else handleStdin(payload);
  });
  io.onClose(cleanup);
}

// ── 멀티 터미널 RPC ──
// 터미널 = 전용 세션(termSession) 모델. list/new/close = 전 기기 공통 durable 목록(tmux 세션들),
// select = 이 pane 스트림의 attach 대상 교체. 전용 소켓 -L codingpt 규율 유지.
function runTmux(args) {
  return new Promise((resolve, reject) => {
    const tmux = findTmux();
    if (!tmux) return reject(new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)'));
    // ⚠ tmuxEnv() 필수 — TMUX 해제 + UTF-8 강제. UTF-8 이 아니면 tmux 가 `-F` 의 TAB 구분자까지
    //  '_' 로 이스케이프해 이 함수의 **모든 호출자의 파싱이 조용히 전멸**한다(tmuxEnv 주석 참조).
    const env = tmuxEnv();
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
  if (usingHost()) return; // term-host 는 자동 개명이 세션 내장(session.windowName) — tmux 옵션 주입 불요
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
//  CPT_TID/CPT_TSESSION = 이 터미널의 안정 좌표(세션명에서 역산 — 전용 세션에만 존재),
//  PATH prepend(~/.codingpt/bin) 는 shim(P5)이 담당 — 여기서는 좌표만.
//  ⚠ 이미 떠 있는 셸은 env 변경을 못 받는다(tmux 세션 env 는 "이후 spawn 되는" 프로세스만 상속). 그래서
//   초기 셸용으로 poolEnvArgs(new-session -e)가 따로 있고, 레거시 풀에서 move-window 로 옮겨온 셸은
//   respawn 될 때까지 CPT_TID 를 못 받는다 → CLI 는 그 경우 tmux display-message 폴백으로 정상 동작한다.
//   이 함수는 세션 env 영속(재spawn/attach 대비)용 — 멱등.
const poolEnvDone = new Set(); // 세션당 1회(데몬 수명 동안) — set-environment 반복 호출 절약
async function injectPoolEnv(session, abs) {
  if (poolEnvDone.has(session)) return;
  const rel = fsLib.relOf ? fsLib.relOf(abs) : '';
  // 소켓 경로는 cpt-server 와 동일 규칙(sun_path 한계 폴백 포함) — 어긋나면 CLI 가 유령 소켓을 본다.
  const sock = require('./cpt-server').sockPath();
  const tmuxBin = usingHost() ? null : findTmux();
  await termBackend.setEnv(session, 'CPT_WS', rel == null ? '' : String(rel));
  await termBackend.setEnv(session, 'CPT_SOCK', sock);
  // 전용 세션("<ns>--t-<tid>")만 터미널 좌표를 가진다. 레거시 홈 세션(codingpt)/풀 세션은 tid 가 없으므로
  //  주입하지 않는다(틀린 tid 주입 = 알림 win·읽음 scope 오류).
  const tm = /--t-(\d+)$/.exec(session);
  if (tm) {
    await termBackend.setEnv(session, 'CPT_TID', tm[1]).catch(() => {});
    await termBackend.setEnv(session, 'CPT_TSESSION', session).catch(() => {});
  }
  if (tmuxBin) await termBackend.setEnv(session, 'CPT_TMUX', tmuxBin);
  // shim(cpt/claude/codex 래퍼) 경로를 PATH 선두에 — 새 window 셸부터 적용.
  //  zsh 는 rc 가 PATH 를 재구성해 이 값이 밀린다(실측) → ZDOTDIR 체인으로 rc 이후에 재-prepend.
  //  (win32: ZDOTDIR 무의미 — PATH prepend 만. 셸 프로필 주입은 term-host defaultShell 이 담당.)
  const shimBin = path.join(runtime.stateDir(), 'bin');
  const basePath = process.env.PATH || (process.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin');
  await termBackend.setEnv(session, 'PATH', `${shimBin}${path.delimiter}${basePath}`).catch(() => {});
  if (process.platform !== 'win32') {
    try {
      const shimLib = require('./shim');
      const zdot = shimLib.zdotDir();
      if (fs.existsSync(zdot)) {
        const origZdot = process.env.ZDOTDIR || '';
        await termBackend.setEnv(session, 'ZDOTDIR', zdot);
        if (origZdot && origZdot !== zdot) await termBackend.setEnv(session, 'CPT_ORIG_ZDOTDIR', origZdot);
      }
    } catch (_) { /* shim 미생성 — PATH 주입만으로 동작(제한적) */ }
  }
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
    //  agent* 4필드는 추가 전용(2026-07-25) — 클라의 "에이전트 붙었나" 판정 정본(§1.6).
    //   agent(true|false|null — **false 는 셸 확정만**, null=모름) · agentName('claude'|'codex'|'gemini'|null)
    //   · agentState('idle'|'working'|'permission'|'needsInput'|null)
    //   · agentSource('hook'|'watch'|'title'|'shell'|null). agent 가 true 가 아니면 name/state 는 전부 null.
    //  ⚠ session/created 는 내부 필드라 여기서 싣지 않는다(기존과 동일 — 와이어 표면을 넓히지 않는다).
    const list = await listTerminals(session);
    return {
      windows: list.map((t) => ({
        index: t.index, name: t.name, command: t.command,
        agent: t.agent, agentName: t.agentName, agentState: t.agentState, agentSource: t.agentSource,
        agentReady: t.agentReady,
      })),
    };
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
      if (h && params && params.claim) {
        try {
          if (typeof h.claim === 'function') h.claim();
          else if (typeof h.sync === 'function') h.sync();
        } catch (_) { /* 포커스 동기화는 세션 전환 경쟁 시 다음 터치가 복구 */ }
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
    // 완전 삭제(전 기기 공통) = kill 등가. 세션이 이미 없거나 서버가 죽었어도 멱등 성공(백엔드 규칙).
    const tid = Number(params && params.index);
    await termBackend.kill(termSession(session, tid));
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
  if (usingHost()) return 0; // 뷰 세션은 tmux 레거시 산물 — term-host 백엔드엔 존재하지 않는다
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
  if (usingHost()) return 0; // zdot(zsh) 훅 배선 치유 = darwin tmux 전용(win32 셸 프로필은 계약 4 별도)
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

module.exports = { openPtyStream, attachPty, wsPtyIo, findTmux, tmuxEnv, handleTerminalRpc, runTmux, poolWindows, sessionForCwd, paneSession, termSession, newTid, listTerminals, createTerminal, migrateLegacyPool, resolveTid, reapStaleViews, healStaleTerminals, poolEnvMap, normalizeResizePromptHistory, TMUX_SOCKET, TMUX_SESSION, CONF_ARGS };
