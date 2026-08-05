// LAN 직결 시그널링(기능4) 단위 테스트 — DB/소켓 무접촉.
//  실행: node --test test/
//
// 이 파일이 지키는 계약(깨지면 실제 사고가 난다)
//  1. 공용 IP·링크로컬·호스트명이 endpoints 로 새어 나가면 데몬이 WAN 에 서비스를 노출한다.
//  2. LAN 은 fail-closed — env 를 켜지 않으면 caps 에 lan.v1 이 없어야 하고 grant 는 404 여야 한다.
//  3. scope 는 서버가 단계 개방한다(기본 tcp 만) — 클라가 요청해서 pty 를 얻을 수 없어야 한다.
//  4. 실패 코드에 '데몬이 연결'/'DAEMON_OFFLINE' 문구가 절대 없어야 한다(모바일 오프라인 오탐 방지).
const { test } = require('node:test');
const assert = require('node:assert');

const lan = require('../services/lanDirectService');
const lanCfg = require('../config/lanDirect');
const { computeServerCaps } = require('../config/caps');

test('isPrivateHost — 사설/루프백만 통과, 공용·링크로컬·호스트명 거부', () => {
  // 통과(사설 IPv4)
  assert.strictEqual(lan.isPrivateHost('192.168.0.31'), 4);
  assert.strictEqual(lan.isPrivateHost('10.1.2.3'), 4);
  assert.strictEqual(lan.isPrivateHost('172.16.0.1'), 4);
  assert.strictEqual(lan.isPrivateHost('172.31.255.254'), 4);
  assert.strictEqual(lan.isPrivateHost('127.0.0.1'), 4);
  // 172.15/172.32 는 사설이 아니다(경계값 — /12 오해가 흔한 지점)
  assert.strictEqual(lan.isPrivateHost('172.15.0.1'), 0);
  assert.strictEqual(lan.isPrivateHost('172.32.0.1'), 0);
  // 공용 IP 는 무조건 거부(이게 WAN 노출 방지의 마지막 방어선)
  assert.strictEqual(lan.isPrivateHost('8.8.8.8'), 0);
  assert.strictEqual(lan.isPrivateHost('203.0.113.7'), 0);
  // 링크로컬(169.254/fe80)은 거부 — 스코프 혼동 사고 예방
  assert.strictEqual(lan.isPrivateHost('169.254.10.1'), 0);
  assert.strictEqual(lan.isPrivateHost('fe80::1'), 0);
  // ULA / 루프백 IPv6 는 통과
  assert.strictEqual(lan.isPrivateHost('fd00::a1'), 6);
  assert.strictEqual(lan.isPrivateHost('fc00::1'), 6);
  assert.strictEqual(lan.isPrivateHost('::1'), 6);
  // v4-mapped 는 v4 규칙으로 환산
  assert.strictEqual(lan.isPrivateHost('::ffff:192.168.1.5'), 4);
  assert.strictEqual(lan.isPrivateHost('::ffff:8.8.8.8'), 0);
  // 호스트명·CIDR·포트·zone·선행 0 전부 거부(IP 리터럴만 받는다)
  assert.strictEqual(lan.isPrivateHost('my-mac.local'), 0);
  assert.strictEqual(lan.isPrivateHost('192.168.0.0/24'), 0);
  assert.strictEqual(lan.isPrivateHost('192.168.0.1:8080'), 0);
  assert.strictEqual(lan.isPrivateHost('fd00::1%en0'), 0);
  assert.strictEqual(lan.isPrivateHost('010.0.0.1'), 0); // 8진수 해석 우회 차단
  assert.strictEqual(lan.isPrivateHost(''), 0);
  assert.strictEqual(lan.isPrivateHost(null), 0);
  assert.strictEqual(lan.isPrivateHost({ host: '192.168.0.1' }), 0);
});

