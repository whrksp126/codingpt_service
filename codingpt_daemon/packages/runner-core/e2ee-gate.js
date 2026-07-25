/**
 * E2EE 게이트 — "봉투를 씌울지/어디까지 씌울지"만 판정하는 배선 계층(암호 코드 0줄).
 *
 * 실제 암호는 `./e2ee`(암호 코어, 설계서 §2)가 전담한다. 이 파일은 그 모듈을 **지연 로드**하고
 * 단계 스코프·킬스위치를 한 곳에서 판정해 control/pty/proxy/forward/sync 가 같은 규칙을 공유하게 한다.
 * 여기에 crypto 를 넣지 말 것 — 두 벌이 되면 3구현체 골든 벡터 동치가 깨진다.
 *
 * 왜 별 파일인가: control.js 는 pty/proxy/sync 를 top-level require 한다. 판정 로직을 control 에 두면
 *  pty→control 역방향 require 가 순환이 되어 "부분 초기화된 exports" 함정을 만든다. 게이트는
 *  아무것도(무거운 것) require 하지 않는 잎 모듈이라 어느 방향에서 불러도 안전하다.
 *
 * ── 킬스위치/단계 ─────────────────────────────────────────────────────────
 *  CPT_E2EE=0            → 전면 OFF(즉시 원복). caps 선언까지 사라져 서버/기기도 평문으로 돈다.
 *                          (e2ee.js enabled() 도 같은 변수를 본다 — 이중 방어)
 *  CPT_E2EE_SCOPE=       off | rpc(기본) | snapshot | stream | all
 *    off      아무것도 봉인하지 않음
 *    rpc      제어채널 봉투 RPC(sealed) — 적용 순서 B단계
 *    snapshot rpc + 스냅샷 번들 봉인 — C단계
 *    stream   snapshot + PTY/TCP 프레임 — D단계(가장 위험, 회귀 통과 후에만 승격)
 *    all      = stream (동의어)
 *  CPT_E2EE_MODULE=<경로> → 암호 모듈 경로 override. **테스트 하네스 전용**(격리 스텁/부재 재현).
 *
 * 불변식: 모듈 부재·스코프 미달·세션 미등록 = 전부 "평문(또는 명확한 실패)". 이 파일의 어떤 경로도
 *  예외를 위로 던지지 않는다(throw 하면 터미널/프리뷰가 죽는다).
 */

// 와이어 상수(설계서 §2.4) — 모듈이 없을 때도 분기 코드가 쓰도록 기본값을 둔다(값은 e2ee.js 와 동일).
const DIR_V2H = 0x01; // 뷰어(폰/PC 앱) → 호스트(데몬)
const DIR_H2V = 0x02; // 호스트 → 뷰어
const KIND_DATA = 0x0; // raw 바이트(stdin/stdout·TCP)
const KIND_CTRL = 0x1; // 제어 JSON 원문({type:'resize',...})

const LEVELS = { off: 0, rpc: 1, snapshot: 2, stream: 3, all: 3 };

function scope() {
  if (String(process.env.CPT_E2EE || '') === '0') return 'off'; // 킬스위치 최우선
  const v = String(process.env.CPT_E2EE_SCOPE || 'rpc').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : 'rpc';
}

// stage: 'rpc' | 'snapshot' | 'stream'
function allows(stage) {
  const cur = LEVELS[scope()] || 0;
  const need = LEVELS[stage];
  return !!need && cur >= need;
}

// 암호 모듈 지연 로드 — 없으면 null(구 번들/미배포). 파일이 런타임에 생기지는 않으므로 결과를 캐시한다.
let cache = { key: null, mod: null };
function load() {
  if (scope() === 'off') return null;
  const key = process.env.CPT_E2EE_MODULE || './e2ee';
  if (cache.key === key) return cache.mod;
  let mod = null;
  try {
    mod = require(key);
  } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') console.error('[e2ee] 모듈 로드 실패:', (e && e.message) || e);
    mod = null;
  }
  cache = { key, mod };
  return mod;
}
function resetCache() { cache = { key: null, mod: null }; } // 테스트에서 모듈 경로 교체 시

