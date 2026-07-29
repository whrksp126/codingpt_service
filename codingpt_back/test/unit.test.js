// 핵심 순수 로직 테스트 — node 내장 러너(node --test), DB/objectstore 무접촉.
//  실행: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeRemote } = require('../services/workspaceService');
const { cmpVersion } = require('../services/pcReleaseService');
const { _composeSubtitle, _computeRoute, _pruneWhere } = require('../services/notificationService');
const { _normCaps } = require('../services/daemonRelayService');
const { SERVER_CAPS, computeServerCaps } = require('../config/caps');
const approvalService = require('../services/approvalService');
const { _buildFcmMessage } = require('../services/pushProviderService');

test('normalizeRemote — ssh/https/포트/.git 흡수해 동일 키', () => {
  assert.strictEqual(normalizeRemote('git@github.com:Foo/Bar.git'), normalizeRemote('https://github.com/Foo/Bar'));
  assert.strictEqual(normalizeRemote('ssh://git@host.com:2222/a/b.git'), 'host.com/a/b');
  assert.notStrictEqual(normalizeRemote('https://github.com/foo/bar'), normalizeRemote('https://github.com/foo/other'));
});

test('cmpVersion — semver 대소/동등', () => {
  assert.strictEqual(cmpVersion('0.2.0', '0.1.9'), 1);
  assert.strictEqual(cmpVersion('1.0.0', '1.0.0'), 0);
  assert.strictEqual(cmpVersion('0.9.0', '0.10.0'), -1); // 문자열 비교가 아님
  assert.strictEqual(cmpVersion('v1.2', '1.2.0'), 0);    // v 접두사·자릿수 관용
});

// 기능3(훅 감지) 1단계 전제 = "back 무수정" — 데몬이 subtitle:null 로 보내고 서버가 조합한다.
//  이 계약이 깨지면 훅/폴백 알림의 부제가 3플랫폼에서 동시에 비어 보인다.
test('composeSubtitle — 훅/폴백 알림 3종 kind 를 서버가 조합', () => {
  assert.strictEqual(_composeSubtitle('done', 'codingpt'), '「codingpt」에서 완료');
  assert.strictEqual(_composeSubtitle('permission_request', 'codingpt'), '「codingpt」에서 승인 대기');
  assert.strictEqual(_composeSubtitle('error', 'codingpt'), '「codingpt」에서 오류');
  assert.strictEqual(_composeSubtitle('done', null), null);      // wsName 없으면 조합 안 함(클라 계약)
  // 미도입 kind(예: needs_input)는 거부가 아니라 "부제 없음" — 데몬이 먼저 나가도 알림이 죽지 않는다.
  assert.strictEqual(_composeSubtitle('needs_input', 'codingpt'), null);
});

// caps 협상 배관(§2-(d)) — 구버전(필드 부재)이 항상 [] 로 떨어져 게이팅이 기존 동작으로 폴백해야 한다.
test('normCaps — 구버전 무영향 + 자기신고 값 정규화', () => {
  assert.deepStrictEqual(_normCaps(undefined), []);   // 구 데몬/구 클라 = 필드 자체가 없음
  assert.deepStrictEqual(_normCaps(null), []);
  assert.deepStrictEqual(_normCaps('approval.v1'), []); // 배열 아님 = 무시(throw 금지)
  assert.deepStrictEqual(_normCaps([' approval.v1 ', 'approval.v1', 42, '', null]), ['approval.v1']); // trim·중복·비문자 제거
  assert.strictEqual(_normCaps(new Array(100).fill(0).map((_, i) => 'c' + i)).length, 32); // 개수 상한
  assert.strictEqual(_normCaps(['x'.repeat(200)])[0].length, 64);                          // 길이 상한
});

test('SERVER_CAPS — 처리 코드가 들어간 능력만 선언 + 킬스위치로 회수', () => {
  // 선언 = "서버가 처리한다"는 약속.
  //  approval.v1  = approvalService + /api/daemon/approvals/* + approval_event 팬아웃(이 커밋)
  //  transcript.v1 = /api/daemon/chat/* callRpc 프록시 + chat_event 팬아웃(이 커밋)
  assert.ok(SERVER_CAPS.includes('approval.v1'));
  assert.ok(SERVER_CAPS.includes('transcript.v1'));
  // 기능3 2단계 — 이 커밋의 서버 코드 = 제어 WS agent_state 분기 + normAgentState 검증
  //  + fanoutAgentState(SSE/WSS) + ui_hello 라스트-스테이트 리플레이 → 이제 선언한다.
  assert.ok(SERVER_CAPS.includes('agentstate.v1'));
  const relay = require('../services/daemonRelayService');
  assert.strictEqual(typeof relay.fanoutAgentState, 'function', '선언했으면 팬아웃 코드가 반드시 있어야 한다');
  // 킬스위치 — 서버에서 기능을 끄면 능력도 회수돼 신버전 데몬의 교집합이 깨진다(= 기존 동작 폴백).
  assert.deepStrictEqual(
    computeServerCaps({ APPROVAL_ENABLED: '0', TRANSCRIPT_ENABLED: 'false', AGENTSTATE_ENABLED: '0', E2EE_ENABLED: 'off' }),
    ['caps.v1']);
  assert.ok(computeServerCaps({}).includes('approval.v1')); // 미설정 = 켜짐
  assert.ok(!computeServerCaps({ AGENTSTATE_ENABLED: 'no' }).includes('agentstate.v1'));
});

test('SERVER_CAPS — E2EE 는 단계별 능력으로 쪼갠다(A/B/D 선언, C 미선언)', () => {
  // A단계 = deviceTrustService + /api/daemon/e2ee/* + device_approval_event 팬아웃.
  assert.ok(SERVER_CAPS.includes('e2ee.keys.v1'));
  // B단계 = POST /api/daemon/rpc 봉투 프록시(이 커밋). 선언했으면 핸들러가 실제로 있어야 한다.
  assert.ok(SERVER_CAPS.includes('e2ee.rpc.v1'));
  assert.strictEqual(typeof require('../controllers/daemonController').rpcSealed, 'function');
  // D단계 = e2ee.begin 선협상 + 토큰 sid(이 커밋).
  assert.ok(SERVER_CAPS.includes('e2ee.stream.v1'));
  assert.strictEqual(typeof require('../services/daemonRelayService').negotiateStreamE2ee, 'function');
  // ★ 뭉뚱그린 'e2ee.v1' 은 영구 금지. C단계(e2ee.snap.v1)는 매니페스트에 enc/epoch 를 보관하는
  //   데까지만 왔고 복원측 처리가 없다 → 선언하면 데몬이 번들을 봉인해 올리는데 서버는 그것이
  //   복원 가능한지 아무것도 확인하지 못한다(교리 위반).
  for (const cap of ['e2ee.v1', 'e2ee.snap.v1']) {
    assert.ok(!SERVER_CAPS.includes(cap), `${cap} 은 해당 단계 서버 코드가 들어간 뒤에 선언해야 한다`);
  }
  // 킬스위치 — E2EE 를 끄면 3개가 함께 회수된다(열쇠 없이 봉투/스트림만 켜지는 조합 금지).
  const off = computeServerCaps({ E2EE_ENABLED: '0' });
  for (const cap of ['e2ee.keys.v1', 'e2ee.rpc.v1', 'e2ee.stream.v1']) assert.ok(!off.includes(cap));
  // D단계만 되돌리기 — sid 주입 회귀(4090 무한 재연결) 시 즉시 회수할 수단.
  const noStream = computeServerCaps({ E2EE_STREAM_ENABLED: '0' });
  assert.ok(noStream.includes('e2ee.rpc.v1'));
  assert.ok(!noStream.includes('e2ee.stream.v1'));
});

// ── 기능1 승인 인박스 ────────────────────────────────────────────────

test('approval normalizeCreate — id 형식 강제 · 캡 · 마감 클램프 · win 정수화', () => {
  const now = 1_753_440_000_000;
  assert.throws(() => approvalService._normalizeCreate({ id: 'nope' }, now), /id 형식/);
  assert.throws(() => approvalService._normalizeCreate({}, now), /id 형식/);
  // TUI 재광고(question-revive) 접두사 — 막히면 재광고 전량 400 이 되어 폰 알림이 조용히 0건이 된다
  //  (2026-07-28 실사고: 데몬 0.1.149 가 20초마다 400 을 받으며 재시도했다).
  assert.strictEqual(approvalService._normalizeCreate({ id: 'aprt_abc123' }, now).id, 'aprt_abc123');
  const a = approvalService._normalizeCreate({
    id: 'apr_9f2c', tool: 'Bash', summary: 'rm important.txt', win: '1234',
    cwd: 'other/project/codingpt', wsName: 'codingpt', waitMs: 570000, requestedAt: now,
  }, now);
  assert.strictEqual(a.win, 1234);                       // notification.win == tid 계약(문자열도 수용)
  assert.strictEqual(a.deadlineAt, now + 570000);
  assert.strictEqual(a.agent, 'claude');                 // 기본 에이전트
  // 마감은 back TTL 안으로 클램프 — 데몬이 과대한 waitMs 를 줘도 유령 카드가 남지 않는다.
  const capped = approvalService._normalizeCreate({ id: 'apr_x', waitMs: 99_999_999 }, now);
  assert.strictEqual(capped.deadlineAt, now + approvalService._config.TTL_MS);
  // 4KB 초과 inputPreview 는 부분 절단(깨진 JSON) 대신 통째로 마커 교체 — 민감정보 유출면도 줄인다.
  const big = approvalService._normalizeCreate({ id: 'apr_y', inputPreview: { command: 'x'.repeat(9000) } }, now);
  assert.strictEqual(big.inputPreview.truncated, true);
  assert.strictEqual(big.inputPreview.command, undefined);
});

