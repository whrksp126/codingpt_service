// LAN 직결(임무 F) 회귀/계약 테스트 — node --test
//   실행: node --test packages/runner-core/test/lan.test.js
//
// 이 파일이 못 박는 것(전부 "되돌리기 쉬운 한 줄"이 사고가 되는 지점):
//  A. 프레임 코덱 cpt-lan/1 왕복 + 1MiB 상한 위반 = 즉시 프로토콜 위반(소켓 파괴)
//  B. 사설 IP 게이팅 — 공용/링크로컬 피어는 붙지 못한다. 리스너는 사설 주소에만 바인드하고,
//     back 에 알리는 endpoint 에 loopback 을 넣지 않는다(원격 뷰어가 자기 자신에 붙어 쿨다운을 태운다).
//  C. grant challenge-response — **secret 은 와이어에 흐르지 않는다**(hello/auth 프레임 전체를 훑어 증명).
//     재사용 금지 · TTL · clientKey 바인딩 · 피어 IP 바인딩 · mac 불일치 · IP 레이트리밋.
//  D. RPC 허용 집합 — fs.watch/unwatch 는 **영구 제외**(fs.js watcher 가 프로세스 전역 1개라서
//     LAN watch 가 릴레이 watch 를 끈다 = IDE 라이브 동기화가 조용히 죽는 최악의 형태).
//  E. 터미널 PTY: 릴레이와 **같은 attachPty 한 벌**을 타고, 같은 pane 아이덴티티(paneId|client)면
//     기존 스트림을 축출해 tmux 클라이언트가 항상 1개다(12R/17R 크기 핑퐁 사고 재발 차단).
//  F. 강등: 직결 실패는 **조용히** 릴레이로 넘어가고 버퍼된 첫 요청 바이트를 유실하지 않는다.
//  G. 경로 상태(승격/강등/최소체류/쿨다운/부활) 히스테리시스.
//  H. 문구 규약 — LAN 실패 코드에 DAEMON_OFFLINE/"데몬이 연결"이 절대 섞이지 않는다
//     (모바일이 그 정규식으로 호스트 오프라인을 판정 → 차단 오버레이 오탐).
//
// 안전: 격리 tmux 소켓 + 격리 stateDir + **127.0.0.1 전용 바인드 + 랜덤 고포트** — 사용자의 실사용
//  데몬(47321)과 실제 Wi-Fi 노출을 건드리지 않는다.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const WebSocket = require('ws');

// ── 격리(require 전에!) ──
const SOCK = `codingpt-lan-test-${process.pid}-${Date.now()}`;
process.env.CODINGPT_TMUX_SOCKET = SOCK;
process.env.CPT_LAN_SCOPE = 'all';                       // F3(pty) 까지 열어 전 채널 검증
process.env.CPT_LAN_PORT = String(45000 + (process.pid % 2000)); // 실사용 47321 회피

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-lan-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: path.join(ROOT, '.claude') });

const lan = require('../lan');
const pty = require('../pty');
const forward = require('../forward');
assert.strictEqual(pty.TMUX_SOCKET, SOCK, '격리 tmux 소켓 미적용 — 중단');
assert.ok(lan.lanStateFile().startsWith(ROOT), '격리 stateDir 미적용 — 중단');

const WS_REL = 'wsL';
fs.mkdirSync(path.join(ROOT, WS_REL), { recursive: true });
const { session: NS } = pty.sessionForCwd(WS_REL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasTmux = (() => { try { execFileSync('/usr/bin/which', ['tmux']); return true; } catch (_) { return false; } })();
function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCK, ...args], { timeout: 5000 }, (err, out, se) => {
      if (err) return reject(new Error(String(se || err.message || '').trim()));
      resolve(String(out || ''));
    });
  });
}

// 주입되는 RPC 한 벌(control.dispatchRpc 자리) — 호출 기록으로 "정말 위임됐나"를 본다.
const rpcCalls = [];
function fakeRpc(method, params) {
  rpcCalls.push({ method, params });
  if (method === 'fs.list') return Promise.resolve({ entries: [{ name: 'a.ts' }] });
  if (method === 'net.ports') return Promise.resolve({ ports: [5173] });
  if (method === 'boom') return Promise.reject(Object.assign(new Error('실패했습니다'), { code: 'X_FAIL' }));
  return Promise.resolve({ ok: true, method });
}

let LAN_PORT = 0;
const openSockets = new Set();
function track(s) { openSockets.add(s); s.on('close', () => openSockets.delete(s)); return s; }

function newGrant(over = {}) {
  const grantId = 'lg-' + crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64');
  const g = {
    grantId, secret, clientKey: over.clientKey || 'pc-test',
    kind: 'pc', scopes: over.scopes || ['tcp', 'rpc', 'pty'],
    expiresAt: new Date(Date.now() + (over.ttlMs || 60000)).toISOString(),
    ...(over.peer ? { peer: over.peer } : {}),
    ...(over.maxUses ? { maxUses: over.maxUses } : {}),
  };
  const r = lan.addGrant(g);
  return { g, r };
}

// 프레임 수준 raw 클라이언트 — mac 을 우리가 정한다(잘못된 mac/버전 등 실패 경로 검증용).
// 반환: 수신한 CTRL 프레임 목록 + 우리가 보낸 바이트 전량(secret 유출 검사용).
function rawHandshake(port, { grantId, clientKey, mac, secret, v = 1 }) {
  return new Promise((resolve) => {
    const got = [];
    const sentChunks = [];
    const sock = track(net.connect({ host: '127.0.0.1', port }));
    const write = (b) => { sentChunks.push(Buffer.from(b)); try { sock.write(b); } catch (_) { /* noop */ } };
    const framer = lan.createFramer((type, ch, payload) => {
      if (type !== lan.T_CTRL) return true;
      let m = null;
      try { m = JSON.parse(payload.toString('utf8')); } catch (_) { return true; }
      got.push(m);
      if (m.t === 'chal') {
        const useMac = mac !== undefined ? mac : lan.macFor(secret, grantId, m.nonce, clientKey);
        write(lan.encodeCtrl({ t: 'auth', mac: useMac }));
      }
      if (m.t === 'ok' || m.t === 'err') setTimeout(() => { try { sock.destroy(); } catch (_) { /* noop */ } }, 30);
      return true;
    }, () => { /* noop */ });
    sock.on('data', (d) => framer(d));
    sock.on('connect', () => write(lan.encodeCtrl({ t: 'hello', v, grantId, client: clientKey, kind: 'pc' })));
    const done = () => resolve({ got, sent: Buffer.concat(sentChunks) });
    sock.on('close', done);
    sock.on('error', done);
    setTimeout(done, 4000).unref?.();
  });
}