test('normLanInfo — 자기신고 값 정규화(공용 주소 탈락·개수/길이 상한·포트 범위)', () => {
  const ok = lan.normLanInfo({
    proto: 1, port: 47321,
    addrs: [
      { host: '192.168.0.31', ifname: 'en0', family: 4 },
      { host: '8.8.8.8', ifname: 'en0' },        // 공용 = 탈락
      { host: '192.168.0.31', ifname: 'en1' },   // 중복 = 탈락
      { host: 'fd00::a1', ifname: 'x'.repeat(99) },
    ],
  });
  assert.deepStrictEqual(ok.addrs.map((a) => a.host), ['192.168.0.31', 'fd00::a1']);
  assert.strictEqual(ok.addrs[1].ifname.length, 24); // ifname 길이 상한
  assert.strictEqual(ok.port, 47321);
  assert.strictEqual(ok.proto, 1);

  // 사설 주소가 하나도 없으면 null = "LAN 미지원"(grant 가 404 로 떨어짐)
  assert.strictEqual(lan.normLanInfo({ port: 47321, addrs: [{ host: '1.1.1.1' }] }), null);
  // 포트 범위 밖 / 누락 / 형식 오류
  assert.strictEqual(lan.normLanInfo({ port: 80, addrs: [{ host: '10.0.0.1' }] }), null);
  assert.strictEqual(lan.normLanInfo({ port: 70000, addrs: [{ host: '10.0.0.1' }] }), null);
  assert.strictEqual(lan.normLanInfo({ addrs: [{ host: '10.0.0.1' }] }), null);
  assert.strictEqual(lan.normLanInfo(null), null);
  assert.strictEqual(lan.normLanInfo('192.168.0.1:47321'), null);
  // 주소 개수 상한
  const many = lan.normLanInfo({ port: 47321, addrs: Array.from({ length: 30 }, (_, i) => ({ host: `10.0.0.${i + 1}` })) });
  assert.strictEqual(many.addrs.length, lan._ADDRS_MAX);
});

test('normLanInfo — 데몬 신고 scope 보존(구 데몬은 null = 제약 없음)', () => {
  // 데몬도 CPT_LAN_SCOPE 로 단계 개방한다(runner-core/lan.js scopesForDaemon). back 은 grant scope 를
  //  서버허용 ∩ 클라요청 ∩ **데몬신고** 로 깎아야 한다 — 안 그러면 뷰어가 거부당해 헛되게 강등된다.
  assert.deepStrictEqual(lan.normLanInfo({ port: 47321, addrs: [{ host: '10.0.0.2' }], scopes: ['tcp', 'rpc', 'ssh'] }).daemonScopes, ['tcp', 'rpc']);
  assert.strictEqual(lan.normLanInfo({ port: 47321, addrs: [{ host: '10.0.0.2' }] }).daemonScopes, null);
  // 서버가 rpc 를 열었어도 데몬이 tcp 만 신고하면 결과는 tcp 뿐이다.
  const info = lan.normLanInfo({ port: 47321, addrs: [{ host: '10.0.0.2' }], scopes: ['tcp'] });
  const allowed = ['tcp', 'rpc'].filter((s) => info.daemonScopes.includes(s));
  assert.deepStrictEqual(lan.normScopes(['tcp', 'rpc'], allowed), ['tcp']);
});

test('sameLanInfo — 변화 없으면 팬아웃/epoch 증가를 억제', () => {
  const a = lan.normLanInfo({ port: 47321, addrs: [{ host: '192.168.0.31' }] });
  const b = lan.normLanInfo({ port: 47321, addrs: [{ host: '192.168.0.31' }] });
  const c = lan.normLanInfo({ port: 47322, addrs: [{ host: '192.168.0.31' }] });
  const d = lan.normLanInfo({ port: 47321, addrs: [{ host: '192.168.0.32' }] });
  assert.strictEqual(lan.sameLanInfo(a, b), true);
  assert.strictEqual(lan.sameLanInfo(a, c), false);
  assert.strictEqual(lan.sameLanInfo(a, d), false);
  assert.strictEqual(lan.sameLanInfo(null, null), true);  // 둘 다 미지원 = 변화 없음
  assert.strictEqual(lan.sameLanInfo(a, null), false);    // 리스너 소멸 = 변화
});

