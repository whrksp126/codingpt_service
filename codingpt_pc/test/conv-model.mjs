// conv-model.mjs — 채팅 v2 순수 규칙(src/js/conv-model.js)을 **실제로 돌려** 고정한다.
//  계약 정본 = codingpt_daemon/docs/chat-v2-design.md. 여기 하드코딩한 프레임은 그 문서의 모양이다
//  (자기 구현으로 자기를 검증하지 않게 — 입력은 문서에서, 기대값은 문서의 규칙에서 온다).
import { renderMarkdown } from '../src/js/chat-md.js';
import * as M from '../src/js/conv-model.js';

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e !== undefined ? '  ' + (typeof e === 'string' ? e : JSON.stringify(e)) : '')); } };
const eq = (got, want, n) => ok(JSON.stringify(got) === JSON.stringify(want), n, { got, want });

const T0 = 1790000000000;
const uMsg = (seq, clientId, status, text = '안녕') => ({ seq, ts: T0 + seq, op: 'msg', msg: { key: 'u:' + clientId, role: 'user', kind: 'text', text, clientId, status, turn: 1 } });
const aMsg = (seq, key, text) => ({ seq, ts: T0 + seq, op: 'msg', msg: { key, role: 'assistant', kind: 'text', text, turn: 1 } });
const tool = (seq, id, name = 'Bash') => ({ seq, ts: T0 + seq, op: 'msg', msg: { key: id, role: 'assistant', kind: 'tool_use', text: '', tool: { id, name, title: name + ' ' + id } } });
const result = (seq, id, okv = true, extra = {}) => ({ seq, ts: T0 + seq, op: 'msg', msg: { key: 'r:' + id, role: 'user', kind: 'tool_result', text: '', result: { toolUseId: id, ok: okv, preview: 'out', ...extra } } });
const keys = (st) => M.buildRows(st).map((r) => r.type + ':' + r.key);

// ── 1. seq 연속성(§3) ─────────────────────────────────────────────────────────
{
  eq(M.classifyFrame(3, [{ seq: 4 }, { seq: 5 }]).kind, 'apply', '이어지는 프레임은 적용');
  eq(M.classifyFrame(3, [{ seq: 5 }]).kind, 'gap', '★ 틈(4 가 없다) → 버리고 since');
  eq(M.classifyFrame(3, [{ seq: 2 }, { seq: 3 }]).kind, 'dup', '전부 이미 가진 것 → 조용히 버린다');
  eq(M.classifyFrame(3, [{ seq: 3 }, { seq: 4 }]).events.map((e) => e.seq), [4], '앞이 겹치면 뒤쪽만 적용');
  eq(M.classifyFrame(3, [{ seq: 4 }, { seq: 6 }]).kind, 'gap', '프레임 안이 끊겨도 틈');
  eq(M.classifyFrame(0, []).kind, 'dup', '빈 프레임');

  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1', state: 'idle' }, events: [uMsg(1, 'c1', 'sent')], headSeq: 1, floorSeq: 1, live: [], pending: [] });
  eq(st.headSeq, 1, 'open → headSeq');
  const r1 = M.applyPush(st, { threadId: 't1', headSeq: 3, events: [aMsg(3, 'm1:0', '늦게')] });
  ok(r1.resync === true && st.headSeq === 1 && !st.msgs.has('m1:0'), '★ 틈 프레임은 아무것도 적용하지 않는다(headSeq 그대로)');
  const r2 = M.applyPush(st, { threadId: 't1', headSeq: 2, events: [aMsg(2, 'm0:0', '먼저')] });
  ok(r2.ok && r2.applied === 1 && st.headSeq === 2, '이어지는 프레임 적용');
  // 역순으로 도착한 옛 프레임 — 이미 지나간 seq
  const r3 = M.applyPush(st, { threadId: 't1', events: [uMsg(1, 'c1', 'queued')] });
  ok(r3.ok && r3.applied === 0 && st.msgs.get('u:c1').msg.status === 'sent', '★ 역순으로 온 옛 프레임이 새 상태를 덮지 않는다');
  // since 가 틈을 메운다
  const s = M.applySince(st, { thread: { id: 't1', state: 'working' }, events: [aMsg(3, 'm1:0', '늦게')], headSeq: 3 });
  ok(!s.more && st.headSeq === 3 && st.msgs.has('m1:0') && st.thread.state === 'working', 'since 가 틈을 메우고 thread 를 갱신');
  // 같은 구간을 다시 받아도 같다(멱등)
  M.applySince(st, { events: [aMsg(3, 'm1:0', '늦게')], headSeq: 3 });
  eq(keys(st), ['user:u:c1', 'assistant:m0:0', 'assistant:m1:0'], '같은 구간 재수신은 멱등');
  // 영속 이벤트가 없던 구간도 head 는 따라간다
  M.applySince(st, { events: [], headSeq: 7 });
  eq(st.headSeq, 7, 'more 가 아니면 서버 headSeq 가 정본');
  // 늦은 응답(만들어진 뒤에 온 push 를 내가 먼저 적용했다) — 로그가 바뀐 것이 아니다(바뀌었으면 데몬이 reset 을 준다)
  const late = M.applySince(st, { thread: { id: 't1', state: 'idle' }, events: [], headSeq: 2, live: [{ key: 'old', kind: 'text', text: 'x' }], pending: [] });
  ok(!late.reopen && !late.reset && st.headSeq === 7 && st.thread.state === 'working' && st.live.size === 0, '★ 서버 head 가 내 것보다 작은 늦은 응답은 head·상태·초안을 되돌리지 않는다');
  // since 응답은 **접은 부분열**이다 — seq 가 띄엄띄엄한 것이 정상(같은 key 의 앞 줄이 빠진다)
  const sp = M.applySince(st, { events: [aMsg(9, 'x:0', 'x'), aMsg(12, 'y:0', 'y')], headSeq: 12, more: false, live: [], pending: [] });
  ok(!sp.reopen && !sp.reset && st.headSeq === 12 && st.msgs.has('x:0') && st.msgs.has('y:0'), '★ since 의 띄엄띄엄한 seq 는 틈이 아니다(접은 스냅샷)');
}

