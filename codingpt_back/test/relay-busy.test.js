// F4 PC 깨어 있기 — 제어 WS `runner_busy` 수신 + 작업 중 끊김 푸시 — node --test.
//
// 정본 계약 = codingpt_daemon/docs/automation-design.md §6.5 / §7.2 / §7.4.
//  · runner_busy {busy, awake} → runner_status 팬아웃에 busy/awake(불리언 강제), listRunners/리플레이에도 동봉
//  · busy 인 PC 가 끊기면 90s 뒤 pc_disconnected 알림 1회, 89s 안 재접속이면 0회, updating 사유면 0회
//  · busy 가 아닌 PC 의 끊김은 푸시 없음
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const relay = require('../services/daemonRelayService');
const notificationService = require('../services/notificationService');
const { DaemonDevice } = require('../models');

let userSeq = 880100;
let origUpdate;
let origCreate;
let created;

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
// 이 사용자의 UI(WSS) 구독자 하나 — runner_status 팬아웃을 받는다.
function uiClient(userId) {
  const frames = [];
  const ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)) };
  const key = String(userId);
  if (!relay._agentWsClients.has(key)) relay._agentWsClients.set(key, new Set());
  relay._agentWsClients.get(key).add(ws);
  return { frames, status: () => frames.filter((f) => f.type === 'runner_status').map((f) => f.event) };
}
function connect(userId, deviceId = 31) {
  const ws = fakeWs();
  relay._registerControl(ws, { id: deviceId, user_id: userId, device_name: 'MacBook', runner_kind: 'local', platform: 'darwin' });
  return ws;
}
const frame = (ws, obj) => ws.emit('message', Buffer.from(JSON.stringify(obj)), false);
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  origUpdate = DaemonDevice.update;
  DaemonDevice.update = async () => [1];
  origCreate = notificationService.createNotification;
  created = [];
  notificationService.createNotification = async (uid, payload) => { created.push({ uid, payload }); return { id: 1 }; };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  DaemonDevice.update = origUpdate;
  notificationService.createNotification = origCreate;
  for (const t of relay._busyTimers.values()) clearTimeout(t);
  relay._busyTimers.clear();
});

test('runner_busy → runner_status 에 busy/awake(불리언 강제) + listRunners 동봉', () => {
  const uid = userSeq++;
  const ui = uiClient(uid);
  const ws = connect(uid);
  frame(ws, { type: 'runner_busy', busy: true, awake: 'yes', at: 1 });
  const ev = ui.status().at(-1);
  assert.strictEqual(ev.deviceId, 31);
  assert.strictEqual(ev.online, true);
  assert.strictEqual(ev.busy, true);
  assert.strictEqual(ev.awake, false, '문자열은 불리언 true 가 아니다');
  assert.strictEqual(ev.deviceName, 'MacBook');
  const r = relay.listRunners(uid)[0];
  assert.strictEqual(r.busy, true);
  assert.strictEqual(r.awake, false);
  ws.emit('close');
  relay._agentWsClients.delete(String(uid));
});

test('10s 안 중복은 마지막 값만 후행 팬아웃', () => {
  const uid = userSeq++;
  const ui = uiClient(uid);
  const ws = connect(uid);
  const base = ui.status().length;
  frame(ws, { type: 'runner_busy', busy: true, awake: false });
  frame(ws, { type: 'runner_busy', busy: true, awake: true });
  frame(ws, { type: 'runner_busy', busy: false, awake: false });
  assert.strictEqual(ui.status().length, base + 1, '첫 프레임만 즉시');
  mock.timers.tick(10000);
  const evs = ui.status().slice(base);
  assert.strictEqual(evs.length, 2);
  assert.deepStrictEqual([evs[1].busy, evs[1].awake], [false, false], '후행 = 마지막 값');
  ws.emit('close');
  relay._agentWsClients.delete(String(uid));
});

test('hello 의 busy/awake 도 읽는다 + 리플레이 동봉', () => {
  const uid = userSeq++;
  const ws = connect(uid);
  frame(ws, { type: 'hello', daemonVersion: '9.9.9', busy: true, awake: true });
  assert.strictEqual(relay.listRunners(uid)[0].busy, true);
  const ui = { readyState: 1, frames: [], send(s) { this.frames.push(JSON.parse(s)); } };
  relay._replayRunnerStatus(uid, ui);
  const ev = ui.frames.find((f) => f.type === 'runner_status').event;
  assert.strictEqual(ev.busy, true);
  assert.strictEqual(ev.awake, true);
  ws.emit('close');
});

test('작업 중 끊김 → 90s 뒤 pc_disconnected 1회(내용 0, 불리언·기기 이름만)', async () => {
  const uid = userSeq++;
  const ws = connect(uid);
  frame(ws, { type: 'runner_busy', busy: true, awake: true });
  ws.emit('close');
  mock.timers.tick(89999);
  await flush();
  assert.strictEqual(created.length, 0);
  mock.timers.tick(1);
  await flush();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].uid, uid);
  assert.deepStrictEqual(created[0].payload, {
    source: 'system', kind: 'pc_disconnected', title: 'PC 연결이 끊겼어요',
    subtitle: 'MacBook · 작업이 진행 중이었어요', deeplink: 'codingpt://tasks?host=31',
    pushGate: 'ignore-pc-active', push: { data: { hostDeviceId: '31' } },
  });
  mock.timers.tick(200000);
  await flush();
  assert.strictEqual(created.length, 1, '기기당 끊김 1회');
});

test('89s 안에 같은 PC 가 재접속하면 0회', async () => {
  const uid = userSeq++;
  const ws = connect(uid);
  frame(ws, { type: 'runner_busy', busy: true, awake: false });
  ws.emit('close');
  mock.timers.tick(89000);
  const ws2 = connect(uid);
  mock.timers.tick(10000);
  await flush();
  assert.strictEqual(created.length, 0);
  ws2.emit('close'); // 새 conn 은 busy 아님 → 무장 안 함
  mock.timers.tick(100000);
  await flush();
  assert.strictEqual(created.length, 0);
});

test('reason:updating(업데이트 재시작) 끊김이면 0회', async () => {
  const uid = userSeq++;
  const ws = connect(uid, 32);
  frame(ws, { type: 'runner_busy', busy: true, awake: true });
  // PC 앱이 ui WS 로 host_updating 을 보낸 것과 같은 상태 — 실제 분기(_registerAgentWs)로 표식을 세운다.
  const pc = new EventEmitter();
  pc.readyState = 1; pc.send = () => {};
  relay._registerAgentWs(pc, String(uid), "pc");
  pc.emit('message', Buffer.from(JSON.stringify({ type: 'ui_hello', kind: 'pc', deviceId: 32, clientKey: 'pc-1' })), false);
  pc.emit('message', Buffer.from(JSON.stringify({ type: 'host_updating', version: '0.1.400' })), false);
  const ui = uiClient(uid);
  ws.emit('close');
  const off = ui.status().find((e) => e.online === false);
  assert.strictEqual(off.reason, 'updating', '전제: 오프라인 팬아웃에 updating 사유');
  mock.timers.tick(200000);
  await flush();
  assert.strictEqual(created.length, 0);
  pc.emit('close');
  relay._agentWsClients.delete(String(uid));
});

test('busy 가 아닌 PC 의 끊김은 푸시 없음', async () => {
  const uid = userSeq++;
  const ws = connect(uid);
  frame(ws, { type: 'runner_busy', busy: false, awake: true });
  ws.emit('close');
  mock.timers.tick(200000);
  await flush();
  assert.strictEqual(created.length, 0);
});
