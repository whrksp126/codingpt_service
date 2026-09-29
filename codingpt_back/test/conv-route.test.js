// 채팅 v2(conv.*) 서버 배관 — `POST /api/daemon/conv` + conv_event 팬아웃 + 알림 threadId — node --test.
//
// 정본 계약 = codingpt_daemon/docs/chat-v2-design.md §3 / §4 / §7 / §8.
//  (1) 허용 표가 설계 §4 표·§8 타임아웃과 한 글자도 다르지 않다,
//  (2) 미허용 → 400, 데몬에 안 간다,
//  (3) 킬스위치(conv.v1 회수) → 403 {code:'CONV_DISABLED'} + conv_event 도 중계하지 않는다,
//  (4) hostDeviceId → 그 PC(runnerId), params 는 그대로,
//  (5) 데몬 오류 code 전달 · code 없으면 CONV_ERROR · 릴레이 타임아웃 → TIMEOUT · 미연결 → 409 DAEMON_OFFLINE,
//  (6) conv_event 화이트리스트(모르는 필드 제거) · SSE 폴백 · 리플레이 버퍼/알림에 들어가지 않는다,
//  (7) 알림 threadId — 컬럼 무추가 저장(session_id 'conv:' 접두) ↔ API JSON · FCM data · 딥링크.
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');

const relay = require('../services/daemonRelayService');
const daemonController = require('../controllers/daemonController');
const daemonRoutes = require('../routes/daemonRoutes');
const notificationService = require('../services/notificationService');
const pushService = require('../services/pushService');
const { Notification, DaemonDevice } = require('../models');
const { SERVER_CAPS, computeServerCaps } = require('../config/caps');

// 설계 §4 의 메서드 표 + §8 의 타임아웃(복사본 — 서버 표가 바뀌면 여기서 깨져야 한다. 바꾸려면 설계 문서 먼저).
const DESIGN_TABLE = [
  ['conv.caps', 15000], ['conv.list', 15000], ['conv.create', 30000], ['conv.open', 30000], ['conv.since', 15000],
  ['conv.before', 15000], ['conv.send', 30000], ['conv.respond', 15000], ['conv.interrupt', 15000], ['conv.set', 15000],
  ['conv.stop', 15000], ['conv.remove', 15000], ['conv.detail', 15000], ['conv.commands', 15000],
  ['conv.toTerminal', 30000], ['conv.adopt', 30000],
];
// 설계 §4 오류 코드(§6.1 의 THREAD_BUSY 포함).
const DESIGN_CODES = ['CONV_DISABLED', 'AGENT_UNAVAILABLE', 'AGENT_NOT_LOGGED_IN', 'THREAD_NOT_FOUND',
  'THREAD_BUSY_IN_TERMINAL', 'THREAD_BUSY', 'REQ_NOT_PENDING', 'TOO_MANY_LIVE', 'BAD_REQUEST', 'START_FAILED'];

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callConv(body, impl, query = {}) {
  const orig = relay.callRpc;
  const calls = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => {
    calls.push({ uid, method, params, timeoutMs, opts });
    return impl ? impl({ uid, method, params, timeoutMs, opts }) : { ok: true };
  };
  const res = fakeRes();
  try {
    await daemonController.convRpc({ user: { id: 7 }, body, query }, res);
  } finally { relay.callRpc = orig; }
  return { res, calls };
}
function withoutCap(cap, fn) {
  const idx = SERVER_CAPS.indexOf(cap);
  assert.ok(idx >= 0, `이 커밋의 서버는 ${cap} 을 선언한다`);
  SERVER_CAPS.splice(idx, 1);
  return Promise.resolve().then(fn).finally(() => { SERVER_CAPS.splice(idx, 0, cap); });
}

