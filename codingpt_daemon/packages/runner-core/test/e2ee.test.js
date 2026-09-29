// E2EE 암호 코어 테스트 — node 내장 러너(node --test), 외부 프레임워크/의존성 없음.
//   실행: npm test  (루트) 또는 node --test packages/runner-core/test/e2ee.test.js
//   대상: ① 키 파생 결정성 ② 방향 분리 ③ 리플레이/순서 거부 ④ 다운그레이드(transcript) 거부
//         ⑤ MK 봉인/해제 ⑥ 복구 코드 왕복+오타 검출 ⑦ 프레임 오버헤드 상한 ⑧ 처리량
//         ⑨ 알림 subtitle 규칙(잠금화면 암호문 노출 방지) ⑩ 골든 벡터 고정
//
// 홈/실데이터 무접촉: runtime.init 으로 격리 stateDir 을 먼저 심는다(require 순서 주의).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-e2ee-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const e2ee = require('../e2ee');
const config = require('../config');

const VECTOR_FILE = path.join(__dirname, 'vectors', 'e2ee-v1.json');

// 공통 픽스처 — 계정 마스터키 1개(epoch 2)를 만들고 시작한다.
function bootAccount() {
  e2ee.removeState();
  e2ee.clearCache();
  e2ee.ensureIdentity({ deviceId: 12 });
  e2ee.setMasterKey(2, e2ee.sha256('fixed-mk-for-tests').subarray(0, 32));
  e2ee.clearCache();
  return e2ee.masterKey(2);
}

const PTY_ROUTING = { cwd: 'proj/a', paneId: 'p1', win: 3 };
const BEGIN = {
  purpose: 'pty', suite: e2ee.SUITE, epoch: 2, transport: 'relay',
  hostDeviceId: 12, client: 'ck_test', routing: PTY_ROUTING,
};

/** 뷰어↔호스트 세션 한 쌍을 세운다(같은 프로세스, role 로 격리). */
function establish(overrides) {
  const o = overrides || {};
  const { offer, pending } = e2ee.createViewerOffer({ ...BEGIN, ...(o.viewer || {}) });
  const answer = e2ee.beginHost({ ...BEGIN, ...(o.host || {}), pub: offer.pub, nonce: offer.nonce });
  const viewer = e2ee.acceptHostAnswer({ ...pending, ...(o.pendingPatch || {}) }, answer);
  return { offer, pending, answer, viewer };
}

// ──────────────────────────────────────────────────────────────────────────────
// win32 스킵: 0600 퍼미션 단정(win32 는 0666 으로 보임) — (windows-port 게이트)
test('상태 파일 — e2ee.json 은 0600 이고 daemon.json 과 분리된다', { skip: process.platform === 'win32' }, () => {
  bootAccount();
  const st = e2ee.loadState();
  assert.strictEqual(st.v, 1);
  assert.strictEqual(st.suite, 'cpt-e2ee/v1');
  assert.strictEqual(e2ee.unb64u(st.ikX.pub).length, 32);
  assert.strictEqual(e2ee.unb64u(st.ikEd.priv).length, 64);   // seed‖pub (stablelib/tweetnacl 표현)
  const mode = fs.statSync(config.e2eeFile()).mode & 0o777;
  assert.strictEqual(mode, 0o600, `mode=${mode.toString(8)}`);
  assert.notStrictEqual(config.e2eeFile(), config.configFile());
  // 로그아웃은 계정별 키를 보존한다. 새 계정 로그인 때 userRef 슬롯이 전환된다.
  config.save({ serverUrl: 'http://x', deviceToken: 'cptd_x' });
  config.clearCredentials();
  assert.ok(config.loadE2ee());
});

test('계정별 열쇠 슬롯 — A→B→A 재로그인 시 각 계정 키를 재사용한다', () => {
  bootAccount();
  const a = e2ee.loadState();
  a.userRef = '7';
  e2ee.saveState(a);
  const aPub = e2ee.identity().ikX;

  assert.strictEqual(config.switchE2eeAccount('8'), true);
  e2ee.clearCache();
  const b = e2ee.ensureIdentity({ deviceId: 12 });
  b.userRef = '8';
  e2ee.saveState(b);
  const bPub = e2ee.identity().ikX;
  assert.notStrictEqual(bPub, aPub);

  assert.strictEqual(config.switchE2eeAccount('7'), true);
  e2ee.clearCache();
  assert.strictEqual(e2ee.identity().ikX, aPub);
  assert.strictEqual(e2ee.loadState().userRef, '7');
});

test('킬스위치 CPT_E2EE=0 → enabled/caps/협상 전부 off (평문 폴백)', () => {
  bootAccount();
  // caps 이름은 back config/caps.js 규약과 동일한 **단계별 점 표기**여야 한다 —
  //  데몬만 다른 표기를 쓰면 교집합이 공집합이 되어 협상이 영구 OFF 되고, 그게 "안전한 평문"으로
  //  위장돼 발견이 늦는다(실제로 그 상태였다).
  assert.deepStrictEqual(e2ee.caps(), ['e2ee.keys.v1', 'e2ee.rpc.v1']);
  process.env.CPT_E2EE = '0';
  try {
    assert.strictEqual(e2ee.enabled(), false);
    assert.deepStrictEqual(e2ee.caps(), []);
    assert.strictEqual(e2ee.shouldUse([e2ee.CAP], 2).use, false);
    assert.throws(() => e2ee.beginHost({ ...BEGIN, pub: e2ee.b64u(Buffer.alloc(32, 1)), nonce: e2ee.b64u(Buffer.alloc(32, 2)) }), /E2EE_DISABLED|CPT_E2EE/);
  } finally { delete process.env.CPT_E2EE; }
  assert.strictEqual(e2ee.enabled(), true);
});

