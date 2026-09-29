'use strict';
if (process.platform === 'win32') {
  require('node:test')('conv.test.js: win32 스킵 — POSIX 픽스처(셔뱅 가짜 CLI)', { skip: true }, () => {});
  return;
}
// 채팅 v2 엔진(conv.js) — docs/chat-v2-design.md.
//  가짜 CLI(test/fixtures/conv/fake-agent.js)를 CODINGPT_CLAUDE_BIN 으로 주입해 실제 프로세스·stdin/stdout 으로 돈다.
//  ★ 실제 에이전트 CLI·back·tmux 를 부르지 않는다(push·알림·터미널은 전부 주입).
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-conv-')));
const STATE = path.join(ROOT, '.codingpt');
const CLAUDE_HOME = path.join(ROOT, '.claude');
const WS = path.join(ROOT, 'ws');
const ARGS_LOG = path.join(ROOT, 'args.log');
const FAKE = path.join(__dirname, 'fixtures', 'conv', 'fake-agent.js');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(CLAUDE_HOME, 'projects'), { recursive: true });
fs.chmodSync(FAKE, 0o755);
process.env.CODINGPT_CLAUDE_BIN = FAKE;
process.env.CODINGPT_TMUX_SOCKET = `convtest-${process.pid}`; // control 배선 테스트가 pty 를 끌어온다 — 사용자 tmux 와 격리
delete process.env.CPT_CONV;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: CLAUDE_HOME });
const conv = require('../conv');
const store = require('../conv-store');
const transcript = require('../transcript');

// ── 하네스 ───────────────────────────────────────────────────────────────────
let frames = [];
let notes = [];
let extraEnv = {};
let serverCaps = [];
let cfg = {};
const terminals = new Map();   // sessionId → { cwdRel, tid, state }
const binds = new Map();       // `${cwd}|${tid}` → { sessionId }
const termStates = new Map();  // `${cwd}|${tid}` → state
let term = null;

function setup(timings) {
  conv.configure({
    send: (f) => { frames.push(JSON.parse(JSON.stringify(f))); return true; },
    serverCaps: () => serverCaps,
    notify: async (p) => { notes.push(p); },
    deviceId: () => 7,
    config: () => cfg,
    env: async () => ({ ...process.env, FAKE_ARGS_LOG: ARGS_LOG, ...extraEnv }),
    terminalOf: (sid) => terminals.get(sid) || null,
    bindOf: (cwd, tid) => binds.get(`${cwd}|${tid}`) || null,
    termState: (cwd, tid) => termStates.get(`${cwd}|${tid}`) || null,
    termName: (cwd, tid) => `cpt-${cwd}--t-${tid}`,
    term: { sendKeys: (...a) => term.sendKeys(...a), info: (...a) => term.info(...a) },
    installExitHooks: false,
    log: () => {},
    timings: { ackWaitMs: 2000, stopGraceMs: 300, hintMs: 5, viewerMs: 30000, idleMs: 600000, adoptWaitMs: 600, adoptPollMs: 20, adoptKeyGapMs: 5, ...(timings || {}) },
  });
}
setup();