// ── 제어 WS / UI 구독자 픽스처(relay-busy.test.js 와 같은 방식) ──
let userSeq = 990100;
function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (s) => ws.sent.push(JSON.parse(s));
  ws.ping = () => {};
  ws.terminate = () => ws.emit('close');
  ws.close = () => ws.emit('close');
  return ws;
}
function uiClient(userId) {
  const frames = [];
  const ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)) };
  const key = String(userId);
  if (!relay._agentWsClients.has(key)) relay._agentWsClients.set(key, new Set());
  relay._agentWsClients.get(key).add(ws);
  return { frames, conv: () => frames.filter((f) => f.type === 'conv_event') };
}
function sseClient(userId) {
  const lines = [];
  const res = { write: (s) => lines.push(s) };
  relay.addEventClient(userId, res);
  return { res, events: () => lines.filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'conv_event') };
}
async function withControl(fn, deviceId = 41) {
  const uid = userSeq++;
  const origUpdate = DaemonDevice.update;
  const origCreate = notificationService.createNotification;
  const created = [];
  DaemonDevice.update = async () => [1];
  notificationService.createNotification = async (u, payload) => { created.push({ u, payload }); return { id: 1 }; };
  const ui = uiClient(uid);
  const sse = sseClient(uid);
  const ws = fakeWs();
  relay._registerControl(ws, { id: deviceId, user_id: uid, device_name: 'MacBook', runner_kind: 'local', platform: 'darwin' });
  const frame = (obj) => ws.emit('message', Buffer.from(JSON.stringify(obj)), false);
  try {
    await fn({ uid, ui, sse, ws, frame, created });
  } finally {
    ws.emit('close');
    relay.removeEventClient(uid, sse.res);
    relay._agentWsClients.delete(String(uid));
    relay._agentBuf.delete(String(uid));
    DaemonDevice.update = origUpdate;
    notificationService.createNotification = origCreate;
  }
}

// ── (1)~(5) REST ──────────────────────────────────────────────────────

test('허용 표 = 설계 §4 표 + §8 타임아웃(메서드 집합·순서·값 전부)', () => {
  assert.deepStrictEqual([...daemonController._CONV_RPC_OK.entries()], DESIGN_TABLE);
  const slow = DESIGN_TABLE.filter(([, ms]) => ms === 30000).map(([m]) => m).sort();
  assert.deepStrictEqual(slow, ['conv.adopt', 'conv.create', 'conv.open', 'conv.send', 'conv.toTerminal']);
  assert.ok(DESIGN_TABLE.every(([, ms]) => ms === 15000 || ms === 30000));
});

test('허용 메서드는 표의 타임아웃으로 그 PC 까지 가고 params 는 그대로', async () => {
  for (const [method, ms] of DESIGN_TABLE) {
    const params = { threadId: 't-1', text: '본문', attachments: [{ path: '/a' }], nested: { x: [1] } };
    const { res, calls } = await callConv({ method, params, hostDeviceId: 12 }, () => ({ echoed: method }));
    assert.strictEqual(res.statusCode, 200, method);
    assert.deepStrictEqual(res.body, { echoed: method });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].uid, 7);
    assert.strictEqual(calls[0].method, method);
    assert.strictEqual(calls[0].timeoutMs, ms, `${method} 타임아웃`);
    assert.deepStrictEqual(calls[0].params, params);
    assert.deepStrictEqual(calls[0].opts, { runnerId: 12 });
  }
});

test('hostDeviceId: 문자열 숫자·쿼리도 받고, 없으면 활성 러너(opts 미지정)', async () => {
  let r = await callConv({ method: 'conv.list', params: {}, hostDeviceId: '33' });
  assert.deepStrictEqual(r.calls[0].opts, { runnerId: 33 });
  r = await callConv({ method: 'conv.list', params: {} }, null, { hostDeviceId: '9' });
  assert.deepStrictEqual(r.calls[0].opts, { runnerId: 9 });
  r = await callConv({ method: 'conv.list', params: {} });
  assert.strictEqual(r.calls[0].opts, undefined);
  r = await callConv({ method: 'conv.list', params: {}, hostDeviceId: 'abc' });
  assert.strictEqual(r.calls[0].opts, undefined);
});

test('params 가 객체가 아니면 {} 로 간다(배열·문자열·누락)', async () => {
  for (const params of [undefined, null, 'x', 3, ['a']]) {
    const { res, calls } = await callConv({ method: 'conv.caps', params });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls[0].params, {});
  }
});

