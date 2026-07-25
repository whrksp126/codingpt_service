// 배관 계약(가운데 5곳) 데몬측 계약 테스트 — node --test
//   실행: CPT_SHIM_NO_GLOBAL_LINK=1 node --test packages/runner-core/test/plumbing-contract.test.js
//
// 정본: docs/구현설계-2026-07-25/11-배관-계약.md (§1 agent_state · §2 봉투 RPC · §4 LAN · §5 체크포인트)
//
// 이 파일의 존재 이유: 지난 라운드에 grant 서명 epoch 인코딩이 back/데몬에서 갈라졌는데 **양쪽 단위
//  테스트가 모두 초록**이었다(각자 자기 구현으로 검증했으니까). 그래서 여기서는 상대가 실제로 보내는
//  **JSON 바이트 형태를 하드코딩**하고, 우리 핸들러가 그것을 받아들이는지/우리가 내보내는 형태가
//  상대의 파서 규칙과 일치하는지를 고정한다.
//
// 하드코딩한 상대편 형태(근거 파일:줄)
//  · back → 데몬 rpc:      { type:'rpc', method:'sealed', params:{ env, hostDeviceId? } }
//                          (codingpt_back/controllers/daemonController.js:897-901)
//  · 앱 → back 봉인 본문:  { hostDeviceId?, timeoutMs, env }  (codingpt_app/src/services/e2ee.ts:862)
//  · back 성공 응답:       successResponse = **data 를 최상위로** (codingpt_back/utils/response.js:11)
//  · back 실패 응답:       { success:false, message, detail:{ code } } (같은 파일 :18)
//  · 데몬 → back 상태:     { type:'agent_state', event:{ cwd, win, state, agent, version, at,
//                            sessionId, source, since } } — back normAgentState(:739) 의 필수/허용 필드
//  · PC lan.js 분기:       lan.status → r.mode==='lan' 만 / lan.rpc → r.ok===true|LAN_* 코드 5종
//                          (codingpt_pc/src/js/lan.js:149, :181-186)
//  · PC e2ee.js 분기:      IPC Err = E2EE 전체 미지원 / {ok:false} = 그 조작만 실패
//                          (codingpt_pc/src/js/e2ee.js:76-85, :211-224)

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

// ── 격리(require 전에!) — 실사용 ~/.codingpt·실 Wi-Fi 노출·실 tmux 무접촉 ──
process.env.CODINGPT_TMUX_SOCKET = `codingpt-plumb-${process.pid}-${Date.now()}`;
process.env.CPT_LAN_SCOPE = 'tcp';                                  // 기본값에서 시작(rpc 는 테스트에서 승격)
process.env.CPT_LAN_PORT = String(48500 + (process.pid % 1000));    // 실사용 47321·lan.test.js 대역 회피
process.env.CPT_E2EE_SCOPE = 'rpc';

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-plumb-'));
const STATE = path.join(ROOT, '.codingpt');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

const cptServer = require('../cpt-server');
const control = require('../control');
const agentState = require('../agent-state');
const e2ee = require('../e2ee');
const lanLib = require('../lan');
const lanLocal = require('../lan-local');

assert.ok(lanLib.lanStateFile().startsWith(ROOT), '격리 stateDir 미적용 — 중단');

const SELF_DEV = 12;   // 이 데몬의 deviceId(= e2ee 상태파일). 봉투 AAD 대조에 쓴다.
const EPOCH = 2;

// ── 가짜 back ─────────────────────────────────────────────────────────────
const hits = [];
let rpcBehavior = 'echo';     // echo | notfound | remoteError | empty
let grantBehavior = 'ok';     // ok | unsupported | ratelimited
let LAN_PORT = 0;
let lanGrantIssued = null;

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const back = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch (_) { json = null; }
    hits.push({ url: req.url, method: req.method, body: json, auth: req.headers.authorization });

    // ── POST /api/daemon/rpc (봉투 프록시, 기능2 B단계) ──
    if (req.url === '/api/daemon/rpc') {
      if (rpcBehavior === 'notfound') return sendJson(res, 404, { success: false, message: 'Not Found' });
      // 상대 데몬 역할: **평문 형제 필드 hostDeviceId 로 AAD 를 재구성**해 봉투를 열고 응답을 봉인한다.
      //  (같은 프로세스라 MK 를 공유한다 — 여기서 검증하는 것은 AAD/필드 규약이다)
      const aadHost = json && json.hostDeviceId != null ? Number(json.hostDeviceId) : 0;
      const encOpts = { epoch: json.env.epoch, hostDeviceId: aadHost };
      let opened = null;
      try { opened = e2ee.openRpc(json.env, encOpts); } catch (e) {
        return sendJson(res, 502, { success: false, message: '복호 실패', detail: { code: 'E2EE_OPEN_FAILED' } });
      }
      if (rpcBehavior === 'remoteError') {
        const env = e2ee.sealRpcError(Object.assign(new Error('그런 파일이 없습니다'), { code: 'ENOENT' }), encOpts);
        return sendJson(res, 200, { env });
      }
      const result = rpcBehavior === 'empty' ? null : { echoed: opened.m, params: opened.p };
      return sendJson(res, 200, { env: e2ee.sealRpcResult(result, encOpts) });
    }

    // ── POST /api/daemon/lan/grant (기능4) ──
    if (req.url === '/api/daemon/lan/grant') {
      if (grantBehavior === 'unsupported') {
        return sendJson(res, 404, { success: false, message: '이 호스트는 직결을 지원하지 않습니다.', detail: { code: 'LAN_UNSUPPORTED' } });
      }
      if (grantBehavior === 'ratelimited') {
        return sendJson(res, 429, { success: false, message: '직결 요청이 너무 잦습니다.', detail: { code: 'LAN_RATE_LIMITED' } });
      }
      const grantId = 'lg-' + crypto.randomBytes(12).toString('hex');
      const secret = crypto.randomBytes(32).toString('base64');
      const scopes = (json && Array.isArray(json.scopes) ? json.scopes : ['tcp'])
        .filter((s) => ['tcp', 'rpc'].includes(s));
      // back 은 grant 를 뷰어에 주기 **전에** 제어 WS 로 호스트에 통지한다(사전 통지 실패 시 폐기).
      //  이 테스트에서는 같은 프로세스의 lan 모듈에 직접 등록해 그 통지를 대신한다.
      const add = lanLib.addGrant({
        grantId, secret, clientKey: json.clientKey, kind: json.kind, scopes,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      assert.strictEqual(add.ok, true, `테스트 grant 등록 실패: ${add.error}`);
      lanGrantIssued = { grantId, secret, clientKey: json.clientKey, scopes };
      return sendJson(res, 200, {
        grantId, secret, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ttlMs: 600000,
        scopes, hostDeviceId: json.hostDeviceId, machineId: 'mid-test', proto: 1, lanEpoch: 1,
        endpoints: [{ host: '127.0.0.1', port: LAN_PORT, family: 4 }],
      });
    }

    // 알림(POST /api/notifications) 등 나머지는 성공으로 흘린다.
    return sendJson(res, 200, { ok: true });
  });
});

