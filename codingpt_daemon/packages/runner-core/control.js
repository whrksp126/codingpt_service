/**
 * 제어 채널 — back(/api/daemon/connect)으로의 상시 아웃바운드 WS
 *
 * 데몬은 인바운드 포트를 열지 않는다. 이 연결 하나로 back 의 지시(stream_open)를
 * 받고, 스트림은 그때마다 별도 WS 를 추가 다이얼(dial-back — lib/pty.js).
 *
 * 재접속: 지수 백오프(1s→최대 30s) + 지터. back 재배포로 끊겨도 자동 복구.
 * 생존 감시: back 이 30s 마다 protocol ping(ws 가 자동 pong). 반대로 90s 동안
 * 아무 신호가 없으면 죽은 연결로 보고 terminate → 재접속.
 */
const os = require('os');
const WebSocket = require('ws');
const ptyLib = require('./pty');
const proxyLib = require('./proxy');
const fsRpc = require('./fs');
const wsRpc = require('./workspace');
const agentLib = require('./agent');
const syncLib = require('./sync');
const cptServer = require('./cpt-server');
const e2eeGate = require('./e2ee-gate'); // 봉투 적용 단계 판정(암호 코드는 ./e2ee 가 전담 — 잎 모듈이라 순환 없음)

const IDLE_TIMEOUT_MS = 90 * 1000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;

// capability 협상(설계 §2-(d)) — 게이팅은 데몬caps ∩ serverCaps ∩ 기기caps 이고, 하나라도 없으면
//  "기존 동작" 폴백이다. 따라서 **이 데몬이 실제로 처리 코드를 가진 것만** 선언한다.
//  미구현을 미리 선언하면 서버/기기가 그 기능을 켜고 데몬은 프레임을 버려 조용히 유실된다.
//  · hooks.v2 — 훅 7종 수신 + agent-state 전이/알림 단일화(기능3 1단계). 서버측 처리는 불필요하지만
//    "이 데몬은 훅으로 상태를 낸다"는 사실을 서버/기기가 알면 폴백 UI 를 접을 수 있다.
//  · agentstate.v1 — 훅/폴백 전이를 {type:'agent_state'} 프레임으로 방출(기능3 2단계). 방출 코드가
//    이 커밋에 있으므로 선언한다. 실제 전송은 sendEvent 가 **서버 선언까지 확인한 뒤**에만 하므로
//    구 back 에서는 프레임 0건 = 오늘의 폴백(tab.cmd)이 그대로 유지된다.
const DAEMON_CAPS = ['caps.v1', 'hooks.v2', 'agentstate.v1'];

// 선택 능력 — "모듈이 실제로 있고 그 함수가 실제로 있을 때만" 선언한다. 번들 버전에 따라 파일이 없을 수
//  있으므로(구 데몬) 하드코딩하면 서버/기기가 기능을 켜고 데몬은 프레임을 버려 조용히 유실된다.
//  [cap, 모듈, 필수 export] — 판정은 hello 를 보낼 때마다 다시 한다(재접속 시 최신 사실 반영).
const OPTIONAL_CAPS = [
  ['approval.v1', './approvals', 'request'],    // 기능1 원격 승인(훅 블로킹 왕복)
  ['transcript.v1', './transcript', 'handle'],  // 기능5 트랜스크립트 tail/파싱
];

function daemonCaps() {
  const caps = [...DAEMON_CAPS];
  for (const [cap, mod, fn] of OPTIONAL_CAPS) {
    const m = tryRequire(mod);
    if (m && typeof m[fn] === 'function') caps.push(cap);
  }
  // LAN 직결(임무 F) — 모듈이 실존하고 스코프가 off 가 아닐 때만 선언한다. 이 선언이 back 에게
  //  "이 데몬에 lan_grant 를 보내도 된다"는 유일한 신호다(선언 없으면 back 은 grant 라우트를
  //  LAN_UNSUPPORTED 로 돌려주고 클라는 릴레이로 조용히 돈다 = 한 스위치 원복).
  const lan = tryRequire('./lan');
  if (lan && typeof lan.start === 'function' && lan.enabled()) caps.push('lan.v1');
  // E2EE(기능2) — 모듈 실존 + 단계 스코프(킬스위치 포함)를 e2ee-gate 가 판정한다. 미구현/OFF 면
  //  아무 것도 선언하지 않으므로 서버·기기는 협상 자체를 시도하지 않고 기존 평문 경로로 돈다.
  caps.push(...e2eeGate.caps());
  // 열쇠 변화 힌트 수신(2026-07-27) — back 이 회전/승인/정책 변화 직후 제어 WS 로 `e2ee_hint` 를
  //  내려보내면 15분 폴링(TRUSTED_MS)을 기다리지 않고 즉시 keyring 을 다시 확인한다. 이 선언이
  //  back 에게 "이 데몬에 e2ee_hint 를 보내도 된다"는 유일한 신호다(없으면 back 은 프레임을
  //  만들지 않고 데몬은 폴링만 한다 = 오늘의 동작 그대로).
  //  ★ e2ee.js caps() 와 달리 **열쇠 보유를 조건으로 걸지 않는다.** 힌트가 가장 필요한 순간이
  //   열쇠가 아직 없는 때이기 때문이다(계정 부트스트랩 대기 = 백오프 상한 1시간 / 승인 대기 = 60초).
  //   조건은 (a) 힌트 핸들러가 실제로 있고 (b) E2EE 가 스코프/킬스위치로 꺼져 있지 않은 것뿐 —
  //   꺼져 있으면 열쇠 클라이언트 자체가 안 도므로 hintResync 가 무시한다(선언도 하지 않는다).
  const acct = tryRequire('./e2ee-account');
  if (e2eeGate.allows('rpc') && e2eeGate.load() && acct && typeof acct.hintResync === 'function') {
    caps.push('e2ee.hint.v1');
  }
  return caps;
}

// 신규 기능 모듈은 지연 로드한다 — 파일 하나가 없다고 데몬 전체(터미널·프리뷰)가 기동 실패하면 안 된다.
function tryRequire(mod) {
  try { return require(mod); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    console.error(`[control] ${mod} 로드 실패:`, e.message);
    return null;
  }
}

// 서버가 hello_ack 으로 회신한 능력 — 기능별 게이팅의 교집합 한쪽. 구 서버는 필드 자체를 안 보내므로
//  [] 로 남고, 그 경우 신규 기능은 전부 꺼진 채 기존 경로로 동작한다.
let serverCaps = [];
function hasServerCap(c) { return serverCaps.includes(c); }

// 현재 살아있는 제어 WS(모듈 레벨) — sendEvent 로 데몬→back 신규 프레임을 보내기 위한 참조.
let activeWs = null;

// 데몬 → back 신규 프레임 전송(게이팅 포함). 서버가 그 능력을 선언하지 않았거나 연결이 없으면
//  **보내지 않고 false** 를 돌려준다 — 호출측은 조용히 기존 동작으로 폴백해야 한다(구 back 에 신규
//  프레임을 던지면 무시되므로, "보냈다"고 믿고 응답을 기다리는 코드가 매달리는 것이 진짜 사고다).
function sendEvent(frame, cap) {
  if (cap && !hasServerCap(cap)) return false;
  if (!activeWs || activeWs.readyState !== 1) return false;
  try { activeWs.send(JSON.stringify(frame)); return true; } catch (_) { return false; }
}

