// 계정 열쇠 클라이언트 **강화(적대적 교차검증 결함 14건)** 회귀 테스트 — node --test
//   실행: CPT_SHIM_NO_GLOBAL_LINK=1 node --test packages/runner-core/test/e2ee-hardening.test.js
//
// 정본: docs/구현설계-2026-07-25/11-배관-계약.md §2 / 기능2-E2EE.md
//
// 이 파일은 e2ee-account.test.js(정상 경로)의 **반대편**을 고정한다. 전부 "조용히 죽는" 종류의
// 결함이라 화면에는 자물쇠가 켜진 채 트래픽만 평문으로 내려간다 — 즉 사람이 눈으로 못 잡는다.
//  1. 신뢰 해제·복구 복원에서 hello 재신고 누락 → back conn.e2eeEpoch 고착 = **거짓 자물쇠**
//  2. adoptPolicy 가 서버를 무조건 따라 내려가 사용자의 'required'(다운그레이드 금지)를 강등
//  3. userRef 미영속 → 재기동 후 **틀린 안전코드**를 표시(사람 대조 = 유일한 MITM 방어)
//  4. E2EE_REPLAY 를 E2EE_OPEN_FAILED 로 뭉갬 → back 409 매핑 도달 불가 + 앱 10분 평문 고정
//  5. 503 전량을 '서버가 껐다'로 오진 → 저장소 장애 1시간 평문 + 거짓 진단 문구
//  6. resolved 백오프가 kind 교대로 리셋돼 10분 고정 → 승인 요청 푸시 10분마다 영구 반복
//  7. e2ee.json 절단 시 신원키·전 세대 MK 를 백업 없이 blankState 로 즉시 덮어씀
//  8. 쓰기 불가/손상 상태에서 e2ee.state 만 소켓 에러로 throw(계약 §2.4 규약① 위반)
//  9. policy='off' 가 caps/봉투 처리를 끄지 않음(킬스위치 반쪽)
// 10. PC 조회(60초)가 폴링 게이트를 우회해 서버 OFF 에서도 분당 2회 영구 왕복
// 11. pcState 도메인에 'none' 이 없어 확정 평문이 '준비 중'(노란 진행)으로 표시

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

// ── 격리(require 전에!) ──────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2ee-hard-'));
const STATE = path.join(ROOT, '.codingpt');
process.env.HOME = ROOT;
process.env.CODINGPT_TMUX_SOCKET = `codingpt-e2hard-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_LAN_SCOPE = 'off';
delete process.env.CPT_E2EE;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

const config = require('../config');
const e2ee = require('../e2ee');
const gate = require('../e2ee-gate');
const control = require('../control');
const account = require('../e2ee-account');
const e2eeLocal = require('../e2ee-local');

assert.ok(config.e2eeFile().startsWith(ROOT), '격리 stateDir 미적용 — 중단');

const USER_ID = 7;
const SELF_DEV = 12;
const stateFile = () => config.e2eeFile();

// ── 가짜 back — 응답을 시험마다 갈아끼운다(실물 deviceTrustService 의 형태만 흉내) ──
const hits = [];
const B = {
  keyring: () => ({ epoch: 1, policy: 'preferred', recoverySet: false, devices: [], myKeyId: 5, myState: 'trusted', myGrant: null }),
  enroll: () => ({ state: 'bootstrap', epoch: 0, policy: 'preferred' }),
  pending: () => ({ pending: [], epoch: 1, trustedCount: 1 }),
  policy: null,          // {status, code} 면 실패 응답
  fail: null,            // {status, code} 면 keyring/enroll/pending 전부 실패
};
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const failJson = (res, status, code, message) => sendJson(res, status, { success: false, message: message || code, detail: { code } });

const back = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch (_) { json = null; }
    const url = req.url.split('?')[0];
    hits.push({ url, method: req.method, body: json });
    if (url === '/api/daemon/me') return sendJson(res, 200, { id: USER_ID, deviceId: SELF_DEV, deviceName: 'T' });
    if (url === '/api/daemon/e2ee/policy') {
      if (B.policy) return failJson(res, B.policy.status, B.policy.code, B.policy.message);
      return sendJson(res, 200, { policy: String((json || {}).policy || ''), epoch: 1 });
    }
    if (B.fail) return failJson(res, B.fail.status, B.fail.code, B.fail.message);
    if (url === '/api/daemon/e2ee/keyring') return sendJson(res, 200, B.keyring());
    if (url === '/api/daemon/e2ee/enroll') return sendJson(res, 200, B.enroll());
    if (url === '/api/daemon/e2ee/pending') return sendJson(res, 200, B.pending());
    return sendJson(res, 404, { success: false, message: 'Not Found' });
  });
});

let hellos = 0;                       // 열쇠 사실 변화 → hello 재신고 횟수
const armNotify = () => { account.start({ onKeyChange: () => { hellos += 1; return true; } }); account.stop(); };
const countOf = (u) => hits.filter((h) => h.url === u).length;

// 열쇠 있는 상태를 로컬에서 만든다(서버 왕복 없음 — 부트스트랩 경로는 e2ee-account.test.js 가 덮는다).
function giveKey(epoch = 1) {
  e2ee.removeState();
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  e2ee.setMasterKey(epoch, e2ee.randomBytes(32));
  gate.resetCache();
}

test('setup — 격리 stateDir + 가짜 back + daemon.json', async () => {
  await new Promise((r) => back.listen(0, '127.0.0.1', r));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({
    serverUrl: `http://127.0.0.1:${back.address().port}`, deviceToken: 'cptd_test', deviceName: 'MacTest', deviceId: SELF_DEV,
  }), { mode: 0o600 });
});