// ── 1b. 확정 계약(데몬 구현, §2.2·§4·§4.3) ───────────────────────────────────
{
  // first — 턴 중에 보낸 메시지가 나중에 sent 로 바뀌어도 제자리
  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1', state: 'working' }, headSeq: 3, floorSeq: 1, live: [], pending: [],
    events: [{ seq: 1, ts: T0, op: 'turn', phase: 'start', turn: 1 }, uMsg(2, 'c1', 'sent'), aMsg(3, 'm:0', '첫 답')] });
  M.applyPush(st, { threadId: 't1', events: [uMsg(4, 'c2', 'queued', '끼어든 말')] });
  M.applyPush(st, { threadId: 't1', events: [aMsg(5, 'm:1', '둘째 답')] });
  M.applyPush(st, { threadId: 't1', events: [{ ...uMsg(6, 'c2', 'sent', '끼어든 말'), first: 4 }] });
  eq(M.buildRows(st).map((r) => r.key), ['u:c1', 'm:0', 'u:c2', 'm:1'], '★ 라이브: queued→sent upsert 가 행을 아래로 보내지 않는다');
  // 같은 대화를 스냅샷으로 열면(접혀서 seq 4 는 없고 6 만 온다) 같은 자리여야 한다
  const st2 = M.createConv('t1');
  M.applyOpen(st2, { thread: { id: 't1', state: 'working' }, headSeq: 6, floorSeq: 1, live: [], pending: [],
    events: [{ seq: 1, ts: T0, op: 'turn', phase: 'start', turn: 1 }, uMsg(2, 'c1', 'sent'), aMsg(3, 'm:0', '첫 답'), aMsg(5, 'm:1', '둘째 답'), { ...uMsg(6, 'c2', 'sent', '끼어든 말'), first: 4 }] });
  eq(M.buildRows(st2).map((r) => r.key), ['u:c1', 'm:0', 'u:c2', 'm:1'], '★ 스냅샷: 자리는 first ?? seq — 라이브와 같은 순서');
  eq(st2.msgs.get('u:c2').firstSeq, 4, 'first 를 자리로 쓴다');
  const st3 = M.createConv('t1');
  M.applyOpen(st3, { thread: { id: 't1' }, headSeq: 6, events: [aMsg(5, 'm:1', 'x'), { ...uMsg(6, 'c2', 'sent'), first: 99 }] });
  eq(st3.msgs.get('u:c2').firstSeq, 6, 'seq 보다 큰 first 는 믿지 않는다');

  // reset — 로컬 상태를 버리고 응답으로 교체
  M.addPending(st, { clientId: 'keep', text: '아직 안 간 글', now: T0 });
  const r = M.applySince(st, { reset: true, more: false, thread: { id: 't1', state: 'idle', title: '다시 만든 대화' }, headSeq: 2, floorSeq: 1, live: [], pending: [],
    events: [uMsg(1, 'n1', 'sent', '새 로그'), aMsg(2, 'z:0', '새 답')] });
  ok(r.reset === true && !r.reopen, 'reset 을 알린다(뷰가 행을 통째로 다시 그린다)');
  eq([st.headSeq, [...st.msgs.keys()], st.thread.title, st.turns.size], [2, ['u:n1', 'z:0'], '다시 만든 대화', 0], '★ since reset:true — 옛 상태를 버리고 스냅샷으로 교체');
  ok(st.pending.has('keep'), '아직 안 간 내 글(낙관 버블)은 남는다');

  // thread 힌트의 headSeq — 가져온 과거는 push 되지 않는다
  const h1 = M.applyThreadHint(st, { id: 't1', headSeq: 40, state: 'idle', preview: '터미널에서 이어 간 답' });
  ok(h1.behind === true && st.headSeq === 2 && st.thread.preview === '터미널에서 이어 간 답', '★ 힌트의 headSeq 가 앞서 있으면 since 를 요구한다(내 headSeq 는 그대로)');
  eq(M.applyThreadHint(st, { id: 't1', headSeq: 2 }).behind, false, '같으면 요구하지 않는다');
  eq(M.applyThreadHint(st, { id: 'other', headSeq: 99 }), { ok: false, behind: false }, '다른 대화의 힌트');

  // pending = [ConvReq] · live = 배열
  const st4 = M.createConv('t1');
  const Rq = (id, status) => ({ id, kind: 'permission', tool: 'Bash', summary: 's', status, requestedAt: T0, turn: 1 });
  M.applyOpen(st4, { thread: { id: 't1', state: 'waiting', pending: 2 }, headSeq: 9, floorSeq: 5, events: [{ seq: 8, ts: T0, op: 'req', req: Rq('req_in', 'pending') }],
    pending: [Rq('req_in', 'pending'), Rq('req_out', 'pending')], live: [{ key: 'm:9', kind: 'text', text: '쓰는 중' }] });
  eq(M.openReqs(st4).map((q) => q.id).sort(), ['req_in', 'req_out'], 'pending 은 요청 배열 — 페이지 밖에서 열린 요청도 카드가 뜬다');
  eq([st4.thread.pending, st4.live.get('m:9').text], [2, '쓰는 중'], '개수는 thread.pending · live 는 배열');
  ok(M.applyDelta(st4, { key: 'm:9', kind: 'text', off: 4, text: ' 글' }).ok && st4.live.get('m:9').text === '쓰는 중 글', '다음 델타의 off 는 live 의 text.length 에서 이어진다');
  eq([st4.floorSeq, st4.noMoreBefore], [5, false], 'floorSeq > 1 — 더 앞이 있다');
  // 닫힌 이벤트를 못 받았어도 pull 의 pending 에 없으면 닫는다
  M.applyPush(st4, { threadId: 't1', events: [{ seq: 10, ts: T0, op: 'req', req: Rq('req_new', 'pending') }] });
  M.applySince(st4, { thread: { id: 't1' }, events: [], headSeq: 9, more: false, live: [], pending: [Rq('req_in', 'pending')] });
  eq(M.openReqs(st4).map((q) => q.id).sort(), ['req_in', 'req_new'], '★ pull 의 pending 에 없는 요청은 닫는다 — 단 응답보다 뒤에 온 요청은 건드리지 않는다');
  const st5 = M.createConv('t1');
  M.applyOpen(st5, { thread: { id: 't1' }, headSeq: 3, floorSeq: 1, events: [aMsg(3, 'm:0', 'x')], live: [], pending: [] });
  eq([st5.floorSeq, st5.noMoreBefore], [1, true], '★ floorSeq 1 = 더 앞이 없다(첫 이벤트의 seq 가 3 이어도)');

  // 상태는 turn·req 이벤트에서 따라간다(working/waiting 은 state 이벤트로 오지 않는다)
  const st6 = M.createConv('t1');
  M.applyOpen(st6, { thread: { id: 't1', state: 'idle' }, headSeq: 0, floorSeq: 1, events: [], live: [], pending: [] });
  M.applyPush(st6, { threadId: 't1', events: [{ seq: 1, ts: T0, op: 'turn', phase: 'start', turn: 1 }] });
  eq(st6.thread.state, 'working', '턴 시작 → working(힌트를 기다리지 않는다)');
  M.applyPush(st6, { threadId: 't1', events: [{ seq: 2, ts: T0, op: 'req', req: Rq('r1', 'pending') }] });
  eq([st6.thread.state, st6.thread.pending], ['waiting', 1], '요청 열림 → waiting');
  M.applyPush(st6, { threadId: 't1', events: [{ seq: 3, ts: T0, op: 'req', req: Rq('r1', 'allowed'), first: 2 }] });
  eq(st6.thread.state, 'working', '요청 닫힘 → working');
  // turn end → 남은 초안을 버린다
  M.applyDelta(st6, { key: 'm:5', kind: 'text', off: 0, text: '끝내 완성되지 못한 글' });
  M.applyDelta(st6, { key: 'th:1', kind: 'thinking', off: 0, text: '' });
  eq(st6.live.size, 2, '빈 thinking 조각(off 0, text "")도 초안을 만든다 — "생각 중" 표시');
  M.applyPush(st6, { threadId: 't1', events: [{ seq: 4, ts: T0 + 5000, op: 'turn', phase: 'end', turn: 1, ok: false, interrupted: true, subtype: 'process_exit' }] });
  eq([st6.live.size, st6.thread.state], [0, 'idle'], '★ turn end 를 받으면 남은 초안을 버린다 · idle');
  // 열린 턴이 받아 둔 구간 밖에 있을 때: 요청이 닫혔다고 idle 로 내리지 않는다
  const st7 = M.createConv('t1');
  M.applyOpen(st7, { thread: { id: 't1', state: 'waiting', pending: 1 }, headSeq: 50, floorSeq: 40, events: [{ seq: 50, ts: T0, op: 'req', req: Rq('r9', 'pending') }], live: [], pending: [Rq('r9', 'pending')] });
  M.applyPush(st7, { threadId: 't1', events: [{ seq: 51, ts: T0, op: 'req', req: Rq('r9', 'denied'), first: 50 }] });
  eq(st7.thread.state, 'working', '턴 시작을 못 봤어도 요청이 닫히면 working(idle 이 아니다)');
  // 델타 off 단위 = UTF-16 코드 유닛
  const st8 = M.createConv('t1');
  M.applyOpen(st8, { thread: { id: 't1' }, headSeq: 0, events: [] });
  M.applyDelta(st8, { key: 'e:0', kind: 'text', off: 0, text: '가😀' });
  ok(M.applyDelta(st8, { key: 'e:0', kind: 'text', off: 3, text: '나' }).ok, '★ off 는 UTF-16 코드 유닛(이모지 = 2)');
  ok(M.applyDelta(st8, { key: 'e:0', kind: 'text', off: 3, text: '다' }).resync, '코드 포인트로 세면 틀린다');

  // 터미널 전용 명령
  const st9 = M.createConv('t1');
  M.applyOpen(st9, { thread: { id: 't1' }, headSeq: 2, floorSeq: 1, live: [], pending: [],
    events: [{ seq: 1, ts: T0, op: 'msg', msg: { key: 'u:s1', role: 'user', kind: 'text', text: '/vim', clientId: 's1', status: 'failed' } },
      { seq: 2, ts: T0, op: 'notice', level: 'info', code: 'TERMINAL_ONLY_COMMAND', text: '/vim 는 터미널에서만 쓸 수 있는 명령입니다' }] });
  const rows9 = M.buildRows(st9);
  eq(rows9.map((r) => r.type + ':' + (r.status || r.code)), ['user:blocked', 'notice:TERMINAL_ONLY_COMMAND'], '★ 터미널 전용 명령은 실패 버블이 아니다(다시 시도를 권하지 않는다)');
  eq(M.noticeText('TERMINAL_ONLY_COMMAND', '데몬 문구'), '이 명령은 터미널에서만 쓸 수 있어요.', '아는 안내 code 는 우리 문구');
  eq(M.noticeText('SOMETHING_NEW', '데몬 문구'), '데몬 문구', '모르는 code 는 데몬 문구 그대로');
  ok(['ADOPT_FAILED', 'CONTROL_TIMEOUT', 'CONTROL_FAILED', 'THREAD_BUSY', 'TERMINAL_ONLY_COMMAND'].every((c) => M.convErrorText(c) !== M.convErrorText('')), '새 오류 code 마다 안내 문구가 있다');

  // conv.toTerminal
  eq(M.terminalLaunch({ ok: true, cwd: 'demo', agent: 'claude', command: 'claude --resume abc', args: ['--resume', 'abc'] }), { agent: 'claude', args: ['--resume', 'abc'], cwd: 'demo' }, '★ 응답의 args 를 쓴다');
  eq(M.terminalLaunch({ command: "claude --resume 'x y'" }, 'claude'), { agent: 'claude', args: ['--resume', 'x y'], cwd: '' }, 'args 가 없으면(구 데몬) command 에서 뽑는다');

  // 모드 이름(채팅 탭)
  eq(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'].map(M.convModeLabel),
    ['매번 물어보기', '파일 수정은 자동 허용', '계획만 세우기', '자동', '모두 허용', '묻지 않고 거절'], '★ 모드 이름은 TUI 원문이 아니라 우리 말');
  eq(M.convModeLabel('futureMode'), 'futureMode', '모르는 모드는 id 그대로');
  eq(M.convModeChoices('default', ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']).map((m) => m.id), ['default', 'acceptEdits', 'plan', 'auto'], '위험한 모드는 목록에 없다');
  eq(M.convModeChoices('bypassPermissions').filter((m) => m.on).map((m) => m.id), ['bypassPermissions'], '지금 그 모드면 보인다');
  eq(M.convModeChoices('plan', ['default', 'plan']).map((m) => m.id + (m.on ? '*' : '')), ['default', 'plan*'], '데몬이 알려 준 모드만');
}

// ── 2. 응답 크기 예산(more, §4.0) ─────────────────────────────────────────────
{
  const st = M.createConv('t1');
  const o = M.applyOpen(st, { thread: { id: 't1' }, events: [uMsg(1, 'a', 'sent'), aMsg(2, 'm:0', 'x')], headSeq: 9, floorSeq: 1, more: true });
  ok(o.more && st.headSeq === 2, '★ open 이 잘렸으면(more) 받은 데까지만 head 다');
  const s = M.applySince(st, { events: [aMsg(3, 'm:1', 'y')], headSeq: 9, more: true, live: [{ key: 'z', kind: 'text', text: '아직' }] });
  ok(s.more && st.headSeq === 3 && st.live.size === 0, 'since more — head 는 받은 데까지, live 는 아직 믿지 않는다');
}

// ── 3. key upsert(§2.2) ───────────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1' }, events: [uMsg(1, 'c1', 'queued'), aMsg(2, 'm:0', '답')], headSeq: 2 });
  M.applyPush(st, { threadId: 't1', events: [uMsg(3, 'c1', 'sent')] });
  const rows = M.buildRows(st);
  eq(rows.map((r) => r.key), ['u:c1', 'm:0'], '★ upsert 는 자리를 옮기지 않는다(queued→sent 가 답 아래로 내려가지 않는다)');
  eq(rows[0].status, 'sent', '뒤 이벤트가 앞을 대체한다');
  ok(rows[0].sig !== `1|queued`, 'sig 가 바뀐다(그 행만 다시 그린다)');
}