test('approval normalizeDecision — allow|deny|answer 만 · 선택형은 answer 로 받는다', () => {
  assert.throws(() => approvalService._normalizeDecision({ decision: 'maybe' }), /decision/);
  assert.throws(() => approvalService._normalizeDecision({}), /decision/);
  assert.deepStrictEqual(approvalService._normalizeDecision({ decision: 'allow' }),
    { decision: 'allow', message: null, always: false });
  // AskUserQuestion/ExitPlanMode = "고르는" 도구. 클라이언트는 훅 내부 규약(deny+message 번역)을 모른다.
  const ans = approvalService._normalizeDecision({ decision: 'answer', answer: { labels: ['Banana'] } });
  assert.deepStrictEqual(ans.answer, { questionIndex: 0, labels: ['Banana'], text: null });
  assert.throws(() => approvalService._normalizeDecision({ decision: 'answer', answer: {} }), /answer/);
});

test('approval 단일 응답 — claimedBy CAS 로 두 번째는 409 ALREADY_RESOLVED', async () => {
  // 데몬 RPC/팬아웃/알림은 배관이므로 스텁. 검증 대상은 "누가 이겼는지"의 원자성 하나다.
  const relay = require('../services/daemonRelayService');
  const notif = require('../services/notificationService');
  const rpcCalls = [];
  const origRpc = relay.callRpc; const origFan = relay.fanoutApprovalEvent; const origRead = notif.markRead;
  relay.callRpc = async (userId, method, params, timeoutMs, opts) => { rpcCalls.push({ method, params, opts }); return { resolved: true }; };
  relay.fanoutApprovalEvent = () => {};
  notif.markRead = async () => ({ ids: [] });
  try {
    const now = Date.now();
    const rec = {
      id: 'apr_cas1', userId: 7, hostDeviceId: 12, notifId: 91823,
      approval: { id: 'apr_cas1', tool: 'Bash', requestedAt: now, deadlineAt: now + 60000 },
      deadlineAt: now + 60000, createdAt: now, claimedBy: null, finalized: false,
      gated: false, escalatedAt: 0, push: { channelId: 'c', category: 'CPT_APPROVAL', data: {} },
    };
    approvalService._pending.set(rec.id, rec);
    const pc = { kind: 'pc', deviceId: 12, deviceName: 'MacBook' };
    const phone = { kind: 'mobile', deviceId: null, deviceName: 'iPhone' };
    const results = await Promise.allSettled([
      approvalService.respond(7, 'apr_cas1', { decision: 'allow' }, phone),
      approvalService.respond(7, 'apr_cas1', { decision: 'deny' }, pc),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(ok.length, 1, '정확히 한 기기만 이겨야 한다');
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].reason.statusCode, 409);
    assert.strictEqual(bad[0].reason.code, 'ALREADY_RESOLVED');
    assert.deepStrictEqual(bad[0].reason.publicDetail.resolvedBy, phone); // 패자에게 승자를 알려준다
    // 데몬에는 단 1회만 간다. ★ runnerId 필수 — 없으면 멀티 PC 에서 활성 러너로 오배달된다.
    assert.strictEqual(rpcCalls.length, 1);
    assert.strictEqual(rpcCalls[0].method, 'approval.resolve');
    assert.deepStrictEqual(rpcCalls[0].opts, { runnerId: 12 });
    // 해소되면 인덱스에서 사라진다(= prune 보호 해제). 늦게 누른 기기는 "만료"가 아니라
    //  409 ALREADY_RESOLVED + 승자 정보를 받아야 카드에 "PC에서 이미 응답" 을 표시할 수 있다.
    assert.strictEqual(approvalService._pending.has('apr_cas1'), false);
    await assert.rejects(
      () => approvalService.respond(7, 'apr_cas1', { decision: 'allow' }, pc),
      (e) => e.statusCode === 409 && e.code === 'ALREADY_RESOLVED' && e.publicDetail.resolvedBy.deviceName === 'iPhone',
    );
    // 남의 계정 id 는 존재 자체를 알려주지 않는다(404).
    await assert.rejects(() => approvalService.respond(99, 'apr_cas1', { decision: 'allow' }, pc), (e) => e.statusCode === 404);
  } finally {
    relay.callRpc = origRpc; relay.fanoutApprovalEvent = origFan; notif.markRead = origRead;
    approvalService._pending.delete('apr_cas1');
    approvalService._resolvedRecent.delete('apr_cas1');
  }
});

test('approval — RPC 실패 시 클레임 롤백(다른 기기가 다시 답할 수 있어야 한다)', async () => {
  const relay = require('../services/daemonRelayService');
  const origRpc = relay.callRpc; const origFan = relay.fanoutApprovalEvent;
  relay.callRpc = async () => { throw new Error('DAEMON_OFFLINE'); };
  relay.fanoutApprovalEvent = () => {};
  try {
    const now = Date.now();
    approvalService._pending.set('apr_off', {
      id: 'apr_off', userId: 7, hostDeviceId: 3, notifId: null,
      approval: { id: 'apr_off', requestedAt: now, deadlineAt: now + 60000 },
      deadlineAt: now + 60000, createdAt: now, claimedBy: null, finalized: false, gated: false, escalatedAt: 0,
    });
    await assert.rejects(
      () => approvalService.respond(7, 'apr_off', { decision: 'allow' }, { kind: 'mobile' }),
      (e) => e.statusCode === 409 && e.code === 'HOST_OFFLINE',
    );
    const rec = approvalService._pending.get('apr_off');
    assert.ok(rec && !rec.finalized, 'pending 이 유지돼야 한다(훅은 아직 대기 중)');
    assert.strictEqual(rec.claimedBy, null, '클레임이 롤백돼야 재시도가 가능하다');
  } finally {
    relay.callRpc = origRpc; relay.fanoutApprovalEvent = origFan;
    approvalService._pending.delete('apr_off');
  }
});

test('approval 마감 스위퍼 — TTL 초과는 defer 로 회수(자동 허용 아님)', () => {
  const relay = require('../services/daemonRelayService');
  const origFan = relay.fanoutApprovalEvent;
  const events = [];
  relay.fanoutApprovalEvent = (userId, event) => events.push(event);
  try {
    const now = Date.now();
    approvalService._pending.set('apr_exp', {
      id: 'apr_exp', userId: 7, hostDeviceId: 1, notifId: null,
      approval: { id: 'apr_exp', requestedAt: now - 700000, deadlineAt: now - 1000 },
      deadlineAt: now - 1000, createdAt: now - 700000, claimedBy: null, finalized: false, gated: false, escalatedAt: 0,
    });
    approvalService._sweep(now);
    assert.strictEqual(approvalService._pending.has('apr_exp'), false);
    const ev = events.find((e) => e.id === 'apr_exp');
    assert.strictEqual(ev.kind, 'resolved');
    assert.strictEqual(ev.decision, 'defer');   // ★ 절대 allow 가 아니다 — TUI 다이얼로그로 폴백
    assert.strictEqual(ev.reason, 'expired');
  } finally { relay.fanoutApprovalEvent = origFan; approvalService._pending.delete('apr_exp'); }
});

test('approval 폭주 가드 — pending 상한 초과는 에러가 아니라 defer 지시(TUI 처리)', async () => {
  // 한 세션이 파일 20개를 연달아 고치면 승인/알림/푸시가 폭주한다. 상한을 넘으면 서버가 defer 를
  //  지시하고 데몬이 그 요청은 로컬 다이얼로그로 넘긴다(에이전트를 세우지 않는다).
  const max = approvalService._config.MAX_PENDING_PER_USER;
  const now = Date.now();
  const ids = new Set();
  for (let i = 0; i < max; i += 1) {
    const id = `apr_flood${i}`;
    ids.add(id);
    approvalService._pending.set(id, {
      id, userId: 8, hostDeviceId: 1, notifId: null, approval: { id, requestedAt: now, deadlineAt: now + 60000 },
      deadlineAt: now + 60000, createdAt: now, claimedBy: null, finalized: false, gated: false, escalatedAt: 0,
    });
  }
  approvalService._byUser.set('8', ids);
  try {
    // DB/알림 경로에 닿기 전에 상한에서 걸러진다(그래서 DB 없이도 검증 가능하다).
    const r = await approvalService.create(8, 1, 'PC', { id: 'apr_over', tool: 'Bash' });
    assert.deepStrictEqual(r, { id: 'apr_over', defer: true, reason: 'too_many_pending' });
    assert.strictEqual(approvalService._pending.has('apr_over'), false); // 등록하지 않는다
  } finally {
    for (const id of ids) approvalService._pending.delete(id);
    approvalService._byUser.delete('8');
  }
});

test('approval 에스컬레이션 — PC 무음으로 게이트된 승인은 60s 무응답 시 같은 태그로 폰 재발송', () => {
  const push = require('../services/pushService');
  const origSend = push.sendToUser;
  const sends = [];
  push.sendToUser = async (userId, payload, opts) => { sends.push({ userId, payload, opts }); return { sent: 1, skipped: 0 }; };
  try {
    const now = Date.now();
    const a = { id: 'apr_esc', tool: 'Bash', relPath: 'src/app.ts', wsName: 'codingpt', cwd: 'dev/x', win: 7, requestedAt: now, deadlineAt: now + 500000 };
    approvalService._pending.set('apr_esc', {
      id: 'apr_esc', userId: 7, hostDeviceId: 1, notifId: 500, approval: a,
      deadlineAt: now + 500000, createdAt: now - 61000, claimedBy: null, finalized: false,
      gated: true, escalatedAt: 0, push: approvalService._buildPush({ approval: a }),
    });
    approvalService._sweep(now);
    assert.strictEqual(sends.length, 1, '정확히 1회만 에스컬레이션');
    assert.strictEqual(sends[0].opts.pcActive, false, 'PC 무음 토글을 이 1회만 우회');
    assert.strictEqual(sends[0].payload.notifId, 500, '같은 notifId=같은 태그 → 배너 교체(중복 아님)');
    assert.strictEqual(sends[0].payload.category, 'CPT_APPROVAL');
    approvalService._sweep(now + 1000);
    assert.strictEqual(sends.length, 1, '두 번 보내지 않는다');
    assert.ok(approvalService._pending.has('apr_esc'), '에스컬레이션은 승인을 해소하지 않는다');
  } finally { push.sendToUser = origSend; approvalService._pending.delete('apr_esc'); }
});

