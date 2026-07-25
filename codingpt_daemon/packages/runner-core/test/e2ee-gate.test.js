// E2EE 배선(게이트·협상 게이팅·봉투 RPC·스냅샷) 계약 테스트 — 암호 코어는 ../e2ee(실물)를 쓴다.
//   실행: node --test packages/runner-core/test/e2ee-gate.test.js
//
// 여기서 고정하는 불변식(설계서 기능2 §2·§6 + 임무의 절대 불변식):
//  1. 킬스위치(CPT_E2EE=0)·스코프(CPT_E2EE_SCOPE)로 즉시 원복되고, 그 상태에서 caps 선언조차 사라진다.
//  2. 모듈 부재 = 능력 미선언(구 번들에 프레임이 흘러 조용히 유실되는 사고 방지).
//  3. 스트림 협상은 스코프 stream 이상에서만 승낙 — 미달이면 **거절**(back 이 평문 폴백을 택하게).
//  4. 봉투 RPC 는 성공/실패 **양쪽 다** 봉인된다(에러 문구에 경로·내용이 섞여 나가는 게 실제 유출 경로).
//  5. 스냅샷은 자기서술 헤더로 평문 옛 번들과 공존하고, 열쇠 없이 열면 명확히 실패한다(빈 결과 금지).
//
// 안전: runtime.init 으로 격리 stateDir 을 강제한 뒤 e2ee 를 쓴다 — 실사용 ~/.codingpt/e2ee.json 무접촉.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2ee-gate-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const gate = require('../e2ee-gate');
const e2ee = require('../e2ee');
const control = require('../control');

const HOST_DEV = 12;
function armKeys(ep = 2) {
  e2ee.ensureIdentity({ deviceId: HOST_DEV });
  e2ee.setMasterKey(ep, Buffer.alloc(32, 0x3f + ep));
  return ep;
}
function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  const apply = (o) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const restore = () => { apply(prev); gate.resetCache(); };
  apply(env); gate.resetCache();
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  // ⚠ 비동기 본문에서도 env 가 유지돼야 한다 — 동기 finally 로 되돌리면 await 이후엔 이미 원복돼
  //  게이트가 다른 모듈/스코프를 로드한다(실제로 이 함정에 한 번 걸렸다).
  if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return r;
}
const callBegin = (params) => new Promise((res, rej) => control.handleE2eeBegin(params, res, rej));
// back 이 실제로 보내는 rpc params 형태: { env, hostDeviceId? } — hostDeviceId 는 **클라가 본문에 실은
//  값 그대로**(미지정이면 필드 자체가 없다. app e2ee.ts:862 / back daemonController.js:899).
const callSealed = (env, hostDeviceId) => new Promise((res, rej) => control.handleSealedRpc(
  { readyState: 1, send() {} },
  { env, ...(hostDeviceId === undefined ? {} : { hostDeviceId }) },
  res, rej,
));

test('스코프 기본값 rpc + 킬스위치 CPT_E2EE=0 = 전면 OFF', () => {
  armKeys();
  withEnv({ CPT_E2EE_SCOPE: undefined, CPT_E2EE: undefined }, () => {
    assert.strictEqual(gate.scope(), 'rpc');
    assert.strictEqual(gate.allows('rpc'), true);
    assert.strictEqual(gate.allows('snapshot'), false);
    assert.strictEqual(gate.allows('stream'), false);
    assert.deepStrictEqual(gate.caps(), ['e2ee.keys.v1', 'e2ee.rpc.v1'], '기본 스코프에서 stream 능력을 선언하면 안 된다');
    assert.strictEqual(gate.selfDeviceId(), HOST_DEV);
  });
  withEnv({ CPT_E2EE_SCOPE: 'all', CPT_E2EE: '0' }, () => {
    assert.strictEqual(gate.scope(), 'off', '킬스위치가 스코프보다 우선해야 한다');
    assert.strictEqual(gate.load(), null);
    assert.deepStrictEqual(gate.caps(), []);
    assert.strictEqual(gate.epoch(), 0);
    assert.strictEqual(gate.viewerChannel('any'), null);
    assert.strictEqual(gate.hostChannelFromFrame('any', Buffer.alloc(64)), null);
  });
});