test('capability 게이팅 — 구 데몬/열쇠 없음/epoch 불일치는 평문(required 면 required:true)', () => {
  bootAccount();
  assert.deepStrictEqual(e2ee.shouldUse([e2ee.CAP], 2), { use: true, reason: null });
  assert.strictEqual(e2ee.shouldUse([], 2).reason, 'HOST_UNSUPPORTED');       // 구 데몬
  assert.strictEqual(e2ee.shouldUse([e2ee.CAP], 3).reason, 'EPOCH_MISMATCH');
  e2ee.setPolicy('off');
  assert.strictEqual(e2ee.shouldUse([e2ee.CAP], 2).reason, 'POLICY_OFF');
  e2ee.setPolicy('required');
  assert.strictEqual(e2ee.shouldUse([], 2).required, true);                    // 명시 에러 UI 근거
  e2ee.setPolicy('preferred');
  // 열쇠 자체가 없으면 caps 를 선언하지 않는다(불변식 3: 처리 가능한 능력만 선언).
  e2ee.removeState(); e2ee.clearCache(); e2ee.ensureIdentity({ deviceId: 12 });
  assert.deepStrictEqual(e2ee.caps(), []);
  assert.strictEqual(e2ee.shouldUse([e2ee.CAP], 0).reason, 'NO_GRANT');
});

// ── 키 파생 ───────────────────────────────────────────────────────────────────
test('키 파생 결정성 — 같은 입력이면 양쪽이 같은 k_v2h/k_h2v/sid/confirm', () => {
  const mk = bootAccount();
  const v = e2ee.genX25519(); const h = e2ee.genX25519();
  const nv = Buffer.alloc(32, 0xa1); const nh = Buffer.alloc(32, 0xb2);
  const common = { ...BEGIN, pubViewer: v.pub, pubHost: h.pub, nonceViewer: nv, nonceHost: nh, mk };
  const asViewer = e2ee.deriveSession({ ...common, privSelf: v.priv, pubPeer: h.pub });
  const asHost = e2ee.deriveSession({ ...common, privSelf: h.priv, pubPeer: v.pub });
  assert.deepStrictEqual(asViewer.kV2H, asHost.kV2H);
  assert.deepStrictEqual(asViewer.kH2V, asHost.kH2V);
  assert.deepStrictEqual(asViewer.sid, asHost.sid);
  assert.deepStrictEqual(asViewer.confirm, asHost.confirm);
  // 방향별 키는 서로 달라야 한다.
  assert.notDeepStrictEqual(asViewer.kV2H, asViewer.kH2V);
  // 두 번 파생해도 동일(결정성)
  assert.deepStrictEqual(e2ee.deriveSession({ ...common, privSelf: v.priv, pubPeer: h.pub }).sid, asViewer.sid);
  // MK 가 다르면(=미승인 기기) 세션키가 완전히 달라진다 — 서버는 MITM 불가.
  const other = e2ee.deriveSession({ ...common, privSelf: v.priv, pubPeer: h.pub, mk: Buffer.alloc(32, 9) });
  assert.notDeepStrictEqual(other.sid, asViewer.sid);
});

test('세션 수립 — beginHost/acceptHostAnswer 왕복, sid 일치, host/viewer 레지스트리 격리', () => {
  bootAccount();
  const { answer, viewer } = establish();
  assert.strictEqual(viewer.role, 'viewer');
  assert.strictEqual(viewer.sidB64, answer.sid);
  const host = e2ee.getSession(answer.sid, 'host');
  assert.strictEqual(host.role, 'host');
  assert.deepStrictEqual(host.sid, viewer.sid);
  // 같은 sid 에 두 역할이 있으면 role 없는 조회는 명시 실패(카운터/키 혼선 차단).
  assert.throws(() => e2ee.getSession(answer.sid), /E2EE_AMBIGUOUS_SESSION/);
  assert.ok(e2ee.sessionCount() >= 2);
});