test('approval 레이트 리밋 — 유저당 분당 상한 후 차단, 창 넘어가면 회복', () => {
  const now = 1_000_000;
  const max = approvalService._config.RESPOND_MAX_PER_MIN;
  for (let i = 0; i < max; i += 1) assert.strictEqual(approvalService._allowRespond('rate-u', now), true);
  assert.strictEqual(approvalService._allowRespond('rate-u', now), false);
  assert.strictEqual(approvalService._allowRespond('rate-u', now + 60_001), true);
});

test('approval 딥링크 — 승인 카드 직행(codingpt://approval/<id>?ws&cwd&win)', () => {
  assert.strictEqual(
    approvalService._buildDeeplink({ id: 'apr_9f2c', workspaceId: 'ws_1', cwd: 'dev/x', win: 1234 }),
    'codingpt://approval/apr_9f2c?ws=ws_1&cwd=dev%2Fx&win=1234',
  );
  assert.strictEqual(approvalService._buildDeeplink({ id: 'apr_9f2c', win: null }), 'codingpt://approval/apr_9f2c');
});

// ── 알림 라우팅 / prune 예외 ──────────────────────────────────────────

test('computeRoute — 알림 3케이스 회귀 고정(PC 포커스→폰 무음 / 자리비움→푸시 / 폰 활성→억제)', () => {
  // 이 3케이스는 "PC엔 오는데 폰엔 안 옴" 라운드의 결론이다. 승인 기능이 여기를 깨면 안 된다.
  assert.deepStrictEqual(_computeRoute({ kind: 'pc', fresh: true }), { suppressAll: false, pcActive: true });
  assert.deepStrictEqual(_computeRoute({ kind: 'pc', fresh: false }), { suppressAll: false, pcActive: false });
  assert.deepStrictEqual(_computeRoute({ kind: 'mobile', fresh: true }), { suppressAll: true, pcActive: false });
  assert.deepStrictEqual(_computeRoute(null), { suppressAll: false, pcActive: false });
});

test('prune 예외 — 미해소 승인 알림은 500건 상한 정리에서 제외된다', () => {
  // 지워지면 대기 중 카드/배너를 회수할 notifId 가 사라져 폰에 유령 배너가 남는다(설계 R7).
  const { Sequelize } = require('sequelize');
  const sql = new Sequelize({ dialect: 'postgres' }).dialect.queryGenerator
    .whereItemsQuery(_pruneWhere(7, 5000, [91823, 91824]), {});
  assert.match(sql, /"id" < 5000/);
  assert.match(sql, /"id" NOT IN \(91823, 91824\)/);            // ① back 인덱스가 아는 pending
  assert.match(sql, /NOT \("kind" = 'approval_request' AND "read_at" IS NULL\)/); // ② 재시작 후에도 사는 그물
  assert.match(sql, /"user_id" = 7/);
  // 인덱스가 비어도(back 재시작) ② 가 남아 보호가 유지된다.
  const sql2 = new Sequelize({ dialect: 'postgres' }).dialect.queryGenerator
    .whereItemsQuery(_pruneWhere(7, 5000, []), {});
  assert.ok(!/NOT IN/.test(sql2));
  assert.match(sql2, /NOT \("kind" = 'approval_request' AND "read_at" IS NULL\)/);
});

// ── 푸시 payload 조립 ────────────────────────────────────────────────

test('FCM payload — 기존 알림은 예전 구조 그대로(회귀 0)', () => {
  const m = _buildFcmMessage({ token: 'tok' }, {
    kind: 'done', sessionId: 's1', title: 'Claude Code', body: '「x」에서 완료',
    deeplink: 'codingpt://notif/5', notifId: 5,
  }).message;
  assert.strictEqual(m.android.notification.channel_id, 'codingpt_default');
  assert.strictEqual(m.android.notification.tag, 'cptnotif-5'); // 크로스기기 dismiss 규약
  assert.deepStrictEqual(m.apns.payload.aps, { sound: 'default' }); // category 없음 = 예전과 동일
  assert.strictEqual(m.data.approvalId, undefined);
  assert.ok(m.notification.title && m.notification.body);          // 혼합(표시+데이터) 유지
});

test('FCM payload — 승인은 액션 가능(혼합 전송 + iOS 카테고리 + data 액션 식별자)', () => {
  const rec = {
    approval: {
      id: 'apr_9f2c', tool: 'Bash', relPath: 'src/app.ts', deadlineAt: 1_753_440_570_000,
      wsName: 'codingpt', cwd: 'dev/codingpt', win: 1234,
    },
  };
  const push = approvalService._buildPush(rec);
  const m = _buildFcmMessage({ token: 'tok' }, {
    kind: 'approval_request', notifId: 91823, title: '승인 필요 — Claude Code',
    body: approvalService._pushBody(rec.approval),
    deeplink: approvalService._buildDeeplink(rec.approval),
    channelId: push.channelId, category: push.category, data: push.data,
  }).message;
  // Android: notification+data 혼합 — data-only 는 제조사 절전에서 유실되면 아무것도 안 뜬다.
  assert.strictEqual(m.notification.title, '승인 필요 — Claude Code');
  assert.strictEqual(m.notification.body, 'Bash · src/app.ts'); // 푸시엔 툴명+파일명만(명령 전문 금지)
  assert.strictEqual(m.android.notification.tag, 'cptnotif-91823'); // 회수 규약 동일
  assert.strictEqual(m.android.priority, 'high');
  // data: 앱이 잠금화면 액션/딥링크를 조립하는 데 필요한 값(문자열화 필수)
  assert.strictEqual(m.data.approvalId, 'apr_9f2c');
  assert.strictEqual(m.data.deadlineAt, '1753440570000');
  assert.strictEqual(m.data.actions, 'CPT_ALLOW,CPT_DENY');
  assert.strictEqual(m.data.deeplink, 'codingpt://approval/apr_9f2c?cwd=dev%2Fcodingpt&win=1234');
  // iOS: UNNotificationCategory 식별자 + 시간민감
  assert.strictEqual(m.apns.payload.aps.category, 'CPT_APPROVAL');
  assert.strictEqual(m.apns.payload.aps['interruption-level'], 'time-sensitive');
});

test('FCM payload — alwaysLabel 이 있으면 3버튼(TUI 순서)과 전용 iOS 카테고리로 나간다', () => {
  // claude 가 규칙을 제안한 요청(alwaysLabel) → 잠금화면에도 "허용하고 묻지 않기"가 떠야
  //  표면마다 선택지 개수가 달라지지 않는다(2026-07-29 표면 통일).
  const push = approvalService._buildPush({
    approval: { id: 'apr_al1', tool: 'Bash', summary: 'git status', alwaysLabel: 'git status:*', deadlineAt: 1, cwd: 'dev/x', win: 1 },
  });
  assert.strictEqual(push.data.actions, 'CPT_ALLOW,CPT_ALWAYS,CPT_DENY');
  assert.strictEqual(push.data.alwaysLabel, 'git status:*');
  assert.strictEqual(push.category, 'CPT_APPROVAL_ALWAYS');
  // 선택형에는 절대 붙지 않는다(허용/거절이 답이 아닌 도구).
  const cp = approvalService._buildPush({
    approval: { id: 'apr_al2', tool: 'AskUserQuestion', alwaysLabel: 'x', prompt: { kind: 'choice', questions: [] }, deadlineAt: 1 },
  });
  assert.strictEqual(cp.data.actions, 'CPT_ANSWER');
  assert.strictEqual(cp.data.alwaysLabel, undefined);
});

// ── 기능2 E2EE — 기기 승인(열쇠 배포) ────────────────────────────────
//
// 이 블록은 "서버는 봉인문만 만진다"를 코드로 고정한다. 아래 seal/open 헬퍼는 **클라이언트 구현의
//  참조 구현**이기도 하다(데몬 runner-core/e2ee.js · 앱 services/e2ee.ts · PC e2ee.rs 가 같은 바이트를
//  만들어야 한다). 여기서 만든 80B 봉인문이 서버 검증(길이·서명)을 통과하고 다시 열려서 MK 가
//  왕복하는 것까지 확인한다.
const crypto = require('node:crypto');
const deviceTrust = require('../services/deviceTrustService');