after(async () => {
  try { account.stop(); } catch (_) { /* noop */ }
  await new Promise((r) => back.close(r));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 1·11 — 신뢰 해제도 '열쇠 사실 변화' 다(hello 재신고 없으면 거짓 자물쇠)
// ══════════════════════════════════════════════════════════════════════════
test('D1. 신뢰 해제(handleRevoked) 직후 hello 를 재신고한다 — back conn.e2eeEpoch 고착 금지', async () => {
  giveKey(1);
  account._reset();
  armNotify();
  hellos = 0;
  B.keyring = () => ({ epoch: 2, policy: 'preferred', devices: [], myKeyId: 5, myState: 'revoked', myGrant: null });
  await account.runOnce();
  account.stop();
  assert.strictEqual(e2ee.hasKey(), false, '해제됐는데 열쇠가 남아 있다');
  gate.resetCache();
  assert.deepStrictEqual(gate.caps(), [], '열쇠 0개인데 능력을 선언하면 앱이 봉인을 계속 보낸다');
  assert.strictEqual(gate.epoch(), 0);
  assert.ok(hellos >= 1,
    `해제도 열쇠 사실 변화다 — hello 재신고가 없으면 back 의 conn.e2eeEpoch 가 옛 세대로 고착해 배지가 '암호화됨' 을 계속 그린다(실제=평문). 재신고=${hellos}`);
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 2·5 — adoptPolicy 단조 강화(사용자의 required 를 서버가 강등하지 못한다)
// ══════════════════════════════════════════════════════════════════════════
test('D2. 서버가 더 약한 정책을 말해도 로컬 required 를 내리지 않는다(+ 동기화 실패를 화면에 노출)', async () => {
  giveKey(1);
  B.keyring = () => ({ epoch: 1, policy: 'preferred', devices: [], myKeyId: 5, myState: 'trusted', myGrant: null });
  B.policy = { status: 409, code: 'RECOVERY_REQUIRED', message: '먼저 복구 코드를 만들어 주세요.' };
  account._reset();

  // 사용자가 PC 설정에서 '항상' 을 켠다 → 로컬은 커밋되고 서버 동기화는 409 로 실패한다.
  const set = await e2eeLocal.setPolicy({ policy: 'required' });
  assert.strictEqual(set.policy, 'required');
  assert.strictEqual(e2ee.policy(), 'required');

  await account.runOnce();          // 정기 폴링 1회 = adoptPolicy('preferred')
  account.stop();
  assert.strictEqual(e2ee.policy(), 'required',
    "서버 값을 무조건 따라가면 사용자가 켠 '항상'(평문 폴백 금지)이 15분 뒤 조용히 '자동' 으로 되돌아간다");

  const s = await account.state();
  account.stop();
  assert.strictEqual(s.policy === undefined, true, 'state() 의 policy 는 e2ee-local 이 로컬 파일에서 싣는다');
  assert.match(String(s.reason || ''), /복구 코드/, '정책 서버 동기화 실패가 완전 무음이면 사용자는 required 가 계정에 안 걸린 것을 모른다');

  // 반대 방향(서버가 더 엄격) 은 채택한다 — 계정 정책은 강화 방향으로만 전파된다.
  e2ee.setPolicy('preferred');
  B.keyring = () => ({ epoch: 1, policy: 'required', devices: [], myKeyId: 5, myState: 'trusted', myGrant: null });
  await account.runOnce();
  account.stop();
  assert.strictEqual(e2ee.policy(), 'required', '서버가 강화한 정책은 따라가야 한다');
  // 'off'(사용자 킬스위치)는 기존 규율대로 절대 되살리지 않는다.
  e2ee.setPolicy('off');
  await account.runOnce();
  account.stop();
  assert.strictEqual(e2ee.policy(), 'off');
  e2ee.setPolicy('preferred');
  B.policy = null;
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 3 — userRef 영속·복원(틀린 안전코드를 그리지 않는다)
// ══════════════════════════════════════════════════════════════════════════
test('D3. userRef 는 첫 기동에 파일에 남고, 재기동 직후 조회에서 그대로 복원된다', async () => {
  e2ee.removeState();
  gate.resetCache();
  account._reset();
  B.keyring = () => ({ epoch: 0, policy: 'preferred', devices: [], myKeyId: null, myState: 'unknown', myGrant: null });
  B.enroll = () => ({ state: 'bootstrap', epoch: 0, policy: 'preferred' });

  await account.runOnce();                       // 1회차(신규 설치) — 상태 파일이 없던 시점
  account.stop();
  const disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  assert.strictEqual(disk.userRef, String(USER_ID),
    '1회차에 저장되지 않으면 재기동마다 userRef=\'\' 로 파생한 틀린 안전코드가 표시된다(사람 대조 방어 무력화)');

  // 데몬 재기동 재현: 모듈 상태만 비우고 파일은 그대로 둔다(네트워크 없이 복원돼야 한다).
  account._reset();
  e2ee.clearCache();
  const before = hits.length;
  const s = await account.state();
  account.stop();
  assert.strictEqual(s.userRef, String(USER_ID), '재기동 직후 state() 가 파일의 userRef 를 읽지 않는다');
  assert.strictEqual(hits.length, before, 'state() 는 네트워크를 기다리지 않는다(계약 §2.4)');
});

test('D3-b. userRef 를 모르면 파생값을 아예 내보내지 않는다(틀린 값 표시 금지)', async () => {
  // 파일에 userRef 가 없는 상태(구 배포에서 올라온 파일) 재현.
  const disk = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  delete disk.userRef;
  fs.writeFileSync(stateFile(), JSON.stringify(disk), { mode: 0o600 });
  e2ee.clearCache();
  account._reset();
  const other = e2ee.genX25519();
  B.pending = () => ({ pending: [{ enrollmentId: 'e_1', label: '새 폰', platform: 'android', ikX: Buffer.from(other.pub).toString('base64url'), verifyCode: '1234', requestedAt: new Date().toISOString() }], epoch: 1, trustedCount: 1 });
  account._state.started = true;        // 조회 게이트(결함 10) 통과 — 이 시험의 대상이 아니다
  account._state.lastRunAt = Date.now();
  const list = await account.pending();
  account.stop();
  const row = list.pending[0];
  assert.ok(row, '승인 시트 행이 없다');
  assert.strictEqual(row.safetyCode, null, 'userRef 없이 파생한 안전코드는 폰 화면과 다르다 — 그리면 사용자를 틀린 값으로 유도한다');
  assert.strictEqual(row.fingerprint, null);
  assert.strictEqual(row.verifyCode, null);
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 4 — 봉투 실패 코드 보존(E2EE_REPLAY 가 back 의 409 매핑에 도달해야 한다)
// ══════════════════════════════════════════════════════════════════════════
test('D4. 같은 봉투 재전송은 E2EE_REPLAY 로 회신한다(E2EE_OPEN_FAILED 로 뭉개지 않는다)', async () => {
  giveKey(1);
  const encOpts = { epoch: 1, hostDeviceId: SELF_DEV };
  const env = e2ee.sealRpc('fs.unwatch', {}, encOpts);
  const call = () => new Promise((res, rej) => control.handleSealedRpc({ readyState: 1, send() {} }, { env, hostDeviceId: SELF_DEV }, res, rej));
  const first = await call();
  assert.ok(first && first.env, '1차 왕복이 실패했다');
  await assert.rejects(call, (err) => err.code === 'E2EE_REPLAY',
    'back e2eeCodes 는 E2EE_REPLAY→409 를 준비해 뒀는데 데몬이 그 코드를 절대 내보내지 않으면 리플레이가 502 로 나가 앱이 10분간 평문으로 고정된다');
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 6 — 503 은 '서버가 껐다' 가 아니다(저장소 장애 ≠ 킬스위치)
// ══════════════════════════════════════════════════════════════════════════
test('D5. 503 KEYRING_UNAVAILABLE 은 1시간 동면·거짓 문구로 접지 않는다', async () => {
  giveKey(1);
  account._reset();
  B.fail = { status: 503, code: 'KEYRING_UNAVAILABLE', message: '열쇠 저장소에 접근할 수 없습니다.' };
  const r = await account.runOnce();
  const wait = account._state.nextAt - Date.now();
  account.stop();
  assert.notStrictEqual(r.skipped, 'server_off', '저장소 장애를 킬스위치로 오진하면 폰에서 승인해도 최대 1시간 평문으로 남는다');
  assert.ok(wait <= account._config.ENROLL_MAX_MS * 1.3, `일시 장애 재시도 간격이 너무 길다: ${Math.round(wait / 1000)}s`);
  assert.ok(!/꺼져 있어요/.test(String(account._state.reason || '')), `거짓 진단 문구: ${account._state.reason}`);

  // 대조군 — 진짜 킬스위치(503 + E2EE_DISABLED)는 그대로 1시간 동면.
  account._reset();
  B.fail = { status: 503, code: 'E2EE_DISABLED', message: '종단간 암호화가 비활성화되어 있습니다.' };
  const r2 = await account.runOnce();
  const wait2 = account._state.nextAt - Date.now();
  account.stop();
  assert.strictEqual(r2.skipped, 'server_off');
  assert.ok(wait2 > account._config.ENROLL_MAX_MS, `킬스위치에서는 길게 물러나야 한다: ${Math.round(wait2 / 1000)}s`);
  B.fail = null;
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 7 — 거절/만료 재신청 백오프가 실제로 자란다(알림 폭탄 금지)
// ══════════════════════════════════════════════════════════════════════════
test('D6. resolved↔pending 교대에도 재신청 간격이 커진다(runOnce 실측 수열)', async () => {
  e2ee.removeState();
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  gate.resetCache();
  account._reset();
  B.fail = null;
  B.policy = null;
  B.enroll = () => ({ state: 'pending', enrollmentId: `e_${Date.now()}`, requestedAt: new Date().toISOString(), policy: 'preferred' });
  B.keyring = () => ({ epoch: 1, policy: 'preferred', devices: [], myKeyId: null, myState: 'unknown', myGrant: null });
  B.pending = () => ({ pending: [], epoch: 1, trustedCount: 1 });   // 내 신청이 사라졌다(거절/만료)

  const resolved = [];
  for (let i = 0; i < 4; i += 1) {
    await account.runOnce();                 // enroll → pending 등록
    const r = await account.runOnce();       // 요청 소멸 감지 → resolved
    assert.strictEqual(r.phase, 'resolved', `${i + 1}회차에서 resolved 로 가지 않았다: ${JSON.stringify(r)}`);
    resolved.push(account._state.delay);
  }
  account.stop();
  assert.strictEqual(resolved[0], account._config.RESOLVED_BASE_MS);
  assert.ok(resolved[1] > resolved[0] && resolved[2] > resolved[1] && resolved[3] > resolved[2],
    `재신청 간격이 자라지 않는다(${resolved.map((m) => `${Math.round(m / 60000)}m`).join(' → ')}) — back 이 재신청마다 승인 요청 푸시를 다시 쏘므로 사용자 폰에 10분마다 영구 배너가 뜬다`);
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 8 — 절단된 e2ee.json 을 백업 없이 blankState 로 덮어쓰지 않는다
// ══════════════════════════════════════════════════════════════════════════
test('D7. 손상된 상태 파일은 보존·백업하고 신원키/MK 를 덮어쓰지 않는다', async () => {
  giveKey(3);
  const good = fs.readFileSync(stateFile(), 'utf8');
  const ikBefore = e2ee.identity().ikX;
  // 디스크 꽉 참/크래시 중 쓰기 = 절반만 남는다.
  fs.writeFileSync(stateFile(), good.slice(0, Math.floor(good.length / 2)), { mode: 0o600 });
  e2ee.clearCache();

  assert.throws(() => e2ee.ensureIdentity(), (err) => err && err.code === 'E2EE_STATE_CORRUPT',
    '손상본을 즉시 새 blankState 로 덮어쓰면 신원키와 전 세대 MK 가 백업 없이 영구 소실된다');
  const after = fs.readFileSync(stateFile(), 'utf8');
  assert.ok(after.length && after !== good, '손상본이 그대로 남아 있어야 사람이 복구할 기회가 있다');
  assert.ok(!/"ikX"[\s\S]*"priv"/.test(after) || after.length < good.length, '파일이 새 blankState 로 덮어써졌다');
  const backups = fs.readdirSync(STATE).filter((f) => f.startsWith('e2ee.json.corrupt-'));
  assert.ok(backups.length >= 1, `손상본 백업(.corrupt-*)이 없다: ${fs.readdirSync(STATE).join(',')}`);

  // 정상 복구: 파일을 되돌리면 같은 신원키·MK 로 그대로 돌아온다(파괴적 동작이 없었다는 증거).
  fs.writeFileSync(stateFile(), good, { mode: 0o600 });
  e2ee.clearCache();
  assert.strictEqual(e2ee.identity().ikX, ikBefore);
  assert.strictEqual(e2ee.hasKey(3), true);
  // 원자적 저장 — 임시 파일이 남지 않는다.
  e2ee.setPolicy('preferred');
  assert.deepStrictEqual(fs.readdirSync(STATE).filter((f) => f.endsWith('.tmp')), []);
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 9 — 상태 파일을 못 읽는 상황에서도 e2ee.state 는 던지지 않는다
// ══════════════════════════════════════════════════════════════════════════
test('D8. 손상/입출력 실패에서 e2ee.state|pending|keyring 은 소켓 에러로 던지지 않는다(규약 ①)', async () => {
  const good = fs.readFileSync(stateFile(), 'utf8');
  fs.writeFileSync(stateFile(), good.slice(0, 20), { mode: 0o600 });
  e2ee.clearCache();
  account._reset();

  const s = await e2eeLocal.state();
  assert.strictEqual(s.available, true, 'E2EE 카드 전체가 미지원으로 뒤집히면 진단이 틀린다');
  assert.strictEqual(s.state, 'error');
  assert.ok(String(s.reason || '').length > 0, '사용자에게 무엇이 문제인지 알려야 한다');
  await assert.doesNotReject(() => e2eeLocal.pending());
  await assert.doesNotReject(() => e2eeLocal.keyring());
  account._state.started = true;
  account._state.lastRunAt = Date.now();
  await assert.doesNotReject(() => account.pending(), 'identityOf 가 try 밖에 있으면 같은 조건에서 reject 한다');
  await assert.doesNotReject(() => account.keyring());
  account.stop();

  fs.writeFileSync(stateFile(), good, { mode: 0o600 });
  e2ee.clearCache();
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 10 — policy='off' 는 caps 와 봉투 처리도 끈다(반쪽 킬스위치 금지)
// ══════════════════════════════════════════════════════════════════════════
test('D9. policy=off 면 caps 를 선언하지 않고 들어오는 봉투도 처리하지 않는다', async () => {
  giveKey(1);
  const encOpts = { epoch: 1, hostDeviceId: SELF_DEV };
  const env = e2ee.sealRpc('fs.unwatch', {}, encOpts);
  e2ee.setPolicy('off');
  gate.resetCache();
  assert.deepStrictEqual(gate.caps(), [], "사용자가 껐는데 e2ee 능력을 계속 광고하면 '연결 없이도 즉시 원복' 약속이 깨진다");
  await assert.rejects(
    () => new Promise((res, rej) => control.handleSealedRpc({ readyState: 1, send() {} }, { env, hostDeviceId: SELF_DEV }, res, rej)),
    (err) => err.code === 'E2EE_DISABLED',
  );
  // 끈다고 **과거 알림**이 🔒 가 되면 안 된다 — openText 는 policy 와 무관하게 남는다.
  const sealedBody = e2ee.sealNotifBody('안녕');
  assert.deepStrictEqual(e2eeLocal.openText({ text: sealedBody }), { text: '안녕', locked: false });
  e2ee.setPolicy('preferred');
  gate.resetCache();
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 12 — PC 의 60초 조회가 폴링 게이트/킬스위치를 우회하지 않는다
// ══════════════════════════════════════════════════════════════════════════
test('D10. 루프가 기동되지 않았으면 pending|keyring 조회는 REST 왕복 0회', async () => {
  account._reset();                       // started=false, lastRunAt=0 (서버가 e2ee.keys.v1 미선언)
  const before = hits.length;
  assert.strictEqual(account._state.phase, 'boot');
  for (let i = 0; i < 3; i += 1) {
    await e2eeLocal.pending();
    await e2eeLocal.keyring();
    account._state.cache = { pending: null, pendingAt: 0, keyring: null, keyringAt: 0 };  // 2초 캐시 우회
  }
  account.stop();
  assert.strictEqual(hits.length - before, 0,
    `서버 미선언/킬스위치 OFF 에서도 PC 1대당 분당 2회 영구 왕복한다(실제 ${hits.length - before}회)`);
});

test('D10-b. 서버가 껐다고 판정된 뒤(phase=off)에도 조회가 왕복을 반복하지 않는다', async () => {
  giveKey(1);
  account._reset();
  B.fail = { status: 503, code: 'E2EE_DISABLED', message: 'off' };
  await account.runOnce();                // → server_off 판정
  account.stop();
  const before = hits.length;
  for (let i = 0; i < 3; i += 1) {
    await e2eeLocal.pending();
    await e2eeLocal.keyring();
    account._state.cache = { pending: null, pendingAt: 0, keyring: null, keyringAt: 0 };
  }
  account.stop();
  assert.ok(hits.length - before <= 2, `킬스위치 OFF 인데 조회가 계속 왕복한다(${hits.length - before}회)`);
  B.fail = null;
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 13 — 확정 평문은 'none'(열쇠 없음)이다. '준비 중'(진행)으로 위장하지 않는다
// ══════════════════════════════════════════════════════════════════════════
test('D11. 계정에 열쇠가 없어 사람을 기다리는 상태는 state=none(PC 열쇠 없음)으로 나간다', async () => {
  e2ee.removeState();
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  e2ee.setPolicy('preferred');
  gate.resetCache();
  account._reset();
  B.fail = null;
  B.enroll = () => ({ state: 'bootstrap', epoch: 0, policy: 'preferred' });
  await account.runOnce();
  account.stop();
  const s = await e2eeLocal.state();
  assert.strictEqual(s.keyState, 'none');
  assert.strictEqual(s.checking, false);
  assert.strictEqual(s.state, 'none',
    "PC 의 '열쇠 없음' 표기는 state==='none' 에서만 켜진다 — 'bootstrap' 으로 보내면 확정 평문이 노란 '준비 중' 으로 표시된다");
  // ★ 개정 4(2026-07-27): 부트스트랩은 앱 표면이 자동 수행 — reason 은 수동 지시("폰에서 켜 주세요")
  //  대신 진행형 + 평문 폴백 고지다(e2ee-account.test.js 1번과 같은 개정).
  assert.match(String(s.reason || ''), /준비하는 중/);
});

// ══════════════════════════════════════════════════════════════════════════
//  결함 14 — 복구 코드 복원도 열쇠 사실 변화다(hello 재신고)
// ══════════════════════════════════════════════════════════════════════════
test('D12. 복구 코드 복원 직후 hello 를 재신고한다(back conn.e2eeEpoch=0 고착 금지)', async () => {
  giveKey(4);
  const code = e2ee.recoveryCode();
  e2ee.removeState();
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  gate.resetCache();
  account._reset();
  armNotify();
  hellos = 0;
  const r = await e2eeLocal.recoveryRestore({ code });
  assert.strictEqual(r.ok, true, `복원 실패: ${r.error || ''}`);
  assert.strictEqual(e2ee.epoch(), 4);
  assert.ok(hellos >= 1, `복원으로 epoch 0→4 가 됐는데 hello 재신고=${hellos} — back 은 다음 재접속까지 이 PC 를 '평문' 으로 팬아웃한다`);
  account.stop();
});