test('다운그레이드 거부 — transcript(호스트/pane/포트/transport/epoch) 불일치 시 confirm 실패', () => {
  bootAccount();
  const mutations = [
    ['다른 pane', { routing: { cwd: 'proj/a', paneId: 'p2', win: 3 } }],
    ['다른 cwd', { routing: { cwd: 'other', paneId: 'p1', win: 3 } }],
    ['transport 강등(relay→direct 위장)', { transport: 'direct' }],
    ['다른 clientKey', { client: 'ck_attacker' }],
    ['다른 purpose', { purpose: 'tcp', routing: { port: 5173 } }],
  ];
  for (const [label, patch] of mutations) {
    // 호스트는 뷰어가 의도한 것과 다른 컨텍스트로 세션을 맺었다 → 뷰어 검증에서 반드시 실패.
    const { offer, pending } = e2ee.createViewerOffer(BEGIN);
    const answer = e2ee.beginHost({ ...BEGIN, ...patch, pub: offer.pub, nonce: offer.nonce });
    assert.throws(() => e2ee.acceptHostAnswer(pending, answer), /E2EE_CONFIRM/, label);
  }
  // confirm 1바이트 변조도 거부
  const { offer, pending } = e2ee.createViewerOffer(BEGIN);
  const good = e2ee.beginHost({ ...BEGIN, pub: offer.pub, nonce: offer.nonce });
  const bad = e2ee.unb64u(good.confirm, 32); bad[0] ^= 1;
  assert.throws(() => e2ee.acceptHostAnswer(pending, { ...good, confirm: e2ee.b64u(bad) }), /E2EE_CONFIRM/);
  // nonce 바꿔치기(서버가 재생) 도 거부
  assert.throws(() => e2ee.acceptHostAnswer(pending, { ...good, nonce: e2ee.b64u(Buffer.alloc(32, 7)) }), /E2EE_CONFIRM/);
  // epoch 불일치는 즉시 명시 실패
  assert.throws(() => e2ee.acceptHostAnswer(pending, { ...good, epoch: 3 }), /E2EE_EPOCH_MISMATCH/);
});

test('epoch 열쇠 부재 → beginHost 는 EPOCH_MISMATCH(=평문 폴백 신호)', () => {
  bootAccount();
  const { offer } = e2ee.createViewerOffer(BEGIN);
  assert.throws(() => e2ee.beginHost({ ...BEGIN, epoch: 7, pub: offer.pub, nonce: offer.nonce }), /E2EE_EPOCH_MISMATCH/);
});

test('호스트 신원 위조 차단 — 서버가 다른 PC 의 hostDeviceId 를 주장하면 거부', () => {
  bootAccount();                                    // 이 기기 deviceId = 12
  const { offer, pending } = e2ee.createViewerOffer({ ...BEGIN, hostDeviceId: 77 });
  // 릴레이가 "너는 77번 PC 다"라고 주장 → 데몬이 자기 신원(12)과 다르므로 즉시 실패.
  assert.throws(() => e2ee.beginHost({ ...BEGIN, hostDeviceId: 77, pub: offer.pub, nonce: offer.nonce }), /E2EE_HOST_MISMATCH/);
  // 서버가 hostDeviceId 를 아예 생략하고 뷰어에게만 77 이라고 속여도 transcript 가 12 로 굳어 confirm 불일치.
  const answer = e2ee.beginHost({ ...BEGIN, hostDeviceId: null, pub: offer.pub, nonce: offer.nonce });
  assert.throws(() => e2ee.acceptHostAnswer(pending, answer), /E2EE_CONFIRM/);
  // 뷰어가 올바른 대상(12)을 지목했을 때만 성립.
  const ok = e2ee.createViewerOffer(BEGIN);
  const a2 = e2ee.beginHost({ ...BEGIN, pub: ok.offer.pub, nonce: ok.offer.nonce });
  assert.ok(e2ee.acceptHostAnswer(ok.pending, a2).sidB64 === a2.sid);
});

// ── 프레이밍 ──────────────────────────────────────────────────────────────────
test('프레임 왕복 — data/ctrl, 헤더 평문 노출은 라우팅 메타뿐', () => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');

  const keys = Buffer.from('echo CPT_CANARY_9f2b\r');
  const f1 = vch.seal(keys, e2ee.KIND.DATA);
  assert.ok(!f1.includes(Buffer.from('CPT_CANARY_9f2b')), '카나리가 프레임에 평문으로 남으면 안 됨');
  const r1 = hch.open(f1);
  assert.strictEqual(r1.kind, e2ee.KIND.DATA);
  assert.deepStrictEqual(r1.payload, keys);

  // resize 는 ctrl kind 로 **원본 JSON 그대로**(tmux window-size latest 규율 불변)
  const resize = { type: 'resize', cols: 118, rows: 48 };
  assert.deepStrictEqual(hch.openJson(vch.sealCtrl(resize)), resize);

  // 역방향(호스트 출력)
  const out = Buffer.from('total 24\r\n');
  assert.deepStrictEqual(vch.open(hch.seal(out, e2ee.KIND.DATA)).payload, out);

  // 헤더 훔쳐보기는 되지만 내용은 불가
  const peek = e2ee.peekFrame(f1);
  assert.strictEqual(peek.ver, 1);
  assert.strictEqual(peek.dir, e2ee.DIR.V2H);
  assert.strictEqual(peek.connId, vch.connId);
  assert.strictEqual(peek.counter, 1);
});

test('방향 분리 — 자기가 봉인한 프레임을 자기가 열 수 없다(반사 공격 차단)', () => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');
  const f = vch.seal(Buffer.from('rm -rf /'), e2ee.KIND.DATA);
  assert.throws(() => vch.open(f), /E2EE_DIR/);            // 뷰어→뷰어 반사
  assert.throws(() => hch.open(hch.seal(Buffer.from('x'))), /E2EE_DIR/);
  // dir 비트만 뒤집으면 AEAD 인증 실패(헤더가 nonce·AAD 라서)
  const flipped = Buffer.from(f); flipped[1] = (flipped[1] & 0xf0) | e2ee.DIR.H2V;
  assert.throws(() => vch.open(flipped), /E2EE_AUTH|E2EE_REPLAY/);
});