const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex'); // SPKI(X25519) 고정 헤더
function genX() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32), pub: publicKey, priv: privateKey };
}
function genEd() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32), pub: publicKey, priv: privateKey };
}
function importXPub(raw) { return crypto.createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: 'der', type: 'spki' }); }
function grantKey(ephRaw, ikXRaw, ss) {
  return Buffer.from(crypto.hkdfSync('sha256', ss,
    crypto.createHash('sha256').update(Buffer.concat([ephRaw, ikXRaw])).digest(),
    Buffer.from('cpt-e2ee/v1/grant'), 32));
}
// sealed = ephPub(32) || AEAD(K, nonce=0^12, aad="grant"||epoch||ikX, MK32) → 정확히 80B
function sealMk(mk, ikXRaw, epoch) {
  const eph = genX();
  const ss = crypto.diffieHellman({ privateKey: eph.priv, publicKey: importXPub(ikXRaw) });
  const K = grantKey(eph.raw, ikXRaw, ss);
  const c = crypto.createCipheriv('chacha20-poly1305', K, Buffer.alloc(12), { authTagLength: 16 });
  c.setAAD(Buffer.concat([Buffer.from('grant'), Buffer.from(String(epoch)), ikXRaw]), { plaintextLength: 32 });
  const ct = Buffer.concat([c.update(mk), c.final()]);
  return Buffer.concat([eph.raw, ct, c.getAuthTag()]);
}
function openMk(sealed, recipient, epoch) {
  const ephRaw = sealed.subarray(0, 32);
  const ss = crypto.diffieHellman({ privateKey: recipient.priv, publicKey: importXPub(ephRaw) });
  const K = grantKey(ephRaw, recipient.raw, ss);
  const d = crypto.createDecipheriv('chacha20-poly1305', K, Buffer.alloc(12), { authTagLength: 16 });
  d.setAAD(Buffer.concat([Buffer.from('grant'), Buffer.from(String(epoch)), recipient.raw]), { plaintextLength: 32 });
  d.setAuthTag(sealed.subarray(64, 80));
  return Buffer.concat([d.update(sealed.subarray(32, 64)), d.final()]);
}
const b64u = (b) => Buffer.from(b).toString('base64url');
// 기기 하나 = X25519(봉인 수신) + Ed25519(승인 서명) 키쌍
function newDevice(label, kind = 'controller', platform = 'ios') {
  const x = genX(); const ed = genEd();
  return { label, kind, platform, x, ed, ikX: b64u(x.raw), ikEd: b64u(ed.raw) };
}
function signGrant(dev, epoch, ikXRaw, sealed) {
  return b64u(crypto.sign(null, deviceTrust._grantSigMessage(epoch, ikXRaw, sealed), dev.ed.priv));
}
function fakeStore() {
  const files = new Map();
  return {
    files,
    async load(uid) { return files.has(uid) ? JSON.parse(files.get(uid)) : null; },
    async save(uid, obj) { files.set(uid, JSON.stringify(obj)); },
  };
}
// 배관(알림/푸시/팬아웃)은 전부 스텁 — 검증 대상은 상태 전이와 암호문 취급이다.
function withStubs(fn) {
  const relay = require('../services/daemonRelayService');
  const notif = require('../services/notificationService');
  const push = require('../services/pushService');
  const saved = {
    fan: relay.fanoutDeviceApproval, present: relay.presentClient,
    create: notif.createNotification, read: notif.markRead, send: push.sendToUser,
  };
  const seen = { events: [], notifs: [], reads: [], pushes: [] };
  let notifId = 700;
  relay.fanoutDeviceApproval = (userId, event) => seen.events.push(event);
  relay.presentClient = () => null;
  notif.createNotification = async (userId, p) => { seen.notifs.push({ userId, ...p }); return { id: notifId += 1 }; };
  notif.markRead = async (userId, p) => { seen.reads.push({ userId, ...p }); return { ids: p.ids }; };
  push.sendToUser = async (userId, p, o) => { seen.pushes.push({ userId, p, o }); return { sent: 1 }; };
  const restore = () => {
    relay.fanoutDeviceApproval = saved.fan; relay.presentClient = saved.present;
    notif.createNotification = saved.create; notif.markRead = saved.read; push.sendToUser = saved.send;
  };
  return Promise.resolve(fn(seen)).finally(restore);
}

test('e2ee 확인번호 — 공개키에서 결정적 파생(서버 발급 아님) · 4자리 = 6자리 지문의 뒤 4자리', () => {
  const dev = newDevice('iPad Pro');
  const a = deviceTrust._fingerprintOf(7, dev.x.raw);
  const b = deviceTrust._fingerprintOf(7, dev.x.raw);
  assert.deepStrictEqual(a, b, '같은 입력 = 같은 숫자(양쪽 화면이 서버 없이 같은 값을 만든다)');
  assert.match(a.verifyCode, /^\d{4}$/);
  assert.match(a.fingerprint, /^\d{3} \d{3}$/);
  // ★ 실제 MITM 대조 대상은 60비트 안전코드다. 짧은 숫자는 방어력이 없다 —
  //  서버는 userId 와 피해 기기의 실제 공개키를 둘 다 알아서 "같은 표시값이 나오는 자기 키쌍"을
  //  오프라인으로 찾을 수 있다(실측: 4자리 1.3초 / 6자리 80초). verifyCode 는 요청 구분용일 뿐이다.
  assert.match(a.safetyCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    '표시 지문은 60비트(base32 12글자)여야 한다');
  assert.notStrictEqual(deviceTrust._fingerprintOf(8, dev.x.raw).safetyCode, a.safetyCode);
  assert.notStrictEqual(deviceTrust._fingerprintOf(7, newDevice('x').x.raw).safetyCode, a.safetyCode);
  // 계정이 다르면 다른 숫자(교차계정 지문 재사용 차단), 키가 다르면 다른 숫자(= MITM 감지의 근거).
  assert.notStrictEqual(deviceTrust._fingerprintOf(8, dev.x.raw).fingerprint, a.fingerprint);
  assert.notStrictEqual(deviceTrust._fingerprintOf(7, newDevice('x').x.raw).fingerprint, a.fingerprint);
});

test('e2ee 평문 MK 거부 — 필드 자체가 없고, 32B 원문은 형식에서 불합격', () => {
  const mk = crypto.randomBytes(32);
  // ① 평문 키를 담을 필드 이름은 전부 거절된다(오전송 그물).
  for (const f of deviceTrust._config.FORBIDDEN_FIELDS) {
    assert.throws(() => deviceTrust._rejectPlaintextFields({ [f]: b64u(mk) }),
      (e) => e.statusCode === 400 && e.code === 'PLAINTEXT_KEY_REJECTED' && e.publicDetail.field === f);
  }
  // ② sealed 는 정확히 80B(ephPub32+ct32+tag16). 32B 원문 키는 길이에서 걸린다.
  assert.throws(() => deviceTrust._decodeExact(b64u(mk), deviceTrust._config.SEALED_LEN, 'sealed'),
    (e) => e.code === 'BAD_LENGTH' && e.publicDetail.got === 32 && e.publicDetail.expected === 80);
  // ③ 비정규 b64(패딩/표준알파벳)도 거절 — 조용히 삼켜서 다른 바이트로 저장되지 않게.
  const std = Buffer.from(mk).toString('base64');
  if (/[+/=]/.test(std)) {
    assert.throws(() => deviceTrust._decodeExact(std, 32, 'ikX'), (e) => /BAD_ENCODING|BAD_LENGTH/.test(e.code));
  }
  // ④ 정상 80B 봉인문은 통과하고, 수신자 개인키로 열면 MK 가 그대로 나온다(참조 구현 왕복).
  const dev = newDevice('MacBook', 'host', 'darwin');
  const sealed = sealMk(mk, dev.x.raw, 1);
  assert.strictEqual(sealed.length, 80);
  assert.strictEqual(deviceTrust._decodeExact(b64u(sealed), 80, 'sealed').length, 80);
  assert.deepStrictEqual(openMk(sealed, dev.x, 1), mk);
});

test('e2ee grant 서명 — 정본 바이트열 + 위조/세대변조 거부', () => {
  const approver = newDevice('MacBook', 'host', 'darwin');
  const recipient = newDevice('iPad Pro');
  const mk = crypto.randomBytes(32);
  const sealed = sealMk(mk, recipient.x.raw, 2);
  const sig = Buffer.from(signGrant(approver, 2, recipient.x.raw, sealed), 'base64url');
  const ok = { epoch: 2, ikXRaw: recipient.x.raw, sealedRaw: sealed, sigRaw: sig, approverIkEdRaw: approver.ed.raw };
  assert.strictEqual(deviceTrust._verifyGrantSig(ok), true);
  // epoch 변조 → 실패(옛 세대 봉인문을 새 세대로 재활용 못 한다)
  assert.strictEqual(deviceTrust._verifyGrantSig({ ...ok, epoch: 3 }), false);
  // 수신자 바꿔치기 → 실패(서버가 봉인 대상을 갈아치울 수 없다)
  assert.strictEqual(deviceTrust._verifyGrantSig({ ...ok, ikXRaw: newDevice('x').x.raw }), false);
  // 봉인문 1바이트 변조 → 실패
  const tampered = Buffer.from(sealed); tampered[70] ^= 1;
  assert.strictEqual(deviceTrust._verifyGrantSig({ ...ok, sealedRaw: tampered }), false);
  // 다른 기기가 서명 → 실패(승인자 신원 위조 차단)
  assert.strictEqual(deviceTrust._verifyGrantSig({ ...ok, approverIkEdRaw: newDevice('y').ed.raw }), false);
  // 정본 메시지 모양 고정 — 다른 구현체가 맞춰야 하는 계약
  const msg = deviceTrust._grantSigMessage(2, recipient.x.raw, sealed);
  // epoch 는 u32 BE(4B) — 데몬/앱 구현이 정본. 이전에는 back 만 문자열+널바이트(84B)를 써서
  //  서버 검증이 전부 실패했고, 그 결과 열쇠가 한 대도 배포되지 않았다(양쪽 단위 테스트는 초록).
  //  이 계약은 test/e2ee-crossimpl.test.js 가 데몬 구현과 실제로 대조한다.
  assert.strictEqual(msg.length, 'cpt-e2ee/v1/grant'.length + 4 + 32 + 32);
  assert.ok(msg.subarray(0, 17).equals(Buffer.from('cpt-e2ee/v1/grant')));
  assert.ok(msg.subarray(-32).equals(crypto.createHash('sha256').update(sealed).digest()));
});

