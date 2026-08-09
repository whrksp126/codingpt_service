// 에이전트 완료 폴백 감지(agent-watch) 상태머신 테스트 — node 내장 러너.
//  실행: node --test packages/runner-core/test/agent-watch.test.js
//  tmux/서버 무접촉: pty(runTmux)·cpt-server(backFetch)를 require 캐시로 스텁하고
//  observe() 에 스냅샷을 직접 주입한다. 발사는 QUIET_MS(3s) 실타이머 — 테스트가 기다린다.
// win32 CI: 이 파일은 ptyLib.runTmux 몽키패치/캐시 스텁으로 돈다 — 파이프 백엔드가 활성이면 스텁이
//  안 걸리므로 tmux 구현을 강제한다(실행이 runTmux 지연 참조라 tmux 바이너리 불요 — term-backend 주석).
process.env.CPT_TERM_BACKEND = "tmux";
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// agent-watch 가 lazy-require 하는 의존 2종을 선점 스텁(실 tmux/백엔드 무접촉).
const fired = [];
require.cache[require.resolve('../pty')] = {
  id: require.resolve('../pty'), loaded: true, children: [],
  exports: { runTmux: async () => 'CPT_WS=proj/demo\n' },
};
require.cache[require.resolve('../cpt-server')] = {
  id: require.resolve('../cpt-server'), loaded: true, children: [],
  exports: { backFetch: async (_m, _p, body) => { fired.push(body); return {}; } },
};
const watch = require('../agent-watch');
const agentState = require('../agent-state'); // 상태/알림 소유자 — 폴백은 이 모듈로만 보고한다

// 와이어 방출 수집 — 감지가 살아 있어도 방출이 안 되면 모바일 TUI↔Chat 토글은 안 뜬다(계약 §1.3).
const frames = [];
agentState.configure({ emit: (f) => { frames.push(f.event); return true; } });

const S = (tid) => `cpt-demo--t-${tid}`;
const row = (tid, cmd, title) => ({ session: S(tid), cmd, title });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(20); // cwdRel 최초 해석(show-environment 스텁)이 비동기라 1틱 양보
const WAIT = 3600; // QUIET_MS(3000) + 여유

function resetAll() {
  fired.length = 0;
  frames.length = 0;
  for (const [k, st] of watch._states) { if (st.pendingTimer) clearTimeout(st.pendingTimer); watch._states.delete(k); }
  agentState._reset(); // 훅 지배/발사 이력까지 초기화(케이스 간 독립)
}

test('titleStatus — 글리프 판정', () => {
  assert.strictEqual(watch.titleStatus('⠋ Reticulating…'), 'working'); // 점자 스피너
  assert.strictEqual(watch.titleStatus('✳ claude'), 'idle');
  assert.strictEqual(watch.titleStatus('✦ thinking'), 'working');
  assert.strictEqual(watch.titleStatus('◇ Gemini CLI'), 'idle');
  assert.strictEqual(watch.titleStatus('✋ Gemini CLI'), 'permission');
  assert.strictEqual(watch.titleStatus('me@mac: ~/proj'), null);
  assert.strictEqual(watch.titleStatus(''), null);
});

