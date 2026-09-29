// Agent Tasks 평문 폴백 `POST /api/daemon/task` — node --test.
//
// 정본 계약 = codingpt_daemon/docs/agent-tasks-design.md §3.3 / §2.13 / §7.2.
// 이 라우트는 봉인 RPC(E2EE)가 **구조적으로** 불가할 때만 쓰이는 통로다. 그래서 여기서 지키는 불변식은
//  (1) 허용 표가 설계 표와 한 글자도 다르지 않다 — 표에 없는 메서드는 데몬까지 가지 않는다(임의 RPC 통로 금지),
//  (2) 에러 code 는 body.detail.code 에 실린다 — 클라(taskRpc)는 문구가 아니라 code 로만 분기한다,
//  (3) 릴레이 타임아웃은 'TIMEOUT' 으로 접힌다 — code 없는 실패가 다른 뜻(E2EE_UNSUPPORTED 등)으로 위장되면
//      클라가 같은 변이를 다시 보내 이중 실행이 난다(부록 A3 의 실사고 경로),
//  (4) TASKS_ENABLED=0 이면 caps 선언과 핸들러가 함께 닫힌다,
//  (5) accountAuth — PC(deviceToken)·폰(JWT) 둘 다 통과, 컨트롤러 파생키·무인증은 401.
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const relay = require('../services/daemonRelayService');
const { DaemonDevice } = require('../models');
const daemonController = require('../controllers/daemonController');
const daemonRoutes = require('../routes/daemonRoutes');
const { SERVER_CAPS, computeServerCaps } = require('../config/caps');

// 설계 §3.3 표 그대로(복사본 — 서버 표가 바뀌면 여기서 깨져야 한다. 바꾸려면 설계 문서 먼저, §12).
const DESIGN_TABLE = [
  ['task.list', 15000], ['task.get', 15000], ['task.create', 15000], ['task.run.prompt', 20000], ['task.run.trust', 15000],
  ['task.run.reopen', 15000], ['task.diff', 30000], ['task.discard', 15000], ['task.delete', 15000],
  ['git.branches', 15000], ['git.status', 15000], ['git.commit', 15000], ['git.push', 15000],
  ['git.pr.create', 15000], ['git.pr.status', 30000], ['git.pr.merge', 15000], ['git.merge.local', 15000], ['git.gh.status', 15000],
];

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

/** relay.callRpc 를 가로채 컨트롤러를 한 번 호출한다. impl 이 없으면 {ok:true} 를 돌려준다. */
async function callTask(body, impl, query) {
  const orig = relay.callRpc;
  const calls = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => {
    calls.push({ uid, method, params, timeoutMs, opts });
    return impl ? impl({ uid, method, params, timeoutMs, opts }) : { ok: true };
  };
  const res = fakeRes();
  try {
    await daemonController.taskRpc({ user: { id: 7 }, body, query: query || {} }, res);
  } finally { relay.callRpc = orig; }
  return { res, calls };
}

test('허용 표 = 설계 §3.3 표(메서드 집합·순서·타임아웃 전부)', () => {
  assert.deepStrictEqual([...daemonController._TASK_RPC_OK.entries()], DESIGN_TABLE);
});

test('허용 메서드는 표의 타임아웃으로 데몬까지 가고 params 는 손대지 않는다(검증은 데몬)', async () => {
  for (const [method, ms] of DESIGN_TABLE) {
    const params = { opId: 'u-1', taskId: 't1', runId: 'r1', prompt: '프롬프트', nested: { a: [1, 2] } };
    const { res, calls } = await callTask({ method, params, hostDeviceId: 12 }, () => ({ echoed: method }));
    assert.strictEqual(res.statusCode, 200, method);
    assert.deepStrictEqual(res.body, { echoed: method }, `${method}: 결과는 그대로(successResponse = data 최상위)`);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, method);
    assert.strictEqual(calls[0].timeoutMs, ms, `${method} 타임아웃`);
    assert.deepStrictEqual(calls[0].params, params);
    assert.deepStrictEqual(calls[0].opts, { runnerId: 12 }, 'hostDeviceId 로 그 PC 러너를 고른다');
  }
});