const rpc = (m, p) => conv.rpc(m, p || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = '조건') {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`시간 안에 충족되지 않음: ${what}`);
    await sleep(15);
  }
}
const eventsOf = (id) => frames.filter((f) => f.threadId === id && f.events).flatMap((f) => f.events);
const deltasOf = (id) => frames.filter((f) => f.threadId === id && f.delta).map((f) => f.delta);
const turnEnds = (id) => eventsOf(id).filter((e) => e.op === 'turn' && e.phase === 'end');
const waitTurnEnd = (id, n = 1) => waitFor(() => turnEnds(id).length >= n, 5000, `턴 종료 ${n}회`);
const waitReq = (id) => waitFor(() => eventsOf(id).find((e) => e.op === 'req' && e.req.status === 'pending'), 4000, '요청');
const spawns = () => (fs.existsSync(ARGS_LOG) ? fs.readFileSync(ARGS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const spawnsOf = (id) => spawns().filter((s) => s.argv.includes(id));
let cseq = 0;
const cid = () => `c${++cseq}-${Date.now()}`;
async function start(text, more) {
  const clientId = cid();
  const r = await rpc('conv.create', { cwd: 'ws', text, clientId, ...(more || {}) });
  return { id: r.thread.id, clientId, r };
}

afterEach(async () => {
  for (const id of [...conv._internals.live.keys()]) { try { await rpc('conv.stop', { threadId: id }); } catch (_) { /* noop */ } }
  await waitFor(() => conv._internals.live.size === 0, 3000, '프로세스 정리');
  extraEnv = {}; serverCaps = []; cfg = {};
  terminals.clear(); binds.clear(); termStates.clear(); term = null;
  frames = []; notes = [];
  setup();
});
after(async () => { await conv._internals._reset(); });

// ── 정상 턴 ──────────────────────────────────────────────────────────────────
test('정상 턴 — seq 연속, 턴 시작/끝, 사용자 메시지 queued → sent(같은 key)', async () => {
  const { id, clientId, r } = await start('say 안녕하세요 반갑습니다');
  assert.strictEqual(r.thread.agent, 'claude');
  assert.strictEqual(r.thread.owner, 'chat');
  assert.ok(Number.isInteger(r.seq));
  await waitTurnEnd(id);
  const evs = eventsOf(id);
  evs.forEach((e, i) => { if (i) assert.strictEqual(e.seq, evs[i - 1].seq + 1, 'push 된 이벤트의 seq 는 연속'); });
  assert.strictEqual(evs[0].seq, 1);
  // 프레임마다 headSeq = 마지막 이벤트의 seq
  for (const f of frames.filter((x) => x.events)) assert.strictEqual(f.headSeq, f.events[f.events.length - 1].seq);

  const mine = evs.filter((e) => e.op === 'msg' && e.msg.key === 'u:' + clientId);
  assert.deepStrictEqual(mine.map((e) => e.msg.status), ['queued', 'sent']);
  assert.strictEqual(mine[1].first, mine[0].seq);
  assert.strictEqual(mine[1].msg.clientId, clientId);
  assert.ok(mine[1].uuid, '도달 확인의 uuid 를 기록한다');
  assert.strictEqual(r.seq, mine[0].seq);

  const turns = evs.filter((e) => e.op === 'turn');
  assert.deepStrictEqual(turns.map((e) => [e.phase, e.turn]), [['start', 1], ['end', 1]]);
  assert.strictEqual(turns[1].ok, true);
  assert.strictEqual(turns[1].interrupted, false);
  assert.ok(turns[1].costUsd > 0);

  const reply = evs.find((e) => e.op === 'msg' && e.msg.role === 'assistant' && e.msg.kind === 'text');
  assert.strictEqual(reply.msg.text, '안녕하세요 반갑습니다');
  assert.strictEqual(reply.msg.turn, 1);

  const t = (await rpc('conv.open', { threadId: id })).thread;
  assert.strictEqual(t.state, 'idle');
  assert.strictEqual(t.title, 'say 안녕하세요 반갑습니다');
  assert.strictEqual(t.preview, '안녕하세요 반갑습니다');
  assert.strictEqual(t.model, 'fake-model-1');
  assert.strictEqual(t.usage.contextMax, 200000);
  assert.ok(!('x' in t), '내부 장부는 와이어에 싣지 않는다');

  const sp = spawnsOf(id);
  assert.strictEqual(sp.length, 1);
  assert.ok(sp[0].argv.includes('--session-id') && !sp[0].argv.includes('--resume'));
  assert.strictEqual(fs.realpathSync(sp[0].cwd), WS);
});

test('델타 — off 가 이어지고, 완성 메시지의 key 가 델타 key 와 같다', async () => {
  const { id } = await start('think 곰곰이 생각한 뒤의 답변입니다');
  await waitTurnEnd(id);
  const deltas = deltasOf(id);
  assert.ok(deltas.length >= 2);
  const acc = new Map();
  for (const d of deltas) {
    const cur = acc.get(d.key) || '';
    assert.strictEqual(d.off, cur.length, `${d.key} off 연속`);
    acc.set(d.key, cur + d.text);
  }
  const msgs = eventsOf(id).filter((e) => e.op === 'msg' && e.msg.role === 'assistant').map((e) => e.msg);
  const think = msgs.find((m) => m.kind === 'thinking');
  const text = msgs.find((m) => m.kind === 'text');
  assert.ok(acc.has(think.key) && acc.has(text.key));
  assert.strictEqual(acc.get(text.key), text.text);
  assert.strictEqual(think.key.split(':')[0], text.key.split(':')[0], '같은 메시지의 두 블록');
  assert.deepStrictEqual([think.key.split(':')[1], text.key.split(':')[1]], ['0', '1']);
  // 델타 프레임은 영속 이벤트가 아니다 — seq 도 headSeq 도 없다.
  for (const f of frames.filter((x) => x.delta)) assert.deepStrictEqual(Object.keys(f).sort(), ['delta', 'threadId', 'type']);
});

test('live — 진행 중에 연 클라는 지금까지의 초안을 받고, 다음 조각의 off 가 거기서 이어진다', async () => {
  extraEnv = { FAKE_PACE_MS: '40' };
  const { id } = await start('say 가나다라마바사아자차카타파하 가나다라마바사아자차카타파하');
  await waitFor(() => deltasOf(id).length >= 2, 4000, '초안 조각');
  const snap = await rpc('conv.open', { threadId: id });
  assert.strictEqual(snap.thread.state, 'working');
  assert.strictEqual(snap.live.length, 1);
  const at = deltasOf(id).length;
  const pushed = deltasOf(id).map((d) => d.text).join('');
  assert.strictEqual(snap.live[0].text, pushed.slice(0, snap.live[0].text.length));
  assert.ok(pushed.startsWith(snap.live[0].text));
  await waitFor(() => deltasOf(id).length > at, 3000, '다음 조각');
  const next = deltasOf(id)[at];
  assert.strictEqual(next.key, snap.live[0].key);
  assert.strictEqual(next.off, deltasOf(id).slice(0, at).reduce((n, d) => n + d.text.length, 0));
  await waitTurnEnd(id);
  assert.deepStrictEqual((await rpc('conv.since', { threadId: id, sinceSeq: 0 })).live, [], '끝나면 초안이 없다');
});

// ── 보내기 ───────────────────────────────────────────────────────────────────
test('conv.send 멱등 — 같은 clientId 를 두 번(겹쳐서도, 뒤에도) 보내도 한 번만 전달된다', async () => {
  const { id } = await start('say 첫째');
  await waitTurnEnd(id);
  const clientId = cid();
  const [a, b] = await Promise.all([
    rpc('conv.send', { threadId: id, clientId, text: 'say 둘째' }),
    rpc('conv.send', { threadId: id, clientId, text: 'say 둘째' }),
  ]);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.status, 'sent');
  await waitTurnEnd(id, 2);
  const c = await rpc('conv.send', { threadId: id, clientId, text: 'say 둘째' });
  assert.deepStrictEqual(c, { ok: true, status: 'sent', seq: a.seq });
  await sleep(150);
  assert.strictEqual(turnEnds(id).length, 2, '세 번째 턴은 없다');
  const replies = eventsOf(id).filter((e) => e.op === 'msg' && e.msg.role === 'assistant' && e.msg.text === '둘째');
  assert.strictEqual(replies.length, 1);
});

test('conv.create 멱등 — 같은 clientId 의 재시도가 대화를 하나 더 만들지 않는다', async () => {
  const clientId = cid();
  const [a, b] = await Promise.all([
    rpc('conv.create', { cwd: 'ws', text: 'say 하나', clientId }),
    rpc('conv.create', { cwd: 'ws', text: 'say 하나', clientId }),
  ]);
  assert.strictEqual(a.thread.id, b.thread.id);
  await waitTurnEnd(a.thread.id);
  const c = await rpc('conv.create', { cwd: 'ws', text: 'say 하나', clientId });
  assert.strictEqual(c.thread.id, a.thread.id);
  assert.strictEqual(c.seq, a.seq);
  assert.strictEqual((await rpc('conv.list', { cwd: 'ws' })).threads.filter((t) => t.id === a.thread.id).length, 1);
});

test('턴 중 추가 입력 — queued 로 접수되고, 앞 턴이 끝난 뒤 다음 턴으로 처리된다', async () => {
  const { id } = await start('sleep 400');
  await waitFor(() => eventsOf(id).some((e) => e.op === 'msg' && e.msg.kind === 'tool_use'), 3000, '도구 실행');
  const clientId = cid();
  const r = await rpc('conv.send', { threadId: id, clientId, text: 'say 끼어든 말' });
  assert.strictEqual(r.status, 'queued');
  assert.strictEqual(turnEnds(id).length, 0);
  await waitTurnEnd(id, 2);
  const evs = eventsOf(id);
  const mine = evs.filter((e) => e.op === 'msg' && e.msg.key === 'u:' + clientId);
  assert.deepStrictEqual(mine.map((e) => e.msg.status), ['queued', 'sent']);
  assert.deepStrictEqual([mine[0].msg.turn, mine[1].msg.turn], [1, 2], '도달한 턴으로 옮겨 적는다');
  assert.deepStrictEqual(evs.filter((e) => e.op === 'turn').map((e) => `${e.phase}${e.turn}`), ['start1', 'end1', 'start2', 'end2']);
  assert.ok(evs.some((e) => e.op === 'msg' && e.msg.text === '끼어든 말' && e.msg.turn === 2));
  assert.strictEqual(spawnsOf(id).length, 1, '같은 프로세스');
});

test('느린 기동 — 기다려 주는 시간 안에 확인이 없으면 queued 로 회신하고 확인은 뒤따른다', async () => {
  setup({ ackWaitMs: 150 });
  extraEnv = { FAKE_START_DELAY_MS: '600' };
  const t0 = Date.now();
  const { id, clientId, r } = await start('say 늦게 떴습니다');
  assert.ok(Date.now() - t0 < 550, 'RPC 는 기동을 끝까지 기다리지 않는다');
  assert.strictEqual(store.latestOf(id, 'msg', 'u:' + clientId).msg.status, 'queued');
  assert.strictEqual(r.thread.state, 'working');
  await waitTurnEnd(id);
  assert.strictEqual(store.latestOf(id, 'msg', 'u:' + clientId).msg.status, 'sent');
});

test('도달 확인 짝짓기 — uuid 를 되돌리지 않는 CLI 에서도 보낸 순서로 맞춘다', async () => {
  extraEnv = { FAKE_NO_UUID_ECHO: '1' };
  const { id, clientId } = await start('say 순서로');
  await waitTurnEnd(id);
  assert.strictEqual(store.latestOf(id, 'msg', 'u:' + clientId).msg.status, 'sent');
  assert.strictEqual(eventsOf(id).filter((e) => e.op === 'msg' && e.msg.role === 'user').length, 2, '따로 생긴 사용자 메시지가 없다');
});

test('터미널 전용 명령 — 에이전트에 보내지 않고 안내를 남긴다', async () => {
  const { id } = await start('say 준비');
  await waitTurnEnd(id);
  const cmds = (await rpc('conv.commands', { threadId: id })).items.map((c) => c.name);
  assert.ok(cmds.includes('/compact') && !cmds.includes('/doctor'));
  const r = await rpc('conv.send', { threadId: id, clientId: cid(), text: '/doctor' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'TERMINAL_ONLY_COMMAND');
  assert.ok(eventsOf(id).some((e) => e.op === 'notice' && e.code === 'TERMINAL_ONLY_COMMAND'));
  await sleep(100);
  assert.strictEqual(turnEnds(id).length, 1);
});

test('보내기 검증 — 빈 본문·clientId 누락·없는 대화', async () => {
  const { id } = await start('say 검증');
  await waitTurnEnd(id);
  await assert.rejects(rpc('conv.send', { threadId: id, clientId: cid(), text: '   ' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(rpc('conv.send', { threadId: id, text: 'x' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(rpc('conv.send', { threadId: 'nope', clientId: cid(), text: 'x' }), (e) => e.code === 'THREAD_NOT_FOUND');
  await assert.rejects(rpc('conv.create', { cwd: 'no-such-folder', text: 'x' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(rpc('conv.create', { cwd: '../..', text: 'x' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(rpc('conv.create', { cwd: 'ws', mode: 'god' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(rpc('conv.nope', {}), (e) => e.code === 'BAD_REQUEST');
});

// ── 승인·질문 ────────────────────────────────────────────────────────────────
test('승인 허용 — pending → allowed, 도구가 실행되고 턴이 이어진다', async () => {
  const { id } = await start('write allow.txt');
  const ev = await waitReq(id);
  const req = ev.req;
  assert.match(req.id, /^req_/);
  assert.strictEqual(req.kind, 'permission');
  assert.strictEqual(req.tool, 'Write');
  assert.strictEqual(req.relPath, 'allow.txt');
  assert.strictEqual(req.summary, 'allow.txt', '요약에 홈 절대경로를 싣지 않는다');
  assert.strictEqual(req.diff.kind, 'write');
  assert.strictEqual(req.alwaysLabel, '이번 대화에서 파일 수정 자동 허용');
  assert.strictEqual(req.turn, 1);
  assert.ok(!('rid' in req) && !JSON.stringify(req).includes('request_id'), '에이전트의 요청 id 는 내부에만');
  const open = await rpc('conv.open', { threadId: id });
  assert.strictEqual(open.thread.state, 'waiting');
  assert.strictEqual(open.thread.pending, 1);
  assert.deepStrictEqual(open.pending.map((r) => r.id), [req.id]);

  assert.deepStrictEqual(await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow', by: '내 폰' }), { ok: true });
  await waitTurnEnd(id);
  const states = eventsOf(id).filter((e) => e.op === 'req' && e.req.id === req.id).map((e) => e.req.status);
  assert.deepStrictEqual(states, ['pending', 'allowed']);
  const done = store.latestOf(id, 'req', req.id).req;
  assert.strictEqual(done.by, '내 폰');
  assert.ok(done.resolvedAt >= done.requestedAt);
  assert.ok(fs.existsSync(path.join(WS, 'allow.txt')));
  assert.strictEqual((await rpc('conv.open', { threadId: id })).thread.pending, 0);
  assert.strictEqual((await rpc('conv.open', { threadId: id })).thread.mode, 'default');
  await assert.rejects(rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow' }), (e) => e.code === 'REQ_NOT_PENDING');
  // 알림 — 즉시, 승인 인박스와 엮이지 않는 kind, 대화와 호스트를 싣는다.
  const n = notes.find((x) => x.kind === 'conv_request');
  assert.ok(n);
  assert.strictEqual(n.threadId, id);
  assert.strictEqual(n.title, 'Claude');
  assert.match(n.subtitle, /승인 대기/);
  assert.strictEqual(n.body, 'allow.txt');
  assert.deepStrictEqual(n.push, { data: { hostDeviceId: 7 } });
  assert.strictEqual(n.deeplink, `codingpt://conv/${id}?cwd=ws&host=7`);
  assert.ok(!notes.some((x) => x.kind === 'approval_request'));
});

test('승인 거부 — denied, 사유가 에이전트에 전달된다', async () => {
  const { id } = await start('write deny.txt');
  const { req } = await waitReq(id);
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'deny', message: '지금은 안 돼요' });
  await waitTurnEnd(id);
  assert.strictEqual(store.latestOf(id, 'req', req.id).req.status, 'denied');
  assert.ok(!fs.existsSync(path.join(WS, 'deny.txt')));
  const res = eventsOf(id).find((e) => e.op === 'msg' && e.msg.kind === 'tool_result');
  assert.strictEqual(res.msg.result.ok, false);
  assert.match(res.msg.text, /지금은 안 돼요/);
  assert.strictEqual(res.msg.key, 'r:' + req.toolUseId);
});

test('항상 허용 — 에이전트가 준 제안만 되돌리고, 바뀐 모드가 thread 에 반영된다', async () => {
  const { id } = await start('write always.txt');
  const { req } = await waitReq(id);
  // 클라가 보낸 규칙은 무시된다(원격에서 권한을 넓히는 통로가 되면 안 된다).
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow', always: true, updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] });
  await waitTurnEnd(id);
  assert.strictEqual(store.latestOf(id, 'req', req.id).req.always, true);
  assert.ok(eventsOf(id).some((e) => e.op === 'msg' && e.msg.text === '완료(항상 허용).'));
  assert.strictEqual(store.getThread(id).mode, 'acceptEdits');
  assert.ok(eventsOf(id).some((e) => e.op === 'state' && e.mode === 'acceptEdits'));
});

test('항상 허용 라벨 — addRules 제안은 규칙 내용을 보여 준다', async () => {
  const { id } = await start('rule npm test');
  const { req } = await waitReq(id);
  assert.strictEqual(req.tool, 'Bash');
  assert.strictEqual(req.summary, 'npm test');
  assert.strictEqual(req.alwaysLabel, 'npm test:*');
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'deny' });
  await waitTurnEnd(id);
  assert.match(eventsOf(id).find((e) => e.op === 'msg' && e.msg.kind === 'tool_result').msg.text, /사용자가 거부했습니다/);
});

test('질문 — answered, 고른 답이 질문 문구를 키로 전달된다', async () => {
  const { id } = await start('ask');
  const { req } = await waitReq(id);
  assert.strictEqual(req.kind, 'question');
  assert.strictEqual(req.questions[0].question, '좋아하는 색은 무엇인가요?');
  assert.ok(!req.alwaysLabel);
  await assert.rejects(rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'answer', answers: [] }), (e) => e.code === 'BAD_REQUEST');
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'answer', answers: [{ questionIndex: 0, labels: ['파랑'] }] });
  await waitTurnEnd(id);
  assert.strictEqual(store.latestOf(id, 'req', req.id).req.status, 'answered');
  assert.ok(eventsOf(id).some((e) => e.op === 'msg' && e.msg.text === '답: 파랑'));
  assert.match(notes.find((x) => x.kind === 'conv_request').subtitle, /답변 대기/);
  assert.deepStrictEqual(conv._internals.answersMap({ '질문?': '자유 답' }, {}), { '질문?': '자유 답' });
  assert.deepStrictEqual(conv._internals.answersMap({ '여럿?': ['가', '나'] }, {}), { '여럿?': '가, 나' }, '다중 선택은 문자열 하나로 잇는다');
});

test('허용하고 추가 지시 — 허용 뒤 메시지가 사용자 메시지로 이어진다', async () => {
  const { id } = await start('write note.txt');
  const { req } = await waitReq(id);
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow', message: 'say 이어서 이것도' });
  await waitTurnEnd(id, 2);
  const extra = store.latestOf(id, 'msg', 'u:r-' + req.id);
  assert.strictEqual(extra.msg.text, 'say 이어서 이것도');
  assert.strictEqual(extra.msg.status, 'sent');
  assert.ok(eventsOf(id).some((e) => e.op === 'msg' && e.msg.text === '이어서 이것도'));
});

// ── 중단·모드 ────────────────────────────────────────────────────────────────
test('중단 — 턴은 중단으로 끝나고 프로세스는 살아서 다음 메시지를 받는다', async () => {
  const { id } = await start('sleep 5000');
  await waitFor(() => eventsOf(id).some((e) => e.op === 'msg' && e.msg.kind === 'tool_use'), 3000, '도구 실행');
  assert.deepStrictEqual(await rpc('conv.interrupt', { threadId: id }), { ok: true, interrupted: true });
  await waitTurnEnd(id);
  const end = turnEnds(id)[0];
  assert.strictEqual(end.interrupted, true);
  assert.strictEqual(end.ok, false);
  assert.strictEqual(store.getThread(id).state, 'idle', '중단은 오류가 아니다');
  assert.ok(!eventsOf(id).some((e) => e.op === 'notice'));
  assert.ok(eventsOf(id).some((e) => e.op === 'msg' && e.msg.kind === 'interrupt' && e.msg.hidden));
  assert.ok(!notes.some((x) => x.kind === 'conv_done' || x.kind === 'conv_error'));
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 다시' });
  await waitTurnEnd(id, 2);
  assert.strictEqual(spawnsOf(id).length, 1);
  assert.deepStrictEqual(await rpc('conv.interrupt', { threadId: id }), { ok: true, interrupted: false });
});

test('중단 — 대기 중 요청은 canceled(interrupted) 로 닫힌다', async () => {
  const { id } = await start('write held.txt');
  const { req } = await waitReq(id);
  await rpc('conv.interrupt', { threadId: id });
  await waitTurnEnd(id);
  const last = store.latestOf(id, 'req', req.id).req;
  assert.strictEqual(last.status, 'canceled');
  assert.strictEqual(last.reason, 'interrupted');
  assert.strictEqual(store.getThread(id).pending, 0);
  assert.ok(!fs.existsSync(path.join(WS, 'held.txt')), '응답 없이 허용이 만들어지지 않는다');
  await assert.rejects(rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow' }), (e) => e.code === 'REQ_NOT_PENDING');
});

test('모드 변경 — 라이브면 에이전트에 적용하고, 없으면 다음 기동 인자가 된다', async () => {
  const { id } = await start('say 모드');
  await waitTurnEnd(id);
  const r = await rpc('conv.set', { threadId: id, mode: 'acceptEdits' });
  assert.strictEqual(r.thread.mode, 'acceptEdits');
  assert.ok(eventsOf(id).some((e) => e.op === 'state' && e.mode === 'acceptEdits'));
  await assert.rejects(rpc('conv.set', { threadId: id, mode: 'nope' }), (e) => e.code === 'BAD_REQUEST');
  await rpc('conv.stop', { threadId: id });
  await rpc('conv.set', { threadId: id, mode: 'plan', title: '  내가 붙인   제목 ' });
  const t = store.getThread(id);
  assert.strictEqual(t.title, '내가 붙인 제목');
  assert.strictEqual(t.titleSet, true);
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 다시' });
  await waitTurnEnd(id, 2);
  const sp = spawnsOf(id);
  assert.strictEqual(sp[1].argv[sp[1].argv.indexOf('--permission-mode') + 1], 'plan');
  assert.strictEqual(store.getThread(id).title, '내가 붙인 제목', '사용자가 붙인 제목은 자동으로 바뀌지 않는다');
});

// ── 프로세스 수명 ────────────────────────────────────────────────────────────
test('프로세스 급사 — 턴을 닫고, 오류를 남기고, 다음 입력에 --resume 으로 다시 뜬다', async () => {
  const { id } = await start('die');
  await waitFor(() => store.getThread(id).state === 'error', 4000, 'error 상태');
  const evs = eventsOf(id);
  const end = evs.find((e) => e.op === 'turn' && e.phase === 'end');
  assert.strictEqual(end.ok, false);
  assert.strictEqual(end.subtype, 'process_exit');
  const n = evs.find((e) => e.op === 'notice');
  assert.strictEqual(n.level, 'error');
  assert.strictEqual(n.code, 'PROCESS_EXIT');
  assert.match(n.text, /code=3/);
  assert.ok(!n.text.includes('sk-secret'), 'stderr 의 비밀은 가린다');
  assert.ok(evs.some((e) => e.op === 'state' && e.state === 'error'));
  assert.ok(notes.some((x) => x.kind === 'conv_error' && x.threadId === id));
  assert.strictEqual(conv._internals.live.size, 0);

  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 살아났습니다' });
  await waitTurnEnd(id, 2);
  const sp = spawnsOf(id);
  assert.strictEqual(sp.length, 2);
  assert.deepStrictEqual(sp[1].argv.slice(sp[1].argv.indexOf('--resume'), sp[1].argv.indexOf('--resume') + 2), ['--resume', id]);
  assert.strictEqual(store.getThread(id).state, 'idle');
});

test('프로세스 급사 — 대기 중 요청은 canceled(process_exit)', async () => {
  const { id } = await start('diereq');
  const { req } = await waitReq(id);
  await waitFor(() => store.getThread(id).state === 'error', 4000, 'error 상태');
  const last = store.latestOf(id, 'req', req.id).req;
  assert.deepStrictEqual([last.status, last.reason], ['canceled', 'process_exit']);
  assert.strictEqual(store.getThread(id).pending, 0);
  await assert.rejects(rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow' }), (e) => e.code === 'REQ_NOT_PENDING');
});

test('기동 직후 종료 — 보낸 메시지는 failed, 같은 clientId 로 다시 보내면 재전송된다', async () => {
  extraEnv = { FAKE_EXIT_AT_START: '1' };
  const clientId = cid();
  await assert.rejects(rpc('conv.create', { cwd: 'ws', text: 'say 첫 시도', clientId }), (e) => e.code === 'START_FAILED');
  const t = (await rpc('conv.list', { cwd: 'ws' })).threads.find((x) => x.title === 'say 첫 시도');
  assert.ok(t, '대화는 남는다');
  assert.strictEqual(store.latestOf(t.id, 'msg', 'u:' + clientId).msg.status, 'failed');
  assert.strictEqual(t.state, 'error');
  extraEnv = {};
  const r = await rpc('conv.send', { threadId: t.id, clientId, text: 'say 첫 시도' });
  assert.strictEqual(r.status, 'sent');
  await waitTurnEnd(t.id, 2);
  assert.strictEqual(store.latestOf(t.id, 'msg', 'u:' + clientId).msg.status, 'sent');
  const sp = spawnsOf(t.id);
  assert.ok(sp[1].argv.includes('--session-id'), '세션이 만들어진 적 없으면 새 세션으로 다시 연다');
});

test('실행 파일 없음 — START_FAILED', async () => {
  const keep = process.env.CODINGPT_CLAUDE_BIN;
  process.env.CODINGPT_CLAUDE_BIN = path.join(ROOT, 'no-such-bin');
  try {
    await assert.rejects(rpc('conv.create', { cwd: 'ws', text: 'say x', clientId: cid() }), (e) => e.code === 'START_FAILED');
  } finally { process.env.CODINGPT_CLAUDE_BIN = keep; }
  await waitFor(() => conv._internals.live.size === 0, 2000, '정리');
});

test('실패로 끝난 턴 — error 상태와 안내, 프로세스는 그대로', async () => {
  const { id } = await start('fail');
  await waitTurnEnd(id);
  assert.strictEqual(store.getThread(id).state, 'error');
  const n = eventsOf(id).find((e) => e.op === 'notice');
  assert.strictEqual(n.code, 'TURN_FAILED');
  assert.ok(conv._internals.live.has(id));
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 회복' });
  await waitTurnEnd(id, 2);
  assert.strictEqual(store.getThread(id).state, 'idle');
});

test('idle 회수 — 조용한 프로세스를 내리고, 다음 입력에 --resume 으로 다시 띄운다', async () => {
  setup({ idleMs: 40 });
  const { id } = await start('say 쉬는 중');
  await waitTurnEnd(id);
  conv._internals.sweep();
  assert.ok(conv._internals.live.has(id), '아직 idle 시간이 안 찼다');
  await sleep(60);
  conv._internals.sweep();
  await waitFor(() => store.getThread(id).state === 'stopped', 3000, 'stopped');
  assert.strictEqual(conv._internals.live.size, 0);
  assert.ok(!eventsOf(id).some((e) => e.op === 'notice'), '회수는 오류가 아니다');
  assert.ok(!notes.some((x) => x.kind === 'conv_error'));
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 돌아옴' });
  await waitTurnEnd(id, 2);
  const sp = spawnsOf(id);
  assert.strictEqual(sp.length, 2);
  assert.ok(sp[0].argv.includes('--session-id'));
  assert.ok(sp[1].argv.includes('--resume') && !sp[1].argv.includes('--session-id'));
  assert.notStrictEqual(sp[0].pid, sp[1].pid);
});

test('idle 회수 — 대기 중 요청이 있으면 내리지 않는다', async () => {
  setup({ idleMs: 20 });
  const { id } = await start('write keep.txt');
  const { req } = await waitReq(id);
  await sleep(50);
  conv._internals.sweep();
  await sleep(50);
  assert.ok(conv._internals.live.has(id));
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'deny' });
  await waitTurnEnd(id);
});

test('동시 상한 — 가장 오래 쉰 프로세스를 내리고, 전부 작업 중이면 TOO_MANY_LIVE', async () => {
  const ids = [];
  for (let i = 0; i < conv.MAX_LIVE; i++) {
    const { id } = await start(`say ${i}번`);
    await waitTurnEnd(id);
    ids.push(id);
    await sleep(5);
  }
  assert.strictEqual(conv._internals.live.size, conv.MAX_LIVE);
  const { id: fifth } = await start('say 다섯째');
  await waitTurnEnd(fifth);
  assert.ok(!conv._internals.live.has(ids[0]), '가장 오래 쉰 것이 내려간다');
  assert.ok(ids.slice(1).every((id) => conv._internals.live.has(id)));
  await waitFor(() => store.getThread(ids[0]).state === 'stopped', 3000, '축출된 대화 stopped');
  assert.strictEqual(conv._internals.live.size, conv.MAX_LIVE);
  // 전부 작업 중으로 만든다.
  for (const id of [...conv._internals.live.keys()]) await rpc('conv.send', { threadId: id, clientId: cid(), text: 'sleep 3000' });
  await assert.rejects(rpc('conv.create', { cwd: 'ws', text: 'say 자리 없음', clientId: cid() }), (e) => e.code === 'TOO_MANY_LIVE');
  assert.strictEqual(conv._internals.live.size, conv.MAX_LIVE);
  assert.strictEqual((await rpc('conv.caps')).maxLive, conv.MAX_LIVE);
});

test('종료 — 진행 중이던 턴을 중단으로 기록하고 프로세스를 내린다', async () => {
  const { id } = await start('sleep 5000');
  await waitFor(() => eventsOf(id).some((e) => e.op === 'msg' && e.msg.kind === 'tool_use'), 3000, '도구 실행');
  const pid = spawnsOf(id)[0].pid;
  await conv.shutdown({ graceMs: 200 });
  const last = store.open(id).events.filter((e) => e.op === 'turn').pop();
  assert.deepStrictEqual([last.phase, last.interrupted, last.subtype], ['end', true, 'daemon_shutdown']);
  assert.strictEqual(store.getThread(id).state, 'stopped');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 3000, '프로세스 종료');
  await waitFor(() => conv._internals.live.size === 0, 2000, '정리');
});

test('stdin 을 닫아도 안 끝나는 프로세스 — 유예 뒤 SIGTERM 으로 내린다', async () => {
  extraEnv = { FAKE_IGNORE_EOF: '1' };
  const { id } = await start('say 버티기');
  await waitTurnEnd(id);
  const pid = spawnsOf(id)[0].pid;
  const t0 = Date.now();
  await rpc('conv.stop', { threadId: id });
  assert.ok(Date.now() - t0 >= 250, '유예(stopGraceMs)를 준다');
  assert.throws(() => process.kill(pid, 0));
  assert.strictEqual(store.getThread(id).state, 'stopped');
});

// ── 재시작 복원 ──────────────────────────────────────────────────────────────
test('데몬 재시작 후 open — 디스크에서 같은 대화를 복원하고 state 는 stopped', async () => {
  const { id, clientId } = await start('say 기억해 주세요');
  await waitTurnEnd(id);
  const before = await rpc('conv.open', { threadId: id });
  await conv._internals._reset(); // 프로세스·메모리 전부 버린다 = 데몬이 새로 떴다
  setup();
  const after = await rpc('conv.open', { threadId: id });
  // 내려가면서 남긴 state(stopped) 한 줄을 빼면 같은 대화다.
  assert.deepStrictEqual(after.events.slice(0, before.events.length), before.events);
  assert.deepStrictEqual(after.events.slice(before.events.length).map((e) => [e.op, e.state]), [['state', 'stopped']]);
  assert.strictEqual(after.thread.state, 'stopped');
  assert.strictEqual(after.thread.title, before.thread.title);
  assert.deepStrictEqual(after.live, []);
  assert.deepStrictEqual(after.pending, []);
  // 멱등도 디스크 기준으로 유지된다.
  assert.deepStrictEqual(await rpc('conv.send', { threadId: id, clientId, text: 'say 기억해 주세요' }), { ok: true, status: 'sent', seq: before.events.find((e) => e.msg && e.msg.key === 'u:' + clientId).first });
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 이어서' });
  await waitFor(() => store.open(id).events.some((e) => e.op === 'turn' && e.phase === 'end' && e.turn === 2), 4000, '둘째 턴');
  assert.ok(spawnsOf(id)[1].argv.includes('--resume'));
  const s = await rpc('conv.since', { threadId: id, sinceSeq: before.headSeq });
  assert.strictEqual(s.events[0].seq, before.headSeq + 1);
});

test('비정상 종료 뒤 — 남은 열린 턴·대기 요청·미도달 메시지를 닫는다', async () => {
  const id = 'crashed-' + Date.now();
  store.putThread({ id, agent: 'claude', cwd: 'ws', title: 't', createdAt: 1, lastAt: Date.now(), state: 'working', owner: 'chat', mode: 'default', headSeq: 0, pending: 1, x: {} });
  store.appendMany(id, [
    { op: 'turn', phase: 'start', turn: 1 },
    { op: 'msg', msg: { key: 'u:lost', role: 'user', kind: 'text', text: 'hi', status: 'queued', turn: 1 } },
    { op: 'req', req: { id: 'req_x', kind: 'permission', tool: 'Bash', status: 'pending', turn: 1 } },
  ]);
  const snap = await rpc('conv.open', { threadId: id });
  const by = (f) => snap.events.find(f);
  assert.deepStrictEqual([by((e) => e.op === 'req').req.status, by((e) => e.op === 'req').req.reason], ['canceled', 'process_exit']);
  assert.strictEqual(by((e) => e.op === 'msg').msg.status, 'failed');
  const end = snap.events.filter((e) => e.op === 'turn').pop();
  assert.deepStrictEqual([end.phase, end.interrupted], ['end', true]);
  assert.strictEqual((await rpc('conv.open', { threadId: id })).headSeq, snap.headSeq, '한 번만 닫는다');
});

// ── 가져오기 ─────────────────────────────────────────────────────────────────
function sessionLines(sid, n0 = 0) {
  const ts = (i) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
  const base = (i) => ({ sessionId: sid, cwd: WS, isSidechain: false, timestamp: ts(n0 + i) });
  return [
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(n0), sessionId: sid },
    { type: 'user', uuid: `${sid}-u${n0}`, message: { role: 'user', content: [{ type: 'text', text: `터미널에서 한 말 ${n0}` }] }, ...base(1) },
    { type: 'attachment', uuid: `${sid}-a${n0}`, attachment: { type: 'x' }, ...base(2) },
    { type: 'assistant', uuid: `${sid}-t${n0}`, message: { id: `msg_imp${n0}`, role: 'assistant', model: 'm', content: [{ type: 'thinking', thinking: '', signature: 's' }] }, ...base(3) },
    { type: 'assistant', uuid: `${sid}-x${n0}`, message: { id: `msg_imp${n0}`, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `toolu_imp${n0}`, name: 'Bash', input: { command: 'ls' } }] }, ...base(4) },
    { type: 'user', uuid: `${sid}-r${n0}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_imp${n0}`, content: 'a.txt' }] }, toolUseResult: 'a.txt', ...base(5) },
    { type: 'assistant', uuid: `${sid}-y${n0}`, message: { id: `msg_imp${n0}b`, role: 'assistant', model: 'm', content: [{ type: 'text', text: `터미널의 답 ${n0}` }] }, ...base(6) },
    { type: 'last-prompt', lastPrompt: 'x', sessionId: sid },
  ];
}
function writeSession(sid, lines, { append } = {}) {
  const dir = transcript.projectDirOf(WS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sid + '.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  if (append) fs.appendFileSync(file, body); else fs.writeFileSync(file, body);
  return file;
}

test('가져오기 — 터미널에서 만든 대화를 열면 세션 파일이 로그가 되고, 다시 열어도 늘지 않는다', async () => {
  const sid = 'aaaa1111-0000-4000-8000-000000000001';
  writeSession(sid, sessionLines(sid));
  const listed = (await rpc('conv.list', { cwd: 'ws', includeExternal: true })).threads.find((t) => t.id === sid);
  assert.ok(listed);
  assert.strictEqual(listed.external, true);
  assert.strictEqual(listed.owner, 'none');
  assert.strictEqual(listed.title, '터미널에서 한 말 0');
  assert.strictEqual(store.getThread(sid), null, '목록에 보이는 것만으로는 들이지 않는다');

  const a = await rpc('conv.open', { threadId: sid, cwd: 'ws' });
  assert.deepStrictEqual(a.events.map((e) => [e.msg.role, e.msg.kind, e.msg.key]), [
    ['user', 'text', `u:${sid}-u0`],
    ['assistant', 'thinking', 'msg_imp0:0'],
    ['assistant', 'tool_use', 'toolu_imp0'],
    ['user', 'tool_result', 'r:toolu_imp0'],
    ['assistant', 'text', 'msg_imp0b:0'],
  ]);
  assert.strictEqual(a.events[0].msg.status, 'sent');
  assert.strictEqual(a.events[0].ts, Date.parse('2026-09-01T00:00:01.000Z'), '이벤트 시각은 원래 말한 때');
  assert.strictEqual(a.thread.external, false);
  assert.strictEqual(a.thread.title, '터미널에서 한 말 0');
  assert.strictEqual(a.thread.preview, '터미널의 답 0');
  assert.strictEqual(a.thread.state, 'stopped');
  assert.ok(!frames.some((f) => f.events && f.threadId === sid), '가져온 과거는 push 하지 않는다');

  const b = await rpc('conv.open', { threadId: sid });
  assert.strictEqual(b.headSeq, a.headSeq);
  const uuids = b.events.map((e) => e.uuid);
  assert.strictEqual(new Set(uuids).size, uuids.length, 'uuid 중복 없음');
});

test('가져오기 — 터미널에서 이어 간 부분만 덧붙인다(파일을 처음부터 다시 읽어도 중복 없음)', async () => {
  const sid = 'aaaa1111-0000-4000-8000-000000000002';
  writeSession(sid, sessionLines(sid, 0));
  const a = await rpc('conv.open', { threadId: sid, cwd: 'ws' });
  writeSession(sid, sessionLines(sid, 10), { append: true });
  const s = await rpc('conv.since', { threadId: sid, sinceSeq: a.headSeq });
  assert.strictEqual(s.events.length, 5);
  assert.strictEqual(s.events[0].seq, a.headSeq + 1);
  assert.strictEqual(s.events[0].msg.text, '터미널에서 한 말 10');
  // 오프셋 장부를 잃어도(처음부터 다시 읽어도) uuid 로 걸러진다.
  const t = store.getThread(sid);
  t.x = { started: true };
  const c = await rpc('conv.open', { threadId: sid });
  assert.strictEqual(c.headSeq, s.headSeq);
  const all = store.since(sid, 0).events.map((e) => e.uuid);
  assert.strictEqual(new Set(all).size, all.length);
});

test('가져오기 — 채팅으로 진행한 턴은 세션 파일에 있어도 다시 들이지 않는다', async () => {
  extraEnv = { FAKE_SESSION_DIR: transcript.projectDirOf(WS) };
  const { id } = await start('write imported.txt');
  const { req } = await waitReq(id);
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow' });
  await waitTurnEnd(id);
  const head = store.headSeq(id);
  assert.strictEqual((await rpc('conv.open', { threadId: id })).headSeq, head, '라이브 중에는 가져오지 않는다');
  await rpc('conv.stop', { threadId: id });
  await waitFor(() => !conv._internals.live.has(id) && store.getThread(id).state === 'stopped', 3000, 'stopped');
  const after = store.headSeq(id);
  const o = await rpc('conv.open', { threadId: id });
  assert.strictEqual(o.headSeq, after, '아는 uuid 뿐이라 늘지 않는다');
  // 터미널에서 이어 간 한 마디만 들어온다.
  writeSession(id, [{ type: 'user', uuid: 'term-1', sessionId: id, cwd: WS, timestamp: new Date().toISOString(), message: { role: 'user', content: '터미널에서 이어서' } }], { append: true });
  const s = await rpc('conv.since', { threadId: id, sinceSeq: after });
  assert.deepStrictEqual(s.events.map((e) => e.msg.text), ['터미널에서 이어서']);
  // 다음 기동은 이어받기다.
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 채팅으로 복귀' });
  await waitTurnEnd(id, 2);
  assert.ok(spawnsOf(id)[1].argv.includes('--resume'));
});

test('전문 보기 — 잘린 본문의 원본을 세션 파일에서 찾는다', async () => {
  extraEnv = { FAKE_SESSION_DIR: transcript.projectDirOf(WS) };
  const n = 70 * 1024;
  const { id } = await start(`big ${n}`);
  await waitTurnEnd(id);
  const m = eventsOf(id).find((e) => e.op === 'msg' && e.msg.role === 'assistant' && e.msg.kind === 'text');
  assert.strictEqual(m.msg.truncated, true);
  assert.strictEqual(m.msg.text.length, 64 * 1024);
  const d = await rpc('conv.detail', { threadId: id, key: m.msg.key });
  assert.strictEqual(d.text.length, n);
  await assert.rejects(rpc('conv.detail', { threadId: id, key: 'nope' }), (e) => e.code === 'BAD_REQUEST');
});

test('없는 대화 — 세션 파일도 없으면 THREAD_NOT_FOUND', async () => {
  await assert.rejects(rpc('conv.open', { threadId: 'aaaa1111-0000-4000-8000-00000000dead', cwd: 'ws' }), (e) => e.code === 'THREAD_NOT_FOUND');
  await assert.rejects(rpc('conv.open', { threadId: '../../etc/passwd', cwd: 'ws' }), (e) => e.code === 'THREAD_NOT_FOUND');
  await assert.rejects(rpc('conv.since', { threadId: 'nope', sinceSeq: 0 }), (e) => e.code === 'THREAD_NOT_FOUND');
});

// ── 소유권 ───────────────────────────────────────────────────────────────────
test('소유권 충돌 — 터미널이 쓰고 있는 세션에는 프로세스를 띄우지 않는다', async () => {
  const { id } = await start('say 채팅에서 시작');
  await waitTurnEnd(id);
  await rpc('conv.stop', { threadId: id });
  await waitFor(() => store.getThread(id).state === 'stopped', 3000, 'stopped');
  terminals.set(id, { cwdRel: 'ws', tid: 1234567, state: 'idle' });
  const before = spawnsOf(id).length;
  const head = store.headSeq(id);
  await assert.rejects(rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 끼어들기' }), (e) => e.code === 'THREAD_BUSY_IN_TERMINAL' && e.tid === 1234567);
  assert.strictEqual(spawnsOf(id).length, before);
  const t = (await rpc('conv.list', { cwd: 'ws' })).threads.find((x) => x.id === id);
  assert.deepStrictEqual([t.owner, t.ownerTid], ['terminal', 1234567]);
  assert.ok(store.since(id, head).events.every((e) => e.op === 'state'), '거절된 메시지는 대화에 남기지 않는다');
  // 터미널이 끝나면 다시 채팅이 가져갈 수 있다.
  terminals.delete(id);
  assert.strictEqual((await rpc('conv.open', { threadId: id })).thread.owner, 'none');
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'say 이제 가능' });
  await waitTurnEnd(id, 2);
  assert.strictEqual(store.getThread(id).owner, 'chat');
});

test('외부 대화 목록 — 터미널이 쓰는 세션은 owner:terminal 로 보인다', async () => {
  const sid = 'aaaa1111-0000-4000-8000-000000000003';
  writeSession(sid, sessionLines(sid));
  terminals.set(sid, { cwdRel: 'ws', tid: 42, state: 'working' });
  const t = (await rpc('conv.list', { cwd: 'ws', includeExternal: true })).threads.find((x) => x.id === sid);
  assert.deepStrictEqual([t.external, t.owner, t.ownerTid], [true, 'terminal', 42]);
  assert.ok(!(await rpc('conv.list', { cwd: 'ws' })).threads.some((x) => x.id === sid), '요청하지 않으면 외부 대화는 없다');
});

test('채팅 → 터미널 — 작업 중이면 거절, 아니면 프로세스를 내리고 이어 갈 명령을 준다', async () => {
  const { id } = await start('sleep 600');
  await waitFor(() => eventsOf(id).some((e) => e.op === 'turn'), 2000, '턴 시작');
  await assert.rejects(rpc('conv.toTerminal', { threadId: id }), (e) => e.code === 'THREAD_BUSY');
  await waitTurnEnd(id);
  const r = await rpc('conv.toTerminal', { threadId: id });
  assert.deepStrictEqual(r, { ok: true, cwd: 'ws', agent: 'claude', command: `claude --resume ${id}`, args: ['--resume', id] });
  assert.strictEqual(conv._internals.live.size, 0);
  assert.strictEqual(store.getThread(id).owner, 'none');
  assert.ok(eventsOf(id).some((e) => e.op === 'state' && e.owner === 'none'));
});

test('터미널 → 채팅 — TUI 를 끝내고 대화를 들인다', async () => {
  const sid = 'aaaa1111-0000-4000-8000-000000000004';
  writeSession(sid, sessionLines(sid));
  binds.set('ws|77', { sessionId: sid });
  termStates.set('ws|77', 'idle');
  const keys = [];
  let cmd = 'node';
  term = {
    sendKeys: async (name, spec) => { keys.push([name, spec]); if (spec.keys && spec.keys[0] === 'Enter') setTimeout(() => { cmd = 'zsh'; }, 60); },
    info: async () => ({ command: cmd }),
  };
  const r = await rpc('conv.adopt', { cwd: 'ws', tid: 77 });
  assert.strictEqual(r.thread.id, sid);
  assert.strictEqual(r.thread.owner, 'chat');
  assert.strictEqual(r.thread.external, false);
  assert.deepStrictEqual(keys.map(([n, s]) => [n, s.data || s.keys[0]]), [['cpt-ws--t-77', 'C-u'], ['cpt-ws--t-77', '/exit'], ['cpt-ws--t-77', 'Enter']]);
  assert.strictEqual(store.open(sid).events.filter((e) => e.op === 'msg').length, 5);
  assert.strictEqual(conv._internals.live.size, 0, '프로세스는 첫 입력에 뜬다');
});

test('터미널 → 채팅 — 작업 중·바인딩 없음·종료 실패는 거절하고 아무것도 바꾸지 않는다', async () => {
  const sid = 'aaaa1111-0000-4000-8000-000000000005';
  writeSession(sid, sessionLines(sid));
  term = { sendKeys: async () => {}, info: async () => ({ command: 'node' }) };
  await assert.rejects(rpc('conv.adopt', { cwd: 'ws', tid: 78 }), (e) => e.code === 'THREAD_NOT_FOUND');
  binds.set('ws|78', { sessionId: sid });
  for (const st of ['working', 'permission']) {
    termStates.set('ws|78', st);
    await assert.rejects(rpc('conv.adopt', { cwd: 'ws', tid: 78 }), (e) => e.code === 'THREAD_BUSY_IN_TERMINAL');
  }
  termStates.set('ws|78', 'idle');
  await assert.rejects(rpc('conv.adopt', { cwd: 'ws', tid: 78 }), (e) => e.code === 'ADOPT_FAILED');
  assert.strictEqual(store.getThread(sid), null);
  await assert.rejects(rpc('conv.adopt', { cwd: 'ws' }), (e) => e.code === 'BAD_REQUEST');
});

// ── 알림·게이팅·프레임 ───────────────────────────────────────────────────────
test('완료 알림 — 보는 기기가 없을 때만', async () => {
  const { id } = await start('say 보고 있음');
  await waitTurnEnd(id);
  await sleep(30);
  assert.ok(!notes.some((n) => n.kind === 'conv_done'), '방금 연 클라가 있다');
  setup({ viewerMs: 1 });
  await sleep(5);
  frames = [];
  // 턴이 "보는 기기" 창(1ms)보다 확실히 길어야 한다 — 데워진 프로세스는 1ms 안에 답하기도 한다.
  await conv.rpc('conv.send', { threadId: id, clientId: cid(), text: 'sleep 40' });
  await waitTurnEnd(id);
  const n = await waitFor(() => notes.find((x) => x.kind === 'conv_done'), 2000, '완료 알림');
  assert.strictEqual(n.threadId, id);
  assert.match(n.subtitle, /「ws」에서 완료/);
  assert.strictEqual(n.body, '기다림 끝.');
  assert.strictEqual(n.wsName, 'ws');
});

test('push 프레임 — 허용된 필드만 싣는다', async () => {
  const { id } = await start('write frame.txt');
  const { req } = await waitReq(id);
  await rpc('conv.respond', { threadId: id, reqId: req.id, decision: 'allow' });
  await waitTurnEnd(id);
  await rpc('conv.remove', { threadId: id });
  await sleep(20);
  const ok = new Set(['type', 'threadId', 'headSeq', 'events', 'delta', 'thread', 'control']);
  assert.ok(frames.length > 5);
  for (const f of frames) {
    assert.strictEqual(f.type, 'conv_event');
    for (const k of Object.keys(f)) assert.ok(ok.has(k), `허용되지 않은 필드: ${k}`);
  }
  assert.ok(frames.some((f) => f.thread && f.thread.id === id && !('x' in f.thread)));
  assert.deepStrictEqual(frames[frames.length - 1], { type: 'conv_event', control: { kind: 'deleted', threadId: id } });
  assert.strictEqual(store.getThread(id), null);
  await assert.rejects(rpc('conv.open', { threadId: id, cwd: 'ws' }), (e) => e.code === 'THREAD_NOT_FOUND');
});

test('서브에이전트 메시지 — parent 를 싣는다', async () => {
  const { id } = await start('sub');
  await waitTurnEnd(id);
  const sub = eventsOf(id).find((e) => e.op === 'msg' && e.msg.parent);
  assert.match(sub.msg.parent, /^toolu_fake/);
  assert.strictEqual(sub.msg.text, '서브에이전트의 말');
  assert.strictEqual(store.getThread(id).preview, '정리했습니다.', '미리보기는 메인 세션의 말');
});

test('게이팅 — 서버가 conv.v1 을 선언하지 않았거나 설정으로 꺼지면 CONV_DISABLED', async () => {
  serverCaps = ['caps.v1', 'task.v1'];
  await assert.rejects(rpc('conv.caps'), (e) => e.code === 'CONV_DISABLED');
  serverCaps = ['caps.v1', 'conv.v1'];
  const caps = await rpc('conv.caps');
  assert.strictEqual(caps.enabled, true);
  assert.deepStrictEqual(caps.agents.map((a) => [a.id, a.label, a.available]), [['claude', 'Claude', true]]);
  assert.ok(caps.modes.includes('plan'));
  serverCaps = []; // 선언 자체가 없다(연결 전·구 서버) — 판정하지 않는다
  assert.strictEqual((await rpc('conv.caps')).enabled, true);
  cfg = { conv: { enabled: false } };
  assert.strictEqual(conv.handle, undefined, '꺼지면 cap 을 광고하지 않는다');
  await assert.rejects(rpc('conv.caps'), (e) => e.code === 'CONV_DISABLED');
  cfg = {};
  process.env.CPT_CONV = '0';
  try { assert.strictEqual(conv.handle, undefined); } finally { delete process.env.CPT_CONV; }
  assert.strictEqual(typeof conv.handle, 'function');
});

test('직접 호출자의 sink — handle 에 넘긴 ws 로 push 를 받고, 끊기면 놓는다', async () => {
  conv.configure({ send: null });
  const got = [];
  const ws = { readyState: 1, send(s) { got.push(JSON.parse(s)); } };
  const r = await conv.handle('conv.create', { cwd: 'ws', text: 'say 직접', clientId: cid() }, ws);
  const id = r.thread.id;
  await waitFor(() => got.some((f) => f.events && f.events.some((e) => e.op === 'turn' && e.phase === 'end')), 4000, '턴 종료 프레임');
  assert.ok(got.some((f) => f.delta));
  assert.ok(got.every((f) => f.type === 'conv_event'));
  conv.detachAll();
  const n = got.length;
  await conv.handle('conv.send', { threadId: id, clientId: cid(), text: 'say 둘째' });
  await waitFor(() => store.open(id).events.some((e) => e.op === 'turn' && e.phase === 'end' && e.turn === 2), 4000, '둘째 턴');
  assert.strictEqual(got.length, n, '놓은 뒤에는 보내지 않는다(프로세스는 계속 돈다)');
});

// ── control.js 배선 ──────────────────────────────────────────────────────────
test('control 배선 — conv.* 디스패치·cap 광고·서버 킬스위치·끊김 시 push 대상 해제', async () => {
  const control = require('../control');
  const sink = { readyState: 1, send() {} };
  const via = (m, p) => new Promise((res, rej) => control.dispatchRpc(sink, m, p, res, rej));
  assert.ok(control.daemonCaps().includes('conv.v1'));
  try {
    conv.configure({ serverCaps: () => control.serverCaps() });
    const caps = await via('conv.caps', {});
    assert.strictEqual(caps.maxLive, conv.MAX_LIVE);
    await assert.rejects(via('conv.open', { threadId: 'nope' }), (e) => e.code === 'THREAD_NOT_FOUND', '오류는 code 를 단다');
    // 서버가 능력을 선언했는데 conv.v1 이 없다 = 서버 킬스위치(봉투 RPC 로 들어와도 닫힌다).
    control._setServerCaps(['task.v1']);
    await assert.rejects(via('conv.caps', {}), (e) => e.code === 'CONV_DISABLED');
    control._setServerCaps(['conv.v1']);
    assert.strictEqual((await via('conv.caps', {})).enabled, true);
    // 데몬 킬스위치 — cap 을 광고하지 않고, 들어온 호출도 같은 code 로 거절한다.
    process.env.CPT_CONV = '0';
    assert.ok(!control.daemonCaps().includes('conv.v1'));
    await assert.rejects(via('conv.caps', {}), (e) => e.code === 'CONV_DISABLED');
  } finally {
    delete process.env.CPT_CONV;
    control._setServerCaps([]);
  }
  assert.strictEqual(control.isActiveWs(sink), false);
  assert.strictEqual(control.isActiveWs(null), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');
  const i = src.indexOf("ws.on('close'");
  const block = src.slice(i, src.indexOf("ws.on('error'", i));
  assert.match(block, /tryRequire\('\.\/conv'\)[^\n]*detachAll\(\)/, '제어 WS 가 끊기면 push 대상을 놓아야 한다');
  assert.match(src, /tryRequire\('\.\/conv'\)[^\n]*c\.start\(\)/, '기동 시 conv.start()(정리·회수 타이머·종료 훅)');
});

test('종료 훅 — process exit 경로에서도 장부를 닫고 프로세스에 신호를 보낸다', async () => {
  const { id } = await start('sleep 5000');
  await waitFor(() => eventsOf(id).some((e) => e.op === 'msg' && e.msg.kind === 'tool_use'), 3000, '도구 실행');
  const pid = spawnsOf(id)[0].pid;
  conv.shutdownSync(); // process.on('exit') 가 부르는 동기 경로
  const last = store.open(id).events.filter((e) => e.op === 'turn').pop();
  assert.deepStrictEqual([last.phase, last.interrupted], ['end', true]);
  const idx = JSON.parse(fs.readFileSync(path.join(STATE, 'conv', 'index.json'), 'utf8'));
  assert.strictEqual(idx.threads[id].state, 'stopped', '색인도 그 자리에서 쓴다');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } }, 3000, '프로세스 종료');
  await waitFor(() => conv._internals.live.size === 0, 2000, '정리');
  assert.strictEqual(store.open(id).events.filter((e) => e.op === 'turn' && e.phase === 'end').length, 1, '턴 종료는 한 번만 적힌다');
});
