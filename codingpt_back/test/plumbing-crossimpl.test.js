// 가운데 배관(갭1 agent_state / 갭2 봉투 RPC / 갭3 스트림 sid / 갭5 체크포인트 2단계)의
// **교차구현 계약** 테스트 — node --test. DB/소켓/objectstore 무접촉.
//
// 왜 이 파일이 따로 필요한가:
//  이 5개 갭은 양쪽 절반이 각자의 리포에 이미 커밋돼 있고 가운데만 없었다. 각 리포의 단위 테스트는
//  **자기 구현으로 만들어 자기 구현으로 검증**하므로 와이어가 갈라져도 양쪽 모두 초록이다(실제로
//  grant 서명 epoch 인코딩이 그렇게 갈라졌고 열쇠가 한 대도 배포되지 않았다 — e2ee-crossimpl.test.js).
//  그래서 여기서는 **상대(데몬)가 실제로 보내는 JSON 을 하드코딩**하고, 봉투는 데몬 모듈로 직접 만든다.
//
// 이 파일이 지키는 계약(깨지면 조용히 죽는다)
//  1. agent_state: 'ended' 가 'gone' 으로 안 바뀌면 claude 종료 후에도 Chat 토글이 영구히 켜진 채 남고
//     tab.cmd 폴백이 다시는 발동하지 않는다(에러 0건·로그 0건).
//  2. agent_state 에 내용성 필드(summary/promptId/pending)가 실리면 봉투 밖으로 내용이 새는 통로가 된다.
//  3. 봉투 RPC: 서버가 env 를 파싱·재작성·로깅하면 그 자체가 유출이다. 응답은 데몬 봉투를 **그대로**.
//  4. 스트림 sid: 협상 실패에 스트림을 죽이면(4xx/throw) 터미널이 아예 열리지 않는다 → 반드시 평문 폴백.
//  5. 체크포인트 commit: 서버가 발급하지 않은 checkpointId 를 받으면 매니페스트에 임의 키가 들어간다.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const relay = require('../services/daemonRelayService');
const daemonController = require('../controllers/daemonController');
const syncService = require('../services/syncService');
const { SERVER_CAPS } = require('../config/caps');

const DAEMON_ROOT = path.resolve(__dirname, '../../codingpt_daemon/packages/runner-core');

// 데몬 e2ee 모듈을 격리 HOME 으로 로드(프로세스/데몬 기동 없음 — 순수 함수만 쓴다).
function loadDaemonE2ee() {
  try {
    const os = require('os');
    const fs = require('fs');
    const runtime = require(path.join(DAEMON_ROOT, 'runtime.js'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-plumb-'));
    runtime.init({ root, stateDir: path.join(root, '.codingpt') });
    const e = require(path.join(DAEMON_ROOT, 'e2ee.js'));
    if (!e.hasKey || !e.hasKey()) e.bootstrapMasterKey({ label: 'test', platform: 'darwin', kind: 'pc' });
    return e;
  } catch (_) { return null; }
}

// ── 갭1: agent_state 팬아웃 ────────────────────────────────────────────

// 데몬 control.js 가 sendEvent(frame,'agentstate.v1') 로 보내는 프레임 그대로(계약 §1.3 ①).
const DAEMON_AGENT_STATE_FRAME = {
  type: 'agent_state',
  event: {
    cwd: 'other/project/codingpt',
    win: 1000123,
    state: 'working',
    agent: 'claude',
    version: 42,
    at: 1753432801000,
    sessionId: '21b28dc2-6d5e-4f1a-9b77-1f0c2a3b4c5d',
    source: 'hook',
    since: 1753432800000,
  },
};

// SSE 구독자 스텁(addEventClient 가 받는 res 모양) + WSS 구독자 스텁.
function sseStub() { const lines = []; return { write(l) { lines.push(l); }, lines, events: () => lines.map((l) => JSON.parse(l.replace(/^data: /, ''))) }; }
function wsStub() { const frames = []; return { readyState: 1, send(s) { frames.push(JSON.parse(s)); }, frames }; }
function fakeConn(deviceId, kind) { return { deviceId, kind: kind || 'local', ws: { send() {} }, rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0 }; }

test('agent_state — 데몬 프레임 그대로 넣으면 (cwd,win) 키 + hostDeviceId 스탬프로 팬아웃된다', () => {
  const userId = 990001;
  const sse = sseStub();
  const ws = wsStub();
  relay.addEventClient(userId, sse, 'mobile');
  relay._agentWsClients.set(String(userId), new Set([ws]));
  try {
    const ev = relay._normAgentState(DAEMON_AGENT_STATE_FRAME.event);
    assert.ok(ev, '데몬이 실제로 보내는 프레임이 검증을 통과해야 한다');
    relay.fanoutAgentState(userId, fakeConn(12), ev);

    // PC 수신기(ui-channel.js:194 → state.js:633)가 읽는 그 모양이어야 한다.
    const got = ws.frames[0];
    assert.strictEqual(got.type, 'agent_state');
    assert.deepStrictEqual(got.event, {
      cwd: 'other/project/codingpt',
      win: 1000123,
      state: 'working',
      agent: 'claude',
      version: 42,
      at: 1753432801000,
      sessionId: '21b28dc2-6d5e-4f1a-9b77-1f0c2a3b4c5d',
      source: 'hook',
      since: 1753432800000,
      hostDeviceId: 12,   // ★ back 이 스탬프(멀티 PC 에서 같은 cwdRel 충돌 방지)
      kind: 'local',
    });
    // SSE 폴백에도 같은 프레임이 간다(구 클라이언트/WSS 미접속 경로).
    assert.deepStrictEqual(sse.events()[0], got);
  } finally {
    relay.removeEventClient(userId, sse);
    relay._agentWsClients.delete(String(userId));
    relay._agentStateLast.delete(String(userId));
  }
});

test('agent_state — 내용성 필드는 절대 실리지 않는다(화이트리스트)', () => {
  // 데몬 publicView 에는 summary/promptId/pending/wsName 이 있다. 상태 프레임에 그것들이 섞여 오더라도
  //  클라이언트로 나가면 안 된다 — 상태 채널은 봉투 밖(평문)이라 그 자체가 유출 통로가 된다.
  const ev = relay._normAgentState({
    ...DAEMON_AGENT_STATE_FRAME.event,
    summary: 'rm -rf important.txt 를 실행하려 합니다',
    body: '파일 내용 …',
    promptId: 'p_1',
    pending: { tool: 'Bash', input: { command: 'rm -rf /' } },
    wsName: 'codingpt',
    backgroundTasks: 3,
  });
  assert.deepStrictEqual(Object.keys(ev).sort(), ['agent', 'at', 'cwd', 'sessionId', 'since', 'source', 'state', 'version', 'win']);
  for (const k of ['summary', 'body', 'promptId', 'pending', 'wsName', 'backgroundTasks']) {
    assert.strictEqual(ev[k], undefined, `${k} 이 상태 프레임에 실리면 안 된다`);
  }
});

test('agent_state — ended→gone / launching→idle 을 서버도 한 번 더 접는다(토글 영구 고착 방지)', () => {
  // 정본은 데몬 wireStateOf 지만, 어긋났을 때의 증상이 "claude 를 끝냈는데 Chat 토글이 영구히 켜진
  //  채로 남고 tab.cmd 폴백도 영구 비활성" 이라 서버에서도 접는다(PC pane.js:783 `st.state !== "gone"`).
  assert.strictEqual(relay._normAgentState({ ...DAEMON_AGENT_STATE_FRAME.event, state: 'ended' }).state, 'gone');
  assert.strictEqual(relay._normAgentState({ ...DAEMON_AGENT_STATE_FRAME.event, state: 'launching' }).state, 'idle');
  // 와이어 도메인 5종은 그대로 통과
  for (const s of ['idle', 'working', 'permission', 'needsInput', 'gone']) {
    assert.strictEqual(relay._normAgentState({ ...DAEMON_AGENT_STATE_FRAME.event, state: s }).state, s);
  }
  // 모르는 상태는 폐기(클라이언트가 해석 못 하는 값을 밀어 넣지 않는다)
  assert.strictEqual(relay._normAgentState({ ...DAEMON_AGENT_STATE_FRAME.event, state: 'busy' }), null);
});

test('agent_state — 필수 좌표(cwd/win/version)가 없으면 폐기한다', () => {
  const base = DAEMON_AGENT_STATE_FRAME.event;
  assert.strictEqual(relay._normAgentState({ ...base, cwd: undefined }), null);
  assert.strictEqual(relay._normAgentState({ ...base, win: undefined }), null);
  assert.strictEqual(relay._normAgentState({ ...base, win: -1 }), null);
  assert.strictEqual(relay._normAgentState({ ...base, version: undefined }), null);
  assert.strictEqual(relay._normAgentState(null), null);
  // cwd 빈 문자열(홈)은 정상 — 홈에서 띄운 claude 가 통째로 사라지면 안 된다.
  assert.strictEqual(relay._normAgentState({ ...base, cwd: '' }).cwd, '');
  // 문자열 정수도 수용(배관은 throw 하지 않는다)
  assert.strictEqual(relay._normAgentState({ ...base, win: '7', version: '3' }).win, 7);
  // at 이 없으면 서버 시각으로 채운다(클라 stale 판정이 0 으로 깨지지 않게)
  assert.ok(relay._normAgentState({ ...base, at: undefined }).at > 0);
});

test('agent_state — 라스트-스테이트: 재접속 리플레이 / gone 삭제 / 호스트 오프라인 폐기', () => {
  const userId = 990002;
  try {
    const ev = relay._normAgentState(DAEMON_AGENT_STATE_FRAME.event);
    relay.fanoutAgentState(userId, fakeConn(12), ev);
    relay.fanoutAgentState(userId, fakeConn(13), { ...ev, win: 5, state: 'permission' });

    // 새로 붙은 화면(ui_hello)에는 마지막 상태만 재전송한다 — push 0건이면 클라가 5~9초 폴백으로 판정.
    const ws = wsStub();
    relay._replayAgentStates(userId, ws);
    assert.strictEqual(ws.frames.length, 2);
    assert.ok(ws.frames.every((f) => f.type === 'agent_state' && f.replay === true));
    assert.deepStrictEqual(ws.frames.map((f) => f.event.hostDeviceId).sort(), [12, 13]);

    // gone 은 보관하지 않고 키를 지운다(PC 도 같은 규칙 — state.js:633-644).
    relay.fanoutAgentState(userId, fakeConn(12), { ...ev, state: 'gone' });
    const ws2 = wsStub();
    relay._replayAgentStates(userId, ws2);
    assert.deepStrictEqual(ws2.frames.map((f) => f.event.hostDeviceId), [13]);

    // 호스트 연결이 끊기면 그 호스트 상태 전부 폐기 — 오프라인 PC 의 'working' 을 리플레이하면
    //  폰이 "아직 돌고 있음"으로 오판하고 폴백이 영구 비활성된다.
    relay._forgetAgentStatesOf(userId, 13);
    const ws3 = wsStub();
    relay._replayAgentStates(userId, ws3);
    assert.strictEqual(ws3.frames.length, 0);
  } finally { relay._agentStateLast.delete(String(userId)); }
});

test('agent_state — 제어 WS 분기가 실제로 존재한다(팬아웃 함수만 있고 배선이 없으면 무발현)', () => {
  // caps 에 agentstate.v1 을 선언했는데 프레임을 받는 자리가 없으면 데몬은 보내고 서버는 버린다
  //  = "5~9초 폴백이 그대로인데 구현 완료로 보임". 순수 함수 테스트로는 절대 잡히지 않으므로
  //  ws.on('message') 체인에 분기가 있는지 소스로 고정한다.
  const src = require('fs').readFileSync(path.resolve(__dirname, '../services/daemonRelayService.js'), 'utf8');
  assert.match(src, /msg\.type === 'agent_state'/, "제어 WS 메시지 체인에 agent_state 분기가 없다");
  const branch = src.slice(src.indexOf("msg.type === 'agent_state'"), src.indexOf("msg.type === 'sync_event'"));
  assert.match(branch, /normAgentState/);
  assert.match(branch, /fanoutAgentState/);
  assert.ok(!/pushAgentEvent/.test(branch), '상태 프레임을 리플레이 버퍼에 넣으면 알림 항목을 축출한다');
  assert.ok(SERVER_CAPS.includes('agentstate.v1'));
});

// ── 갭2: 봉투 RPC 프록시 ───────────────────────────────────────────────

function fakeRes() {
  const out = { code: 200, body: null };
  return { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; }, _out: out };
}
// console 캡처 — 봉투 평문/암호문이 로그로 새는지 감시.
function captureLogs(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const seen = [];
  const grab = (...a) => { seen.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.log = grab; console.warn = grab; console.error = grab;
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; })
    .then((r) => ({ result: r, logs: seen.join('\n') }));
}