test('첫 관찰(시드)은 이벤트를 만들지 않는다', async () => {
  resetAll();
  watch.observe([row(1000001, 'claude', '✳ claude')]); // 재기동 직후 idle 터미널
  watch.observe([row(1000001, 'claude', '✳ claude')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});

test('title 전이 working→idle = done 폴백 알림', async () => {
  resetAll();
  watch.observe([row(1000002, 'claude', '⠙ working…')]); // 시드(working)
  watch.observe([row(1000002, 'claude', '⠹ working…')]); // 유지
  watch.observe([row(1000002, 'claude', '✳ claude')]);   // 턴 완료
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'done');
  assert.strictEqual(fired[0].source, 'watch');
  assert.strictEqual(fired[0].win, 1000002);
  assert.strictEqual(fired[0].cwd, 'proj/demo');
  assert.strictEqual(fired[0].wsName, 'demo');
  assert.strictEqual(fired[0].title, 'Claude Code');
});

test('훅이 최근에 왔으면 폴백은 침묵(dedup)', async () => {
  resetAll();
  watch.observe([row(1000003, 'claude', '⠙ working…')]);
  watch.observe([row(1000003, 'claude', '⠹ working…')]);
  watch.noteHook('proj/demo', 1000003);                  // Stop 훅 정상 수신
  watch.observe([row(1000003, 'claude', '✳ claude')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});

test('process-exit — working 중 에이전트→셸 전이 = exited done', async () => {
  resetAll();
  watch.observe([row(1000004, 'codex', '⠙ running tests')]);
  watch.observe([row(1000004, 'codex', '⠹ running tests')]);
  watch.observe([row(1000004, 'zsh', '⠹ running tests')]); // 크래시 — 타이틀은 스테일
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'done');
  assert.strictEqual(fired[0].title, 'Codex');
  assert.match(String(fired[0].body || ''), /종료/);
});

test('idle 상태에서의 종료(/exit)는 알림 없음', async () => {
  resetAll();
  watch.observe([row(1000005, 'claude', '✳ claude')]);
  watch.observe([row(1000005, 'claude', '✳ claude')]);
  watch.observe([row(1000005, 'zsh', 'me@mac: ~')]);     // 사용자가 직접 종료
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});

test('permission 전이 = permission_request', async () => {
  resetAll();
  watch.observe([row(1000006, 'gemini', '✦ thinking')]);
  watch.observe([row(1000006, 'gemini', '✦ thinking')]);
  watch.observe([row(1000006, 'gemini', '✋ Gemini CLI')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'permission_request');
});

test('node(npm 설치형) — 에이전트 글리프를 본 세션만 에이전트 취급', async () => {
  resetAll();
  watch.observe([row(1000007, 'node', 'dev server listening')]); // 일반 node — 무시
  watch.observe([row(1000007, 'node', 'dev server listening')]);
  watch.observe([row(1000007, 'zsh', 'me@mac: ~')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
  watch.observe([row(1000008, 'node', '⠙ working…')]);  // npm 설치형 claude(글리프 有)
  watch.observe([row(1000008, 'node', '⠹ working…')]);
  watch.observe([row(1000008, 'node', '✳ claude')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'done');
});

// ── 훅 주력화(2026-07-25) 이후 추가: 소유권 경계 회귀 ──

test('훅 + 폴백이 같은 턴을 동시에 감지해도 알림은 정확히 1건', async () => {
  resetAll();
  const tid = 1000010;
  watch.observe([row(tid, 'claude', '⠙ working…')]); // 시드(working)
  watch.observe([row(tid, 'claude', '⠹ working…')]);
  // 훅(Stop)이 먼저 도착 = 1차 소유자.
  await agentState.applyHook(S(tid), {
    v: 2, event: 'stop', agent: 'claude', sessionId: 'sess-x',
    tid, cwdRel: 'proj/demo', wsName: 'demo', backgroundTasks: 0, summary: '훅 완료',
  });
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].source, 'hook');
  // 폴백도 title 전이로 같은 턴을 감지 → QUIET_MS 뒤 발사 요청하지만 agent-state 가 억제한다.
  watch.observe([row(tid, 'claude', '✳ claude')]);
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1, '훅 done + 폴백 done = 알림 1건');
});

test('statusOf 는 훅 상태를 즉시 반영하고 폴백 관찰에 뒤집히지 않는다', async () => {
  resetAll();
  const tid = 1000011;
  watch.observe([row(tid, 'claude', '✳ claude')]); // 시드 idle
  assert.strictEqual(watch.statusOf(S(tid)), 'idle');
  await agentState.applyHook(S(tid), {
    v: 2, event: 'prompt', agent: 'claude', sessionId: 'sess-y', promptId: 'p1',
    tid, cwdRel: 'proj/demo', wsName: 'demo',
  });
  assert.strictEqual(watch.statusOf(S(tid)), 'working'); // 폴링(2s) 대기 없음
  watch.observe([row(tid, 'claude', '✳ claude')]);       // 폴백은 여전히 idle 로 보이지만
  assert.strictEqual(watch.statusOf(S(tid)), 'working'); // 훅 지배 중이라 상태는 유지
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});

// ── 2026-07-25 실측 회귀: 최신 Claude Code 의 프로세스 이름은 **버전 문자열**이다 ──
//  사용자 Mac 실측(라이브 claude 세션):
//    tmux -L codingpt list-panes -F '#{pane_current_command} | #{pane_title}'
//    → `2.1.219 | ✳ 히어로 아래에 고객 후기 섹션 추가`
//  이름 화이트리스트(claude|codex|gemini + node 특례)로 판정하던 구 코드는 이 pane 을 에이전트로 보지
//  못해 ① 상태 기록 0건(→ 와이어 방출 0건 → 모바일 토글 무발현) ② process-exit 폴백 영구 미발화였다.
//  아래 값들은 **실측 문자열 그대로** 하드코딩한다 — 여기서 깨지면 라이브에서 다시 죽는다는 뜻이다.
const LIVE_CMD = '2.1.219';
const LIVE_TITLE_IDLE = '✳ 히어로 아래에 고객 후기 섹션 추가';
const LIVE_TITLE_WORK = '⠹ 히어로 아래에 고객 후기 섹션 추가'; // 점자 스피너(working)

test('판정 규칙 — 셸은 절대 제외, 제목 신호는 1급 근거(isAgentPane)', () => {
  assert.strictEqual(watch.isAgentPane(LIVE_CMD, 'idle', false), true, '버전 문자열 + 제목 신호 = 에이전트');
  assert.strictEqual(watch.isAgentPane(LIVE_CMD, null, true), true, '과거에 본 신호(sawAgentTitle)도 근거');
  assert.strictEqual(watch.isAgentPane(LIVE_CMD, null, false), false, '제목 신호 0 = 판정 보류(패턴 단독 채택 금지)');
  assert.strictEqual(watch.isAgentPane('zsh', 'working', true), false, '셸은 스테일 제목이 있어도 에이전트가 아니다');
  assert.strictEqual(watch.isAgentPane('claude', null, false), true, '이름으로 확실한 경우');
  assert.strictEqual(watch.isAgentPane('vim', null, false), false);
});

test('titleAgent — 특정 가능한 글리프만 이름을 추론한다', () => {
  assert.strictEqual(watch.titleAgent(LIVE_TITLE_IDLE), 'claude');
  assert.strictEqual(watch.titleAgent('◇ Gemini CLI'), 'gemini');
  assert.strictEqual(watch.titleAgent('✋ Gemini CLI'), 'gemini');
  assert.strictEqual(watch.titleAgent(LIVE_TITLE_WORK), null, '점자 스피너는 claude/codex 공용 = 추론 금지');
});

test('실측 회귀 — cmd=2.1.219 인 claude 가 기록되고 와이어에 idle 이 방출된다', async () => {
  resetAll();
  const tid = 1000020;
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_IDLE)]); // 첫 관찰(시드)
  await tick();
  assert.ok(agentState._states.has(S(tid)), '기록이 생겨야 한다(구 코드는 무기록 → 토글 무발현)');
  assert.deepStrictEqual(frames.map((f) => f.state), ['idle']);
  assert.strictEqual(frames[0].cwd, 'proj/demo');
  assert.strictEqual(frames[0].win, tid);
  assert.strictEqual(frames[0].agent, 'claude', '✳ 글리프로 이름까지 특정된다');
  // 스피너 제목 = working 방출.
  frames.length = 0;
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]);
  await tick();
  assert.deepStrictEqual(frames.map((f) => f.state), ['working']);
  // `cpt agent status`(사람·AI 노출)에도 같은 레코드가 보여야 한다 — 스코프는 cwdRel.
  const snap = agentState.snapshot('proj/demo');
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].state, 'working');
  assert.strictEqual(snap[0].tid, tid);
});

