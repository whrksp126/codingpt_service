// 훅 파이프라인 이음새 회귀 테스트 — cpt.js(매핑) → agent-state(전이·알림) → cpt-server(배선).
//
// 왜 이 파일이 따로 있나:
//  agent-state.test.js 는 agent-state 단독을 검증한다. 하지만 실제 사고는 **패키지 경계**에서 났다.
//  ① cpt-server 의 hook.event 가 구현(v1: 모든 훅 → 알림 1건)에 머물러 있으면 훅 7종 × 알림 =
//     턴당 6건 폭주가 된다. 두 패키지가 각자 정상인데 합치면 터지는 유형.
//  ② cpt.js 가 agent_type 만으로 서브에이전트를 판정하면 메인 세션 SessionStart 가 통째로 버려져
//     상태가 launching 에 고착된다(claude 실측 payload 에 agent_type 이 실려 옴).
//  ③ codex-notify 가 notificationType 을 안 실으면 agent-state 가 no-op 처리해 승인 알림이 0건이 된다.
// 셋 다 단독 테스트로는 잡히지 않으므로 여기서 실제 매핑 함수와 실제 소스를 함께 본다.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-hookwire-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const agentState = require('../agent-state');
const { mapClaudeHook } = require('../../cpt-cli/bin/cpt.js');

const KEY = 'cpt-proj--t-1000123';
const CTX = { cwdRel: 'other/project/proj', tid: 1000123, wsName: 'proj' };
const BASE = { session_id: 'sess-A', cwd: '/x/proj', transcript_path: '/x/t.jsonl' };

let fired;
beforeEach(() => {
  fired = [];
  agentState._reset();
  agentState.configure({ notify: async (p) => { fired.push(p); }, log: null });
});

// 실제 CLI 매핑을 통과시켜 보낸다 — 필드명 드리프트가 여기서 잡힌다.
const send = (sub, payload, ctx = CTX) =>
  agentState.applyHook(ctx.key || KEY, { ...mapClaudeHook(sub, payload), ...ctx });

test('SessionStart 에 agent_type 이 있어도 메인 세션이다 (subagent 오분류 회귀)', async () => {
  // claude 실측: 메인 세션 SessionStart payload 에도 agent_type 이 실려 온다.
  const r = await send('session-start', { ...BASE, source: 'startup', agent_type: 'general-purpose' });
  assert.notStrictEqual(r.ignored, 'subagent', 'agent_type 만으로 서브에이전트 판정하면 안 된다');
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(fired.length, 0, 'session_start 는 알림 없음');
});

test('agent_id 가 있는 이벤트만 서브에이전트로 무시된다', async () => {
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  const r = await send('stop', { ...BASE, agent_id: 'sub-1', agent_type: 'x', last_assistant_message: '서브 완료' });
  assert.strictEqual(r.ignored, 'subagent');
  assert.strictEqual(fired.length, 0, '서브에이전트 완료로 알림이 나가면 병렬 N건 오알림이 된다');
});

test('한 턴 = 알림 정확히 1건 (훅 7종이 각자 알림을 내지 않는다)', async () => {
  // v1 구현이 남아 있으면 이 시나리오가 6건을 낸다.
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  await send('stop', { ...BASE, last_assistant_message: '완료' });
  await send('session-end', { ...BASE, reason: 'prompt_input_exit' });
  assert.strictEqual(fired.length, 1, `턴당 1건이어야 함 (실제: ${fired.map((f) => f.kind).join(',')})`);
  assert.strictEqual(fired[0].kind, 'done');
});

test('PermissionRequest → 승인 알림 즉시 + 뒤따르는 Notification 은 중복 억제', async () => {
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  const r = await send('permission', { ...BASE, tool_name: 'Write', tool_input: { file_path: '/x/a.js' } });
  assert.strictEqual(r.state, 'permission');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'permission_request');
  // claude 는 PermissionRequest 직후 Notification(permission_prompt) 도 낸다 → 같은 승인 1건이다.
  await send('notification', { ...BASE, message: '권한 필요', notification_type: 'permission_prompt' });
  assert.strictEqual(fired.length, 1, '같은 승인으로 알림 2건이 나가면 안 된다');
});

test('stop + background_tasks>0 은 턴 종료가 아니다 (거짓 완료 알림 0건)', async () => {
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  const r = await send('stop', { ...BASE, last_assistant_message: 'bg 대기', background_tasks: [{ id: 'b1' }] });
  assert.strictEqual(fired.length, 0);
  assert.strictEqual(r.state, 'working', '백그라운드 대기 중이면 working 유지');
});