// 이 기기가 들고 있는 계정 마스터키 epoch(0 = 열쇠 없음). hello 광고용.
function epoch() {
  const e = load();
  if (!e) return 0;
  try {
    if (typeof e.epoch === 'function') return Number(e.epoch()) || 0;
    if (typeof e.loadState === 'function') { const st = e.loadState(); return (st && Number(st.epoch)) || 0; }
  } catch (_) { /* 상태 파일 손상 등 — 열쇠 없음으로 취급 */ }
  return 0;
}

// 봉투 AAD 에 들어가는 이 기기의 deviceId(뷰어가 봉인할 때 쓴 값과 같아야 복호된다).
function selfDeviceId() {
  const e = load();
  try {
    const st = e && typeof e.loadState === 'function' ? e.loadState() : null;
    if (st && st.deviceId != null) return Number(st.deviceId);
  } catch (_) { /* noop */ }
  try {
    const cfg = require('./config').load();
    if (cfg && cfg.deviceId != null) return Number(cfg.deviceId);
  } catch (_) { /* noop */ }
  return 0;
}

/**
 * 이 데몬이 실제로 "처리 코드를 가진" e2ee 능력만 선언한다(control.js caps 규율).
 *  · e2ee.keys.v1 / e2ee.rpc.v1 : 키 수립 + 봉투 RPC(sealed) 처리 가능 (열쇠 보유 시 — e2ee.caps() 판정)
 *  · e2ee/v1/stream : PTY/TCP 프레임 봉투 처리 가능(스코프 stream 이상)
 * 스트림 하위 능력을 따로 선언하는 이유: 단계 승격(D단계)을 서버/기기가 사실대로 알아야
 *  "협상해놓고 프레임을 버리는" 조용한 유실이 생기지 않는다.
 */
function caps() {
  const e = load();
  if (!e || !allows('rpc')) return [];
  let base = [];
  try {
    if (typeof e.caps === 'function') base = e.caps().slice();
    else if (typeof e.begin === 'function' || typeof e.beginHost === 'function') base = ['e2ee.keys.v1', 'e2ee.rpc.v1'];
  } catch (_) { return []; }
  if (!base.length) return [];
  // 이름은 back config/caps.js 규약과 동일해야 한다 — 데몬만 다른 표기를 쓰면 교집합이 공집합이 되어
  //  협상이 영구 OFF 된다(그게 '안전한 평문'으로 위장돼 발견이 늦는다).
  if (allows('stream') && typeof e.channel === 'function') base.push('e2ee.stream.v1');
  return base;
}

function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  return Buffer.from(String(x == null ? '' : x), 'utf8');
}

// ── 스트림 세션 선협상(§2.4) ────────────────────────────────────────────────
// 호스트(데몬)측 begin. e2ee.js 는 beginHost, 구 스텁은 begin — 둘 다 받아준다.
function beginHost(params) {
  const e = load();
  if (!e) throw new Error('E2EE 모듈 없음');
  const fn = typeof e.beginHost === 'function' ? e.beginHost : (typeof e.begin === 'function' ? e.begin : null);
  if (!fn) throw new Error('E2EE begin 진입점 없음');
  return fn.call(e, params);
}

function sessionExists(sid, role) {
  const e = load();
  if (!e || !sid) return false;
  if (typeof e.hasSession !== 'function') return true; // 판정 불가 = 있다고 보고 실제 seal/open 에서 실패
  try { return !!e.hasSession(sid, role); } catch (_) { return false; }
}