test('리플레이/순서 변경 거부 — 같은 프레임 재투입, 카운터 역행', () => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');
  const f1 = vch.seal(Buffer.from('a'));
  const f2 = vch.seal(Buffer.from('b'));
  const f3 = vch.seal(Buffer.from('c'));
  hch.open(f1);
  hch.open(f2);
  assert.throws(() => hch.open(f2), /E2EE_REPLAY/, '동일 프레임 재투입');
  assert.throws(() => hch.open(f1), /E2EE_REPLAY/, '카운터 역행');
  hch.open(f3);                                            // 정상 진행은 계속 가능
  // kind 비트 변조도 인증 실패(kind 가 nonce 안에 있음)
  const f4 = vch.seal(Buffer.from('{"type":"resize"}'), e2ee.KIND.DATA);
  const tampered = Buffer.from(f4); tampered[1] = e2ee.DIR.V2H | (e2ee.KIND.CTRL << 4);
  assert.throws(() => hch.open(tampered), /E2EE_AUTH/);
});

test('connId — 다른 연결 프레임 혼입 거부, 닫힌 connId 재사용 거부, 첫 프레임 학습', () => {
  bootAccount();
  const { answer } = establish();
  const a = e2ee.channel(answer.sid, null, 'viewer');
  const b = e2ee.channel(answer.sid, null, 'viewer');
  assert.notStrictEqual(a.connId, b.connId);
  const hostA = e2ee.channel(answer.sid, a.connId, 'host');
  assert.throws(() => hostA.open(b.seal(Buffer.from('x'))), /E2EE_CONN_MISMATCH/);

  // TCP 포워딩: 호스트는 첫 프레임 헤더에서 connId 를 학습한다.
  const c = e2ee.channel(answer.sid, null, 'viewer');
  const first = c.seal(Buffer.from('GET / HTTP/1.1\r\n'));
  const hostC = e2ee.channelFromFrame(answer.sid, first, 'host');
  assert.strictEqual(hostC.connId, c.connId);
  assert.deepStrictEqual(hostC.open(first).payload, Buffer.from('GET / HTTP/1.1\r\n'));
  // 학습은 첫 프레임(카운터 1)만 — 중간 프레임으로 채널을 새로 만들 수 없다.
  assert.throws(() => e2ee.channelFromFrame(answer.sid, c.seal(Buffer.from('x')), 'host'), /E2EE_PROTOCOL/);

  // 닫은 뒤 같은 connId 재사용 = 재연결 nonce 재사용 → 거부
  hostC.close();
  assert.throws(() => e2ee.channel(answer.sid, c.connId, 'host'), /E2EE_CONN_REUSE/);
});

test('스플라이싱 거부 — 다른 세션/다른 프레임의 암호문 조각 이식', () => {
  bootAccount();
  const s1 = establish();
  const s2 = establish({ viewer: { client: 'ck_other' }, host: { client: 'ck_other' }, pendingPatch: { client: 'ck_other' } });
  const v1 = e2ee.channel(s1.answer.sid, null, 'viewer');
  const h1 = e2ee.channel(s1.answer.sid, v1.connId, 'host');
  const v2 = e2ee.channel(s2.answer.sid, v1.connId, 'viewer');
  const alien = v2.seal(Buffer.from('sudo su'));
  assert.throws(() => h1.open(alien), /E2EE_AUTH/, '다른 세션(sid) 프레임은 AAD 불일치로 거부');

  // 헤더는 그대로 두고 본문만 바꿔 붙이기
  const good = v1.seal(Buffer.from('ok'));
  const mixed = Buffer.concat([good.subarray(0, e2ee.HDR_LEN), alien.subarray(e2ee.HDR_LEN)]);
  assert.throws(() => h1.open(mixed), /E2EE_AUTH/);
  // 짧은/쓰레기 프레임
  assert.throws(() => h1.open(Buffer.alloc(8)), /E2EE_BAD_FRAME/);
  assert.throws(() => h1.open(Buffer.alloc(64)), /E2EE_BAD_FRAME/);   // ver 0
});

test('프레임 오버헤드 상한 — 40B 고정(키입력 1B 도 41B)', () => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  assert.strictEqual(e2ee.frameOverhead(), 40);
  for (const n of [0, 1, 3, 64, 4096, 65536]) {
    const f = vch.seal(Buffer.alloc(n, 0x41));
    assert.strictEqual(f.length - n, 40, `payload ${n}B → 오버헤드 ${f.length - n}B`);
  }
});