test('미허용 메서드 → 400, 데몬에 가지 않는다', async () => {
  for (const method of ['', 'conv', 'conv.unknown', 'conv.import', 'chat.open', 'agent.start', 'fs.read', 'terminal.new',
    'CONV.LIST', 'conv.list ', ' conv.list', 'conv.totrminal', 'sealed', undefined, null, 5]) {
    const { res, calls } = await callConv({ method, params: {} });
    assert.strictEqual(res.statusCode, 400, String(method));
    assert.strictEqual(res.body.message, '허용되지 않은 명령입니다.');
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(calls.length, 0, String(method));
  }
  const { res, calls } = await callConv(undefined);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.length, 0);
});

test('킬스위치: conv.v1 이 빠지면 모든 메서드 403 CONV_DISABLED, 다른 기능은 그대로', async () => {
  await withoutCap('conv.v1', async () => {
    for (const [method] of DESIGN_TABLE) {
      const { res, calls } = await callConv({ method, params: {} });
      assert.strictEqual(res.statusCode, 403, method);
      assert.deepStrictEqual(res.body.detail, { code: 'CONV_DISABLED' });
      assert.strictEqual(calls.length, 0, method);
    }
    // 꺼져 있어도 미허용 메서드는 400(허용 표가 먼저 — autoRpc 와 같은 순서).
    const bad = await callConv({ method: 'conv.nope', params: {} });
    assert.strictEqual(bad.res.statusCode, 400);
    // 채팅 v1(transcript)·자동화는 영향 없음.
    assert.ok(SERVER_CAPS.includes('transcript.v1'));
    const orig = relay.callRpc;
    relay.callRpc = async () => ({ items: [] });
    try {
      const res = fakeRes();
      await daemonController.autoRpc({ user: { id: 7 }, body: { method: 'auto.list', params: {} }, query: {} }, res);
      assert.strictEqual(res.statusCode, 200);
    } finally { relay.callRpc = orig; }
  });
  const back = await callConv({ method: 'conv.list', params: {} });
  assert.strictEqual(back.res.statusCode, 200, '복구 후 통과');
});

test('caps: conv.v1 기본 선언, CONV_ENABLED 는 자기 능력만 회수', () => {
  assert.ok(SERVER_CAPS.includes('conv.v1'));
  assert.ok(computeServerCaps({}).includes('conv.v1'));
  assert.ok(computeServerCaps({ CONV_ENABLED: '1' }).includes('conv.v1'));
  assert.ok(computeServerCaps({ CONV_ENABLED: '' }).includes('conv.v1'));
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    const caps = computeServerCaps({ CONV_ENABLED: v });
    assert.ok(!caps.includes('conv.v1'), `CONV_ENABLED=${v}`);
    for (const other of ['caps.v1', 'transcript.v1', 'approval.v1', 'task.v1', 'auto.v1']) assert.ok(caps.includes(other), other);
  }
  // 채팅 v1 을 꺼도 v2 는 남는다(별개 능력).
  assert.ok(computeServerCaps({ TRANSCRIPT_ENABLED: '0' }).includes('conv.v1'));
  // 선언했으면 처리 코드가 반드시 있어야 한다.
  assert.strictEqual(typeof daemonController.convRpc, 'function');
  assert.strictEqual(typeof relay.fanoutConvEvent, 'function');
});