/**
 * 봉인 채널 = WS 연결 1개(양방향, connId 공유). 실패는 전부 null(호출측이 평문/종료를 택한다).
 *
 * ⚠ connId 는 **연결을 여는 쪽(뷰어)** 이 정하고 호스트는 첫 수신 프레임에서 학습한다
 *   (e2ee.channelFromFrame). 호스트가 자기 connId 를 쓰면 뷰어의 open() 이 connId 불일치로
 *   전부 거부한다 — 그래서 pty/proxy(호스트)는 첫 프레임이 오기 전 출력을 버퍼링한다.
 */
function hostChannelFromFrame(sid, frame) {
  const e = load();
  if (!e || !sid || !allows('stream') || typeof e.channel !== 'function') return null;
  const buf = toBuf(frame);
  try { return e.channelFromFrame(sid, buf, 'host'); } catch (_) { /* 첫 프레임이 counter 1 이 아닐 수도 */ }
  try {
    const h = typeof e.peekFrame === 'function' ? e.peekFrame(buf) : null;
    if (h) return e.channel(sid, h.connId, 'host');
  } catch (_) { /* noop */ }
  return null;
}

// 뷰어측(데몬이 로컬 리스너 = forward.js) — 먼저 보내는 쪽이라 connId 를 스스로 만든다.
function viewerChannel(sid) {
  const e = load();
  if (!e || !sid || !allows('stream') || typeof e.channel !== 'function') return null;
  try { return e.channel(sid, null, 'viewer'); } catch (_) { return null; }
}

// 프레임 열기 — 실패는 null(폐기). 프레임 하나로 소켓을 죽이지 않는다(§6-4).
function openFrame(ch, frame) {
  try {
    const r = ch.open(toBuf(frame));
    if (!r) return null;
    return { kind: Number(r.kind) || KIND_DATA, payload: toBuf(r.payload) };
  } catch (_) { return null; }
}

// ── 봉투 RPC 응답 ───────────────────────────────────────────────────────────
// 요청(K_rpc)과 응답(K_rpcResp)은 다른 키다. e2ee.js 는 sealRpcResult/sealRpcError 를 제공한다.
function sealRpcResult(e, result, opts) {
  if (typeof e.sealRpcResult === 'function') return e.sealRpcResult(result, opts);
  if (typeof e.sealEnvelope === 'function') return e.sealEnvelope({ ok: true, r: result === undefined ? null : result }, { ...(opts || {}), dir: 'resp' });
  throw new Error('E2EE 응답 봉인 진입점이 없습니다');
}
function sealRpcError(e, err, opts) {
  if (typeof e.sealRpcError === 'function') return e.sealRpcError(err, opts);
  if (typeof e.sealEnvelope === 'function') {
    return e.sealEnvelope({ ok: false, e: (err && err.message) || String(err), code: (err && err.code) || null }, { ...(opts || {}), dir: 'resp' });
  }
  throw new Error('E2EE 응답 봉인 진입점이 없습니다');
}

// ── 스냅샷 ─────────────────────────────────────────────────────────────────
const SNAP_MAGIC = Buffer.from('435054533100', 'hex'); // "CPTS1\0" (§2.7)
// 모듈이 없어도 판정할 수 있어야 한다(암호문을 git 에 물리지 않기 위한 최후 방어선).
function isSealedSnapshot(buf) {
  const e = load();
  if (e && typeof e.isSealedSnapshot === 'function') {
    try { return !!e.isSealedSnapshot(buf); } catch (_) { /* 폴백 */ }
  }
  return Buffer.isBuffer(buf) && buf.length >= SNAP_MAGIC.length + 16 && buf.subarray(0, SNAP_MAGIC.length).equals(SNAP_MAGIC);
}

module.exports = {
  scope, allows, load, resetCache, epoch, selfDeviceId, caps,
  beginHost, sessionExists, hostChannelFromFrame, viewerChannel, openFrame,
  sealRpcResult, sealRpcError, isSealedSnapshot, toBuf,
  DIR_V2H, DIR_H2V, KIND_DATA, KIND_CTRL,
};