test('봉투 RPC — 데몬이 만든 실제 봉투가 형식 게이트를 통과한다(하드코딩 형태와 일치)', (t) => {
  const dm = loadDaemonE2ee();
  if (!dm) return t.skip('데몬 모듈 없음(단일 리포 CI)');
  const env = dm.sealRpc('fs.read', { path: 'a.ts' }, { epoch: 1, hostDeviceId: 0 });
  assert.deepStrictEqual(Object.keys(env).sort(), ['ct', 'epoch', 'nonce', 'suite', 'v']);
  assert.strictEqual(daemonController._isSealedEnvelope(env), true, '데몬 sealEnvelope 출력이 거절되면 봉투 RPC 전체가 죽는다');
  // nonce = [부팅난수 8B][카운터 u32 4B] = 12B → b64u 16자
  assert.strictEqual(Buffer.from(env.nonce, 'base64url').length, 12);
  // 형식 게이트 반증 — 봉투가 아닌 것은 400 으로 걸러야 한다(서버는 내용을 못 보므로 형식이 유일한 검문)
  assert.strictEqual(daemonController._isSealedEnvelope({ ...env, v: 2 }), false);
  assert.strictEqual(daemonController._isSealedEnvelope({ ...env, ct: 'not+base64url/' }), false);
  assert.strictEqual(daemonController._isSealedEnvelope({ ...env, epoch: 0 }), false);
  assert.strictEqual(daemonController._isSealedEnvelope(null), false);
});

test('봉투 RPC — 서버는 봉투를 열지 않고 그대로 중계하고, 평문/암호문을 로그에 남기지 않는다', async (t) => {
  const dm = loadDaemonE2ee();
  if (!dm) return t.skip('데몬 모듈 없음');
  const reqEnv = dm.sealRpc('fs.write', { path: 'secret.ts', content: 'API_KEY=abc' }, { epoch: 1, hostDeviceId: 12 });
  const respEnv = dm.sealRpcResult({ ok: true, bytes: 11 }, { epoch: 1, hostDeviceId: 12 });

  const origRpc = relay.callRpc;
  const calls = [];
  relay.callRpc = async (userId, method, params, timeoutMs, opts) => { calls.push({ userId, method, params, timeoutMs, opts }); return { env: respEnv }; };
  try {
    const res = fakeRes();
    const { logs } = await captureLogs(() => daemonController.rpcSealed(
      { user: { id: 7 }, body: { hostDeviceId: 12, timeoutMs: 999999, env: reqEnv } }, res));

    // ① 데몬에 가는 프레임 — method='sealed', env 는 **바이트 동일**, hostDeviceId 는 평문 형제 필드.
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'sealed');
    assert.deepStrictEqual(calls[0].params, { env: reqEnv, hostDeviceId: 12 });
    assert.strictEqual(calls[0].params.env.ct, reqEnv.ct, 'ct 가 재작성되면 복호가 100% 실패한다');
    assert.strictEqual(calls[0].timeoutMs, 60000, 'timeoutMs 는 60s 로 클램프');
    // ② 응답 — 데몬 봉투 그대로(successResponse 는 data 를 최상위로 펼친다).
    assert.strictEqual(res._out.code, 200);
    assert.deepStrictEqual(res._out.body, { env: respEnv });
    // ③ 로그 — ct/nonce 어느 조각도 남지 않아야 한다(로그가 곧 평문 저장소가 되는 유일한 경로).
    assert.ok(!logs.includes(reqEnv.ct.slice(0, 24)), '요청 봉투 ct 가 로그에 남았다');
    assert.ok(!logs.includes(respEnv.ct.slice(0, 24)), '응답 봉투 ct 가 로그에 남았다');
    assert.ok(!logs.includes(reqEnv.nonce), 'nonce 가 로그에 남았다');
    assert.ok(!logs.includes('secret.ts'), '봉투 안의 경로가 로그에 나오면 서버가 봉투를 연 것이다');

    // ④ hostDeviceId 미지정 = 필드 자체를 싣지 않는다(양쪽이 AAD u32(0) 으로 맞춘다).
    //   여기서 서버가 활성 러너 id 를 임의로 채우면 앱이 봉인한 AAD(0)와 갈라져 전 봉투가 복호 실패한다.
    calls.length = 0;
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env: reqEnv } }, fakeRes());
    assert.deepStrictEqual(calls[0].params, { env: reqEnv });
    assert.strictEqual(calls[0].timeoutMs, 15000);
  } finally { relay.callRpc = origRpc; }
});

test('봉투 RPC — 오류 코드 매핑(클라는 detail.code 로만 분기한다)', async () => {
  const env = { v: 1, suite: 'cpt-e2ee/v1', epoch: 2, nonce: 'CUrriT9CgNkAAAAB', ct: 'D1lINqe3h8O7mVvg8qXBF1kq' };
  const origRpc = relay.callRpc;
  const throwWith = (err) => { relay.callRpc = async () => { throw err; }; };
  try {
    // 형식 오류 = 400 BAD_ENVELOPE (데몬 왕복 0회)
    let res = fakeRes();
    relay.callRpc = async () => { throw new Error('여기까지 오면 안 된다'); };
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env: { v: 1 } } }, res);
    assert.strictEqual(res._out.code, 400);
    assert.strictEqual(res._out.body.detail.code, 'BAD_ENVELOPE');

    // 데몬 오프라인 = 409 DAEMON_OFFLINE(모바일이 이 문구/코드로 오프라인 UX 를 켠다)
    throwWith(new Error('DAEMON_OFFLINE'));
    res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
    assert.strictEqual(res._out.code, 409);
    assert.strictEqual(res._out.body.detail.code, 'DAEMON_OFFLINE');

    // 구 데몬/E2EE OFF = 501 → 앱이 10분 UNSUPPORTED 캐시 후 평문 REST 폴백(정상 동작)
    for (const code of ['E2EE_UNSUPPORTED', 'E2EE_DISABLED']) {
      throwWith(Object.assign(new Error('x'), { code }));
      res = fakeRes();
      await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
      assert.strictEqual(res._out.code, 501, `${code} → 501`);
      assert.strictEqual(res._out.body.detail.code, code);
    }
    // code 없는 실패(구 데몬이 method 'sealed' 를 몰라 throw / RPC 타임아웃)도 같은 바구니
    throwWith(new Error('알 수 없는 method: sealed'));
    res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
    assert.strictEqual(res._out.code, 501);
    assert.strictEqual(res._out.body.detail.code, 'E2EE_UNSUPPORTED');

    // 그 외 데몬 오류는 502 + 코드 보존(진단 가능해야 한다)
    throwWith(Object.assign(new Error('봉투를 열 수 없습니다'), { code: 'E2EE_OPEN_FAILED' }));
    res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
    assert.strictEqual(res._out.code, 502);
    assert.strictEqual(res._out.body.detail.code, 'E2EE_OPEN_FAILED');

    // 데몬이 봉투 없이 성공했다고 하면 평문으로 흘리지 않고 502(빈 성공 = PC 이중 실행의 씨앗)
    relay.callRpc = async () => ({ ok: true });
    res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
    assert.strictEqual(res._out.code, 502);
    assert.strictEqual(res._out.body.detail.code, 'E2EE_NO_ENVELOPE');
  } finally { relay.callRpc = origRpc; }
});