test('params 가 객체가 아니면 {} 로 보낸다(배열·문자열·null)', async () => {
  for (const p of [null, 'x', [1, 2], 3]) {
    const { calls } = await callTask({ method: 'task.list', params: p });
    assert.deepStrictEqual(calls[0].params, {});
  }
});

test('미허용 메서드 → 400, 데몬에 가지 않는다', async () => {
  for (const method of ['', 'fs.read', 'task', 'task.unknown', 'git.exec', 'surface.add', 'task.list ', 'TASK.LIST', undefined]) {
    const { res, calls } = await callTask({ method, params: {} });
    assert.strictEqual(res.statusCode, 400, String(method));
    assert.strictEqual(res.body.message, '허용되지 않은 명령입니다.');
    assert.strictEqual(calls.length, 0, `${method}: 표 밖 메서드는 릴레이를 타면 안 된다`);
  }
});

test('DAEMON_OFFLINE → 409', async () => {
  const { res } = await callTask({ method: 'task.list', params: {} }, () => { throw new Error('DAEMON_OFFLINE'); });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.success, false);
});

test('데몬 에러 code 는 detail.code 로 전달된다(문구는 원문 그대로)', async () => {
  for (const code of ['UNCOMMITTED_CHANGES', 'RUN_BUSY', 'BAD_PARAMS', 'TASK_NOT_FOUND', 'GH_NOT_AUTHED', 'TASKS_DISABLED']) {
    const { res } = await callTask({ method: 'git.pr.merge', params: {} }, () => {
      throw Object.assign(new Error('작업 트리에 커밋되지 않은 변경이 있습니다.'), { code });
    });
    assert.strictEqual(res.statusCode, 500, code);
    assert.deepStrictEqual(res.body.detail, { code });
    assert.strictEqual(res.body.message, '작업 트리에 커밋되지 않은 변경이 있습니다.');
  }
});

test('code 없는 데몬 실패는 GH_ERROR 로 접는다(설계 §3.3)', async () => {
  const { res } = await callTask({ method: 'git.pr.status', params: {} }, () => { throw new Error('RPC 실패'); });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body.detail, { code: 'GH_ERROR' });
});

test('★ 릴레이 타임아웃 → detail.code TIMEOUT (실제 relay.callRpc 로 — 문구가 바뀌면 여기서 깨진다)', async () => {
  // 가짜 러너 커넥션: 데몬이 영영 답하지 않는다. 가짜 타이머로 표의 타임아웃(30s)만큼 흘린다.
  const userId = 990777;
  const sent = [];
  const conn = { deviceId: 12, kind: 'local', caps: ['task.v1'], e2eeEpoch: 0, connectedAt: Date.now(),
    ws: { readyState: 1, send(s) { sent.push(JSON.parse(s)); } }, rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0 };
  relay._connections.set(String(userId), { runners: new Map([[12, conn]]), activeRunnerId: 12 });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const res = fakeRes();
    const p = daemonController.taskRpc({ user: { id: userId }, body: { method: 'task.diff', params: { taskId: 't' }, hostDeviceId: 12 }, query: {} }, res);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'rpc');
    assert.strictEqual(sent[0].method, 'task.diff');
    mock.timers.tick(29999);
    await Promise.resolve();
    assert.strictEqual(res.body, null, 'task.diff 는 30s 전에 끊기면 안 된다');
    mock.timers.tick(1);
    await p;
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body.detail, { code: 'TIMEOUT' },
      'code 없는 타임아웃이 다른 code 로 위장되면 클라가 같은 변이를 평문으로 다시 보낸다(이중 실행)');
  } finally {
    mock.timers.reset();
    relay._connections.delete(String(userId));
  }
});