// ── 4. 이전 내역(conv.before) ─────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1', state: 'idle' }, events: [uMsg(10, 'c1', 'sent'), aMsg(11, 'm:0', '답')], headSeq: 11, floorSeq: 10 });
  ok(!st.noMoreBefore && st.floorSeq === 10, '바닥이 1 보다 크면 더 받을 것이 있다');
  M.applyBefore(st, { events: [uMsg(8, 'c1', 'queued'), aMsg(7, 'old:0', '옛'), { seq: 9, ts: T0, op: 'state', state: 'working' }], floorSeq: 7 });
  eq(st.msgs.get('u:c1').msg.status, 'sent', '★ 이전 내역이 새 상태를 덮지 않는다');
  eq(st.thread.state, 'idle', '★ 이전 내역 속의 state 이벤트가 지금 상태를 되돌리지 않는다');
  eq(M.buildRows(st).map((r) => r.key), ['old:0', 'u:c1', 'm:0'], '자리는 처음 등장한 seq 로 넓어진다');
  eq(st.headSeq, 11, 'head 는 건드리지 않는다');
  M.applyBefore(st, { events: [], floorSeq: 7 });
  ok(st.noMoreBefore, '빈 응답이면 더 없다(당길 때마다 또 부르지 않는다)');
}

// ── 5. 델타(§2.5) ─────────────────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1', state: 'working' }, events: [], headSeq: 0 });
  ok(M.applyDelta(st, { key: 'm:0', kind: 'text', off: 0, text: '안녕' }).ok, '첫 조각(off 0)');
  ok(M.applyDelta(st, { key: 'm:0', kind: 'text', off: 2, text: '하세요' }).ok && st.live.get('m:0').text === '안녕하세요', 'off 가 맞으면 이어 붙인다');
  const bad = M.applyDelta(st, { key: 'm:0', kind: 'text', off: 9, text: '!' });
  ok(bad.resync === true && st.live.get('m:0').text === '안녕하세요', '★ off 가 어긋나면 버리고 since');
  ok(M.applyDelta(st, { key: 'm:0', kind: 'text', off: 2, text: '하세요' }).ignored === true, '같은 조각의 재전송은 틈이 아니다');
  ok(M.applyDelta(st, { key: 'm:0', kind: 'text', off: 2, text: '다른글' }).resync === true, '같은 자리의 다른 글자는 틈이다');
  ok(M.applyDelta(st, { key: 'n:0', kind: 'text', off: 3, text: 'x' }).resync === true, '모르는 블록이 중간부터 오면 since');
  eq(M.buildRows(st).map((r) => r.type + ':' + r.key), ['live:m:0'], '초안은 live 행');
  M.applyPush(st, { threadId: 't1', events: [aMsg(1, 'm:0', '안녕하세요.')] });
  eq(M.buildRows(st).map((r) => r.type + ':' + r.key), ['assistant:m:0'], '★ 완성본이 오면 **같은 key** 의 행이 완성본이 된다');
  ok(M.applyDelta(st, { key: 'm:0', kind: 'text', off: 6, text: '늦은' }).ignored === true && st.live.size === 0, '완성본 뒤의 늦은 조각은 버린다');
  M.setLive(st, { 'k:1': { kind: 'thinking', text: '' }, 'm:0': { kind: 'text', text: 'x' } });
  eq([...st.live.entries()].map(([k, v]) => [k, v.key, v.kind]), [], 'live 맵 — key 가 값에 없으면 받지 않는다(모양을 추측하지 않는다)');
  M.setLive(st, { a: { key: 'k:1', kind: 'thinking', text: '' } });
  eq([...st.live.keys()], ['k:1'], 'live 는 key→블록 맵으로도 받는다');
  M.setLive(st, [{ key: 'k:2', kind: 'thinking', text: '' }, { key: 'm:0', kind: 'text', text: 'x' }]);
  eq([...st.live.keys()], ['k:2'], 'live 에서 이미 완성된 블록은 뺀다 · 빈 thinking 도 받는다');
}

