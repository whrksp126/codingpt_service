// back → 데몬 열쇠 힌트(`e2ee_hint`) 계약 테스트 — node --test
//   실행: CPT_SHIM_NO_GLOBAL_LINK=1 node --test packages/runner-core/test/e2ee-hint.test.js
//
// 닫는 한계(직전 라운드 §남은 것 6-①): 데몬은 열쇠 보유 중 `TRUSTED_MS`(15분) 고정 주기로만 keyring
// 을 확인했다. 그래서 다른 기기에서 `rotate` 하면 **최대 15분간** 이 데몬은 옛 세대로 남고 그 사이
// 봉투는 `E2EE_EPOCH_MISMATCH` 로 거절돼 사용자 화면이 '확인 중' 에 머문다.
//
// 이 파일이 증명하는 것
//  1. **실제 WS 로 도착한** `{type:'e2ee_hint'}` 프레임 → control.handleE2eeHint → 즉시 keyring 재확인
//     → 새 세대 봉인문 수령(epoch 1→2) → `onKeyChange`(=control.announceHello) 로 hello 재신고.
//  2. throttle: 같은 프레임 5장 연속 → keyring 왕복 **1회**(폭주 금지).
//  3. 폴백 유지: 프레임이 0장인 구 back 시나리오에서 15분 폴링이 그대로 유일 경로이고(예약 간격 실측)
//     그 폴링이 실제로 새 세대를 따라잡는다.
//  4. 보안: 프레임이 epoch/policy 를 주장해도 **아무것도 채택하지 않는다**(정본 = keyring 왕복 + 서명).
//     루프가 시작되지 않은 상태의 프레임은 루프를 시작시키지 못한다.
//  5. 알림 폭탄 금지: `resolved`(거절/만료 후 재신청 대기) 상태에서는 힌트를 받지 않는다 —
//     그 상태의 화해는 **새 enroll** 을 만들고 back 은 그때마다 승인 요청 푸시를 다시 쏜다.
//
// 가짜 back 은 codingpt_back 실물 형태를 흉내낸다(e2ee-account.test.js 와 같은 근거 파일:줄)
//  · successResponse = data 를 최상위(utils/response.js:11) · errorResponse = detail.code(:18-28)
//  · keyring 응답(services/deviceTrustService.js:624-630) · publicKeyRow(:255-263)
//  · grant 서명 바이트열 = "cpt-e2ee/v1/grant" ‖ u32BE(epoch) ‖ ikX(32B) ‖ SHA256(sealed) (:142-151)
//  · 힌트 프레임(services/daemonRelayService.js notifyRunnersE2ee) = {type,kind,at} — **epoch 없음**

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// ── 격리(require 전에!) — 실사용 ~/.codingpt / 실 tmux / PC 앱 번들 데몬 무접촉 ──────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2ee-hint-'));
const STATE = path.join(ROOT, '.codingpt');
process.env.HOME = ROOT;
process.env.CODINGPT_TMUX_SOCKET = `codingpt-e2hint-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_LAN_SCOPE = 'off';
delete process.env.CPT_E2EE;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

const e2ee = require('../e2ee');
const gate = require('../e2ee-gate');
const control = require('../control');
const account = require('../e2ee-account');

assert.ok(require('../config').e2eeFile().startsWith(ROOT), '격리 stateDir 미적용 — 중단');

const USER_ID = 11;
const SELF_DEV = 21;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 계정(= objectstore keyring.json 미러) ────────────────────────────────
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const b64u = (b) => Buffer.from(b).toString('base64url');
const raw = (s) => Buffer.from(String(s), 'base64url');

function newDevice(label, platform, kind) {
  const x = e2ee.genX25519();
  const ed = e2ee.genEd25519();
  return { label, platform, kind, ikX: b64u(x.pub), ikEd: b64u(ed.pub), xPriv: x.priv, edPriv: ed.priv };
}
const phone = newDevice('내 폰', 'android', 'controller');   // 계정 최초 기기(승인자)
const tablet = newDevice('아이패드', 'ios', 'controller');    // 나중에 해제되는 기기(회전 유발)
let MK = e2ee.randomBytes(32);

const acct = { epoch: 0, policy: 'preferred', keys: [], grants: [], nextKeyId: 1, recovery: null };
const pendings = new Map();
let enrollSeq = 0;

function grantSigMsg(epoch, ikXRaw, sealedRaw) {
  return Buffer.concat([Buffer.from('cpt-e2ee/v1/grant', 'utf8'), u32(Number(epoch)), Buffer.from(ikXRaw), e2ee.sha256(sealedRaw)]);
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
const phoneKeyId = () => (keyByIkX(phone.ikX) || { keyId: 1 }).keyId;
function publicPending(id, rec) {
  const fp = fpOf(rec.ikX);
  return {
    enrollmentId: id, label: rec.label, platform: rec.platform, deviceKind: rec.kind,
    ikX: rec.ikX, ikEd: rec.ikEd, verifyCode: fp.short, fingerprint: fp.legacy,
    requestedAt: new Date(rec.requestedAt).toISOString(),
    expiresAt: new Date(rec.requestedAt + 600000).toISOString(), requestIp: '10.0.1.*',
  };
}

/** 폰이 대상 공개키로 MK 를 봉인해 키링에 grant 를 넣는다(승인/회전 공용). */
function phoneSeals(ikX, meta, epoch, mk) {
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

/** 폰이 기기 하나를 해제하며 세대를 올린다(back rotate 결과와 같은 상태를 만든다). */
function phoneRotates(revokeIkX) {
  const from = acct.epoch;
  const to = from + 1;
  MK = e2ee.randomBytes(32);                        // 새 세대 MK
  const gone = keyByIkX(revokeIkX);
  if (gone) { gone.state = 'revoked'; gone.revokedAt = new Date().toISOString(); }
  acct.epoch = to;
  for (const row of trusted()) {                    // 남는 기기 전부 재봉인(INCOMPLETE_ROTATION 대칭)
    const s = e2ee.sealTo(row.ikX, { epoch: to, mk: MK, ikEdPriv: phone.edPriv, ikEdPub: phone.ikEd });
    acct.grants.push({ epoch: to, recipientKeyId: row.keyId, sealed: s.sealed, sealedByKeyId: phoneKeyId(), sig: s.sig, createdAt: new Date().toISOString() });
    row.lastGrantEpoch = to;
  }
  return { from, to };
}

// ── 가짜 back HTTP ───────────────────────────────────────────────────────────
const hits = [];
let keyringDelayMs = 0;   // keyring 응답 지연(7-A: 화해가 왕복을 물고 있는 창을 실제로 만든다)
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
    hits.push({ url, method: req.method, body: json, auth: req.headers.authorization });

    if (url === '/api/daemon/me') {
      return sendJson(res, 200, { id: USER_ID, email: 't@example.com', nickname: 't', deviceId: SELF_DEV, deviceName: 'T' });
    }
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
      if (acct.epoch === 0 && trusted().length === 0) return sendJson(res, 200, { state: 'bootstrap', epoch: 0, policy: acct.policy, suite: 'cpt-e2ee/v1' });
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
    if (url === '/api/daemon/e2ee/pending') {
      return sendJson(res, 200, {
        pending: [...pendings.entries()].map(([id, rec]) => publicPending(id, rec)),
        epoch: acct.epoch, policy: acct.policy, trustedCount: trusted().length,
      });
    }
    if (url === '/api/daemon/e2ee/keyring') {
      const ikX = q.get('ikX') || '';
      let myKeyId = null; let myState = 'unknown'; let myGrant = null;
      const row = ikX ? keyByIkX(ikX) : null;
      if (row) { myKeyId = row.keyId; myState = row.state; myGrant = publicGrant(grantFor(acct.epoch, row.keyId)); }
      else if (ikX) myState = [...pendings.values()].some((p) => p.ikX === ikX) ? 'pending' : 'unknown';
      // ★ 응답 본문은 **요청이 도착한 시점에** 굳히고 전송만 늦춘다(keyringDelayMs) — back 이 keyring 을
      //  저장하기 **전에** 우리 GET 이 들어간 그 레이스를 충실히 재현하기 위해서다(7-A). 늦게 굳히면
      //  회전 결과가 응답에 섞여 레이스 자체가 사라진다.
      const payload = {
        epoch: acct.epoch, policy: acct.policy, suite: 'cpt-e2ee/v1', recoverySet: !!acct.recovery,
        devices: acct.keys.map(publicKeyRow),
        myKeyId, myState, myGrant,
      };
      if (keyringDelayMs > 0) { setTimeout(() => sendJson(res, 200, payload), keyringDelayMs); return undefined; }
      return sendJson(res, 200, payload);
    }
    return sendJson(res, 404, { success: false, message: 'Not Found' });
  });
});

// ── 가짜 back 제어 WS(/api/daemon/connect) — 힌트 프레임을 **실제 와이어로** 내려보낸다 ──────
//  control.run() 은 쓰지 않는다: killStrayDaemons()/reaper 가 이 Mac 의 PC 앱 번들 데몬을 죽인다.
//  그래서 전송(서버 send → 클라 message)만 실물로 두고, 수신 프레임은 control 이 쓰는 그 함수
//  (control.handleE2eeHint)에 그대로 넣는다 — 아래 '배선' 테스트가 그 호출을 소스로 못 박는다.
let wss = null;
let serverSock = null;      // back 쪽 소켓(힌트 발신)
let clientSock = null;      // 데몬 쪽 소켓(힌트 수신)
const received = [];        // 데몬이 실제로 받은 프레임
const hellos = [];          // onKeyChange(=control.announceHello) 로 재신고된 hello 프레임

function hintOverWire(kind, extra) {
  // back notifyRunnersE2ee 가 만드는 프레임 그대로(+ extra = 위조 필드 주입 실험용)
  serverSock.send(JSON.stringify({ type: 'e2ee_hint', kind, at: new Date().toISOString(), ...(extra || {}) }));
}
const keyringHits = () => hits.filter((h) => h.url === '/api/daemon/e2ee/keyring').length;
const enrollHits = () => hits.filter((h) => h.url === '/api/daemon/e2ee/enroll').length;

test('setup — 격리 stateDir + 가짜 back HTTP/WS + daemon.json', async () => {
  await new Promise((r) => back.listen(0, '127.0.0.1', r));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({
    serverUrl: `http://127.0.0.1:${back.address().port}`, deviceToken: 'cptd_hint', deviceName: 'MacHint', deviceId: SELF_DEV,
  }), { mode: 0o600 });

  // 제어 WS 대역 — 실제 ws 서버/클라이언트 한 쌍.
  const httpSrv = http.createServer();
  wss = new WebSocket.Server({ server: httpSrv, path: '/api/daemon/connect' });
  await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
  const opened = new Promise((r) => wss.on('connection', (ws) => { serverSock = ws; r(); }));
  clientSock = new WebSocket(`ws://127.0.0.1:${httpSrv.address().port}/api/daemon/connect`);
  clientSock.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    received.push(msg);
    // control.js 의 프레임 디스패치와 같은 분기(아래 '배선' 테스트가 소스로 동일성을 못 박는다).
    if (msg && msg.type === 'e2ee_hint') control.handleE2eeHint(msg);
  });
  await new Promise((r) => clientSock.on('open', r));
  await opened;
  wss._httpSrv = httpSrv;
  assert.ok(serverSock && clientSock.readyState === 1, '가짜 제어 WS 가 열리지 않았다');
});