const urls = () => hits.map((h) => h.url);
const hitsOf = (u) => hits.filter((h) => h.url === u);

// one-shot 소켓 왕복(local-checkpoint.test.js 헬퍼 미러).
function call(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(cptServer.sockPath());
    let buf = '';
    const timer = setTimeout(() => { try { conn.destroy(); } catch (_) { /* noop */ } reject(new Error('소켓 응답 시간 초과')); }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, cmd, args, ctx: { cwd: ROOT, ws: 'proj' } }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      try { conn.end(); } catch (_) { /* noop */ }
    });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

let srv = null;
test('setup — 격리 stateDir + 가짜 back + cpt 소켓 + LAN 리스너(127.0.0.1 전용)', async () => {
  await new Promise((r) => back.listen(0, '127.0.0.1', r));
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({
    serverUrl: `http://127.0.0.1:${back.address().port}`, deviceToken: 'cptd_test', deviceName: 'T', deviceId: SELF_DEV,
  }));
  fs.mkdirSync(path.join(ROOT, 'proj'), { recursive: true });
  srv = cptServer.start({});
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(fs.existsSync(cptServer.sockPath()));
});

after(async () => {
  try { lanLib.stop(); } catch (_) { /* noop */ }
  try { if (srv) srv.close(); } catch (_) { /* noop */ }
  try { fs.unlinkSync(cptServer.sockPath()); } catch (_) { /* noop */ }
  await new Promise((r) => back.close(r));
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ══════════════════════════════════════════════════════════════════════════
//  갭 1 — agent_state 방출
// ══════════════════════════════════════════════════════════════════════════

const T0 = 1753432800000;
const KEY = (tid) => `cpt-proj--t-${tid}`;

function armAgentState(frames) {
  agentState._reset();
  agentState.configure({
    now: () => T0,
    notify: async () => { /* 알림은 이 테스트의 관심사가 아니다 */ },
    log: null,
    emit: (f) => { frames.push(JSON.parse(JSON.stringify(f))); return true; },
  });
}

test('1-A. 데몬이 내보내는 agent_state 프레임의 정확한 형태(back normAgentState 가 받는 그대로)', async () => {
  const frames = [];
  armAgentState(frames);
  await agentState.applyHook(KEY(1000123), {
    event: 'prompt', cwdRel: 'other/project/codingpt', tid: 1000123, agent: 'claude',
    sessionId: '21b28dc2-4b1e-4a55-9c4a-000000000000', promptId: 'p1',
  });
  assert.strictEqual(frames.length, 1);
  assert.deepStrictEqual(frames[0], {
    type: 'agent_state',
    event: {
      cwd: 'other/project/codingpt',
      win: 1000123,
      state: 'working',
      agent: 'claude',
      version: 1,
      at: T0,
      sessionId: '21b28dc2-4b1e-4a55-9c4a-000000000000',
      source: 'hook',
      since: T0,
    },
  }, '와이어 형태가 계약 §1.3 ①과 1바이트라도 다르면 back 이 프레임을 버린다');
  // 금지 필드 — 내용성 정보는 상태 프레임에 절대 싣지 않는다(순수 메타데이터 불변식).
  for (const k of ['summary', 'body', 'promptId', 'pending', 'transcriptPath', 'tool']) {
    assert.ok(!(k in frames[0].event), `상태 프레임에 내용성 필드(${k})가 실렸다`);
  }
});

test('1-B. ended → "gone" 변환(누락하면 claude 종료 후 Chat 토글이 영구히 켜진 채 남는다)', async () => {
  const frames = [];
  armAgentState(frames);
  const key = KEY(1000200);
  const id = { cwdRel: 'proj/a', tid: 1000200, agent: 'claude' };
  await agentState.applyHook(key, { ...id, event: 'session_start' });   // → idle
  await agentState.applyHook(key, { ...id, event: 'prompt' });          // → working
  await agentState.applyHook(key, { ...id, event: 'session_end' });     // → ended → 'gone'
  assert.deepStrictEqual(frames.map((f) => f.event.state), ['idle', 'working', 'gone']);
  assert.strictEqual(agentState.wireStateOf({ state: 'ended' }), 'gone');
  assert.strictEqual(agentState.wireStateOf({ state: 'launching' }), 'idle', 'launching 은 idle 로 접는다(statusOf 규칙)');
});

test('1-C. 같은 와이어 state 는 재방출하지 않는다(훅 7종 폭주 차단) + 좌표 미상은 방출 안 함', async () => {
  const frames = [];
  armAgentState(frames);
  const key = KEY(1000300);
  const id = { cwdRel: 'proj/a', tid: 1000300, agent: 'claude' };
  await agentState.applyHook(key, { ...id, event: 'prompt' });                       // working
  await agentState.applyHook(key, { ...id, event: 'notification', notificationType: 'auth_success' }); // 무변경
  await agentState.applyHook(key, { ...id, event: 'prompt' });                       // working(중복)
  assert.strictEqual(frames.length, 1, 'version 만 오른 갱신으로 프레임이 늘어선 안 된다');
  // 상태가 실제로 바뀌면 즉시 나간다(알림 REFIRE 8초 창과 겹쳐 지연되지 않는다).
  await agentState.applyHook(key, { ...id, event: 'permission', tool: { name: 'Bash' }, summary: '위험한 명령' });
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[1].event.state, 'permission');
  assert.ok(!('summary' in frames[1].event), '알림 body 는 상태 프레임에 실리지 않는다');

  // 좌표(cwdRel)를 아직 모르는 레코드는 방출하지 않는다 — (cwd,win) 색인이 홈 루트와 충돌한다.
  const before = frames.length;
  await agentState.applyHook(KEY(1000301), { event: 'prompt', tid: 1000301 });
  assert.strictEqual(frames.length, before, 'cwd 미상 상태를 빈 문자열로 내보내면 안 된다');
});

test('1-D. forget(터미널 소멸) = "gone" 1회 · resyncAll = 강제 재방출', async () => {
  const frames = [];
  armAgentState(frames);
  const key = KEY(1000400);
  await agentState.applyHook(key, { event: 'prompt', cwdRel: 'proj/a', tid: 1000400, agent: 'claude' });
  frames.length = 0;
  assert.strictEqual(agentState.forget(key), true);
  assert.deepStrictEqual(frames.map((f) => f.event.state), ['gone']);

  // resync — back 재시작으로 라스트-스테이트 인덱스가 비었을 때 현재 스냅샷을 다시 밀어 넣는다.
  frames.length = 0;
  await agentState.applyHook(KEY(1000401), { event: 'prompt', cwdRel: 'proj/a', tid: 1000401, agent: 'claude' });
  frames.length = 0;
  const r = agentState.resyncAll();
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].event.state, 'working');
});