// ── 6. 낙관 버블(§10.2) ───────────────────────────────────────────────────────
{
  eq(M.pendingNext('sending', 'ack_sent'), 'sent', 'sending → sent');
  eq(M.pendingNext('sending', 'ack_queued'), 'queued', 'sending → queued');
  eq(M.pendingNext('sending', 'timeout'), 'failed', 'sending → failed(20초)');
  eq(M.pendingNext('failed', 'retry'), 'sending', 'failed → sending(다시 시도)');
  eq(M.pendingNext('sending', 'retry'), 'sending', '보내는 중의 다시 시도는 아무 일도 아니다(멱등)');
  eq(M.pendingNext('failed', 'ack_sent'), 'sent', '★ 늦은 성공이 실패를 이긴다');
  eq(M.pendingNext('sent', 'error'), 'sent', '★ 접수된 뒤의 늦은 오류가 성공을 뒤집지 않는다');
  eq(M.pendingNext('queued', 'timeout'), 'queued', '대기열에 든 것은 시간 초과로 실패가 되지 않는다');

  const st = M.createConv('t1');
  M.applyOpen(st, { thread: { id: 't1' }, events: [], headSeq: 0 });
  const p = M.addPending(st, { clientId: 'c9', text: '원문 보관', now: T0 });
  ok(M.addPending(st, { clientId: 'c9', text: '다른 글', now: T0 }) === p && st.pending.size === 1, '같은 clientId 재등록은 멱등');
  M.markPending(st, 'c9', 'error', 'START_FAILED');
  eq([p.status, p.code, p.text], ['failed', 'START_FAILED', '원문 보관'], '실패해도 원문은 버블이 들고 있다');
  M.markPending(st, 'c9', 'retry');
  eq([p.status, p.code, p.clientId], ['sending', '', 'c9'], '★ 다시 시도는 같은 clientId');
  eq(M.buildRows(st).map((r) => r.type + ':' + r.status), ['pending:sending'], '버블 행');
  M.applyPush(st, { threadId: 't1', events: [uMsg(1, 'c9', 'queued', '원문 보관')] });
  eq(M.buildRows(st).map((r) => r.type + ':' + r.key + ':' + r.status), ['user:u:c9:queued'], '★ 서버 msg(같은 clientId)가 버블을 대체한다 — 둘이 되지 않는다');
  ok(M.markPending(st, 'c9', 'ack_sent') === null, '대체된 뒤의 전이는 아무 일도 하지 않는다');
  // 서버가 실패로 기록한 메시지를 접고 다시 보냈는데 또 실패 → 그 실패가 보여야 한다
  M.applyPush(st, { threadId: 't1', events: [uMsg(2, 'c9', 'failed', '원문 보관')] });
  st.hidden.add('u:c9');
  eq(M.buildRows(st).length, 0, '접어 둔 행은 안 보인다');
  M.applyPush(st, { threadId: 't1', events: [uMsg(3, 'c9', 'failed', '원문 보관')] });
  eq(M.buildRows(st).map((r) => r.status), ['failed'], '★ 같은 key 에 새 사실이 오면 접힘이 풀린다');
}

// ── 7. 요청(§2.4·§10.8) ───────────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  const req = (seq, id, status, extra = {}) => ({ seq, ts: T0 + seq, op: 'req', req: { id, kind: 'permission', tool: 'Bash', toolUseId: 'tu_' + id, summary: 'rm -rf x', status, requestedAt: T0 + (extra.at || seq), turn: 1, ...extra } });
  M.applyOpen(st, { thread: { id: 't1', state: 'waiting' }, events: [req(2, 'req_b', 'pending'), req(1, 'req_a', 'pending')], headSeq: 2, pending: [{ id: 'req_old', kind: 'question', status: 'pending', requestedAt: T0 - 5, questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }, req(1, 'req_a', 'pending').req, req(2, 'req_b', 'pending').req] });
  eq(M.openReqs(st).map((q) => q.id), ['req_old', 'req_a', 'req_b'], '가장 오래된 것부터 · 이벤트 창 밖의 pending 도 포함');
  M.applyPush(st, { threadId: 't1', events: [req(3, 'req_a', 'allowed', { by: '내 폰', resolvedAt: T0 + 9 })] });
  eq(M.openReqs(st).map((q) => q.id), ['req_old', 'req_b'], '★ 다른 기기가 답하면(upsert) 카드가 닫힌다');
  M.applyPush(st, { threadId: 't1', events: [req(4, 'req_b', 'canceled', { reason: 'interrupted' })] });
  eq(M.openReqs(st).map((q) => q.id), ['req_old'], '중단으로 닫힘(canceled)');

  const perm = M.reqToCard({ id: 'req_1', kind: 'permission', tool: 'Bash', summary: 'ls', detail: '목록', alwaysLabel: 'ls *', inputPreview: { command: 'ls -la' }, status: 'pending' });
  eq([perm.kind, perm.prompt.kind, perm.alwaysLabel, perm.summary], ['permission', 'permission', 'ls *', 'ls'], '권한 → 번호 선택지 카드');
  const q = M.reqToCard({ id: 'req_2', kind: 'question', questions: [{ question: 'Q?', options: [{ label: 'A' }] }] });
  ok(q.prompt.kind === 'choice' && q.prompt.questions.length === 1 && q.prompt.plan === undefined, '질문 → 질문 카드');
  const plan = M.reqToCard({ id: 'req_3', kind: 'plan', plan: '# 계획' });
  ok(plan.prompt.kind === 'choice' && plan.prompt.plan === '# 계획' && !plan.prompt.questions, '계획 → 선택지 없는 선택형(계획 본문)');
  eq(M.reqToCard(null), null, '없는 요청');

  const Q = { id: 'req_2', kind: 'question', questions: [{ question: '언제?', options: [] }, { header: '무엇', options: [] }] };
  eq(M.respondParams(Q, { decision: 'answer', answers: [{ questionIndex: 0, labels: ['밤', '낮'] }, { questionIndex: 1, labels: [], text: ' 직접 ' }] }, 'Mac'),
    { reqId: 'req_2', decision: 'answer', answers: { '언제?': '밤, 낮', '무엇': '직접' }, by: 'Mac' }, '★ 질문 답 = {"질문 문구":"답"}(§0.1)');
  eq(M.respondParams({ id: 'r', kind: 'permission' }, { decision: 'allow', always: true }), { reqId: 'r', decision: 'allow', always: true }, '허용하고 다음부터 묻지 않기');
  eq(M.respondParams({ id: 'r', kind: 'permission' }, { decision: 'deny', message: '그건 하지 마' }), { reqId: 'r', decision: 'deny', message: '그건 하지 마' }, '거절 + 사유');
  eq(M.respondParams({ id: 'r', kind: 'plan' }, { decision: 'answer', answers: [{ questionIndex: 0, labels: [], text: '테스트 먼저' }] }),
    { reqId: 'r', decision: 'allow', message: '테스트 먼저' }, '★ 계획 + 의견 = 허용 + 추가 지시(§4.2)');
  eq(M.respondParams({ id: 'r', kind: 'plan' }, { decision: 'allow' }), { reqId: 'r', decision: 'allow' }, '계획대로 진행');
}

