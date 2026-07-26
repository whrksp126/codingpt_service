// 목록(terminal.list)의 정규화 에이전트 신호 — **실 tmux** 배관 회귀(node --test).
//   실행: node --test packages/runner-core/test/terminal-agent-flag.test.js
//
// 배경(2026-07-25 사용자 증상): "터미널에 claude 가 도는데 챗/TUI 전환 토글이 있다 없다 한다."
//   진단 결론 = push(agent_state)가 비는 순간(스테일 15분·WS 재접속 공백·데몬 재기동·서버 cap 미선언)에
//   클라이언트가 `command` 를 이름 패턴(`/^(claude|codex|gemini)$/`)으로 되짚는 구조였고, 최신 Claude Code 의
//   pane_current_command 는 `2.1.219` 같은 **버전 문자열**이라 그 폴백이 영구 미매치다 → 토글이 사라진다.
//   대책 = 5~9초마다 무조건 다시 오는 터미널 목록에 **데몬이 판정한** agent 신호를 추가 전용으로 싣는다.
//
// 이 파일이 증명하는 것(순수 단위 테스트로는 못 잡는 것들):
//   ① listTerminals 가 pane_title 을 실제로 조회해 판정에 쓴다(format 문자열이 깨지면 여기서 죽는다).
//   ② 판정이 window_name 에 의존하지 않는다 — 수동 rename 한 터미널(automatic-rename OFF, 이름 얼어붙음)도
//      감지된다(구 폴백 후보였던 "tab.title 글리프" 는 그 터미널에서 죽는다).
//   ③ 셸 터미널은 pane_title 에 스테일 글리프가 남아 있어도 OFF(빈 탭 토글 = 직전 라운드 blocker).
//   ④ 와이어 표면이 넓어지지 않는다 — windows[] 키 집합이 정확히 기존 3 + agent 4 개다(제목 원문 유출 금지).
//   ⑤ 에이전트 → 셸 복귀가 목록에서 OFF 로 전이한다.
//   ⑥ (2026-07-25 추가) **근거 0 = `agent:null`(모름)**, `false` 는 셸 확정만. 그리고 그 행을 앱·PC 의
//      **실제 사다리에 그대로 먹여** 최종 노출이 3플랫폼 동일함을 확인한다(§합성). 데몬 단위 테스트와
//      클라 단위 테스트가 **같은 값에 반대 의미**를 적어 놓고 양쪽 다 초록이던 것이 이번 결함의 형태다.
//
// 안전: 반드시 CODINGPT_TMUX_SOCKET 로 격리 소켓을 강제한 뒤 pty.js 를 require 한다 —
//   사용자 실사용 `-L codingpt` 세션은 절대 건드리지 않는다(reconnect-race.test.js 와 동일 규율).

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const SOCK = `codingpt-agentflag-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-agentflag-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const pty = require('../pty');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '테스트가 격리 소켓을 못 잡았다(실사용 소켓 오염 위험) — 중단');

const WS_REL = 'ws1';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });
const { session: NS, abs: ABS } = pty.sessionForCwd(WS_REL);

// 실측 문자열 그대로(사용자 Mac 라이브 claude 세션) — 여기서 깨지면 라이브에서 다시 죽는다는 뜻이다.
const LIVE_CMD = '2.1.219';
const LIVE_TITLE_IDLE = '✳ 히어로 아래에 고객 후기 섹션 추가';
const LIVE_TITLE_WORK = '⠹ 히어로 아래에 고객 후기 섹션 추가';
const SHELL_RE = /^-?(zsh|bash|sh|fish|login|tcsh)$/;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}
const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pane_current_command 를 `2.1.219` 로 만드는 유일한 방법 = **그 이름의 실행 파일을 실제로 돌리는 것**
//  (최신 claude 가 정확히 이렇게 보인다 — 이름은 벤더가 언제든 바꾸므로 판정 근거가 될 수 없다는 증거).
//  ⚠ /bin/sleep 같은 플랫폼 바이너리 복사는 macOS 코드서명 검증에 걸려 SIGKILL(137) 된다(실측) —
//  그래서 지금 돌고 있는 node 를 하드링크(같은 inode = 서명 유효)해서 쓴다. 링크 불가(다른 볼륨)면 복사.
let agentBinPath = null;
function fakeAgentBin() {
  if (agentBinPath) return agentBinPath;
  const p = path.join(ROOT, LIVE_CMD);
  try { fs.linkSync(process.execPath, p); } catch (_) {
    fs.copyFileSync(process.execPath, p);
    fs.chmodSync(p, 0o755);
  }
  agentBinPath = p;
  return p;
}
const AGENT_ARGS = "-e 'setInterval(()=>{},1000)'"; // 끝나지 않는 전경 프로세스(에이전트 TUI 대역)

// 목록에서 이 터미널 한 줄을 찾는다(pty 의 실제 조회 경로 그대로).
const rowOf = async (tid) => (await pty.listTerminals(NS)).find((t) => t.index === tid) || null;
// tmux 는 프로세스 전환을 즉시 반영하지 않는다(셸 rc·spawn 지연) — 조건이 될 때까지 폴링.
async function waitRow(tid, pred, ms = 8000) {
  const t0 = Date.now();
  let row = null;
  for (;;) {
    row = await rowOf(tid);
    if (row && pred(row)) return row;
    if (Date.now() - t0 >= ms) return row;
    await sleep(120);
  }
}

after(async () => {
  try { await tmux(['kill-server']); } catch (_) { /* 이미 없음 */ }
  // 소켓 파일까지 지운다 — 안 지우면 /tmp/tmux-<uid>/ 에 테스트 소켓이 무한 누적된다(기존 테스트들의 잔재).
  //  경로는 tmux 규칙(TMUX_TMPDIR 또는 /tmp)/tmux-<uid>/<소켓명> — os.tmpdir() 이 아니다(macOS 는 /var/folders).
  try {
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCK), { force: true });
  } catch (_) { /* noop */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

test('버전 문자열 cmd + 글리프 제목 = 목록에 agent ON(수동 rename 터미널도)', { skip: !hasTmux }, async () => {
  const bin = fakeAgentBin();
  const tid = 1000101;
  const sess = pty.termSession(NS, tid);
  //  -e NODE_OPTIONS= : 이 리포의 개발 셸이 NODE_OPTIONS preload 를 걸어 두면 자식 node 가 즉사한다.
  await tmux(['new-session', '-d', '-s', sess, '-c', ABS, '-e', 'NODE_OPTIONS=', `exec ${bin} ${AGENT_ARGS}`]);
  await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', LIVE_TITLE_IDLE]);
  // ② 사용자가 수동 rename → automatic-rename OFF → window_name 이 얼어붙는다(제목 글리프 폴백 사망).
  await tmux(['rename-window', '-t', `=${sess}:0`, '내 작업 탭']);

  const row = await waitRow(tid, (r) => r.command === LIVE_CMD);
  assert.ok(row, '터미널이 목록에 없다');
  assert.strictEqual(row.command, LIVE_CMD, '실측대로 pane_current_command 가 버전 문자열이어야 한다');
  assert.strictEqual(row.name, '내 작업 탭', '이름은 얼어붙은 그대로(클라의 제목 글리프 폴백은 여기서 죽는다)');
  assert.strictEqual(row.agent, true, '데몬 판정이 이름 대신 pane_title 글리프를 근거로 ON 해야 한다');
  assert.strictEqual(row.agentName, 'claude');
  assert.strictEqual(row.agentState, 'idle');
  assert.strictEqual(row.agentSource, 'title');

  // working(점자 스피너)도 같은 규칙 — 이름은 특정 불가(claude/codex 공용)지만 ON 은 유지.
  await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', LIVE_TITLE_WORK]);
  const work = await waitRow(tid, (r) => r.agentState === 'working');
  assert.strictEqual(work.agent, true);
  assert.strictEqual(work.agentState, 'working');
  assert.strictEqual(work.agentName, null);

  // ④ 와이어 표면 = 기존 3 + agent 4. 제목 원문(사용자 프롬프트)은 절대 새 필드로 나가지 않는다.
  const r = await pty.handleTerminalRpc('terminal.list', { cwd: WS_REL });
  const w = r.windows.find((x) => x.index === tid);
  assert.deepStrictEqual(
    Object.keys(w).sort(),
    ['agent', 'agentName', 'agentSource', 'agentState', 'command', 'index', 'name'],
    'terminal.list 응답 키가 바뀌었다(추가 전용 규율 위반 또는 내용성 정보 유출)',
  );
  assert.strictEqual(w.agent, true);
  assert.strictEqual(JSON.stringify(w).includes('히어로'), false, '제목 원문이 응답에 섞였다');

  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: tid });
});

test('셸 터미널은 스테일 글리프 제목에서도 agent OFF', { skip: !hasTmux }, async () => {
  const t = await pty.createTerminal(NS, ABS); // 실제 셸
  await tmux(['select-pane', '-t', `=${t.session}:0.0`, '-T', LIVE_TITLE_WORK]); // 에이전트 종료 후 잔상
  // 셸 rc 가 프롬프트용 서브프로세스(git 등)를 돌리는 순간을 피해 "셸이 전경" 일 때를 본다.
  const row = await waitRow(t.index, (r) => SHELL_RE.test(r.command));
  assert.ok(row, '터미널이 목록에 없다');
  assert.match(row.command, SHELL_RE, `셸이 전경이 되지 않았다: ${row.command}`);
  assert.strictEqual(row.agent, false, '빈 셸 탭에 토글이 굳으면 안 된다(하드 OFF)');
  assert.strictEqual(row.agentName, null);
  assert.strictEqual(row.agentState, null);
  assert.strictEqual(row.agentSource, 'shell', 'false 의 근거를 남긴다(모름과 구별되는 유일한 부정)');
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: t.index });
});

// ★★ 사용자 증상의 정면 재현(2026-07-25 합성 교차검증 blocker): 살아 있는 claude 인데 판정 근거가
//  하나도 없는 순간(제목 글리프 부재 + 훅 레코드 0건)에 목록이 `agent:false` 를 실으면 클라 사다리가
//  그것을 **명시적 부정**으로 읽어 토글이 사라진다. 근거 0 은 `null`(모름)이어야 하고, 그러면 앱·PC 의
//  normalizeDaemonAgentFlag 가 "필드 부재" 와 같게 접어 아래 폴백 칸으로 내려간다(클라 수정 0).
test('제목 글리프·훅이 둘 다 없는 살아있는 프로세스 = agent:null(모름) — false 로 접지 않는다',
  { skip: !hasTmux }, async () => {
    const bin = fakeAgentBin();
    const tid = 1000103;
    const sess = pty.termSession(NS, tid);
    await tmux(['new-session', '-d', '-s', sess, '-c', ABS, '-e', 'NODE_OPTIONS=', `exec ${bin} ${AGENT_ARGS}`]);
    // CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 / showStatusInTerminalTab / resume·agents·폴더 신뢰 화면 =
    //  제목에 글리프가 없다(실측 3화면 전부). 훅도 안 왔다(데몬 재기동 직후·CPT_HOOKS_DISABLED·PATH 경합).
    await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo']);

    const row = await waitRow(tid, (r) => r.command === LIVE_CMD);
    assert.ok(row, '터미널이 목록에 없다');
    assert.strictEqual(row.command, LIVE_CMD);
    assert.strictEqual(row.agent, null, '근거 0 은 모름이다 — false 면 클라가 토글을 영구히 숨긴다');
    assert.strictEqual(row.agentName, null);
    assert.strictEqual(row.agentState, null);
    assert.strictEqual(row.agentSource, null);

    // RPC 응답(와이어)에도 null 그대로 실려야 한다 — JSON 왕복에서 false 로 접히지 않는지 확인.
    const r = await pty.handleTerminalRpc('terminal.list', { cwd: WS_REL });
    const w = JSON.parse(JSON.stringify(r)).windows.find((x) => x.index === tid);
    assert.strictEqual(w.agent, null);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(w, 'agent'), true, '키 자체는 유지(추가 전용)');

    await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: tid });
  });

test('에이전트 → 셸 복귀(프로세스 종료)가 목록에서 OFF 로 반영된다', { skip: !hasTmux }, async () => {
  const bin = fakeAgentBin();
  const tid = 1000102;
  const sess = pty.termSession(NS, tid);
  // 셸 안에서 에이전트를 띄운 실제 사용 형태(종료하면 셸로 돌아온다).
  await tmux(['new-session', '-d', '-s', sess, '-c', ABS, '-e', 'NODE_OPTIONS=']);
  await waitRow(tid, (r) => SHELL_RE.test(r.command)); // 프롬프트 준비 대기(rc 실행 중 send-keys 유실 방지)
  await tmux(['send-keys', '-t', `=${sess}:0.0`, `${bin} ${AGENT_ARGS}`, 'Enter']);
  await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', LIVE_TITLE_WORK]);
  const on = await waitRow(tid, (r) => r.command === LIVE_CMD);
  assert.strictEqual(on.command, LIVE_CMD, '에이전트가 전경이 되지 않았다(테스트 전제 실패)');
  assert.strictEqual(on.agent, true);

  await tmux(['send-keys', '-t', `=${sess}:0.0`, 'C-c']); // 종료 — pane_title 은 스테일하게 남는다
  const off = await waitRow(tid, (r) => SHELL_RE.test(r.command));
  assert.match(off.command, SHELL_RE, '셸로 돌아오지 않았다(테스트 전제 실패)');
  assert.strictEqual(off.agent, false, '에이전트 종료가 목록에 즉시 반영돼야 한다(셸 하드 OFF)');
  assert.strictEqual(off.agentState, null);
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: tid });
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ 합성 — 데몬 목록 행을 **앱·PC 의 실제 사다리 코드**에 그대로 먹인다.
//
// 왜 여기서 해야 하는가: 이 결함은 세 패키지가 각자 초록인 상태로 존재했다. 데몬 테스트는 같은 입력에
//  `agent:false` 를 못박고, 앱 테스트는 `agent:false` 를 "명시적 부정 → 토글 OFF" 로 못박았다 =
//  두 계약서가 같은 값에 반대 의미를 적어 둔 상태. 경계는 **합성해서 실행할 때만** 보인다.
//  · 앱 `agentPresence.ts` 는 TS 라 형제 리포의 typescript 로 타입만 벗겨 실행한다(선례: PC
//    test/agent-toggle.mjs §3).
//  · PC 는 목록을 Rust(tmux_list_windows)로 받으므로 `agent`/`agentState` 필드가 **구조적으로 없다** —
//    그래서 PC 에는 그 필드를 뺀 탭을 준다(실제 배관을 그대로 모사. 이 비대칭이 "PC 는 보이는데 폰만
//    안 보인다" 의 원인이었다).
//  형제 리포가 없는 단독 체크아웃/의존성 미설치면 SKIP 한다(다른 절은 계속 돈다).
// ══════════════════════════════════════════════════════════════════════════════
const SIBLINGS = {
  app: path.resolve(__dirname, '../../../../../codingpt_app/src/workspace/agentPresence.ts'),
  appPkg: path.resolve(__dirname, '../../../../../codingpt_app/package.json'),
  pc: path.resolve(__dirname, '../../../../codingpt_pc/src/js/agent-signal.js'),
};
async function loadLadders() {
  if (!fs.existsSync(SIBLINGS.app) || !fs.existsSync(SIBLINGS.appPkg) || !fs.existsSync(SIBLINGS.pc)) return null;
  try {
    const { createRequire } = require('module');
    const ts = createRequire(SIBLINGS.appPkg)('typescript');
    const js = ts.transpileModule(fs.readFileSync(SIBLINGS.app, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const APP = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
    const PC = await import(`file://${SIBLINGS.pc}`);
    if (typeof APP.resolveAgentPresence !== 'function' || typeof PC.resolveAgentPresence !== 'function') return null;
    return { APP, PC };
  } catch (_) { return null; }
}
// 앱은 데몬 행을 그대로 받는다(daemonService.listTerminals → WorkspaceShellContext 리컨실러).
const appTabOf = (row) => ({ cmd: row.command, title: row.name, agent: row.agent, agentState: row.agentState });
// PC 는 Rust 목록이라 agent* 가 없다(state.js 는 undefined 를 그대로 둔다).
const pcTabOf = (row) => ({ cmd: row.command, title: row.name });