test('실제 relay 의 rpc_result 실패 code 도 detail.code 로 도착한다(릴레이가 code 를 보존하는 전제)', async () => {
  const userId = 990778;
  const conn = { deviceId: 12, kind: 'local', caps: [], e2eeEpoch: 0, connectedAt: Date.now(),
    ws: { readyState: 1, send() {} }, rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0 };
  relay._connections.set(String(userId), { runners: new Map([[12, conn]]), activeRunnerId: 12 });
  try {
    const res = fakeRes();
    const p = daemonController.taskRpc({ user: { id: userId }, body: { method: 'git.commit', params: {}, hostDeviceId: 12 }, query: {} }, res);
    // daemonRelayService 의 rpc_result 분기와 같은 모양으로 거절(Error + code).
    const [[, pending]] = [...conn.pendingRpc.entries()];
    clearTimeout(pending.timer);
    pending.reject(Object.assign(new Error('git 저장소가 잠겨 있습니다.'), { code: 'GIT_LOCKED' }));
    await p;
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body.detail, { code: 'GIT_LOCKED' });
  } finally { relay._connections.delete(String(userId)); }
});

test('caps: task.v1 기본 선언, TASKS_ENABLED=0/false/off 면 없음', () => {
  assert.ok(computeServerCaps({}).includes('task.v1'));
  assert.ok(computeServerCaps({ TASKS_ENABLED: '1' }).includes('task.v1'));
  for (const v of ['0', 'false', 'off', 'OFF']) {
    assert.ok(!computeServerCaps({ TASKS_ENABLED: v }).includes('task.v1'), v);
  }
  // 다른 능력에는 영향 없음(스위치가 서로 얽히면 회수가 엉뚱한 기능을 끈다).
  const off = computeServerCaps({ TASKS_ENABLED: '0' });
  assert.ok(off.includes('caps.v1') && off.includes('agentstate.v1'));
});

test('킬스위치: SERVER_CAPS 에서 task.v1 이 빠지면 핸들러가 403 TASKS_DISABLED(데몬에 안 간다)', async () => {
  const idx = SERVER_CAPS.indexOf('task.v1');
  assert.ok(idx >= 0, '이 커밋의 서버는 task.v1 을 선언한다');
  SERVER_CAPS.splice(idx, 1);
  try {
    const { res, calls } = await callTask({ method: 'task.list', params: {} });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body.detail, { code: 'TASKS_DISABLED' });
    assert.strictEqual(calls.length, 0);
  } finally { SERVER_CAPS.splice(idx, 0, 'task.v1'); }
});

// ── 라우트 배선 + accountAuth(HTTP 왕복) ─────────────────────────────────
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/daemon', daemonRoutes);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/daemon/task`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('accountAuth: deviceToken(PC)·JWT(폰) 둘 다 통과, 파생키·무인증은 401', async () => {
  const origFind = DaemonDevice.findOne;
  const origRpc = relay.callRpc;
  const seen = [];
  DaemonDevice.findOne = async ({ where }) => (where && where.token_hash ? { id: 55, user_id: 3001 } : null);
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => { seen.push({ uid, method, opts }); return { items: [], caps: { gh: { gitOk: true, ghInstalled: true, ghAuthed: true } } }; };
  try {
    await withServer(async (url) => {
      const post = (auth, body) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body || { method: 'task.list', params: {}, hostDeviceId: 12 }),
      });
      // PC — deviceToken
      let r = await post('cptd_' + 'a'.repeat(40));
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual((await r.json()).items, []);
      assert.deepStrictEqual(seen.at(-1), { uid: 3001, method: 'task.list', opts: { runnerId: 12 } });
      // 폰 — JWT
      const token = jwt.sign({ id: 4002 }, process.env.ACCESS_SECRET, { algorithm: 'HS256' });
      r = await post(token);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(seen.at(-1).uid, 4002);
      // 컨트롤러 파생키(ctrl:uuid)·무인증·잘못 서명된 JWT → 401
      for (const bad of ['ctrl:00000000-0000-0000-0000-000000000000', null, jwt.sign({ id: 1 }, 'wrong', { algorithm: 'HS256' })]) {
        r = await post(bad);
        assert.strictEqual(r.status, 401, String(bad));
      }
      // 라우트 수준에서도 미허용 → 400
      r = await post(token, { method: 'fs.read', params: {} });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(seen.length, 2, '401/400 요청은 데몬에 가지 않는다');
    });
  } finally {
    DaemonDevice.findOne = origFind;
    relay.callRpc = origRpc;
  }
});

