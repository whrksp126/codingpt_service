// back ↔ 데몬 E2EE 바이트 계약 교차 검증 — node --test
//
// 왜 이 파일이 필요한가:
//  grant 서명 대상 바이트열은 **승인자(다른 기기)가 만들고 서버가 검증**한다. 즉 두 구현이 바이트
//  단위로 같아야만 동작하는데, 각 리포의 단위 테스트는 **자기 구현으로 만들어 자기 구현으로 검증**하므로
//  불일치를 절대 잡지 못한다. 실제로 그 상태였다:
//    back    : utf8("cpt-e2ee/v1/grant") ‖ 0x00 ‖ utf8("2") ‖ 0x00 ‖ ikX ‖ sha256(sealed)   (84B)
//    데몬/앱 : utf8("cpt-e2ee/v1/grant") ‖ u32BE(2)          ‖ ikX ‖ sha256(sealed)          (85B)
//  → 서버 검증이 전부 실패해서 **열쇠가 단 한 대도 배포되지 않는데** 양쪽 테스트는 모두 초록이었다.
//  (기능 전체가 조용히 죽고, 게이팅 때문에 "안전한 평문 폴백"으로 위장된다 — 발견이 가장 늦는 유형)
//
// 그래서 이 테스트는 **데몬 구현으로 서명을 만들어 back 구현으로 검증**한다(양방향).
// 두 리포가 같은 머신에 있는 모노레포 구조를 이용한다. 데몬 모듈이 없으면 skip(CI 환경 대비).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

const DAEMON_E2EE = path.resolve(__dirname, '../../codingpt_daemon/packages/runner-core/e2ee.js');

function loadDaemon() {
  try {
    // 데몬 e2ee 는 runtime.init 없이도 순수 함수(서명/봉인)는 쓸 수 있다.
    const runtime = require(path.resolve(__dirname, '../../codingpt_daemon/packages/runner-core/runtime.js'));
    const os = require('os');
    const fs = require('fs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-xi-'));
    runtime.init({ root, stateDir: path.join(root, '.codingpt') });
    return require(DAEMON_E2EE);
  } catch (_) { return null; }
}

test('grant 서명 바이트 — 데몬이 만든 서명을 back 이 검증한다', (t) => {
  const dm = loadDaemon();
  if (!dm) return t.skip('데몬 모듈 없음(단일 리포 CI)');
  const trust = require('../services/deviceTrustService');
  if (typeof trust._verifyGrantSig !== 'function') {
    return t.skip('deviceTrustService 가 _verifyGrantSig 를 노출하지 않음 — 노출해야 이 계약을 지킬 수 있다');
  }

  // 승인자(기존 신뢰 기기) 신원 + 수신자(새 기기) 공개키
  const approver = { x: dm.genX25519(), ed: dm.genEd25519() };
  const recipient = dm.genX25519();
  const mk = crypto.randomBytes(32);
  const epoch = 2;

  // 데몬 구현으로 MK 봉인 + 서명(= 실제 승인자가 하는 일)
  const g = dm.sealTo(recipient.pub, { epoch, mk, ikEdPriv: approver.ed.priv });

  // back 구현으로 검증(= 실제 서버가 하는 일)
  const ok = trust._verifyGrantSig({
    epoch,
    ikXRaw: recipient.pub,
    sealedRaw: Buffer.from(g.sealed, 'base64url'),
    sigRaw: Buffer.from(g.sig, 'base64url'),
    approverIkEdRaw: approver.ed.pub,
  });
  assert.strictEqual(ok, true,
    'back 이 데몬 서명을 거절했다 — grantSigMessage 바이트열이 갈라졌다(epoch 인코딩 확인: u32BE 가 정본)');

  // 반증: epoch 를 바꾸면 반드시 거절돼야 한다(검증이 실제로 동작하는지 확인)
  assert.strictEqual(trust._verifyGrantSig({
    epoch: epoch + 1,
    ikXRaw: recipient.pub,
    sealedRaw: Buffer.from(g.sealed, 'base64url'),
    sigRaw: Buffer.from(g.sig, 'base64url'),
    approverIkEdRaw: approver.ed.pub,
  }), false, 'epoch 변조가 통과하면 검증이 무의미하다');

  // 반증: 다른 수신자 키로도 거절
  assert.strictEqual(trust._verifyGrantSig({
    epoch,
    ikXRaw: dm.genX25519().pub,
    sealedRaw: Buffer.from(g.sealed, 'base64url'),
    sigRaw: Buffer.from(g.sig, 'base64url'),
    approverIkEdRaw: approver.ed.pub,
  }), false, '수신자 키 바꿔치기가 통과하면 서버가 봉인 대상을 검증하지 못한다');
});