// ── 8. 도구 짝짓기·묶기 ───────────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  const ev = [uMsg(1, 'c', 'sent')];
  let s = 2;
  for (const id of ['a', 'b', 'c', 'd']) { ev.push(tool(s++, id)); ev.push(result(s++, id, id !== 'c')); }
  ev.push(aMsg(s++, 'm:0', '끝'));
  M.applyOpen(st, { thread: { id: 't1', state: 'idle' }, events: ev, headSeq: s - 1 });
  let rows = M.buildRows(st);
  eq(rows.map((r) => r.type), ['user', 'group', 'assistant'], '★ 끝난 도구 4개 = 묶음 한 줄');
  eq([rows[1].count, rows[1].bad, rows[1].key], [4, 1, 'g:a'], '묶음 — 개수·실패 수·첫 도구 key');
  ok(rows[1].items.every((r) => r.result && r.result.key === 'r:' + r.key), '도구와 결과가 id 로 짝지어진다(결과는 독립 행이 아니다)');
  eq(M.buildRows(st, { openGroups: new Set(['g:a']) }).map((r) => r.type), ['user', 'tool', 'tool', 'tool', 'tool', 'assistant'], '펼친 묶음은 낱개로');
  eq(M.buildRows(st, { openTools: new Set(['b']) }).map((r) => r.type), ['user', 'tool', 'tool', 'tool', 'tool', 'assistant'], '사용자가 펼쳐 둔 도구는 묶음을 끊는다(3개 미만은 안 묶는다)');

  // 진행 중인 도구는 묶지 않는다 / 생각 줄은 묶음을 끊지 않는다 / diff 는 묶지 않는다
  const st2 = M.createConv('t2');
  M.applyOpen(st2, {
    thread: { id: 't2', state: 'working' }, headSeq: 12,
    events: [
      tool(1, 'a'), result(2, 'a'), tool(3, 'b'), result(4, 'b'),
      { seq: 5, ts: T0, op: 'msg', msg: { key: 'th:0', role: 'assistant', kind: 'thinking', text: '생각' } },
      tool(6, 'c'), result(7, 'c'), tool(8, 'd'), result(9, 'd'),
      tool(10, 'e', 'Edit'), result(11, 'e', true, { patch: { hunks: [] } }),
      tool(12, 'f'),
    ],
  });
  rows = M.buildRows(st2);
  eq(rows.map((r) => r.type + (r.type === 'group' ? r.count : '')), ['group4', 'tool', 'tool'], '★ 생각 줄은 묶음을 끊지 않는다 · diff 와 진행 중 도구는 묶지 않는다');
  eq(rows[2].result, null, '진행 중 = 결과 없음');
  eq(M.workingInfo(st2).title, 'Bash f', '작업 중 표시 = 결과가 아직 없는 마지막 도구');

  // 짝 없는 결과(도구 호출이 받아 둔 내역 밖)
  const st3 = M.createConv('t3');
  M.applyOpen(st3, { thread: { id: 't3' }, events: [result(5, 'zz')], headSeq: 5, floorSeq: 5 });
  eq(M.buildRows(st3).map((r) => r.type), ['orphan'], '짝 없는 결과는 독립 행');

  // 미응답 질문은 내역에 그리지 않는다(도크가 그린다)
  const st4 = M.createConv('t4');
  const qmsg = { seq: 1, ts: T0, op: 'msg', msg: { key: 'q1', role: 'assistant', kind: 'question', text: '', tool: { id: 'q1', name: 'AskUserQuestion' }, question: { question: 'Q?' } } };
  M.applyOpen(st4, { thread: { id: 't4', state: 'waiting' }, headSeq: 2, events: [qmsg, { seq: 2, ts: T0, op: 'req', req: { id: 'req_q', kind: 'question', toolUseId: 'q1', status: 'pending', questions: [] } }] });
  eq(M.buildRows(st4).length, 0, '★ 답하지 않은 질문은 내역에 없다(같은 질문이 둘이 되지 않게)');
  eq(M.workingInfo(st4).waiting, true, '요청 대기 중');
  M.applyPush(st4, { threadId: 't4', events: [{ seq: 3, ts: T0, op: 'req', req: { id: 'req_q', kind: 'question', toolUseId: 'q1', status: 'answered' } }, result(4, 'q1')] });
  eq(M.buildRows(st4).map((r) => r.type + ':' + r.question), ['tool:true'], '답한 뒤에는 질문과 답이 내역에 들어온다');
}

// ── 9. 턴 요약·작업 중 ────────────────────────────────────────────────────────
{
  const st = M.createConv('t1');
  M.applyOpen(st, {
    thread: { id: 't1', state: 'idle' }, headSeq: 4,
    events: [
      { seq: 1, ts: T0, op: 'turn', phase: 'start', turn: 1 }, uMsg(2, 'c', 'sent'), aMsg(3, 'm:0', '답'),
      { seq: 4, ts: T0 + 83000, op: 'turn', phase: 'end', turn: 1, ok: true, durationMs: 83000 },
    ],
  });
  const rows = M.buildRows(st);
  eq(rows.map((r) => r.type), ['user', 'assistant', 'turn'], '턴 끝 요약은 그 턴의 마지막 행');
  eq(M.turnSummaryText(rows[2]), '1분 23초 걸림', '걸린 시간');
  eq(M.turnSummaryText({ durationMs: 5000, interrupted: true, ok: true }), '중단됨 · 5초', '중단');
  eq(M.turnSummaryText({ durationMs: null, interrupted: false, ok: false }), '오류로 끝남', '오류');
  eq(M.turnSummary({ turn: 2, endSeq: 9, startTs: T0, endTs: T0 + 4000 }).durationMs, 4000, 'durationMs 가 없으면 시작·끝 시각으로');
  eq(M.turnSummary({ turn: 2, endSeq: 9 }), null, '할 말이 없는 턴은 줄을 만들지 않는다');
  eq([M.fmtDuration(8000), M.fmtDuration(180000), M.fmtDuration(3900000), M.fmtDuration(7200000)], ['8초', '3분', '1시간 5분', '2시간'], 'fmtDuration');
  eq(M.workingInfo(st).on, false, 'idle 은 작업 중이 아니다');
  st.thread.state = 'stopped';
  eq(M.isBusy(st), false, 'stopped 는 사용자에게 idle 과 같다(§2.1)');
}

// ── 10. 폴백 폴링(§10.1) ──────────────────────────────────────────────────────
{
  const now = T0;
  eq(M.shouldPoll({ now, lastPushAt: 0, lastPullAt: now - 16000, working: false, visible: true }), true, '유휴 15초');
  eq(M.shouldPoll({ now, lastPushAt: 0, lastPullAt: now - 9000, working: false, visible: true }), false, '유휴 15초 전에는 안 부른다');
  eq(M.shouldPoll({ now, lastPushAt: 0, lastPullAt: now - 6000, working: true, visible: true }), true, '작업 중 5초');
  eq(M.shouldPoll({ now, lastPushAt: now - 1000, lastPullAt: now - 6000, working: true, visible: true }), false, 'push 가 3초 안에 왔으면 건너뛴다');
  eq(M.shouldPoll({ now, lastPushAt: now - 1000, lastPullAt: now - 21000, working: true, visible: true }), true, '★ push 가 살아 있어도 20초에 한 번은 부른다(보고 있다는 신호)');
  eq(M.shouldPoll({ now, lastPushAt: 0, lastPullAt: 0, working: true, visible: false }), false, '안 보이면 안 부른다');
}