test('1-E. cap 없는 back(구 서버) = 방출 0건 + 아무 일도 없다(기존 폴백 유지)', async () => {
  agentState._reset();
  agentState.configure({ now: () => T0, notify: async () => {}, log: null, emit: null }); // 기본 경로(control.sendEvent)
  // 이 프로세스엔 제어 WS 도 serverCaps 도 없다 = 구 back 과 동일한 조합.
  assert.strictEqual(control.hasServerCap('agentstate.v1'), false);
  assert.strictEqual(control.sendEvent({ type: 'agent_state', event: {} }, 'agentstate.v1'), false,
    'cap 미선언이면 sendEvent 는 보내지 않고 false 여야 한다');
  const r = await agentState.applyHook(KEY(1000500), { event: 'prompt', cwdRel: 'proj/a', tid: 1000500, agent: 'claude' });
  assert.strictEqual(r.ok, true, '방출 실패가 훅 처리를 깨뜨려선 안 된다');
  assert.strictEqual(agentState._lastEmitted.size, 0, '전송 실패는 캐시에 남기지 않는다(다음 기회에 재시도)');
  // 상태/알림 경로는 그대로 살아 있다.
  assert.strictEqual(agentState.statusOf(KEY(1000500)), 'working');
  agentState._reset();
});

test('1-F. 데몬 caps 선언 + control 배선(방출 코드가 있는 커밋에서만 선언한다)', () => {
  assert.ok(control.DAEMON_CAPS.includes('agentstate.v1'), '방출 코드가 있으면 선언한다');
  assert.ok(control.daemonCaps().includes('agentstate.v1'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'control.js'), 'utf8');
  assert.match(src, /agent-state'\)\.start\(\{\s*emit:\s*\(frame\)\s*=>\s*sendEvent\(frame,\s*'agentstate\.v1'\)/,
    'agent-state 기동 시 emit 을 주입해야 한다(cap 게이팅은 sendEvent 안)');
  const ack = src.slice(src.indexOf("msg.type === 'hello_ack'"), src.indexOf("msg.type === 'lan_grant'"));
  assert.match(ack, /hasServerCap\('agentstate\.v1'\)[\s\S]{0,200}resyncAll\(\)/,
    '리싱크는 서버 선언 확인 뒤에만(구 서버에 프레임을 던지지 않는다)');
});

test('1-G. 워치 셸 복귀 = "gone" · "gone" 뒤에는 어떤 상태도 재방출되지 않는다(토글 자가 재점등 차단)', async () => {
  // 와이어 계약에서 'idle' 은 "에이전트가 붙어 있고 유휴" 다. 셸 복귀(에이전트 프로세스 소멸)를
  //  'idle' 로 기록하면 두 방향으로 조용히 죽는다 — 아래 ①②가 그 두 입구다(부록A #1 의 변종).
  const frames = [];
  let t = T0;
  agentState._reset();
  agentState.configure({
    now: () => t, notify: async () => {}, log: null,
    emit: (f) => { frames.push(f.event.state); return true; },
  });

  // ① 훅이 없는 에이전트(gemini · --settings 직접 지정 · idle 중 kill -9): 훅 지배가 없으므로 폴백이
  //    authoritative 다. 셸 복귀가 'idle' 이면 마지막 방출값이 'idle' 로 남아 **빈 셸 탭에 Chat 토글이
  //    stale 상한(15분)까지 켜진 채 굳는다**(push 가 있는 순간 tab.cmd 폴백은 건너뛰어진다).
  const k1 = KEY(1000600);
  const id1 = { tid: 1000600, cwdRel: 'proj/a', agent: 'claude' };
  await agentState.applyWatch(k1, { ...id1, observedState: 'working', seed: true });
  await agentState.applyWatch(k1, { ...id1, observedState: 'idle' });
  assert.deepStrictEqual(frames, ['working', 'idle']);
  frames.length = 0;
  for (let i = 0; i < 3; i++) {                       // 폴링 3틱(2s 주기) 동안 셸만 보인다
    t += 2000;
    await agentState.applyWatch(k1, { tid: 1000600, cwdRel: 'proj/a', observedState: null, shell: true });
  }
  assert.deepStrictEqual(frames, ['gone'], '셸 복귀는 idle 이 아니라 소멸이다(그리고 폴링마다 재방출하지 않는다)');
  assert.strictEqual(agentState.wireStateOf(agentState._states.get(k1)), 'gone');
  assert.strictEqual(agentState.legacyStatusOf(k1), 'idle',
    '레거시 3값(cpt terminal wait --for idle)은 그대로여야 한다 — ended 는 idle 로 접힌다');

  // ② 훅이 있는 경우: session_end 가 'gone' 을 보낸 뒤 그 터미널을 닫지 않고 10분(HOOK_GOVERN_MS) 두면
  //    훅 지배가 풀린다. 이때 같은 셸 관찰이 상태를 'idle' 로 되돌리면 **이미 꺼진 토글이 스스로 되켜진다**.
  frames.length = 0;
  const k2 = KEY(1000601);
  const id2 = { tid: 1000601, cwdRel: 'proj/a', agent: 'claude' };
  await agentState.applyHook(k2, { ...id2, event: 'session_start' });
  await agentState.applyHook(k2, { ...id2, event: 'prompt' });
  await agentState.applyHook(k2, { ...id2, event: 'stop' });
  await agentState.applyHook(k2, { ...id2, event: 'session_end' });
  assert.deepStrictEqual(frames, ['idle', 'working', 'idle', 'gone']);
  frames.length = 0;
  t += agentState.HOOK_GOVERN_MS + 1;
  assert.strictEqual(agentState.hookGoverned(k2), false, '10분 뒤 폴백이 다시 authoritative 가 된다(전제)');
  for (let i = 0; i < 3; i++) {
    t += 2000;
    await agentState.applyWatch(k2, { tid: 1000601, cwdRel: 'proj/a', observedState: null, shell: true });
  }
  assert.deepStrictEqual(frames, [], "'gone' 을 보낸 뒤에는 어떤 상태도 재방출되지 않는다");
  agentState._reset();
});