test('오류: 데몬 code 전달 · code 없으면 CONV_ERROR · 릴레이 타임아웃 → TIMEOUT · 미연결 → 409 DAEMON_OFFLINE', async () => {
  for (const code of DESIGN_CODES) {
    const r = await callConv({ method: 'conv.send', params: {} }, () => { throw Object.assign(new Error('원문'), { code }); });
    assert.strictEqual(r.res.statusCode, 500, code);
    assert.deepStrictEqual(r.res.body.detail, { code });
    assert.strictEqual(r.res.body.message, '원문');
    assert.strictEqual(r.res.body.success, false);
  }
  let r = await callConv({ method: 'conv.open', params: {} }, () => { throw new Error('RPC 실패'); });
  assert.strictEqual(r.res.statusCode, 500);
  assert.deepStrictEqual(r.res.body.detail, { code: 'CONV_ERROR' });
  r = await callConv({ method: 'conv.open', params: {} }, () => { throw new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'); });
  assert.deepStrictEqual(r.res.body.detail, { code: 'TIMEOUT' });
  r = await callConv({ method: 'conv.list', params: {} }, () => { throw new Error('DAEMON_OFFLINE'); });
  assert.strictEqual(r.res.statusCode, 409);
  assert.deepStrictEqual(r.res.body.detail, { code: 'DAEMON_OFFLINE' });
  assert.strictEqual(r.res.body.message, 'PC 데몬이 연결되어 있지 않습니다.');
  // Error 가 아닌 값이 던져져도 죽지 않는다.
  r = await callConv({ method: 'conv.list', params: {} }, () => { throw 'boom'; }); // eslint-disable-line no-throw-literal
  assert.strictEqual(r.res.statusCode, 500);
  assert.deepStrictEqual(r.res.body.detail, { code: 'CONV_ERROR' });
});

test('실제 릴레이: rpc_result 의 code 가 클라까지 간다 + 그 PC 로만 간다', async () => {
  const uid = userSeq++;
  const origUpdate = DaemonDevice.update;
  DaemonDevice.update = async () => [1];
  const a = fakeWs();
  const b = fakeWs();
  relay._registerControl(a, { id: 51, user_id: uid, device_name: 'A', runner_kind: 'local', platform: 'darwin' });
  relay._registerControl(b, { id: 52, user_id: uid, device_name: 'B', runner_kind: 'local', platform: 'darwin' });
  const rpcOf = (ws) => ws.sent.filter((f) => f.type === 'rpc');
  try {
    const res = fakeRes();
    const p = daemonController.convRpc({ user: { id: uid }, body: { method: 'conv.respond', params: { threadId: 't', reqId: 'req_1', decision: 'allow' }, hostDeviceId: 52 }, query: {} }, res);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(rpcOf(a).length, 0, '지정하지 않은 PC 로는 가지 않는다');
    assert.strictEqual(rpcOf(b).length, 1);
    const sent = rpcOf(b)[0];
    assert.strictEqual(sent.method, 'conv.respond');
    assert.deepStrictEqual(sent.params, { threadId: 't', reqId: 'req_1', decision: 'allow' });
    b.emit('message', Buffer.from(JSON.stringify({ type: 'rpc_result', id: sent.id, ok: false, error: '이미 닫힌 요청입니다.', code: 'REQ_NOT_PENDING' })), false);
    await p;
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body.detail, { code: 'REQ_NOT_PENDING' });
    assert.strictEqual(res.body.message, '이미 닫힌 요청입니다.');

    // 큰 응답(conv.open 이벤트 200개 ≈ 1MB)도 그대로 통과한다 — back 은 크기를 자르지 않는다.
    const res2 = fakeRes();
    const p2 = daemonController.convRpc({ user: { id: uid }, body: { method: 'conv.open', params: { threadId: 't' }, hostDeviceId: 52 }, query: {} }, res2);
    await new Promise((r) => setImmediate(r));
    const sent2 = rpcOf(b)[1];
    const events = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, ts: 1, op: 'msg', msg: { key: 'k' + i, text: 'x'.repeat(5000) } }));
    b.emit('message', Buffer.from(JSON.stringify({ type: 'rpc_result', id: sent2.id, ok: true, result: { thread: { id: 't' }, events, headSeq: 200, floorSeq: 1, live: null, pending: [] } })), false);
    await p2;
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.events.length, 200);
    assert.strictEqual(res2.body.events[199].msg.text.length, 5000);
  } finally {
    a.emit('close'); b.emit('close');
    DaemonDevice.update = origUpdate;
  }
});