// ── 11. 오류 code(§4.0) ───────────────────────────────────────────────────────
{
  eq(M.parseConvError('HTTP 500 THREAD_BUSY_IN_TERMINAL: 터미널에서 사용 중').code, 'THREAD_BUSY_IN_TERMINAL', 'back 이 실어 준 detail.code');
  eq(M.parseConvError(new Error('HTTP 409 DAEMON_OFFLINE: PC 데몬이 연결되어 있지 않습니다.')).code, 'DAEMON_OFFLINE', 'PC 미연결');
  eq(M.parseConvError('HTTP 409: 뭔가').code, 'DAEMON_OFFLINE', 'code 없는 409 도 PC 미연결');
  eq(M.parseConvError('HTTP 403 CONV_DISABLED: 꺼짐').code, 'CONV_DISABLED', '킬스위치');
  eq(M.parseConvError('HTTP 404: Not Found').code, 'SERVER_NEEDS_UPDATE', '구 서버(라우트 없음)');
  eq(M.parseConvError('HTTP 500 TIMEOUT: x').code, 'TIMEOUT', '릴레이 타임아웃');
  eq(M.parseConvError('요청 실패: timed out reading response').code, 'TIMEOUT', '클라 HTTP 타임아웃');
  eq(M.parseConvError('요청 실패: Connection refused').code, 'NETWORK', '네트워크');
  eq(M.parseConvError({ code: 'REQ_NOT_PENDING', message: 'm' }).code, 'REQ_NOT_PENDING', 'code 를 가진 오류 객체');
  ok(M.isAmbiguousFailure('TIMEOUT') && !M.isAmbiguousFailure('START_FAILED'), '결과 불명 실패 구분');
  ok(M.convErrorText('NOPE') === M.convErrorText('') && M.convErrorText('THREAD_BUSY') !== M.convErrorText(''), '모르는 code 는 일반 문구');
  eq([M.convTimeoutSecs('conv.send'), M.convTimeoutSecs('conv.open'), M.convTimeoutSecs('conv.since'), M.convTimeoutSecs('conv.respond')], [35, 35, 20, 20], '클라 타임아웃 = back + 5초');
  eq(M.convTimeoutSecs('conv.file'), 35, 'conv.file 은 8MB 바이트 — back 30초 + 5(§4.5)');
}

// ── 12. 터미널로 넘기기·목록 ──────────────────────────────────────────────────
{
  eq(M.argsOfCommand('claude --resume 1b2c-3d'), ['--resume', '1b2c-3d'], '실행 파일을 뺀 인자');
  eq(M.argsOfCommand("'/Users/a b/bin/claude' --resume \"x y\" --model opus"), ['--resume', 'x y', '--model', 'opus'], '따옴표가 든 경로·인자');
  eq(M.argsOfCommand('/opt/my\\ tools/claude --resume id'), ['--resume', 'id'], '역슬래시 공백');
  eq(M.argsOfCommand(''), [], '빈 명령');
  eq(M.threadDot({ state: 'working', pending: 1 }), 'attention', '대기 요청이 있으면 조치 필요가 우선');
  eq([M.threadDot({ state: 'working' }), M.threadDot({ state: 'idle' }), M.threadDot({ state: 'error' })], ['working', '', 'error'], '상태 점');
  ok(M.needsAdopt({ owner: 'terminal' }) && !M.needsAdopt({ owner: 'chat' }) && !M.needsAdopt({ owner: 'none', external: true }), '터미널이 쓰는 대화만 가져오기가 필요하다');
  eq([M.fmtAgo(T0 - 20000, T0), M.fmtAgo(T0 - 5 * 60000, T0), M.fmtAgo(T0 - 3 * 3600000, T0), M.fmtAgo(T0 - 2 * 86400000, T0), M.fmtAgo(T0 + 9999, T0), M.fmtAgo(0, T0)],
    ['방금', '5분 전', '3시간 전', '2일 전', '방금', ''], '상대 시각');
}

