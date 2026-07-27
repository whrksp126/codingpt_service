// 계정 열쇠 클라이언트(기능2 2b) 계약 테스트 — node --test
//   실행: CPT_SHIM_NO_GLOBAL_LINK=1 node --test packages/runner-core/test/e2ee-account.test.js
//
// 정본: docs/구현설계-2026-07-25/11-배관-계약.md §2.6 / 기능2-E2EE.md §3
//
// 이 파일이 증명하는 것(하나라도 깨지면 E2EE 는 "암호화된 척하는 평문" 으로 되돌아간다)
//  1. enroll → 승인 대기 → (다른 기기 승인) → keyring 폴링 → 봉인문 수령 → **MK 획득**
//     → `e2ee-gate.caps()` 가 **빈 배열이 아니다**(이 라운드 전에는 영구히 [] 였다).
//  2. 열쇠가 없을 때 봉투 RPC 는 `E2EE_NO_KEY` 로 회신한다(E2EE_OPEN_FAILED 로 뭉개지 않는다).
//  3. 계정에 열쇠가 없으면(state:'bootstrap') 데몬은 **자기가 만들지 않는다** — /e2ee/bootstrap 호출 0건.
//  4. 상태 파일은 기존 경로(`<stateDir>/e2ee.json`) 하나이고 권한은 **0600**(fs.statSync 로 실측).
//  5. MK 는 로그·서버 요청 본문 어디에도 나타나지 않는다(실제 문자열 grep).
//  6. 폴링은 지수 백오프 + 상한(부팅/재접속 폭주 금지 — "데몬 2초 재연결 폭주" 사고 이력).
//  7. 회전(rotate)에서 새 봉인문을 수령하고 보관 세대를 넘긴 옛 MK 는 정리된다.
//
// 가짜 back 은 **codingpt_back 실물 코드의 형태를 그대로 흉내**낸다(근거 파일:줄)
//  · successResponse = data 를 최상위 (utils/response.js:11) — 래퍼 없음
//  · errorResponse   = { success:false, message, detail:{code} } (:18-28)
//  · enroll 응답 3형태 (services/deviceTrustService.js:341-343, 360-364, 371, 398)
//  · keyring 응답     (:624-630)  · publicKeyRow(:255-263) · publicGrant(:252-254)
//  · approve 검증     (:546-581)  — ikX 에코 / approverIkX trusted / epoch / Ed25519 서명
//  · rotate 검증      (:651-698)  — INCOMPLETE_ROTATION(남는 기기 전부 재봉인)
//  · grant 서명 바이트열 = "cpt-e2ee/v1/grant" ‖ u32BE(epoch) ‖ ikX(32B) ‖ SHA256(sealed) (:142-151)

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

