// 에이전트 상태 단일 소유자(agent-state) 전이표/우선순위 테스트 — node 내장 러너.
//  실행: node --test packages/runner-core/test/agent-state.test.js
//  tmux/back 무접촉: 시각(now)과 알림 전송(notify)을 주입해 8s/10분 창을 실시간 대기 없이 검증한다.
const { test } = require('node:test');
const assert = require('node:assert');

const st = require('../agent-state');

const clock = { t: 1700000000000 };
const fired = [];
st.configure({ now: () => clock.t, notify: async (p) => { fired.push(p); }, log: null });

const KEY = (tid) => `cpt-demo--t-${tid}`;
const ID = (tid) => ({ tid, cwdRel: 'proj/demo', wsName: 'demo', agent: 'claude' });
const hook = (tid, ev) => st.applyHook(KEY(tid), { v: 2, sessionId: 'sess-a', ...ID(tid), ...ev });

function reset(t) {
  fired.length = 0;
  st._reset();
  if (t != null) clock.t = t;
}

test('전이표 — session_start→idle / prompt→working / stop(bg=0)→idle+done 1건', async () => {
  reset();
  let r = await hook(1, { event: 'session_start', sessionSource: 'startup' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(st.attachmentOf(KEY(1)).ready, true, 'SessionStart/sessionId 이후에만 채팅 준비 완료');
  assert.strictEqual(fired.length, 0);

  r = await hook(1, { event: 'prompt', promptId: 'p1' });
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(st.statusOf(KEY(1)), 'working');
  assert.strictEqual(fired.length, 0);

  clock.t += 5000;
  r = await hook(1, { event: 'stop', promptId: 'p1', backgroundTasks: 0, summary: '완료했습니다' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(r.clearedProgress, true);
  assert.strictEqual(fired.length, 1);
  // 알림 payload 계약(기존 필드) 그대로여야 한다 — 서버 무수정 전제.
  assert.strictEqual(fired[0].kind, 'done');
  assert.strictEqual(fired[0].source, 'hook');
  assert.strictEqual(fired[0].title, 'Claude Code');
  assert.strictEqual(fired[0].body, '완료했습니다');
  assert.strictEqual(fired[0].cwd, 'proj/demo');
  assert.strictEqual(fired[0].wsName, 'demo');
  assert.strictEqual(fired[0].win, 1);
  assert.strictEqual(fired[0].subtitle, '「demo」에서 완료');
  assert.strictEqual(fired[0].sessionId, 'sess-a');
});

test('전이표 — permission→permission + 즉시 알림, 8초 내 Notification(permission_prompt)은 억제', async () => {
  reset();
  let r = await hook(2, { event: 'prompt', promptId: 'p1' });
  r = await hook(2, { event: 'permission', promptId: 'p1', tool: { name: 'Write', useId: null } });
  assert.strictEqual(r.state, 'permission');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'permission_request');

  // claude 는 대화상자 6초 뒤 같은 사건을 Notification 으로 또 알린다 → 같은 (sessionId,promptId) 면 억제.
  clock.t += 6000;
  r = await hook(2, { event: 'notification', promptId: 'p1', notificationType: 'permission_prompt', summary: 'Claude needs your permission' });
  assert.strictEqual(r.state, 'permission');
  assert.strictEqual(fired.length, 1, '승인 알림은 1건이어야 한다(이중 발사 금지)');
});

test('PermissionRequest 유실 시 Notification(permission_prompt)이 승인 알림을 낸다', async () => {
  reset();
  const r = await hook(3, { event: 'notification', promptId: 'p1', notificationType: 'permission_prompt', summary: 'Claude needs your permission' });
  assert.strictEqual(r.state, 'permission');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'permission_request');
  assert.strictEqual(fired[0].subtitle, '「demo」에서 승인 대기');
});

test('notification(idle_prompt) → needsInput, 알림 없음 / 기타 타입은 무변경', async () => {
  reset();
  await hook(4, { event: 'prompt', promptId: 'p1' });
  let r = await hook(4, { event: 'notification', notificationType: 'idle_prompt', summary: 'waiting' });
  assert.strictEqual(r.state, 'needsInput');
  assert.strictEqual(fired.length, 0);
  const v = r.version;
  r = await hook(4, { event: 'notification', notificationType: 'auth_success' });
  assert.strictEqual(r.state, 'needsInput', '기타 notification 은 상태를 바꾸지 않는다');
  assert.strictEqual(r.version, v + 1, 'version 은 갱신마다 단조 증가');
  assert.strictEqual(fired.length, 0);
  // terminal.wait 호환: needsInput 은 레거시 3값에서 idle 로 접힌다.
  assert.strictEqual(st.legacyStatusOf(KEY(4)), 'idle');
});

test('stop + backgroundTasks>0 → working 유지, 알림 0건 (오탐 방지 핵심)', async () => {
  reset();
  await hook(5, { event: 'prompt', promptId: 'p1' });
  let r = await hook(5, { event: 'stop', promptId: 'p1', backgroundTasks: 2, summary: '백그라운드 대기' });
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(fired.length, 0, 'backgroundTasks 가 남아있으면 done 을 내지 않는다');

  clock.t += 20000;
  r = await hook(5, { event: 'stop', promptId: 'p1', backgroundTasks: 0, summary: '이제 끝' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].body, '이제 끝');
});

test('stop_failure → idle + error / session_end → ended, 알림 없음', async () => {
  reset();
  await hook(6, { event: 'prompt', promptId: 'p1' });
  let r = await hook(6, { event: 'stop_failure', promptId: 'p1', summary: 'hook blocked' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].kind, 'error');
  assert.strictEqual(fired[0].body, 'hook blocked');

  clock.t += 1000;
  r = await hook(6, { event: 'session_end', endReason: 'prompt_input_exit' });
  assert.strictEqual(r.state, 'ended');
  assert.strictEqual(st.statusOf(KEY(6)), 'ended');
  assert.strictEqual(st.legacyStatusOf(KEY(6)), 'idle', 'terminal.wait --for idle 이 영원히 대기하지 않아야 한다');
  assert.strictEqual(fired.length, 1, 'session_end 는 알림을 내지 않는다');
});

test('version 은 같은 key 안에서 단조 증가한다', async () => {
  reset();
  const seen = [];
  for (const ev of [{ event: 'session_start' }, { event: 'prompt', promptId: 'p1' }, { event: 'notification', notificationType: 'auth_success' }, { event: 'stop', backgroundTasks: 0 }]) {
    const r = await hook(7, ev);
    seen.push(r.version);
    clock.t += 100;
  }
  assert.deepStrictEqual(seen, [1, 2, 3, 4]);
});

test('hookGoverned 이면 폴백은 상태를 못 쓴다(관찰만) — 단 프로세스 사망은 항상 채택', async () => {
  reset();
  await hook(8, { event: 'prompt', promptId: 'p1' });   // working, 훅 지배 시작
  assert.strictEqual(st.hookGoverned(KEY(8)), true);

  // 폴백이 "idle 로 보인다" 고 관찰해도 상태는 훅 기준(working) 유지.
  clock.t += 2000;
  let r = await st.applyWatch(KEY(8), { tid: 8, cwdRel: 'proj/demo', observedState: 'idle', agentName: 'Claude Code' });
  assert.strictEqual(r.observedOnly, true);
  assert.strictEqual(st.statusOf(KEY(8)), 'working');

  // 폴백 발사 요청(title 전이)도 억제.
  r = await st.applyWatch(KEY(8), { tid: 8, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(r.suppressed, true);
  assert.strictEqual(fired.length, 0);

  // 프로세스 사망(에이전트→셸)은 훅이 낼 수 없는 신호 → hookGoverned 무관하게 채택 + 알림 1건.
  r = await st.applyWatch(KEY(8), { tid: 8, cwdRel: 'proj/demo', fire: 'done', exited: true, agentName: 'Claude Code' });
  assert.strictEqual(r.state, 'ended');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].source, 'watch');
  assert.match(String(fired[0].body), /종료/);
});

test('훅과 폴백이 동시에 들어와도 알림은 정확히 1건 (과거 이중 발사 재발 지점)', async () => {
  reset();
  await hook(9, { event: 'prompt', promptId: 'p1' });
  await hook(9, { event: 'stop', promptId: 'p1', backgroundTasks: 0, summary: '끝' });
  assert.strictEqual(fired.length, 1);

  // 같은 턴을 폴백이 뒤늦게(QUIET 3s 뒤) 발사 시도 — 훅 지배로 억제.
  clock.t += 3000;
  await st.applyWatch(KEY(9), { tid: 9, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  // 프로세스 사망 신호까지 겹쳐도 REFIRE(8s) 창 안이라 억제.
  await st.applyWatch(KEY(9), { tid: 9, cwdRel: 'proj/demo', fire: 'done', exited: true, agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 1, '훅 done + 폴백 done + exit done = 알림 1건');

  // REFIRE 창을 넘긴 뒤의 사망은 별개 사건 → 1건 추가.
  clock.t += st.REFIRE_MIN_MS + 1;
  await st.applyWatch(KEY(9), { tid: 9, cwdRel: 'proj/demo', fire: 'done', exited: true, agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 2);
});

test('REFIRE — 같은 key + 같은 kind 는 8초 안에 재발사하지 않는다', async () => {
  reset();
  await st.applyWatch(KEY(10), { tid: 10, cwdRel: 'proj/demo', observedState: 'working', agentName: 'Claude Code' });
  await st.applyWatch(KEY(10), { tid: 10, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 1);
  clock.t += 1000;
  await st.applyWatch(KEY(10), { tid: 10, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 1);
  clock.t += st.REFIRE_MIN_MS;
  await st.applyWatch(KEY(10), { tid: 10, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 2);
});

test('훅이 없으면(hookGoverned=false) 폴백이 오늘과 동일하게 authoritative', async () => {
  reset();
  let r = await st.applyWatch(KEY(11), { tid: 11, cwdRel: 'proj/demo', observedState: 'working', agent: 'claude', seed: true });
  assert.strictEqual(r.seeded, true);
  assert.strictEqual(st.statusOf(KEY(11)), 'working');
  assert.strictEqual(fired.length, 0, '시드는 상태만 쓰고 알림을 내지 않는다');

  r = await st.applyWatch(KEY(11), { tid: 11, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].source, 'watch');
});

test('훅 지배는 HOOK_GOVERN_MS 뒤 만료돼 폴백이 다시 authoritative 가 된다', async () => {
  reset();
  await hook(12, { event: 'prompt', promptId: 'p1' });
  assert.strictEqual(st.hookGoverned(KEY(12)), true);
  clock.t += st.HOOK_GOVERN_MS + 1;
  assert.strictEqual(st.hookGoverned(KEY(12)), false);
  const r = await st.applyWatch(KEY(12), { tid: 12, cwdRel: 'proj/demo', observedState: 'idle', agentName: 'Claude Code' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(r.source, undefined); // 반환 계약은 state/version 만
  assert.strictEqual(st.statusOf(KEY(12)), 'idle');
});

test('레거시 noteHook(cwdRel,win) 창구도 폴백을 침묵시킨다(15s)', async () => {
  reset();
  await st.applyWatch(KEY(13), { tid: 13, cwdRel: 'proj/demo', observedState: 'working', seed: true });
  st.noteHook('proj/demo', 13);
  await st.applyWatch(KEY(13), { tid: 13, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(fired.length, 0);
});

test('서브에이전트 이벤트와 모르는 event 값은 무시(throw 금지) — 구/신 혼재 안전', async () => {
  reset();
  await hook(14, { event: 'prompt', promptId: 'p1' });
  let r = await hook(14, { event: 'stop', backgroundTasks: 0, summary: 'sub', subagent: { id: 'a1', type: 'explorer' } });
  assert.strictEqual(r.ignored, 'subagent');
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(fired.length, 0, '서브에이전트 Stop 이 "완료" 알림을 내면 병렬 5개 = 5건이 된다');

  r = await hook(14, { event: 'pre_tool', tool: { name: 'Write' } });
  assert.strictEqual(r.ignored, 'unknown_event');
  r = await hook(14, { event: 'wat' });
  assert.strictEqual(r.ignored, 'unknown_event');
  assert.strictEqual(r.state, 'working');
});

test('중첩 claude -p (같은 tid, 다른 sessionId) 는 거짓 완료 알림을 내지 않는다', async () => {
  reset();
  await hook(15, { event: 'session_start', sessionSource: 'startup' });
  await hook(15, { event: 'prompt', promptId: 'p1' });   // 주 세션 = sess-a
  clock.t += 1000;
  // 터미널 안의 에이전트가 `claude -p` 를 돌리면 CPT_TID 를 상속해 같은 key 로 훅이 온다.
  let r = await st.applyHook(KEY(15), { ...ID(15), event: 'session_start', sessionId: 'sess-nested', sessionSource: 'startup' });
  assert.strictEqual(r.ignored, 'foreign_session');
  r = await st.applyHook(KEY(15), { ...ID(15), event: 'stop', sessionId: 'sess-nested', backgroundTasks: 0, summary: 'nested done' });
  assert.strictEqual(r.ignored, 'foreign_session');
  assert.strictEqual(fired.length, 0);
  assert.strictEqual(st.statusOf(KEY(15)), 'working');

  // 주 세션의 Stop 은 정상 처리.
  r = await hook(15, { event: 'stop', promptId: 'p1', backgroundTasks: 0, summary: '주 세션 완료' });
  assert.strictEqual(r.state, 'idle');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].body, '주 세션 완료');

  // /clear·재개는 session_end 로 주 세션이 풀린 뒤 새 sessionId 를 채택한다.
  await hook(15, { event: 'session_end', endReason: 'clear' });
  r = await st.applyHook(KEY(15), { ...ID(15), event: 'prompt', sessionId: 'sess-b', promptId: 'p2' });
  assert.strictEqual(r.state, 'working');
});

test('snapshot / statusOf / forget', async () => {
  reset();
  await hook(16, { event: 'prompt', promptId: 'p1' });
  await st.applyHook(KEY(17), { tid: 17, cwdRel: 'other/ws', wsName: 'ws', agent: 'claude', sessionId: 's2', event: 'session_start' });
  const all = st.snapshot();
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((r) => r.tid), [16, 17]);
  const one = st.snapshot('proj/demo');
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].state, 'working');
  assert.strictEqual(one[0].hookGoverned, true);
  assert.strictEqual(one[0].wsName, 'demo');
  assert.ok(one[0].version >= 1 && one[0].sessionId === 'sess-a');

  // 세션 소멸 → 상태는 지워지지만 훅 지배/발사 이력은 tomb 로 남아 중복 알림을 막는다.
  assert.strictEqual(st.forget(KEY(16)), true);
  assert.strictEqual(st.snapshot('proj/demo').length, 0);
  assert.strictEqual(st.hookGoverned(KEY(16)), true, 'tmux 목록이 일시적으로 비어도 폴백이 뒤집히지 않아야 한다');
  const r = await st.applyWatch(KEY(16), { tid: 16, cwdRel: 'proj/demo', fire: 'done', agentName: 'Claude Code' });
  assert.strictEqual(r.suppressed, true);
  assert.strictEqual(fired.length, 0);
});

test('에이전트 신호가 없는 일반 셸 터미널은 레코드를 만들지 않는다', async () => {
  reset();
  const r = await st.applyWatch(KEY(18), { tid: 18, cwdRel: 'proj/demo', observedState: null, shell: true, seed: true });
  assert.strictEqual(r.skipped, 'no_signal');
  assert.strictEqual(st.snapshot().length, 0);
  assert.strictEqual(st.statusOf(KEY(18)), 'idle');
});
