// 자동화 번들 평문 폴백 `POST /api/daemon/auto` + caps — node --test.
//
// 정본 계약 = codingpt_daemon/docs/automation-design.md §7.1 / §7.4.
//  (1) 허용 표가 설계 표와 한 글자도 다르지 않다(power.event 는 로컬 전용이라 없다),
//  (2) 미허용 → 400, 데몬에 안 간다,
//  (3) method 접두별 킬스위치 → 403 {code:'<FAM>_DISABLED'}(다른 family 는 영향 없음),
//  (4) computeServerCaps 의 3 스위치,
//  (5) 에러 code 전달·TIMEOUT 접기·AUTO_ERROR 기본값·라우트 배선.
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const relay = require('../services/daemonRelayService');
const daemonController = require('../controllers/daemonController');
const daemonRoutes = require('../routes/daemonRoutes');
const { SERVER_CAPS, computeServerCaps } = require('../config/caps');

// 설계 §7.1 표 그대로(복사본 — 서버 표가 바뀌면 여기서 깨져야 한다. 바꾸려면 설계 문서 먼저, §13).
const DESIGN_TABLE = [
  ['auto.list', 15000], ['auto.get', 15000], ['auto.validate', 15000], ['auto.create', 15000], ['auto.update', 15000], ['auto.remove', 15000],
  ['auto.pause', 15000], ['auto.resume', 15000], ['auto.pauseAll', 15000], ['auto.runNow', 15000], ['auto.log', 15000],
  ['dispatch.catalog', 30000], ['dispatch.plan', 15000], ['dispatch.get', 15000],
  ['power.status', 15000], ['power.set', 15000], ['power.setup', 15000],
];

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callAuto(body, impl) {
  const orig = relay.callRpc;
  const calls = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => {
    calls.push({ uid, method, params, timeoutMs, opts });
    return impl ? impl({ uid, method, params, timeoutMs, opts }) : { ok: true };
  };
  const res = fakeRes();
  try {
    await daemonController.autoRpc({ user: { id: 7 }, body, query: {} }, res);
  } finally { relay.callRpc = orig; }
  return { res, calls };
}

test('허용 표 = 설계 §7.1 표(메서드 집합·순서·타임아웃 전부)', () => {
  assert.deepStrictEqual([...daemonController._AUTO_RPC_OK.entries()], DESIGN_TABLE);
});

test('TASK_RPC_OK 에 F2 2줄(task.run.fix / task.run.followup.dismiss, 15s)', () => {
  assert.strictEqual(daemonController._TASK_RPC_OK.get('task.run.fix'), 15000);
  assert.strictEqual(daemonController._TASK_RPC_OK.get('task.run.followup.dismiss'), 15000);
});

test('허용 메서드는 표의 타임아웃으로 그 PC 까지 가고 params 는 그대로', async () => {
  for (const [method, ms] of DESIGN_TABLE) {
    const params = { id: 'a_1', nested: { x: [1] } };
    const { res, calls } = await callAuto({ method, params, hostDeviceId: 12 }, () => ({ echoed: method }));
    assert.strictEqual(res.statusCode, 200, method);
    assert.deepStrictEqual(res.body, { echoed: method });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, method);
    assert.strictEqual(calls[0].timeoutMs, ms, `${method} 타임아웃`);
    assert.deepStrictEqual(calls[0].params, params);
    assert.deepStrictEqual(calls[0].opts, { runnerId: 12 });
  }
});

test('미허용 메서드 → 400, 데몬에 가지 않는다(power.event 는 로컬 전용)', async () => {
  for (const method of ['', 'power.event', 'auto', 'auto.unknown', 'task.list', 'fs.read', 'dispatch.run', 'AUTO.LIST', 'auto.list ', undefined]) {
    const { res, calls } = await callAuto({ method, params: {} });
    assert.strictEqual(res.statusCode, 400, String(method));
    assert.strictEqual(res.body.message, '허용되지 않은 명령입니다.');
    assert.strictEqual(calls.length, 0, String(method));
  }
});