// ── 격리(require 전에!) — 실사용 ~/.codingpt / 실 tmux 무접촉 ──────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2ee-acct-'));
const STATE = path.join(ROOT, '.codingpt');
process.env.HOME = ROOT;                      // HOME 격리(홈 기반 기본값이 새지 않게)
process.env.CODINGPT_TMUX_SOCKET = `codingpt-e2acct-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_E2EE_KEEP_EPOCHS = '2';       // 보관 세대 상한을 실측하려고 좁힌다(기본 8)
process.env.CPT_LAN_SCOPE = 'off';            // hello 프레임 검사에서 LAN 모듈이 포트를 건드리지 않게
delete process.env.CPT_E2EE;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

const e2ee = require('../e2ee');
const gate = require('../e2ee-gate');
const control = require('../control');
const account = require('../e2ee-account');

assert.ok(require('../config').e2eeFile().startsWith(ROOT), '격리 stateDir 미적용 — 중단');

const USER_ID = 7;
const SELF_DEV = 12;

// ── 로그 캡처(MK 유출 grep 용) ───────────────────────────────────────────────
const logs = [];
const realLog = console.log;
const realWarn = console.warn;
const realErr = console.error;
function captureLogs() {
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push(a.map(String).join(' '));
}
function releaseLogs() { console.log = realLog; console.warn = realWarn; console.error = realErr; }
captureLogs();

// ── 가짜 계정(=objectstore keyring.json 미러) ────────────────────────────────
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const b64u = (b) => Buffer.from(b).toString('base64url');
const raw = (s) => Buffer.from(String(s), 'base64url');

function newDevice(label, platform, kind) {
  const x = e2ee.genX25519();
  const ed = e2ee.genEd25519();
  return { label, platform, kind, ikX: b64u(x.pub), ikEd: b64u(ed.pub), xPriv: x.priv, edPriv: ed.priv };
}
const phone = newDevice('내 폰', 'android', 'controller');   // 계정 최초 기기(사람이 앱에서 부트스트랩)
const tablet = newDevice('아이패드', 'ios', 'controller');    // 나중에 데몬이 승인해 줄 기기
let MK = e2ee.randomBytes(32);                               // 계정 마스터키(현재 세대) — 폰이 보관

const acct = { epoch: 0, policy: 'preferred', keys: [], grants: [], nextKeyId: 1, recovery: null };
const pendings = new Map();  // enrollmentId → {ikX, ikEd, label, platform, kind, requestedAt}
let enrollSeq = 0;

// back deviceTrustService.grantSigMessage(:142-151) 를 **독립적으로** 재구현(바이트 계약 고정).
function grantSigMsg(epoch, ikXRaw, sealedRaw) {
  return Buffer.concat([Buffer.from('cpt-e2ee/v1/grant', 'utf8'), u32(Number(epoch)), Buffer.from(ikXRaw), e2ee.sha256(sealedRaw)]);
}
function verifyGrantSig({ epoch, ikX, sealed, sig, approverIkEd }) {
  return e2ee.verify(raw(approverIkEd), grantSigMsg(epoch, raw(ikX), raw(sealed)), sig);
}
function fpOf(ikX) { return e2ee.fingerprint(ikX, String(USER_ID)); }
function publicKeyRow(row) {
  const fp = fpOf(row.ikX);
  return {
    keyId: row.keyId, label: row.label, platform: row.platform, kind: row.kind,
    deviceId: row.deviceId ?? null, state: row.state, ikX: row.ikX, ikEd: row.ikEd,
    fingerprint: fp.legacy, verifyCode: fp.short,
    enrolledAt: row.enrolledAt, revokedAt: row.revokedAt || null, lastGrantEpoch: row.lastGrantEpoch ?? null,
  };
}
const publicGrant = (g) => (g ? { epoch: g.epoch, sealed: g.sealed, sealedByKeyId: g.sealedByKeyId, sig: g.sig, createdAt: g.createdAt } : null);
const keyByIkX = (ikX) => acct.keys.find((k) => k.ikX === ikX) || null;
const grantFor = (epoch, keyId) => acct.grants.find((g) => g.epoch === epoch && g.recipientKeyId === keyId) || null;
const trusted = () => acct.keys.filter((k) => k.state === 'trusted');
function publicPending(id, rec) {
  const fp = fpOf(rec.ikX);
  return {
    enrollmentId: id, label: rec.label, platform: rec.platform, deviceKind: rec.kind,
    ikX: rec.ikX, ikEd: rec.ikEd, verifyCode: fp.short, fingerprint: fp.legacy,
    requestedAt: new Date(rec.requestedAt).toISOString(),
    expiresAt: new Date(rec.requestedAt + 600000).toISOString(), requestIp: '10.0.1.*',
  };
}

/** 폰이 승인해 주는 것을 시뮬레이션 — MK 를 대상 공개키로 봉인하고 키링에 grant 를 넣는다. */
function phoneApproves(ikX, meta, epoch = acct.epoch, mk = MK) {
  const s = e2ee.sealTo(ikX, { epoch, mk, ikEdPriv: phone.edPriv, ikEdPub: phone.ikEd });
  let row = keyByIkX(ikX);
  if (!row) {
    row = {
      keyId: acct.nextKeyId++, ikX, ikEd: meta.ikEd, label: meta.label, platform: meta.platform,
      kind: meta.kind || 'host', deviceId: null, state: 'trusted',
      enrolledAt: new Date().toISOString(), revokedAt: null, lastGrantEpoch: epoch,
    };
    acct.keys.push(row);
  }
  row.state = 'trusted';
  row.lastGrantEpoch = epoch;
  acct.grants.push({ epoch, recipientKeyId: row.keyId, sealed: s.sealed, sealedByKeyId: phoneKeyId(), sig: s.sig, createdAt: new Date().toISOString() });
  for (const [id, rec] of pendings) if (rec.ikX === ikX) pendings.delete(id);
  return row;
}
const phoneKeyId = () => (keyByIkX(phone.ikX) || { keyId: 1 }).keyId;

// ── 가짜 back HTTP ───────────────────────────────────────────────────────────
const hits = [];
let denySig = false;        // 서명 검증 강제 실패(위조 grant 거부 계약)
let rotateReject = null;    // {status, code} — 회전 업로드 실패 시 로컬 롤백 계약

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const failJson = (res, status, code, message) => sendJson(res, status, { success: false, message, detail: { code }, timestamp: new Date().toISOString() });

const back = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch (_) { json = null; }
    const url = req.url.split('?')[0];
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    hits.push({ url, method: req.method, body: json, rawBody: body, auth: req.headers.authorization });

    if (url === '/api/daemon/me') {
      return sendJson(res, 200, { id: USER_ID, email: 't@example.com', nickname: 't', profileImg: null, role: 'user', appearance: null, deviceId: SELF_DEV, deviceName: 'T' });
    }

    // POST /e2ee/enroll (deviceTrustService.enroll)
    if (url === '/api/daemon/e2ee/enroll') {
      const ikX = String((json || {}).ikX || '');
      const existing = keyByIkX(ikX);
      if (existing && existing.state === 'trusted') {
        return sendJson(res, 200, {
          state: 'trusted', epoch: acct.epoch, keyId: existing.keyId, policy: acct.policy,
          grant: publicGrant(grantFor(acct.epoch, existing.keyId)), recoverySet: !!acct.recovery,
        });
      }
      if (existing && existing.state === 'revoked') return failJson(res, 409, 'KEY_REVOKED', '이 기기의 열쇠는 해제되었습니다.');
      if (acct.epoch === 0 && trusted().length === 0) {
        return sendJson(res, 200, { state: 'bootstrap', epoch: 0, policy: acct.policy, suite: 'cpt-e2ee/v1' });
      }
      for (const [id, rec] of pendings) {
        if (rec.ikX === ikX) return sendJson(res, 200, { state: 'pending', ...publicPending(id, rec), policy: acct.policy });
      }
      const id = `e_${(++enrollSeq).toString().padStart(4, '0')}`;
      pendings.set(id, {
        ikX, ikEd: String((json || {}).ikEd || ''), label: String((json || {}).label || '기기'),
        platform: (json || {}).platform || null, kind: (json || {}).kind || 'controller', requestedAt: Date.now(),
      });
      return sendJson(res, 200, { state: 'pending', ...publicPending(id, pendings.get(id)), policy: acct.policy });
    }

    // GET /e2ee/pending
    if (url === '/api/daemon/e2ee/pending') {
      return sendJson(res, 200, {
        pending: [...pendings.entries()].map(([id, rec]) => publicPending(id, rec)),
        epoch: acct.epoch, policy: acct.policy, trustedCount: trusted().length,
      });
    }

    // GET /e2ee/keyring?ikX=
    if (url === '/api/daemon/e2ee/keyring') {
      const ikX = q.get('ikX') || '';
      let myKeyId = null; let myState = 'unknown'; let myGrant = null;
      const row = ikX ? keyByIkX(ikX) : null;
      if (row) { myKeyId = row.keyId; myState = row.state; myGrant = publicGrant(grantFor(acct.epoch, row.keyId)); }
      else if (ikX) myState = [...pendings.values()].some((p) => p.ikX === ikX) ? 'pending' : 'unknown';
      return sendJson(res, 200, {
        epoch: acct.epoch, policy: acct.policy, suite: 'cpt-e2ee/v1', recoverySet: !!acct.recovery,
        devices: acct.keys.map(publicKeyRow),
        grants: acct.grants.filter((g) => g.epoch === acct.epoch).map((g) => ({ ...publicGrant(g), recipientKeyId: g.recipientKeyId })),
        myKeyId, myState, myGrant,
      });
    }

    // POST /e2ee/approve
    if (url === '/api/daemon/e2ee/approve') {
      const b = json || {};
      const rec = pendings.get(String(b.enrollmentId || ''));
      if (!rec) return failJson(res, 404, 'NOT_FOUND', '승인 요청을 찾을 수 없습니다.');
      if (rec.ikX !== b.ikX) return failJson(res, 409, 'KEY_MISMATCH', '기기 공개키가 일치하지 않습니다.');
      const approver = keyByIkX(String(b.approverIkX || ''));
      if (!approver || approver.state !== 'trusted') return failJson(res, 403, 'NOT_TRUSTED', '승인은 이미 신뢰된 기기에서만 할 수 있습니다.');
      if (Number(b.epoch) !== acct.epoch) return failJson(res, 409, 'EPOCH_MISMATCH', '열쇠 세대가 달라졌습니다.');
      if (denySig || !verifyGrantSig({ epoch: acct.epoch, ikX: b.ikX, sealed: b.sealed, sig: b.sig, approverIkEd: approver.ikEd })) {
        return failJson(res, 400, 'SIG_INVALID', '봉인문 서명 검증에 실패했습니다.');
      }
      const keyId = acct.nextKeyId++;
      acct.keys.push({
        keyId, ikX: rec.ikX, ikEd: rec.ikEd, label: rec.label, platform: rec.platform, kind: rec.kind,
        deviceId: null, state: 'trusted', enrolledAt: new Date().toISOString(), revokedAt: null, lastGrantEpoch: acct.epoch,
      });
      acct.grants.push({ epoch: acct.epoch, recipientKeyId: keyId, sealed: b.sealed, sealedByKeyId: approver.keyId, sig: b.sig, createdAt: new Date().toISOString() });
      pendings.delete(String(b.enrollmentId));
      return sendJson(res, 200, { ok: true, keyId, epoch: acct.epoch });
    }

    if (url === '/api/daemon/e2ee/deny') {
      const id = String((json || {}).enrollmentId || '');
      if (!pendings.has(id)) return failJson(res, 404, 'NOT_FOUND', '승인 요청을 찾을 수 없습니다.');
      pendings.delete(id);
      return sendJson(res, 200, { ok: true });
    }

    // POST /e2ee/rotate
    if (url === '/api/daemon/e2ee/rotate') {
      if (rotateReject) return failJson(res, rotateReject.status, rotateReject.code, '회전 거절(테스트)');
      const b = json || {};
      const approver = keyByIkX(String(b.approverIkX || ''));
      if (!approver || approver.state !== 'trusted') return failJson(res, 403, 'NOT_TRUSTED', '회전은 신뢰된 기기에서만 할 수 있습니다.');
      if (Number(b.fromEpoch) !== acct.epoch) return failJson(res, 409, 'EPOCH_MISMATCH', '열쇠 세대가 달라졌습니다.');
      if (Number(b.toEpoch) !== acct.epoch + 1) return failJson(res, 400, 'BAD_EPOCH', 'toEpoch 는 fromEpoch + 1 이어야 합니다.');
      const revoke = new Set((Array.isArray(b.revokeKeyIds) ? b.revokeKeyIds : []).map(Number));
      const seen = new Map();
      for (const g of (Array.isArray(b.grants) ? b.grants : [])) {
        const keyId = Number(g.keyId);
        const row = acct.keys.find((k) => k.keyId === keyId && k.state === 'trusted');
        if (!row) return failJson(res, 400, 'UNKNOWN_KEY', `알 수 없는 keyId(${keyId})`);
        if (row.ikX !== g.ikX) return failJson(res, 409, 'KEY_MISMATCH', '공개키가 일치하지 않습니다.');
        if (!verifyGrantSig({ epoch: Number(b.toEpoch), ikX: g.ikX, sealed: g.sealed, sig: g.sig, approverIkEd: approver.ikEd })) {
          return failJson(res, 400, 'SIG_INVALID', '봉인문 서명 검증 실패');
        }
        seen.set(keyId, g);
      }
      const remaining = acct.keys.filter((k) => k.state === 'trusted' && !revoke.has(k.keyId));
      const missing = remaining.filter((k) => !seen.has(k.keyId)).map((k) => k.keyId);
      if (missing.length) return failJson(res, 400, 'INCOMPLETE_ROTATION', '남아 있는 기기 전부에 새 봉인문이 필요합니다.');
      for (const keyId of revoke) {
        const row = acct.keys.find((k) => k.keyId === keyId);
        if (row) { row.state = 'revoked'; row.revokedAt = new Date().toISOString(); }
      }
      acct.epoch = Number(b.toEpoch);
      for (const [keyId, g] of seen) {
        acct.grants.push({ epoch: acct.epoch, recipientKeyId: keyId, sealed: g.sealed, sealedByKeyId: approver.keyId, sig: g.sig, createdAt: new Date().toISOString() });
        const row = acct.keys.find((k) => k.keyId === keyId);
        if (row) row.lastGrantEpoch = acct.epoch;
      }
      return sendJson(res, 200, { epoch: acct.epoch, resealed: seen.size, revoked: [...revoke] });
    }

    if (url === '/api/daemon/e2ee/policy') {
      const p = String((json || {}).policy || '');
      acct.policy = p;
      return sendJson(res, 200, { policy: p, epoch: acct.epoch });
    }

    if (url === '/api/daemon/e2ee/bootstrap') {
      // 이 테스트에서 이 라우트가 **호출되는 것 자체가 계약 위반**이다(데몬 자동 부트스트랩 금지).
      return sendJson(res, 200, { epoch: 1, keyId: 1, policy: acct.policy, recoverySet: false });
    }

    return sendJson(res, 404, { success: false, message: 'Not Found' });
  });
});

const hellos = [];   // 열쇠 변화 시 재신고된 hello 프레임(control.announceHello 배선 대역)
const urls = () => hits.map((h) => h.url);
const countOf = (u) => hits.filter((h) => h.url === u).length;
const stateFile = () => require('../config').e2eeFile();

test('setup — 격리 stateDir + 가짜 back + daemon.json', async () => {
  await new Promise((r) => back.listen(0, '127.0.0.1', r));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({
    serverUrl: `http://127.0.0.1:${back.address().port}`, deviceToken: 'cptd_test', deviceName: 'MacTest', deviceId: SELF_DEV,
  }), { mode: 0o600 });
  assert.ok(stateFile().startsWith(ROOT));
});