// ══════════════════════════════════════════════════════════════════════════
//  갭 2 — e2ee.* cpt.sock 커맨드
// ══════════════════════════════════════════════════════════════════════════

test('2-A. e2ee.state — 열쇠 없음=none, 열쇠 있음=trusted, policy=off 우선', async () => {
  e2ee.removeState();
  e2ee.clearCache();
  let r = await call('e2ee.state');
  assert.strictEqual(r.ok, true, 'state 조회가 소켓 에러면 PC 는 E2EE 전체를 미지원으로 내려앉힌다');
  assert.strictEqual(r.result.available, true);
  // 2026-07-26 개정(계약 §2.4): 확인이 **진행 중이 아닌** 열쇠 없음은 'none'(PC "열쇠 없음", off 톤)이다.
  //  'bootstrap' 은 노란 "준비 중"(진행 중) 표기라, 아무 일도 일어나지 않는 확정 평문을 진행 중으로
  //  위장한다 = 거짓 자물쇠의 다른 얼굴. 'bootstrap' 은 checking===true 인 동안만 나간다.
  assert.strictEqual(r.result.state, 'none');
  assert.strictEqual(r.result.epoch, 0);
  assert.strictEqual(r.result.policy, 'preferred');
  assert.strictEqual(r.result.scope, 'rpc');
  assert.ok(typeof r.result.ikX === 'string' && r.result.ikX.length > 20, '지문 계산 입력(ikX)이 필요하다');
  assert.strictEqual(typeof r.result.userRef, 'string');
  assert.strictEqual(r.result.recoverySet, false);
  assert.ok(r.result.reason, '열쇠가 없는 이유를 사람이 읽을 수 있어야 한다');
  // ★ 취득 진행상태 — "확인 중" 과 "평문" 을 구분할 수 있어야 한다(거짓 자물쇠 방지). 열쇠 배관이
  //  아직 아무것도 하지 않은 상태를 'pending' 으로 주장하면 영원히 오지 않는 승인을 기다리게 된다.
  assert.strictEqual(r.result.keyState, 'none');
  assert.strictEqual(r.result.checking, false);

  // 열쇠 주입(= 다른 기기 승인/부트스트랩 이후 상태)
  e2ee.ensureIdentity({ deviceId: SELF_DEV });
  e2ee.setMasterKey(EPOCH, Buffer.alloc(32, 0x41));
  r = await call('e2ee.state');
  assert.strictEqual(r.result.state, 'trusted');
  assert.strictEqual(r.result.keyState, 'trusted');
  assert.strictEqual(r.result.epoch, EPOCH);

  // 정책 토글(킬스위치) — 로컬 상태 파일이 정본
  const off = await call('e2ee.policy', { policy: 'off' });
  assert.deepStrictEqual(off.result, { policy: 'off' });
  const offState = (await call('e2ee.state')).result;
  assert.strictEqual(offState.state, 'off', '킬스위치가 UI 상태보다 우선한다');
  assert.strictEqual(offState.keyState, 'trusted', '열쇠 보유 사실 자체는 정직하게 보고한다(정책과 별개)');
  await call('e2ee.policy', { policy: 'preferred' });
  const bad = await call('e2ee.policy', { policy: 'nonsense' });
  assert.strictEqual(bad.ok, true);
  assert.strictEqual(bad.result.ok, false, '알 수 없는 정책은 도메인 실패(result)로 — 소켓 에러 금지');
});

// 2026-07-26: 열쇠 클라이언트(2b = `../e2ee-account`)가 들어왔으므로 "계정 모듈 부재" 전제는 끝났다.
//  여기서 고정하는 것은 **모듈이 있든 없든 변하지 않아야 하는 PC 규약**이다(e2ee-local 헤더 ①):
//   · 조회(pending/keyring)는 서버가 뭘 주든 **소켓 에러로 던지지 않는다**(던지면 PC 가 E2EE 전체를
//     '미지원' 으로 내려앉혀 그 조작만이 아니라 자물쇠 표시·게이팅이 통째로 뒤집힌다).
//   · 도메인 실패(승인 대상 없음 등)는 `{ok:false}` **result** 로 온다.
//   · 모르는 커맨드만 소켓 에러(구 데몬 판정과 같은 신호).
//  이 테스트의 가짜 back 에는 `/e2ee/*` 라우트가 없다(catch-all) — 즉 "서버가 엉뚱한 응답을 주는"
//  최악의 경우에도 위 규약이 유지되는지 보는 것이다. 정상 응답 왕복은 e2ee-account.test.js 가 본다.
test('2-B. 조회는 절대 소켓 에러로 던지지 않는다 · 변형 실패는 result(E2EE 전체 미지원 금지)', async () => {
  const p = await call('e2ee.pending');
  assert.strictEqual(p.ok, true, 'pending 조회가 소켓 에러면 PC 의 E2EE 카드가 통째로 미지원이 된다');
  assert.ok(Array.isArray(p.result.pending), 'pending 은 항상 배열이어야 한다');
  assert.strictEqual(p.result.pending.length, 0);
  const k = await call('e2ee.keyring');
  assert.strictEqual(k.ok, true);
  assert.ok(Array.isArray(k.result.devices), 'devices 는 항상 배열이어야 한다');
  assert.strictEqual(k.result.devices.length, 0);
  const a = await call('e2ee.approve', { enrollmentId: 'en_1', ikX: 'x'.repeat(43) });
  assert.strictEqual(a.ok, true, '소켓 에러로 던지면 PC 카드 전체가 미지원으로 뒤집힌다');
  assert.strictEqual(a.result.ok, false);
  assert.ok(a.result.error, '사람이 읽을 수 있는 실패 사유가 있어야 한다');
  const unknown = await call('e2ee.bogus');
  assert.strictEqual(unknown.ok, false, '모르는 e2ee 명령은 명확한 실패(구 데몬 판정과 같은 신호)');
});

