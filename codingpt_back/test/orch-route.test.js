// 오케스트레이션(orch.*) 서버 배관 — `POST /api/daemon/orch` — node --test.
//  정본 계약 = codingpt_daemon/docs/orchestration-design.md.
//  (1) 원격 화면은 사람 권한 메서드만 — 워커를 띄우거나 수신함을 소비하는 명령은 400 이고 데몬에 안 간다,
//  (2) 킬스위치(orch.v1 회수) → 403 {code:'ORCH_DISABLED'},
//  (3) params 는 그대로, 데몬 오류 code 전달 · 타임아웃 → TIMEOUT · 미연결 → 409 DAEMON_OFFLINE.
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const relay = require('../services/daemonRelayService');
const daemonController = require('../controllers/daemonController');
const { SERVER_CAPS, computeServerCaps } = require('../config/caps');

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callOrch(body, impl) {
  const orig = relay.callRpc;
  const calls = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => {
    calls.push({ uid, method, params, timeoutMs, opts });
    return impl ? impl({ method, params }) : { ok: true };
  };
  const res = fakeRes();
  try { await daemonController.orchRpc({ user: { id: 7 }, body, query: {} }, res); } finally { relay.callRpc = orig; }
  return { res, calls };
}

test('허용 표: 보기 + 답하기·결정·멈추기·정리·닫기·메모만', async () => {
  const ok = [...daemonController._ORCH_RPC_OK.keys()].sort();
  assert.deepStrictEqual(ok, ['orch.gateList', 'orch.gateResolve', 'orch.list', 'orch.noteSet', 'orch.reply', 'orch.runClose', 'orch.runList',
    'orch.runShow', 'orch.status', 'orch.workerList', 'orch.workerRead', 'orch.workerRelease', 'orch.workerRetain', 'orch.workerShow', 'orch.workerStop']);
  const { res, calls } = await callOrch({ method: 'orch.reply', params: { id: 'm_1', body: '그렇게 해' }, hostDeviceId: 3 });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls[0].params, { id: 'm_1', body: '그렇게 해' });
  assert.strictEqual(calls[0].timeoutMs, 15000);
});

test('에이전트 전용 명령은 원격에서 400 — 데몬에 가지 않는다', async () => {
  for (const method of ['orch.workerStart', 'orch.runCreate', 'orch.check', 'orch.ask', 'orch.send', 'orch.taskCreate', 'orch.workerAbandon', 'orch.gateCreate', 'orch.nope', '']) {
    const { res, calls } = await callOrch({ method, params: {} });
    assert.strictEqual(res.statusCode, 400, method);
    assert.strictEqual(calls.length, 0, method);
  }
});

test('킬스위치: orch.v1 이 빠지면 403 ORCH_DISABLED', async () => {
  assert.ok(SERVER_CAPS.includes('orch.v1'));
  assert.ok(!computeServerCaps({ ORCH_ENABLED: '0' }).includes('orch.v1'));
  assert.ok(computeServerCaps({ ORCH_ENABLED: '0' }).includes('task.v1'), '자기 능력만 회수');
  const idx = SERVER_CAPS.indexOf('orch.v1');
  SERVER_CAPS.splice(idx, 1);
  try {
    const { res, calls } = await callOrch({ method: 'orch.list', params: {} });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body.detail, { code: 'ORCH_DISABLED' });
    assert.strictEqual(calls.length, 0);
  } finally { SERVER_CAPS.splice(idx, 0, 'orch.v1'); }
});

test('오류: 데몬 code 전달 · 타임아웃 → TIMEOUT · 미연결 → 409', async () => {
  const a = await callOrch({ method: 'orch.workerRelease', params: {} }, () => { throw Object.assign(new Error('머지하지 못했습니다'), { code: 'MERGE_FAILED' }); });
  assert.strictEqual(a.res.statusCode, 500);
  assert.deepStrictEqual(a.res.body.detail, { code: 'MERGE_FAILED' });
  const b = await callOrch({ method: 'orch.list', params: {} }, () => { throw new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'); });
  assert.deepStrictEqual(b.res.body.detail, { code: 'TIMEOUT' });
  const c = await callOrch({ method: 'orch.list', params: {} }, () => { throw new Error('DAEMON_OFFLINE'); });
  assert.strictEqual(c.res.statusCode, 409);
  assert.deepStrictEqual(c.res.body.detail, { code: 'DAEMON_OFFLINE' });
});