// ── 갭2 후속(이 라운드): 코드 매핑 정직화 · 스위치 실회수 · epoch 선대조 · 로그 불변식 ────────
//
// 왜 추가하나: 앱의 폴백 규칙이 규칙 기반(비-200 = 전부 폴백)이 되면서 **상태 코드는 폴백 여부를 더 이상
//  지배하지 않는다**. 대신 상태 코드가 지배하는 것은 앱의 "미지원 10분 네거티브 캐시"다. 그래서
//   · 구조적 미지원(열쇠 0개 등)을 502 로 올리면 → "일시 장애"로 오인 + 진단 불가(실증된 결함),
//   · 계약 위반(세대 회전 등)을 5xx 로 올리면 → 정상 기기가 회전 직후 **10분간 평문**으로 떨어진다.
//  이 두 가지를 코드로 못 박는다. 매핑 정본 = config/e2eeCodes.js.
const e2eeCodes = require('../config/e2eeCodes');
const APP_ROOT = path.resolve(__dirname, '../../../codingpt_app');

// 러너 conn 주입(hello 광고 epoch 포함) — hostE2eeEpoch 가 읽는 그 자리.
function withEpochRunner(userId, deviceId, e2eeEpoch, fn) {
  const conn = {
    deviceId, kind: 'local', e2eeEpoch,
    rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0, ws: { send() {} },
  };
  relay._connections.set(String(userId), { runners: new Map([[deviceId, conn]]), activeRunnerId: deviceId });
  return Promise.resolve().then(() => fn(conn)).finally(() => relay._connections.delete(String(userId)));
}

test('봉투 RPC 코드 매핑 — 데몬이 실제로 던지는 E2EE_* 코드가 표에서 하나도 빠지지 않는다', (t) => {
  const fs = require('fs');
  const p = path.join(DAEMON_ROOT, 'control.js');
  if (!fs.existsSync(p)) return t.skip('데몬 리포 없음(단일 리포 CI)');
  const src = fs.readFileSync(p, 'utf8');
  const codes = [...new Set([...src.matchAll(/codedError\('(E2EE_[A-Z_]+)'/g)].map((m) => m[1]))];
  assert.ok(codes.length >= 6, `데몬 코드 스캔 실패(${codes.length}개) — 정규식이 낡았다`);
  for (const c of codes) {
    // 표에 없으면 "모르는 코드" 기본값 502 로 나간다 = 구조적 미지원이 "일시 장애"로 위장되는 그 사고.
    assert.ok(e2eeCodes.SEALED_STATUS[c], `${c} 이 config/e2eeCodes.js 표에 없다`);
  }
  // 이 라운드가 닫는 결함: '열쇠 없음'은 재시도로 낫지 않는 **구조적 미지원**이다.
  assert.strictEqual(e2eeCodes.SEALED_STATUS.E2EE_NO_KEY, 501);
  assert.strictEqual(e2eeCodes.SEALED_STATUS.E2EE_DISABLED, 501);
  assert.strictEqual(e2eeCodes.SEALED_STATUS.E2EE_UNSUPPORTED, 501);
});

test('봉투 RPC 코드 매핑 — 구조적 미지원=501 / 계약 위반=409(5xx 금지) / 처리 실패=502', async () => {
  const env = { v: 1, suite: 'cpt-e2ee/v1', epoch: 2, nonce: 'CUrriT9CgNkAAAAB', ct: 'D1lINqe3h8O7mVvg8qXBF1kq' };
  const origRpc = relay.callRpc;
  const call = async (code) => {
    relay.callRpc = async () => { throw Object.assign(new Error('데몬 실패'), { code }); };
    const res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
    return res._out;
  };
  try {
    for (const code of e2eeCodes.SEALED_STRUCTURAL) {
      const out = await call(code);
      assert.strictEqual(out.code, 501, `${code} → 501(구조적 미지원 = 조용한 평문 폴백 + 캐시가 옳은 처방)`);
      assert.strictEqual(out.body.detail.code, code, '코드는 반드시 보존(클라는 code 로만 분기)');
    }
    for (const code of e2eeCodes.SEALED_CONTRACT) {
      const out = await call(code);
      assert.strictEqual(out.code, 409, `${code} → 409`);
      assert.strictEqual(out.body.detail.code, code);
      // ★ 5xx 금지 근거: 앱 sealedRpc 가 status>=500 을 10분 미지원 캐시로 승격한다 → 회전/재전송
      //   같은 "상태만 바뀌면 낫는" 실패에서 정상 기기가 10분 평문이 된다(보안 조작 직후에 암호화가
      //   꺼지는, 방향이 거꾸로인 동작). 4xx 는 캐시를 켜지 않아 다음 요청이 바로 다시 봉인된다.
      assert.ok(out.code < 500, `${code} 를 5xx 로 올리면 회전 직후 10분 평문이 된다`);
      assert.ok(out.code !== 501, `${code} 는 구조적 미지원이 아니다(상태가 바뀌면 낫는다)`);
    }
    for (const code of e2eeCodes.SEALED_HANDLING) {
      const out = await call(code);
      assert.strictEqual(out.code, 502, `${code} → 502`);
    }
    // 표에 없는 신설 코드 = 데몬이 뭔가 시도하다 실패한 것으로 보고 502(코드 보존해 진단 가능하게).
    const unknown = await call('E2EE_SOMETHING_NEW');
    assert.strictEqual(unknown.code, 502);
    assert.strictEqual(unknown.body.detail.code, 'E2EE_SOMETHING_NEW');
  } finally { relay.callRpc = origRpc; }
});

test('봉투 RPC 코드 매핑 — 앱 폴백 규칙(mayFallbackFor)과 맞물린다', (t) => {
  const fs = require('fs');
  const statePath = path.join(APP_ROOT, 'src/services/e2ee/e2eeState.ts');
  const rpcPath = path.join(APP_ROOT, 'src/services/e2ee.ts');
  if (!fs.existsSync(statePath) || !fs.existsSync(rpcPath)) return t.skip('앱 리포 없음');
  const state = fs.readFileSync(statePath, 'utf8');
  // ① 앱 규칙은 **규칙 기반**이다: 200 만 예외고 그 밖의 모든 상태가 폴백 대상 → 서버가 어떤 상태를
  //   주더라도 화면이 죽지 않는다(그래서 우리는 상태 코드를 "진단 정직성" 기준으로 고를 수 있다).
  assert.match(state, /if \(status === 200\) return code === 'DECRYPT_FAILED';/);
  assert.match(state, /return true; \/\/ 404·501·4xx·5xx/);
  // ② 그러나 네거티브 캐시는 상태 코드가 지배한다 — 이게 계약 위반 코드를 4xx 로 내리는 근거다.
  const rpc = fs.readFileSync(rpcPath, 'utf8');
  assert.match(rpc, /r\.status === 404 \|\| r\.status === 501/, '501 = 미지원 캐시 진입점(앱)');
  // 조건은 감싸는 가드가 붙을 수 있다(예: 세대 불일치는 캐시 제외) → 괄호 개수에 얽매이지 않는다.
  //  고정하는 것은 "5xx 는 캐시 대상" 이라는 사실뿐. 아래 ③ 이 그 예외를 따로 못 박는다.
  assert.match(rpc, /r\.status >= 500\)+ noteRpcUnsupported\(\);/, '5xx 도 10분 캐시된다(앱)');
  // ③ 단, E2EE_EPOCH_MISMATCH 는 **캐시에 넣지 않는다** — 회전 직후의 뒤처짐은 갱신하면 낫는 상태인데
  //   10분 UNSUPPORTED 로 굳히면 그동안 전부 평문이면서 배지는 '암호화됨' 이 된다(거짓 자물쇠).
  assert.match(rpc, /E2EE_EPOCH_MISMATCH/, '세대 불일치를 구분하지 않으면 회전 직후 10분간 거짓 자물쇠다');
});