// hello 프레임 — 연결 직후 1회 + **사실이 바뀌었을 때 재신고**(back 은 같은 소켓의 hello 재수신을
//  정상 경로로 처리한다: caps/e2eeEpoch/lan 갱신 + runner_status 재팬아웃 + hello_ack 회신 —
//  daemonRelayService.js:245-275). 재접속을 유발하지 않고 사실을 고칠 수 있는 유일한 수단이다.
function helloFrame(config) {
  return {
    type: 'hello',
    deviceName: config.deviceName || os.hostname(),
    platform: process.platform,
    daemonVersion: config.daemonVersion || 'unknown',
    clientType: config.clientType || 'daemon',
    caps: daemonCaps(), // 이 데몬이 처리 코드를 가진 능력(구 서버는 이 필드를 무시 — additive)
    // LAN 직결 좌표(설계 §2.5) — 사설 IP + 포트. back 은 이것을 **DB 가 아니라 conn 객체**에
    //  보관하고 grant 응답의 endpoints 로만 노출한다(LAN IP 는 휘발성 → 마이그레이션 없음).
    //  ⚠ 리스너는 hello_ack 에서 serverCaps 를 본 뒤에 열리므로(=인바운드 포트 0 불변식 보호)
    //  **첫 hello 에는 보통 없다.** 좌표는 기동 직후 lan_update 로 보낸다. 여기 값은 재접속
    //  (이미 리스너가 열려 있는 상태)에서만 채워진다 — 없으면 back 은 LAN_UNSUPPORTED 로 다룬다.
    lan: lanInfo(),
    // 이 기기가 들고 있는 계정 마스터키 epoch(0 = 열쇠 없음). 클라는 자기 grant epoch 과 같을 때만
    //  암호화를 켠다(§2.8) — 0 이면 어떤 클라와도 일치하지 않아 자동으로 평문이 된다.
    e2eeEpoch: e2eeGate.epoch(),
  };
}

// 열쇠 상태가 바뀐 직후(승인 수령·회전) 같은 소켓으로 hello 를 다시 보낸다.
//  이게 없으면 **승인 직후 몇 시간 동안** back 의 conn.caps 에 e2ee.* 가 없고 e2eeEpoch 가 0 으로
//  남는다(caps 는 연결 시점의 사실이므로). 그 사이 앱/PC 는 이 PC 를 "열쇠 없음"으로 보고 평문으로
//  돌고 잠금 배지도 꺼진 채다 — 사용자가 방금 승인했는데 아무 일도 안 일어나는 것처럼 보인다.
//  재접속으로 갱신하는 방법도 있지만 터미널/워치/에이전트 push 대상을 모두 끊으므로 쓰지 않는다.
function announceHello(config) {
  const cfg = config || lastConfig;
  if (!cfg) return false;
  return sendEvent(helloFrame(cfg));   // cap 게이팅 없음 — hello 는 구 서버도 아는 프레임이다
}
let lastConfig = null;

/**
 * back `e2ee_hint` 수신 — 열쇠 클라이언트에게 "지금 다시 확인해 봐" 를 넘긴다(§2.12).
 *
 * ★ 이 함수는 프레임에서 `kind`(로그 문자열) 외에 **아무것도 읽지 않는다.** 세대·정책을 프레임에서
 *  받아 반영하면 서버가 데몬을 옛/새 세대로 몰아넣을 수 있고, 그 순간 서버가 신뢰 경계 안으로
 *  들어온다(E2EE 의 유일한 위협모델). 정본은 e2ee-account 의 keyring 왕복 + 승인자 서명 검증이다.
 * ★ 루프를 시작하지도 않는다 — `hintResync` 가 `!started` 면 스스로 무시한다(기동은 hello_ack 에서
 *  서버 선언 e2ee.keys.v1 을 본 뒤에만). 폭주 방지(최소 간격)도 전부 그쪽 책임이다.
 */
function handleE2eeHint(msg) {
  const acct = tryRequire('./e2ee-account');
  if (!acct || typeof acct.hintResync !== 'function') return false;   // 구 번들 — 폴링만(무해)
  try {
    const r = acct.hintResync({ kind: msg && typeof msg.kind === 'string' ? msg.kind : '' });
    if (r && r.ok && !r.alreadySoon) console.log(`[control] 열쇠 힌트 수신(${(msg && msg.kind) || '?'}) — 즉시 재확인`);
    return !!(r && r.ok);
  } catch (e) {
    console.warn('[control] 열쇠 힌트 처리 실패:', (e && e.message) || e);
    return false;
  }
}