test('e2ee 기기 승인 전 과정 — 부트스트랩 → 대기 → 1탭 승인 → 봉인문 수령', async () => {
  deviceTrust._reset();
  const store = fakeStore();
  deviceTrust._setStore(store);
  await withStubs(async (seen) => {
    const pc = newDevice('MacBook Pro', 'host', 'darwin');
    const phone = newDevice('iPhone 17');
    const mk = crypto.randomBytes(32); // MK_1 — 오직 기기들만 아는 값. 서버로는 절대 안 간다.

    // ① 계정 최초 기기 = 부트스트랩 허용(승인해 줄 기기가 없다)
    const first = await deviceTrust.enroll(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, label: pc.label, kind: 'host' });
    assert.strictEqual(first.state, 'bootstrap');
    const sealedSelf = sealMk(mk, pc.x.raw, 1);
    const boot = await deviceTrust.bootstrap(7, 12, {
      ikX: pc.ikX, ikEd: pc.ikEd, label: pc.label, kind: 'host', platform: 'darwin',
      sealed: b64u(sealedSelf), sig: signGrant(pc, 1, pc.x.raw, sealedSelf),
    });
    assert.strictEqual(boot.epoch, 1);
    const sealedSecond = sealMk(mk, phone.x.raw, 1);
    // 두 번째 부트스트랩은 반드시 막혀야 한다 — 통과하면 계정 열쇠가 갈라져 전 기기가 서로 못 읽는다.
    await assert.rejects(() => deviceTrust.bootstrap(7, 99, {
      ikX: phone.ikX, ikEd: phone.ikEd, sealed: b64u(sealedSecond),
      sig: signGrant(phone, 1, phone.x.raw, sealedSecond),
    }), (e) => e.statusCode === 409 && e.code === 'E2EE_ALREADY_INITIALIZED');

    // ② 새 폰: 계정 로그인만으로 enroll → 대기 + 확인번호(공개키 파생)
    const pend = await deviceTrust.enroll(7, null, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, platform: 'ios' });
    assert.strictEqual(pend.state, 'pending');
    assert.strictEqual(pend.verifyCode, deviceTrust._fingerprintOf(7, phone.x.raw).verifyCode);
    // 팬아웃 = 기존 배관 그대로(인앱 시트 + 알림 인박스/FCM)
    const reqEv = seen.events.filter((e) => e.kind === 'request');
    assert.strictEqual(reqEv.length, 1);
    // ★ 이벤트 종류(kind)와 기기 종류(deviceKind)는 반드시 다른 필드여야 한다 —
    //   같은 이름이면 스프레드가 'request' 를 'controller' 로 덮어써 승인 시트가 영원히 안 뜬다.
    assert.strictEqual(reqEv[0].deviceKind, 'controller');
    assert.strictEqual(reqEv[0].verifyCode, pend.verifyCode);
    const n = seen.notifs[0];
    assert.strictEqual(n.kind, 'device_approval');
    assert.ok(n.subtitle && n.subtitle.includes(phone.label));
    assert.ok(!String(n.subtitle).includes(pend.verifyCode), '확인번호가 FCM 본문(subtitle)으로 새면 안 된다');
    //  ★ 개정 5(2026-07-28): 인앱 본문에서도 확인번호를 뺐다 — 알림이 승인 화면과 같은 말을 해야 한다
    //   ("코드를 입력해야 하나" 로 읽히던 것이 이 개정의 출발점). 어느 요청인지는 시트가 구분한다.
    assert.ok(!String(n.body).includes(pend.verifyCode), '확인번호는 알림에 싣지 않는다(개정 5)');
    assert.ok(String(n.title).includes('로그인'), '알림 제목도 승인 화면과 같은 사실 진술이어야 한다');
    assert.strictEqual(n.deeplink, `codingpt://device-approval/${pend.enrollmentId}`);
    // 멱등 — 폴링/앱 재시작에 같은 enrollment 를 돌려준다(알림은 새로 만들지 않는다)
    const again = await deviceTrust.enroll(7, null, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label });
    assert.strictEqual(again.enrollmentId, pend.enrollmentId);
    assert.strictEqual(seen.notifs.length, 1);

    // ③ 대기 중 기기는 승인자가 될 수 없다(자기 자신을 승인하는 우회 차단)
    const sealedPhone = sealMk(mk, phone.x.raw, 1);
    await assert.rejects(() => deviceTrust.approve(7, {
      enrollmentId: pend.enrollmentId, ikX: phone.ikX, approverIkX: phone.ikX, epoch: 1,
      sealed: b64u(sealedPhone), sig: signGrant(phone, 1, phone.x.raw, sealedPhone),
    }), (e) => e.statusCode === 403 && e.code === 'NOT_TRUSTED');

    // ④ 봉인 대상 바꿔치기 시도 → KEY_MISMATCH
    const other = newDevice('공격자');
    const sealedOther = sealMk(mk, other.x.raw, 1);
    await assert.rejects(() => deviceTrust.approve(7, {
      enrollmentId: pend.enrollmentId, ikX: other.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedOther), sig: signGrant(pc, 1, other.x.raw, sealedOther),
    }), (e) => e.statusCode === 409 && e.code === 'KEY_MISMATCH');

    // ⑤ 신뢰 기기(PC)가 1탭 승인 — MK 를 폰 공개키로 봉인해 업로드
    const okRes = await deviceTrust.approve(7, {
      enrollmentId: pend.enrollmentId, ikX: phone.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedPhone), sig: signGrant(pc, 1, phone.x.raw, sealedPhone),
    });
    assert.strictEqual(okRes.ok, true);
    // 해소 팬아웃 + 알림 읽음(= 기존 크로스기기 dismiss 재사용) → 다른 기기 배너 자동 회수
    const resolved = seen.events.find((e) => e.kind === 'resolved');
    assert.strictEqual(resolved.approved, true);
    assert.deepStrictEqual(seen.reads[0].ids, [n_id(seen)]);

    // ⑥ 폰이 다시 enroll → trusted + 봉인문 수령 → 열어서 MK 확인(진짜 열쇠가 옮겨졌다)
    const trusted = await deviceTrust.enroll(7, null, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label });
    assert.strictEqual(trusted.state, 'trusted');
    assert.strictEqual(trusted.epoch, 1);
    assert.deepStrictEqual(openMk(Buffer.from(trusted.grant.sealed, 'base64url'), phone.x, 1), mk);
    assert.strictEqual(trusted.grant.sealedByKeyId, 1);

    // ⑦ 서버 저장물에 평문 MK 가 없다 — blob 전체를 훑어 32B 원문의 어떤 인코딩도 없어야 한다.
    const blob = store.files.get('7');
    assert.ok(blob.length > 0);
    assert.ok(!blob.includes(b64u(mk)));
    assert.ok(!blob.includes(mk.toString('base64')));
    assert.ok(!blob.includes(mk.toString('hex')));
    for (const f of deviceTrust._config.FORBIDDEN_FIELDS) assert.ok(!blob.includes(`"${f}"`));

    // ⑧ 키링(감사 UI) — 공개키/지문/상태만. 기기 2대가 trusted.
    const ring = await deviceTrust.keyring(7, { ikX: phone.ikX });
    assert.strictEqual(ring.epoch, 1);
    assert.strictEqual(ring.devices.length, 2);
    assert.deepStrictEqual(ring.devices.map((d) => d.state), ['trusted', 'trusted']);
    assert.strictEqual(ring.myState, 'trusted');
    assert.strictEqual(ring.devices[1].verifyCode, pend.verifyCode);
  });
});
function n_id(seen) { return seen.notifs.length ? 701 : null; } // withStubs 의 첫 알림 id(700+1)

test('e2ee — 열쇠는 ikX(공개키) 기준으로만 발급된다(deviceId 재귀속 함정 #12)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async () => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s), sig: signGrant(pc, 1, pc.x.raw, s) });
    // 같은 ikX + 다른 deviceId(기기행 재귀속/업서트) → 여전히 trusted(열쇠 유지)
    const same = await deviceTrust.enroll(7, 99, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host' });
    assert.strictEqual(same.state, 'trusted');
    // 같은 deviceId + 다른 ikX(다른 기기가 그 행을 선점) → 절대 열쇠를 주지 않고 승인 대기
    const impostor = newDevice('같은 행을 쓰는 다른 기기', 'host', 'darwin');
    const pend = await deviceTrust.enroll(7, 12, { ikX: impostor.ikX, ikEd: impostor.ikEd, kind: 'host' });
    assert.strictEqual(pend.state, 'pending');
  });
});

// ★ 2026-07-28 실사고: 폰이 "새 기기 승인 · Android" 카드를 보고 있었는데 그것은 **자기 자신의 옛
//  enrollment** 였다(재설치·계정 전환으로 신원키가 갈라지면 같은 기기가 두 항목이 된다). approve 는
//  승인자가 trusted 여야 하므로 그 [승인] 은 항상 403 = 무동작 카드. listPending 이 호출자를 알면
//  애초에 그 항목을 안 준다(ikX 쿼리). 클라이언트도 같은 규칙을 갖지만 서버가 마지막 방어선이다.
test('e2ee 대기 목록 — 자기 요청은 빼고, 미신뢰 호출자에겐 아무것도 주지 않는다(ikX 쿼리)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async () => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    const phone = newDevice('Android');
    const tablet = newDevice('iPad');
    for (const d of [phone, tablet]) {
      const p = await deviceTrust.enroll(7, null, { ikX: d.ikX, ikEd: d.ikEd, label: d.label });
      assert.strictEqual(p.state, 'pending');
    }
    // ① ikX 없음(구 클라이언트) = 기존 동작: 전량
    assert.strictEqual((await deviceTrust.listPending(7)).pending.length, 2);
    // ② 신뢰된 PC 가 물으면 2건 그대로(자기 것은 애초에 대기 목록에 없다)
    assert.strictEqual((await deviceTrust.listPending(7, { ikX: pc.ikX })).pending.length, 2);
    // ③ **대기 중인 폰**이 물으면 0건 — 자기 요청 제외 + 애초에 승인 주체가 될 수 없다(미신뢰)
    assert.strictEqual((await deviceTrust.listPending(7, { ikX: phone.ikX })).pending.length, 0);
    // ④ 폰이 승인되면(=trusted) 남은 iPad 만 보인다. 자기 것은 이미 목록에서 빠져 있다.
    const list = await deviceTrust.listPending(7, { ikX: pc.ikX });
    const mine = list.pending.find((p) => p.ikX === phone.ikX);
    const sealedPhone = sealMk(mk, phone.x.raw, 1);
    await deviceTrust.approve(7, {
      enrollmentId: mine.enrollmentId, ikX: phone.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedPhone), sig: signGrant(pc, 1, phone.x.raw, sealedPhone),
    });
    const asPhone = await deviceTrust.listPending(7, { ikX: phone.ikX });
    assert.deepStrictEqual(asPhone.pending.map((p) => p.label), ['iPad']);
    // ⑤ 형식이 깨진 ikX 는 400 이 아니라 '알 수 없는 호출자'(읽기 전용 조회를 던져서 막지 않는다)
    assert.strictEqual((await deviceTrust.listPending(7, { ikX: 'not-a-key' })).pending.length, 1);
  });
});