test('E2EE_ENABLED=0 회수 — /rpc 는 라우트가 살아 있어도 501 로 답하고 데몬 왕복이 0 이다', async () => {
  // 실증된 결함: 스위치가 caps 선언만 회수하고 라우트·중계는 살아 있어 **이미 열쇠를 가진** 클라가
  //  계속 봉투를 왕복했다(caps 는 hello 1회 협상이라 그 뒤 붙은 클라를 막지 못한다).
  const env = { v: 1, suite: 'cpt-e2ee/v1', epoch: 2, nonce: 'CUrriT9CgNkAAAAB', ct: 'D1lINqe3h8O7mVvg8qXBF1kq' };
  const idx = SERVER_CAPS.indexOf('e2ee.rpc.v1');
  assert.ok(idx >= 0, '이 커밋의 서버는 e2ee.rpc.v1 을 선언한다');
  const origRpc = relay.callRpc;
  let calls = 0;
  relay.callRpc = async () => { calls += 1; throw new Error('여기까지 오면 스위치가 회수되지 않은 것'); };
  SERVER_CAPS.splice(idx, 1); // E2EE_ENABLED=0 재현(같은 배열 인스턴스를 컨트롤러가 참조한다)
  try {
    const res = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { hostDeviceId: 12, env } }, res);
    assert.strictEqual(res._out.code, 501, '501 = 구조적 미지원 → 앱이 평문으로 내려가고 10분 캐시');
    assert.strictEqual(res._out.body.detail.code, 'E2EE_DISABLED');
    assert.strictEqual(calls, 0, '스위치가 꺼졌는데 봉투가 데몬까지 갔다');
    // 형식이 틀린 봉투여도 스위치 게이트가 먼저다(꺼진 서버가 400 을 주면 "형식만 고치면 된다"는 오해).
    const res2 = fakeRes();
    await daemonController.rpcSealed({ user: { id: 7 }, body: { env: { v: 1 } } }, res2);
    assert.strictEqual(res2._out.body.detail.code, 'E2EE_DISABLED');
  } finally {
    SERVER_CAPS.splice(idx, 0, 'e2ee.rpc.v1');
    relay.callRpc = origRpc;
  }
  // 회수 방식 = **핸들러 내부 게이트**(라우트 조건부 등록 금지). 근거는 config/caps.js·컨트롤러 주석:
  //  조건부 등록은 공용 404(detail.code 없음)가 되어 "스위치로 껐다"와 "구 back"을 구분할 수 없다.
  const routesSrc = require('fs').readFileSync(path.resolve(__dirname, '../routes/daemonRoutes.js'), 'utf8');
  assert.match(routesSrc, /router\.post\('\/rpc', accountAuth, daemonController\.rpcSealed\)/);
  assert.ok(!/process\.env/.test(routesSrc), '라우트 표에 env 분기를 넣으면 관습(핸들러 게이트)과 갈라진다');
});

test('epoch 선대조 — 명백히 낡은 세대만 왕복 전에 거절하고, 판정 정본은 데몬으로 남긴다', async () => {
  const userId = 990020;
  const envAt = (epoch) => ({ v: 1, suite: 'cpt-e2ee/v1', epoch, nonce: 'CUrriT9CgNkAAAAB', ct: 'D1lINqe3h8O7mVvg8qXBF1kq' });
  const origRpc = relay.callRpc;
  const run = async (env, body) => {
    const res = fakeRes();
    await daemonController.rpcSealed({ user: { id: userId }, body: { ...(body || {}), env } }, res);
    return res._out;
  };
  try {
    let calls = 0;
    relay.callRpc = async () => { calls += 1; return { env: envAt(3) }; };
    await withEpochRunner(userId, 12, 3, async () => {
      // ① 뒤처진 세대 = 데몬도 100% 같은 판정(control.js handleSealedRpc) → 왕복 절감 + 이유 있는 로그.
      const { logs, result } = await captureLogs(() => run(envAt(2), { hostDeviceId: 12 }));
      assert.strictEqual(result.code, 409);
      assert.strictEqual(result.body.detail.code, 'E2EE_EPOCH_MISMATCH');
      assert.strictEqual(calls, 0, '낡은 봉투가 데몬까지 갔다(왕복 절감 실패)');
      assert.match(logs, /낡은 세대 봉투 거절/, '거절 이유가 로그에 없으면 진단이 "왜인지 모를 4xx" 가 된다');
      assert.ok(!logs.includes('D1lINqe3h8O7mVvg8qXBF1kq') && !logs.includes('CUrriT9CgNkAAAAB'),
        '진단 로그에 ct/nonce 가 섞이면 로그가 곧 유출 경로다');

      // ② 같은 세대 = 통과(당연)
      assert.strictEqual((await run(envAt(3), { hostDeviceId: 12 })).code, 200);
      assert.strictEqual(calls, 1);

      // ③ ★ 클라가 앞선 경우는 통과시킨다 — hello 는 연결 시 1회뿐이라(daemon control.js:368) 데몬이
      //   연결 중 회전하면 conn.e2eeEpoch 가 뒤처진다. 여기서 막으면 서버가 스스로 암호화를 끈다.
      assert.strictEqual((await run(envAt(4), { hostDeviceId: 12 })).code, 200);
      assert.strictEqual(calls, 2, '앞선 세대를 서버가 삼켰다(데몬 정본 원칙 위반)');
    });
    // ④ 광고 epoch 0(열쇠 없음/구 데몬) = 판정 근거 없음 → 통과시키고 **데몬의 정직한 코드**로 답한다.
    await withEpochRunner(userId, 12, 0, async () => {
      relay.callRpc = async () => { throw Object.assign(new Error('열쇠 없음'), { code: 'E2EE_NO_KEY' }); };
      const out = await run(envAt(2), { hostDeviceId: 12 });
      assert.strictEqual(out.code, 501, '열쇠 0개는 501(구조적 미지원) — 502 "일시 장애" 오인이 이 라운드의 결함');
      assert.strictEqual(out.body.detail.code, 'E2EE_NO_KEY');
    });
    // ⑤ 대상 미연결이면 선대조가 아니라 기존 409 DAEMON_OFFLINE 경로(오프라인 UX 가 이 코드를 본다).
    relay.callRpc = async () => { throw new Error('DAEMON_OFFLINE'); };
    const off = await run(envAt(2), { hostDeviceId: 12 });
    assert.strictEqual(off.code, 409);
    assert.strictEqual(off.body.detail.code, 'DAEMON_OFFLINE');
  } finally { relay.callRpc = origRpc; }
});

test('봉투 프록시 불변식 — 스위치/거절 경로의 응답 본문·로그에 봉투 조각이 없다', async () => {
  const dm = loadDaemonE2ee();
  const env = dm
    ? dm.sealRpc('fs.read', { path: 'secret/keys.env' }, { epoch: 1, hostDeviceId: 0 })
    : { v: 1, suite: 'cpt-e2ee/v1', epoch: 1, nonce: 'CUrriT9CgNkAAAAB', ct: 'D1lINqe3h8O7mVvg8qXBF1kq' };
  const origRpc = relay.callRpc;
  const bodies = [];
  const idx = SERVER_CAPS.indexOf('e2ee.rpc.v1');
  try {
    // 오류 4경로(400/409/501/502)를 전부 지나가며 본문을 모은다 — errorResponse 가 요청 본문을 그대로
    //  되돌려주는 실수(디버깅 편의로 자주 생긴다)를 여기서 잡는다.
    relay.callRpc = async () => { throw Object.assign(new Error('데몬 실패'), { code: 'E2EE_OPEN_FAILED' }); };
    let res = fakeRes();
    const { logs } = await captureLogs(async () => {
      await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
      bodies.push(res._out.body);
      relay.callRpc = async () => { throw new Error('DAEMON_OFFLINE'); };
      res = fakeRes();
      await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
      bodies.push(res._out.body);
      res = fakeRes();
      await daemonController.rpcSealed({ user: { id: 7 }, body: { env: { ...env, ct: 'not+valid/' } } }, res);
      bodies.push(res._out.body);
      SERVER_CAPS.splice(idx, 1);
      res = fakeRes();
      await daemonController.rpcSealed({ user: { id: 7 }, body: { env } }, res);
      bodies.push(res._out.body);
      SERVER_CAPS.splice(idx, 0, 'e2ee.rpc.v1');
    });
    const dump = JSON.stringify(bodies) + '\n' + logs;
    assert.ok(!dump.includes(env.ct), '오류 응답/로그에 봉투 ct 가 섞였다');
    assert.ok(!dump.includes(env.nonce), '오류 응답/로그에 nonce 가 섞였다');
    if (dm) assert.ok(!dump.includes('secret/keys.env'), '평문 경로가 나왔다 = 서버가 봉투를 열었다');
    // access log(middlewares/logger.js)도 같은 불변식 — 본문을 찍지 않는다(메서드/URL/상태/소요만).
    const logger = require('../middlewares/logger');
    const handlers = {};
    const fakeReq = { method: 'POST', originalUrl: '/api/daemon/rpc', body: { env } };
    const fakeRes2 = { statusCode: 200, on(ev, fn) { handlers[ev] = fn; } };
    const { logs: accessLogs } = await captureLogs(() => {
      logger(fakeReq, fakeRes2, () => {});
      handlers.finish();
    });
    assert.match(accessLogs, /POST \/api\/daemon\/rpc 200/);
    assert.ok(!accessLogs.includes(env.ct) && !accessLogs.includes(env.nonce), 'access log 에 봉투가 남았다');
    // 핸들러 소스에 개봉 시도가 없어야 한다(계약 §2.7 불변식 — "JSON.parse(...ct) 류가 등장하면 위반").
    const ctrl = require('fs').readFileSync(path.resolve(__dirname, '../controllers/daemonController.js'), 'utf8');
    const fn = ctrl.slice(ctrl.indexOf('async function rpcSealed'), ctrl.indexOf('// ── 봉인 스트림 선협상'));
    assert.ok(!/\.ct/.test(fn), 'rpcSealed 가 ct 를 읽는다');
    assert.ok(!/JSON\.parse|Buffer\.from|decipher/i.test(fn), 'rpcSealed 가 봉투를 열려 한다');
  } finally {
    relay.callRpc = origRpc;
    if (!SERVER_CAPS.includes('e2ee.rpc.v1')) SERVER_CAPS.splice(idx, 0, 'e2ee.rpc.v1');
  }
});

