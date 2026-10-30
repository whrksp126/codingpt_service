// 외부 연동 API(/api/v1) — node --test. 공개 본문으로 auth 를 덮어쓸 수 없고, 키는 묶인 PC 로만 간다.
process.env.ACCESS_SECRET = process.env.ACCESS_SECRET || 'test-access-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const relay = require('../services/daemonRelayService');
const models = require('../models');
const c = require('../controllers/externalController');

function fakeRes() {
  return { statusCode: 200, body: null, writableEnded: false, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, send(b) { this.body = b; return this; } };
}
const KEY = { id: 3, name: '쇼핑몰', user_id: 7, device_id: 11, allowed_paths: ['~/a'], allow_bypass: false };
async function call(fn, req, impl) {
  const orig = relay.callRpc; const calls = [];
  relay.callRpc = async (uid, method, params, timeoutMs, opts) => { calls.push({ uid, method, params, opts }); return impl ? impl(method, params) : { ok: true }; };
  const res = fakeRes();
  try { await fn({ apiKey: KEY, params: {}, query: {}, body: {}, headers: {}, ...req }, res); } finally { relay.callRpc = orig; }
  return { res, calls };
}

test('auth 는 키에서 만든다 — 본문의 auth·알 수 없는 필드는 버린다', async () => {
  const { calls } = await call(c.createSession, { body: { cwd: '/x', prompt: 'p', auth: { keyId: 999, allowBypass: true }, evil: 1 } });
  assert.strictEqual(calls[0].method, 'ext.create');
  assert.deepStrictEqual(calls[0].params.auth, { keyId: 3, keyName: '쇼핑몰', paths: ['~/a'], allowBypass: false });
  assert.strictEqual(calls[0].params.evil, undefined);
  assert.strictEqual(calls[0].uid, 7);
  assert.deepStrictEqual(calls[0].opts, { runnerId: 11 });
});

test('오류 code 를 detail 로, 상태를 맞춰 돌려준다', async () => {
  const fail = (code) => () => { throw Object.assign(new Error('x'), { code }); };
  assert.strictEqual((await call(c.getSession, { params: { id: 's' } }, fail('SESSION_NOT_FOUND'))).res.statusCode, 404);
  const a = await call(c.createSession, {}, fail('BYPASS_NOT_ALLOWED'));
  assert.strictEqual(a.res.statusCode, 403);
  assert.strictEqual(a.res.body.detail.code, 'BYPASS_NOT_ALLOWED');
  const off = await call(c.listSessions, {}, () => { throw new Error('DAEMON_OFFLINE'); });
  assert.strictEqual(off.res.statusCode, 503);
  assert.strictEqual(off.res.body.detail.code, 'DAEMON_OFFLINE');
});

test('long-poll — 일하는 중이면 기다리고, 새 이벤트가 오면 바로 돌려준다', async () => {
  let n = 0;
  const { res, calls } = await call(c.events, { params: { id: 's' }, query: { after: '3', wait: '5' } }, () => {
    n++;
    return n < 2 ? { session: { state: 'working' }, events: [], partial: [] } : { session: { state: 'working' }, events: [{ seq: 4 }], partial: [] };
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].params.after, 3);
  assert.strictEqual(res.body.events.length, 1);
});

test('키 인증 — 접두사·해시·폐기', async () => {
  const orig = models.ExternalApiKey.findOne;
  models.ExternalApiKey.findOne = async ({ where }) => (where.key_hash === c._sha256('cptx_good') && where.revoked_at === null ? { id: 1, last_used_at: new Date() } : null);
  try {
    const run = async (h) => { const res = fakeRes(); let nexted = false; const req = { headers: { authorization: h } }; await c.apiKeyAuth(req, res, () => { nexted = true; }); return { res, nexted, req }; };
    assert.strictEqual((await run('Bearer cptd_device')).res.statusCode, 401);   // 기기 토큰으로는 못 부른다
    assert.strictEqual((await run('Bearer cptx_bad')).res.statusCode, 401);
    const good = await run('Bearer cptx_good');
    assert.ok(good.nexted);
    assert.strictEqual(good.req.apiKey.id, 1);
  } finally { models.ExternalApiKey.findOne = orig; }
});

test('키 관리 라우트는 cpt 로 열려 있지 않다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../codingpt_daemon/packages/runner-core/cpt-server.js'), 'utf8');
  assert.ok(!/api-keys/.test(src));
  assert.ok(!/'ext\.[a-zA-Z]+'/.test(src));
});

test('SDK 파일은 공개로 읽힌다', () => {
  const res = fakeRes();
  c.publicFile('sdk')({}, res);
  assert.match(String(res.body), /export class CodingPT/);
});