test('실측 회귀 — 버전 문자열 cmd 에서도 working→idle 완료 알림이 나간다', async () => {
  resetAll();
  const tid = 1000021;
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]); // 시드(working)
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]);
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_IDLE)]); // 턴 완료
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'done');
  assert.strictEqual(fired[0].win, tid);
  assert.strictEqual(fired[0].title, 'Claude Code');
  assert.deepStrictEqual(frames.map((f) => f.state), ['working', 'idle']);
});

test('실측 회귀 — 버전 문자열 → 셸 전이가 종료로 인식된다(gone 방출 + exited 알림)', async () => {
  resetAll();
  const tid = 1000022;
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]); // 시드(working)
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]);
  await tick();
  frames.length = 0;
  watch.observe([row(tid, 'zsh', LIVE_TITLE_WORK)]);    // kill -9 — pane_title 은 스테일하게 남는다
  await tick();
  assert.deepStrictEqual(frames.map((f) => f.state), ['gone'], '셸 복귀는 idle 이 아니라 소멸이다');
  await sleep(WAIT);
  assert.strictEqual(fired.length, 1, '훅 없는 에이전트의 유일한 완료 신호 — 구 코드는 영구 미발화');
  assert.strictEqual(fired[0].kind, 'done');
  assert.match(String(fired[0].body || ''), /종료/);
  assert.strictEqual(fired[0].title, 'AI 에이전트', '이름 단서(제목 글리프)가 없으면 폴백 문구');
  // 폴링이 계속돼도 gone 은 한 번만(토글 자가 재점등·중복 알림 차단).
  frames.length = 0;
  watch.observe([row(tid, 'zsh', 'me@mac: ~')]);
  await tick();
  assert.strictEqual(frames.length, 0);
});