// ★ 개정 6(2026-07-28 사용자 요구): 기기 목록의 [연동] 버튼 = 연동 절차 다시 시작. 방향은 **서버가**
//  판단한다(클라가 정하면 폰과 PC 규칙이 갈라진다): 내가 대기 중이면 재알림 · 상대에게 열쇠가 없으면
//  그 기기가 즉시 재신청하도록 nudge 팬아웃. 쿨다운이 없으면 버튼 연타가 곧 푸시 연타가 된다.
// ★ 2026-07-28 실사고: 승인된 열쇠가 기기 행에 묶이지 않아 같은 폰이 "연동 안 됨" 행 + 고아 열쇠 행
//  **둘**로 나왔다(모바일은 JWT 인증이라 서버가 deviceId 를 모른다 → 컨트롤러가 body.deviceId 를 검증해
//  넘긴다). 신청 시점의 deviceId 가 승인까지 이어져야 화면이 한 줄이 된다.
test('e2ee 승인 — 신청 시점 deviceId 가 열쇠에 묶인다(기기 행 = 열쇠, 고아 행 금지)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async () => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    const phone = newDevice('Android');
    const p = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label });
    assert.strictEqual(p.state, 'pending');
    const sealedPhone = sealMk(mk, phone.x.raw, 1);
    await deviceTrust.approve(7, {
      enrollmentId: p.enrollmentId, ikX: phone.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedPhone), sig: signGrant(pc, 1, phone.x.raw, sealedPhone),
    });
    const ring = await deviceTrust.keyring(7, { ikX: phone.ikX });
    const row = ring.devices.find((d) => d.ikX === phone.ikX);
    assert.strictEqual(row.deviceId, 42, '승인된 열쇠는 신청 기기 행(42)에 묶여야 한다');
    // deviceId 를 모르는 신청(구 클라이언트)은 여전히 null — 다음 enroll 에서 흡수된다(멱등 경로).
    const other = newDevice('iPad');
    const p2 = await deviceTrust.enroll(7, null, { ikX: other.ikX, ikEd: other.ikEd, label: other.label });
    const sealedOther = sealMk(mk, other.x.raw, 1);
    await deviceTrust.approve(7, {
      enrollmentId: p2.enrollmentId, ikX: other.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedOther), sig: signGrant(pc, 1, other.x.raw, sealedOther),
    });
    const ring2 = await deviceTrust.keyring(7, { ikX: other.ikX });
    assert.strictEqual(ring2.devices.find((d) => d.ikX === other.ikX).deviceId, null);
    await deviceTrust.enroll(7, 77, { ikX: other.ikX, ikEd: other.ikEd, label: other.label });
    const ring3 = await deviceTrust.keyring(7, { ikX: other.ikX });
    assert.strictEqual(ring3.devices.find((d) => d.ikX === other.ikX).deviceId, 77, '다음 enroll 이 귀속을 흡수한다');
  });
});

test('e2ee nudge — 대기 중이면 재알림 · 아니면 대상 기기에 재신청 팬아웃 · 쿨다운 429', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async (seen) => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    // ① 대기 중인 폰이 누르면 = 같은 요청을 다시 알린다(새 enrollment 를 만들지 않는다).
    const phone = newDevice('Android');
    const p = await deviceTrust.enroll(7, null, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label });
    const notifsBefore = seen.notifs.length;
    const r1 = await deviceTrust.nudge(7, { ikX: phone.ikX });
    assert.strictEqual(r1.sent, 'reannounce');
    assert.strictEqual(r1.enrollmentId, p.enrollmentId);
    assert.ok(seen.notifs.length > notifsBefore, '재알림이 실제로 발송돼야 한다');

    // ② 쿨다운 — 연타는 429(NUDGE_COOLDOWN). 알림 폭탄 방지가 이 버튼의 전제다.
    await assert.rejects(() => deviceTrust.nudge(7, { ikX: phone.ikX }),
      (e) => e.statusCode === 429 && e.code === 'NUDGE_COOLDOWN');

    // ③ 열쇠 있는 기기가 **열쇠 없는 대상**에 대해 누르면 → 그 기기가 재신청하도록 팬아웃.
    deviceTrust._config.NUDGE_COOLDOWN_MS; // (문서용 참조 — 쿨다운은 아래에서 우회한다)
    deviceTrust._nudgeAt.clear();
    const r2 = await deviceTrust.nudge(7, { ikX: pc.ikX, deviceId: 99 });
    assert.strictEqual(r2.sent, 'nudge');
    const ev = seen.events.filter((e) => e.kind === 'nudge').pop();
    assert.strictEqual(ev.deviceId, 99);

    // ④ 이미 연동된 기기면 아무것도 보내지 않는다(무의미한 알림을 만들지 않는다).
    deviceTrust._nudgeAt.clear();
    const r3 = await deviceTrust.nudge(7, { ikX: pc.ikX, deviceId: 12 });
    assert.deepStrictEqual([r3.sent, r3.reason], ['none', 'already_linked']);
  });
});

// ★ 개정 8(2026-07-28 사용자 확정): **알리지 않는 등록**. 원문 — "그래도 그 전에 사용자한테
//  android에서 내 pc 목록에 승인 요청할까요? 라고 물어보면서 뭔가 온보딩 식으로 알려줘야 하지 않을까?"
//  로그인 즉시 알려버리면 앱이 "보낼까요?" 를 묻는 순간 이미 보낸 뒤에 묻는 거짓 화면이 된다.
//  세 가지가 동시에 성립해야 이 UX 가 성립한다:
//   ① announce:false 는 알림/팬아웃을 하지 않는다 ② 그 신청은 승인자 목록에도 안 보인다(PC 폴링이
//   먼저 카드를 띄우면 순서가 또 깨진다) ③ nudge 가 첫 알림이 되고 **쿨다운에 걸리지 않는다**
//   (걸리면 announced=false 로 남아 아무 기기에도 안 보이는 유령 요청이 된다 — 앱은 429 를 성공으로
//   취급하므로 사용자는 보냈다고 믿는다).
test('e2ee 등록 — announce:false 는 알리지도 보이지도 않고, nudge 가 첫 알림이 된다(개정 8)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async (seen) => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    const phone = newDevice('Android');
    const notifs0 = seen.notifs.length;
    const events0 = seen.events.length;
    const p = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, announce: false });
    assert.strictEqual(p.state, 'pending');
    assert.strictEqual(p.announced, false, '응답이 아직 안 알렸음을 알려야 한다(앱이 ① 화면을 그린다)');
    // ① 알림 0건 · 팬아웃 0건
    assert.strictEqual(seen.notifs.length, notifs0, 'announce:false 는 알림을 만들지 않는다');
    assert.strictEqual(seen.events.length, events0, 'announce:false 는 승인 카드를 띄우지 않는다');
    // ② 승인자(PC)의 대기 목록에도 없다 — 켜져 있는 PC 가 폴링으로 먼저 카드를 띄우면 안 된다.
    assert.strictEqual((await deviceTrust.listPending(7, { ikX: pc.ikX })).pending.length, 0);
    // ②-b 폴링(같은 ikX 재신청)도 알리지 않는다 — 앱은 대기 중 계속 enroll 을 올린다.
    const again = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, announce: false });
    assert.strictEqual(again.enrollmentId, p.enrollmentId, '같은 신청서를 재사용한다');
    assert.strictEqual(seen.events.length, events0, '억제된 신청은 폴링에서도 팬아웃하지 않는다');

    // ③ 사용자가 [승인 요청 보내기] → nudge 가 첫 알림. **쿨다운이 있어도 통과**해야 한다.
    deviceTrust._nudgeAt.set('7', Date.now()); // 방금 다른 nudge 를 보낸 상태를 강제
    const r = await deviceTrust.nudge(7, { ikX: phone.ikX });
    assert.strictEqual(r.sent, 'announce', '첫 알림은 reannounce 가 아니라 announce');
    assert.ok(seen.notifs.length > notifs0, '이제야 알림이 나간다');
    assert.strictEqual((await deviceTrust.listPending(7, { ikX: pc.ikX })).pending.length, 1, '이제 승인자 목록에 보인다');
    // ④ 두 번째부터는 쿨다운이 정상 적용된다(알림 폭탄 방지는 그대로).
    await assert.rejects(() => deviceTrust.nudge(7, { ikX: phone.ikX }),
      (e) => e.statusCode === 429 && e.code === 'NUDGE_COOLDOWN');
    // ⑤ 기본값은 알린다(구 클라이언트·데몬·PC 하위호환) + 응답에 deviceId 가 실린다(설정 화면이 행에 묶는다).
    const ipad = newDevice('iPad');
    const q = await deviceTrust.enroll(7, 55, { ikX: ipad.ikX, ikEd: ipad.ikEd, label: ipad.label });
    assert.strictEqual(q.announced, true);
    assert.strictEqual(q.deviceId, 55);
    assert.ok(seen.events.some((e) => e.kind === 'request' && e.deviceId === 55), '팬아웃도 deviceId 를 싣는다');
  });
});