// ── 13. 스트리밍 분할(§10.5) ──────────────────────────────────────────────────
{
  const sp = (t) => M.splitStreamBlocks(t);
  const patched = (t) => { const r = sp(t); return M.patchStreamTail(r.tail, r); };

  eq(sp('첫 문단\n\n둘째 문'), { blocks: ['첫 문단'], tail: '둘째 문', open: null, partial: true }, '빈 줄 = 블록 경계');
  eq(sp('a\n\n\n\nb\n'), { blocks: ['a'], tail: 'b', open: null, partial: false }, '연속 빈 줄 · 개행으로 끝난 꼬리는 미완 줄이 없다');
  eq(sp(''), { blocks: [], tail: '', open: null, partial: false }, '빈 글');

  // 열린 펜스
  const o1 = sp('설명\n```js\nconst a = 1;\n\nconst b = 2;');
  eq([o1.blocks, o1.open && o1.open.lang, o1.tail], [['설명'], 'js', '```js\nconst a = 1;\n\nconst b = 2;'], '★ 열린 펜스 — 안의 빈 줄은 경계가 아니다');
  ok(/chat-code-pre/.test(renderMarkdown(M.patchStreamTail(o1.tail, o1))) && !/chat-p/.test(renderMarkdown(M.patchStreamTail(o1.tail, o1))), '열린 펜스는 닫힌 것으로 보고 코드 블록으로 그린다');
  const o2 = sp('```js\na\n```\n다음');
  eq([o2.blocks, o2.tail, o2.open], [['```js\na\n```'], '다음', null], '닫힌 펜스는 빈 줄을 기다리지 않고 확정');
  eq(sp('~~~\n```\n~~~\n').blocks, ['~~~\n```\n~~~'], '다른 표식은 펜스를 닫지 못한다');

  // 쪼개진 펜스 줄
  eq(patched('문단\n``'), '문단', '★ 여는 펜스가 쪼개져 오는 중(``) — 그 줄을 미룬다(백틱이 깜빡이지 않게)');
  eq(patched('문단\n```py'), '문단', '언어 이름이 오는 중인 펜스 줄도 미룬다');
  eq(patched('```js\nx = 1\n``'), '```js\nx = 1', '★ 닫는 펜스가 쪼개져 오는 중 — 코드에 `` 가 보였다 사라지지 않는다');
  eq(patched('```js\nx = `a`'), '```js\nx = `a`', '코드 안의 백틱은 손대지 않는다');
  eq(patched('`npm'), '`npm`', '줄 머리의 인라인 코드는 펜스가 아니다');

  // 표 구분선 전
  eq(patched('| a | b |'), '| a | b |', '표 머리줄만 — 일반 글자');
  ok(!/chat-table/.test(renderMarkdown(patched('| a | b |\n|--'))), '★ 구분선이 오는 중에는 표가 아니다');
  eq(patched('| a | b |\n|--'), '| a | b |', '쓰다 만 구분선 줄은 미룬다');
  ok(/chat-table/.test(renderMarkdown(patched('| a | b |\n|---|---|\n| 1 |'))), '구분선이 완성되면 표');
  eq(patched('그냥 글\n|--'), '그냥 글\n|--', '앞 줄이 표가 아니면 손대지 않는다');

  // 미완 강조·링크
  eq(patched('이건 **굵'), '이건 **굵**', '★ 안 닫힌 ** 는 닫아서 그린다');
  eq(patched('이건 **'), '이건 ', '방금 연 ** 는 감춘다(빈 강조는 날글자가 된다)');
  eq(patched('**a** 그리고 **b'), '**a** 그리고 **b**', '닫힌 쌍은 세지 않는다');
  eq(patched('`**` 는 굵게'), '`**` 는 굵게', '코드 안의 ** 는 문법이 아니다');
  eq(patched('코드 `let x'), '코드 `let x`', '안 닫힌 백틱');
  eq(patched('기울임 *it'), '기울임 *it*', '안 닫힌 *');
  eq(patched('* 항목 하나'), '* 항목 하나', '목록 기호는 강조가 아니다');
  eq(patched('2 * 3 = 6'), '2 * 3 = 6', '곱셈');
  eq(patched('~~취'), '~~취~~', '취소선');
  eq(patched('문서는 [여기](https://exa'), '문서는 여기', '★ 주소가 오는 중인 링크는 라벨만');
  eq(patched('그림 ![도식](/tmp/a.p'), '그림 ', '주소가 오는 중인 이미지는 자리를 미룬다');
  eq(patched('#'), '', '제목 기호만 온 줄');
  eq(patched('문단\n-'), '문단', '목록 기호만 온 줄');
  eq(patched('끝난 줄 **열림\n'), '끝난 줄 **열림', '★ 끝난 줄은 고치지 않는다(거기서 안 닫힌 기호는 실제 날글자다)');
  for (const s of ['이건 **굵', '코드 `let x', '문서는 [여기](https://exa', '기울임 *it', '```js\nx\n``']) {
    ok(!/\*\*|`|\]\(/.test(renderMarkdown(patched(s)).replace(/<[^>]+>/g, '')), `보정 뒤에는 기호가 화면에 남지 않는다: ${JSON.stringify(s)}`);
  }

  // ★ 등식: 나눠 그린 것 = 통째로 그린 것. 글이 뒤로만 자랄 때 확정 블록은 바뀌지 않는다(접두 안정).
  const DOC = [
    '# 제목', '', '첫 문단 **굵게** 와 `코드`.', '둘째 줄.', '', '- 하나', '- 둘', '  - 둘의 하나', '', '1. 첫째', '2. 둘째', '',
    '> 인용', '> 계속', '', '```js', 'const a = 1;', '', 'function f() {}', '```', '바로 이어지는 글', '',
    '| 이름 | 값 |', '|---|:--:|', '| a | 1 |', '| b | 2 |', '', '---', '', '마지막 [링크](https://example.com) 문단.', '',
  ].join('\n');
  const whole = M.splitStreamBlocks(DOC);
  eq([whole.tail, whole.partial], ['마지막 [링크](https://example.com) 문단.', false], '빈 줄이 뒤따르지 않은 마지막 블록은 꼬리다(완성본에서는 뷰가 마지막 블록으로 그린다)');
  ok([...whole.blocks, whole.tail].map((b) => renderMarkdown(b)).join('') === renderMarkdown(DOC), '★ 블록을 따로 그려 이은 것 = 통째로 그린 것', whole.blocks.length);
  eq(M.patchStreamTail(whole.tail, whole), whole.tail, '끝난 꼬리는 보정하지 않는다');
  let stable = true, monotone = true, prev = [];
  for (let i = 1; i <= DOC.length; i++) {
    const r = M.splitStreamBlocks(DOC.slice(0, i));
    if (r.blocks.length < prev.length) monotone = false;
    for (let k = 0; k < prev.length; k++) if (r.blocks[k] !== prev[k]) stable = false;
    prev = r.blocks;
    M.patchStreamTail(r.tail, r);   // 어떤 접두에서도 던지지 않는다
  }
  ok(stable && monotone, `★ 한 글자씩 자라는 ${DOC.length}개 접두에서 확정 블록이 한 번도 바뀌지 않는다`);
  eq(sp('a\r\n\r\nb').blocks, ['a'], 'CRLF');
}

// ── 8. 첨부(§4.1·§4.5) ────────────────────────────────────────────────────────
{
  // 데몬 composeText 가 만드는 본문: 글 + 빈 줄 + `[첨부] <절대경로>` 줄들, msg.attachments 에 메타
  const text = '이 화면 봐 줘\n\n[첨부] /Users/me/a/shot.png\n[첨부] /Users/me/docs/spec.pdf';
  const atts = [{ idx: 0, name: '화면.png', path: '/Users/me/a/shot.png', mediaType: 'image/png' }, { idx: 1, name: 'spec.pdf', path: '/Users/me/docs/spec.pdf' }];
  const sp = M.splitAttachLines(text, atts);
  eq(sp.body, '이 화면 봐 줘', '★ 끝의 [첨부] 줄을 본문에서 뗀다(빈 줄까지)');
  eq(sp.files.map((f) => [f.path, f.name, f.image]), [['/Users/me/a/shot.png', '화면.png', true], ['/Users/me/docs/spec.pdf', 'spec.pdf', false]], '칩 = 경로 순서 그대로, 이름·형식은 msg.attachments 에서');
  eq(M.splitAttachLines('[첨부] /Users/me/x.jpg', null).body, '', '첨부만 보낸 메시지 = 본문 없음');
  eq(M.splitAttachLines('[첨부] /Users/me/x.jpg', null).files[0].image, true, '메타가 없으면 확장자로 이미지 판정');
  const mid = '예: [첨부] /a/b.png 이런 줄\n그리고 끝';
  eq(M.splitAttachLines(mid, null), { body: mid, files: [] }, '★ 본문 중간·끝이 아닌 [첨부] 는 사용자가 쓴 글이다');
  eq(M.splitAttachLines('앞\n[첨부] /a/x.png\n뒤', null).files.length, 0, '뒤에 글이 있으면 떼지 않는다');
  eq(M.splitAttachLines('글', [{ path: '/Users/me/y.png', name: 'y.png' }]).files.map((f) => f.path), ['/Users/me/y.png'], '줄이 없고 attachments 만 있으면 그것으로');

  // 어디서 온 경로인가 → 그 PC 의 경로로 만드는 방법
  eq(M.attachPlan({ path: 'demo/src/a.js', origin: 'workspace' }, false), 'keep', '워크스페이스에서 고른 파일은 그 PC 의 것 — 다른 PC 여도 그대로');
  eq(M.attachPlan({ path: '/Users/me/Desktop/a.png', origin: 'local' }, true), 'keep', '이 PC 의 홈 안 → 그대로');
  eq(M.attachPlan({ path: '/var/folders/zz/T/clip.png', origin: 'local' }, true), 'copy', '★ 붙여넣은 스크린샷(임시 폴더 = 홈 밖) → 홈으로 복사(안 하면 데몬 jail 이 조용히 버린다)');
  eq(M.attachPlan({ path: '/Users/Shared/x.png', origin: 'local' }, true), 'copy', '/Users/Shared 는 홈이 아니다');
  eq(M.attachPlan({ path: 'C:\\Users\\me\\a.png', origin: 'local' }, true), 'keep', 'win32 홈');
  eq(M.attachPlan({ path: '/Users/me/Desktop/a.png', origin: 'local' }, false), 'upload', '★ 다른 PC 의 대화 → 이 PC 파일은 올린다');
  const nm = M.attachUploadName('내 파일 (1).png', new Date(2026, 8, 30, 7, 5, 9).getTime());
  eq(nm, '.codingpt/attachments/20260930-070509-내_파일_(1).png', '올리는 이름 = 타임스탬프-원래이름(공백·구분자 정리)');
  ok(!M.attachUploadName('../../etc/passwd', 0).includes('../'), '이름의 경로 구분자로 폴더를 벗어나지 못한다');
  eq(M.attachmentsForWire([]), undefined, '없으면 필드를 싣지 않는다');
  const many = Array.from({ length: 15 }, (_, i) => ({ path: '/Users/me/f' + i + '.txt', name: 'f' + i, thumb: 'data:x' }));
  const wire = M.attachmentsForWire([...many, many[0]]);
  eq([wire.length, Object.keys(wire[0]).sort()], [12, ['name', 'path']], '★ 와이어는 최대 12 · 썸네일 같은 화면 전용 필드는 안 싣는다');
  eq(M.attachmentsForWire([{ path: '/a', name: 'a' }, { path: '/a', name: 'b' }, { path: '' }]).length, 1, '같은 경로·빈 경로는 뺀다');

  // 낙관 버블도 칩을 들고 있다(다시 시도가 같은 파일로 간다)
  const st = M.createConv(null);
  M.addPending(st, { clientId: 'c1', text: '', now: T0, attachments: [{ path: '/Users/me/a.png', name: 'a.png', image: true }] });
  const row = M.buildRows(st).find((r) => r.type === 'pending');
  eq(row.attachments.map((a) => a.path), ['/Users/me/a.png'], '낙관 버블 행에 첨부가 있다');
  M.addPending(st, { clientId: 'c2', text: '글만', now: T0 });
  eq(M.buildRows(st).find((r) => r.key === 'p:c2').attachments, null, '첨부 없는 버블');
}

// ── 9. 파일 바이트 캐시(conv.file) ───────────────────────────────────────────
{
  const c = M.createByteCache(100);
  let calls = 0;
  const load = (b64) => () => { calls++; return new Promise((r) => setTimeout(() => r({ mediaType: 'image/png', base64: b64 }), 5)); };
  const [a, b] = await Promise.all([c.get('k1', load('x'.repeat(40))), c.get('k1', load('y'))]);
  ok(calls === 1 && a === b, '★ 같은 파일을 동시에 두 행이 물어도 한 번만 받는다');
  await c.get('k1', load('z'));
  ok(calls === 1, '받은 것은 다시 받지 않는다');
  await c.get('m', () => { calls++; return { missing: true, reason: 'not_found' }; });
  await c.get('m', () => { calls++; return { missing: true, reason: 'not_found' }; });
  ok(calls === 3, '"없음"은 남기지 않는다(곧 생길 수 있다)');
  await c.get('k2', load('x'.repeat(40)));
  await c.get('k3', load('x'.repeat(40)));
  ok(!c.has('k1') && c.has('k2') && c.has('k3') && c.size <= 100, '★ 상한을 넘으면 오래된 것부터 버린다', c.size);
  let threw = false;
  try { await c.get('e', () => { throw new Error('x'); }); } catch (_) { threw = true; }
  ok(threw && !c.has('e'), '실패는 그대로 던지고 남기지 않는다');
  eq(M.fileMissingText({ missing: true, reason: 'too_large' }), '파일이 너무 커서 여기서는 못 보여줘요(눌러서 열기)', '없음 사유 문구 — 너무 큼');
  eq(M.fileMissingText({ missing: true, reason: 'not_referenced' }), '불러오지 못했어요', '없음 사유 문구 — 대화에 없는 경로');
}

// ── 10. 사용량 줄·에이전트·모델(§4.5) ─────────────────────────────────────────
{
  const { statusChips } = await import('../src/js/chat-model.js');
  const th = { id: 't', model: 'claude-x', usage: { contextTokens: 84000, contextMax: 200000, contextPct: 42, costUsd: 0.3, model: 'claude-y' } };
  eq(statusChips(M.usageStatus(th)).map((c) => c.text), ['claude-y', '컨텍스트 42%'], '★ "모델 · 컨텍스트 n%" — 앱 ConvBody 와 같은 칩');
  eq(M.usageStatus({ usage: { contextTokens: 50000, contextMax: 200000 } }).contextPct, 25, 'contextPct 가 없으면 토큰으로 계산');
  eq(M.usageStatus({ model: 'm', usage: { contextTokens: null, contextMax: null, contextPct: null, costUsd: null, model: null } }), { model: 'm' }, 'null 필드는 싣지 않는다(빈 칩 없음)');
  eq(M.usageStatus({ usage: null }), null, '아무것도 모르면 줄이 없다');
  eq(M.usageStatus({ usage: { contextPct: 140 } }).contextPct, 100, '0~100 으로 자른다');

  const one = { agents: [{ id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: false }] };
  eq(M.agentChoices(one), [], '★ 쓸 수 있는 에이전트가 1개면 고르는 줄을 숨긴다');
  const two = { agents: [{ id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: true }] };
  eq(M.agentChoices(two).map((a) => a.id), ['claude', 'codex'], '2개 이상이면 보인다');
  eq(M.agentChoices(null), [], 'caps 를 모르면 숨긴다');

  eq(M.modelChoices({ enabled: true, agents: two.agents, modes: [] }, 'claude', 'x'), [], '★ 데몬이 모델 목록을 안 주면 기능을 숨긴다(추측한 별칭 없음)');
  eq(M.modelChoices({ models: ['a', { id: 'b', label: 'B 모델' }] }, 'claude', 'b').map((m) => [m.id, m.label, m.on]), [['a', 'a', false], ['b', 'B 모델', true]], 'caps.models — 문자열·객체 둘 다');
  eq(M.modelChoices({ models: ['a'], agents: [{ id: 'codex', models: ['c1', 'c2'] }] }, 'codex', '').map((m) => m.id), ['c1', 'c2'], '에이전트별 목록이 있으면 그것');
  eq(M.modelChoices({ models: ['a', 'b'] }, 'claude', 'zz').map((m) => [m.id, m.on]), [['zz', true], ['a', false], ['b', false]], '지금 모델이 목록에 없으면 맨 앞에 남긴다');
}

// ── 11. 대화 안 검색 ──────────────────────────────────────────────────────────
{
  eq(M.countMatches('Abc abc ABC', 'abc'), 3, '대소문자 무시');
  eq(M.countMatches('aaaa', 'aa'), 2, '겹치지 않게 센다');
  eq(M.countMatches('x', ''), 0, '빈 검색어');
  const st = M.createConv('t');
  M.applyOpen(st, { thread: { id: 't', state: 'idle' }, headSeq: 12, floorSeq: 1, live: [], pending: [], events: [
    aMsg(1, 'a:0', '시작'),
    tool(2, 't1', 'Read'), result(3, 't1', true, { preview: 'nothing' }),
    tool(4, 't2', 'Read'), result(5, 't2', true, { preview: 'needle here' }),
    tool(6, 't3', 'Bash'), result(7, 't3', true, { preview: 'x' }),
    tool(8, 't4', 'Bash'), result(9, 't4', true),
    aMsg(10, 'a:1', '끝'),
  ] });
  const rows = M.buildRows(st);
  const g = rows.find((r) => r.type === 'group');
  ok(!!g, '끝난 도구 4개는 한 줄로 접혀 있다');
  const ex = M.searchExpand(rows, 'NEEDLE');
  ok(ex.groups.has(g.key) && ex.tools.has('t2') && ex.tools.size === 1, '★ 접힌 묶음 속 도구 결과의 일치 → 그 묶음과 그 도구만 펼친다');
  const ex2 = M.searchExpand(rows, 'Bash t3');
  ok(ex2.groups.has(g.key) && ex2.tools.size === 0, '도구 제목의 일치는 묶음만 펼친다(결과까지 열지 않는다)');
  eq(M.searchExpand(rows, '시작').groups.size, 0, '보이는 행의 일치는 아무것도 펼치지 않는다');
  eq(M.searchExpand(rows, '  ').groups.size, 0, '공백 검색어');
}

// ── 12. 알림으로 대화 열기 · 탭 라벨 ─────────────────────────────────────────
{
  const A = { id: 'A', threadId: 'tA' }, blank1 = { id: 'b1', threadId: null }, blank2 = { id: 'b2', threadId: null, focused: true };
  eq(M.pickConvTab([A, blank1], 'tA').kind, 'focus', '그 대화가 열린 탭이 있으면 그리로');
  const r = M.pickConvTab([A, blank1, blank2], 'tB');
  ok(r.kind === 'reuse' && r.target === blank2, '★ 없으면 빈 새 채팅 탭을 쓴다(포커스된 것 우선)');
  eq(M.pickConvTab([A, blank1], 'tB').target, blank1, '빈 탭이 하나면 그것');
  eq(M.pickConvTab([A], 'tB').kind, 'new', '★ 다른 대화가 열린 탭은 갈아치우지 않는다 → 새 탭');
  eq(M.pickConvTab([], 'tB').kind, 'new', '채팅 탭이 없으면 새 탭');

  eq(M.tabPatchFor({ threadId: 'tA', title: 'A 대화' }, 'tB', { id: 'tB', title: 'B 대화' }), { threadId: 'tB', title: 'B 대화' }, '대화가 바뀌면 라벨도 그 대화의 제목');
  eq(M.tabPatchFor({ threadId: 'tA', title: 'A 대화' }, 'tB', { id: 'tB', title: '' }), { threadId: 'tB', title: undefined }, '★ 제목 없는 대화로 바뀌면 옛 제목을 지운다(옛 라벨이 남던 버그)');
  eq(M.tabPatchFor({ threadId: 'tA', title: '옛 제목' }, 'tA', { id: 'tA', title: '새 제목' }), { title: '새 제목' }, '★ 제목이 갱신되면 라벨도');
  eq(M.tabPatchFor({ threadId: 'tA', title: 'A' }, 'tA', { id: 'tA', title: 'A' }), null, '같으면 건드리지 않는다(영속·재렌더 없음)');
  eq(M.tabPatchFor({ threadId: 'tA', title: 'A' }, 'tA', { id: 'tA', title: '' }), null, '제목을 아직 모르면 지금 라벨을 둔다');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