after(async () => {
  releaseLogs();
  try { account.stop(); } catch (_) { /* noop */ }
  await new Promise((r) => back.close(r));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ══════════════════════════════════════════════════════════════════════════
//  0. 출발점 — 열쇠 0개 = caps 공집합 = 봉투 RPC 는 E2EE_NO_KEY
// ══════════════════════════════════════════════════════════════════════════

const callSealed = (env, hostDeviceId) => new Promise((res, rej) => control.handleSealedRpc(
  { readyState: 1, send() {} },
  { env, ...(hostDeviceId === undefined ? {} : { hostDeviceId }) }, res, rej,
));

test('0. 열쇠 없음: caps=[] + 봉투 RPC 는 E2EE_NO_KEY(뭉개지 않는다)', async () => {
  gate.resetCache();
  assert.strictEqual(e2ee.hasKey(), false);
  assert.deepStrictEqual(gate.caps(), [], '열쇠가 없는데 e2ee 능력을 선언하면 서버/앱이 봉인을 보낸다');
  assert.strictEqual(gate.epoch(), 0);
  await assert.rejects(
    () => callSealed({ v: 1, suite: 'cpt-e2ee/v1', epoch: 1, nonce: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAA' }, SELF_DEV),
    (e) => e.code === 'E2EE_NO_KEY',
    'E2EE_OPEN_FAILED/EPOCH_MISMATCH 로 뭉개면 back 이 502 로 올려 앱이 "일시 장애" 로 오인한다',
  );
});

// ══════════════════════════════════════════════════════════════════════════
//  1. 계정에 열쇠가 없을 때 — 데몬은 스스로 신뢰 기점을 만들지 않는다
// ══════════════════════════════════════════════════════════════════════════

test('1. state:bootstrap → 데몬은 /e2ee/bootstrap 을 부르지 않고 사람을 기다린다', async () => {
  account._reset();
  const r = await account.runOnce();
  account.stop();
  assert.strictEqual(r.phase, 'bootstrap');
  assert.strictEqual(countOf('/api/daemon/e2ee/bootstrap'), 0, '데몬이 사용자 대신 신뢰 기점을 세우면 승인 UX 가 무의미해진다');
  const s = await account.state();
  account.stop();
  assert.strictEqual(s.keyState, 'none');
  // 2026-07-26 개정(계약 §2.4): 사람이 폰에서 켜 줄 때까지는 **확정 평문**이므로 'none'(PC "열쇠 없음")
  //  으로 나간다. 'bootstrap'(노란 "준비 중")은 실제로 왕복 중(checking)일 때만 쓴다.
  assert.strictEqual(s.state, 'none');
  assert.strictEqual(s.checking, false);
  // ★ 개정 4(2026-07-27): 부트스트랩은 사람이 보는 앱 표면이 **자동** 수행한다 — 수동 지시("폰에서
  //  켜 주세요")는 거짓 안내가 됐다. reason 은 진행형 + 평문 폴백 고지를 유지한다.
  assert.match(s.reason || '', /준비하는 중/, '자동 부트스트랩 진행을 알려야 한다(수동 지시 금지)');
  assert.match(s.reason || '', /평문/, '그동안 평문으로 동작한다는 정직성 고지는 유지한다');
  assert.strictEqual(s.userRef, String(USER_ID), 'userRef 는 /api/daemon/me 로 채운다(back 이 아직 안 싣는다)');
  // 신원키는 이 단계에서 이미 만들어져 있어야 한다(멱등) — 파일 권한도 여기서 확정된다.
  assert.strictEqual(fs.statSync(stateFile()).mode & 0o777, 0o600, 'e2ee.json 권한이 0600 이 아니다');
});

// ══════════════════════════════════════════════════════════════════════════
//  2. enroll → pending → 승인 → keyring → MK 획득 → caps 성립
// ══════════════════════════════════════════════════════════════════════════

test('2-A. 계정 최초 기기(폰)가 생긴 뒤 enroll = 승인 대기 등록(멱등)', async () => {
  // 사람이 폰에서 E2EE 를 켠 상태를 만든다(앱이 /e2ee/bootstrap 으로 MK_1 자가 생성).
  acct.epoch = 1;
  acct.keys.push({
    keyId: acct.nextKeyId++, ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, platform: phone.platform,
    kind: 'controller', deviceId: 99, state: 'trusted', enrolledAt: new Date().toISOString(), revokedAt: null, lastGrantEpoch: 1,
  });
  const selfSeal = e2ee.sealTo(phone.ikX, { epoch: 1, mk: MK, ikEdPriv: phone.edPriv, ikEdPub: phone.ikEd });
  acct.grants.push({ epoch: 1, recipientKeyId: phoneKeyId(), sealed: selfSeal.sealed, sealedByKeyId: phoneKeyId(), sig: selfSeal.sig, createdAt: new Date().toISOString() });

  account._reset();
  // 열쇠 변화 → control 이 같은 소켓으로 hello 를 다시 신고하는 배선(caps·e2eeEpoch 즉시 반영).
  account.start({ onKeyChange: () => { hellos.push(control.helloFrame({ deviceName: 'MacTest', daemonVersion: 'test' })); return true; } });
  account.stop();
  const r1 = await account.runOnce();
  account.stop();
  assert.strictEqual(r1.phase, 'pending');
  assert.ok(r1.enrollmentId, 'enrollmentId 가 없으면 승인 화면이 어느 요청인지 못 짚는다');
  assert.strictEqual(e2ee.hasKey(), false, '아직 열쇠는 없다');

  const before = countOf('/api/daemon/e2ee/enroll');
  const r2 = await account.runOnce();     // 대기 중 재폴링
  account.stop();
  assert.strictEqual(r2.phase, 'pending');
  assert.strictEqual(countOf('/api/daemon/e2ee/enroll'), before,
    '대기 중 enroll 재호출은 back 이 팬아웃(알림/시트)을 다시 쏘므로 금지 — 확인은 keyring 폴링으로');
  assert.ok(countOf('/api/daemon/e2ee/keyring') >= 1, '대기 중에는 내 봉인문이 올라왔는지 keyring 으로 확인한다');

  const s = await account.state();
  account.stop();
  assert.strictEqual(s.keyState, 'pending');
  assert.strictEqual(s.checking, true, '"확인 중"과 "평문"을 구분할 수 있어야 한다(거짓 자물쇠 방지)');
  assert.deepStrictEqual(gate.caps(), [], '승인 전에는 여전히 능력 미선언');
});

test('2-B. 폰이 승인 → keyring 폴링이 봉인문을 수령해 MK 획득 → caps 가 실제로 열린다', async () => {
  // 폰의 1탭 승인(서버에 grant 업로드)을 시뮬레이션.
  const daemonIkX = e2ee.identity().ikX;
  phoneApproves(daemonIkX, { ikEd: e2ee.identity().ikEd, label: 'MacTest', platform: process.platform, kind: 'host' });

  const r = await account.runOnce();
  account.stop();
  assert.strictEqual(r.phase, 'trusted');
  assert.strictEqual(e2ee.hasKey(), true, '봉인문을 수령했는데 열쇠가 없다');
  assert.strictEqual(Buffer.compare(e2ee.masterKey(1), MK), 0, '폰이 봉인한 MK 와 다른 값을 얻었다');
  assert.strictEqual(e2ee.epoch(), 1);

  gate.resetCache();
  const caps = gate.caps();
  assert.notDeepStrictEqual(caps, [], '★ 이 라운드의 존재 이유 — caps 가 여전히 빈 배열이면 E2EE 는 무발현이다');
  assert.deepStrictEqual(caps, ['e2ee.keys.v1', 'e2ee.rpc.v1']);
  assert.strictEqual(gate.epoch(), 1, 'hello 의 e2eeEpoch 가 0 이면 어떤 클라와도 세대가 맞지 않는다');
  assert.strictEqual(gate.selfDeviceId(), SELF_DEV, '봉투 AAD 의 host 대조에 쓰는 deviceId 가 심기지 않았다');

  const s = await account.state();
  account.stop();
  assert.strictEqual(s.keyState, 'trusted');
  assert.strictEqual(s.state, 'trusted');
  assert.strictEqual(fs.statSync(stateFile()).mode & 0o777, 0o600, '열쇠를 담은 뒤에도 0600 이어야 한다');
});

// ★ 승인 직후 back 의 conn.caps/e2eeEpoch 는 **연결 시점의 사실**이라 열쇠가 생겼다는 것을 모른다.
//  같은 소켓으로 hello 를 다시 신고하지 않으면 다음 재접속(수 시간)까지 앱/PC 는 이 PC 를 "열쇠 없음"
//  으로 보고 평문으로 돌고 잠금 배지도 꺼진 채다 — 방금 승인이 아무 효과가 없는 것처럼 보인다.
test('2-B2. 열쇠 수령 직후 hello 를 재신고한다(caps + e2eeEpoch 즉시 반영)', () => {
  assert.strictEqual(hellos.length, 1, '열쇠 수령 후 hello 재신고가 없다');
  const h = hellos[0];
  assert.strictEqual(h.type, 'hello');
  assert.ok(h.caps.includes('e2ee.keys.v1') && h.caps.includes('e2ee.rpc.v1'), `caps 에 e2ee 능력이 없다: ${h.caps.join(',')}`);
  assert.strictEqual(h.e2eeEpoch, 1, 'e2eeEpoch 가 0 이면 back 은 계속 "열쇠 없음"으로 팬아웃한다');
});

test('2-C. 열쇠를 얻은 뒤 봉투 RPC 가 실제로 왕복한다(NO_KEY 가 사라졌다)', async () => {
  const encOpts = { epoch: 1, hostDeviceId: SELF_DEV };
  const res = await callSealed(e2ee.sealRpc('fs.unwatch', {}, encOpts), SELF_DEV);
  assert.ok(res && res.env && res.env.ct, '응답이 봉인되지 않았다');
  assert.deepStrictEqual(e2ee.openRpcResult(res.env, encOpts), { ok: true, r: { ok: true } });
});

// ══════════════════════════════════════════════════════════════════════════
//  3. 위조 봉인문 거부 — 서버가 자기 키로 봉인한 MK 를 주입할 수 없다
// ══════════════════════════════════════════════════════════════════════════

test('3. 승인자를 모르는 봉인문은 받지 않는다(서버 주입 차단)', async () => {
  const evil = newDevice('악성 서버', 'x', 'controller');
  const bogusMk = e2ee.randomBytes(32);
  const s = e2ee.sealTo(e2ee.identity().ikX, { epoch: 1, mk: bogusMk, ikEdPriv: evil.edPriv, ikEdPub: evil.ikEd });
  const r = await account.acceptPairGrant({ epoch: 1, sealed: s.sealed, sig: s.sig, sealedByKeyId: 999 });
  account.stop();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'E2EE_GRANT_UNVERIFIABLE');
  assert.strictEqual(Buffer.compare(e2ee.masterKey(1), MK), 0, '위조 MK 가 저장됐다 — 계정 전체가 열린다');
});

// ══════════════════════════════════════════════════════════════════════════
//  4. 이 PC 가 승인자가 되는 레그(approve) — 다른 기기가 실제로 MK 를 얻는다
// ══════════════════════════════════════════════════════════════════════════

test('4. approve: 태블릿 승인 → 태블릿이 자기 개인키로 같은 MK 를 얻는다', async () => {
  const id = 'e_9001';
  pendings.set(id, { ikX: tablet.ikX, ikEd: tablet.ikEd, label: tablet.label, platform: tablet.platform, kind: 'controller', requestedAt: Date.now() });

  const list = await account.pending();
  account.stop();
  const row = list.pending.find((p) => p.enrollmentId === id);
  assert.ok(row, '승인 시트에 태블릿이 보이지 않는다');
  assert.match(row.safetyCode || '', /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, '대조 대상은 60비트 safetyCode 다');
  assert.strictEqual(row.verified, true, '로컬 파생과 서버 값이 갈라지면 사용자가 경고를 학습한다');
  assert.ok(!list.pending.some((p) => p.ikX === e2ee.identity().ikX), '자기 자신의 신청은 승인 시트에 넣지 않는다');

  const r = await account.approve({ enrollmentId: id, ikX: tablet.ikX });
  account.stop();
  assert.strictEqual(r.ok, true, `승인 실패: ${r.error || ''}`);
  const g = acct.grants.find((x) => x.recipientKeyId === r.keyId && x.epoch === acct.epoch);
  assert.ok(g, '서버에 봉인문이 올라가지 않았다');
  const got = e2ee.openFrom(g.sealed, {
    epoch: acct.epoch, sig: g.sig, approverIkEd: e2ee.identity().ikEd,
    ikXPriv: tablet.xPriv, ikXPub: tablet.ikX,
  });
  assert.strictEqual(Buffer.compare(got, MK), 0, '태블릿이 열 수 없는 봉인문을 올렸다');

  // 도메인 실패는 소켓 에러가 아니라 {ok:false} 여야 한다(PC 가 E2EE 전체를 미지원으로 뒤집지 않게).
  const bad = await account.approve({ enrollmentId: 'e_nope', ikX: tablet.ikX });
  account.stop();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'NOT_FOUND');
});

// ══════════════════════════════════════════════════════════════════════════
//  5. 회전(rotate) — 새 세대 수령 · 실패 시 로컬 롤백 · 보관 세대 상한
// ══════════════════════════════════════════════════════════════════════════

test('5-A. rotate 업로드 실패 → 로컬 세대를 되돌린다(계정과 어긋난 채 앞서가지 않는다)', async () => {
  rotateReject = { status: 400, code: 'INCOMPLETE_ROTATION' };
  const before = e2ee.epoch();
  const r = await account.revoke({ deviceKeyId: phoneKeyId() });
  account.stop();
  rotateReject = null;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INCOMPLETE_ROTATION');
  assert.strictEqual(e2ee.epoch(), before, '로컬 epoch 만 앞서가면 내 봉투가 전부 거절되고 스스로 복구할 수 없다');
  assert.strictEqual(Buffer.compare(e2ee.masterKey(before), MK), 0);
});

test('5-B. revoke: 폰 해제 + 세대 회전 → 남은 기기(이 PC·태블릿)가 새 MK 를 받는다', async () => {
  const from = e2ee.epoch();
  const r = await account.revoke({ deviceKeyId: phoneKeyId() });
  account.stop();
  assert.strictEqual(r.ok, true, `해제 실패: ${r.error || ''}`);
  assert.strictEqual(r.epoch, from + 1);
  assert.strictEqual(acct.epoch, from + 1);
  assert.strictEqual(e2ee.epoch(), from + 1);
  assert.notStrictEqual(Buffer.compare(e2ee.masterKey(from + 1), MK), 0, '회전인데 MK 가 그대로면 무효화가 아니다');
  MK = e2ee.masterKey(from + 1);   // 이후 시뮬레이션의 계정 MK 갱신
  assert.strictEqual(acct.keys.find((k) => k.ikX === phone.ikX).state, 'revoked');

  // 태블릿도 새 세대 봉인문을 받았는가(남는 기기 전부 재봉인 — 빠뜨리면 그 기기가 영구 복호 불가).
  const tabRow = keyByIkX(tablet.ikX);
  const tg = acct.grants.find((g) => g.epoch === acct.epoch && g.recipientKeyId === tabRow.keyId);
  assert.ok(tg, '태블릿 봉인문이 없다');
  const got = e2ee.openFrom(tg.sealed, { epoch: acct.epoch, sig: tg.sig, approverIkEd: e2ee.identity().ikEd, ikXPriv: tablet.xPriv, ikXPub: tablet.ikX });
  assert.strictEqual(Buffer.compare(got, MK), 0);
});

test('5-C. 다른 기기가 회전시킨 세대도 정기 확인에서 수령하고, 보관 세대 상한을 넘긴 옛 MK 는 정리된다', async () => {
  // 태블릿이 회전을 주도한 상황(서버 epoch 만 올라가고 우리는 폴링으로 알게 된다).
  const to = acct.epoch + 1;
  const newMk = e2ee.randomBytes(32);
  const rows = acct.keys.filter((k) => k.state === 'trusted');
  acct.epoch = to;
  for (const row of rows) {
    const s = e2ee.sealTo(row.ikX, { epoch: to, mk: newMk, ikEdPriv: tablet.edPriv, ikEdPub: tablet.ikEd });
    acct.grants.push({ epoch: to, recipientKeyId: row.keyId, sealed: s.sealed, sealedByKeyId: keyByIkX(tablet.ikX).keyId, sig: s.sig, createdAt: new Date().toISOString() });
    row.lastGrantEpoch = to;
  }
  MK = newMk;

  const r = await account.runOnce();
  account.stop();
  assert.strictEqual(r.phase, 'trusted');
  assert.strictEqual(e2ee.epoch(), to);
  assert.strictEqual(Buffer.compare(e2ee.masterKey(to), newMk), 0);

  // 보관 세대(CPT_E2EE_KEEP_EPOCHS=2) — 현재와 직전만 남고 그보다 옛 MK 는 파일에서 사라진다.
  const disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const kept = Object.keys(disk.keys).map(Number).sort((a, b) => a - b);
  assert.deepStrictEqual(kept, [to - 1, to], `보관 세대가 상한을 벗어났다: ${kept.join(',')}`);
  assert.strictEqual(e2ee.hasKey(to - 2), false, '해제된 옛 세대가 무한히 남으면 회전이 무효화가 아니다');
});

// ══════════════════════════════════════════════════════════════════════════
//  6. 폴링 백오프 · 정책 · 유출 금지
// ══════════════════════════════════════════════════════════════════════════

test('6-A. 폴링은 지수 백오프 + 상한(부팅/재접속 폭주 금지)', () => {
  const d = account._nextDelay;
  const c = account._config;
  assert.strictEqual(d('enroll', 0), 5000);
  assert.strictEqual(d('enroll', 5000), 10000);
  assert.strictEqual(d('enroll', c.ENROLL_MAX_MS), c.ENROLL_MAX_MS, '상한이 없으면 영구 재시도 폭주가 된다');
  assert.strictEqual(d('pending', 0), 5000);
  assert.ok(d('pending', 5000) > 5000 && d('pending', 5000) <= c.PENDING_MAX_MS);
  assert.strictEqual(d('pending', c.PENDING_MAX_MS), c.PENDING_MAX_MS);
  assert.strictEqual(d('trusted', 0), c.TRUSTED_MS);
  // 거절/만료 후 재신청은 back 이 신뢰 기기에 **푸시를 다시 쏘는** 경로 → 상한이 시간 단위여야 한다.
  assert.ok(c.RESOLVED_BASE_MS >= 10 * 60 * 1000 && c.RESOLVED_MAX_MS >= 60 * 60 * 1000);
  assert.strictEqual(d('resolved', c.RESOLVED_MAX_MS), c.RESOLVED_MAX_MS);
  assert.strictEqual(d('bootstrap', c.BOOTSTRAP_MAX_MS), c.BOOTSTRAP_MAX_MS);
  // 재접속마다 즉시 폴링하면 재연결 폭주가 폴링 폭주로 증폭된다.
  account._reset();
  account.start();
  const k1 = account.resync();
  const k2 = account.resync();
  account.stop();
  assert.strictEqual(k2.throttled, true, `kick 최소 간격(${c.KICK_MIN_GAP_MS}ms)이 없다`);
  assert.ok(k1 && (k1.ok === true || k1.throttled === true));
});

test('6-B. policy=off 면 열쇠 요청 자체를 하지 않는다(끈 사람에게 승인 알림이 가면 안 된다)', async () => {
  const before = countOf('/api/daemon/e2ee/enroll');
  e2ee.setPolicy('off');
  e2ee.removeState();                     // 열쇠 없는 상태 재현(정책만 남기려 새 신원 생성)
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  e2ee.setPolicy('off');
  account._reset();
  const r = await account.runOnce();
  account.stop();
  assert.strictEqual(r.skipped, 'policy_off');
  assert.strictEqual(countOf('/api/daemon/e2ee/enroll'), before);
  e2ee.setPolicy('preferred');
});

test('6-C. MK 는 로그·서버 요청 본문 어디에도 남지 않는다', () => {
  const blob = logs.join('\n');
  assert.ok(blob.length > 0, '로그가 하나도 없다 — grep 이 무의미하다');
  for (const [label, key] of [['현재 MK', MK]]) {
    assert.strictEqual(blob.includes(key.toString('base64url')), false, `${label} 이 로그에 b64u 로 남았다`);
    assert.strictEqual(blob.includes(key.toString('hex')), false, `${label} 이 로그에 hex 로 남았다`);
    assert.strictEqual(blob.includes(key.toString('base64')), false, `${label} 이 로그에 base64 로 남았다`);
  }
  // 개인키(신원키)도 로그·서버로 나가지 않는다.
  const disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  const bodies = hits.map((h) => h.rawBody || '').join('\n');
  assert.strictEqual(blob.includes(disk.ikX.priv), false, '신원 개인키가 로그에 남았다');
  assert.strictEqual(bodies.includes(disk.ikX.priv), false, '신원 개인키가 서버로 전송됐다');
  assert.strictEqual(bodies.includes(disk.ikEd.priv), false, '서명 개인키가 서버로 전송됐다');
  for (const k of Object.values(disk.keys || {})) {
    assert.strictEqual(bodies.includes(k), false, 'MK 가 서버 요청 본문에 실렸다');
    assert.strictEqual(blob.includes(k), false, 'MK 가 로그에 남았다');
  }
  // 서버로 나간 본문에 금지 필드(mk/masterKey/…)가 없는지 — back 이 400 으로 거절하는 그물의 데몬측 대칭.
  for (const f of ['"mk"', '"masterKey"', '"secret"', '"privateKey"', '"priv"']) {
    assert.strictEqual(bodies.includes(f), false, `요청 본문에 금지 필드 ${f} 가 있다`);
  }
  // 사용자 AI 자격증명 경로를 건드리지 않는다(ToS 경계) — 요청 본문/로그에 흔적 0.
  for (const s of ['.claude', 'Keychain', 'ANTHROPIC_API_KEY', 'oauth']) {
    assert.strictEqual(bodies.includes(s), false, `요청 본문에 ${s} 흔적이 있다`);
  }
});

test('6-D. 데몬이 부른 back 라우트는 열쇠 배포 표면 + /me 뿐이다(다른 표면을 건드리지 않는다)', () => {
  const allowed = new Set([
    '/api/daemon/me',
    '/api/daemon/e2ee/enroll', '/api/daemon/e2ee/pending', '/api/daemon/e2ee/keyring',
    '/api/daemon/e2ee/approve', '/api/daemon/e2ee/deny', '/api/daemon/e2ee/rotate', '/api/daemon/e2ee/policy',
  ]);
  const unexpected = [...new Set(urls())].filter((u) => !allowed.has(u));
  assert.deepStrictEqual(unexpected, [], `예상 밖 라우트 호출: ${unexpected.join(',')}`);
  assert.ok(hits.every((h) => h.auth === 'Bearer cptd_test'), '모든 호출이 deviceToken 인증이어야 한다');
});
