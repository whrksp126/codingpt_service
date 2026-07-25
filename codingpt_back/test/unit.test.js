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
  // 기능3 2단계(agent_state 수신·rseq 부여)는 아직 서버 코드가 없다 → 선언 금지.
  assert.ok(!SERVER_CAPS.includes('agentstate.v1'), 'agentstate.v1 은 서버 처리 코드가 들어간 뒤에 선언해야 한다');
  // 킬스위치 — 서버에서 기능을 끄면 능력도 회수돼 신버전 데몬의 교집합이 깨진다(= 기존 동작 폴백).
  assert.deepStrictEqual(computeServerCaps({ APPROVAL_ENABLED: '0', TRANSCRIPT_ENABLED: 'false' }), ['caps.v1']);
  assert.ok(computeServerCaps({}).includes('approval.v1')); // 미설정 = 켜짐
});

// ── 기능1 승인 인박스 ────────────────────────────────────────────────

test('approval normalizeCreate — id 형식 강제 · 캡 · 마감 클램프 · win 정수화', () => {
  const now = 1_753_440_000_000;
  assert.throws(() => approvalService._normalizeCreate({ id: 'nope' }, now), /id 형식/);
  assert.throws(() => approvalService._normalizeCreate({}, now), /id 형식/);
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