test('처리량 — 1MB 를 4KB 프레임으로 봉인/해제', (t) => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');
  const chunk = require('crypto').randomBytes(4096);
  const N = 256;                                   // 4KB * 256 = 1MB
  let sealMs = 0, openMs = 0, bytesOut = 0;
  const frames = [];
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) frames.push(vch.seal(chunk));
  sealMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  for (const f of frames) bytesOut += hch.open(f).payload.length;
  openMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(bytesOut, N * 4096);
  const mb = (N * 4096) / (1024 * 1024);
  t.diagnostic(`seal 1MB/4KB×${N}: ${sealMs.toFixed(2)}ms (${(mb / (sealMs / 1000)).toFixed(0)} MB/s)`);
  t.diagnostic(`open 1MB/4KB×${N}: ${openMs.toFixed(2)}ms (${(mb / (openMs / 1000)).toFixed(0)} MB/s)`);
  t.diagnostic(`오버헤드: ${(40 * N)}B / 1MB = ${((40 * N) / (N * 4096) * 100).toFixed(2)}%`);
  // 여유 있는 하한만 검사(CI 머신 편차 흡수) — PTY 대역폭은 실사용 대비 2자릿수 여유가 목표.
  assert.ok(sealMs < 2000 && openMs < 2000, `너무 느림 seal=${sealMs}ms open=${openMs}ms`);
});

test('키입력 지연 — 1바이트 프레임 왕복 1000회', (t) => {
  bootAccount();
  const { answer } = establish();
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');
  const one = Buffer.from('a');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) hch.open(vch.seal(one));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.diagnostic(`1B seal+open ×1000: ${ms.toFixed(2)}ms (${(ms).toFixed(3)}µs/키 = ${(ms * 1000 / 1000).toFixed(2)}µs)`);
  assert.ok(ms < 500, `키입력 경로가 느림: ${ms}ms/1000`);
});

test('AES-256-GCM 대체 스위트도 동일 API 로 동작', () => {
  bootAccount();
  const { offer, pending } = e2ee.createViewerOffer({ ...BEGIN, suite: e2ee.SUITE_AES });
  const answer = e2ee.beginHost({ ...BEGIN, suite: e2ee.SUITE_AES, pub: offer.pub, nonce: offer.nonce });
  const viewer = e2ee.acceptHostAnswer(pending, answer);
  assert.strictEqual(viewer.suite, e2ee.SUITE_AES);
  const vch = e2ee.channel(answer.sid, null, 'viewer');
  const hch = e2ee.channel(answer.sid, vch.connId, 'host');
  assert.deepStrictEqual(hch.open(vch.seal(Buffer.from('aes-ok'))).payload, Buffer.from('aes-ok'));
  // 스위트가 다르면 세션키도 다르다(교차 복호 불가) — 협상 결과가 바인딩됨
  assert.throws(() => e2ee.beginHost({ ...BEGIN, suite: 'nope/v9', pub: offer.pub, nonce: offer.nonce }), /E2EE_SUITE/);
});

// ── 봉투(JSON) ────────────────────────────────────────────────────────────────
test('봉투 왕복 — fs RPC 요청/응답, 라우팅 필드는 봉투 밖', () => {
  bootAccount();
  const env = e2ee.sealRpc('fs.read', { path: 'proj/a/.env' }, { hostDeviceId: 12 });
  assert.strictEqual(env.v, 1);
  assert.strictEqual(env.suite, 'cpt-e2ee/v1');
  assert.strictEqual(env.epoch, 2);
  const wire = JSON.stringify({ hostDeviceId: 12, timeoutMs: 15000, env });
  assert.ok(!wire.includes('fs.read') && !wire.includes('.env'), '메서드명/경로가 와이어에 남으면 안 됨');
  const opened = e2ee.openRpc(env, { hostDeviceId: 12 });
  assert.strictEqual(opened.m, 'fs.read');
  assert.deepStrictEqual(opened.p, { path: 'proj/a/.env' });

  const res = e2ee.sealRpcResult({ content: 'SECRET=1' }, { hostDeviceId: 12 });
  assert.ok(!JSON.stringify(res).includes('SECRET'));
  assert.deepStrictEqual(e2ee.openRpcResult(res, { hostDeviceId: 12 }), { ok: true, r: { content: 'SECRET=1' } });
  const errEnv = e2ee.sealRpcError(Object.assign(new Error('없는 파일'), { code: 'ENOENT' }), { hostDeviceId: 12 });
  assert.deepStrictEqual(e2ee.openRpcResult(errEnv, { hostDeviceId: 12 }), { ok: false, e: '없는 파일', code: 'ENOENT' });
});

test('봉투 — 방향키 분리, hostDeviceId 바꿔치기(AAD) 거부, 리플레이 거부', () => {
  bootAccount();
  const env = e2ee.sealRpc('ws.list', {}, { hostDeviceId: 12 });
  assert.throws(() => e2ee.openRpcResult(env, { hostDeviceId: 12 }), /E2EE_AUTH/, '요청키로 봉인된 것을 응답키로 열 수 없다');
  assert.throws(() => e2ee.openRpc(env, { hostDeviceId: 99 }), /E2EE_AUTH/, '다른 PC 로 재라우팅 거부');
  e2ee.openRpc(env, { hostDeviceId: 12 });
  assert.throws(() => e2ee.openRpc(env, { hostDeviceId: 12 }), /E2EE_REPLAY/, '같은 봉투 재사용 거부');
  // 암호문 변조
  const tampered = { ...e2ee.sealRpc('fs.write', { path: 'a' }, { hostDeviceId: 12 }) };
  const ct = e2ee.unb64u(tampered.ct); ct[0] ^= 0xff; tampered.ct = e2ee.b64u(ct);
  assert.throws(() => e2ee.openRpc(tampered, { hostDeviceId: 12 }), /E2EE_AUTH/);
  // epoch 열쇠 없음 → NO_KEY(평문 폴백 신호)
  assert.throws(() => e2ee.openRpc({ ...env, epoch: 5, ct: env.ct }, { hostDeviceId: 12 }), /E2EE_NO_KEY/);
});