test('모듈 부재 = 능력 미선언(구 번들 안전 실패)', () => {
  withEnv({ CPT_E2EE_MODULE: path.join(__dirname, '__no_such_e2ee__.js'), CPT_E2EE_SCOPE: 'all' }, () => {
    assert.strictEqual(gate.load(), null);
    assert.deepStrictEqual(gate.caps(), []);
    assert.strictEqual(gate.hostChannelFromFrame('sid', Buffer.alloc(64)), null);
    assert.strictEqual(gate.sessionExists('sid', 'host'), false);
  });
});

test('열쇠 없음 = 능력 미선언(협상해놓고 열쇠가 없는 상태 차단)', () => {
  // 상태 파일을 지우면 신원/열쇠가 없다 → caps 는 비어야 한다(e2ee.caps() 규율).
  e2ee.removeState();
  withEnv({ CPT_E2EE_SCOPE: 'all' }, () => {
    assert.deepStrictEqual(gate.caps(), []);
    assert.strictEqual(gate.epoch(), 0);
  });
  armKeys(); // 이후 테스트를 위해 복구
});

test('스코프 승격: all 에서만 e2ee.stream.v1 선언 + 스트림 협상 승낙', async () => {
  const ep = armKeys();
  const routing = { cwd: 'a', paneId: 'p', win: 7 };
  // scope=rpc: 스트림 목적(pty/tcp) 협상은 거절 — back 이 e2ee:false 로 평문 폴백한다.
  await withEnv({ CPT_E2EE_SCOPE: 'rpc' }, async () => {
    const { offer } = e2ee.createViewerOffer({ purpose: 'pty', epoch: ep, client: 'c1', routing, hostDeviceId: HOST_DEV });
    await assert.rejects(
      () => callBegin({ purpose: 'pty', suite: offer.suite, epoch: ep, pub: offer.pub, nonce: offer.nonce, client: 'c1', routing, hostDeviceId: HOST_DEV }),
      (e) => e.code === 'E2EE_SCOPE',
    );
  });
  // scope=all: 승낙 + 뷰어가 confirm/sid 를 재계산해 일치(트랜스크립트 바인딩 성립).
  await withEnv({ CPT_E2EE_SCOPE: 'all' }, async () => {
    assert.deepStrictEqual(gate.caps(), ['e2ee.keys.v1', 'e2ee.rpc.v1', 'e2ee.stream.v1']);
    const { offer, pending } = e2ee.createViewerOffer({ purpose: 'pty', epoch: ep, client: 'c1', routing, hostDeviceId: HOST_DEV });
    const answer = await callBegin({ purpose: 'pty', suite: offer.suite, epoch: ep, pub: offer.pub, nonce: offer.nonce, client: 'c1', routing, hostDeviceId: HOST_DEV });
    assert.ok(answer && answer.sid && answer.pub && answer.nonce && answer.confirm, '협상 응답 필드 누락');
    const vsess = e2ee.acceptHostAnswer(pending, answer);
    assert.strictEqual(vsess.sidB64, answer.sid);
    assert.strictEqual(gate.sessionExists(answer.sid, 'host'), true);

    // 프레임 왕복 — 뷰어가 connId 를 정하고 호스트는 첫 프레임에서 학습한다(pty/proxy 규율).
    const vch = e2ee.channel(vsess.sidB64, null, 'viewer');
    const first = vch.sealCtrl({ type: 'resize', cols: 100, rows: 30 });
    const hch = gate.hostChannelFromFrame(answer.sid, first);
    assert.ok(hch, '호스트 채널 학습 실패');
    const f = gate.openFrame(hch, first);
    assert.strictEqual(f.kind, gate.KIND_CTRL);
    assert.strictEqual(f.payload.toString('utf8'), '{"type":"resize","cols":100,"rows":30}');
    // 리플레이/방향 혼동은 null(폐기) — throw 로 소켓을 죽이지 않는다.
    assert.strictEqual(gate.openFrame(hch, first), null);
    const out = hch.seal(Buffer.from('output'), gate.KIND_DATA);
    assert.strictEqual(gate.openFrame(hch, out), null, '자기 방향 프레임을 열어선 안 된다');
    assert.strictEqual(vch.open(out).payload.toString('utf8'), 'output');
  });
});