// ★ 개정 10(2026-07-28 사용자 확정): 계정 첫 열쇠의 주인은 **경주가 아니라 규칙**으로 정한다.
//  실측(prod): PC 페어링 26초 뒤 폰 로그인 → 폰이 0.5초 만에 부트스트랩해 PC 가 '승인 대기'가 됐다
//  (폰은 인프로세스 즉시, PC 는 데몬 phase 보고 대기 = 구조적 속도차). host 기기가 있으면 모바일은
//  대기하고 PC 가 열쇠를 만든다. host 가 0대면(폰만 쓰는 사용자) 그대로 허용 = 영구 차단 금지.
test('e2ee 부트스트랩 우선권 — host(PC)가 있으면 모바일은 대기, 없으면 허용(개정 10)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async () => {
    const phone = newDevice('Android');
    // ① host 0대(폰만 있는 계정) → 폰이 부트스트랩한다(폴백 — 아니면 영영 못 켠다)
    deviceTrust._setDeviceLookup(async () => 0);
    const r0 = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, kind: 'controller' });
    assert.strictEqual(r0.state, 'bootstrap');

    // ② host 1대(PC 등록됨) → 모바일은 bootstrap 을 받지 못하고 **대기**가 된다
    deviceTrust._reset();
    deviceTrust._setStore(fakeStore());
    deviceTrust._setDeviceLookup(async () => 1);
    const r1 = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, kind: 'controller' });
    assert.strictEqual(r1.state, 'pending');
    // ③ 같은 상황에서 PC(host)는 그대로 부트스트랩한다 = 순서가 항상 같다
    const pc = newDevice('PC', 'host', 'darwin');
    const r2 = await deviceTrust.enroll(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, label: pc.label, kind: 'host' });
    assert.strictEqual(r2.state, 'bootstrap');
    // ④ 모바일이 bootstrap 을 직접 호출해도 막힌다(enroll 을 건너뛰는 우회 차단)
    const mk = crypto.randomBytes(32);
    const sealed = sealMk(mk, phone.x.raw, 1);
    await assert.rejects(() => deviceTrust.bootstrap(7, 42, {
      ikX: phone.ikX, ikEd: phone.ikEd, kind: 'controller',
      sealed: b64u(sealed), sig: signGrant(phone, 1, phone.x.raw, sealed),
    }), (e) => e.statusCode === 409 && e.code === 'E2EE_HOST_FIRST');
    // ⑤ 조회 실패는 허용으로 본다(DB 장애가 열쇠 생성을 영구 차단하면 안 된다)
    deviceTrust._reset();
    deviceTrust._setStore(fakeStore());
    deviceTrust._setDeviceLookup(async () => { throw new Error('db down'); });
    const r3 = await deviceTrust.enroll(7, 42, { ikX: phone.ikX, ikEd: phone.ikEd, label: phone.label, kind: 'controller' });
    assert.strictEqual(r3.state, 'bootstrap');
    deviceTrust._setDeviceLookup(async () => 0);
  });
});

// ★ 개정 12(2026-07-28 사용자 확정): **승인 절차를 없애고 QR/코드로 연동한다.**
//  코드는 owner 가 로컬에서 만든 난수이고 서버에는 해시만 온다 → 서버는 코드를 모른다. owner 가 봉인문을
//  `HKDF(code)` 로 한 겹 더 감싸 올리므로 서버가 공개키를 바꿔치기해도 봉인문을 만들 수도 열 수도 없다
//  (= 사람의 눈 대조가 필요 없다). 서버가 지켜야 할 것: 코드 대조 · 시도 제한 · 만료 · 키링 귀속.
test('e2ee 연동(QR/코드) — 코드 대조로 열쇠가 전달되고, 틀린 코드는 5회에 폐기된다(개정 12)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async (seen) => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    // ① owner(PC)가 코드를 만든다 — 서버에는 해시만 올라간다.
    const code = 'ABCD2345';
    const codeHash = b64u(crypto.createHash('sha256').update(code).digest());
    const started = await deviceTrust.linkStart(7, 12, { codeHash, ikX: pc.ikX });
    assert.ok(started.linkId && started.state === 'waiting');
    // 열쇠 없는 기기는 연동을 시작할 수 없다(코드 발급 주체는 열쇠 보유자뿐).
    const phone = newDevice('Android');
    await assert.rejects(() => deviceTrust.linkStart(7, 42, { codeHash, ikX: phone.ikX }),
      (e) => e.statusCode === 403 && e.code === 'NOT_TRUSTED');

    // ② 새 기기가 틀린 코드를 넣으면 남은 횟수를 알려주고, 5회에 폐기된다(온라인 무차별 대입 차단).
    for (let i = 1; i < deviceTrust._config.LINK_MAX_TRIES; i += 1) {
      await assert.rejects(() => deviceTrust.linkClaim(7, 42, { linkId: started.linkId, code: 'WRONG' + i, ikX: phone.ikX, ikEd: phone.ikEd }),
        (e) => e.statusCode === 400 && e.code === 'LINK_CODE_MISMATCH');
    }
    await assert.rejects(() => deviceTrust.linkClaim(7, 42, { linkId: started.linkId, code: 'WRONGX', ikX: phone.ikX, ikEd: phone.ikEd }),
      (e) => e.statusCode === 429 && e.code === 'LINK_BLOCKED');

    // ③ 새 코드로 정상 경로 — 코드가 맞으면 owner 에게 팬아웃되고(사람 승인 없음) 열쇠가 등록된다.
    const s2 = await deviceTrust.linkStart(7, 12, { codeHash, ikX: pc.ikX });
    const claimed = await deviceTrust.linkClaim(7, 42, { linkId: s2.linkId, code: code.toLowerCase(), ikX: phone.ikX, ikEd: phone.ikEd, label: 'Android' });
    assert.strictEqual(claimed.state, 'claimed');
    assert.ok(seen.events.some((e) => e.kind === 'link_claim' && e.linkId === s2.linkId), 'owner 에게 즉시 알린다');
    // 아직 봉인문이 없으므로 새 기기는 받을 게 없다.
    assert.strictEqual((await deviceTrust.linkGet(7, s2.linkId)).state, 'claimed');

    const wrapped = crypto.randomBytes(120); // (감싸기는 클라이언트 몫 — 서버는 불투명 바이트로만 다룬다)
    await deviceTrust.linkFulfill(7, {
      linkId: s2.linkId, epoch: 1, wrapped: b64u(wrapped), sig: signGrant(pc, 1, phone.x.raw, wrapped.slice(0, 80)),
    });
    const got = await deviceTrust.linkGet(7, s2.linkId);
    assert.strictEqual(got.state, 'ready');
    assert.strictEqual(got.wrapped, b64u(wrapped), '감싼 봉인문을 그대로 돌려준다(서버는 못 연다)');
    // ④ 키링에 **신청 기기 행(42)으로 귀속**된다 — 목록에 새 줄이 생기지 않는다(사용자 요구).
    const ring = await deviceTrust.keyring(7, { ikX: phone.ikX });
    const row = ring.devices.find((d) => d.ikX === phone.ikX);
    assert.strictEqual(row.state, 'trusted');
    assert.strictEqual(row.deviceId, 42);
  });
});

test('e2ee 거절/만료 — 반복 거절은 차단, 만료는 스위퍼가 회수(알림도 함께)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async (seen) => {
    const pc = newDevice('PC', 'host', 'darwin');
    const mk = crypto.randomBytes(32);
    const s0 = sealMk(mk, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });

    const bad = newDevice('낯선 기기');
    for (let i = 0; i < deviceTrust._config.DENY_BLOCK_MAX; i += 1) {
      const p = await deviceTrust.enroll(7, null, { ikX: bad.ikX, ikEd: bad.ikEd, label: bad.label });
      assert.strictEqual(p.state, 'pending');
      await deviceTrust.deny(7, { enrollmentId: p.enrollmentId });
    }
    // 3회 거절 후 같은 키의 재신청은 차단(알림 폭탄 방지)
    await assert.rejects(() => deviceTrust.enroll(7, null, { ikX: bad.ikX, ikEd: bad.ikEd }),
      (e) => e.statusCode === 429 && e.code === 'ENROLL_BLOCKED');
    // 거절 알림도 읽음 처리로 배너를 회수한다
    assert.strictEqual(seen.reads.length, deviceTrust._config.DENY_BLOCK_MAX);

    // 만료: 스위퍼가 resolved(expired) 팬아웃 + 인덱스 제거
    const other = newDevice('태블릿');
    const p = await deviceTrust.enroll(7, null, { ikX: other.ikX, ikEd: other.ikEd });
    deviceTrust._sweep(Date.now() + deviceTrust._config.ENROLL_TTL_MS + 1);
    assert.strictEqual(deviceTrust._pending.has(p.enrollmentId), false);
    const ev = seen.events.filter((e) => e.kind === 'resolved' && e.enrollmentId === p.enrollmentId)[0];
    assert.strictEqual(ev.approved, false);
    assert.strictEqual(ev.reason, 'expired');
    // 만료 후 승인 시도는 404(인덱스에 없다)
    const sealedOtherE1 = sealMk(mk, other.x.raw, 1);
    await assert.rejects(() => deviceTrust.approve(7, {
      enrollmentId: p.enrollmentId, ikX: other.ikX, approverIkX: pc.ikX, epoch: 1,
      sealed: b64u(sealedOtherE1), sig: signGrant(pc, 1, other.x.raw, sealedOtherE1),
    }), (e) => e.statusCode === 404);
  });
});