after(async () => {
  try { account.stop(); } catch (_) { /* noop */ }
  try { clientSock.close(); } catch (_) { /* noop */ }
  try { wss.close(); wss._httpSrv.close(); } catch (_) { /* noop */ }
  await new Promise((r) => back.close(r));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ══════════════════════════════════════════════════════════════════════════
//  0. 선언 — 처리 코드가 있는 이 커밋에서만 caps 에 실린다
// ══════════════════════════════════════════════════════════════════════════

test('0-A. 데몬 caps 에 e2ee.hint.v1 이 실린다 — **열쇠가 없어도**(힌트가 가장 필요한 순간이다)', () => {
  gate.resetCache();
  assert.strictEqual(e2ee.hasKey(), false);
  assert.deepStrictEqual(gate.caps(), [], '열쇠 없음 = e2ee.keys/rpc 미선언(기존 계약)');
  const caps = control.daemonCaps();
  assert.ok(caps.includes('e2ee.hint.v1'),
    `열쇠 없는 상태에서도 힌트 능력은 선언해야 한다(bootstrap 백오프 상한 1시간): ${caps.join(',')}`);
  assert.strictEqual(typeof account.hintResync, 'function', '선언 조건 = 핸들러 실존');
});

test('0-B. 루프가 안 도는 상태의 프레임은 **아무것도 시작시키지 못한다**(caps 교리)', () => {
  account._reset();
  const before = hits.length;
  const r = account.hintResync({ kind: 'rotated' });
  assert.deepStrictEqual(r, { ok: false, ignored: 'not_started' });
  assert.strictEqual(hits.length, before, '서버 프레임 한 장이 왕복을 유발하면 킬스위치가 무의미해진다');
  assert.strictEqual(account._state.started, false, '프레임이 폴링 루프를 기동시켜서는 안 된다');
});

// ══════════════════════════════════════════════════════════════════════════
//  1. 열쇠 취득(사전 조건) — 폰이 부트스트랩하고 데몬을 승인한 상태
// ══════════════════════════════════════════════════════════════════════════

test('1. 폰이 계정 열쇠를 만들고 이 데몬 + 태블릿을 승인 → 데몬 epoch=1', async () => {
  acct.epoch = 1;
  phoneSeals(phone.ikX, { ikEd: phone.ikEd, label: phone.label, platform: phone.platform, kind: 'controller' }, 1, MK);
  phoneSeals(tablet.ikX, { ikEd: tablet.ikEd, label: tablet.label, platform: tablet.platform, kind: 'controller' }, 1, MK);

  account._reset();
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  const id = e2ee.identity();
  phoneSeals(id.ikX, { ikEd: id.ikEd, label: 'MacHint', platform: process.platform, kind: 'host' }, 1, MK);

  // control.js 가 hello_ack 에서 하는 배선 그대로(onKeyChange = 같은 소켓 hello 재신고).
  account.start({ onKeyChange: () => { hellos.push(control.helloFrame({ deviceName: 'MacHint', daemonVersion: 'test' })); return true; } });
  const r = await account.runOnce();
  assert.strictEqual(r.phase, 'trusted');
  assert.strictEqual(e2ee.epoch(), 1);
  assert.strictEqual(Buffer.compare(e2ee.masterKey(1), MK), 0);
  hellos.length = 0;
});

// ══════════════════════════════════════════════════════════════════════════
//  2. 이 라운드의 본체 — 회전 후 15분을 기다리지 않는다
// ══════════════════════════════════════════════════════════════════════════

test('2-A. 회전 직후 힌트가 없으면 다음 확인은 15분 뒤다(닫으려는 결함을 먼저 실측한다)', () => {
  const { to } = phoneRotates(tablet.ikX);          // 폰이 태블릿을 해제 → epoch 1→2
  assert.strictEqual(acct.epoch, to);
  assert.strictEqual(e2ee.epoch(), 1, '데몬은 아직 옛 세대다');
  const waitMs = account._state.nextAt - Date.now();
  assert.ok(waitMs > 10 * 60 * 1000,
    `힌트가 없으면 이 데몬은 ${Math.round(waitMs / 1000)}초 동안 옛 세대로 남는다(=봉투 전량 EPOCH_MISMATCH)`);
  assert.strictEqual(account._state.hintSeen, 0);
});

test('2-B. **실제 WS 로 받은** e2ee_hint → 즉시 재확인 → 새 세대 채택 → hello 재신고', async () => {
  const krBefore = keyringHits();
  hintOverWire('rotated');
  await sleep(60);
  assert.deepStrictEqual(
    received.map((m) => m.type), ['e2ee_hint'],
    '프레임이 와이어를 타고 데몬 쪽 소켓에 도착해야 한다',
  );
  assert.strictEqual(received[0].epoch, undefined, '힌트 프레임에 epoch 이 실리면 서버가 세대를 주장할 수 있다');

  // 힌트 → HINT_COALESCE_MS(400ms) 뒤 화해 + 왕복.
  const nextIn = account._state.nextAt - Date.now();
  assert.ok(nextIn <= account._config.HINT_COALESCE_MS + 50, `즉시 재확인이 예약되지 않았다(${nextIn}ms 뒤)`);
  await sleep(account._config.HINT_COALESCE_MS + 400);

  assert.strictEqual(e2ee.epoch(), 2, '힌트를 받고도 옛 세대로 남으면 이 라운드는 아무것도 고치지 않았다');
  assert.strictEqual(Buffer.compare(e2ee.masterKey(2), MK), 0, '새 세대 MK 를 폰이 봉인한 값과 다르게 얻었다');
  assert.ok(keyringHits() > krBefore, 'keyring 왕복 없이 세대가 바뀌었다면 프레임 내용을 채택한 것이다(계약 위반)');

  // 열쇠 사실 변화 → hello 재신고(back conn.e2eeEpoch·caps 즉시 갱신 — 없으면 배지가 거짓말한다).
  assert.ok(hellos.length >= 1, '새 세대를 채택했는데 hello 재신고가 없다');
  const h = hellos[hellos.length - 1];
  assert.strictEqual(h.type, 'hello');
  assert.strictEqual(h.e2eeEpoch, 2, `재신고 hello 의 e2eeEpoch 가 ${h.e2eeEpoch} 다`);
  assert.ok(h.caps.includes('e2ee.hint.v1') && h.caps.includes('e2ee.keys.v1'), `재신고 caps: ${h.caps.join(',')}`);

  // 힌트 처리 뒤에도 정기 폴링은 그대로 살아 있어야 한다(힌트는 가속기이고 대체물이 아니다).
  const waitMs = account._state.nextAt - Date.now();
  assert.ok(waitMs > 10 * 60 * 1000, `힌트가 폴링 주기를 갈아치웠다(다음 확인 ${Math.round(waitMs / 1000)}초)`);
});

// ══════════════════════════════════════════════════════════════════════════
//  3. throttle — 연속 프레임이 왕복 폭주가 되지 않는다
// ══════════════════════════════════════════════════════════════════════════

test('3-A. 같은 프레임 5장 연속 → keyring 왕복 1회', async () => {
  const before = keyringHits();
  const rcvBefore = received.length;
  account._state.lastHintAt = 0;    // 2-B 가 방금 수용했으므로 창 밖 시각으로 되돌린다(합침만 본다)
  for (let i = 0; i < 5; i += 1) hintOverWire('rotated');
  await sleep(80);
  assert.ok(received.length - rcvBefore === 5, `프레임이 5장 도착해야 한다(실제 ${received.length - rcvBefore})`);
  await sleep(account._config.HINT_COALESCE_MS + 400);
  assert.strictEqual(keyringHits() - before, 1,
    `연속 프레임 5장에 왕복 ${keyringHits() - before}회 — 재연결 폭주가 폴링 폭주로 증폭되는 그 패턴이다`);
  assert.strictEqual(account._state.hintRuns, 2, '힌트가 유발한 화해는 2-B 의 1회 + 여기 1회여야 한다');
});

test('3-B. throttle 창(5s) 안의 힌트는 **즉시** 수용되지 않는다(값이 계약이다)', () => {
  const c = account._config;
  assert.strictEqual(c.HINT_MIN_GAP_MS, 5000);
  assert.strictEqual(c.HINT_COALESCE_MS, 400);
  // 방금(3-A) 수용했으므로 지금 오는 프레임은 throttled 여야 한다.
  //  ★ throttled = "즉시 왕복 금지" 이고 "버림" 이 아니다 — 상한 시점 1회 예약은 7-B 가 못 박는다.
  const r = account.hintResync({ kind: 'policy' });
  assert.strictEqual(r.throttled, true, `힌트 최소 간격(${c.HINT_MIN_GAP_MS}ms)이 없다`);
  assert.strictEqual(r.ok, false);
});

test('3-C. 백오프를 리셋하지 않는다 — 프레임 반복으로 재신청 상한을 0 으로 되돌릴 수 없다', () => {
  const st = account._state;
  const saved = { delays: st.delays, lastHintAt: st.lastHintAt, nextAt: st.nextAt, timer: st.timer };
  const kept = { resolved: 6 * 60 * 60 * 1000, pending: 60000 };
  st.delays = { ...kept };
  st.lastHintAt = 0;                                  // throttle 창 밖으로
  st.nextAt = Date.now() + 6 * 60 * 60 * 1000;
  st.timer = null;                                    // 실제 15분 타이머는 saved 로 되돌린다
  account.hintResync({ kind: 'rotated' });
  assert.deepStrictEqual(st.delays, kept,
    '힌트가 st.delays 를 건드리면 서버가 프레임만 반복해 승인 요청 푸시를 되살릴 수 있다');
  if (st.timer) clearTimeout(st.timer);
  Object.assign(st, saved);                           // 정기 폴링 예약 원상복구
});

// ══════════════════════════════════════════════════════════════════════════
//  4. 보안 — 프레임 내용으로 열쇠 상태를 바꾸지 않는다
// ══════════════════════════════════════════════════════════════════════════

test('4-A. 위조 필드(epoch/policy/sealed)를 실은 힌트는 아무것도 바꾸지 않는다', async () => {
  const epochBefore = e2ee.epoch();
  const policyBefore = e2ee.policy();
  account._state.lastHintAt = 0;
  // 악의적/버그 서버가 "지금 세대는 99, 정책은 off" 라고 주장하며 봉인문까지 실어 보낸 경우.
  hintOverWire('rotated', { epoch: 99, policy: 'off', sealed: b64u(e2ee.randomBytes(72)), sealedByKeyId: 1 });
  await sleep(account._config.HINT_COALESCE_MS + 400);
  assert.strictEqual(e2ee.epoch(), epochBefore, `서버 주장으로 세대가 ${e2ee.epoch()} 로 바뀌었다 — 신뢰 경계 붕괴`);
  assert.strictEqual(e2ee.policy(), policyBefore, '서버 주장으로 로컬 정책이 바뀌었다');
  const st = await account.state();
  assert.strictEqual(st.keyState, 'trusted');
  assert.strictEqual(st.accountEpoch, 2, '정본은 keyring 왕복이 말한 세대(2)여야 한다');
});

test('4-B. 힌트는 신원/열쇠 표면 밖의 back 라우트를 부르지 않는다', () => {
  const allowed = new Set([
    '/api/daemon/me',
    '/api/daemon/e2ee/enroll', '/api/daemon/e2ee/pending', '/api/daemon/e2ee/keyring',
  ]);
  const unexpected = [...new Set(hits.map((h) => h.url))].filter((u) => !allowed.has(u));
  assert.deepStrictEqual(unexpected, [], `예상 밖 라우트: ${unexpected.join(',')}`);
  assert.ok(hits.every((h) => h.auth === 'Bearer cptd_hint'), '모든 왕복이 deviceToken 인증이어야 한다');
});

test('4-C. resolved(거절/만료 후 재신청 대기)에서는 힌트를 받지 않는다 — 승인 푸시 폭탄 금지', () => {
  const st = account._state;
  const saved = { phase: st.phase, lastHintAt: st.lastHintAt, nextAt: st.nextAt, timer: st.timer };
  const before = enrollHits();
  st.phase = 'resolved';
  st.lastHintAt = 0;
  st.nextAt = Date.now() + 6 * 60 * 60 * 1000;   // 재신청 상한에 도달한 상태
  st.timer = null;
  const r = account.hintResync({ kind: 'policy' });
  assert.deepStrictEqual(r, { ok: false, ignored: 'resolved' });
  assert.strictEqual(enrollHits(), before, 'resolved 에서 힌트를 받으면 화해가 새 enroll = 승인 요청 푸시를 만든다');
  Object.assign(st, saved);
});

// ══════════════════════════════════════════════════════════════════════════
//  5. 폴백 — 프레임이 0장인 구 back 에서 15분 폴링이 그대로 유일 경로다
// ══════════════════════════════════════════════════════════════════════════

test('5-A. 힌트 0장 시나리오: 정기 폴링 예약이 살아 있고 그 폴링이 새 세대를 따라잡는다', async () => {
  const seenBefore = account._state.hintSeen;
  const { to } = phoneRotates(tablet.ikX);   // 폰이 한 번 더 회전(이미 해제된 기기 재지정 = 세대만 오른다)
  assert.strictEqual(acct.epoch, to);
  assert.strictEqual(e2ee.epoch(), to - 1, '아직 옛 세대');

  // 구 back = 프레임을 만들지 않는다 → 데몬은 이미 걸려 있는 15분 타이머만 갖는다.
  const waitMs = account._state.nextAt - Date.now();
  assert.ok(waitMs > 10 * 60 * 1000 && waitMs <= account._config.TRUSTED_MS * 1.25,
    `정기 폴링 예약이 사라졌다(다음 확인 ${Math.round(waitMs / 1000)}초) — 힌트가 없으면 회복 경로가 0 이 된다`);
  assert.strictEqual(account._state.hintSeen, seenBefore, '프레임 없이 hintSeen 이 늘면 테스트가 거짓이다');

  // 그 타이머가 하는 일을 그대로 실행(15분을 기다리는 대신) — 폴백 경로가 실제로 회복시킨다.
  const r = await account.runOnce();
  assert.strictEqual(r.phase, 'trusted');
  assert.strictEqual(e2ee.epoch(), to, '15분 폴링 폴백이 새 세대를 못 따라잡으면 구 back 사용자는 영구 고착이다');
  assert.strictEqual(account._nextDelay('trusted', 0), account._config.TRUSTED_MS);
  assert.strictEqual(account._config.TRUSTED_MS, 15 * 60 * 1000, '폴백 주기를 바꾸면 구 back 환경의 계약이 바뀐다');
});

// ══════════════════════════════════════════════════════════════════════════
//  6. 배선 — control.js 가 정말 이 경로를 태우는가(소스 계약)
// ══════════════════════════════════════════════════════════════════════════

test('6. control.js 의 e2ee_hint 분기가 handleE2eeHint → hintResync 를 태운다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');
  assert.match(src, /msg\.type === 'e2ee_hint'/, "제어 WS 메세지 핸들러에 e2ee_hint 분기가 없다");
  const branch = src.slice(src.indexOf("msg.type === 'e2ee_hint'"), src.indexOf("msg.type === 'e2ee_hint'") + 200);
  assert.match(branch, /handleE2eeHint\(msg\)/, 'e2ee_hint 분기가 handleE2eeHint 를 부르지 않는다');
  const fn = src.slice(src.indexOf('function handleE2eeHint'));
  assert.match(fn.slice(0, 800), /acct\.hintResync\(/, 'handleE2eeHint 가 hintResync 를 부르지 않는다');
  // 프레임에서 kind 외의 필드를 읽지 않는다 — epoch/policy/sealed 를 읽는 코드가 생기면 계약 위반.
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  for (const f of ['msg.epoch', 'msg.policy', 'msg.sealed', 'msg.grant']) {
    assert.strictEqual(body.includes(f), false, `handleE2eeHint 가 프레임의 ${f} 를 읽는다 — 서버가 세대를 주장할 수 있다`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  7. 프레임을 **버리지 않는다**(hintResync 불변식 ⑤ — 적대적 교차검증에서 적출된 실측 결함 2건)
//     back 은 힌트를 재전송하지 않는다. 그래서 여기서 한 장 버리면 그 사실은 다음 정기 폴링
//     (15분)까지 영구 유실이고, 그것이 곧 이 라운드가 닫으려던 '회전 직후 15분 평문/409' 다.
// ══════════════════════════════════════════════════════════════════════════

test('7-A. 화해(runOnce) **진행 중**에 온 힌트는 deferred 로 미뤄지고 끝난 직후 재확인된다', async () => {
  const st = account._state;
  const c = account._config;
  keyringDelayMs = 0;
  st.lastHintAt = 0;
  await account.runOnce();                                   // 정렬(데몬 = 계정 세대)
  assert.strictEqual(e2ee.epoch(), acct.epoch, '전제: 데몬이 계정 세대와 같아야 한다');

  // ① 힌트 한 장으로 화해를 예약하고, 그 화해가 keyring 왕복을 **물고 있는** 창을 만든다.
  keyringDelayMs = 500;
  const r1 = account.hintResync({ kind: 'policy' });
  assert.strictEqual(r1.ok, true, `첫 힌트가 수용돼야 한다: ${JSON.stringify(r1)}`);
  await sleep(c.HINT_COALESCE_MS + 150);
  assert.strictEqual(st.running, true, '전제: 이 시점엔 화해가 진행 중이어야 한다');

  // ② 그 창 안에서 폰이 회전한다 = back 은 keyring 을 저장한 뒤 팬아웃하지만 우리 GET 은 이미
  //   회전 **전** 세대를 읽어 뒀다. 이 프레임이 유일한 회복 수단이다.
  const { to } = phoneRotates(tablet.ikX);
  const r2 = account.hintResync({ kind: 'rotated' });
  assert.strictEqual(r2.deferred, true,
    `진행 중 힌트가 미뤄지지 않았다(${JSON.stringify(r2)}) — alreadySoon/throttle 을 running 보다 먼저 보면 `
    + 'st.nextAt 이 항상 과거값이라(타이머 콜백은 갱신하지 않고 schedule 은 화해 끝에야 부른다) '
    + '이 경로가 영구히 도달 불가능한 죽은 코드가 된다',
  );
  assert.strictEqual(st.hintPending, true, 'deferred 라면서 재확인 표시를 남기지 않았다');

  // ③ 화해가 끝나면 finally 가 딱 한 번 재확인한다 → 새 세대 채택.
  keyringDelayMs = 0;
  await sleep(2000);
  assert.strictEqual(e2ee.epoch(), to,
    `진행 중 도착한 힌트가 유실됐다 — 데몬 epoch=${e2ee.epoch()} (계정 ${to}), `
    + `다음 확인 ${Math.round((st.nextAt - Date.now()) / 1000)}초 뒤`);
  assert.strictEqual(st.hintPending, false, '재확인을 하고도 표시가 남아 있으면 다음 화해마다 왕복이 하나 더 붙는다');
});

test('7-B. throttle 창(5s) 안의 힌트는 **폐기가 아니라 지연**이다 — 상한 시점에 1회 수용', async () => {
  const st = account._state;
  const c = account._config;
  keyringDelayMs = 0;
  st.lastHintAt = 0;
  await account.runOnce();                                   // 정렬
  const epoch0 = e2ee.epoch();
  assert.strictEqual(epoch0, acct.epoch);

  // ① 첫 프레임(back onDeviceRevoked → rotate_needed) — 세대는 아직 오르지 않았다.
  const r1 = account.hintResync({ kind: 'rotate_needed' });
  assert.strictEqual(r1.ok, true);
  await sleep(c.HINT_COALESCE_MS + 400);
  assert.strictEqual(st.running, false);
  assert.strictEqual(e2ee.epoch(), epoch0, '전제: 첫 왕복은 회전 전 세대를 읽는다');

  // ② 사람이 이어서 회전을 확정한다(앱 crypto+HTTP 왕복 = 합침창 400ms 밖, throttle창 5s 안).
  //   → 두 번째 프레임이 '진짜 회전' 을 실어 온다.
  const runsBefore = st.hintRuns;
  const { to } = phoneRotates(tablet.ikX);
  const r2 = account.hintResync({ kind: 'rotated' });
  assert.strictEqual(r2.throttled, true, `상한(${c.HINT_MIN_GAP_MS}ms)이 사라졌다: ${JSON.stringify(r2)}`);
  assert.strictEqual(r2.deferred, true,
    `throttle 이 프레임을 **버렸다**(${JSON.stringify(r2)}) — back 은 재전송하지 않으므로 이 사실은 `
    + '다음 정기 폴링(15분)까지 영구 유실이다',
  );
  assert.ok(r2.nextInMs > 0 && r2.nextInMs <= c.HINT_MIN_GAP_MS,
    `지연 예약이 상한 창 안(0<${r2.nextInMs}<=${c.HINT_MIN_GAP_MS})이어야 한다`);

  // ③ 창 안에 프레임이 더 쏟아져도 예약은 **하나로 수렴한다**(타이머 누적 금지 = 왕복 상한 유지).
  for (let i = 0; i < 5; i += 1) account.hintResync({ kind: 'rotated' });
  assert.strictEqual(st.hintRuns - runsBefore, 1,
    `창 안 프레임 6장이 화해 ${st.hintRuns - runsBefore}회를 예약했다 — 지연이 폭주로 바뀌었다`);

  // ④ 상한 시점에 딱 한 번 돌고 새 세대를 잡는다.
  await sleep(c.HINT_MIN_GAP_MS + c.HINT_COALESCE_MS + 900);
  assert.strictEqual(e2ee.epoch(), to,
    `두 번째 프레임이 버려졌다 — 데몬 epoch=${e2ee.epoch()} (계정 ${to}), `
    + `다음 확인 ${Math.round((st.nextAt - Date.now()) / 1000)}초 뒤`);
  // 힌트가 폴링 주기를 갈아치우지 않았다(가속기이고 대체물이 아니다).
  assert.ok(st.nextAt - Date.now() > 10 * 60 * 1000, '지연 수용 뒤 정기 폴링 예약이 사라졌다');
});