test('표시 지문 — back 과 데몬이 같은 값을 낸다', (t) => {
  const dm = loadDaemon();
  if (!dm) return t.skip('데몬 모듈 없음');
  const trust = require('../services/deviceTrustService');
  if (typeof trust._fingerprintOf !== 'function') {
    return t.skip('deviceTrustService 가 _fingerprintOf 를 노출하지 않음');
  }
  const ikX = dm.genX25519().pub;
  const userId = 4242;
  const a = dm.fingerprint(ikX, userId);
  const b = trust._fingerprintOf(userId, ikX);
  assert.strictEqual(b.safetyCode, a.safety,
    '사용자가 두 화면에서 비교하는 값이 서로 다르면 대조 자체가 불가능하다');
  assert.strictEqual(b.verifyCode, a.short);
  // 60비트 표기 확인 — 짧은 숫자는 오프라인 그라인딩으로 뚫린다(실측 4자리 1.3초).
  assert.match(a.safety, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

// ── 안전코드 파생 기준(userRef) 배관 — 2026-07-26 실기기 사고 회귀 고정 ──────────────
//  사고: 안전코드·지문은 HKDF(ikX, userRef) 로 파생하는데 **back 이 userRef 를 한 번도 보내지
//  않았다**. 데몬/PC 는 `/api/daemon/me` 의 id 를 쓰고 앱은 서버 필드를 기다렸으므로, 같은 기기에
//  대해 데몬은 `0727`·앱은 `8212` 를 계산했다 = **폰↔PC 대조가 처음부터 성립하지 않았다**.
//  (실측: prod 로그 `[e2ee] 등록 신청 … code=0727`, 앱 화면 "직접 계산한 값과 달랐습니다")
//  아래 두 테스트는 ① 모든 e2ee 응답에 userRef 가 실리는가 ② 그 값으로 3구현체 파생이 일치하는가.
const dtController = require('../controllers/deviceTrustController');

test('e2ee 컨트롤러 — 모든 응답에 userRef 가 실린다(안전코드 파생 기준)', async () => {
  const HANDLERS = ['enroll', 'bootstrap', 'pending', 'approve', 'deny', 'keyring', 'rotate', 'policy', 'recovery'];
  for (const name of HANDLERS) {
    assert.equal(typeof dtController[name], 'function', `${name} 핸들러가 있어야 한다`);
  }
  // 서비스는 스텁하고 컨트롤러의 응답 성형만 본다(서비스 계층은 별도 테스트 대상).
  const svc = require('../services/deviceTrustService');
  const saved = {};
  const stub = { enroll: 'enroll', bootstrap: 'bootstrap', listPending: 'pending', approve: 'approve',
    deny: 'deny', keyring: 'keyring', rotate: 'rotate', setPolicy: 'policy', setRecovery: 'recovery' };
  for (const k of Object.keys(stub)) { saved[k] = svc[k]; svc[k] = async () => ({ state: 'trusted' }); }
  try {
    for (const name of HANDLERS) {
      let body = null;
      const res = { status() { return this; }, json(b) { body = b; return this; } };
      const req = { account: { userId: 43, deviceId: 7 }, body: {}, query: {}, headers: {}, ip: '10.0.0.2' };
      await dtController[name](req, res);
      const data = body && (body.data !== undefined ? body.data : body);
      assert.ok(data && typeof data === 'object', `${name}: 응답 본문이 객체여야 한다`);
      // successResponse 는 data 를 최상위로 펼친다(back 관습) — 어느 형태든 userRef 가 보여야 한다.
      const ref = data.userRef !== undefined ? data.userRef : (body || {}).userRef;
      assert.equal(ref, '43', `${name}: userRef 가 문자열 userId 로 실려야 한다`);
    }
  } finally {
    for (const k of Object.keys(saved)) svc[k] = saved[k];
  }
});

test('e2ee 안전코드 — back 이 준 userRef 로 데몬·PC 파생이 일치한다', async () => {
  const path2 = require('path');
  const daemonE2ee = require(path2.resolve(__dirname, '../../codingpt_daemon/packages/runner-core/e2ee.js'));
  // 실기기에서 실제로 등록 신청한 기기의 공개키(공개값이라 비밀 아님) — 그때 서버 로그가 code=0727.
  const ikX = Buffer.from('l_GQNh6mKArY_U9nx4ck3c5ifVp0qytXo4M7SJBoHxo'.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ref = '43'; // = String(userId) = back 이 이제 응답에 싣는 값
  const f = daemonE2ee.fingerprint(ikX, ref);
  assert.equal(f.short, '0727', '데몬 파생이 prod 실측 code 와 같아야 한다');
  assert.equal(f.safety, 'P2MK-240X-FYC7', '60비트 안전코드(사람이 대조하는 유일한 값)');
  // ref 가 비면 **완전히 다른 값**이 나온다 — 그래서 back 이 반드시 보내야 한다는 것이 이 테스트의 요지.
  assert.notEqual(daemonE2ee.fingerprint(ikX, '').short, f.short);
});