after(async () => {
  try { lan.stop(); } catch (_) { /* noop */ }
  try { forward.stopAllForwards(); } catch (_) { /* noop */ }
  for (const s of openSockets) { try { s.destroy(); } catch (_) { /* noop */ } }
  try { await tmux(['kill-server']); } catch (_) { /* 이미 없음 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ── A. 프레임 코덱 ────────────────────────────────────────────────────────
test('A. 프레임 코덱 왕복(분할 수신 포함) + LEN 상한 위반 = 프로토콜 위반', () => {
  const frames = [];
  let violated = null;
  const push = lan.createFramer((t, ch, p) => { frames.push([t, ch, p]); return true; }, (c) => { violated = c; });
  const a = lan.encodeCtrl({ t: 'hello', v: 1 });
  const b = lan.encodeFrame(lan.T_DATA, 7, Buffer.from([1, 2, 3]));
  const c = lan.encodeFrame(lan.T_TEXT, 7, JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  const all = Buffer.concat([a, b, c]);
  // 1바이트씩 흘려도 경계가 정확해야 한다(TCP 는 프레임을 보존하지 않는다).
  for (let i = 0; i < all.length; i++) push(all.subarray(i, i + 1));
  assert.strictEqual(frames.length, 3);
  assert.deepStrictEqual(JSON.parse(frames[0][2].toString()), { t: 'hello', v: 1 });
  assert.strictEqual(frames[1][0], lan.T_DATA);
  assert.strictEqual(frames[1][1], 7);
  assert.deepStrictEqual([...frames[1][2]], [1, 2, 3]);
  assert.strictEqual(frames[2][0], lan.T_TEXT);
  assert.strictEqual(JSON.parse(frames[2][2].toString()).cols, 100);
  assert.strictEqual(violated, null);

  // LEN 상한 초과 = 즉시 위반(메모리 폭탄 차단).
  const bad = Buffer.alloc(8);
  bad.writeUInt32BE(lan.MAX_FRAME + 1, 0);
  const p2 = lan.createFramer(() => true, (c2) => { violated = c2; });
  assert.strictEqual(p2(bad), false);
  assert.strictEqual(violated, 'LAN_PROTO');
});

// ── B. 사설 IP 게이팅 ─────────────────────────────────────────────────────
test('B. 주소 분류 + 피어 정책 — 공용/링크로컬 거부, loopback/사설만 허용', () => {
  const t = (a) => lan.classifyAddr(a);
  assert.strictEqual(t('192.168.0.31').private, true);
  assert.strictEqual(t('10.1.2.3').private, true);
  assert.strictEqual(t('172.16.0.1').private, true);
  assert.strictEqual(t('172.32.0.1').private, false, '172.32 는 사설이 아니다(경계 오류의 고전)');
  assert.strictEqual(t('172.15.255.255').private, false);
  assert.strictEqual(t('8.8.8.8').private, false);
  assert.strictEqual(t('::ffff:192.168.1.5').private, true, 'IPv4-mapped 정규화 실패 = 게이팅 무력화');
  assert.strictEqual(t('::ffff:8.8.8.8').private, false);
  assert.strictEqual(t('fd00::1').private, true);
  assert.strictEqual(t('2001:4860::1').private, false);
  assert.strictEqual(t('fe80::1%en0').linkLocal, true, 'scope id 정규화');
  assert.strictEqual(t('127.0.0.1').loopback, true);

  assert.strictEqual(lan.peerPolicy('8.8.8.8', '192.168.0.31').code, 'PEER_NOT_PRIVATE');
  assert.strictEqual(lan.peerPolicy('fe80::1', '192.168.0.31').code, 'PEER_LINK_LOCAL');
  assert.strictEqual(lan.peerPolicy('192.168.0.9', '203.0.113.7').code, 'LOCAL_NOT_PRIVATE',
    '우리 쪽이 공용 IP 면 서비스 노출 — 거부해야 한다');
  assert.strictEqual(lan.peerPolicy('192.168.0.9', '192.168.0.31').ok, true);
  assert.strictEqual(lan.peerPolicy('127.0.0.1', '127.0.0.1', { allowLoopback: false }).code, 'PEER_LOOPBACK_DENIED');
});

// ── G. 경로 상태(승격/강등/최소체류/쿨다운/부활) ─────────────────────────
test('G. 경로 상태 머신 — 2연속 승격 / 하드 즉시 강등+쿨다운 배가 / 최소체류 / 부활', () => {
  let now = 1_000_000;
  lan.__setNow(() => now);
  lan.resetPaths();
  try {
    const k = lan.pathKey('pc-1', 12, '192.168.0.31');
    assert.strictEqual(lan.fingerprint('192.168.0.31'), '192.168.0.0/24');
    assert.strictEqual(lan.pathState(k), 'relay', '기본은 릴레이(항상 동작)');

    // 승격: 2연속 성공 && RTT ≤ 800ms
    assert.strictEqual(lan.noteProbeOk(k, 120), 'probing');
    assert.strictEqual(lan.noteProbeOk(k, 120), 'lan');
    // 최소 체류(30s) 안에서는 소프트 실패로 강등하지 않는다(플랩 방지)
    now += 5000;
    lan.noteSoftFail(k, 'rtt');
    lan.noteSoftFail(k, 'rtt');
    assert.strictEqual(lan.pathState(k), 'lan', '최소 체류 안에서 소프트 강등 = 플래핑');
    // 체류 후 소프트 2연속 → 강등 + 쿨다운(60s)
    now += 31000;
    lan.noteSoftFail(k, 'rtt');
    assert.strictEqual(lan.noteSoftFail(k, 'rtt'), 'relay');
    assert.strictEqual(lan.pathState(k), 'cooldown');
    assert.strictEqual(lan.shouldTry(k), false, '쿨다운 중 probe 금지');
    now += 60001;
    assert.strictEqual(lan.shouldTry(k), true);

    // 하드 실패는 즉시 강등하고 쿨다운이 배가된다(60s → 120s)
    lan.noteProbeOk(k, 50); lan.noteProbeOk(k, 50);
    assert.strictEqual(lan.pathState(k), 'lan');
    assert.strictEqual(lan.noteHardFail(k, 'auth'), 'relay');
    now += 60001;
    assert.strictEqual(lan.shouldTry(k), false, '연속 강등이면 쿨다운 ×2 여야 한다');
    now += 60000;
    assert.strictEqual(lan.shouldTry(k), true);

    // 부활(앱 복귀/네트워크 변경) — 쿨다운 1회 무시
    lan.noteHardFail(k, 'auth');
    assert.strictEqual(lan.shouldTry(k), false);
    lan.revive(k);
    assert.strictEqual(lan.shouldTry(k), true, 'revival trigger 가 쿨다운을 1회 무시해야 한다');
  } finally {
    lan.__setNow(null);
    lan.resetPaths();
  }
});

// ── B-2/리스너 기동 + 포트 복구 ───────────────────────────────────────────
test('B-2. 리스너 기동 — 127.0.0.1 바인드, lan.json 0600 저장, 재시작 시 같은 포트 복구', async () => {
  const r = await lan.start({ deviceId: 12, machineId: 'm-test', daemonVersion: '0.0.0-test' },
    { rpc: fakeRpc }, { bindHosts: ['127.0.0.1'] });
  assert.strictEqual(r.ok, true, `리스너 기동 실패: ${r.code}`);
  LAN_PORT = r.port;
  assert.ok(LAN_PORT >= 1024);

  const st = JSON.parse(fs.readFileSync(lan.lanStateFile(), 'utf8'));
  assert.strictEqual(st.port, LAN_PORT, 'lan.json 에 실제 바인드 포트를 남겨야 재시작 복구가 된다');
  assert.strictEqual((fs.statSync(lan.lanStateFile()).mode & 0o777), 0o600, 'lan.json 은 0600');

  // back 에 알리는 endpoint 에 loopback 이 섞이면 원격 뷰어가 자기 자신에 붙어 실패→쿨다운을 태운다.
  const nfo = lan.info();
  if (nfo) {
    assert.strictEqual(nfo.port, LAN_PORT);
    assert.strictEqual(nfo.proto, 1);
    assert.ok(!nfo.addrs.some((a) => lan.classifyAddr(a.host).loopback), 'info().addrs 에 loopback 금지');
    assert.ok(nfo.addrs.every((a) => lan.classifyAddr(a.host).private), 'info().addrs 는 사설만');
  }

  // 재시작(리스너 복구) — 같은 포트로 다시 열려야 한다.
  lan.stop();
  const r2 = await lan.start({ deviceId: 12, machineId: 'm-test', daemonVersion: '0.0.0-test' },
    { rpc: fakeRpc }, { bindHosts: ['127.0.0.1'] });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.port, LAN_PORT, '데몬 재시작 후 포트가 바뀌면 back 이 알던 좌표가 죽는다');

  // CPT_LAN_PORT=0 = OS 할당 — 실제 포트를 확정해 보고한다(0 을 그대로 보고하면 뷰어가 영원히 못 붙는다).
  const prevPort = process.env.CPT_LAN_PORT;
  try {
    lan.stop();
    process.env.CPT_LAN_PORT = '0';
    const r3 = await lan.start({ deviceId: 12, machineId: 'm-test' }, { rpc: fakeRpc }, { bindHosts: ['127.0.0.1'] });
    assert.strictEqual(r3.ok, true);
    assert.ok(r3.port > 0 && r3.port <= 65535, `OS 할당 포트가 확정되지 않았다: ${r3.port}`);
  } finally {
    lan.stop();
    process.env.CPT_LAN_PORT = prevPort;
    const back = await lan.start({ deviceId: 12, machineId: 'm-test', daemonVersion: '0.0.0-test' },
      { rpc: fakeRpc }, { bindHosts: ['127.0.0.1'] });
    assert.strictEqual(back.port, LAN_PORT);
  }
});

// ── C. grant 인증(성공) + 토큰 미노출 ────────────────────────────────────
test('C. grant challenge-response 성공 — secret/mac 재료가 와이어에 흐르지 않는다', async () => {
  const { g, r } = newGrant();
  assert.strictEqual(r.ok, true);
  const { got, sent } = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  const kinds = got.map((m) => m.t);
  assert.deepStrictEqual(kinds, ['chal', 'ok'], `핸드셰이크 순서가 다르다: ${JSON.stringify(got)}`);
  assert.ok(got[0].nonce && got[0].nonce.length >= 20, 'nonce 가 없으면 challenge-response 가 아니다');
  assert.strictEqual(got[0].deviceId, 12);
  assert.strictEqual(got[0].machineId, 'm-test');
  assert.deepStrictEqual(got[1].scopes.sort(), ['pty', 'rpc', 'tcp']);
  assert.ok(got[1].smac, '상호 인증(smac)이 없으면 사칭 호스트에게 파일/키입력을 넘긴다');

  // 뷰어가 보낸 **모든 바이트**에 secret 이 없어야 한다(=토큰 미노출의 직접 증거).
  const wire = sent.toString('latin1');
  assert.ok(!wire.includes(g.secret), '와이어에 grant secret 평문이 흘렀다');
  assert.ok(!wire.includes(Buffer.from(g.secret, 'base64').toString('latin1')), '와이어에 secret 원문 바이트가 흘렀다');
  assert.ok(wire.includes(g.grantId), 'grantId(식별자)는 흐른다 — 비밀이 아니다');
});

// ── C-2. 실패 계약: 재사용 / TTL / clientKey / 피어 IP / mac ─────────────
test('C-2. grant 재사용 거부(단일 사용)', async () => {
  const { g } = newGrant();
  const a = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  assert.strictEqual(a.got[a.got.length - 1].t, 'ok');
  const b = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  assert.deepStrictEqual(b.got.map((m) => m.t), ['err']);
  assert.strictEqual(b.got[0].code, 'BAD_GRANT', '한 번 쓴 grant 는 두 번 통하면 안 된다');
});

test('C-3. TTL 초과 grant 는 거부', async () => {
  const { g, r } = newGrant({ ttlMs: 300 });
  assert.strictEqual(r.ok, true);
  await sleep(420);
  const x = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  assert.deepStrictEqual(x.got.map((m) => m.t), ['err']);
  assert.strictEqual(x.got[0].code, 'EXPIRED');
  // 등록 시점 검증도 함께(과거 만료를 애초에 받지 않는다)
  const past = lan.addGrant({ grantId: 'lg-' + 'a'.repeat(12), secret: crypto.randomBytes(32).toString('base64'), clientKey: 'x', scopes: ['tcp'], expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepStrictEqual(past, { ok: false, error: 'EXPIRED' });
});

test('C-3b. 재사용/만료는 IP 레이트리밋에 세지 않는다(자가 DoS 금지)', async () => {
  lan.__resetLimits();
  // 우리 클라이언트가 스테일 grant 로 3번 재시도해도, 그 직후 **새 grant** 로는 붙을 수 있어야 한다.
  //  (세면 폰이 새 grant 를 받아 재시도하려는 60초를 데몬이 스스로 막는다)
  for (let i = 0; i < 3; i++) {
    const { g } = newGrant({ ttlMs: 200 });
    await sleep(260);
    const x = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
    assert.strictEqual(x.got[0].code, 'EXPIRED');
  }
  const { g: fresh } = newGrant();
  const ok = await rawHandshake(LAN_PORT, { grantId: fresh.grantId, clientKey: fresh.clientKey, secret: fresh.secret });
  assert.strictEqual(ok.got[ok.got.length - 1].t, 'ok', '만료 재시도가 우리 자신을 차단했다');
});

test('C-4. clientKey / 피어 IP 바인딩 불일치 거부', async () => {
  lan.__resetLimits();
  const { g } = newGrant({ clientKey: 'pc-alpha' });
  const bad = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: 'pc-beta', secret: g.secret });
  assert.strictEqual(bad.got[0].code, 'BAD_GRANT', 'clientKey 가 달라도 통과하면 grant 가 양도 가능해진다');

  const { g: g2 } = newGrant({ peer: '10.9.9.9' });
  const bad2 = await rawHandshake(LAN_PORT, { grantId: g2.grantId, clientKey: g2.clientKey, secret: g2.secret });
  assert.strictEqual(bad2.got[0].code, 'PEER_MISMATCH', '바인드 IP 검증이 없다');
  lan.__resetLimits();
});

test('C-5. mac 불일치 거부 — grant 는 소모되지 않는다(DoS 방지)', async () => {
  lan.__resetLimits();
  const { g } = newGrant();
  const bad = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, mac: 'AAAA' });
  assert.deepStrictEqual(bad.got.map((m) => m.t), ['chal', 'err']);
  assert.strictEqual(bad.got[1].code, 'LAN_AUTH_FAILED');
  // 같은 grant 로 정상 mac 은 여전히 통해야 한다(공격자가 사용자의 grant 를 태우지 못한다)
  const ok = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  assert.strictEqual(ok.got[ok.got.length - 1].t, 'ok');
  lan.__resetLimits();
});

// ── D. RPC 왕복 + 허용 집합 ──────────────────────────────────────────────
test('D. RPC 왕복(주입된 디스패처) + 허용 집합 게이팅(fs.watch 영구 제외)', async () => {
  const { g } = newGrant();
  const s = await lan.connect({ host: '127.0.0.1', port: LAN_PORT, grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc' });
  try {
    assert.deepStrictEqual(await s.rpc('fs.list', { path: 'wsL' }), { entries: [{ name: 'a.ts' }] });
    assert.deepStrictEqual(await s.rpc('net.ports', {}), { ports: [5173] });
    assert.strictEqual(rpcCalls.some((c) => c.method === 'fs.list'), true, '주입 디스패처로 위임되지 않았다');

    // fs.watch/unwatch — 전역 단일 watcher 사고 방지로 LAN 에서 영구 제외.
    await assert.rejects(() => s.rpc('fs.watch', { path: 'wsL' }), (e) => e.code === 'LAN_METHOD_NOT_ALLOWED');
    await assert.rejects(() => s.rpc('fs.unwatch', {}), (e) => e.code === 'LAN_METHOD_NOT_ALLOWED');
    assert.strictEqual(rpcCalls.some((c) => c.method === 'fs.watch'), false, 'fs.watch 가 데몬까지 도달했다(릴레이 watch 를 끈다)');
    // 서버가 단일 순서 권위를 갖는 것들도 직결로 흐르지 않는다.
    for (const m of ['agent.start', 'sync.checkpoint', 'approval.resolve', 'chat.open', 'sealed', 'e2ee.begin']) {
      await assert.rejects(() => s.rpc(m, {}), (e) => e.code === 'LAN_METHOD_NOT_ALLOWED', `${m} 이 직결로 통과했다`);
    }
    // 실패는 code 를 그대로 실어 보낸다(문구 정규식 추측 금지 규율).
    await assert.rejects(() => s.rpc('ws.boom', {}).then(() => { throw new Error('no'); }), () => true);
    assert.strictEqual(lan.rpcAllowed('fs.read'), true);
    assert.strictEqual(lan.rpcAllowed('fs.watch'), false);
    assert.strictEqual(lan.rpcAllowed('terminal.list'), true);
  } finally { s.close(); }
});

// ── D-2. scope 게이팅 ────────────────────────────────────────────────────
test('D-2. grant scope 밖 채널/RPC 은 열리지 않는다(CPT_LAN_SCOPE 와 교집합)', async () => {
  const { g } = newGrant({ scopes: ['tcp'] }); // rpc/pty 없음
  const s = await lan.connect({ host: '127.0.0.1', port: LAN_PORT, grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc' });
  try {
    assert.deepStrictEqual(s.scopes, ['tcp']);
    await assert.rejects(() => s.rpc('fs.list', {}), (e) => e.code === 'LAN_SCOPE');
    await assert.rejects(() => s.openPty({ cwd: WS_REL }), (e) => e.code === 'LAN_SCOPE');
  } finally { s.close(); }
});

// ── TCP 채널(프리뷰 F1) 왕복 ─────────────────────────────────────────────
test('E. tcp 채널 왕복 — loopback 고정, 없는 포트는 openfail', async () => {
  const echo = net.createServer((c) => c.on('data', (d) => c.write(Buffer.concat([Buffer.from('R:'), d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  const { g } = newGrant();
  const s = await lan.connect({ host: '127.0.0.1', port: LAN_PORT, grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc' });
  try {
    const ch = await s.openTcp(echoPort);
    const rx = [];
    ch.onData = (b) => rx.push(b);
    ch.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    for (let i = 0; i < 40 && !rx.length; i++) await sleep(25);
    assert.strictEqual(Buffer.concat(rx).toString(), 'R:GET / HTTP/1.1\r\n\r\n');
    ch.close();
    // 닫힌 포트 → openfail(코드 그대로)
    const dead = net.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));
    await assert.rejects(() => s.openTcp(deadPort), (e) => /ECONNREFUSED|LAN_/.test(e.code));
  } finally {
    s.close();
    await new Promise((r) => echo.close(r));
  }
});

// ── E. 터미널 PTY(F3) ────────────────────────────────────────────────────
// 릴레이와 같은 attachPty 한 벌 + 아이덴티티 승계(select 스왑) + 같은 pkey 축출(클라이언트 1개).
test('E-2. pty 채널: resize(TEXT)/stdin(DATA) 계약 + select 스왑 + 같은 pane 축출', { skip: !hasTmux }, async () => {
  const a = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const b = await pty.handleTerminalRpc('terminal.new', { cwd: WS_REL });
  const { g } = newGrant();
  const s = await lan.connect({ host: '127.0.0.1', port: LAN_PORT, grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc' });
  try {
    // 릴레이(daemonRelayService → openPtyStream)가 넘기는 것과 **완전 동일한 키**.
    const params = { cwd: WS_REL, paneId: 'pL', client: 'cL', win: a.index, cols: 80, rows: 24 };
    const ch = await s.openPty(params);
    const rx = [];
    ch.onData = (buf) => rx.push(buf);
    // 첫 resize 는 TEXT 프레임(= 옛 텍스트 JSON). 채널 오픈 직후 보내 early 버퍼 경로도 함께 태운다.
    ch.sendText(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await sleep(1300); // attach + nudge(600ms) 안정화
    assert.ok(Buffer.concat(rx).length > 0, 'attach 출력이 LAN 채널로 흐르지 않는다');

    const clients = await tmux(['list-clients', '-t', `=${pty.termSession(NS, a.index)}`, '-F', '#{client_width}x#{client_height}']);
    assert.match(clients.trim(), /(^|\s)100x30(\s|$)/, `TEXT resize 가 tmux 클라이언트에 반영되지 않았다(80x24 고착): ${clients.trim()}`);

    ch.write(Buffer.from('echo LAN-A\r'));
    await sleep(700);
    const capA = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, a.index)}:0`, '-S', '-30']);
    assert.match(capA, /LAN-A/, 'DATA 프레임이 stdin 으로 들어가지 않았다');

    // 아이덴티티 승계: 릴레이로 오는 terminal.select 가 **LAN 스트림**을 찾아 스왑해야 한다.
    const sel = await pty.handleTerminalRpc('terminal.select', { cwd: WS_REL, index: b.index, paneId: 'pL', client: 'cL' });
    assert.strictEqual(sel.index, b.index);
    await sleep(700);
    ch.write(Buffer.from('echo LAN-B\r'));
    await sleep(700);
    const capB = await tmux(['capture-pane', '-p', '-t', `=${pty.termSession(NS, b.index)}:0`, '-S', '-30']);
    assert.match(capB, /LAN-B/, 'select 스왑이 LAN 스트림을 못 찾았다(pkey 승계 실패 = 유령 탭)');

    // 같은 pane 아이덴티티로 다시 열기(경로 전환/재접속 겹침) → 옛 스트림 축출, 클라이언트 1개.
    let closedOld = false;
    ch.onClose = () => { closedOld = true; };
    const ch2 = await s.openPty({ ...params, win: b.index, cols: 90, rows: 26 });
    ch2.sendText(JSON.stringify({ type: 'resize', cols: 90, rows: 26 }));
    await sleep(1300);
    assert.strictEqual(closedOld, true, '옛 스트림이 닫히지 않았다(같은 세션에 tmux 클라이언트 2개 = 크기 핑퐁)');
    const cl2 = (await tmux(['list-clients', '-t', `=${pty.termSession(NS, b.index)}`, '-F', '#{client_width}x#{client_height}']))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    assert.strictEqual(cl2.length, 1, `경로 전환 후 tmux 클라이언트가 ${cl2.length}개 — 1개여야 한다(§5.1)`);
    assert.strictEqual(cl2[0], '90x26', `승계된 클라이언트 크기가 틀리다: ${cl2[0]}`);
    ch2.close();
    await sleep(200);
  } finally {
    s.close();
    await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: a.index });
    await pty.handleTerminalRpc('terminal.close', { cwd: WS_REL, index: b.index });
  }
});

// ── F. 강등: 직결 실패 → 조용히 릴레이(버퍼 승계) ────────────────────────
test('F. forward 강등 — 직결로 흐르다가 실패하면 같은 연결이 릴레이로 넘어가고 첫 요청이 유실되지 않는다', async () => {
  // "dev 서버" = 에코, "back 릴레이" = /api/daemon/forward/<token> 을 에코로 브리지하는 가짜 WS 서버.
  const echo = net.createServer((c) => c.on('data', (d) => c.write(Buffer.concat([Buffer.from('R:'), d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  let relayHits = 0;
  const httpServer = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!/\/api\/daemon\/forward\//.test(req.url || '')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      relayHits += 1;
      const up = net.connect({ host: '127.0.0.1', port: echoPort });
      ws.on('message', (d) => up.write(d));
      up.on('data', (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); });
      const bye = () => { try { up.destroy(); } catch (_) { /* noop */ } try { ws.close(); } catch (_) { /* noop */ } };
      ws.on('close', bye); up.on('close', bye); up.on('error', bye);
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const backPort = httpServer.address().port;

  const listenPort = 24000 + (process.pid % 1000);
  const { g } = newGrant();
  lan.resetPaths();
  const upstream = {
    mode: 'lan', host: '127.0.0.1', lanPort: LAN_PORT, remotePort: echoPort,
    grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc', hostDeviceId: 12,
  };
  const key = lan.pathKey(g.clientKey, 12, '127.0.0.1');
  const started = await forward.startLocalForward({
    serverUrl: `http://127.0.0.1:${backPort}`, port: listenPort, token: 'tok-lan', upstream,
  });
  assert.strictEqual(started.ok, true, `포워더 기동 실패: ${started.error}`);

  const roundtrip = (payload) => new Promise((resolve, reject) => {
    const c = track(net.connect({ host: '127.0.0.1', port: listenPort }));
    let out = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('왕복 시간 초과')); }, 5000);
    c.on('connect', () => c.write(payload)); // connect 직후 즉시 전송 = 상류 확립 전 버퍼 경로
    c.on('data', (d) => { out += d.toString(); clearTimeout(t); c.end(); resolve(out); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });

  // 1) 직결 경로 — back(릴레이)은 한 번도 안 열린다(= "정말 우회했다"의 증거).
  assert.strictEqual(await roundtrip('A1'), 'R:A1');
  assert.strictEqual(relayHits, 0, '직결인데 릴레이 WS 가 열렸다');
  assert.strictEqual(lan.pathState(key), 'probing');

  // 2) LAN 리스너 사망 → 같은 연결이 조용히 릴레이로 넘어가고 첫 바이트가 살아 있어야 한다.
  lan.stop();
  assert.strictEqual(await roundtrip('A2'), 'R:A2', '강등 시 버퍼된 첫 요청이 유실됐다(빈 화면 사고)');
  assert.strictEqual(relayHits, 1, '릴레이로 폴백하지 않았다');
  assert.strictEqual(lan.pathState(key), 'cooldown', '하드 실패는 즉시 강등 + 쿨다운이어야 한다');

  // 3) 쿨다운 중에는 시도조차 하지 않는다(연결마다 타임아웃을 태우지 않는다).
  assert.strictEqual(await roundtrip('A3'), 'R:A3');
  assert.strictEqual(relayHits, 2);

  forward.stopLocalForward(listenPort);
  await new Promise((r) => httpServer.close(r));
  try { wss.close(); } catch (_) { /* noop */ }
  await new Promise((r) => echo.close(r));
  lan.resetPaths();
  // 이후 테스트를 위해 리스너 복구(같은 포트)
  const again = await lan.start({ deviceId: 12, machineId: 'm-test', daemonVersion: '0.0.0-test' },
    { rpc: fakeRpc }, { bindHosts: ['127.0.0.1'] });
  assert.strictEqual(again.port, LAN_PORT);
});