test('라우트 배선: POST /api/daemon/conv (JWT 통과·무인증 401·미허용 400)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/daemon', daemonRoutes);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origRpc = relay.callRpc;
  const seen = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => { seen.push({ uid, method, timeoutMs, opts }); return { threads: [] }; };
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/daemon/conv`;
    const token = jwt.sign({ id: 4003 }, process.env.ACCESS_SECRET, { algorithm: 'HS256' });
    const post = (auth, body) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body) });
    let r = await post(token, { method: 'conv.list', params: { cwd: 'proj' }, hostDeviceId: 12 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { threads: [] });
    assert.deepStrictEqual(seen, [{ uid: 4003, method: 'conv.list', timeoutMs: 15000, opts: { runnerId: 12 } }]);
    r = await post(null, { method: 'conv.list', params: {} });
    assert.strictEqual(r.status, 401);
    r = await post(token, { method: 'chat.open', params: {} });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(seen.length, 1);
  } finally {
    relay.callRpc = origRpc;
    await new Promise((r) => server.close(r));
  }
});

// ── (6) conv_event 팬아웃 ──────────────────────────────────────────────

test('conv_event 화이트리스트: 6개 필드만 통과, 모르는 필드는 제거, hostDeviceId 는 서버가 붙인다', () => {
  const conn = { deviceId: 77 };
  const p = relay._convEventPayload(conn, {
    type: 'conv_event', threadId: 't-1', headSeq: 9, events: [{ seq: 9, op: 'msg', msg: { key: 'a', text: 'hi' } }],
    delta: { key: 'a', kind: 'text', off: 0, text: 'h' }, thread: { id: 't-1', state: 'working' }, control: { kind: 'gone', threadId: 't-1' },
    // 아래는 전부 버려져야 한다.
    requestId: 'agent-internal', env: 'secret', pid: 123, hostDeviceId: 1, userId: 999, rseq: 4, sessionFile: '/Users/x/.claude/y.jsonl', __proto__x: 1,
  });
  assert.deepStrictEqual(Object.keys(p).sort(), ['control', 'delta', 'events', 'headSeq', 'hostDeviceId', 'thread', 'threadId', 'type']);
  assert.strictEqual(p.type, 'conv_event');
  assert.strictEqual(p.hostDeviceId, 77, '데몬이 주장한 hostDeviceId 가 아니라 실제 커넥션');
  assert.deepStrictEqual(p.events, [{ seq: 9, op: 'msg', msg: { key: 'a', text: 'hi' } }], '내용은 해석·재작성하지 않는다');
  // 없는 필드는 키 자체가 없다(델타 프레임이 headSeq:undefined 같은 잡음을 달지 않는다).
  assert.deepStrictEqual(relay._convEventPayload(conn, { type: 'conv_event', threadId: 't', delta: { key: 'a', kind: 'text', off: 3, text: 'x' } }),
    { type: 'conv_event', threadId: 't', delta: { key: 'a', kind: 'text', off: 3, text: 'x' }, hostDeviceId: 77 });
  // threadId 없는 control 프레임(설계 §3 4번째 형태).
  assert.deepStrictEqual(relay._convEventPayload(conn, { type: 'conv_event', control: { kind: 'deleted', threadId: 't' } }),
    { type: 'conv_event', control: { kind: 'deleted', threadId: 't' }, hostDeviceId: 77 });
  // type 을 속여도 conv_event 로 고정.
  assert.strictEqual(relay._convEventPayload(conn, { type: 'notif_event', threadId: 't' }).type, 'conv_event');
});

test('제어 WS conv_event → WSS + SSE 라이브 중계, 버퍼·알림에는 들어가지 않는다', async () => {
  await withControl(async ({ uid, ui, sse, frame, created }) => {
    const before = relay._agentBuf.get(String(uid));
    const beforeLen = before ? before.items.length : 0;
    frame({ type: 'conv_event', threadId: 't-1', headSeq: 2, events: [{ seq: 1, ts: 1, op: 'turn', phase: 'start', turn: 1 }, { seq: 2, ts: 2, op: 'req', req: { id: 'req_1', kind: 'permission', status: 'pending' } }], junk: 'x' });
    for (let i = 0; i < 50; i += 1) frame({ type: 'conv_event', threadId: 't-1', delta: { key: 'm:0', kind: 'text', off: i, text: 'a' } });
    frame({ type: 'conv_event', threadId: 't-1', thread: { id: 't-1', state: 'waiting', pending: 1 } });
    frame({ type: 'conv_event', control: { kind: 'gone', threadId: 't-1' } });
    await new Promise((r) => setImmediate(r));

    const got = ui.conv();
    assert.strictEqual(got.length, 53);
    assert.deepStrictEqual(got[0], { type: 'conv_event', threadId: 't-1', headSeq: 2,
      events: [{ seq: 1, ts: 1, op: 'turn', phase: 'start', turn: 1 }, { seq: 2, ts: 2, op: 'req', req: { id: 'req_1', kind: 'permission', status: 'pending' } }],
      hostDeviceId: 41 });
    assert.ok(!('junk' in got[0]));
    assert.deepStrictEqual(got.slice(1, 51).map((f) => f.delta.off), Array.from({ length: 50 }, (_, i) => i), '순서 보존');
    assert.deepStrictEqual(got[52], { type: 'conv_event', control: { kind: 'gone', threadId: 't-1' }, hostDeviceId: 41 });
    assert.ok(got.every((f) => !('rseq' in f)), '리플레이 순번을 받지 않는다 = 버퍼 경로가 아니다');
    // SSE 폴백도 같은 프레임.
    assert.deepStrictEqual(sse.events(), got);
    // 리플레이 버퍼 불변 + 알림 0건(req 이벤트가 와도 back 은 알림을 만들지 않는다 — 데몬이 따로 만든다).
    const after = relay._agentBuf.get(String(uid));
    assert.strictEqual(after ? after.items.length : 0, beforeLen);
    assert.strictEqual(created.length, 0);
  });
});

test('데몬이 conv.v1 을 신고하지 않아도 중계한다(conn.caps 하드 게이트 없음), 서버 킬스위치면 버린다', async () => {
  await withControl(async ({ ui, frame }) => {
    // hello 없이(= caps []) 온 프레임 — chat_event/agent_state/runner_busy 와 같은 관례로 통과.
    frame({ type: 'conv_event', threadId: 't', delta: { key: 'k', kind: 'text', off: 0, text: 'a' } });
    assert.strictEqual(ui.conv().length, 1);
    frame({ type: 'hello', caps: ['transcript.v1'] });
    frame({ type: 'conv_event', threadId: 't', delta: { key: 'k', kind: 'text', off: 1, text: 'b' } });
    assert.strictEqual(ui.conv().length, 2);
    await withoutCap('conv.v1', async () => {
      frame({ type: 'conv_event', threadId: 't', delta: { key: 'k', kind: 'text', off: 2, text: 'c' } });
      assert.strictEqual(ui.conv().length, 2, 'CONV_ENABLED=0 이면 중계하지 않는다');
    });
    frame({ type: 'conv_event', threadId: 't', delta: { key: 'k', kind: 'text', off: 2, text: 'c' } });
    assert.strictEqual(ui.conv().length, 3);
  });
});

test('다른 사용자에게는 가지 않는다', async () => {
  await withControl(async ({ frame, ui }) => {
    const other = uiClient(userSeq++);
    frame({ type: 'conv_event', threadId: 't', thread: { id: 't', title: '비밀' } });
    assert.strictEqual(ui.conv().length, 1);
    assert.strictEqual(other.frames.length, 0);
  });
});

// ── (7) 알림 threadId ─────────────────────────────────────────────────

async function createWith(payload, present = null) {
  const saved = {
    create: Notification.create, send: pushService.sendToUser,
    present: relay.presentClient, fan: relay.fanoutNotifEvent,
  };
  const seen = { rows: [], pushes: [], fans: [] };
  Notification.create = async (row) => { seen.rows.push(row); return { id: '501', created_at: new Date(0), read_at: null, ...row }; };
  pushService.sendToUser = async (userId, p, o) => { seen.pushes.push({ userId, p, o }); return { sent: 1, skipped: 0 }; };
  relay.presentClient = () => present;
  relay.fanoutNotifEvent = (userId, ev) => { seen.fans.push(ev); };
  try {
    const notification = await notificationService.createNotification(7, payload);
    await new Promise((r) => setImmediate(r));
    return { notification, ...seen };
  } finally {
    Notification.create = saved.create; pushService.sendToUser = saved.send;
    relay.presentClient = saved.present; relay.fanoutNotifEvent = saved.fan;
  }
}
const THREAD = '3f2b8c1e-6a4d-4e0b-9c77-0d5a1b2c3d4e';

test('알림 threadId: 컬럼 무추가 저장 → API JSON·팬아웃·FCM data·딥링크에 실린다', async () => {
  const r = await createWith({ source: 'agent', kind: 'conv_request', title: '조치 필요', subtitle: '「proj」에서 승인 대기',
    cwd: 'proj', wsName: 'proj', workspaceId: 'ws_1', threadId: THREAD });
  // 저장: 새 컬럼 없이 session_id 에 접두로.
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].session_id, 'conv:' + THREAD);
  assert.ok(!('thread_id' in r.rows[0]), '스키마에 없는 컬럼을 쓰지 않는다');
  // API JSON: threadId + (구 클라용) sessionId 는 접두 없는 값.
  assert.strictEqual(r.notification.threadId, THREAD);
  assert.strictEqual(r.notification.sessionId, THREAD);
  // 라이브 팬아웃(notif_event new)도 같은 JSON.
  assert.strictEqual(r.fans.length, 1);
  assert.strictEqual(r.fans[0].kind, 'new');
  assert.strictEqual(r.fans[0].notification.threadId, THREAD);
  // FCM: data.threadId + 딥링크 thread=.
  assert.strictEqual(r.pushes.length, 1);
  const p = r.pushes[0].p;
  assert.deepStrictEqual(p.data, { threadId: THREAD });
  assert.strictEqual(p.sessionId, THREAD);
  assert.strictEqual(p.notifId, 501);
  const u = new URL(p.deeplink);
  assert.strictEqual(u.protocol, 'codingpt:');
  assert.strictEqual(u.searchParams.get('thread'), THREAD);
  assert.strictEqual(u.searchParams.get('ws'), 'ws_1');
  assert.strictEqual(u.searchParams.get('cwd'), 'proj');
  assert.strictEqual(p.title, '조치 필요');
  // provider 가 실제로 만드는 FCM 메시지의 data 에 문자열로 실린다.
  const { _buildFcmMessage } = require('../services/pushProviderService');
  if (typeof _buildFcmMessage === 'function') {
    const m = _buildFcmMessage({ token: 'tok' }, p);
    assert.strictEqual(m.message.data.threadId, THREAD);
  }
});

test('알림 threadId: 데몬이 준 deeplink·push.data 는 보존하고 threadId 만 서버 값으로 고정', async () => {
  const r = await createWith({ source: 'agent', kind: 'conv_done', title: '작업 완료', body: '미리보기', threadId: THREAD,
    sessionId: 'other-session', deeplink: 'codingpt://conv/' + THREAD + '?host=12',
    push: { channelId: 'codingpt_default', data: { hostDeviceId: '12', threadId: 'spoofed' } } });
  assert.strictEqual(r.rows[0].session_id, 'conv:' + THREAD, 'threadId 가 sessionId 보다 우선');
  const p = r.pushes[0].p;
  assert.strictEqual(p.deeplink, 'codingpt://conv/' + THREAD + '?host=12');
  assert.deepStrictEqual(p.data, { hostDeviceId: '12', threadId: THREAD });
  assert.strictEqual(p.channelId, 'codingpt_default');
});

test('알림 threadId 없음 = 기존과 완전히 동일(회귀 0)', async () => {
  const r = await createWith({ source: 'agent', kind: 'done', title: '완료', wsName: 'proj', cwd: 'proj', win: 2, sessionId: 'sess-1' });
  assert.strictEqual(r.rows[0].session_id, 'sess-1');
  assert.ok(!('threadId' in r.notification));
  assert.strictEqual(r.notification.sessionId, 'sess-1');
  const p = r.pushes[0].p;
  assert.ok(!('data' in p), 'push 옵션이 없으면 data 키도 없다');
  assert.ok(!('channelId' in p));
  assert.strictEqual(p.deeplink, 'codingpt://notif/501?cwd=proj&win=2');
  // push 옵션만 있는 기존 승인 알림 모양도 그대로.
  const a = await createWith({ source: 'agent', kind: 'approval_request', title: '승인', push: { channelId: 'c', category: 'CPT_APPROVAL', data: { approvalId: 'ap_1' } } });
  assert.deepStrictEqual(a.pushes[0].p.data, { approvalId: 'ap_1' });
  assert.strictEqual(a.pushes[0].p.category, 'CPT_APPROVAL');
  assert.strictEqual(a.pushes[0].p.channelId, 'c');
});

test('알림 threadId 형식: 이상한 값은 무시하되 알림은 만든다', async () => {
  assert.strictEqual(notificationService._normThreadId(THREAD), THREAD);
  assert.strictEqual(notificationService._normThreadId(' ' + THREAD + ' '), THREAD);
  for (const bad of [undefined, null, '', 12, {}, ['a'], 'a b', '../x', 'a/b', 'x'.repeat(101), '한글', 'a?b=c', '-lead']) {
    assert.strictEqual(notificationService._normThreadId(bad), null, String(bad));
  }
  const r = await createWith({ source: 'agent', title: '작업 완료', threadId: '../../etc', sessionId: 's' });
  assert.strictEqual(r.rows[0].session_id, 's');
  assert.ok(!('threadId' in r.notification));
});

test('알림 목록 JSON: 저장된 행(conv: 접두)을 읽어도 threadId 가 복원된다 + 딥링크 기본값', () => {
  const j = notificationService._toJson({ id: '9', source: 'agent', kind: 'conv_done', title: '작업 완료', session_id: 'conv:' + THREAD, cwd: 'p', win: null });
  assert.strictEqual(j.threadId, THREAD);
  assert.strictEqual(j.sessionId, THREAD);
  const plain = notificationService._toJson({ id: '10', source: 'agent', title: 't', session_id: null });
  assert.ok(!('threadId' in plain));
  assert.strictEqual(plain.sessionId, null);
  assert.strictEqual(notificationService._buildDeeplink(j), `codingpt://notif/9?cwd=p&thread=${THREAD}`);
});

