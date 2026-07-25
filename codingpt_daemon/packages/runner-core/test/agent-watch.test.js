// 에이전트 완료 폴백 감지(agent-watch) 상태머신 테스트 — node 내장 러너.
//  실행: node --test packages/runner-core/test/agent-watch.test.js
//  tmux/서버 무접촉: pty(runTmux)·cpt-server(backFetch)를 require 캐시로 스텁하고
//  observe() 에 스냅샷을 직접 주입한다. 발사는 QUIET_MS(3s) 실타이머 — 테스트가 기다린다.
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

const S = (tid) => `cpt-demo--t-${tid}`;
const row = (tid, cmd, title) => ({ session: S(tid), cmd, title });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = 3600; // QUIET_MS(3000) + 여유

function resetAll() {
  fired.length = 0;
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

test('터미널 닫힘(세션 소멸)은 알림 없음 — 대기 후보도 폐기', async () => {
  resetAll();
  watch.observe([row(1000009, 'claude', '⠙ working…')]);
  watch.observe([row(1000009, 'claude', '⠹ working…')]);
  watch.observe([row(1000009, 'claude', '✳ claude')]); // 후보 발생(3s 대기)
  watch.observe([]);                                   // 즉시 터미널 닫힘
  await sleep(WAIT);
  assert.strictEqual(fired.length, 0);
});