// ── F-2. grant 소진(데몬 재시작 등) → 1회 재발급 재시도, 강등 카운터 무소모 ─
test('F-2. 소진된 grant 로 시작해도 refresh 1회로 직결 유지(릴레이로 안 떨어진다)', async () => {
  const echo = net.createServer((c) => c.on('data', (d) => c.write(Buffer.concat([Buffer.from('R:'), d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  let relayHits = 0;
  const httpServer = http.createServer();
  httpServer.on('upgrade', (req, socket) => { relayHits += 1; socket.destroy(); });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));

  lan.resetPaths();
  lan.__resetLimits();
  // 이미 써 버린 grant(= 데몬 재시작으로 사라진 grant 와 동형 실패: LAN_AUTH_FAILED)
  const { g: spent } = newGrant();
  await rawHandshake(LAN_PORT, { grantId: spent.grantId, clientKey: spent.clientKey, secret: spent.secret });

  let refreshCalls = 0;
  const listenPort = 26000 + (process.pid % 1000);
  const started = await forward.startLocalForward({
    serverUrl: `http://127.0.0.1:${httpServer.address().port}`, port: listenPort, token: 'tok-r',
    upstream: {
      mode: 'lan', host: '127.0.0.1', lanPort: LAN_PORT, remotePort: echoPort,
      grantId: spent.grantId, secret: spent.secret, clientKey: spent.clientKey, kind: 'pc', hostDeviceId: 12,
      refresh: () => { refreshCalls += 1; const { g } = newGrant(); return { grantId: g.grantId, secret: g.secret }; },
    },
  });
  assert.strictEqual(started.ok, true);
  const out = await new Promise((resolve, reject) => {
    const c = track(net.connect({ host: '127.0.0.1', port: listenPort }));
    const t = setTimeout(() => { c.destroy(); reject(new Error('왕복 시간 초과')); }, 5000);
    c.on('connect', () => c.write('RF'));
    c.on('data', (d) => { clearTimeout(t); c.end(); resolve(d.toString()); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  assert.strictEqual(out, 'R:RF', 'grant 재발급 재시도가 첫 요청 바이트를 살리지 못했다');
  assert.strictEqual(refreshCalls, 1, 'grant 재발급이 정확히 1회여야 한다');
  assert.strictEqual(relayHits, 0, '재발급으로 붙을 수 있었는데 릴레이로 떨어졌다');
  assert.notStrictEqual(lan.pathState(lan.pathKey('pc-test', 12, '127.0.0.1')), 'cooldown',
    '재발급 재시도가 강등 카운터를 소모했다(§5.5 위반)');

  forward.stopLocalForward(listenPort);
  await new Promise((r) => httpServer.close(r));
  await new Promise((r) => echo.close(r));
  lan.resetPaths();
});

// ── H. 문구 규약 + 킬스위치 ──────────────────────────────────────────────
test('H. 실패 문구 규약(호스트 오프라인 오탐 금지) + 킬스위치 한 스위치 원복', () => {
  // 주석은 규율을 **설명**하므로 제외하고 실제 코드만 훑는다.
  const code = fs.readFileSync(path.join(__dirname, '..', 'lan.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  assert.ok(!/DAEMON_OFFLINE/.test(code), 'LAN 코드에 DAEMON_OFFLINE 이 있으면 모바일이 호스트 오프라인으로 오탐한다');
  assert.ok(!/데몬이 연결/.test(code), 'LAN 실패 문구에 "데몬이 연결" 금지(정규식 오탐)');
  // 클라이언트에 노출되는 실패 코드는 전부 LAN_* 접두사여야 한다(경로 상태와 호스트 상태의 완전 분리).
  const fwd = fs.readFileSync(path.join(__dirname, '..', 'forward.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  assert.ok(!/DAEMON_OFFLINE|데몬이 연결/.test(fwd), 'forward 강등 경로에 오프라인 오탐 문구 금지');
  // 킬스위치
  const prev = process.env.CPT_LAN;
  const prevScope = process.env.CPT_LAN_SCOPE;
  try {
    process.env.CPT_LAN = '0';
    assert.strictEqual(lan.enabled(), false);
    assert.strictEqual(lan.allows('tcp'), false);
    delete process.env.CPT_LAN;
    process.env.CPT_LAN_SCOPE = 'tcp';
    assert.deepStrictEqual(lan.scopesForDaemon(), ['tcp'], '기본 스코프는 프리뷰(tcp)만');
    process.env.CPT_LAN_SCOPE = 'rpc';
    assert.deepStrictEqual(lan.scopesForDaemon(), ['tcp', 'rpc']);
    process.env.CPT_LAN_SCOPE = 'all';
    assert.deepStrictEqual(lan.scopesForDaemon(), ['tcp', 'rpc', 'pty']);
  } finally {
    if (prev === undefined) delete process.env.CPT_LAN; else process.env.CPT_LAN = prev;
    process.env.CPT_LAN_SCOPE = prevScope;
  }
});

// ── I. 무트래픽 TTL(경로 주장 철회) — 계약 §4.10 ──────────────────────────
// 닫는 한계: 강등 신호(noteSoftFail/noteHardFail)는 **실트래픽이 있을 때만** 불린다. 그래서 프리뷰
//  실트래픽(PC JS clientKey)으로 승격된 엔트리는 PC 의 검증 probe(데몬 뷰어 clientKey = **다른 키**)로
//  강등되지 않고 영원히 'lan' 으로 동결됐다 → 집을 떠나도 "직결" 배지가 켜져 있는 거짓 표시.
// 여기서 못 박는 것: ① 무소식이면 스스로 내려온다 ② **흐르고 있는 직결은 절대 내려가지 않는다**
//  ③ 내려오는 방식은 "주장 철회"뿐(쿨다운·백오프 승수 무손상 = 지연 회귀 금지, 릴레이 강제 금지).
test('I. 무트래픽 TTL — 무소식이면 직결 주장을 스스로 철회하고, 바이트가 흐르는 직결은 강등되지 않는다', async () => {
  const TTL = lan.NO_TRAFFIC_TTL_MS;
  assert.ok(Number.isFinite(TTL) && TTL > 0, 'TTL 상수가 노출되지 않았다');
  assert.ok(TTL >= 2 * 5 * 60 * 1000,
    'TTL 은 PC 검증 probe 간격(VERIFY_GAP_MS=5분)의 2배 이상 — 폴링 1회를 놓쳐도 배지가 깜빡이면 안 된다');

  const echo = net.createServer((c) => c.on('data', (d) => c.write(Buffer.concat([Buffer.from('R:'), d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  // 릴레이가 열리면 곧 "직결이 죽었다"는 뜻이다 — 이 테스트에서는 0 이어야 한다.
  let relayHits = 0;
  const httpServer = http.createServer();
  httpServer.on('upgrade', (req, socket) => { relayHits += 1; socket.destroy(); });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));

  let now = 5_000_000;
  lan.__setNow(() => now);
  lan.resetPaths();
  lan.__resetLimits();
  const listenPort = 28000 + (process.pid % 1000);
  // clientKey 는 **PC 웹뷰(프리뷰)** 쪽 값 — 데몬 뷰어 키로 도는 검증 probe 가 만질 수 없는 그 엔트리다.
  const { g } = newGrant({ clientKey: 'pc-webview-ttl' });
  const key = lan.pathKey(g.clientKey, 12, '127.0.0.1');
  const started = await forward.startLocalForward({
    serverUrl: `http://127.0.0.1:${httpServer.address().port}`, port: listenPort, token: 'tok-ttl',
    upstream: {
      mode: 'lan', host: '127.0.0.1', lanPort: LAN_PORT, remotePort: echoPort,
      grantId: g.grantId, secret: g.secret, clientKey: g.clientKey, kind: 'pc', hostDeviceId: 12,
    },
  });
  assert.strictEqual(started.ok, true, `포워더 기동 실패: ${started.error}`);

  const live = () => new Promise((resolve, reject) => {
    const c = track(net.connect({ host: '127.0.0.1', port: listenPort }));
    const t = setTimeout(() => { c.destroy(); reject(new Error('연결 시간 초과')); }, 5000);
    c.on('connect', () => { clearTimeout(t); resolve(c); });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  const exchange = (c, payload) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('왕복 시간 초과')), 5000);
    c.once('data', (d) => { clearTimeout(t); resolve(d.toString()); });
    c.write(payload);
  });

  try {
    // 승격 — 연결 1개 = 성공 1단위(PROMOTE_OK_STREAK=2).
    const c1 = await live();
    assert.strictEqual(await exchange(c1, 'P1'), 'R:P1');
    assert.strictEqual(lan.pathState(key), 'probing');
    const c2 = await live();
    assert.strictEqual(await exchange(c2, 'P2'), 'R:P2');
    assert.strictEqual(lan.pathState(key), 'lan');
    assert.strictEqual(relayHits, 0, '직결인데 릴레이가 열렸다');

    // ② 흐르고 있는 직결 — 새 연결이 더 생기지 않아도(오래 열린 HMR/WS 스트림) 강등되면 안 된다.
    now += TTL - 60_000;
    assert.strictEqual(lan.pathState(key), 'lan', 'TTL 전에 내려가면 정상 사용을 깨뜨린다');
    assert.strictEqual(await exchange(c2, 'P3'), 'R:P3');   // 호스트→우리 바이트 도착 = noteTraffic
    now += TTL - 60_000;                                    // 누적 경과 = TTL 초과(무소식 판정이면 만료됐을 시점)
    assert.strictEqual(lan.pathState(key), 'lan',
      '바이트가 흐르는데 TTL 이 강등했다 — TTL 은 "무소식" 에만 반응해야 한다');

    // ① 무소식 — 마지막 바이트로부터 TTL 초과 → 주장 철회.
    now += 120_000;
    // 강등 목표가 **'relay'** 인 것이 계약이다(값을 'probing' 으로 되돌리면 아래 I-3 이 깨진다):
    //  같은 호스트의 실패한 형제 엔트리(cooldown)를 lan-local.status 집계가 가리지 않게 하기 위해서다
    //  (MODE_RANK: probing 3 > cooldown 2 > relay 1).
    assert.strictEqual(lan.pathState(key), 'relay', '무트래픽 TTL 이 지났는데 여전히 lan(거짓 배지)');
    // ③ 철회는 벌이 아니다 — 쿨다운 미부과 + 백오프 승수 보존 + 다음 연결은 여전히 직결을 쓴다.
    assert.strictEqual(lan.shouldTry(key), true, 'TTL 이 쿨다운을 걸면 다음 프리뷰가 60s 이상 릴레이로 밀린다');
    const snap = lan.pathSnapshot()[key];
    assert.strictEqual(snap.cooldownUntil, 0);
    assert.strictEqual(snap.cooldownMs, 0, 'TTL 철회가 백오프 승수를 건드리면 플래핑 백오프가 무의미해진다');
    assert.strictEqual(snap.okStreak, 0, '만료된 승격 근거(한 시간 전 probe)를 오늘의 성공과 합치면 안 된다');

    // 재승격 — 같은 좌표로 다시 흐르면 원래대로. 릴레이로 밀린 연결은 하나도 없다.
    const c3 = await live();
    assert.strictEqual(await exchange(c3, 'P4'), 'R:P4');
    assert.strictEqual(lan.pathState(key), 'probing');
    const c4 = await live();
    assert.strictEqual(await exchange(c4, 'P5'), 'R:P5');
    assert.strictEqual(lan.pathState(key), 'lan', 'TTL 철회 뒤 재승격이 안 되면 직결이 영구히 죽는다');
    assert.strictEqual(relayHits, 0, 'TTL 철회가 트래픽을 릴레이로 밀어냈다');
    for (const c of [c1, c2, c3, c4]) { try { c.destroy(); } catch (_) { /* noop */ } }
  } finally {
    forward.stopLocalForward(listenPort);
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => echo.close(r));
    lan.__setNow(null);
    lan.resetPaths();
  }
});

test('I-2. TTL × 쿨다운/부활 상호작용 — 만료가 쿨다운을 풀지 않고, 부활은 백오프 승수를 보존한다', () => {
  let now = 9_000_000;
  lan.__setNow(() => now);
  lan.resetPaths();
  try {
    const k = lan.pathKey('pc-1', 77, '192.168.7.5');
    // 백오프를 상한까지 올린다(60s→120→240→480→900 상한) — 쿨다운(15분)이 TTL(10분)보다 길어지는
    //  유일한 구간이고, 여기서 TTL 이 쿨다운을 덮어쓰면 "실패한 경로를 곧바로 다시 두드리는" 회귀가 된다.
    for (let i = 0; i < 5; i++) lan.noteHardFail(k, 'auth');
    const cd = lan.pathSnapshot()[k];
    assert.strictEqual(cd.cooldownMs, 15 * 60 * 1000, '쿨다운 상한은 15분');
    assert.strictEqual(lan.shouldTry(k), false);

    now += lan.NO_TRAFFIC_TTL_MS + 1000;     // TTL 만료 시점(아직 쿨다운 5분 남음)
    assert.strictEqual(lan.pathState(k), 'cooldown', 'TTL 만료가 남은 쿨다운을 지웠다');
    assert.strictEqual(lan.shouldTry(k), false, 'TTL 이 쿨다운을 풀면 백오프가 무의미해진다');
    // 쿨다운 중에는 probe 성공도 승격시키지 않는다(TTL 만료가 그 울타리를 흔들지 않는다).
    lan.noteProbeOk(k, 10); lan.noteProbeOk(k, 10);
    assert.strictEqual(lan.pathState(k), 'cooldown');

    // 부활(재접속 훅) — 쿨다운은 1회 무시되지만 **백오프 승수는 남는다**(불안정 망에서 60s 로 리셋 금지).
    assert.strictEqual(lan.reviveAll('control-reconnect'), 1, '쿨다운 중인 엔트리를 부활시켜야 한다');
    assert.strictEqual(lan.shouldTry(k), true);
    assert.notStrictEqual(lan.pathState(k), 'lan', '부활이 직결 주장을 되살려선 안 된다(근거 없는 배지)');
    lan.noteHardFail(k, 'auth');
    assert.strictEqual(lan.pathSnapshot()[k].cooldownMs, 15 * 60 * 1000,
      '부활 후 첫 강등이 60s 로 되돌아가면 플래핑 백오프가 사라진다');
    // 부활은 TTL 시계를 밀지 않는다 — 밀면 재접속마다 거짓 'lan' 이 TTL 만큼 연장된다.
    lan.resetPaths();
    const k2 = lan.pathKey('pc-1', 78, '192.168.7.5');
    lan.noteProbeOk(k2, 10); lan.noteProbeOk(k2, 10);
    assert.strictEqual(lan.pathState(k2), 'lan');
    now += lan.NO_TRAFFIC_TTL_MS - 1000;
    lan.reviveAll('control-reconnect');
    now += 2000;
    assert.strictEqual(lan.pathState(k2), 'relay', '부활이 TTL 시계를 밀어 거짓 배지가 연장됐다');

    // 네트워크 변경(인터페이스 감시 훅) — 이전 망의 이력은 통째로 무의미하다(모바일 net_change 등가).
    lan.resetPaths();
    const k3 = lan.pathKey('pc-1', 79, '192.168.9.9');
    lan.noteProbeOk(k3, 10); lan.noteProbeOk(k3, 10);
    lan.noteHardFail(k3, 'auth');            // 쿨다운 이력까지 만든 뒤
    lan.noteProbeOk(k3, 10); lan.noteProbeOk(k3, 10);
    const nc = lan.noteNetChange('if-change');
    assert.deepStrictEqual(nc, { entries: 1, demoted: 0 });
    assert.strictEqual(lan.pathState(k3), 'relay');
    assert.strictEqual(lan.shouldTry(k3), true, '망이 바뀌면 이전 망의 쿨다운으로 새 망을 막아선 안 된다');
    assert.strictEqual(lan.pathSnapshot()[k3].cooldownMs, 0);
    // 'lan' 주장도 함께 내려간다(망이 바뀐 뒤에도 켜져 있는 배지가 이 라운드의 거짓 표시다).
    lan.resetPaths();
    const k4 = lan.pathKey('pc-1', 80, '192.168.9.9');
    lan.noteProbeOk(k4, 10); lan.noteProbeOk(k4, 10);
    assert.strictEqual(lan.noteNetChange('if-change').demoted, 1);
    assert.strictEqual(lan.pathState(k4), 'relay');
  } finally {
    lan.__setNow(null);
    lan.resetPaths();
  }
});

test('I-3. 부활/TTL 배선 — revive 는 실제 신호에서 불리고, 흐르는 바이트는 TTL 시계를 리셋한다', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  // ① 데몬이 아는 "네트워크가 바뀌었다" 신호 = lan.js 인터페이스 감시(lan_update 를 유발하는 그 지점).
  const lanSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'lan.js'), 'utf8'));
  const ifBranch = lanSrc.slice(lanSrc.indexOf('ifTimer = setInterval'), lanSrc.indexOf('sweepTimer = setInterval'));
  assert.match(ifBranch, /noteNetChange\(/, '인터페이스 변경에 경로 이력 초기화가 연결되지 않았다(revive 호출자 0건 재발)');
  assert.match(ifBranch, /onLanChange/, 'lan_update 통지(호스트 좌표)는 그대로 유지돼야 한다');
  // ② 제어 WS 재접속(수면 복귀·망 전환·서버 재시작) = hello_ack 안에서 부활.
  const ctlSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8'));
  const ack = ctlSrc.slice(ctlSrc.indexOf("msg.type === 'hello_ack'"), ctlSrc.indexOf("msg.type === 'lan_grant'"));
  assert.match(ack, /reviveAll\(/, '재접속에 LAN 경로 부활이 연결되지 않았다');
  // ③ 흐르는 직결의 TTL 시계 리셋은 **호스트→우리 방향**에만 걸린다(죽은 소켓에도 쓸 수 있으므로
  //    업스트림 write 는 생존 증거가 아니다).
  const fwdSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'forward.js'), 'utf8'));
  assert.match(fwdSrc, /c\.onData\s*=\s*\([\s\S]{0,80}noteTraffic\(up\.key\)/,
    '직결 수신 경로에 noteTraffic 이 없으면 오래 열린 스트림이 TTL 로 강등된다');
  const localData = fwdSrc.slice(fwdSrc.indexOf('const onLocalData'), fwdSrc.indexOf('sock.on(\'data\', onLocalData)'));
  assert.ok(!/noteTraffic/.test(localData), '업스트림 write 를 생존 증거로 쓰면 죽은 경로가 살아 있는 것처럼 보인다');
  // 릴레이 폴백은 한 줄도 사라지지 않았다(영구 폴백 규율).
  assert.match(fwdSrc, /handleConnRelay\(entry, port, sock, pending\.splice\(0\)\)/, '버퍼 승계 릴레이 폴백 유지');
  assert.match(fwdSrc, /\/api\/daemon\/forward\/' \+ entry\.token/, '릴레이 upstream(token) 경로 유지');
});

// ── I-4. TTL 강등이 형제 엔트리의 쿨다운을 가리지 않는다(실측 결함 — PC 60초 왕복 영구 반복) ──
// 호스트 1대에 경로 엔트리는 **둘** 생긴다(키 = clientKey|hostDeviceId|net):
//   · 프리뷰 = PC JS clientKey (forward.start 실트래픽으로 승격)
//   · probe  = 데몬 뷰어 clientKey (lan.probe / lan.rpc)
// 집을 떠나면 뷰어 엔트리는 probe 실패로 cooldown(상한 15분)에 들어가지만 프리뷰 엔트리는 아무도
// 만지지 않아 TTL(10분)로만 내려간다. TTL 목표가 'probing' 이면 lan-local.status 의 MODE_RANK 최댓값
// 규칙(probing 3 > cooldown 2)이 그 쿨다운을 **가려** PC 의 `if (mode === 'cooldown') return;` 이 절대
// 발화하지 않고, PC 는 PROBE_GAP_MS(60s)마다 lan.probe → grantFor → back POST /api/daemon/lan/grant
// 왕복 + 스테일 사설 IP 로의 TCP 타임아웃을 무기한 반복한다.
//  ⚠ 시계: lan-local.status 는 쿨다운 유효성을 **Date.now()** 로 본다. 그래서 주입 시계는 반드시
//   '실시간 + offset' 이어야 한다(작은 절대값을 주입하면 두 모듈의 눈금이 갈려 쿨다운이 안 보인다).
test('I-4. TTL 강등 목표는 relay — 같은 호스트의 남은 쿨다운을 집계가 가리지 않는다', () => {
  const lanLocal = require('../lan-local');
  let off = 0;
  lan.__setNow(() => Date.now() + off);
  lan.resetPaths();
  try {
    const HID = 91;
    const IP = '192.168.31.7';
    const kPrev = lan.pathKey('pcjs-abc', HID, IP);      // 프리뷰(PC JS)
    const kView = lan.pathKey('daemon-viewer', HID, IP); // 데몬 뷰어(probe)

    lan.noteProbeOk(kPrev, 10); lan.noteProbeOk(kPrev, 10);
    assert.strictEqual(lan.pathState(kPrev), 'lan');
    for (let i = 0; i < 6; i++) lan.noteHardFail(kView, 'LAN_UNREACHABLE');   // 쿨다운을 상한(15분)까지
    assert.strictEqual(lan.pathState(kView), 'cooldown');

    // 흐르는 직결이 있는 동안은 'lan' 이 맞다 — 형제의 쿨다운이 살아 있는 배지를 꺼서는 안 된다.
    assert.strictEqual(lanLocal.status({ hostDeviceId: HID }).mode, 'lan');

    off += lan.NO_TRAFFIC_TTL_MS + 1000;                 // 무트래픽 TTL 발화(쿨다운은 아직 5분 남음)
    const after = lanLocal.status({ hostDeviceId: HID });
    assert.ok(after.cooldownUntil - (Date.now() + off) > 0, '전제 붕괴: 가려질 쿨다운이 이미 끝났다');
    assert.strictEqual(after.mode, 'cooldown',
      `쿨다운이 남았는데 mode='${after.mode}' — PC 가 데몬 백오프를 존중할 기회를 잃고 60초마다 `
      + 'lan.probe + back grant 왕복을 영구히 돈다');
    // 벌은 주지 않았다: 직결 재시도 능력·백오프 승수는 그대로(지연 회귀 금지).
    assert.strictEqual(lan.shouldTry(kPrev), true, 'TTL 철회가 쿨다운을 걸었다');
    assert.strictEqual(lan.pathSnapshot()[kPrev].cooldownMs, 0);

    // 다시 집에 돌아와 프리뷰가 흐르면 배지는 곧바로 되살아난다.
    lan.noteProbeOk(kPrev, 10); lan.noteProbeOk(kPrev, 10);
    assert.strictEqual(lanLocal.status({ hostDeviceId: HID }).mode, 'lan',
      'relay 강등이 재승격을 막으면 집에 돌아와도 직결이 살아나지 않는다');
  } finally {
    lan.__setNow(null);
    lan.resetPaths();
  }
});

// ── C-6. IP 레이트리밋(마지막 — 127.0.0.1 을 60s 차단하므로) ─────────────
test('C-6. 인증 실패 3회/분/IP → 그 IP 차단(무프레임 즉시 종료)', async () => {
  lan.__resetLimits();
  for (let i = 0; i < 3; i++) {
    const x = await rawHandshake(LAN_PORT, { grantId: 'lg-' + 'f'.repeat(12), clientKey: 'nope', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    assert.strictEqual(x.got[0] && x.got[0].code, 'BAD_GRANT');
  }
  const { g } = newGrant();
  const blocked = await rawHandshake(LAN_PORT, { grantId: g.grantId, clientKey: g.clientKey, secret: g.secret });
  assert.deepStrictEqual(blocked.got, [], '차단 중인 IP 에 응답을 주면 안 된다(스캐너 정보 제공)');
});