test('킬스위치: family 별 cap 이 빠지면 403 <FAM>_DISABLED, 다른 family 는 그대로 통과', async () => {
  const cases = [['auto.v1', 'auto.list', 'AUTO_DISABLED'], ['dispatch.v1', 'dispatch.plan', 'DISPATCH_DISABLED'], ['power.v1', 'power.status', 'POWER_DISABLED']];
  for (const [cap, method, code] of cases) {
    const idx = SERVER_CAPS.indexOf(cap);
    assert.ok(idx >= 0, `이 커밋의 서버는 ${cap} 을 선언한다`);
    SERVER_CAPS.splice(idx, 1);
    try {
      const { res, calls } = await callAuto({ method, params: {} });
      assert.strictEqual(res.statusCode, 403, cap);
      assert.deepStrictEqual(res.body.detail, { code });
      assert.strictEqual(calls.length, 0);
      for (const [, other] of cases.filter((c) => c[0] !== cap)) {
        const r = await callAuto({ method: other, params: {} });
        assert.strictEqual(r.res.statusCode, 200, `${cap} 을 꺼도 ${other} 는 통과`);
      }
    } finally { SERVER_CAPS.splice(idx, 0, cap); }
  }
});

test('caps: 세 능력 기본 선언, 각 스위치는 자기 능력만 회수', () => {
  const all = computeServerCaps({});
  for (const c of ['auto.v1', 'dispatch.v1', 'power.v1']) assert.ok(all.includes(c), c);
  const sw = [['AUTOMATIONS_ENABLED', 'auto.v1'], ['DISPATCH_ENABLED', 'dispatch.v1'], ['POWER_ENABLED', 'power.v1']];
  for (const [env, cap] of sw) {
    for (const v of ['0', 'false', 'off', 'NO']) {
      const caps = computeServerCaps({ [env]: v });
      assert.ok(!caps.includes(cap), `${env}=${v}`);
      for (const [, other] of sw.filter((x) => x[1] !== cap)) assert.ok(caps.includes(other), `${env} 가 ${other} 를 끄면 안 된다`);
      assert.ok(caps.includes('task.v1') && caps.includes('caps.v1'));
    }
  }
});

test('DAEMON_OFFLINE → 409 · 데몬 code 전달 · code 없으면 AUTO_ERROR · 릴레이 타임아웃 → TIMEOUT', async () => {
  let r = await callAuto({ method: 'auto.list', params: {} }, () => { throw new Error('DAEMON_OFFLINE'); });
  assert.strictEqual(r.res.statusCode, 409);
  for (const code of ['AUTO_LIMIT', 'AUTO_LOOP', 'POWER_SETUP_REQUIRED', 'PLANNER_FAILED', 'AUTO_DISABLED']) {
    r = await callAuto({ method: 'auto.create', params: {} }, () => { throw Object.assign(new Error('원문'), { code }); });
    assert.strictEqual(r.res.statusCode, 500);
    assert.deepStrictEqual(r.res.body.detail, { code });
    assert.strictEqual(r.res.body.message, '원문');
  }
  r = await callAuto({ method: 'auto.get', params: {} }, () => { throw new Error('RPC 실패'); });
  assert.deepStrictEqual(r.res.body.detail, { code: 'AUTO_ERROR' });
  r = await callAuto({ method: 'dispatch.catalog', params: {} }, () => { throw new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'); });
  assert.deepStrictEqual(r.res.body.detail, { code: 'TIMEOUT' });
});

test('라우트 배선: POST /api/daemon/auto (JWT 통과·무인증 401)', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/daemon', daemonRoutes);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origRpc = relay.callRpc;
  const seen = [];
  relay.callRpc = async (uid, method) => { seen.push({ uid, method }); return { items: [] }; };
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/daemon/auto`;
    const token = jwt.sign({ id: 4002 }, process.env.ACCESS_SECRET, { algorithm: 'HS256' });
    const post = (auth, body) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body) });
    let r = await post(token, { method: 'auto.list', params: {}, hostDeviceId: 12 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { items: [] });
    assert.deepStrictEqual(seen, [{ uid: 4002, method: 'auto.list' }]);
    r = await post(null, { method: 'auto.list', params: {} });
    assert.strictEqual(r.status, 401);
    r = await post(token, { method: 'power.event', params: { kind: 'willSleep' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(seen.length, 1);
  } finally {
    relay.callRpc = origRpc;
    await new Promise((r) => server.close(r));
  }
});