// ── MK 봉인/승인 ──────────────────────────────────────────────────────────────
test('MK 봉인/해제 왕복 — 새 기기 승인(서버는 암호문만)', () => {
  const mk = bootAccount();
  const approver = e2ee.loadState();
  const newDev = { ikX: e2ee.genX25519(), ikEd: e2ee.genEd25519() };

  const payload = e2ee.approvePayload('e_7f01', newDev.ikX.pub, 2);
  assert.strictEqual(payload.epoch, 2);
  assert.ok(!e2ee.unb64u(payload.sealed).includes(mk), '봉인문에 MK 평문이 들어가면 안 됨');

  const got = e2ee.openFrom(payload.sealed, {
    epoch: 2, sig: payload.sig, approverIkEd: approver.ikEd.pub,
    ikXPriv: newDev.ikX.priv, ikXPub: newDev.ikX.pub,
  });
  assert.deepStrictEqual(got, mk);

  // 다른 기기 키로는 못 열고, 승인 서명이 틀리면 거부(서버가 만든 위조 봉인문 주입 차단)
  const other = e2ee.genX25519();
  assert.throws(() => e2ee.openFrom(payload.sealed, { epoch: 2, ikXPriv: other.priv, ikXPub: other.pub }), /E2EE_AUTH/);
  const forged = e2ee.genEd25519();
  assert.throws(() => e2ee.openFrom(payload.sealed, {
    epoch: 2, sig: payload.sig, approverIkEd: forged.pub, ikXPriv: newDev.ikX.priv, ikXPub: newDev.ikX.pub,
  }), /E2EE_GRANT_SIG/);
  // epoch 를 서버가 바꿔치기해도 AAD 불일치
  assert.throws(() => e2ee.openFrom(payload.sealed, { epoch: 3, ikXPriv: newDev.ikX.priv, ikXPub: newDev.ikX.pub }), /E2EE_AUTH/);
});

test('부트스트랩 / 지문 / epoch 회전', () => {
  e2ee.removeState(); e2ee.clearCache();
  e2ee.ensureIdentity({ deviceId: 1 });
  assert.strictEqual(e2ee.epoch(), 0);
  const b = e2ee.bootstrapMasterKey();
  assert.deepStrictEqual(b, { epoch: 1, created: true });
  assert.strictEqual(e2ee.bootstrapMasterKey().created, false, '멱등');

  const st = e2ee.loadState();
  const fp = e2ee.fingerprint(st.ikX.pub, 42).safety;
  assert.match(e2ee.fingerprint(st.ikX.pub, 42).legacy, /^\d{3} \d{3}$/);
  assert.strictEqual(e2ee.fingerprint(st.ikX.pub, 42).safety, fp, '결정적');
  assert.notStrictEqual(e2ee.fingerprint(st.ikX.pub, 43).safety, fp, '계정별로 다름');
  // 표시 지문은 60비트여야 한다 — 짧은 숫자는 악성 서버가 같은 값이 나오는 키를 오프라인으로
  //  찾아낼 수 있어(실측 4자리 1.3초 / 6자리 80초) 사람이 눈으로 비교하는 채널이 무력해진다.
  assert.match(fp, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, '60비트 base32 12글자');
  const short = e2ee.fingerprint(st.ikX.pub, 42).short;
  assert.match(short, /^\d{4}$/, 'short 는 요청 구분용 4자리(보안값 아님)');

  // 회전: 남은 기기 목록에 재봉인 + 우리 epoch 승격, 옛 epoch 열쇠는 보존(옛 스냅샷 복호)
  const mk1 = e2ee.masterKey(1);
  const remain = e2ee.genX25519();
  const r = e2ee.rotate([{ deviceKeyId: 88, ikX: remain.pub }]);
  assert.deepStrictEqual([r.fromEpoch, r.toEpoch], [1, 2]);
  assert.strictEqual(e2ee.epoch(), 2);
  assert.deepStrictEqual(e2ee.masterKey(1), mk1, '옛 epoch 보존');
  assert.notDeepStrictEqual(e2ee.masterKey(2), mk1);
  const delivered = e2ee.openFrom(r.grants[0].sealed, { epoch: 2, ikXPriv: remain.priv, ikXPub: remain.pub });
  assert.deepStrictEqual(delivered, e2ee.masterKey(2));
});