// ── 갭3: 스트림 sid 선협상 ─────────────────────────────────────────────

const VIEWER_OFFER = { suite: 'cpt-e2ee/v1', epoch: 2, pub: 'x'.repeat(43), nonce: 'y'.repeat(43) };
// 데몬 beginHost() 가 돌려주는 것 그대로(계약 §3.3 ③).
const HOST_ANSWER = {
  sid: 'c2lkc2lkc2lkc2lkc2lkc2lkc2lkc2lkc2lkc2lk',
  pub: 'p'.repeat(43), nonce: 'n'.repeat(43), confirm: 'c'.repeat(43),
  epoch: 2, suite: 'cpt-e2ee/v1', expiresAt: '2026-07-26T00:00:00.000Z',
};

// conn 을 주입하고 e2ee.begin RPC 를 손으로 응답해 주는 하네스(실제 callRpc 프레임을 검사한다).
function withRunner(userId, deviceId, fn) {
  const sent = [];
  const conn = {
    deviceId, kind: 'local', rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0,
    ws: { send(s) { sent.push(JSON.parse(s)); } },
  };
  relay._connections.set(String(userId), { runners: new Map([[deviceId, conn]]), activeRunnerId: deviceId });
  const reply = (result, err) => {
    const [p] = [...conn.pendingRpc.values()];
    assert.ok(p, 'e2ee.begin RPC 가 나가지 않았다');
    conn.pendingRpc.clear();
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(result);
  };
  return Promise.resolve()
    .then(() => fn({ conn, sent, reply }))
    .finally(() => relay._connections.delete(String(userId)));
}

test('스트림 sid — begin 프레임은 토큰에 저장된 좌표와 동일해야 한다(트랜스크립트 = confirm 검증)', async () => {
  const userId = 990010;
  await withRunner(userId, 12, async ({ sent, reply }) => {
    const token = relay.issueTerminalToken(userId, 'proj/a', 'p1', 3, 'clientKeyA', 12);
    const p = relay.negotiateStreamE2ee(userId, {
      token, purpose: 'pty', offer: VIEWER_OFFER,
      routing: { cwd: 'proj/a', paneId: 'p1', win: 3 }, client: 'clientKeyA',
      hostDeviceId: 12, opts: { runnerId: 12 },
    });
    await new Promise((r) => setImmediate(r));
    // 데몬이 받는 프레임(control.js:425 e2ee.begin → e2ee.js:684 beginHost)
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'rpc');
    assert.strictEqual(sent[0].method, 'e2ee.begin');
    assert.deepStrictEqual(sent[0].params, {
      purpose: 'pty', transport: 'relay', suite: 'cpt-e2ee/v1', epoch: 2,
      pub: VIEWER_OFFER.pub, nonce: VIEWER_OFFER.nonce,
      client: 'clientKeyA', hostDeviceId: 12,
      routing: { cwd: 'proj/a', paneId: 'p1', win: 3 },
    });
    reply(HOST_ANSWER);
    const out = await p;
    // 클라에 돌려주는 답변 — sid/pub/nonce/confirm/epoch/suite + hostDeviceId 에코.
    assert.deepStrictEqual(out, {
      e2ee: {
        sid: HOST_ANSWER.sid, pub: HOST_ANSWER.pub, nonce: HOST_ANSWER.nonce, confirm: HOST_ANSWER.confirm,
        epoch: 2, suite: 'cpt-e2ee/v1', hostDeviceId: 12,
      },
    });
    // 토큰에 sid 가 붙고, 스트림 오픈 params 에 실제로 실린다(데몬 pty.js:357 이 읽는 자리).
    const sess = relay._termTokens.get(token);
    assert.deepStrictEqual(sess.e2ee, { sid: HOST_ANSWER.sid });
    assert.deepStrictEqual(relay._ptyStreamParams(sess), {
      cols: 80, rows: 24, cwd: 'proj/a', paneId: 'p1', win: 3, client: 'clientKeyA', sid: HOST_ANSWER.sid,
    });
    relay._termTokens.delete(token);
  });
});

test('스트림 sid — hostDeviceId 미지정이면 서버가 고른 러너 id 를 쓰고 응답에 에코한다', async () => {
  const userId = 990011;
  await withRunner(userId, 31, async ({ sent, reply }) => {
    const token = relay.issueTerminalToken(userId, '', '', null, 'ck', null);
    const p = relay.negotiateStreamE2ee(userId, { token, purpose: 'pty', offer: VIEWER_OFFER, routing: { cwd: '', paneId: '', win: null }, client: 'ck' });
    await new Promise((r) => setImmediate(r));
    // 데몬 beginHost 는 selfDeviceId 로 트랜스크립트를 만든다 → 서버가 실 러너 id 를 보내야 일치한다.
    assert.strictEqual(sent[0].params.hostDeviceId, 31);
    reply(HOST_ANSWER);
    const out = await p;
    // ★ 에코가 없으면 뷰어는 ''(미지정)으로 트랜스크립트를 만들어 confirm 이 100% 불일치한다.
    assert.strictEqual(out.e2ee.hostDeviceId, 31);
    relay._termTokens.delete(token);
  });
});

test('스트림 sid — 협상 실패는 전부 평문 폴백(토큰은 살아 있고 sid 는 안 붙는다)', async () => {
  const userId = 990012;
  await withRunner(userId, 12, async ({ sent, reply }) => {
    // ① 오퍼 형식 오류 = begin 왕복 0회
    const t1 = relay.issueTerminalToken(userId, 'a', 'p', 1, 'c', 12);
    assert.deepStrictEqual(await relay.negotiateStreamE2ee(userId, { token: t1, purpose: 'pty', offer: { suite: 'cpt-e2ee/v1' } }),
      { e2ee: false, e2eeReason: 'E2EE_BAD_OFFER' });
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(relay._termTokens.get(t1).e2ee, undefined);

    // ② 데몬이 스코프 미달로 거절(control.js:193 E2EE_SCOPE) → 평문 폴백, 스트림은 정상 개설
    const p = relay.negotiateStreamE2ee(userId, { token: t1, purpose: 'pty', offer: VIEWER_OFFER, routing: {}, client: 'c', hostDeviceId: 12 });
    await new Promise((r) => setImmediate(r));
    reply(null, Object.assign(new Error('스트림 암호화가 꺼져 있습니다'), { code: 'E2EE_SCOPE' }));
    assert.deepStrictEqual(await p, { e2ee: false, e2eeReason: 'E2EE_SCOPE' });
    assert.strictEqual(relay._termTokens.get(t1).e2ee, undefined, 'sid 가 붙으면 호스트가 봉인 프레임을 요구해 4090 으로 닫힌다');
    assert.deepStrictEqual(relay._ptyStreamParams(relay._termTokens.get(t1)).sid, undefined);

    // ③ 구 데몬(코드 없는 throw) → 진단용 코드로 폴백
    const p2 = relay.negotiateStreamE2ee(userId, { token: t1, purpose: 'pty', offer: VIEWER_OFFER, routing: {}, client: 'c', hostDeviceId: 12 });
    await new Promise((r) => setImmediate(r));
    reply(null, new Error('알 수 없는 method: e2ee.begin'));
    assert.deepStrictEqual(await p2, { e2ee: false, e2eeReason: 'E2EE_BEGIN_FAILED' });
    relay._termTokens.delete(t1);
  });
});

test('스트림 sid — 서버 caps 에서 e2ee.stream.v1 을 회수하면 begin 을 시도조차 하지 않는다', async () => {
  const userId = 990013;
  const idx = SERVER_CAPS.indexOf('e2ee.stream.v1');
  assert.ok(idx >= 0);
  SERVER_CAPS.splice(idx, 1); // 킬스위치 상황 재현(같은 배열 인스턴스를 서비스가 참조한다)
  try {
    await withRunner(userId, 12, async ({ sent }) => {
      const t = relay.issueTerminalToken(userId, 'a', 'p', 1, 'c', 12);
      assert.deepStrictEqual(await relay.negotiateStreamE2ee(userId, { token: t, purpose: 'pty', offer: VIEWER_OFFER, routing: {}, client: 'c', hostDeviceId: 12 }),
        { e2ee: false, e2eeReason: 'E2EE_UNSUPPORTED' });
      assert.strictEqual(sent.length, 0);
      relay._termTokens.delete(t);
    });
  } finally { SERVER_CAPS.splice(idx, 0, 'e2ee.stream.v1'); }
});