// 지연 로드 모듈로의 rpc 위임 — 모듈/함수 부재를 "명확한 실패"로 바꿔 회신한다.
//  ⚠ require 를 message 핸들러 안에서 그냥 부르면 예외가 EventEmitter 로 새어 데몬이 죽는다(uncaught).
//   동기 throw·비동기 reject 를 모두 fail 로 접는다.
function callLazy(mod, fn, argv, ok, fail) {
  const m = tryRequire(mod);
  if (!m || typeof m[fn] !== 'function') {
    fail(new Error(`이 데몬은 ${mod.replace('./', '')} 기능을 지원하지 않습니다(PC 앱 업데이트 필요)`));
    return;
  }
  try { Promise.resolve(m[fn](...argv)).then(ok).catch(fail); } catch (e) { fail(e); }
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── LAN 직결(임무 F) 배선 ────────────────────────────────────────────────
// 데몬의 "인바운드 포트 0" 불변식을 깨는 유일한 지점이라 배선을 한 곳에 모아 둔다.
//  · lan.js 는 잎 모듈(node 내장만) — control 을 require 하지 않는다. RPC 는 **주입**으로 공유해
//    dispatchRpc 한 벌을 그대로 쓴다(중복 구현 금지). 순환 require 도 자연히 없다.
//  · 리스너 기동 위치는 boot() 의 cptServer.start() **직후**다 — 구 인스턴스 인수(takeover)와
//    좀비 정리가 끝난 뒤여야 포트를 빼앗기지 않는다(§5.5: +1 포트로 도망가면 back 에 보고한
//    포트와 실제가 어긋난다).
function lanMod() {
  const m = tryRequire('./lan');
  return m && typeof m.start === 'function' ? m : null;
}
function lanInfo() {
  const m = lanMod();
  if (!m) return undefined;
  try { return m.info() || undefined; } catch (_) { return undefined; }
}
// LAN 채널이 부르는 RPC — 제어채널과 **같은 디스패처**를 탄다. 허용 집합/게이팅은 lan.js 가 판정하고
//  (fs.watch 는 전역 단일 watcher 사고 방지로 영구 제외), 여기서는 이벤트 push 대상이 없는
//  sink 를 준다(허용 집합에 push 를 동반하는 메서드가 없다는 사실과 짝을 이룬다).
// 머신 식별자 — grant 응답/chal 에 실어 뷰어가 "정말 그 PC 인가"를 대조하게 한다(자격증명 아님).
function safeMachineId() {
  try { return require('./config').machineId(); } catch (_) { return null; }
}
function lanRpc(method, params) {
  return new Promise((resolve, reject) => {
    const sink = { send() { /* LAN 경로엔 unsolicited push 가 없다 */ }, readyState: 3 };
    try { dispatchRpc(sink, method, params, resolve, reject); } catch (e) { reject(e); }
  });
}

// LAN 리스너 기동/정지 — **서버가 lan.v1 을 선언했을 때만** 연다(hello_ack 에서 호출).
//  데몬의 "인바운드 포트 0" 은 보안 불변식이다. 부팅 시점에 여는 구현은 서버 스위치를 켜지 않은
//  환경에서도 전 사용자 PC 에 포트를 여는 결과가 되어(grant 가 없어 인증은 못 뚫려도 미인증 표면이
//  생기고 "스위치 하나로 원복"이라는 운영 약속이 깨진다) 금지한다.
//  재접속 때마다 다시 판정하므로, 서버에서 스위치를 내리면 다음 재접속에서 자동으로 닫힌다.
let lanRunning = false;
async function startLanIfAllowed(config) {
  const m = lanMod();
  if (!m) return;
  const want = hasServerCap('lan.v1') && (typeof m.enabled !== 'function' || m.enabled());
  if (!want) {
    if (lanRunning) {
      try { m.stop(); } catch (_) { /* noop */ }
      lanRunning = false;
      console.log('[control] LAN 직결 리스너 정지(서버가 lan.v1 을 선언하지 않음)');
    }
    return;
  }
  if (lanRunning) {
    // 이미 열려 있으면 좌표만 다시 알린다(back 재시작으로 인덱스가 비었을 수 있다).
    const nfo = lanInfo();
    if (nfo) sendEvent({ type: 'lan_update', lan: nfo }, 'lan.v1');
    return;
  }
  try {
    const r = await m.start({ ...config, machineId: safeMachineId() }, {
      rpc: lanRpc,
      // 인터페이스 변경(Wi-Fi 전환/도킹) → 새 좌표를 back 에 알린다. 서버가 lan.v1 을 모르면
      //  sendEvent 가 false 로 접고 아무 일도 없다(구 서버 안전).
      onLanChange: (nfo) => { if (nfo) sendEvent({ type: 'lan_update', lan: nfo }, 'lan.v1'); },
    });
    lanRunning = !!(r && r.ok);
    if (lanRunning) {
      const nfo = lanInfo();
      if (nfo) sendEvent({ type: 'lan_update', lan: nfo }, 'lan.v1');
    }
  } catch (e) {
    // 실패는 전부 무해 — 릴레이 경로가 그대로 유지된다.
    console.error('[control] LAN 리스너 시작 실패:', e.message);
  }
}

// ── E2EE (기능2) ────────────────────────────────────────────────────────────
// ① 협상은 **제어채널 RPC 선협상**이다(설계서 §2.4). 스트림 WS 안에서 핸드셰이크를 하면 구 데몬이
//    그 JSON 을 셸에 그대로 타이핑한다(pty.js 텍스트 프레임 폴스루) — 인스트림 협상 영구 금지.
// ② 그래서 스트림이 열리는 시점엔 이미 세션키가 확정돼 있고, 첫 프레임부터 봉인할 수 있다
//    (= early resize 버퍼를 손대지 않아도 첫 resize 유실 함정이 재발하지 않는다).
function handleE2eeBegin(params, ok, fail) {
  const p = params || {};
  const e = e2eeGate.load();
  if (!e) {
    fail(codedError('E2EE_UNSUPPORTED', '이 데몬은 E2EE 를 지원하지 않습니다(PC 앱 업데이트 필요)'));
    return;
  }
  if (!e2eeGate.allows('rpc')) {
    fail(codedError('E2EE_DISABLED', `이 데몬에서 E2EE 가 꺼져 있습니다(scope=${e2eeGate.scope()})`));
    return;
  }
  const purpose = String(p.purpose || '');
  // 스트림(pty/tcp)은 D단계 — 스코프가 stream 미달이면 협상을 **거절**한다. 거절이 곧 안전한 폴백:
  //  back 은 e2ee:false + reason 을 클라에 돌려주고 클라는 평문 토큰으로 기존 경로를 탄다.
  if ((purpose === 'pty' || purpose === 'tcp') && !e2eeGate.allows('stream')) {
    fail(codedError('E2EE_SCOPE', `이 데몬은 스트림 암호화가 아직 꺼져 있습니다(scope=${e2eeGate.scope()})`));
    return;
  }
  try {
    // params 는 그대로 넘긴다 — routing/transport/hostDeviceId 가 트랜스크립트에 묶여, 서버가 몰래
    //  다른 PC/pane/포트/전송로로 라우팅하면 뷰어의 confirm 검증이 실패한다(다운그레이드 차단).
    Promise.resolve(e2eeGate.beginHost({ ...p, purpose })).then(ok).catch(fail);
  } catch (err) { fail(err); }
}

// 봉투 RPC(`method:'sealed'`) — 서버는 메서드명조차 못 본다. 복호 → 기존 디스패처 재사용 → 응답 봉인.
//  ⚠ 실패 응답도 반드시 봉인한다(에러 문구에 경로·파일 내용이 섞여 나오는 게 실제 유출 경로다).
//  봉인 자체가 불가능하면 평문으로 흘리는 대신 **일반화된 실패**를 회신한다.
function handleSealedRpc(ws, params, ok, fail) {
  const e = e2eeGate.load();
  if (!e || typeof e.openRpc !== 'function' || !e2eeGate.allows('rpc')) {
    fail(codedError('E2EE_UNSUPPORTED', '이 데몬은 봉투 RPC 를 지원하지 않습니다(PC 앱 업데이트 필요)'));
    return;
  }
  const p = params || {};
  const env = p.env;
  // ★ '열쇠 없음' 은 `E2EE_NO_KEY` 로 **그대로** 회신한다(뭉개지 말 것).
  //  이 데몬이 아직 계정 열쇠를 못 받은 상태는 "일시 장애" 가 아니라 **구조적 미지원**이다.
  //  예전에는 이 경우가 아래 epoch 검사(현재 0)에 걸려 EPOCH_MISMATCH, 또는 openRpc 실패를 뭉갠
  //  E2EE_OPEN_FAILED 로 나갔고 → back 이 502(일시 장애)로 올려 → 앱은 "잠깐 이상했다" 로 오인하고
  //  10분마다 같은 실패를 반복했다(진단 불가). 정본 매핑은 **501=미지원**이고 그건 back 담당이다.
  //  코드만 정직하게 주면 클라이언트는 UNSUPPORTED 캐시 → 평문 폴백으로 조용히·정확히 내려간다.
  if (typeof e.hasKey === 'function' && !e.hasKey()) {
    fail(codedError('E2EE_NO_KEY', '이 PC 에는 아직 계정 열쇠가 없습니다(기존 방식으로 계속 진행하세요)'));
    return;
  }
  // ★ 사용자 킬스위치(policy='off')는 봉투 **처리**도 끈다 — caps 선언만 끄고 처리를 남기면
  //  '끄기' 가 반쪽이 되고(열쇠가 있는 한 계속 열어 준다) 재접속 전까지 옛 caps 를 본 기기가 계속
  //  봉인해 보낸다. 501 로 회신하면 클라는 UNSUPPORTED 캐시 → 평문으로 조용히·정확히 내려간다.
  //  ⚠ 지난 알림 body 복호(openText)는 policy 와 무관하게 남긴다(끄면 과거 알림이 🔒 가 된다).
  if (typeof e.policy === 'function' && e.policy() === 'off') {
    fail(codedError('E2EE_DISABLED', '이 PC 에서 종단간 암호화가 꺼져 있습니다(기존 방식으로 계속 진행하세요)'));
    return;
  }
  // ★ AAD 의 hostDeviceId 는 **클라이언트가 요청 본문에 실은 값**이다(계약 §2.3 확정).
  //  뷰어(앱 e2ee.ts / PC)는 `hostDeviceId ?? null` 로 봉인하고 null 은 AAD 에서 u32(0) 이 된다.
  //  여기서 자기 deviceId(selfDeviceId)로 열려고 하면 **활성 러너 라우팅(host 미지정) 호출이 100%
  //  복호 실패**하고, 클라는 그것을 "서버 미지원"으로 캐시해 평문으로 내려간다 = 잠금 배지는 켜져 있고
  //  트래픽은 평문(결함 #8 동형). back 은 그 값을 평문 형제 필드로 그대로 중계한다.
  const want = p.hostDeviceId == null ? 0 : Number(p.hostDeviceId);
  const self = e2eeGate.selfDeviceId();
  // 명시된 host 가 이 기기가 아니면 거절 — 서버가 다른 PC 로 몰래 라우팅한 경우(beginHost 의 같은 가드
  //  미러). self 를 모를 때(0 = 미페어링/상태파일에 deviceId 없음)는 판정 근거가 없으므로 검사하지 않는다
  //  (여기서 막으면 정상 기기에서 봉투가 영구히 거절돼 조용한 평문 폴백이 된다).
  if (want && self && want !== self) {
    fail(codedError('E2EE_HOST_MISMATCH', '다른 기기로 지정된 봉투입니다'));
    return;
  }
  // ★ epoch 회전 = 무효화여야 한다(회전인데 무효화가 아니면 revoke 가 아무 일도 하지 않는다).
  //  e2ee.js 는 옛 epoch 의 MK 를 **영구 보존**한다(state.keys — 옛 스냅샷/알림 body 복호용).
  //  그래서 봉투가 주장한 env.epoch 를 그대로 믿고 열면, `e2ee.revoke` 로 세대를 회전한 뒤에도
  //  해제된 기기(또는 유출된 옛 복구코드) 보유자가 옛 epoch 로 봉인한 `fs.write` 봉투를 계속
  //  실행시킬 수 있다. 옛 MK 는 **읽기 전용 복호**에만 쓰고, 실행을 유발하는 봉투는 현재 세대만 받는다.
  //  · 뷰어가 회전 직후 잠깐 뒤처진 경우도 여기로 떨어지는데, back 이 코드를 보존해 5xx 로 내려주고
  //    클라는 refresh 후 평문 폴백(policy=preferred) — 오늘의 E2EE_OPEN_FAILED 와 같은 안전한 폴백이다.
  const curEp = e2eeGate.epoch();
  const envEp = Number(env && env.epoch);
  if (!Number.isInteger(envEp) || envEp < 1 || envEp !== curEp) {
    fail(codedError('E2EE_EPOCH_MISMATCH', `봉투 세대가 현재와 다릅니다(env=${env && env.epoch}, 현재=${curEp})`));
    return;
  }
  // 응답도 같은 epoch/hostDeviceId 로 봉인해야 뷰어가 열 수 있다(둘 다 AAD 에 묶여 있다).
  const encOpts = { epoch: envEp, hostDeviceId: want };
  let req = null;
  try { req = e.openRpc(env, encOpts); } catch (err) {
    // 열 수 없으면 여기서 끝 — 평문 처리로 폴스루하면 서버가 내용을 보게 된다.
    //  ★ 코어가 **이미 구분해 던진 코드는 보존한다**(뭉개면 back 의 매핑표가 죽은 항목이 된다):
    //   · E2EE_NO_KEY  — 위 가드가 대부분 잡지만 회전 레이스로 여기까지 오는 경로가 남아 있다(501).
    //   · E2EE_REPLAY  — nonce 재사용/윈도우 밖(e2ee.js:952-953). **보안 이벤트**이고 back 은 409 를
    //     준비해 뒀다(config/e2eeCodes.js SEALED_CONTRACT). 502 로 뭉개면 앱이 10분간 봉투를 아예
    //     멈추고 평문으로 고정된다 — 리플레이 공격이 곧 다운그레이드 스위치가 되는 최악의 방향이다.
    //   · E2EE_EPOCH_MISMATCH / E2EE_HOST_MISMATCH — 상태가 바뀌면 즉시 낫는 계약 위반(409).
    //  문구는 일반화를 유지한다(경로·내용 누출 금지 불변식 그대로).
    const KEEP = ['E2EE_NO_KEY', 'E2EE_REPLAY', 'E2EE_EPOCH_MISMATCH', 'E2EE_HOST_MISMATCH'];
    const code = err && KEEP.includes(err.code) ? err.code : 'E2EE_OPEN_FAILED';
    fail(codedError(code, code === 'E2EE_NO_KEY'
      ? '이 PC 에는 아직 계정 열쇠가 없습니다(기존 방식으로 계속 진행하세요)'
      : '봉투를 열 수 없습니다(열쇠/epoch 불일치)'));
    return;
  }
  const method = req && typeof req.m === 'string' ? req.m : '';
  // 재귀/승격 금지 — 봉투 안에서 다시 sealed/e2ee.* 를 부르지 못하게.
  if (!method || method === 'sealed' || method.startsWith('e2ee.')) {
    fail(codedError('E2EE_BAD_METHOD', '봉투 안의 메서드가 올바르지 않습니다'));
    return;
  }
  const sealed = (fn, arg) => {
    let out = null;
    try { out = fn(e, arg, encOpts); } catch (_) { out = null; }
    if (out) ok({ env: out });
    else fail(codedError('E2EE_SEAL_FAILED', '응답을 봉인할 수 없습니다'));
  };
  dispatchRpc(ws, method, req.p,
    (result) => sealed(e2eeGate.sealRpcResult, result === undefined ? null : result),
    (err) => sealed(e2eeGate.sealRpcError, err));
}

// 제어채널 RPC 디스패처 — 평문 경로와 봉투(sealed) 경로가 **같은 한 벌**을 탄다(분기 이중화 금지).
function dispatchRpc(ws, method, params, ok, fail) {
  if (typeof method !== 'string' || !method) { fail(new Error('method 가 필요합니다')); return; }
  // watch/unwatch 는 unsolicited push(fs_event)를 동반하므로 여기서 직접 처리(제어 ws 에 바인딩).
  if (method === 'fs.watch') {
    try {
      const r = fsRpc.startWatch(params && params.path, (ev) => {
        try { ws.send(JSON.stringify({ type: 'fs_event', event: ev.event, path: ev.path })); } catch (_) { /* noop */ }
      });
      ok(r);
    } catch (e) { fail(e); }
    return;
  }
  if (method === 'fs.unwatch') { fsRpc.stopWatch(); ok({ ok: true }); return; }
  if (method === 'net.ports') { proxyLib.listPorts(params || {}).then(ok).catch(fail); return; }
  // 멀티 터미널(tmux window) — terminal.list/new/select/close.
  if (method.startsWith('terminal.')) { ptyLib.handleTerminalRpc(method, params).then(ok).catch(fail); return; }
  // BYO 에이전트(agent.start/input/approve/…) — ws 를 넘겨 이벤트 push 대상 갱신.
  if (method.startsWith('agent.')) { agentLib.handle(method, params, ws).then(ok).catch(fail); return; }
  // 에이전트 관리(agents.list/wire/rescan) — 모바일에서도 조작 가능(사용자 확정 2026-07-27).
  //  ⚠ `agents.` 와 `agent.` 는 다른 접두사다(위 분기가 먼저 걸리지 않는다) — 순서를 바꿔도 안전.
  //  LAN 직결 allowlist 에는 넣지 않는다(lan.js 불변식: 승인·에이전트류는 서버 릴레이로 남긴다).
  if (method.startsWith('agents.')) { cptServer.handleAgentsRpc(method, params || {}).then(ok).catch(fail); return; }
  // 동기화(sync.checkpoint/materialize/status/resolve) — ws 를 넘겨 sync_event push.
  if (method.startsWith('sync.')) { syncLib.handle(method, params, ws).then(ok).catch(fail); return; }
  // 원격 승인(기능1) — 사용자 결정 배달(approval.resolve) / 정본 대조(approval.list) / 일괄 취소.
  //  블록된 훅을 풀어주는 유일한 정상 경로다. 모듈이 없으면(구 데몬) 명확한 오류로 회신해 back 이
  //  409/HOST_OFFLINE 을 사용자에게 표시하게 한다 — 조용히 성공하면 폰 카드가 영구히 남는다.
  if (method.startsWith('approval.')) { callLazy('./approvals', 'handle', [method, params], ok, fail); return; }
  // 트랜스크립트(기능5) — chat.sessions/open/since/detail/attachment/close/input.
  //  ws 를 넘겨 chat_event push 대상을 갱신한다(agent/sync 와 같은 형태).
  // chat.input 은 읽기가 아니라 **PTY 입력**이다 — transcript(읽기 전용)로 보내면 NOT_IMPLEMENTED 로
  //  떨어져 폰 채팅의 전송 버튼이 항상 실패한다. cpt-server 의 구현(로컬 소켓과 동일)으로 보낸다.
  if (method === 'chat.input') {
    const p = params || {};
    Promise.resolve()
      .then(() => cptServer.chatInput({ cwd: p.cwd, tid: p.tid != null ? p.tid : p.win, text: p.text, submit: p.submit }))
      .then(ok).catch(fail);
    return;
  }
  // chat.answer — TUI 로 폴백된 AskUserQuestion 에 원격 카드로 답한다(다이얼로그 키 조작).
  //  chat.input 과 같은 이유로 transcript(읽기 전용)가 아니라 cpt-server 구현으로 보낸다.
  if (method === 'chat.answer') {
    const p = params || {};
    Promise.resolve()
      .then(() => cptServer.chatAnswer({ cwd: p.cwd, tid: p.tid != null ? p.tid : p.win, answers: p.answers, expect: p.expect }))
      .then(ok).catch(fail);
    return;
  }
  if (method.startsWith('chat.')) { callLazy('./transcript', 'handle', [method, params, ws], ok, fail); return; }
  // 워크스페이스 스캐폴드/루트 지정(ws.getRoot/setRoot/create).
  if (method.startsWith('ws.')) { wsRpc.handle(method, params).then(ok).catch(fail); return; }
  fsRpc.handle(method, params).then(ok).catch(fail);
}

// ── LAN 단계 개방 스위치(영속 설정 지점) ─────────────────────────────────────
// LAN 직결의 `rpc` 단계(= IDE 원격 fs 직결)는 데몬 스코프 `CPT_LAN_SCOPE` 로 게이팅되는데, 출하
//  구성에서 그 문자열을 **설정하는 지점이 아무 데도 없었다**(PC 사이드카 spawn env·번들 스크립트·
//  packages/daemon 전부 0건) → 기본값 'tcp' 로 남고 → `lan.rpc` 가 다이얼 전에 `LAN_SCOPE` 로
//  거절되고 → PC 는 그것을 markUnsupported(30분 휴면 + **grant 폐기**)로 받아 프리뷰 tcp 직결까지
//  같이 죽는다. 서버 `LAN_SCOPES` 에 rpc 를 넣어도 켜지지 않는 "구현했는데 안 켜지는" 상태였다.
//  → 영속 설정 지점을 만든다: `~/.codingpt/daemon.json` 의 `lanScope`("off"|"tcp"|"rpc"|"all").
//  · env(CPT_LAN_SCOPE)가 이미 있으면 env 가 이긴다(테스트·1회 실험이 설정 파일을 건드리지 않게).
//  · 기본값은 그대로 'tcp' — 단계 개방은 fail-closed 방향을 유지한다. 정책 정본은 여전히 서버다
//    (`LAN_SCOPES` 에 rpc 가 없으면 grant 에 scope 가 실리지 않아 클라 수정 없이 꺼진다).
//  · ⚠ 재페어링은 daemon.json 을 새로 쓰므로(계정 전환 = 클린 슬레이트) 이 값도 다시 넣어야 한다.
function applyLanScope(config) {
  if (process.env.CPT_LAN_SCOPE) return;                     // env 우선
  const v = String((config && config.lanScope) || '').trim().toLowerCase();
  if (!v) return;
  if (!['off', 'tcp', 'rpc', 'all'].includes(v)) {
    console.warn(`[control] daemon.json lanScope 값을 무시합니다(off|tcp|rpc|all): ${v}`);
    return;
  }
  process.env.CPT_LAN_SCOPE = v;
  console.log(`[control] LAN 스코프 = ${v} (daemon.json lanScope)`);
}

function run(config) {
  let backoff = BACKOFF_MIN_MS;
  let ws = null;
  let idleTimer = null;
  lastConfig = config;   // announceHello(열쇠 변화 시 재신고)가 hello 를 다시 만들 때 쓴다

  applyLanScope(config);   // 리스너/커맨드가 스코프를 읽기 전에(= 어떤 boot 단계보다 먼저)

  // cpt 소켓·shim·WS 연결은 파일 하단 boot() 에서 — 기존 인스턴스 인수(takeover) 후 순서대로.

  // PTY 스트림이 흐르는 핵심 WS(leg B). relayWsUrl(예: wss://codingpt-direct — CF 우회 직결) 이 있으면
  //  WS 만 그리로 보내 지연을 줄이고(REST/pair 는 serverUrl=CF 유지), 없으면 serverUrl 에서 파생(기존).
  const wsBase = config.relayWsUrl
    ? config.relayWsUrl.replace(/\/+$/, '')
    : config.serverUrl.replace(/^http/, 'ws');
  const wsUrl = wsBase + '/api/daemon/connect';

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn('[control] 90초간 신호 없음 — 연결 재수립');
      try { ws.terminate(); } catch (_) { /* noop */ }
    }, IDLE_TIMEOUT_MS);
  };

  const connect = () => {
    console.log(`[control] 연결 시도 → ${wsUrl}`);
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${config.deviceToken}` } });

    ws.on('open', () => {
      try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ } // Nagle off — RPC/resize 응답성
      backoff = BACKOFF_MIN_MS;
      bumpIdle();
      ws.send(JSON.stringify(helloFrame(config)));
      activeWs = ws;
      cptServer.setControlWs(ws); // cpt ui_command 전송로 갱신
      console.log('[control] 연결됨 — 지시 대기 중 (Ctrl+C 로 종료)');
    });

    // 업그레이드 거부(101 아님) — 401/403 = deviceToken 무효(계정 탈퇴/기기 해제). 재시도 무의미,
    //  방치하면 백오프 재연결이 영원히 돈다(고아 데몬 폭주). 즉시 종료한다.
    //  그 외 상태코드(프록시 5xx 등)는 일시 장애로 보고 기존 close 경로로 재접속을 잇는다.
    ws.on('unexpected-response', (_req2, res2) => {
      const sc = res2 && res2.statusCode;
      if (sc === 401 || sc === 403) {
        console.error('[control] 서버가 이 기기의 등록을 거부했습니다(계정 탈퇴/기기 해제). `pair` 를 다시 실행하세요.');
        process.exit(1);
      }
      try { ws.terminate(); } catch (_) { /* noop */ }
      ws.emit('close', 1006, `unexpected-response ${sc || ''}`); // close 핸들러(중복 가드 내장)로 재접속 스케줄
    });

    ws.on('ping', bumpIdle);
    ws.on('message', (data, isBinary) => {
      bumpIdle();
      if (isBinary) return;
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'hello_ack') {
        // serverCaps 는 재연결마다 갱신(서버 배포로 늘거나 줄 수 있다). 부재 = 구 서버 = [].
        serverCaps = Array.isArray(msg.serverCaps) ? msg.serverCaps.filter((c) => typeof c === 'string') : [];
        console.log(`[control] 서버 확인 (serverTime=${msg.serverTime}${serverCaps.length ? `, serverCaps=${serverCaps.join(',')}` : ', serverCaps=없음(구 서버)'})`);
        // 대기 중 승인 재광고 — back 이 재시작하면 인메모리 pending 인덱스가 통째로 사라지지만
        //  데몬 쪽 훅은 그대로 블록된 채 살아 있다(정본은 데몬). 같은 id 로 재등록해 응답 경로를 되살린다.
        //  ⚠ ws.on('open') 이 아니라 여기서 부른다 — 승인은 caps 게이팅 대상이고 serverCaps 는
        //   hello_ack 에서야 확정된다. open 시점에 부르면 구 서버에도 재광고를 던지게 된다.
        if (hasServerCap('approval.v1')) {
          const approvals = tryRequire('./approvals');
          if (approvals && typeof approvals.resync === 'function') {
            Promise.resolve()
              .then(() => approvals.resync())
              .then((r) => { if (r && r.total) console.log(`[control] 대기 중 승인 재광고 ${r.resynced}/${r.total}건${r.failed ? ` (실패 ${r.failed})` : ''}`); })
              .catch((e) => console.warn('[control] 승인 재광고 실패:', (e && e.message) || e));
          }
        }
        // 에이전트 상태 리싱크 — back 이 재시작하면 라스트-스테이트 인덱스가 비지만 데몬의 상태는
        //  그대로다. 서버가 cap 을 선언했을 때만(구 서버에 프레임을 던지지 않게) 현재 스냅샷을 재방출한다.
        if (hasServerCap('agentstate.v1')) {
          try {
            const r = require('./agent-state').resyncAll();
            if (r && r.sent) console.log(`[control] 에이전트 상태 리싱크 ${r.sent}/${r.total}건`);
          } catch (e) { console.warn('[control] 상태 리싱크 실패:', (e && e.message) || e); }
        }
        // E2EE 계정 열쇠 클라이언트(기능2 2b) — **서버가 e2ee.keys.v1 을 선언했을 때만** 돌린다.
        //  이게 없으면 데몬은 열쇠를 얻는 경로가 아예 없어(계약 §2.6) e2ee.caps() 가 영구히 [] 이고,
        //  앱이 봉인을 시도해도 데몬이 못 열어 "암호화된 척하는 평문" 이 된다. 승인/회전 결과의 **정본은
        //  pull** 이고(back 의 `e2ee_hint` 는 그 pull 을 앞당기는 가속기일 뿐 — §2.12), 모든 대기는
        //  e2ee-account 의 지수 백오프 + 상한이 관리한다(부팅/재접속 폭주 금지).
        //  ⚠ caps 는 **다음 hello** 부터 e2ee.* 를 싣는다(열쇠 수령 시점엔 이미 연결돼 있으므로).
        //   그래서 열쇠 수령 직후 봉투 RPC 를 받으려면 재접속이 필요하지 않도록 back 은 caps 를
        //   게이팅에만 쓰고(라우트는 항상 존재) 데몬은 sealed 를 언제나 처리한다 — 지금 구조가 그렇다.
        if (hasServerCap('e2ee.keys.v1')) {
          const acct = tryRequire('./e2ee-account');
          if (acct && typeof acct.start === 'function') {
            try {
              // onKeyChange = 열쇠가 생기거나 세대가 바뀐 직후 hello 재신고(caps·e2eeEpoch 즉시 반영).
              const r = acct.start({ onKeyChange: () => announceHello(config) });
              if (!r || !r.already) console.log(`[control] E2EE 열쇠 클라이언트 시작(첫 확인 ${Math.round((r && r.firstRunInMs) || 0)}ms 후)`);
              else acct.resync();   // 재접속 — throttle 이 폭주를 막는다(30s 최소 간격)
            } catch (e) { console.warn('[control] E2EE 열쇠 클라이언트 시작 실패:', (e && e.message) || e); }
          }
        }
        // LAN 경로 부활 — 제어 WS 가 다시 붙었다 = 그 사이 이 기기가 망을 잃었다 왔다는 뜻이다
        //  (수면 복귀·Wi-Fi 전환·90s 무신호 재수립·서버 재시작). 쿨다운을 1회 무시해 "집에 돌아왔는데
        //  직결이 다시 안 살아나는" 상태를 없앤다. **프레임을 보내지 않는 로컬 상태 조작**이라 caps
        //  게이팅 대상이 아니고, 구 서버/스위치 OFF 에서도 무해하다(아무것도 다이얼하지 않는다).
        //  첫 접속에서는 경로 엔트리가 없어 0건 = no-op(계약 §4.10).
        {
          const m = lanMod();
          if (m && typeof m.reviveAll === 'function') {
            try {
              const n = m.reviveAll('control-reconnect');
              if (n) console.log(`[control] LAN 경로 쿨다운 해제 ${n}건(재접속 부활)`);
            } catch (e) { console.warn('[control] LAN 경로 부활 실패:', (e && e.message) || e); }
          }
        }
        // LAN 직결 리스너는 **서버가 lan.v1 을 선언했을 때만** 연다(부팅 시점이 아니다).
        //  데몬의 "인바운드 포트 0" 불변식을 깨는 유일한 기능이라, 서버 스위치가 켜져 있다는 사실을
        //  확인한 뒤에만 여는 것이 옳다. 스위치를 내리면(재접속 시 caps 소멸) 즉시 닫는다.
        void startLanIfAllowed(config);
        return;
      }
      // LAN 직결 grant 사전 통지(back → 데몬) — 뷰어가 /api/daemon/lan/grant 로 받은 것과 같은
      //  grantId/secret 을 우리도 미리 받아 둔다. 이것이 "사용자 마찰 0" 인증의 전부다: 뷰어는
      //  challenge-response 로 secret 보유만 증명하고 토큰은 와이어에 흐르지 않는다.
      //  구 데몬은 이 type 을 무시하므로(조건 체인) additive — back 은 caps 'lan.v1' 로 게이팅한다.
      if (msg.type === 'lan_grant') {
        const m = lanMod();
        if (!m) return;
        const r = m.addGrant(msg);
        if (!r.ok) console.warn(`[control] lan_grant 거부: ${r.error}`);
        return;
      }
      // 열쇠 변화 힌트(back → 데몬) — "지금 keyring 을 다시 확인해 보라". 구 데몬은 이 type 을
      //  무시하므로 additive 이고, back 은 caps 'e2ee.hint.v1' 로 게이팅한다.
      if (msg.type === 'e2ee_hint') {
        handleE2eeHint(msg);
        return;
      }
      // cpt ui_command 의 결과 회신(back → 데몬) — 대기 중인 CLI 요청으로 전달.
      if (msg.type === 'ui_result' && msg.id) {
        cptServer.resolveUi(msg.id, msg);
        return;
      }
      if (msg.type === 'stream_open') {
        console.log(`[control] stream_open kind=${msg.kind}`);
        try {
          if (msg.kind === 'pty') {
            ptyLib.openPtyStream(config, msg);
          } else if (msg.kind === 'tcp') {
            proxyLib.openTcpStream(config, msg); // 프리뷰 — 로컬 포트 raw TCP 터널
          } else {
            throw new Error(`지원하지 않는 스트림 종류: ${msg.kind}`);
          }
        } catch (e) {
          console.error(`[control] 스트림 열기 실패: ${e.message}`);
          try { ws.send(JSON.stringify({ type: 'stream_fail', streamToken: msg.streamToken, message: e.message })); } catch (_) { /* noop */ }
        }
        return;
      }
      // fs RPC(list/read/write/watch/unwatch) — 요청/응답. back 이 id 로 응답을 매칭.
      if (msg.type === 'rpc' && msg.id) {
        const ok = (result) => { try { ws.send(JSON.stringify({ type: 'rpc_result', id: msg.id, ok: true, result })); } catch (_) { /* noop */ } };
        // code 를 함께 보낸다 — 서버/클라이언트가 오류를 **문구 정규식으로 추측하지 않고** 분기할 수 있게.
        //  예: 승인 중복 응답(ALREADY_RESOLVED)은 409 로 접어 카드를 즉시 철수해야 하는데, code 가 없으면
        //  back 이 한글 메시지를 정규식으로 맞춰야 하고 문구가 바뀌면 조용히 502 로 떨어진다.
        const fail = (e) => {
          try {
            ws.send(JSON.stringify({
              type: 'rpc_result', id: msg.id, ok: false,
              error: (e && e.message) || String(e),
              code: (e && e.code) || undefined,
            }));
          } catch (_) { /* noop */ }
        };
        // E2EE 스트림 세션 선협상(§2.4) — 스트림이 열리기 **전에** 세션키를 확정한다.
        if (msg.method === 'e2ee.begin') { handleE2eeBegin(msg.params, ok, fail); return; }
        // E2EE 봉투 RPC(§2.5) — 서버는 hostDeviceId/timeoutMs/봉인문 길이만 본다.
        //  구 데몬은 이 분기가 없어 fs.handle 로 떨어져 throw → 클라가 평문 라우트로 폴백(안전 실패).
        if (msg.method === 'sealed') { handleSealedRpc(ws, msg.params, ok, fail); return; }
        dispatchRpc(ws, msg.method, msg.params, ok, fail);
        return;
      }
    });

    const scheduleReconnect = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const delay = backoff + Math.floor(Math.random() * 1000);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      console.log(`[control] ${Math.round(delay / 1000)}초 후 재접속`);
      setTimeout(connect, delay);
    };

    let closed = false;
    ws.on('close', (code, reason) => {
      if (closed) return; closed = true;
      fsRpc.stopWatch(); // 이 연결에 바인딩된 감시 정리(재접속 시 앱이 다시 watch 등록)
      agentLib.detachAll(); // 이벤트 push 대상 해제(자식 claude 는 유지 — 재접속 시 backlog)
      activeWs = null;
      // 트랜스크립트: push 대상만 해제하고 tail/offset 은 유지한다(재접속 후 클라가 chat.since 로 따라잡음).
      //  ⚠ fsRpc.stopWatch() 처럼 watcher 를 닫지 말 것 — 재접속마다 tail 이 끊겨 스냅샷 재전송이 폭주한다.
      try { const t = tryRequire('./transcript'); if (t && typeof t.detachAll === 'function') t.detachAll(); } catch (_) { /* noop */ }
      // 승인은 여기서 건드리지 않는다 — 훅은 여전히 블록돼 있고 pending 의 정본은 데몬이다.
      //  재접속하면 hello_ack 에서 resync() 가 다시 광고한다(마감 타이머는 approvals 가 자체 보유).
      // 전송로 무효화 — 이걸 빼면 controlWs 가 CLOSED 인 스테일 소켓으로 남아, 대기 중이던 ui 왕복이
      //  BACK_OFFLINE 로 즉시 실패하지 못하고 UI_TIMEOUT(최대 60s)까지 매달린다. 훅을 블로킹하는
      //  경로(승인 왕복)에서는 그 지연이 곧 claude 정지 시간이므로 close 시점에 반드시 끊는다.
      cptServer.setControlWs(null);
      console.warn(`[control] 연결 끊김 code=${code} reason=${reason || ''}`);
      if (code === 4001) { // revoked — 재페어링 필요
        console.error('[control] 서버에서 이 기기의 연결이 해제되었습니다. `pair` 를 다시 실행하세요.');
        process.exit(1);
      }
      if (code === 4000) { // replaced — 같은 기기의 새 데몬이 연결됨. 재접속하면 서로 밀어내는
        //  핑퐁(재연결 폭주)이 되므로 구 인스턴스는 조용히 물러난다(takeover 소켓이 못 잡는
        //  다른 stateDir/구버전 고아까지 이 경로로 정리됨).
        console.error('[control] 이 기기의 새 데몬 인스턴스로 대체되었습니다 — 이 인스턴스를 종료합니다.');
        process.exit(0);
      }
      scheduleReconnect();
    });
    ws.on('error', (e) => {
      console.warn(`[control] WS 오류: ${e.message}`);
      // 'close' 가 뒤따르지 않는 초기 접속 실패도 있어 close 핸들러와 중복 방지.
      if (closed) return; closed = true;
      activeWs = null;
      cptServer.setControlWs(null); // close 를 거치지 않는 경로도 전송로를 끊는다(위 close 주석 참조)
      try { ws.terminate(); } catch (_) { /* noop */ }
      scheduleReconnect();
    });
  };

  (async () => {
    // 같은 stateDir 의 기존 인스턴스가 살아있으면 정상 종료를 지시하고 대체(새 인스턴스 승리) —
    //  둘이 단일 control WS 를 서로 뺏는 replaced 재접속 폭주 방지. WS 연결 전에 수행해야 무쟁탈.
    try {
      // 소켓 무관 백스톱 먼저 — sock 을 잃은 좀비 데몬(takeover 사각지대)까지 ps 로 훑어 정리.
      const strays = await cptServer.killStrayDaemons();
      if (strays) console.log(`[control] 다른 데몬 프로세스 ${strays}개 정리(단일 인스턴스 강제)`);
      // 그다음 sock 소유자 graceful 인수(정상 경로).
      const took = await cptServer.takeoverExisting();
      if (took) console.log('[control] 기존 데몬 인스턴스 인수 완료(구 인스턴스 종료 지시)');
    } catch (_) { /* noop */ }
    // cpt 컨트롤 소켓 — 터미널 안의 AI/사용자가 `cpt` CLI 로 서비스를 조작하는 로컬 진입점.
    try { cptServer.start(config); } catch (e) { console.error('[control] cpt 소켓 시작 실패:', e.message); }
    // ⚠ LAN 직결 리스너는 **여기서 열지 않는다.** 데몬의 불변식은 "인바운드 포트 0" 이고,
    //  리스너를 여는 것은 그 불변식을 깨는 일이라 **서버가 그 기능을 쓴다고 선언했을 때만** 열어야 한다.
    //  부팅 시점에 열면 서버 스위치(LAN_DIRECT_ENABLED)를 켜지 않은 환경의 모든 사용자 PC 가 사설
    //  인터페이스마다 포트를 여는 결과가 된다(grant 가 없어 인증은 못 뚫리지만, 미인증 표면이 생기고
    //  "스위치 하나로 원복"이라는 운영 약속이 깨진다).
    //  → 실제 기동은 hello_ack 에서 serverCaps 를 확인한 뒤(startLanIfAllowed). 좌표는 lan_update 로 보낸다.
    // shim(cpt/claude/codex 래퍼 + claude 훅 설정) 멱등 생성 — 터미널 PATH 주입은 pty.js 가 담당.
    //  ★ 비동기판을 쓴다 — 감지(로그인 셸 PATH 포함)를 먼저 끝내야 "설치된 것만 감싸기"가 정확하다.
    //   실패해도 부팅을 막지 않는다(래퍼가 없으면 사용자는 훅 없이 평소대로 쓰게 되는 열화 동작).
    require('./shim').ensureShimsAsync()
      .catch((e) => console.error('[control] shim 생성 실패:', e.message));
    // cpt 스킬 스텁을 ~/.claude/skills 에 설치 — claude 가 cpt 를 스스로 인지·사용하게(opt-out: CPT_SKILL_INSTALL=0).
    try { require('./skills').ensureSkillStub(); } catch (e) { console.error('[control] 스킬 스텁 설치 실패:', e.message); }
    // 첨부 저장소(<stateDir>/attachments) 보장 + 7일 초과 파일 삭제 — 베스트에포트(실패 무해).
    cleanupAttachments();
    // 신선도 보고 루프(사이드바 미커밋/미푸시 배지) — 60s 주기, 변화시에만 서버 기록.
    try { require('./freshness').start(); } catch (e) { console.error('[control] freshness 시작 실패:', e.message); }
    // 에이전트 상태의 단일 소유자 — 훅(1차)과 agent-watch(폴백)의 보고를 받아 전이·알림을 판정한다.
    //  agent-watch 보다 먼저 띄운다(agent-watch 가 lazy require 하므로 순서 의존은 없지만 의도를 드러냄).
    //  emit 주입 = 상태 방출로(기능3 2단계). cap 게이팅은 sendEvent 안에 있어 구 back 에서는 무발화다.
    try {
      require('./agent-state').start({ emit: (frame) => sendEvent(frame, 'agentstate.v1') });
    } catch (e) { console.error('[control] agent-state 초기화 실패:', e.message); }
    // 트랜스크립트 바인딩(세션↔터미널) 정리 — 30일 초과분 삭제. 모듈이 없는 구 번들이면 조용히 건너뛴다.
    try { const t = tryRequire('./transcript'); if (t && typeof t.pruneBinds === 'function') t.pruneBinds(); } catch (e) { console.error('[control] 바인딩 정리 실패:', e.message); }
    // 에이전트 완료 폴백 감지 — 훅이 안 걸린 터미널의 title/process-exit 전이를 관찰해 알림(안전망).
    try { require('./agent-watch').start(); } catch (e) { console.error('[control] agent-watch 시작 실패:', e.message); }
    // TUI 폴백 질문 재광고 — 데몬 재시작이 회수한 승인 배너를 미응답 질문에 한해 되살린다.
    try { require('./question-revive').start(); } catch (e) { console.error('[control] question-revive 시작 실패:', e.message); }
    // 스테일 뷰 세션 리퍼 — 시작 시 1회 + 주기(120s). 버려진 pane 뷰 세션(--p-/--v-/--c-)이 영구
    //  tmux 소켓에 무한 누적되는 것을 막는다(attach 없는 뷰만·primary 셸은 보존). idleSec grace 로
    //  방금 만든 뷰는 안 건드림. 데몬 수명 내내 소켓을 스스로 청소한다.
    const reap = () => {
      ptyLib.reapStaleViews()
        .then((n) => { if (n) console.log(`[control] 스테일 뷰 세션 ${n}개 정리`); })
        .catch(() => { /* 서버 없음 등 — 다음 주기 */ });
      // 낡은 터미널 자가치유 — shim 갱신 전에 열린 idle 셸을 respawn 해 훅 배선을 소급 적용.
      //  (부팅 시 1회 + 주기 — 실행 중이던 claude 를 끝내 idle 이 된 낡은 셸도 다음 주기에 치유)
      ptyLib.healStaleTerminals()
        .then((n) => { if (n) console.log(`[control] 낡은 터미널 ${n}개 자가치유(respawn)`); })
        .catch(() => { /* 다음 주기 */ });
    };
    // 첫 reap 은 지연한다 — 앱/데몬이 함께 재기동되는 순간(특히 PC 앱 업데이트: 다운로드+설치가
    //  리퍼 grace(90s)를 넘겨 뷰 세션이 idle 로 판정됨)에, 클라이언트가 레이아웃을 복원해 자기 뷰
    //  세션에 재attach 하기 "전에" 리퍼가 그 세션을 죽이면 attach 가 "can't find window/session"
    //  으로 터진다(사용자가 매 업데이트마다 본 PC 터미널 오류의 근원). 재attach 하면 attach>0 이라
    //  이후엔 안 죽으므로, 첫 청소를 미뤄 복원이 먼저 끝나게 한다(누적 스테일은 15s 뒤/주기로 정리).
    const firstReap = setTimeout(reap, 15000);
    if (firstReap.unref) firstReap.unref();
    const reapTimer = setInterval(reap, 120000);
    if (reapTimer.unref) reapTimer.unref();
    connect();
  })();
}

// 첨부 저장소 정리 — 모바일이 fs.write(base64) 로 올린 이미지가 ~/.codingpt/attachments/ 에 쌓인다.
//  부팅 시 디렉토리를 보장하고 7일 초과 파일만 삭제(베스트에포트 — 개별 실패는 다음 부팅에 재시도).
function cleanupAttachments() {
  const fs = require('fs');
  const path = require('path');
  const runtime = require('./runtime');
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    const dir = path.join(runtime.stateDir(), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const cut = Date.now() - MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs < cut) fs.unlinkSync(p);
      } catch (_) { /* 개별 파일 실패 무시 */ }
    }
  } catch (e) { console.error('[control] 첨부 정리 실패:', e.message); }
}

module.exports = {
  run,
  DAEMON_CAPS,   // 항상 켜져 있는 기본 능력(선택 능력은 daemonCaps() 가 모듈 존재로 판정)
  daemonCaps,
  helloFrame,      // 연결 시 신고 프레임(테스트가 caps/e2eeEpoch 동승을 고정한다)
  announceHello,   // 열쇠 변화 직후 재신고(재접속 없이 caps·e2eeEpoch 갱신)
  handleE2eeHint,  // back e2ee_hint 프레임 처리(테스트가 실제 WS 로 받은 프레임을 그대로 넣는다)
  hasServerCap,  // 기능별 게이팅용(기능1 승인 왕복 등에서 사용) — 연결 전/구 서버면 항상 false
  sendEvent,     // 데몬→back 신규 프레임(caps 게이팅 포함). false 면 보내지 않았다는 뜻 — 폴백할 것
  dispatchRpc,   // 제어채널 RPC 한 벌(평문/봉투 공용) — 테스트가 봉투 경로를 직접 검증할 수 있게 노출
  lanRpc,        // LAN 채널 → 같은 디스패처(주입용). 테스트가 "한 벌 공유"를 직접 검증한다
  lanInfo,       // hello 에 싣는 LAN 좌표(리스너 없으면 undefined)
  handleE2eeBegin, // E2EE 선협상 핸들러(테스트 노출 — 스코프 게이팅/거절 계약 고정용)
  handleSealedRpc, // 봉투 RPC 핸들러(테스트 노출 — "실패도 봉인" 불변식 고정용)
  applyLanScope,   // daemon.json lanScope → CPT_LAN_SCOPE(단계 개방 설정 지점 — 테스트가 고정한다)
};