test('acceptGrant — 승인 결과 수신 시 상태에 저장되고 즉시 사용 가능', () => {
  bootAccount();
  const approver = e2ee.loadState();
  const mk = e2ee.masterKey(2);
  const grant = e2ee.approvePayload('e_x', approver.ikX.pub, 2);   // 자기 자신에게(=부트스트랩 미러)
  // 다른 기기 상태로 갈아탄 뒤 grant 만으로 복구되는지 검증
  e2ee.removeState(); e2ee.clearCache();
  const fresh = e2ee.ensureIdentity({ deviceId: 31 });
  const grantForFresh = (() => {
    e2ee.setMasterKey(2, mk);                                       // 승인자 문맥 재현
    const p = e2ee.approvePayload('e_y', fresh.ikX.pub, 2);
    return p;
  })();
  assert.deepStrictEqual(e2ee.acceptGrant({ epoch: 2, sealed: grantForFresh.sealed, sig: grantForFresh.sig }), { epoch: 2 });
  assert.deepStrictEqual(e2ee.masterKey(2), mk);
  assert.ok(grant.sealed.length > 40);
});

// ── 복구 코드 ─────────────────────────────────────────────────────────────────
test('복구 코드 — 왕복, 형식, 오타/체크섬 검출, 혼동문자 흡수', (t) => {
  const mk = bootAccount();
  const code = e2ee.recoveryCode({ epoch: 2 });
  t.diagnostic(`복구 코드 예시: ${code}`);
  assert.match(code, /^CPT1(-[0-9A-HJKMNP-TV-Z]{5}){12}$/);
  const parsed = e2ee.parseRecoveryCode(code);
  assert.strictEqual(parsed.epoch, 2);
  assert.deepStrictEqual(parsed.mk, mk);
  // 공백/소문자/구분자 없음 모두 허용
  assert.deepStrictEqual(e2ee.parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ')).mk, mk);
  // 혼동문자 흡수: O→0, I/L→1
  const body = code.slice(5).replace(/-/g, '');
  const confusable = body.replace(/0/, 'O').replace(/1/, 'I');
  if (confusable !== body) assert.deepStrictEqual(e2ee.parseRecoveryCode('CPT1' + confusable).mk, mk);
  // 1글자 오타 → 전량 거부. **모든 위치 × 모든 대체문자**를 전수(60×31=1860건) 확인한다.
  //  마지막 글자에는 잉여 비트가 있어 무작위 표본으로는 놓친다(실측으로 잡은 버그).
  const CHARSET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let typos = 0;
  for (let pos = 0; pos < body.length; pos++) {
    for (const alt of CHARSET) {
      if (alt === body[pos]) continue;
      typos++;
      assert.throws(
        () => e2ee.parseRecoveryCode('CPT1' + body.slice(0, pos) + alt + body.slice(pos + 1)),
        /E2EE_RECOVERY/, `pos=${pos} ${body[pos]}→${alt} 오타가 통과했다`,
      );
    }
  }
  assert.strictEqual(typos, 60 * 31);
  // 글자 두 개 뒤바뀜(transposition)도 전수 거부
  for (let pos = 0; pos + 1 < body.length; pos++) {
    if (body[pos] === body[pos + 1]) continue;
    const swapped = 'CPT1' + body.slice(0, pos) + body[pos + 1] + body[pos] + body.slice(pos + 2);
    assert.throws(() => e2ee.parseRecoveryCode(swapped), /E2EE_RECOVERY/, `pos=${pos} 전치가 통과했다`);
  }
  // 길이/문자셋 오류
  assert.throws(() => e2ee.parseRecoveryCode('CPT1-ABCDE'), /E2EE_RECOVERY_LEN/);
  // 다른 기기에서 복구 코드만으로 열쇠 복원
  e2ee.removeState(); e2ee.clearCache(); e2ee.ensureIdentity({ deviceId: 77 });
  assert.deepStrictEqual(e2ee.restoreFromRecoveryCode(code), { epoch: 2 });
  assert.deepStrictEqual(e2ee.masterKey(2), mk);
  assert.strictEqual(e2ee.loadState().recoverySet, true);
});

// ── 알림 / 스냅샷 ─────────────────────────────────────────────────────────────
test('알림 body 봉인 — subtitle 강제(잠금화면 암호문 노출 방지), 접두사 판정', () => {
  bootAccount();
  const sealed = e2ee.sealNotifBody('claude 가 파일 3개를 수정했습니다');
  assert.ok(sealed.startsWith('cptenc:1:2:'));
  assert.strictEqual(e2ee.openNotifBody(sealed), 'claude 가 파일 3개를 수정했습니다');
  assert.strictEqual(e2ee.isSealedNotifBody(sealed), true);
  assert.strictEqual(e2ee.openNotifBody('평문 그대로'), '평문 그대로', '평문은 통과');

  // 라우팅 필드는 평문 유지 + subtitle 자동 보장(불변식 5·함정 7)
  const n = e2ee.sealNotification({ title: '작업 완료', body: '비밀 diff', kind: 'agent_done', cwd: 'proj/a', win: 3 });
  assert.strictEqual(n.kind, 'agent_done');
  assert.strictEqual(n.cwd, 'proj/a');
  assert.strictEqual(n.win, 3);
  assert.ok(n.subtitle && !n.subtitle.startsWith('cptenc:'), 'subtitle 없으면 FCM 본문이 암호문이 된다');
  assert.ok(n.body.startsWith('cptenc:1:'));
  assert.strictEqual(e2ee.openNotifBody(n.body), '비밀 diff');
  // 주어진 subtitle 은 보존
  assert.strictEqual(e2ee.sealNotification({ title: 't', subtitle: 'codingpt · 완료', body: 'x' }).subtitle, 'codingpt · 완료');
  // body 없으면 무변경
  assert.deepStrictEqual(e2ee.sealNotification({ title: 't' }), { title: 't' });
});

test('스냅샷 번들 봉인 — CPTS1 헤더, git bundle 매직 소거, epoch 별 복호', () => {
  bootAccount();
  const bundle = Buffer.concat([Buffer.from('PACK'), require('crypto').randomBytes(4096)]);
  const sealed = e2ee.sealSnapshot(bundle);
  assert.strictEqual(sealed.subarray(0, 6).toString('binary'), 'CPTS1\0');
  assert.strictEqual(e2ee.snapshotEpoch(sealed), 2);
  assert.strictEqual(sealed.length - bundle.length, 6 + 4 + 12 + 16, '스냅샷 오버헤드 38B 고정');
  assert.ok(!sealed.subarray(6).includes(Buffer.from('PACK')), 'git bundle 매직이 남으면 안 됨');
  assert.deepStrictEqual(e2ee.openSnapshot(sealed), bundle);
  assert.strictEqual(e2ee.isSealedSnapshot(bundle), false, '평문 번들은 그대로 인식(하위호환)');
  const t = Buffer.from(sealed); t[100] ^= 0xff;
  assert.throws(() => e2ee.openSnapshot(t), /E2EE_AUTH/);
});

test('스냅샷 스트리밍 — 8MB 파이프 왕복(200MB 번들 메모리 2배 방지), 잘림/변조 거부', async (t) => {
  bootAccount();
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  const plain = require('crypto').randomBytes(8 * 1024 * 1024);
  const chunks = [];
  for (let i = 0; i < plain.length; i += 65536) chunks.push(plain.subarray(i, i + 65536));

  const sealedParts = [];
  const t0 = process.hrtime.bigint();
  await pipeline(Readable.from(chunks), e2ee.sealSnapshotStream(), async function* (src) { for await (const c of src) sealedParts.push(c); });
  const sealed = Buffer.concat(sealedParts);
  const sealMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(sealed.length, plain.length + 38);
  assert.strictEqual(sealed.subarray(0, 6).toString('binary'), 'CPTS1\0');
  // 같은 바이트를 일괄 API 로도 열 수 있어야 한다(포맷 일치).
  assert.deepStrictEqual(e2ee.openSnapshot(sealed), plain);

  const back = [];
  const t1 = process.hrtime.bigint();
  await pipeline(Readable.from([sealed.subarray(0, 1000), sealed.subarray(1000)]), e2ee.openSnapshotStream(), async function* (src) { for await (const c of src) back.push(c); });
  const openMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.deepStrictEqual(Buffer.concat(back), plain);
  t.diagnostic(`스냅샷 스트림 8MB: seal ${sealMs.toFixed(1)}ms / open ${openMs.toFixed(1)}ms`);

  await assert.rejects(pipeline(Readable.from([sealed.subarray(0, sealed.length - 4)]), e2ee.openSnapshotStream(), async function* (s) { for await (const _ of s); }), /E2EE_AUTH|E2EE_PROTOCOL/);
  const bad = Buffer.from(sealed); bad[5000] ^= 0xff;
  await assert.rejects(pipeline(Readable.from([bad]), e2ee.openSnapshotStream(), async function* (s) { for await (const _ of s); }), /E2EE_AUTH/);
});

// ── 골든 벡터 ─────────────────────────────────────────────────────────────────
test('골든 벡터 — test/vectors/e2ee-v1.json 과 바이트 단위 일치(3구현체 동치 기준)', (t) => {
  bootAccount();
  const v = e2ee.vectors();
  // 자기 일관성: 벡터의 프레임/봉투를 다시 열 수 있어야 한다.
  assert.strictEqual(v.session.transcript.split('\n').length, 11);
  assert.strictEqual(v.session.transcript.split('\n')[10], 'pty|proj/a|p1|3');
  assert.strictEqual(v.session.sid.length, 64);
  for (const f of v.frames) {
    const frame = Buffer.from(f.frame, 'hex');
    const hdr = frame.subarray(0, 12);
    const pt = e2ee.aeadOpen(Buffer.from(v.session.kV2H, 'hex'), hdr, Buffer.concat([hdr, Buffer.from(v.session.sid, 'hex')]), frame.subarray(12), e2ee.SUITE);
    assert.deepStrictEqual(pt.subarray(0, 12), hdr);
    assert.strictEqual(pt.subarray(12).toString('hex'), f.payload);
  }
  assert.deepStrictEqual(e2ee.parseRecoveryCode(v.recovery.code).mk, Buffer.from(v.recovery.mk, 'hex'));

  if (!fs.existsSync(VECTOR_FILE)) {
    fs.mkdirSync(path.dirname(VECTOR_FILE), { recursive: true });
    fs.writeFileSync(VECTOR_FILE, JSON.stringify(v, null, 2) + '\n');
    t.diagnostic(`골든 벡터 생성: ${VECTOR_FILE}`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
  assert.deepStrictEqual(v, golden, '와이어 포맷이 바뀌었다 — 3구현체(모바일/PC)를 함께 고쳐야 한다');
});