test('normScopes — 서버 허용 ∩ 클라 요청, 순서는 서버가 정하고 과다부여 금지', () => {
  assert.deepStrictEqual(lan.normScopes(['pty', 'tcp'], ['tcp', 'rpc']), ['tcp']); // pty 미허용 → 탈락
  assert.deepStrictEqual(lan.normScopes(['rpc', 'tcp'], ['tcp', 'rpc']), ['tcp', 'rpc']); // 순서=서버
  assert.deepStrictEqual(lan.normScopes(undefined, ['tcp', 'rpc']), ['tcp']); // 요청 없으면 최소부여
  assert.deepStrictEqual(lan.normScopes([], ['tcp', 'rpc']), ['tcp']);
  assert.deepStrictEqual(lan.normScopes(['pty'], ['tcp']), []); // 교집합 없음 → 403 LAN_SCOPE
  assert.deepStrictEqual(lan.normScopes(['TCP', ' rpc '], ['tcp', 'rpc']), ['tcp', 'rpc']); // 대소/공백 관용
  assert.deepStrictEqual(lan.normScopes(['tcp'], []), []); // 서버가 전부 닫으면 아무것도 안 준다
});

test('lanDirect env — fail-closed 기본값 + 단계 개방', () => {
  assert.strictEqual(lanCfg.lanEnabled({}), false);                       // 미설정 = 꺼짐(다른 스위치와 반대)
  assert.strictEqual(lanCfg.lanEnabled({ LAN_DIRECT_ENABLED: '0' }), false);
  assert.strictEqual(lanCfg.lanEnabled({ LAN_DIRECT_ENABLED: 'maybe' }), false);
  assert.strictEqual(lanCfg.lanEnabled({ LAN_DIRECT_ENABLED: '1' }), true);
  assert.strictEqual(lanCfg.lanEnabled({ LAN_DIRECT_ENABLED: 'true' }), true);
  // scope 기본 = 프리뷰(tcp)만 → fs/터미널은 서버가 grant 를 안 줘서 자동으로 기존 릴레이 경로
  assert.deepStrictEqual(lanCfg.allowedScopes({}), ['tcp']);
  assert.deepStrictEqual(lanCfg.allowedScopes({ LAN_SCOPES: 'tcp,rpc' }), ['tcp', 'rpc']);
  assert.deepStrictEqual(lanCfg.allowedScopes({ LAN_SCOPES: 'rpc,tcp,rpc' }), ['rpc', 'tcp']);
  assert.deepStrictEqual(lanCfg.allowedScopes({ LAN_SCOPES: '' }), []);       // 전면 차단
  assert.deepStrictEqual(lanCfg.allowedScopes({ LAN_SCOPES: 'ssh,pty' }), ['pty']); // 미지의 값 폐기
  //  화면 영상(emu)도 서버 한 줄로만 열린다 — 어휘에는 있지만 **기본값에는 없다**.
  //   (2026-08-05: 폰 화면 지연 릴레이 310~420ms vs LAN 직결 96~109ms 실측으로 추가된 scope)
  assert.ok(lanCfg.SCOPES_ALL.includes('emu'), 'emu 가 어휘에 없으면 grant 에서 통째로 버려진다');
  assert.ok(!lanCfg.allowedScopes({}).includes('emu'), '기본은 여전히 닫혀 있다(명시적으로 켜야 한다)');
  assert.deepStrictEqual(lanCfg.allowedScopes({ LAN_SCOPES: 'tcp,emu' }), ['tcp', 'emu']);
  // TTL 은 상식 범위 밖이면 무시(오타로 영구 grant 가 되는 것 방지)
  assert.strictEqual(lanCfg.grantTtlMs({}), 600000);
  assert.strictEqual(lanCfg.grantTtlMs({ LAN_GRANT_TTL_MS: '120000' }), 120000);
  assert.strictEqual(lanCfg.grantTtlMs({ LAN_GRANT_TTL_MS: '1' }), 600000);
  assert.strictEqual(lanCfg.grantTtlMs({ LAN_GRANT_TTL_MS: '999999999' }), 600000);
});