test('2-C. e2ee.openText — 봉인 알림 body 복호 / 열 수 없으면 locked', async () => {
  const sealed = e2ee.sealNotifBody('rm -rf 실행 승인 요청', { epoch: EPOCH });
  const r = await call('e2ee.openText', { text: sealed });
  assert.deepStrictEqual(r.result, { text: 'rm -rf 실행 승인 요청', locked: false });
  const plain = await call('e2ee.openText', { text: '평문 본문' });
  assert.deepStrictEqual(plain.result, { text: '평문 본문', locked: false });
  const foreign = await call('e2ee.openText', { text: 'cptenc:1:9:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.deepStrictEqual(foreign.result, { text: null, locked: true }, '다른 epoch/열쇠는 🔒 유지(빈 문자열 금지)');
});

test('2-D. e2ee.rpc — host 명시/미지정 AAD 왕복 + 본문 형태(앱 e2ee.ts:862 와 동일)', async () => {
  hits.length = 0;
  rpcBehavior = 'echo';
  // ① host 명시 — 본문에 hostDeviceId 를 그대로 싣고, 같은 값으로 AAD 를 만든다.
  const r1 = await call('e2ee.rpc', { method: 'fs.read', params: { path: 'a.ts' }, hostDeviceId: SELF_DEV, timeoutMs: 15000 });
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.result, { ok: true, r: { echoed: 'fs.read', params: { path: 'a.ts' } } });
  const b1 = hitsOf('/api/daemon/rpc')[0].body;
  assert.strictEqual(b1.hostDeviceId, SELF_DEV);
  assert.strictEqual(b1.timeoutMs, 15000);
  assert.strictEqual(b1.env.v, 1);
  assert.strictEqual(b1.env.suite, 'cpt-e2ee/v1');
  assert.strictEqual(b1.env.epoch, EPOCH);
  assert.ok(typeof b1.env.nonce === 'string' && typeof b1.env.ct === 'string');
  assert.strictEqual(JSON.stringify(b1).includes('fs.read'), false, '메서드명이 봉투 밖에 보인다');

  // ② host 미지정(=활성 러너 위임) — 필드를 **생략**하고 AAD 는 0 이어야 한다(§2.3 확정 규칙).
  hits.length = 0;
  const r2 = await call('e2ee.rpc', { method: 'fs.list', params: {} });
  assert.strictEqual(r2.result.ok, true);
  const b2 = hitsOf('/api/daemon/rpc')[0].body;
  assert.ok(!('hostDeviceId' in b2), '미지정은 필드를 싣지 않는다(back 도 그때 params 에 넣지 않는다)');
  assert.strictEqual(b2.timeoutMs, 15000, '기본 15s');

  // ③ 성공했는데 결과가 비어도 **null 금지** — PC 가 폴백으로 오해해 같은 변형을 평문으로 재실행한다.
  rpcBehavior = 'empty';
  const r3 = await call('e2ee.rpc', { method: 'fs.write', params: { path: 'a.ts', content: 'x' }, hostDeviceId: SELF_DEV });
  assert.deepStrictEqual(r3.result, { ok: true, r: {} });

  // ④ 원격 도메인 실패는 {ok:false,e,code} result — PC 가 그 문구를 사용자에게 보여준다.
  rpcBehavior = 'remoteError';
  const r4 = await call('e2ee.rpc', { method: 'fs.read', params: { path: 'nope' }, hostDeviceId: SELF_DEV });
  assert.strictEqual(r4.ok, true);
  assert.strictEqual(r4.result.ok, false);
  assert.strictEqual(r4.result.e, '그런 파일이 없습니다');
  assert.strictEqual(r4.result.code, 'ENOENT');

  // ⑤ 구 back(404) = 소켓 실패 → PC 가 10분 네거티브 캐시 후 평문 REST 로 폴백(§2.7)
  rpcBehavior = 'notfound';
  const r5 = await call('e2ee.rpc', { method: 'fs.read', params: { path: 'a.ts' }, hostDeviceId: SELF_DEV });
  assert.strictEqual(r5.ok, false, '미지원은 폴백 신호여야 한다(도메인 실패로 주면 IDE 에 붉은 오류가 뜬다)');
  rpcBehavior = 'echo';
});

test('2-F. epoch 회전 = 무효화 — 해제된 세대의 봉투/스트림은 열리지 않는다(옛 MK 는 읽기 전용)', async () => {
  // 전제: 현재 epoch = EPOCH(2)이고 옛 세대(1)의 MK 도 상태 파일에 **그대로 남아 있다**
  //  (e2ee.js 는 옛 스냅샷·알림 body 를 읽어야 하므로 keys 를 지우지 않는다 — rotate() 도 지우지 않는다).
  e2ee.setMasterKey(1, Buffer.alloc(32, 0x39));      // 1 < 2 라 현재 epoch 은 그대로 2
  assert.strictEqual(e2ee.epoch(), EPOCH);
  assert.strictEqual(e2ee.hasKey(1), true);

  const callSealed = (env, hostDeviceId) => new Promise((res) => control.handleSealedRpc(
    { readyState: 1, send() {} },
    { env, ...(hostDeviceId === undefined ? {} : { hostDeviceId }) },
    (out) => res({ ok: true, out }), (err) => res({ ok: false, code: err && err.code }),
  ));

  // ① 해제된 세대(epoch 1)로 봉인된 실행 요청 — 열리면 회전이 아무것도 무효화하지 않는다는 뜻이다.
  const old = await callSealed(e2ee.sealRpc('fs.write', { path: 'proj/x.txt', content: 'X' }, { epoch: 1, hostDeviceId: SELF_DEV }), SELF_DEV);
  assert.strictEqual(old.ok, false, '해제된 epoch 봉투가 열려 실행되면 revoke 가 무의미해진다');
  assert.strictEqual(old.code, 'E2EE_EPOCH_MISMATCH');
  assert.ok(!fs.existsSync(path.join(ROOT, 'proj', 'x.txt')), '거절된 봉투의 변형이 실행되면 안 된다');

  // ② 현재 세대는 그대로 왕복한다(가드가 정상 경로를 막지 않는다 = "켜도 안 켜지는" 회귀 방지).
  const cur = await callSealed(e2ee.sealRpc('fs.list', { path: 'proj' }, { epoch: EPOCH, hostDeviceId: SELF_DEV }), SELF_DEV);
  assert.strictEqual(cur.ok, true);
  assert.strictEqual(cur.out.env.epoch, EPOCH, '응답도 같은 세대로 봉인해야 뷰어가 열 수 있다');
  const opened = e2ee.openRpcResult(cur.out.env, { epoch: EPOCH, hostDeviceId: SELF_DEV });
  assert.strictEqual(typeof opened.ok, 'boolean', '응답 봉투가 실제로 열려야 한다');

  // ③ 스트림 레그도 같은 규칙 — hasKey(옛 epoch) 만 보면 해제된 세대의 세션을 **새로** 열 수 있다.
  const offer = { pub: crypto.randomBytes(32), nonce: crypto.randomBytes(32) };
  assert.throws(
    () => e2ee.beginHost({ purpose: 'pty', suite: 'cpt-e2ee/v1', epoch: 1, pub: offer.pub, nonce: offer.nonce, client: 'c1', routing: { cwd: 'proj' }, hostDeviceId: SELF_DEV }),
    /E2EE_EPOCH_MISMATCH/, '옛 세대로 새 스트림 세션을 수립할 수 있으면 회전이 무효화가 아니다',
  );
  const okBegin = e2ee.beginHost({ purpose: 'pty', suite: 'cpt-e2ee/v1', epoch: EPOCH, pub: offer.pub, nonce: offer.nonce, client: 'c1', routing: { cwd: 'proj' }, hostDeviceId: SELF_DEV });
  assert.strictEqual(okBegin.epoch, EPOCH);
  assert.ok(typeof okBegin.sid === 'string' && okBegin.sid.length > 10);

  // ④ 회전은 **살아 있는 옛 세대 세션**도 끊는다(남겨 두면 해제된 기기의 터미널/프리뷰가 계속 흐른다).
  //    끊긴 스트림은 4090(E2EE_SESSION_UNKNOWN) → 토큰 재발급 = "데몬 재기동" 과 같은 기존 복구 경로.
  assert.strictEqual(e2ee.hasSession(okBegin.sid, 'host'), true, '전제: 현재 세대 세션이 살아 있다');
  const rot = e2ee.rotate([]);
  try {
    assert.strictEqual(rot.toEpoch, EPOCH + 1);
    assert.strictEqual(e2ee.hasSession(okBegin.sid, 'host'), false, '옛 세대 세션은 회전과 함께 사라진다');
  } finally {
    // 이 파일의 나머지 테스트가 EPOCH 를 기준으로 하므로 상태를 되돌린다(다른 테스트 오염 금지).
    e2ee.removeState();
    e2ee.clearCache();
    e2ee.ensureIdentity({ deviceId: SELF_DEV });
    e2ee.setMasterKey(EPOCH, Buffer.alloc(32, 0x41));
    e2ee.setMasterKey(1, Buffer.alloc(32, 0x39));
  }

  // ⑤ 옛 MK 는 **읽기 전용 복호**로 계속 살아 있어야 한다(옛 스냅샷·지난 알림 body).
  const oldBody = e2ee.sealNotifBody('지난 세대의 알림 본문', { epoch: 1 });
  const r = await call('e2ee.openText', { text: oldBody });
  assert.deepStrictEqual(r.result, { text: '지난 세대의 알림 본문', locked: false },
    '옛 세대 열쇠를 지우면 회전 전 알림/스냅샷이 영구히 🔒 가 된다');
});

test('2-E. 킬스위치(CPT_E2EE=0) = e2ee.* 전부 명확한 실패(즉시 원복)', async () => {
  process.env.CPT_E2EE = '0';
  try {
    require('../e2ee-gate').resetCache();
    const r = await call('e2ee.state');
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /지원하지 않습니다|꺼져/);
  } finally {
    delete process.env.CPT_E2EE;
    require('../e2ee-gate').resetCache();
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  갭 4 — LAN 직결 커맨드
// ══════════════════════════════════════════════════════════════════════════

test('4-A. lan.status — clientKey 무관하게 hostDeviceId 로만 집계한다(배지 어긋남 방지)', async () => {
  lanLib.resetPaths();
  lanLocal._reset();
  // 아직 아무 경로도 없다 → relay(배지 없음). PC 는 mode==='lan' 만 본다.
  const s0 = await call('lan.status', { hostDeviceId: 12 });
  assert.strictEqual(s0.ok, true);
  assert.strictEqual(s0.result.mode, 'relay');
  assert.strictEqual(s0.result.hostDeviceId, 12);
  assert.ok(Array.isArray(s0.result.scopes));

  // 포워딩(PC JS clientKey)이 직결 중 — lan.rpc(데몬 clientKey)와 **다른 경로 엔트리**다.
  const other = lanLib.pathKey('pc-webview-abc', 12, '192.168.0.31');
  lanLib.noteProbeOk(other, 12);
  lanLib.noteProbeOk(other, 12);
  assert.strictEqual(lanLib.pathState(other), 'lan');
  const s1 = await call('lan.status', { hostDeviceId: 12 });
  assert.strictEqual(s1.result.mode, 'lan', 'clientKey 로 필터하면 프리뷰가 직결인데 배지가 안 뜬다');
  const s2 = await call('lan.status', { hostDeviceId: 13 });
  assert.strictEqual(s2.result.mode, 'relay', '다른 호스트의 경로를 섞어선 안 된다');
  lanLib.resetPaths();
});

test('4-B. lan.rpc 울타리 — 스코프/메서드/E2EE required 는 **왕복 0회**로 LAN_SCOPE(PC 가 아는 코드)', async () => {
  hits.length = 0;
  // 기본 스코프(tcp)에서는 RPC 가 닫혀 있다.
  process.env.CPT_LAN_SCOPE = 'tcp';
  let r = await call('lan.rpc', { hostDeviceId: 12, method: 'fs.read', params: { path: 'a.ts' } });
  assert.strictEqual(r.ok, true, '실패도 result 로 감싼다(소켓 에러 = 구 데몬 판정 = 30분 휴면)');
  assert.strictEqual(r.result.ok, false);
  assert.strictEqual(r.result.code, 'LAN_SCOPE');
  assert.strictEqual(hitsOf('/api/daemon/lan/grant').length, 0, 'grant 도 받지 않는다(다이얼 전 거절)');

  process.env.CPT_LAN_SCOPE = 'rpc';
  // fs.watch/unwatch 는 영구 금지(전역 단일 watcher 사고) — 왕복 0회.
  for (const m of ['fs.watch', 'fs.unwatch', 'sealed', 'agent.start', 'approval.resolve']) {
    r = await call('lan.rpc', { hostDeviceId: 12, method: m, params: {} });
    assert.strictEqual(r.result.code, 'LAN_SCOPE', `${m} 은 직결로 나가면 안 된다`);
  }
  assert.strictEqual(hitsOf('/api/daemon/lan/grant').length, 0);

  // E2EE policy=required 면 평문 LAN leg 를 쓰지 않는다(결함 #12 이중 방어).
  e2ee.setPolicy('required');
  try {
    r = await call('lan.rpc', { hostDeviceId: 12, method: 'fs.read', params: { path: 'a.ts' } });
    assert.strictEqual(r.result.code, 'LAN_SCOPE');
    assert.strictEqual(hitsOf('/api/daemon/lan/grant').length, 0);
  } finally { e2ee.setPolicy('preferred'); }

  // 실패 문구에 호스트 오프라인 오탐 유발 문자열이 절대 없어야 한다(모바일이 정규식으로 판정).
  const all = JSON.stringify(r.result);
  assert.ok(!/DAEMON_OFFLINE|데몬이 연결/.test(all), 'LAN 실패에 오프라인 문구를 섞으면 차단 오버레이 오탐');
});

test('4-C. lan.probe / lan.rpc 실제 왕복(127.0.0.1 리스너 + back grant) — Rust 주석의 result 스키마', async () => {
  process.env.CPT_LAN_SCOPE = 'rpc';
  lanLib.resetPaths();
  lanLocal._reset();
  lanLib.clearGrants();
  const rpcCalls = [];
  const started = await lanLib.start({ deviceId: SELF_DEV, machineId: 'mid-test', daemonVersion: 't' }, {
    rpc: (method, params) => { rpcCalls.push({ method, params }); return Promise.resolve({ entries: [{ name: 'a.ts' }] }); },
  }, { bindHosts: ['127.0.0.1'] });
  assert.strictEqual(started.ok, true, `LAN 리스너 기동 실패: ${started.code}`);
  LAN_PORT = started.port;
  grantBehavior = 'ok';

  // ── lan.probe: { ok:true, rttMs, endpoint:{host,port} }
  hits.length = 0;
  const p = await call('lan.probe', { hostDeviceId: SELF_DEV });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.result.ok, true, `probe 실패: ${JSON.stringify(p.result)}`);
  assert.strictEqual(typeof p.result.rttMs, 'number');
  assert.deepStrictEqual(p.result.endpoint, { host: '127.0.0.1', port: LAN_PORT });
  const gbody = hitsOf('/api/daemon/lan/grant')[0].body;
  assert.strictEqual(gbody.hostDeviceId, SELF_DEV);
  assert.strictEqual(gbody.kind, 'pc');
  assert.match(String(gbody.clientKey), /^pc-daemon-/, '데몬 뷰어 clientKey 형식(계약 §4.3)');
  assert.strictEqual(hitsOf('/api/daemon/lan/grant')[0].auth, 'Bearer cptd_test', 'deviceToken 으로 데몬이 직접 받는다');

  // ── lan.rpc: { ok:true, result }
  hits.length = 0;
  const r = await call('lan.rpc', { hostDeviceId: SELF_DEV, method: 'fs.list', params: { path: 'proj' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.result, { ok: true, result: { entries: [{ name: 'a.ts' }] } });
  assert.deepStrictEqual(rpcCalls[rpcCalls.length - 1], { method: 'fs.list', params: { path: 'proj' } },
    '릴레이와 같은 디스패처 한 벌로 위임돼야 한다');
  // 직결 성공 후에는 배지가 켜진다(같은 hostDeviceId 로 집계).
  const st = await call('lan.status', { hostDeviceId: SELF_DEV });
  assert.strictEqual(st.result.mode, 'lan', `직결 성공 뒤에는 배지가 켜져야 한다: ${st.result.mode}`);
  assert.deepStrictEqual(st.result.endpoint, { host: '127.0.0.1', port: LAN_PORT });

  // ── grant 를 못 받으면(서버 스위치 OFF) 조용히 릴레이 = PC 가 아는 코드
  lanLocal._reset();
  grantBehavior = 'unsupported';
  const u = await call('lan.rpc', { hostDeviceId: SELF_DEV, method: 'fs.list', params: {} });
  assert.strictEqual(u.result.ok, false);
  assert.strictEqual(u.result.code, 'LAN_UNSUPPORTED');
  grantBehavior = 'ok';
  lanLib.stop();
  process.env.CPT_LAN_SCOPE = 'tcp';
});

test('4-C2. lan.probe **1회**로 승격이 끝난다(승격 책임은 데몬 — 계약 §4.2)', async () => {
  // 승격 데드락의 정체: 데몬은 probe 2연속(PROMOTE_OK_STREAK=2)을 요구하는데 probe 커맨드가
  //  noteProbeOk 를 1회만 기록했다. 뷰어가 'probing' 을 "데몬이 판단 중"으로 읽고 손을 놓으면
  //  2번째 probe 가 영원히 오지 않아 경로가 'probing' 에 영구 고착하고(경로 상태에 TTL 없음),
  //  PC lan.js 의 `if (!s.direct) return null` 때문에 IDE 원격 fs 직결(remote-fs.js)이 **한 번도
  //  시작되지 않았다**(로그·오류 0건). 그래서 데몬이 왕복 1회로 승격까지 끝내야 한다.
  process.env.CPT_LAN_SCOPE = 'rpc';
  lanLib.resetPaths();
  lanLocal._reset();
  lanLib.clearGrants();
  const started = await lanLib.start({ deviceId: SELF_DEV, machineId: 'mid-test', daemonVersion: 't' },
    { rpc: () => Promise.resolve({ ok: true }) }, { bindHosts: ['127.0.0.1'] });
  assert.strictEqual(started.ok, true, `LAN 리스너 기동 실패: ${started.code}`);
  LAN_PORT = started.port;
  grantBehavior = 'ok';
  try {
    hits.length = 0;
    const p = await call('lan.probe', { hostDeviceId: SELF_DEV });
    assert.strictEqual(p.result.ok, true, `probe 실패: ${JSON.stringify(p.result)}`);
    assert.strictEqual(hitsOf('/api/daemon/lan/grant').length, 1, 'grant 는 1장만 쓴다(세션 재사용)');
    const s1 = await call('lan.status', { hostDeviceId: SELF_DEV });
    assert.strictEqual(s1.result.mode, 'lan',
      'probe 1회 뒤 상태가 probing 이면 PC 는 영원히 2번째 probe 를 쏘지 않는다(승격 데드락)');

    // 폴링을 더 돌려도 상태가 뒤집히지 않는다(배지 플래핑 금지).
    const s2 = await call('lan.status', { hostDeviceId: SELF_DEV });
    assert.strictEqual(s2.result.mode, 'lan');

    // 두 번째 probe(뷰어의 검증 폴링)도 상태를 떨어뜨리지 않는다.
    const p2 = await call('lan.probe', { hostDeviceId: SELF_DEV });
    assert.strictEqual(p2.result.ok, true);
    const s3 = await call('lan.status', { hostDeviceId: SELF_DEV });
    assert.strictEqual(s3.result.mode, 'lan');
  } finally {
    lanLib.stop();
    lanLib.resetPaths();
    lanLocal._reset();
    process.env.CPT_LAN_SCOPE = 'tcp';
  }
});

test('4-C3. 단계 개방 설정 지점 — daemon.json lanScope 가 CPT_LAN_SCOPE 를 채운다(env 우선)', () => {
  // 출하 구성에 CPT_LAN_SCOPE 를 넣는 지점이 없어 스코프가 기본 'tcp' 로 남으면, lan.rpc 는 다이얼
  //  전에 LAN_SCOPE 로 거절되고 PC 는 그것을 markUnsupported(30분 휴면 + grant 폐기)로 받는다
  //  = 서버 LAN_SCOPES 에 rpc 를 넣어도 fs 직결이 켜지지 않고, 프리뷰 tcp 직결까지 같이 죽는다.
  const prev = process.env.CPT_LAN_SCOPE;
  try {
    delete process.env.CPT_LAN_SCOPE;
    control.applyLanScope({ lanScope: 'rpc' });
    assert.strictEqual(process.env.CPT_LAN_SCOPE, 'rpc');
    assert.strictEqual(lanLib.allows('rpc'), true, '설정 파일만으로 rpc 단계가 열려야 한다');

    // env 가 이미 있으면 env 가 이긴다(테스트·1회 실험이 설정 파일에 눌리지 않게).
    process.env.CPT_LAN_SCOPE = 'tcp';
    control.applyLanScope({ lanScope: 'all' });
    assert.strictEqual(process.env.CPT_LAN_SCOPE, 'tcp');

    // 알 수 없는 값/미설정은 기본값 유지(fail-closed 방향).
    delete process.env.CPT_LAN_SCOPE;
    control.applyLanScope({ lanScope: 'everything' });
    assert.strictEqual(process.env.CPT_LAN_SCOPE, undefined);
    control.applyLanScope({});
    assert.strictEqual(process.env.CPT_LAN_SCOPE, undefined);
    assert.strictEqual(lanLib.scope(), 'tcp', '미설정 기본값은 여전히 tcp(단계 개방 = 명시적 선택)');
  } finally {
    if (prev === undefined) delete process.env.CPT_LAN_SCOPE;
    else process.env.CPT_LAN_SCOPE = prev;
  }
});

test('4-D. CPT_LAN=0(데몬 킬스위치) = lan.status 는 unsupported(거짓 배지 금지)', async () => {
  process.env.CPT_LAN = '0';
  try {
    const s = await call('lan.status', { hostDeviceId: 12 });
    assert.strictEqual(s.result.mode, 'unsupported');
    const r = await call('lan.rpc', { hostDeviceId: 12, method: 'fs.read', params: {} });
    assert.strictEqual(r.result.code, 'LAN_SCOPE');
  } finally { delete process.env.CPT_LAN; }
});

test('4-E. forward.start 가 upstream 을 전달한다(이 한 줄이 없으면 직결은 死文)', async () => {
  const forwardLib = require('../forward');
  const seen = [];
  const orig = forwardLib.startLocalForward;
  forwardLib.startLocalForward = (a) => { seen.push(a); return Promise.resolve({ ok: true }); };
  try {
    const up = {
      mode: 'lan', host: '192.168.0.31', lanPort: 47321, grantId: 'lg-abc', secret: 'c2VjcmV0MTIzNDU2Nzg5MA==',
      clientKey: 'pc-webview-abc', kind: 'pc', hostDeviceId: 12, remotePort: 5173,
    };
    const r = await call('forward.start', { port: 15173, token: 'dfw-xyz', upstream: up });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].token, 'dfw-xyz', '릴레이 토큰은 upstream 이 있어도 항상 함께 넘긴다(폴백 전제)');
    assert.ok(seen[0].upstream, 'upstream 이 유실되면 grant 는 매번 발급되는데 바이트는 영원히 서버 경유');
    assert.strictEqual(seen[0].upstream.host, '192.168.0.31');
    assert.strictEqual(seen[0].upstream.grantId, 'lg-abc');
    assert.strictEqual(seen[0].upstream.hostDeviceId, 12);
    assert.strictEqual(typeof seen[0].upstream.refresh, 'function',
      'LAN_AUTH_FAILED 1회 재발급을 위해 refresh 콜백을 주입해야 한다(grant 는 단일 사용)');
    // upstream 없는 호출은 오늘과 100% 동일(필드 추가 없음)
    const r2 = await call('forward.start', { port: 15174, token: 'dfw-2' });
    assert.strictEqual(r2.ok, true);
    assert.ok(!('upstream' in seen[1]), '구 호출 경로에 새 필드를 끼워 넣지 않는다');
  } finally { forwardLib.startLocalForward = orig; }
});

// ══════════════════════════════════════════════════════════════════════════
//  갭 5 — sync.checkpoint(내부 커맨드) · CAPABILITIES 공개 목록
// ══════════════════════════════════════════════════════════════════════════

test('5-A. sync.checkpoint 는 resolveCtx 전에 처리되는 내부 커맨드다(구 back = 즉시 폴백)', async () => {
  // 이 계약의 본체는 local-checkpoint.test.js 가 이미 고정한다. 여기서는 "가짜 back 이 /begin 을
  //  모른다"는 조건에서 **소켓이 실패로 알려 주는지**만 재확인한다(PC 가 구 경로로 폴백하는 근거).
  hits.length = 0;
  const r = await call('sync.checkpoint', { workspaceId: 'ws_ab12', reason: 'periodic', cwd: 'proj' });
  // 가짜 back 은 /begin 에 { ok:true } 를 주므로 좌표가 없다 → 반쪽 상태로 진행하지 않고 실패한다.
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error), /좌표 발급 실패/);
  assert.deepStrictEqual(urls(), ['/api/daemon/sync/checkpoint/begin']);
  assert.strictEqual(hitsOf('/api/daemon/sync/checkpoint/begin')[0].auth, 'Bearer cptd_test');
});

test('5-B. CAPABILITIES 공개 목록 — 내부/위험 커맨드는 AI 에게 노출하지 않는다', async () => {
  const caps = (await call('capabilities')).result.commands;
  for (const hidden of [
    'lan.probe', 'lan.status', 'lan.rpc',
    'e2ee.state', 'e2ee.approve', 'e2ee.rpc', 'e2ee.openText', 'e2ee.recovery.create',
    'forward.start', 'forward.stop', 'sync.checkpoint', 'daemon.shutdown', 'ui.attach',
    'approval.request', 'approval.respond', 'chat.input',
  ]) {
    assert.ok(!caps.includes(hidden), `${hidden} 은 비공개여야 한다(터미널의 AI 가 부를 수 있는 표면)`);
  }
  // 조회 전용 표면은 그대로 공개(회귀 방지).
  for (const shown of ['approval.list', 'chat.sessions', 'agent.status', 'hooks.doctor', 'terminal.list']) {
    assert.ok(caps.includes(shown), `${shown} 공개가 사라졌다`);
  }
});