test('HTTP 본문 계약: 에러는 {success:false, message, detail:{code}}', async () => {
  const origRpc = relay.callRpc;
  relay.callRpc = async () => { throw Object.assign(new Error('프롬프트가 너무 깁니다.'), { code: 'PROMPT_TOO_LARGE' }); };
  try {
    await withServer(async (url) => {
      const token = jwt.sign({ id: 4002 }, process.env.ACCESS_SECRET, { algorithm: 'HS256' });
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ method: 'task.create', params: { prompt: 'x' } }) });
      assert.strictEqual(r.status, 500);
      const b = await r.json();
      assert.strictEqual(b.success, false);
      assert.strictEqual(b.message, '프롬프트가 너무 깁니다.');
      assert.deepStrictEqual(b.detail, { code: 'PROMPT_TOO_LARGE' });
    });
  } finally { relay.callRpc = origRpc; }
});

// ── 통합 라운드 추가: 봉인 경로 타임아웃 · PC 의 caps 조회 ────────────────────────
function sealedEnv() {
  return { v: 1, suite: 'x25519-aes256gcm', epoch: 3, nonce: 'AAAAAAAAAAAAAAAA', ct: 'B'.repeat(32) };
}
async function callSealed(impl) {
  const orig = relay.callRpc;
  relay.callRpc = async (...a) => impl(...a);
  const res = fakeRes();
  try {
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env: sealedEnv(), hostDeviceId: 12, timeoutMs: 30000 }, query: {} }, res);
  } finally { relay.callRpc = orig; }
  return res;
}

test('★ 봉인 경로 릴레이 타임아웃 → 504 TIMEOUT (501 구조적 미지원으로 위장 금지 — 평문 재전송 = 이중 실행)', async () => {
  const res = await callSealed(async () => { throw new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'); });
  assert.strictEqual(res.statusCode, 504);
  assert.deepStrictEqual(res.body.detail, { code: 'TIMEOUT' });
  // 코드 없는 다른 실패(구 데몬이 'sealed' 를 모름)는 종전대로 501 E2EE_UNSUPPORTED.
  const old = await callSealed(async () => { throw new Error('unknown method sealed'); });
  assert.strictEqual(old.statusCode, 501);
  assert.deepStrictEqual(old.body.detail, { code: 'E2EE_UNSUPPORTED' });
});

test('GET /status 는 deviceToken(PC)도 통과한다 — PC hostCaps 의 유일한 출처(§2.3)', async () => {
  const origFind = DaemonDevice.findOne;
  const origAll = DaemonDevice.findAll;
  const origList = relay.listRunners;
  DaemonDevice.findOne = async ({ where }) => (where && where.token_hash ? { id: 55, user_id: 3001 } : null);
  DaemonDevice.findAll = async () => [];
  relay.listRunners = (uid) => [{ deviceId: 12, kind: 'local', caps: ['task.v1'], uid }];
  try {
    await withServer(async (taskUrl) => {
      const url = taskUrl.replace(/\/task$/, '/status');
      let r = await fetch(url, { headers: { authorization: `Bearer cptd_${'a'.repeat(40)}` } });
      assert.strictEqual(r.status, 200);
      const b = await r.json();
      const data = b.data || b;
      assert.deepStrictEqual(data.runners, [{ deviceId: 12, kind: 'local', caps: ['task.v1'], uid: 3001 }]);
      const token = jwt.sign({ id: 4002 }, process.env.ACCESS_SECRET, { algorithm: 'HS256' });
      r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      assert.strictEqual(r.status, 200, 'JWT(폰) 경로는 종전 그대로');
      r = await fetch(url);
      assert.strictEqual(r.status, 401);
    });
  } finally {
    DaemonDevice.findOne = origFind;
    DaemonDevice.findAll = origAll;
    relay.listRunners = origList;
  }
});