test('SERVER_CAPS — lan.v1 은 켠 경우에만 선언(데몬 리스너 게이트)', () => {
  assert.ok(!computeServerCaps({}).includes('lan.v1'));
  assert.ok(computeServerCaps({ LAN_DIRECT_ENABLED: '1' }).includes('lan.v1'));
});

test('newGrant — 단명·랜덤·(뷰어,PC,purpose) 바인딩', () => {
  const g1 = lan.newGrant({ hostDeviceId: 12, clientKey: 'pc-abc', kind: 'pc', scopes: ['tcp'], ttlMs: 60000, now: 1000 });
  const g2 = lan.newGrant({ hostDeviceId: 12, clientKey: 'pc-abc', kind: 'pc', scopes: ['tcp'], ttlMs: 60000, now: 1000 });
  assert.match(g1.grantId, /^lg-[0-9a-f]{24}$/);
  assert.notStrictEqual(g1.grantId, g2.grantId);          // 매 발급 랜덤(재사용 금지)
  assert.notStrictEqual(g1.secret, g2.secret);
  assert.strictEqual(Buffer.from(g1.secret, 'base64').length, 32);
  assert.strictEqual(g1.expiresAt, new Date(61000).toISOString());
  assert.strictEqual(g1.hostDeviceId, 12);
  assert.strictEqual(g1.kind, 'pc');
  assert.strictEqual(lan.newGrant({ kind: 'tablet' }).kind, 'mobile'); // 미지의 kind = mobile
});

test('endpointsOf — IPv4 우선 정렬 + port 부착', () => {
  const info = lan.normLanInfo({ port: 47321, addrs: [{ host: 'fd00::a1' }, { host: '192.168.0.31' }] });
  assert.deepStrictEqual(lan.endpointsOf(info), [
    { host: '192.168.0.31', port: 47321, family: 4 },
    { host: 'fd00::a1', port: 47321, family: 6 },
  ]);
  assert.deepStrictEqual(lan.endpointsOf(null), []);
});

test('allowGrant — (user,host)당 1분 20회 상한(데몬 보호)', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) assert.strictEqual(lan.allowGrant('u9', 77, t0), true, `#${i}`);
  assert.strictEqual(lan.allowGrant('u9', 77, t0), false);   // 21번째 차단
  assert.strictEqual(lan.allowGrant('u9', 78, t0), true);    // 다른 호스트는 독립
  assert.strictEqual(lan.allowGrant('u9', 77, t0 + 60_001), true); // 창 넘어가면 회복
});

test('issueLanGrant — 게이트 순서와 실패 코드(오프라인 오탐 문구 금지)', () => {
  const relay = require('../services/daemonRelayService');
  const prev = process.env.LAN_DIRECT_ENABLED;
  const grab = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  // ① 서버 스위치 off = 최우선 게이트(데몬 조회조차 하지 않는다)
  delete process.env.LAN_DIRECT_ENABLED;
  const off = grab(() => relay.issueLanGrant(999999, 12, { clientKey: 'k' }));
  assert.strictEqual(off.code, 'LAN_UNSUPPORTED');
  assert.strictEqual(off.statusCode, 404);

  // ② 켠 상태에서 대상 PC 가 아예 안 붙어 있으면 LAN_HOST_OFFLINE(409)
  process.env.LAN_DIRECT_ENABLED = '1';
  const noConn = grab(() => relay.issueLanGrant(999999, 12, { clientKey: 'k' }));
  assert.strictEqual(noConn.code, 'LAN_HOST_OFFLINE');
  assert.strictEqual(noConn.statusCode, 409);

  // ★ 어떤 LAN 실패 문구에도 모바일 오프라인 판정 정규식(/데몬이 연결|DAEMON_OFFLINE/)이 걸리면 안 된다.
  for (const e of [off, noConn]) {
    assert.ok(!/데몬이 연결|DAEMON_OFFLINE/.test(e.message), `오프라인 오탐 문구: ${e.message}`);
  }
  if (prev == null) delete process.env.LAN_DIRECT_ENABLED; else process.env.LAN_DIRECT_ENABLED = prev;
});