test('합성 — 데몬 행을 앱·PC 사다리에 먹이면 최종 노출이 3플랫폼 동일하다', { skip: !hasTmux }, async (t) => {
  const L = await loadLadders();
  if (!L) { t.skip('앱/PC 사다리를 실행할 수 없다(단독 체크아웃 또는 의존성 미설치)'); return; }
  const { APP, PC } = L;
  const both = (row) => {
    const app = APP.resolveAgentPresence({ push: null, tab: appTabOf(row) });
    const pc = PC.resolveAgentPresence({ push: null, tab: pcTabOf(row) });
    return { app, pc };
  };

  const bin = fakeAgentBin();
  const tid = 1000104;
  const sess = pty.termSession(NS, tid);
  await tmux(['new-session', '-d', '-s', sess, '-c', ABS, '-e', 'NODE_OPTIONS=', `exec ${bin} ${AGENT_ARGS}`]);

  // (a) 사용자 신고 케이스: 살아 있는 claude + 글리프 없는 제목 + 훅 0건 = 근거 0.
  await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo']);
  const none = await waitRow(tid, (r) => r.command === LIVE_CMD);
  const rNone = both(none);
  assert.strictEqual(none.agent, null, `근거 0 행이 모름이어야 한다(got ${JSON.stringify(none.agent)})`);
  assert.strictEqual(rNone.app.on, true, `앱에서 토글이 사라졌다: ${JSON.stringify(rNone.app)}`);
  assert.strictEqual(rNone.pc.on, true, `PC 에서 토글이 사라졌다: ${JSON.stringify(rNone.pc)}`);
  assert.strictEqual(rNone.app.on, rNone.pc.on,
    `같은 pane 인데 앱=${JSON.stringify(rNone.app)} PC=${JSON.stringify(rNone.pc)} — 사용자 요구는 "pc·android·ios 다"`);

  // (b) 대조군: 글리프 제목 → 양쪽 ON.
  await tmux(['select-pane', '-t', `=${sess}:0.0`, '-T', LIVE_TITLE_IDLE]);
  const glyph = await waitRow(tid, (r) => r.agent === true);
  const rGlyph = both(glyph);
  assert.strictEqual(rGlyph.app.on, true);
  assert.strictEqual(rGlyph.pc.on, true);
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: tid });

  // (c) 대조군: 빈 셸(스테일 글리프 잔존) → 양쪽 OFF. 유일한 항상-숨김이 살아 있어야 한다.
  const sh = await pty.createTerminal(NS, ABS);
  await tmux(['select-pane', '-t', `=${sh.session}:0.0`, '-T', LIVE_TITLE_WORK]);
  const shellRow = await waitRow(sh.index, (r) => SHELL_RE.test(r.command));
  assert.match(shellRow.command, SHELL_RE, `셸이 전경이 되지 않았다: ${shellRow.command}`);
  assert.strictEqual(shellRow.agent, false, '셸은 유일한 명시적 부정이다');
  const rShell = both(shellRow);
  assert.strictEqual(rShell.app.on, false, `빈 셸 탭에 토글이 굳었다: ${JSON.stringify(rShell.app)}`);
  assert.strictEqual(rShell.pc.on, false, `빈 셸 탭에 토글이 굳었다: ${JSON.stringify(rShell.pc)}`);
  await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: sh.index });
});