test('스트림 sid — 스위치를 내리면 **이미 sid 가 붙은 토큰**도 주입을 멈춘다(회수의 절반이 아니라 전부)', () => {
  // 협상은 토큰 발급 1회지만 그 토큰의 모든 재연결이 같은 sid 를 재사용한다(TTL 1h, 접근 시 연장).
  //  스위치를 내리는 이유가 "sid 주입이 잘못돼 터미널이 4090 무한 재연결" 인데, 발급된 토큰이 계속
  //  sid 를 실으면 그 회귀를 회수할 수 없다 → 주입 지점에도 같은 게이트를 둔다.
  const sess = { cwd: 'a', paneId: 'p', win: 1, client: 'c', e2ee: { sid: HOST_ANSWER.sid } };
  const fwd = { port: 5173, e2ee: { sid: HOST_ANSWER.sid } };
  assert.strictEqual(relay._ptyStreamParams(sess).sid, HOST_ANSWER.sid); // 켜져 있을 때
  const idx = SERVER_CAPS.indexOf('e2ee.stream.v1');
  assert.ok(idx >= 0);
  SERVER_CAPS.splice(idx, 1);
  try {
    assert.strictEqual(relay._ptyStreamParams(sess).sid, undefined, 'sid 가 계속 실리면 스위치가 반쪽이다');
    assert.strictEqual(relay._tcpStreamParams(fwd).sid, undefined);
    // 나머지 params 는 그대로여야 한다(평문 경로 = 오늘의 동작에서 한 필드도 달라지지 않는다).
    assert.deepStrictEqual(relay._ptyStreamParams(sess), { cols: 80, rows: 24, cwd: 'a', paneId: 'p', win: 1, client: 'c' });
    assert.deepStrictEqual(relay._tcpStreamParams(fwd), { port: 5173 });
  } finally { SERVER_CAPS.splice(idx, 0, 'e2ee.stream.v1'); }
});