test('present 라우팅은 채팅 v2 알림에도 그대로 — 활성 폰이면 FCM 억제, 팬아웃은 간다', async () => {
  const r = await createWith({ source: 'agent', kind: 'conv_request', title: '조치 필요', threadId: THREAD },
    { clientKey: 'phone-1', kind: 'mobile', fresh: true });
  assert.strictEqual(r.pushes.length, 0);
  assert.strictEqual(r.fans.length, 1);
  assert.strictEqual(r.fans[0].alertClientKey, 'phone-1');
  assert.strictEqual(r.fans[0].notification.threadId, THREAD);
});

test('back 이 만드는 알림 문구에 벤더 제품명이 없다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['services/notificationService.js', 'controllers/notificationController.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/Claude Code/i.test(src), f);
  }
});

// ── 런치 인자 전달(launchargs.v1) ──────────────────────────────────────────
test('agents/launch: 검증된 args 만 데몬에 넘기고, 셸 문자가 섞이면 400', async () => {
  const ctrl = require('../controllers/daemonController');
  const relay = require('../services/daemonRelayService');
  const { SERVER_CAPS } = require('../config/caps');
  assert.ok(SERVER_CAPS.includes('launchargs.v1'));
  const orig = relay.callRpc; const calls = [];
  relay.callRpc = async (uid, m, p) => { calls.push(p); return { ok: true }; };
  const mk = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  try {
    let res = mk();
    await ctrl.agentsLaunch({ user: { id: 1 }, body: { cwd: 'p', index: 2, id: 'claude', args: ['--resume', '11f810c8-3f6c-4d09-85a7-c4f1636852b3'] }, query: {} }, res);
    assert.equal(res.code, 200); assert.deepEqual(calls[0].args, ['--resume', '11f810c8-3f6c-4d09-85a7-c4f1636852b3']);
    res = mk();
    await ctrl.agentsLaunch({ user: { id: 1 }, body: { cwd: 'p', index: 2, id: 'claude', args: ['--resume', 'x; rm -rf ~'] }, query: {} }, res);
    assert.equal(res.code, 400); assert.equal(calls.length, 1);
    res = mk();
    await ctrl.agentsLaunch({ user: { id: 1 }, body: { cwd: 'p', index: 2, id: 'claude' }, query: {} }, res);
    assert.equal(res.code, 200); assert.equal('args' in calls[1], false);
  } finally { relay.callRpc = orig; }
});