test('트랜스크립트 바인딩: 서버가 routing 을 바꿔치면 뷰어 검증이 실패한다', async () => {
  const ep = armKeys();
  await withEnv({ CPT_E2EE_SCOPE: 'all' }, async () => {
    const routing = { cwd: 'a', paneId: 'p', win: 7 };
    const { offer, pending } = e2ee.createViewerOffer({ purpose: 'pty', epoch: ep, client: 'c1', routing, hostDeviceId: HOST_DEV });
    // 데몬은 "다른 pane(win 8)" 로 협상됐다 — 서버가 몰래 라우팅을 바꾼 상황.
    const answer = await callBegin({ purpose: 'pty', suite: offer.suite, epoch: ep, pub: offer.pub, nonce: offer.nonce, client: 'c1', routing: { cwd: 'a', paneId: 'p', win: 8 }, hostDeviceId: HOST_DEV });
    assert.throws(() => e2ee.acceptHostAnswer(pending, answer), (e) => e.code === 'E2EE_CONFIRM');
  });
});

test('봉투 RPC: 성공/실패 모두 봉인되고 메서드명·오류문구가 평문으로 새지 않는다', async () => {
  const ep = armKeys();
  await withEnv({ CPT_E2EE_SCOPE: 'rpc' }, async () => {
    const encOpts = { epoch: ep, hostDeviceId: HOST_DEV };
    const seal = (m, p) => e2ee.sealRpc(m, p, encOpts);

    // ① 정상 — fs.unwatch(부작용 없는 멱등 메서드). host 를 명시한 경우.
    const okRes = await callSealed(seal('fs.unwatch', {}), HOST_DEV);
    assert.ok(okRes && okRes.env && okRes.env.ct, '응답이 봉인되지 않았다');
    assert.strictEqual(JSON.stringify(okRes.env).includes('fs.unwatch'), false, '봉투 밖에 메서드명이 보인다');
    assert.deepStrictEqual(e2ee.openRpcResult(okRes.env, encOpts), { ok: true, r: { ok: true } });

    // ② 실패 — 알 수 없는 메서드(fs.handle 이 throw). 오류 문구도 봉인돼야 한다.
    const errRes = await callSealed(seal('nope.nothing', {}), HOST_DEV);
    const openedErr = e2ee.openRpcResult(errRes.env, encOpts);
    assert.strictEqual(openedErr.ok, false);
    assert.ok(openedErr.e && openedErr.e.length > 0, '오류 메시지가 봉투 안에 없다');
    assert.strictEqual(JSON.stringify(errRes.env).includes('nope.nothing'), false, '오류 경로가 평문으로 샜다');

    // ③ 재귀/승격 금지
    await assert.rejects(() => callSealed(seal('sealed', {}), HOST_DEV), (e) => e.code === 'E2EE_BAD_METHOD');
    await assert.rejects(() => callSealed(seal('e2ee.begin', {}), HOST_DEV), (e) => e.code === 'E2EE_BAD_METHOD');

    // ④ 열 수 없는 봉투 = 명확한 실패(평문 처리로 폴스루 금지)
    await assert.rejects(
      () => callSealed({ v: 1, suite: 'cpt-e2ee/v1', epoch: ep, nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' }, HOST_DEV),
      (e) => e.code === 'E2EE_OPEN_FAILED',
    );
  });
});

// ★ 계약 §2.3 — AAD 의 hostDeviceId 는 **클라가 본문에 실은 값(미지정=0)** 이다. 자기 deviceId 로 열려고
//  하면 "활성 러너 위임"(host 미지정) 호출이 100% 복호 실패하고, 클라는 그것을 "서버 미지원"으로 캐시해
//  평문으로 내려간다 = 잠금 배지는 켜져 있고 트래픽은 평문(결함 #8 동형). 여기서 바이트 형태로 고정한다.
test('봉투 AAD: host 미지정(=0)과 명시(=self) 둘 다 왕복 + 다른 host 지정은 거절', async () => {
  const ep = armKeys();
  await withEnv({ CPT_E2EE_SCOPE: 'rpc' }, async () => {
    // ① 미지정 — 앱은 `hostDeviceId: host ?? null` 로 봉인하고 null 은 AAD 에서 u32(0) 이다.
    //  back 은 그 경우 params 에 필드를 넣지 않는다 → 데몬은 0 으로 재구성해야 한다.
    const zeroOpts = { epoch: ep, hostDeviceId: 0 };
    const r0 = await callSealed(e2ee.sealRpc('fs.unwatch', {}, zeroOpts) /* host 미지정 */);
    assert.deepStrictEqual(e2ee.openRpcResult(r0.env, zeroOpts), { ok: true, r: { ok: true } },
      '응답도 같은 AAD(0)로 봉인돼야 뷰어가 열 수 있다');

    // ② 명시 — self 와 같으면 통과(위 테스트가 이미 증명하지만 대칭을 여기서 한 번 더 못박는다)
    const selfOpts = { epoch: ep, hostDeviceId: HOST_DEV };
    const r1 = await callSealed(e2ee.sealRpc('fs.unwatch', {}, selfOpts), HOST_DEV);
    assert.deepStrictEqual(e2ee.openRpcResult(r1.env, selfOpts), { ok: true, r: { ok: true } });

    // ③ 다른 기기로 지정된 봉투 = 서버가 몰래 라우팅한 경우 → 거절(beginHost 의 같은 가드 미러).
    await assert.rejects(
      () => callSealed(e2ee.sealRpc('fs.unwatch', {}, { epoch: ep, hostDeviceId: HOST_DEV + 1 }), HOST_DEV + 1),
      (e) => e.code === 'E2EE_HOST_MISMATCH',
    );

    // ④ AAD 가 어긋나면(0 으로 봉인 + host 명시) 복호 실패로 떨어진다 — 평문 폴스루 금지.
    await assert.rejects(
      () => callSealed(e2ee.sealRpc('fs.unwatch', {}, zeroOpts), HOST_DEV),
      (e) => e.code === 'E2EE_OPEN_FAILED',
    );
  });
});

test('킬스위치 상태에서는 봉투 RPC·협상 자체가 거절된다(즉시 원복 가능)', async () => {
  armKeys();
  await withEnv({ CPT_E2EE_SCOPE: 'all', CPT_E2EE: '0' }, async () => {
    await assert.rejects(() => callSealed({}), (e) => e.code === 'E2EE_UNSUPPORTED');
    await assert.rejects(() => callBegin({ purpose: 'pty' }), (e) => e.code === 'E2EE_UNSUPPORTED');
  });
});

test('스냅샷: 헤더 자기서술 + 평문 옛 번들 통과 + 서버 cap 게이팅 + 열쇠 없으면 명확한 실패', () => {
  const sync = require('../sync');
  const snap = sync.__snapshot;
  const body = Buffer.from('PACK... git bundle bytes ...', 'utf8');
  const ep = armKeys();

  // 기본 스코프(rpc)에서는 스냅샷을 건드리지 않는다(단계 분리).
  withEnv({ CPT_E2EE_SCOPE: 'rpc' }, () => {
    const r = snap.maybeSealSnapshot(body, '번들');
    assert.strictEqual(r.enc, null);
    assert.ok(r.buf.equals(body));
  });

  const origHasCap = control.hasServerCap;
  try {
    // 서버가 능력을 선언하지 않으면(구 back) 평문 유지 — 구 데몬이 복원 못 하는 사고 방지.
    control.hasServerCap = () => false;
    withEnv({ CPT_E2EE_SCOPE: 'all' }, () => {
      assert.strictEqual(snap.maybeSealSnapshot(body, '번들').enc, null);
    });
    control.hasServerCap = (c) => c === 'e2ee.snap.v1';
    withEnv({ CPT_E2EE_SCOPE: 'all' }, () => {
      const r = snap.maybeSealSnapshot(body, '번들');
      assert.strictEqual(r.enc, 'cptsnap/1');
      assert.strictEqual(r.epoch, ep);
      assert.ok(snap.isSealedSnapshot(r.buf), 'CPTS1 헤더가 아니다');
      assert.ok(!r.buf.toString('latin1').includes('git bundle bytes'), '봉인 결과에 평문이 남았다');
      // 복호 왕복 + 평문 옛 번들은 그대로 통과(하위호환).
      assert.ok(snap.openSnapshotBuf(r.buf).equals(body));
      assert.ok(snap.openSnapshotBuf(body).equals(body));
      // 열쇠가 없으면(다른 계정/미승인 기기) 빈 결과가 아니라 명확한 실패.
      //  ⚠ 파생키 캐시(_acctCache)까지 비워야 "열쇠 없음"이 재현된다(clearCache).
      e2ee.removeState();
      e2ee.clearCache();
      assert.throws(() => snap.openSnapshotBuf(r.buf), /E2EE_NO_KEY|암호화|열쇠/);
      armKeys();
    });
  } finally { control.hasServerCap = origHasCap; }
});