test('스트림 sid — 포워딩(tcp)은 routing={port} 로 같은 배관을 탄다', async () => {
  const userId = 990014;
  await withRunner(userId, 12, async ({ sent, reply }) => {
    const token = relay.issueForwardToken(userId, 5173, 12);
    const p = relay.negotiateStreamE2ee(userId, { token, purpose: 'tcp', offer: VIEWER_OFFER, routing: { port: 5173 }, client: 'pcKey', hostDeviceId: 12, opts: { runnerId: 12 } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent[0].params.purpose, 'tcp');
    assert.deepStrictEqual(sent[0].params.routing, { port: 5173 });
    reply(HOST_ANSWER);
    await p;
    const sess = relay._fwdTokens.get(token);
    assert.deepStrictEqual(relay._tcpStreamParams(sess), { port: 5173, sid: HOST_ANSWER.sid });
    relay._fwdTokens.delete(token);
  });
});

test('스트림 sid — 오퍼의 pub/nonce 는 32바이트여야 한다(데몬 beginHost 가 강제하는 길이)', (t) => {
  // b64u 16~512자만 보면 16B nonce 가 통과하는데 데몬 beginHost 는 bytes(p.nonce,32) 로 잘라
  //  E2EE_ENCODING 을 던진다 → 결과는 왕복 1회 낭비 + 아무 신호 없는 e2ee:false(평문).
  //  "스트림 암호화를 켰는데 평문" 은 이 라운드가 닫은 결함과 같은 형태이므로 형식 게이트에서 접는다.
  const b64u = (n) => require('crypto').randomBytes(n).toString('base64url');
  const base = { suite: 'cpt-e2ee/v1', epoch: 2 };
  assert.ok(relay._normE2eeOffer({ ...base, pub: b64u(32), nonce: b64u(32) }), '32B 정상 오퍼가 거절되면 협상 자체가 죽는다');
  assert.strictEqual(relay._normE2eeOffer({ ...base, pub: b64u(32), nonce: b64u(16) }), null, '16B nonce = 데몬 E2EE_ENCODING → 조용한 평문');
  assert.strictEqual(relay._normE2eeOffer({ ...base, pub: b64u(16), nonce: b64u(32) }), null);
  assert.strictEqual(relay._normE2eeOffer({ ...base, pub: b64u(33), nonce: b64u(32) }), null);
  assert.strictEqual(relay._normE2eeOffer({ ...base, pub: b64u(32), nonce: b64u(64) }), null);
  // b64u 아닌 문자(=/+)는 그대로 거절 — 관용 디코드로 우회되면 안 된다.
  assert.strictEqual(relay._normE2eeOffer({ ...base, pub: 'A'.repeat(42) + '=', nonce: b64u(32) }), null);

  // 교차검증 — 데몬 beginHost 가 실제로 32B 만 받는지 상대 구현으로 확인(우리 상수의 근거).
  const dm = loadDaemonE2ee();
  if (!dm) return t.skip('데몬 모듈 없음(단일 리포 CI)');
  const ep = dm.epoch();
  // 데몬이 스스로 만드는 오퍼(뷰어 레그 정본) = back 게이트를 통과해야 한다 = 32B 가 맞는 상수다.
  const { offer } = dm.createViewerOffer({ epoch: ep, purpose: 'pty', client: 'ck', routing: {} });
  assert.deepStrictEqual(relay._normE2eeOffer(offer), { suite: offer.suite, epoch: offer.epoch, pub: offer.pub, nonce: offer.nonce });
  assert.strictEqual(Buffer.from(offer.pub, 'base64url').length, 32);
  assert.strictEqual(Buffer.from(offer.nonce, 'base64url').length, 32);
  // 반대로 16B nonce 는 데몬이 E2EE_ENCODING 으로 죽인다 → back 이 미리 접는 게 맞다.
  assert.throws(() => dm.beginHost({ ...offer, purpose: 'pty', nonce: b64u(16), client: 'ck', routing: {} }),
    (e) => e && e.code === 'E2EE_ENCODING', '데몬이 16B nonce 를 받아 준다면 back 의 32B 게이트가 과하다');
  const ok = dm.beginHost({ ...offer, purpose: 'pty', client: 'ck', routing: {} });
  assert.ok(ok && ok.sid, '32B 오퍼는 sid 를 발급해야 한다');
});

// ── 갭2/3: 호스트별 자물쇠 배지의 급여 경로(runner_status) ─────────────────

// registerAgentWs 를 실제로 태우기 위한 최소 ws 스텁(EventEmitter + send 캡처).
function agentWsStub() {
  const { EventEmitter } = require('events');
  const ws = new EventEmitter();
  ws.readyState = 1; ws.frames = [];
  ws.send = (s) => { ws.frames.push(JSON.parse(s)); };
  ws.ping = () => {}; ws.terminate = () => {};
  ws.feed = (obj) => ws.emit('message', Buffer.from(JSON.stringify(obj)));
  return ws;
}

test('runner_status — ui_hello 는 이미 붙어 있는 러너의 열쇠 세대를 그 화면에만 리플레이한다', () => {
  // 왜: e2eeEpoch 팬아웃은 러너 "연결 시"와 hello 의 "값 변화 시" 두 곳뿐이다. 데몬이 이미 붙어 있는
  //  정상 상태에서 앱/PC 를 다시 열면 프레임이 0건 → 클라 hostLock 이 비어 배지가 '확인 중' 에
  //  영구 고착한다(다음 데몬 재접속까지 수 시간~수 일). 정직한 자물쇠를 만들려고 세운 배지가
  //  정작 진실을 한 번도 못 보여주는 상태 = 조용한 죽음.
  const userId = 990020;
  const conn = { deviceId: 12, kind: 'local', deviceName: 'MacBook', platform: 'darwin', caps: ['e2ee.keys.v1'], e2eeEpoch: 3, lan: null, lanEpoch: 0, connectedAt: Date.now(), ws: { send() {} }, rpcSeq: 0, pendingRpc: new Map() };
  const conn2 = { deviceId: 13, kind: 'local', deviceName: 'Mini', platform: 'darwin', caps: [], e2eeEpoch: 0, lan: null, lanEpoch: 0, connectedAt: Date.now(), ws: { send() {} }, rpcSeq: 0, pendingRpc: new Map() };
  relay._connections.set(String(userId), { runners: new Map([[12, conn], [13, conn2]]), activeRunnerId: 12 });
  const other = wsStub(); // 이미 붙어 있던 다른 화면 — 리플레이는 팬아웃이 아니다
  relay._agentWsClients.set(String(userId), new Set([other]));
  const ws = agentWsStub();
  try {
    relay._registerAgentWs(ws, String(userId), 'mobile');
    ws.feed({ type: 'ui_hello', clientKey: 'ck', kind: 'mobile', deviceId: 77, caps: [], e2eeEpoch: 3 });
    const rs = ws.frames.filter((f) => f.type === 'runner_status');
    assert.strictEqual(rs.length, 2, 'ui_hello 직후 runner_status 리플레이가 없으면 배지가 영구히 확인 중이다');
    assert.deepStrictEqual(rs.map((f) => f.event.deviceId).sort(), [12, 13]);
    const m = new Map(rs.map((f) => [f.event.deviceId, f.event]));
    // 열쇠 있는 PC = epoch 그대로, 없는 PC = 0(둘 다 진실이다 — 0 을 안 보내면 '확인 중' 이 남는다).
    assert.strictEqual(m.get(12).e2eeEpoch, 3);
    assert.strictEqual(m.get(13).e2eeEpoch, 0);
    // 라이브 팬아웃과 같은 필드로 보내야 클라 수신기가 분기 없이 먹는다(applyHostOnline/lanEpochRef).
    assert.strictEqual(m.get(12).online, true);
    assert.strictEqual(m.get(12).deviceName, 'MacBook');
    assert.strictEqual(m.get(12).kind, 'local');
    assert.strictEqual(m.get(12).lanEpoch, 0);
    assert.strictEqual(m.get(12).replay, true, '리플레이 표시가 있어야 클라가 라이브 전이와 구분할 수 있다');
    // agent_state 리플레이는 그대로 살아 있어야 한다(같은 분기의 기존 기능 회귀 금지).
    assert.strictEqual(other.frames.length, 0, '리플레이가 다른 화면으로 새면 팬아웃이 된다');
  } finally {
    ws.emit('close');
    relay._connections.delete(String(userId));
    relay._agentWsClients.delete(String(userId));
  }
});

test('runner_status — 러너가 0대면 리플레이 프레임도 0건이다(유령 온라인 금지)', () => {
  const userId = 990021;
  const ws = agentWsStub();
  try {
    relay._registerAgentWs(ws, String(userId), 'pc');
    ws.feed({ type: 'ui_hello', clientKey: 'ck', kind: 'pc' });
    assert.strictEqual(ws.frames.filter((f) => f.type === 'runner_status').length, 0);
  } finally { ws.emit('close'); relay._agentWsClients.delete(String(userId)); }
});

// ── 갭5: 체크포인트 begin/commit ────────────────────────────────────────

// cpt-server.js:252-263 이 실제로 보내는 commit body 그대로(봉인 좌표 포함).
const DAEMON_COMMIT_BODY = {
  workspaceId: 'ws_ab12',
  checkpointId: 'ck_1753432800000_a1b2c3d4',
  skipped: false,
  unchanged: false,
  baseCommit: '1111111111111111111111111111111111111111',
  commit: '2222222222222222222222222222222222222222',
  sizeBytes: 123456,
  hasSession: true,
  enc: 'cptsnap/1',
  epoch: 2,
};

// objectstore/워크스페이스 메타는 배관이므로 스텁(검증 대상 = 매니페스트 규칙과 응답 형태).
function withSyncStubs(fn) {
  const s3 = require('../services/s3Service');
  const wsSvc = require('../services/workspaceService');
  const orig = {
    getWorkspace: wsSvc.getWorkspace, put: s3.getSignedPutUrl, get: s3.getFileContent, save: s3.saveFile,
  };
  const state = { manifest: null, saves: 0 };
  wsSvc.getWorkspace = async () => ({ compute: 'local', localPath: 'proj/a' });
  s3.getSignedPutUrl = async (key) => `https://objectstore.test/${key}?sig=1`;
  s3.getFileContent = async () => (state.manifest ? { success: true, content: JSON.stringify(state.manifest) } : null);
  s3.saveFile = async (key, body) => { state.manifest = JSON.parse(body); state.saves += 1; return { success: true }; };
  return Promise.resolve().then(() => fn(state)).finally(() => {
    wsSvc.getWorkspace = orig.getWorkspace; s3.getSignedPutUrl = orig.put; s3.getFileContent = orig.get; s3.saveFile = orig.save;
  });
}

test('체크포인트 begin/commit — 데몬 body 그대로 왕복(키는 서버 조립 · enc/epoch 보관 · 멱등)', async () => {
  await withSyncStubs(async (state) => {
    const begun = await syncService.checkpointBegin(9, 'ws_ab12', { reason: 'periodic' });
    // 데몬 cpt-server.js:238-243 이 없으면 throw 하는 필수 3종
    assert.match(begun.checkpointId, /^ck_\d+_[0-9a-f]{8}$/);
    assert.strictEqual(begun.putUrls.bundle, `https://objectstore.test/codingpt/sync/ws_ab12/${begun.checkpointId}.bundle?sig=1`);
    assert.ok(begun.putUrls.session.endsWith('.session.json?sig=1'));
    assert.strictEqual(begun.cwd, 'proj/a');  // 미지정이면 ws.localPath
    assert.strictEqual(begun.reason, 'periodic');

    // ★ 데몬 commit body 에는 reason 이 **없다**(cpt-server.js:252-263) → begin 이 기억한 이유를 쓴다.
    const out = await syncService.checkpointCommit(9, 'ws_ab12', { ...DAEMON_COMMIT_BODY, checkpointId: begun.checkpointId });
    assert.strictEqual(out.reason, 'periodic', '자동 트리거가 매니페스트에 manual 로 위장되면 목록이 거짓말을 한다');
    assert.strictEqual(out.id, begun.checkpointId);
    assert.strictEqual(out.bundleKey, `codingpt/sync/ws_ab12/${begun.checkpointId}.bundle`); // 서버 조립(데몬 임의 키 금지)
    assert.strictEqual(out.sessionKey, `codingpt/sync/ws_ab12/${begun.checkpointId}.session.json`);
    assert.strictEqual(out.sizeBytes, 123456);
    assert.strictEqual(out.hasSession, true);
    assert.strictEqual(out.enc, 'cptsnap/1');   // 봉인 좌표 보관(감사/복호 실패 진단)
    assert.strictEqual(out.epoch, 2);
    assert.deepStrictEqual(out.head, { checkpointId: begun.checkpointId, commit: DAEMON_COMMIT_BODY.commit, baseCommit: DAEMON_COMMIT_BODY.baseCommit, at: out.at });

    // 멱등 — 같은 id 로 두 번 와도 항목이 중복되지 않는다(재시도/중복 트리거)
    await syncService.checkpointCommit(9, 'ws_ab12', { ...DAEMON_COMMIT_BODY, checkpointId: begun.checkpointId });
    assert.strictEqual(state.manifest.checkpoints.length, 1);

    // skipped=true → 매니페스트를 건드리지 않고 현재 head 를 돌려준다
    const savesBefore = state.saves;
    const skipped = await syncService.checkpointCommit(9, 'ws_ab12', { workspaceId: 'ws_ab12', checkpointId: begun.checkpointId, skipped: true, unchanged: true });
    assert.deepStrictEqual(skipped, { skipped: true, unchanged: true, checkpointId: begun.checkpointId, head: state.manifest.head });
    assert.strictEqual(state.saves, savesBefore, 'skipped 인데 매니페스트를 다시 썼다');
  });
});

test('체크포인트 commit — 미발급/형식오류 id 는 400(매니페스트 키를 클라가 정할 수 없다)', async () => {
  await withSyncStubs(async () => {
    // 형식은 맞지만 begin 이 발급하지 않은 id
    await assert.rejects(
      () => syncService.checkpointCommit(9, 'ws_ab12', { checkpointId: 'ck_evil_key', commit: 'x' }),
      (e) => e.statusCode === 400 && /발급되지 않은/.test(e.message));
    // 경로 안전(형식) 위반
    await assert.rejects(
      () => syncService.checkpointCommit(9, 'ws_ab12', { checkpointId: '../../etc/passwd' }),
      (e) => e.statusCode === 400);
    await assert.rejects(
      () => syncService.checkpointCommit(9, 'ws_ab12', {}),
      (e) => e.statusCode === 400);
  });
});

test('체크포인트 구 경로 — 응답/매니페스트가 1바이트도 바뀌지 않는다(모바일이 이 경로만 쓴다)', async () => {
  await withSyncStubs(async (state) => {
    const origRpc = relay.callRpc;
    const rpcCalls = [];
    relay.callRpc = async (userId, method, params, timeoutMs) => {
      rpcCalls.push({ method, params, timeoutMs });
      return { baseCommit: 'aaa', commit: 'bbb', sizeBytes: 42, hasSession: false };
    };
    try {
      const out = await syncService.checkpoint(9, 'ws_ab12', { reason: 'manual' });
      // 데몬에 가는 RPC 는 그대로(cwd/reason/checkpointId/putUrls/includeAgentSession/wsId)
      assert.strictEqual(rpcCalls[0].method, 'sync.checkpoint');
      assert.deepStrictEqual(Object.keys(rpcCalls[0].params).sort(), ['checkpointId', 'cwd', 'includeAgentSession', 'putUrls', 'reason', 'wsId']);
      assert.strictEqual(rpcCalls[0].params.cwd, 'proj/a');
      assert.strictEqual(rpcCalls[0].timeoutMs, 600000);
      // 응답 키 = 구 구현과 동일(+ enc/epoch 는 데몬이 봉인했을 때만 추가되는 additive 필드)
      assert.deepStrictEqual(Object.keys(out).sort(), ['at', 'baseCommit', 'bundleKey', 'commit', 'hasSession', 'head', 'id', 'reason', 'sessionKey', 'sizeBytes']);
      assert.strictEqual(out.reason, 'manual');
      assert.strictEqual(out.sessionKey, null); // hasSession=false
      assert.strictEqual(state.manifest.checkpoints.length, 1);
      assert.strictEqual(state.manifest.head.checkpointId, out.id);

      // skipped 응답도 구 구현과 동일한 모양
      relay.callRpc = async () => ({ skipped: true });
      const sk = await syncService.checkpoint(9, 'ws_ab12', { reason: 'periodic' });
      assert.deepStrictEqual(Object.keys(sk).sort(), ['checkpointId', 'head', 'skipped', 'unchanged']);
      assert.strictEqual(sk.checkpointId, out.id, 'skipped 면 head 의 체크포인트를 돌려준다(구 동작)');
    } finally { relay.callRpc = origRpc; }
  });
});

test('체크포인트 commit — enc/epoch 는 보관하고 쓰레기 값은 버린다(감사 단서)', () => {
  assert.deepStrictEqual(syncService._normEnc(DAEMON_COMMIT_BODY), { enc: 'cptsnap/1', epoch: 2 });
  assert.deepStrictEqual(syncService._normEnc({}), {});                                  // 평문이면 필드 없음
  assert.deepStrictEqual(syncService._normEnc({ enc: 'cptsnap/1' }), { enc: 'cptsnap/1' }); // epoch 없이도 보관
  assert.deepStrictEqual(syncService._normEnc({ enc: 'x'.repeat(80), epoch: 1 }), {});    // 길이 상한
  assert.deepStrictEqual(syncService._normEnc({ enc: 'a b', epoch: 1 }), {});             // 형식
  assert.deepStrictEqual(syncService._normEnc({ enc: 'cptsnap/1', epoch: -1 }), { enc: 'cptsnap/1' });
});

test('체크포인트 — begin/commit 컨트롤러가 accountAuth 라우트로 붙어 있다(JWT 전용이면 데몬 401)', () => {
  const syncController = require('../controllers/syncController');
  assert.strictEqual(typeof syncController.checkpointBegin, 'function');
  assert.strictEqual(typeof syncController.checkpointCommit, 'function');
  // 라우트 정의를 소스로 고정 — authMiddleware(JWT 전용)로 붙이면 데몬 deviceToken 이 401 을 받아
  //  PC 가 영구히 구 경로로 폴백한다(체크포인트는 정상 동작하므로 아무도 눈치채지 못한다 = §5.8).
  const routes = require('fs').readFileSync(path.resolve(__dirname, '../routes/daemonRoutes.js'), 'utf8');
  assert.match(routes, /router\.post\('\/sync\/checkpoint\/begin', accountAuth, syncController\.checkpointBegin\)/);
  assert.match(routes, /router\.post\('\/sync\/checkpoint\/commit', accountAuth, syncController\.checkpointCommit\)/);
  // 구 경로는 남아 있어야 한다(모바일 daemonService.ts:719 가 그것만 쓴다).
  assert.match(routes, /router\.post\('\/sync\/checkpoint', accountAuth, syncController\.checkpoint\)/);
  // 봉투 RPC 도 accountAuth(PC 앱 deviceToken) — fs/* 와 같은 규약.
  assert.match(routes, /router\.post\('\/rpc', accountAuth, daemonController\.rpcSealed\)/);
});

// ── 갭2 후속(2026-07-27): 열쇠 변화 힌트 푸시 `e2ee_hint` ─────────────────────
//
// 닫는 한계: 데몬은 열쇠 보유 중 15분(e2ee-account TRUSTED_MS) 고정 주기로만 keyring 을 확인했다.
//  다른 기기에서 rotate 하면 최대 15분간 그 PC 는 옛 세대로 남고 봉투는 전부 E2EE_EPOCH_MISMATCH →
//  화면은 '확인 중' 에 머문다. 이제 back 이 같은 사실을 데몬 제어 WS 로도 알린다(가속기).
//
// 이 절이 고정하는 계약(깨지면 조용히 죽는다)
//  · 프레임 스키마에 epoch/policy/봉인문이 **없다** — 있으면 서버가 세대를 주장해 데몬을 옛/새 세대로
//    몰아넣을 수 있고 그 순간 서버가 E2EE 신뢰 경계 안으로 들어온다(유일한 위협모델).
//  · 데몬 caps 게이팅 — 선언하지 않은 데몬에게 보내면 프레임만 버려진다(조용한 유실).
//  · UI 팬아웃(device_approval_event)은 한 줄도 바뀌지 않는다(같은 함수 안에 추가했으므로 회귀 위험).

function runnerStub(deviceId, caps) {
  const frames = [];
  return {
    conn: { deviceId, kind: 'local', caps, e2eeEpoch: 1, ws: { readyState: 1, send(s) { frames.push(JSON.parse(s)); } }, rpcSeq: 0, pendingRpc: new Map(), lastActivityAt: 0 },
    frames,
  };
}

test('e2ee_hint — 회전 팬아웃이 e2ee.hint.v1 을 선언한 데몬에게만 내려간다(스키마에 epoch 없음)', () => {
  const userId = 990030;
  const newDaemon = runnerStub(12, ['caps.v1', 'e2ee.keys.v1', 'e2ee.hint.v1']);
  const oldDaemon = runnerStub(13, ['caps.v1', 'e2ee.keys.v1']);        // 구 번들 — 프레임을 버린다
  const ui = wsStub();
  relay._connections.set(String(userId), { runners: new Map([[12, newDaemon.conn], [13, oldDaemon.conn]]), activeRunnerId: 12 });
  relay._agentWsClients.set(String(userId), new Set([ui]));
  try {
    relay.fanoutDeviceApproval(userId, { kind: 'rotated', epoch: 4, revokedKeyIds: [7], byKeyId: 1 });

    // ① UI 팬아웃은 그대로(회귀 금지) — 기기 승인 시트/키링 화면이 이 프레임으로 산다.
    assert.strictEqual(ui.frames.length, 1);
    assert.strictEqual(ui.frames[0].type, 'device_approval_event');
    assert.strictEqual(ui.frames[0].event.epoch, 4, 'UI 프레임은 기존 형태를 유지한다');

    // ② 데몬에게는 힌트만 — caps 를 선언한 쪽에만.
    assert.strictEqual(oldDaemon.frames.length, 0, '선언하지 않은 데몬에게 보내면 조용한 유실이다');
    assert.strictEqual(newDaemon.frames.length, 1);
    const f = newDaemon.frames[0];
    assert.strictEqual(f.type, 'e2ee_hint');
    assert.strictEqual(f.kind, 'rotated');
    assert.strictEqual(typeof f.at, 'string');
    // ★ 스키마 잠금 — 상태를 주장하는 필드가 하나라도 생기면 데몬이 그것을 채택할 여지가 생긴다.
    assert.deepStrictEqual(Object.keys(f).sort(), ['at', 'kind', 'type']);
    for (const bad of ['epoch', 'policy', 'sealed', 'sig', 'grant', 'keyId', 'revokedKeyIds']) {
      assert.strictEqual(bad in f, false, `힌트 프레임에 ${bad} 가 실렸다 — 정본은 데몬의 keyring 왕복이다`);
    }
  } finally {
    relay._connections.delete(String(userId));
    relay._agentWsClients.delete(String(userId));
  }
});

test("e2ee_hint — 'request'(새 기기 승인 대기)는 데몬 힌트를 만들지 않는다(왕복만 늘고 바뀌는 게 없다)", () => {
  const userId = 990031;
  const d = runnerStub(12, ['e2ee.hint.v1']);
  const ui = wsStub();
  relay._connections.set(String(userId), { runners: new Map([[12, d.conn]]), activeRunnerId: 12 });
  relay._agentWsClients.set(String(userId), new Set([ui]));
  try {
    relay.fanoutDeviceApproval(userId, { kind: 'request', enrollmentId: 'e_0001', verifyCode: '1234' });
    assert.strictEqual(ui.frames.length, 1, '승인 시트용 UI 팬아웃은 그대로여야 한다');
    assert.strictEqual(d.frames.length, 0);
    // 열쇠 사실이 바뀌는 kind 는 전부 보낸다(하나라도 빠지면 그 전이만 15분 지연으로 남는다).
    for (const kind of ['rotated', 'rotate_needed', 'resolved', 'bootstrapped', 'policy', 'recovery']) {
      assert.strictEqual(relay.notifyRunnersE2ee(userId, { kind }), 1, `kind=${kind} 가 데몬에게 가지 않는다`);
    }
    assert.strictEqual(relay.notifyRunnersE2ee(userId, { kind: 'nope' }), 0, '모르는 kind 를 보내면 안 된다');
    assert.strictEqual(relay.notifyRunnersE2ee(userId, {}), 0);
  } finally {
    relay._connections.delete(String(userId));
    relay._agentWsClients.delete(String(userId));
  }
});

test('e2ee_hint — 힌트 kind 는 deviceTrustService 가 실제로 팬아웃하는 문자열이어야 한다', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../services/deviceTrustService.js'), 'utf8');
  const emitted = new Set([...src.matchAll(/fanout\([^,]+,\s*\{\s*kind:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 6, `팬아웃 kind 스캔 실패(${emitted.size}개) — 정규식이 낡았다`);
  for (const kind of relay._e2eeHintKinds) {
    // 오타 하나면 그 전이의 힌트가 영원히 발화하지 않는다(에러 0건 — 15분 지연이 그대로 남는다).
    assert.ok(emitted.has(kind), `힌트 목록의 '${kind}' 를 deviceTrustService 는 팬아웃하지 않는다`);
  }
});

test('e2ee_hint — caps 문자열이 back·데몬 양쪽에서 글자까지 같다 + 킬스위치로 회수된다', () => {
  const { computeServerCaps } = require('../config/caps');
  assert.ok(SERVER_CAPS.includes('e2ee.hint.v1'), '처리 코드가 이 커밋에 있으므로 선언해야 한다');
  assert.strictEqual(computeServerCaps({ E2EE_ENABLED: '0' }).includes('e2ee.hint.v1'), false,
    'E2EE 를 끄면 알릴 변화 자체가 없다 — 선언도 회수해야 한다');
  // 데몬이 다른 표기를 쓰면 교집합이 공집합이 되어 협상이 영구 OFF 된다(그게 '안전한 평문'으로 위장된다).
  const fs = require('fs');
  const p = path.join(DAEMON_ROOT, 'control.js');
  if (fs.existsSync(p)) {
    const src = fs.readFileSync(p, 'utf8');
    assert.match(src, /caps\.push\('e2ee\.hint\.v1'\)/, '데몬 daemonCaps() 가 같은 문자열을 선언해야 한다');
    assert.match(src, /msg\.type === 'e2ee_hint'/, '데몬에 프레임 수신 분기가 없으면 선언이 거짓이 된다');
  }
});