test('완료 알림 body = last_assistant_message (트랜스크립트 읽기 없음)', async () => {
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  const r = await send('stop', { ...BASE, last_assistant_message: '작업 3건 완료했습니다' });
  assert.strictEqual(fired.length, 1);
  assert.match(String(fired[0].body), /작업 3건 완료했습니다/);
  assert.strictEqual(r.clearedProgress, true, '턴 종료 시 진행률을 지워야 한다');
});

test('codex 승인 알림 — notificationType 을 실어야 살아남는다', async () => {
  // codex-notify 는 claude 와 달리 notification_type 을 주지 않으므로 CLI 가 판정해 넣는다.
  //  이 필드가 없으면 agent-state 가 무변경 no-op 처리해 승인 알림이 조용히 0건이 된다.
  const r = await agentState.applyHook('cpt-proj--t-1000999', {
    v: 2, agent: 'codex', event: 'notification', at: Date.now(),
    notificationType: 'permission_prompt', backgroundTasks: 0, summary: '승인 필요',
    cwdRel: CTX.cwdRel, tid: 1000999, wsName: 'proj',
  });
  assert.strictEqual(r.state, 'permission');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'permission_request');
});

test('알림 payload 는 기존 서버 계약 필드를 그대로 유지한다', async () => {
  await send('session-start', { ...BASE, source: 'startup' });
  await send('prompt', { ...BASE, prompt: 'x' });
  await send('permission', { ...BASE, tool_name: 'Bash', tool_input: { command: 'ls' } });
  await send('stop', { ...BASE, last_assistant_message: '끝' });
  assert.ok(fired.length >= 2);
  for (const f of fired) {
    for (const k of ['source', 'kind', 'title', 'cwd', 'wsName', 'win']) {
      assert.ok(k in f, `기존 필드 ${k} 가 빠지면 back 이 알림을 다르게 처리한다`);
    }
    assert.strictEqual(f.source, 'hook');
  }
});

// ── 소스 계약: 다른 패키지가 배선을 되돌리는 것을 막는다 ──
test('cpt-server 의 hook.event 가 agent-state 로 위임한다 (구 알림 발사 부활 금지)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
  const i = src.indexOf("cmd === 'hook.event'");
  assert.ok(i > 0, "hook.event 핸들러가 있어야 한다");
  const block = src.slice(i, i + 2500);

  assert.match(block, /agent-state'\)\.applyHook/,
    'hook.event 는 agent-state.applyHook 으로 위임해야 한다');
  assert.doesNotMatch(block, /backFetch\('POST',\s*'\/api\/notifications'/,
    '구 알림 발사 코드가 남아 있으면 훅 7종 × 알림 = 턴당 6건 폭주가 된다');
  assert.match(block, /ctxSess|req\.ctx\.tmux/,
    'key 는 ctx.tmux.session(전용 세션명) 기준이어야 한다 — 재조립하면 유령 ws 에서 agent-watch 와 키가 갈라진다');
});

test('cpt.js 는 agent_id 단독으로 서브에이전트를 판정한다 (소스 계약)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js'), 'utf8');
  const m = /subagent:\s*([^\n]+)/.exec(src);
  assert.ok(m, 'subagent 필드 매핑이 있어야 한다');
  assert.doesNotMatch(m[1], /agent_id\s*\|\|\s*d\.agent_type/,
    'agent_type 을 판정에 넣으면 메인 세션 session_start 가 버려진다');
});

test('shim 은 훅 7종을 등록한다 (격리 stateDir, zdot 무접촉)', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-shimtest-'));
  const prev = { root: runtime.root && runtime.root(), stateDir: runtime.stateDir() };
  try {
    runtime.init({ root: iso, stateDir: path.join(iso, '.codingpt') });
    process.env.CPT_SHIM_NO_GLOBAL_LINK = '1'; // 전역 cpt 심링크 무접촉
    require('../shim').ensureShims();
    const hooks = JSON.parse(fs.readFileSync(path.join(iso, '.codingpt', 'shim', 'claude-hooks.json'), 'utf8'));
    const events = Object.keys(hooks.hooks).sort();
    assert.deepStrictEqual(events, [
      'Notification', 'PermissionRequest', 'SessionEnd', 'SessionStart',
      'Stop', 'StopFailure', 'UserPromptSubmit',
    ], `훅 7종이어야 함 (실제: ${events.join(',')})`);
    // 래퍼가 --settings 로 이 파일을 주입해야 기존 셸에도 즉시 적용된다(zdot 수정 불필요).
    const wrapper = fs.readFileSync(path.join(iso, '.codingpt', 'bin', 'claude'), 'utf8');
    assert.match(wrapper, /--settings/);
    assert.match(wrapper, /CPT_HOOKS_DISABLED/, '비활성 킬스위치를 유지해야 한다');
  } finally {
    runtime.init({ root: prev.root || ROOT, stateDir: prev.stateDir });
  }
});