test('e2ee 회전(revoke 후) — 남은 기기 전부 재봉인 강제 · 누락은 400', async () => {
  deviceTrust._reset();
  deviceTrust._setStore(fakeStore());
  await withStubs(async () => {
    const pc = newDevice('PC', 'host', 'darwin');
    const phone = newDevice('iPhone');
    const tablet = newDevice('iPad');
    const mk1 = crypto.randomBytes(32);
    const s0 = sealMk(mk1, pc.x.raw, 1);
    await deviceTrust.bootstrap(7, 12, { ikX: pc.ikX, ikEd: pc.ikEd, kind: 'host', sealed: b64u(s0), sig: signGrant(pc, 1, pc.x.raw, s0) });
    for (const d of [phone, tablet]) {
      const p = await deviceTrust.enroll(7, null, { ikX: d.ikX, ikEd: d.ikEd, label: d.label });
      const sd = sealMk(mk1, d.x.raw, 1);
      await deviceTrust.approve(7, { enrollmentId: p.enrollmentId, ikX: d.ikX, approverIkX: pc.ikX, epoch: 1, sealed: b64u(sd), sig: signGrant(pc, 1, d.x.raw, sd) });
    }
    // 태블릿(keyId 3)을 해제하며 epoch 2 로 회전 — 폰(keyId 2) 봉인문을 빠뜨리면 거부돼야 한다.
    //  (조용히 통과시키면 그 폰이 다음 접속에서 영구 복호 불가 = "갑자기 안 됨")
    const mk2 = crypto.randomBytes(32);
    const sealedPcE2 = sealMk(mk2, pc.x.raw, 2);
    await assert.rejects(() => deviceTrust.rotate(7, {
      approverIkX: pc.ikX, fromEpoch: 1, toEpoch: 2, revokeKeyIds: [3],
      grants: [{ keyId: 1, ikX: pc.ikX, sealed: b64u(sealedPcE2), sig: signGrant(pc, 2, pc.x.raw, sealedPcE2) }],
    }), (e) => e.statusCode === 400 && e.code === 'INCOMPLETE_ROTATION' && e.publicDetail.missing.includes(2));

    const mkGrant = (d) => { const s = sealMk(mk2, d.x.raw, 2); return { keyId: d === pc ? 1 : 2, ikX: d.ikX, sealed: b64u(s), sig: signGrant(pc, 2, d.x.raw, s) }; };
    const rot = await deviceTrust.rotate(7, {
      approverIkX: pc.ikX, fromEpoch: 1, toEpoch: 2, revokeKeyIds: [3], grants: [mkGrant(pc), mkGrant(phone)],
    });
    assert.deepStrictEqual({ epoch: rot.epoch, resealed: rot.resealed, revoked: rot.revoked }, { epoch: 2, resealed: 2, revoked: [3] });
    // 폰은 새 세대 MK 를 받고, 태블릿은 revoked + 새 봉인문 없음
    const phoneRing = await deviceTrust.enroll(7, null, { ikX: phone.ikX, ikEd: phone.ikEd });
    assert.strictEqual(phoneRing.epoch, 2);
    assert.deepStrictEqual(openMk(Buffer.from(phoneRing.grant.sealed, 'base64url'), phone.x, 2), mk2);
    await assert.rejects(() => deviceTrust.enroll(7, null, { ikX: tablet.ikX, ikEd: tablet.ikEd }),
      (e) => e.statusCode === 409 && e.code === 'KEY_REVOKED');
    // 옛 세대 봉인문은 남는다(옛 스냅샷/알림 복호 — §6-19)
    const ring = await deviceTrust.keyring(7, {});
    assert.strictEqual(ring.epoch, 2);
    assert.strictEqual(ring.devices.find((d) => d.keyId === 3).state, 'revoked');
    // required 정책은 복구 코드 없이는 켤 수 없다(기기 전량 소실 = 영구 손실 방지)
    await assert.rejects(() => deviceTrust.setPolicy(7, 'required'), (e) => e.code === 'RECOVERY_REQUIRED');
    await deviceTrust.setRecovery(7, { recovery: { blob: b64u(crypto.randomBytes(60)) } });
    assert.deepStrictEqual(await deviceTrust.setPolicy(7, 'required'), { policy: 'required', epoch: 2 });
  });
});

test('e2ee 저장소 장애 — "빈 키링"으로 뭉개지 않는다(부트스트랩 재허용 금지)', async () => {
  deviceTrust._reset();
  deviceTrust._setStore({
    async load() { const e = new Error('objectstore down'); throw Object.assign(e, { statusCode: 503, code: 'KEYRING_UNAVAILABLE' }); },
    async save() {},
  });
  await withStubs(async () => {
    const d = newDevice('PC', 'host', 'darwin');
    await assert.rejects(() => deviceTrust.enroll(7, 1, { ikX: d.ikX, ikEd: d.ikEd, kind: 'host' }),
      (e) => e.statusCode === 503, '장애 시 bootstrap 을 열어주면 계정 열쇠가 갈라진다');
  });
  deviceTrust._reset();
});

test('e2ee 레이트 리밋 — 유저당 분당 상한 후 차단, 창 넘어가면 회복', () => {
  const map = new Map();
  const now = 1_000_000;
  const max = deviceTrust._config.ENROLL_MAX_PER_MIN;
  for (let i = 0; i < max; i += 1) assert.strictEqual(deviceTrust._allowRate(map, 'u9', now, max), true);
  assert.strictEqual(deviceTrust._allowRate(map, 'u9', now, max), false);
  assert.strictEqual(deviceTrust._allowRate(map, 'u9', now + 60_001, max), true);
  // 감사 UI 에 뜨는 IP 는 마지막 옥텟을 가린다
  assert.strictEqual(deviceTrust._maskIp('203.0.113.42'), '203.0.113.*');
  assert.strictEqual(deviceTrust._maskIp(''), null);
});

test('maybeNotify — 봉인 모드는 평문 hint 로, hint 없으면 기존 event 로 폴백(알림 품질 보존)', async () => {
  const relay = require('../services/daemonRelayService');
  const notif = require('../services/notificationService');
  const orig = notif.createNotification;
  const calls = [];
  notif.createNotification = async (userId, p) => { calls.push({ userId, ...p }); return { id: 1 }; };
  try {
    // (신) 데몬이 봉인문 + 평문 최소 요약(hint)을 보낸 경우
    relay._maybeNotify(7, 'sess-1', { type: 'done', wsName: 'codingpt', summary: '리팩터링 완료', cwd: 'dev/codingpt', win: 1234, workspaceId: 'p-1' });
    // (구) 데몬이 평문 event 를 보낸 경우 — 문구 추출 규칙 동일
    relay._maybeNotify(7, 'sess-2', { type: 'error', message: 'ENOENT' });
    // 알림 아닌 종류는 그대로 무시
    relay._maybeNotify(7, 'sess-3', { type: 'text', text: 'blah' });
    relay._maybeNotify(7, 'sess-4', undefined); // 봉인문만 오고 hint 가 없으면 알림 없음
    assert.strictEqual(calls.length, 2);
    const [a, b] = calls;
    assert.strictEqual(a.body, '리팩터링 완료');   // ★ 잠금화면 본문 = 요약(무내용 푸시로 깎지 않는다)
    assert.strictEqual(a.kind, 'done');
    assert.strictEqual(a.cwd, 'dev/codingpt');     // pane 단위 읽음 scope
    assert.strictEqual(a.win, 1234);
    assert.strictEqual(a.workspaceId, 'p-1');      // 딥링크
    // ★ wsName 은 넘기지 않는다 — composeSubtitle 이 subtitle 을 채우면 FCM 본문이 부제로 바뀌어
    //   잠금화면에서 요약문이 사라진다(불변식 5).
    assert.strictEqual(a.wsName, undefined);
    assert.strictEqual(_composeSubtitle(a.kind, a.wsName), null);
    assert.strictEqual(b.body, 'ENOENT');
    assert.strictEqual(b.cwd, null);
  } finally { notif.createNotification = orig; }
});

// ★ AskUserQuestion 은 질문이 여러 개일 수 있다. 예전 normalizeDecision 은 단수 `answer` 만 받아
//  첫 질문의 답만 데몬에 넘겼고, claude 는 나머지를 미답으로 두고 턴을 끝냈다(사용자 신고 증상).
test('승인 응답 — 복수 answers 를 그대로 싣고, 단수 answer 는 구 데몬 호환으로 남긴다', () => {
  const out = approvalService._normalizeDecision({
    decision: 'answer',
    answers: [
      { questionIndex: 0, labels: ['겨울 스포츠'] },
      { questionIndex: 1, labels: ['밤'] },
      { questionIndex: 2, labels: [], text: '즉흥파요' },
    ],
  });
  assert.strictEqual(out.answers.length, 3, '세 답이 모두 전달돼야 한다');
  assert.deepStrictEqual(out.answers[1], { questionIndex: 1, labels: ['밤'], text: null });
  assert.strictEqual(out.answers[2].text, '즉흥파요');
  assert.deepStrictEqual(out.answer, out.answers[0], '구 데몬은 단수만 읽는다');
  // 구 클라이언트(단수만 보냄)도 그대로 동작해야 한다.
  const one = approvalService._normalizeDecision({ decision: 'answer', answer: { questionIndex: 0, labels: ['Apple'] } });
  assert.strictEqual(one.answers.length, 1);
  assert.deepStrictEqual(one.answers[0].labels, ['Apple']);
  // 빈 답은 여전히 거부(오응답 방지).
  assert.throws(() => approvalService._normalizeDecision({ decision: 'answer', answers: [{ questionIndex: 0, labels: [] }] }), /BAD_ANSWER|labels/);
});

// ★ 원격 응답에는 마감이 없다(2026-07-28 확정). 그리고 **back TTL 은 데몬 마감보다 뒤**여야 한다 —
//  앞이면 데몬은 아직 기다리는데 back 이 먼저 만료시켜 카드만 사라진다(실사고). 이 순서가 계약이다.
test('승인 TTL — back 백스톱이 데몬 마감보다 뒤에 있다(카드가 먼저 사라지지 않는다)', () => {
  const daemonWaitMs = 24 * 3600 * 1000;   // runner-core approvals.budget().hardMs
  const backTtlMs = approvalService._config && approvalService._config.TTL_MS;
  assert.ok(backTtlMs > daemonWaitMs,
    `back TTL(${backTtlMs}) 이 데몬 마감(${daemonWaitMs}) 보다 앞이면 카드가 먼저 사라진다`);
});