test('셸(zsh)에는 어떤 제목이어도 기록이 생기지 않는다(오검 차단)', async () => {
  resetAll();
  const tid = 1000023;
  watch.observe([row(tid, 'zsh', 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo')]); // 실측 셸 타이틀
  watch.observe([row(tid, 'zsh', LIVE_TITLE_IDLE)]);  // 에이전트 종료 후 스테일 제목
  watch.observe([row(tid, 'zsh', LIVE_TITLE_WORK)]);
  await sleep(WAIT);
  assert.strictEqual(agentState._states.has(S(tid)), false, '셸에 레코드가 생기면 빈 탭에 토글이 뜬다');
  assert.strictEqual(frames.length, 0);
  assert.strictEqual(fired.length, 0);
});

test('이름을 몰라도(agent:null) 기록·방출은 된다 — 토글 노출은 에이전트 이름과 무관', async () => {
  resetAll();
  const tid = 1000024;
  watch.observe([row(tid, '2.1.220', LIVE_TITLE_WORK)]); // 점자 스피너만 = 제품 특정 불가
  await tick();
  assert.deepStrictEqual(frames.map((f) => f.state), ['working']);
  assert.strictEqual(frames[0].agent, null, '계약 §1.3 은 agent:null 을 허용한다');
  assert.strictEqual(agentState.snapshot('proj/demo').length, 1, 'cpt agent status 에서도 누락되지 않는다');
});

// ── 2026-07-25 추가: 목록(terminal.list)용 정규화 신호 agentSignalOf ────────────────
//  사용자 증상 = "터미널에 claude 가 도는데 챗/TUI 토글이 있다 없다 한다". 원인은 push(agent_state)가
//  비는 순간(스테일 15분·WS 재접속 공백·데몬 재기동·서버 cap 미선언)에 클라가 `command` 이름 패턴으로
//  되짚는 구조였다(최신 claude = `2.1.219` → 영구 미매치). 아래는 그 구멍을 닫는 pull 경로의 판정 회귀다.

test('agentSignalOf — 실측 값(cmd=2.1.219 + ✳ 제목)이면 기록 0건에서도 ON', () => {
  resetAll();
  const tid = 1000030;
  // 데몬 재기동 직후 = agent-state 기록 0건 + 관찰 장부 0건. 첫 목록 조회부터 신호가 살아야 한다
  //  (관찰 폴링 2s 를 기다리면 그 사이 목록은 OFF 를 실어 보내고 토글이 사라진다).
  const s = watch.agentSignalOf(S(tid), LIVE_CMD, LIVE_TITLE_IDLE);
  assert.strictEqual(s.on, true);
  assert.strictEqual(s.agent, 'claude');
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.source, 'title');
  // 스피너 제목(working)도 같은 규칙 — 이름은 특정 불가(claude/codex 공용)이지만 ON 은 유지.
  const w = watch.agentSignalOf(S(tid), LIVE_CMD, LIVE_TITLE_WORK);
  assert.strictEqual(w.on, true);
  assert.strictEqual(w.state, 'working');
  assert.strictEqual(w.agent, null);
});

// ★★ 와이어에서 "근거 0(모름)" 과 "부정" 은 다른 값이어야 한다 — 둘을 같은 false 로 접었을 때
//  클라 사다리(앱 agentPresence.ts / PC agent-signal.js)가 그것을 **명시적 부정**으로 읽어 살아 있는
//  claude 의 토글이 사라졌다(2026-07-25 3패키지 합성 교차검증 blocker). 셸 확정만 false 다.
test('agentSignalOf — 근거 0 은 false 가 아니라 null(모름), 셸 확정만 false', () => {
  resetAll();
  const tid = 1000036;
  // (a) 살아 있는 claude 인데 근거가 하나도 없는 순간: 제목 글리프 없음(CLAUDE_CODE_DISABLE_TERMINAL_TITLE
  //     / showStatusInTerminalTab / resume·agents·폴더 신뢰 화면) + 훅 레코드 0건(데몬 재기동 직후·훅 미주입).
  const u = watch.agentSignalOf(S(tid), '2.1.219', 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo');
  assert.strictEqual(u.on, null, '근거 0 을 false 로 실으면 클라가 "에이전트 없음"으로 단정해 토글이 사라진다');
  assert.strictEqual(u.agent, null);
  assert.strictEqual(u.state, null);
  assert.strictEqual(u.source, null);
  // 제목이 아예 없는 환경도 같다.
  assert.strictEqual(watch.agentSignalOf(S(tid), '2.1.219', '').on, null);
  // cursor-agent 실측 cmd(제목 글리프 없음) 도 모름 — 감지 못 하는 것과 부정하는 것은 다르다.
  assert.strictEqual(watch.agentSignalOf(S(tid), '2025.09.18-7ae6800', '').on, null);
  // (b) 에이전트가 아닌 게 거의 확실한 프로세스도 "모름" 이다 — 데몬은 vim/npm 을 구별할 근거가 없다.
  assert.strictEqual(watch.agentSignalOf(S(tid), 'vim', 'vim README.md').on, null);
  // (c) 셸만 부정이다(유일한 하드 OFF). 근거까지 실어 왜 false 인지 남긴다.
  const sh = watch.agentSignalOf(S(tid), 'zsh', '⠹ 스테일 제목');
  assert.strictEqual(sh.on, false);
  assert.strictEqual(sh.source, 'shell');
  assert.strictEqual(watch.agentSignalOf(S(tid), '-bash', '').on, false);
});

test('agentSignalOf — 셸은 스테일 글리프·훅 기록이 있어도 OFF(직전 라운드 blocker)', async () => {
  resetAll();
  const tid = 1000031;
  // 훅이 방금 working 을 보고한 터미널(= agent-state 는 부착 상태)인데 프로세스가 셸로 돌아온 경우.
  await agentState.applyHook(S(tid), {
    v: 2, event: 'prompt', agent: 'claude', sessionId: 'sess-shell', promptId: 'p1',
    tid, cwdRel: 'proj/demo', wsName: 'demo',
  });
  assert.strictEqual(agentState.attachmentOf(S(tid)).attached, true);
  const s = watch.agentSignalOf(S(tid), 'zsh', LIVE_TITLE_WORK); // 실측: cmd=zsh + 스테일 스피너 제목
  assert.strictEqual(s.on, false, '빈 셸 탭에 토글이 굳으면 안 된다(하드 OFF)');
  assert.strictEqual(s.agent, null);
  assert.strictEqual(s.state, null);
  // 실측 셸 타이틀도 당연히 OFF.
  assert.strictEqual(watch.agentSignalOf(S(tid), '-zsh', 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo').on, false);
});

test('agentSignalOf — 셸 복귀가 관찰되면 ON→OFF 로 전이한다(내부 ended → 와이어 gone)', async () => {
  resetAll();
  const tid = 1000032;
  watch.observe([row(tid, LIVE_CMD, LIVE_TITLE_WORK)]); // 시드(working)
  await tick();
  assert.strictEqual(watch.agentSignalOf(S(tid), LIVE_CMD, LIVE_TITLE_WORK).on, true);
  watch.observe([row(tid, 'zsh', LIVE_TITLE_WORK)]);   // 종료 — 제목은 스테일하게 남는다
  await tick();
  assert.strictEqual(agentState.attachmentOf(S(tid)).state, 'gone');
  assert.strictEqual(agentState.attachmentOf(S(tid)).attached, false);
  const s = watch.agentSignalOf(S(tid), 'zsh', LIVE_TITLE_WORK);
  assert.strictEqual(s.on, false, '에이전트 종료가 목록에도 즉시 반영돼야 한다');
});

test('agentSignalOf — 제목이 없는 환경(제목 비활성/resume 화면)도 훅·sticky 근거로 ON', async () => {
  resetAll();
  const tidHook = 1000033;
  // CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 → 제목이 영구히 셸 타이틀. 훅 기록이 유일한 근거다.
  await agentState.applyHook(S(tidHook), {
    v: 2, event: 'prompt', agent: 'claude', sessionId: 'sess-nt', promptId: 'p1',
    tid: tidHook, cwdRel: 'proj/demo', wsName: 'demo',
  });
  const h = watch.agentSignalOf(S(tidHook), LIVE_CMD, 'whrksp126@GH-MACui-MacBookPro:~/codingpt-demo');
  assert.strictEqual(h.on, true);
  assert.strictEqual(h.state, 'working');
  assert.strictEqual(h.source, 'hook');
  // 훅이 없는 경우: 한 번이라도 글리프를 본 세션은 글리프 없는 화면(claude · resume / agents)에서도 ON.
  const tidSticky = 1000034;
  watch.observe([row(tidSticky, LIVE_CMD, LIVE_TITLE_IDLE)]);
  await tick();
  const st = watch.agentSignalOf(S(tidSticky), LIVE_CMD, 'claude · resume');
  assert.strictEqual(st.on, true, '중간에 글리프가 사라지는 화면에서 토글이 꺼지면 안 된다');
});

test('attachmentOf — 기록 유무와 무관하게 "부착" 을 답한다(와이어와 같은 접기)', async () => {
  resetAll();
  const tid = 1000035;
  const unknown = agentState.attachmentOf(S(tid));
  assert.deepStrictEqual(
    { attached: unknown.attached, known: unknown.known, state: unknown.state },
    { attached: false, known: false, state: null },
    '기록 없음 = 근거 없음(OFF 단정이 아니라 제목 판정으로 내려간다)',
  );
  // session_start 전 launching 도 부착으로 답해야 한다(wireStateOf 가 idle 로 접는다).
  await agentState.applyHook(S(tid), { v: 2, event: 'unknown_thing', agent: 'claude', tid, cwdRel: 'proj/demo' });
  const launching = agentState.attachmentOf(S(tid));
  assert.strictEqual(launching.known, true);
  assert.strictEqual(launching.state, 'idle');
  assert.strictEqual(launching.attached, true);
  // session_end → ended → 와이어 gone → 미부착.
  await agentState.applyHook(S(tid), { v: 2, event: 'session_end', agent: 'claude', tid, cwdRel: 'proj/demo' });
  assert.strictEqual(agentState.attachmentOf(S(tid)).state, 'gone');
  assert.strictEqual(agentState.attachmentOf(S(tid)).attached, false);
  // snapshot(= cpt agent status·hooks.doctor)에도 같은 값이 실린다(판정 정본 1개).
  const snap = agentState.snapshot('proj/demo').find((t) => t.tid === tid);
  assert.strictEqual(snap.wireState, 'gone');
  assert.strictEqual(snap.attached, false);
});

test('터미널 닫힘(세션 소멸)은 알림 없음 — 대기 후보도 폐기', async () => {
  resetAll();
  watch.observe([row(1000009, 'claude', '⠙ working…')]);
  watch.observe([row(1000009, 'claude', '⠹ working…')]);
  watch.observe([row(1000009, 'claude', '✳ claude')]); // 후보 발생(3s 대기)
  watch.observe([]);                                   // 즉시 터미널 닫힘
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});
