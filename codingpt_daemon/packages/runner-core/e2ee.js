/**
 * e2ee.js — CodingPT E2EE 암호 코어 (스위트 `cpt-e2ee/v1`)
 *
 * 설계 정본: docs/구현설계-2026-07-25/기능2-E2EE.md  §2 와이어 계약
 * 참조 설계: docs/cmux-orca-분석-2026-07-25/03-orca-아키텍처.md §5 (Orca mobile-e2ee v2)
 *
 * 이 파일은 **플랫폼 공용 스펙의 데몬(Node) 구현**이다. 같은 바이트를 모바일(@stablelib 순수 JS)과
 * PC(Rust)가 재현해야 하므로, 아래 "와이어 규칙"을 바꿀 때는 3구현체 + test/vectors/e2ee-v1.json 을
 * 동시에 고쳐야 한다.
 *
 * ── 의존성 규율 ────────────────────────────────────────────────────────────────
 *  Node 내장 crypto 만 사용한다(신규 npm 의존성 0). tweetnacl/@stablelib 금지.
 *   X25519  crypto.diffieHellman / generateKeyPairSync('x25519')   (raw 32B ↔ DER 래핑)
 *   Ed25519 crypto.sign/verify(null, …)                            (raw 32/64B ↔ DER 래핑)
 *   HKDF    crypto.hkdfSync('sha256', …)
 *   AEAD    chacha20-poly1305(기본) / aes-256-gcm(대체) — 둘 다 Node 내장
 *
 * ── 킬스위치 ──────────────────────────────────────────────────────────────────
 *  CPT_E2EE=0 → enabled()===false. 호출부(control/pty/forward/…)는 enabled()가 false면
 *  협상 자체를 하지 않고 평문 경로를 유지한다(불변식 1·2: 절대 연결이 끊기지 않는다).
 *
 * ── 키 계층 ───────────────────────────────────────────────────────────────────
 *  MK_e  계정 마스터키 32B(epoch e≥1) — 기기 로컬에만. 서버는 봉인문만 본다.
 *   ├ K_rpc      = HKDF(MK,∅,"cpt-e2ee/v1/rpc")        요청 봉투
 *   ├ K_rpcResp  = HKDF(MK,∅,"cpt-e2ee/v1/rpc-resp")   응답 봉투
 *   ├ K_notif    = HKDF(MK,∅,"cpt-e2ee/v1/notif")      알림 body
 *   ├ K_snap     = HKDF(MK,∅,"cpt-e2ee/v1/snapshot")   스냅샷 번들
 *   └ 스트림 세션키: 임시 X25519 ECDH + MK 를 PSK 로 혼합(§2.4) → 방향별 2개 + sid + K_confirm
 *  기기 신원키(영구): IK_x(X25519, MK 봉인 수신용) / IK_ed(Ed25519, 승인 서명용)
 *
 *  MK 는 스트림을 직접 암호화하지 않는다(PSK 로만 섞음) = PFS + 계정 인증 동시 확보.
 */
'use strict';

const crypto = require('crypto');
const config = require('./config');

// ──────────────────────────────────────────────────────────────────────────────
// 0. 스위트 / 상수
// ──────────────────────────────────────────────────────────────────────────────

const SUITE = 'cpt-e2ee/v1';        // AEAD = ChaCha20-Poly1305 (IETF)
const SUITE_AES = 'cpt-e2ee/v1a';   // AEAD = AES-256-GCM (동일 KEX/KDF, AEAD만 교체)

const SUITES = {
  [SUITE]: { alg: 'chacha20-poly1305', keyLen: 32, nonceLen: 12, tagLen: 16 },
  [SUITE_AES]: { alg: 'aes-256-gcm', keyLen: 32, nonceLen: 12, tagLen: 16 },
};

// 기본 스위트. 3구현체 공통이 chacha 이므로 chacha 가 정본(모바일 WebView 는 비보안 컨텍스트라
// crypto.subtle 이 없어 어차피 순수 JS AEAD → AES 라고 이점이 없고, 순수 JS AES 는 타이밍상 더 나쁨).
function defaultSuite() {
  const s = process.env.CPT_E2EE_SUITE;
  return s && SUITES[s] ? s : SUITE;
}

const DIR = { V2H: 0x01, H2V: 0x02 };       // 뷰어→호스트 / 호스트→뷰어
const KIND = { DATA: 0x0, CTRL: 0x1 };      // 0=raw 바이트(stdin/stdout·TCP), 1=제어 JSON(resize 등)
const FRAME_VER = 0x01;

const HDR_LEN = 12;                          // [ver1][dir|kind<<4 1][connId u32][counter u48]
const TAG_LEN = 16;
const FRAME_OVERHEAD = HDR_LEN + HDR_LEN + TAG_LEN;   // 40B — 겉헤더 + 내부 헤더 사본 + 태그
const MAX_COUNTER = 0xffffffffffff;           // u48

const SESSION_TTL_MS = Number(process.env.CPT_E2EE_SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_SESSIONS = 512;
const ENV_WINDOW = 1024;                      // 봉투 리플레이 윈도우(카운터 개수)

// 도메인 문자열(전부 바이트 그대로 HKDF/AAD 에 들어간다 — 오타 = 크로스플랫폼 불일치)
const D = {
  salt: 'cpt-e2ee/v1/salt',
  session: 'cpt-e2ee/v1/session',
  grant: 'cpt-e2ee/v1/grant',
  fp: 'cpt-e2ee/v1/fp',
  rpc: 'cpt-e2ee/v1/rpc',
  rpcResp: 'cpt-e2ee/v1/rpc-resp',
  notif: 'cpt-e2ee/v1/notif',
  snapshot: 'cpt-e2ee/v1/snapshot',
  recovery: 'cpt-e2ee/v1/recovery',
};

// 메시지는 항상 `CODE: 설명` — 로그(applog/debug_log)에서 코드가 바로 보이고, 호출부가 코드로
// 분기(평문 폴백 vs 명시 에러 UI)할 수 있다.
class E2eeError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'E2eeError';
    this.code = code;
  }
}
const fail = (code, msg) => { throw new E2eeError(code, msg); };

// 킬스위치 — 데몬 전역. false 면 호출부는 평문 경로만 쓴다.
function enabled() {
  return process.env.CPT_E2EE !== '0';
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. 인코딩 / 해시 / 서명 프리미티브
// ──────────────────────────────────────────────────────────────────────────────

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function unb64u(s, expectLen) {
  if (typeof s !== 'string') fail('E2EE_ENCODING', 'b64u 문자열 아님');
  const b = Buffer.from(s, 'base64url');
  if (expectLen != null && b.length !== expectLen) {
    fail('E2EE_ENCODING', `길이 불일치: ${b.length} != ${expectLen}`);
  }
  return b;
}
const bytes = (v, len) => {
  const b = typeof v === 'string' ? unb64u(v, len) : Buffer.from(v);
  if (len != null && b.length !== len) fail('E2EE_ENCODING', `길이 불일치: ${b.length} != ${len}`);
  return b;
};

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest();
};
const hmac256 = (key, ...parts) => {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest();
};
const randomBytes = (n) => crypto.randomBytes(n);

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function u48(n) { const b = Buffer.alloc(6); b.writeUIntBE(n, 0, 6); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n), 0); return b; }

/** HKDF-SHA256. salt 는 비어도 된다(=HKDF 기본 salt). */
function hkdf(ikm, salt, info, len) {
  const s = salt == null ? Buffer.alloc(0) : (typeof salt === 'string' ? Buffer.from(salt) : salt);
  const i = info == null ? Buffer.alloc(0) : (typeof info === 'string' ? Buffer.from(info) : info);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, s, i, len));
}

// ── raw 키 ↔ Node KeyObject (DER 고정 접두사 래핑) ────────────────────────────
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const E_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const E_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

const importXPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([X_SPKI, bytes(raw, 32)]), format: 'der', type: 'spki' });
const importXPriv = (raw) => crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, bytes(raw, 32)]), format: 'der', type: 'pkcs8' });
const importEdPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([E_SPKI, bytes(raw, 32)]), format: 'der', type: 'spki' });
const importEdPriv = (seed) => crypto.createPrivateKey({ key: Buffer.concat([E_PKCS8, bytes(seed, 32)]), format: 'der', type: 'pkcs8' });
const rawPub = (keyObj) => keyObj.export({ type: 'spki', format: 'der' }).subarray(-32);

/** X25519 키쌍 — raw 32B 두 개. */
function genX25519() {
  const kp = crypto.generateKeyPairSync('x25519');
  return {
    pub: rawPub(kp.publicKey),
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
  };
}

/**
 * Ed25519 키쌍. priv 는 **64B(seed‖pub)** 로 돌려준다 — @stablelib/ed25519·tweetnacl 의
 * secretKey 표현과 동일해 3구현체가 같은 파일(e2ee.json)을 읽을 수 있다. Node 는 seed 32B 만 쓴다.
 */
function genEd25519() {
  const kp = crypto.generateKeyPairSync('ed25519');
  const seed = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = rawPub(kp.publicKey);
  return { pub, priv: Buffer.concat([seed, pub]) };
}

const sign = (priv, msg) => crypto.sign(null, Buffer.isBuffer(msg) ? msg : Buffer.from(msg), importEdPriv(bytes(priv).subarray(0, 32)));
function verify(pub, msg, sig) {
  try {
    return crypto.verify(null, Buffer.isBuffer(msg) ? msg : Buffer.from(msg), importEdPub(pub), bytes(sig, 64));
  } catch (_) { return false; }
}

/** X25519 ECDH. 저차 점(공유비밀 전부 0)은 거부. */
function x25519(priv32, pub32) {
  let ss;
  try {
    ss = crypto.diffieHellman({ privateKey: importXPriv(priv32), publicKey: importXPub(pub32) });
  } catch (e) {
    fail('E2EE_KEX', 'X25519 실패: ' + e.message);
  }
  if (ss.length !== 32 || ss.every((b) => b === 0)) fail('E2EE_KEX', 'X25519 저차 점 거부');
  return ss;
}

// ── AEAD ─────────────────────────────────────────────────────────────────────
function aeadSeal(key, nonce, aad, pt, suite) {
  const s = SUITES[suite || defaultSuite()] || fail('E2EE_SUITE', '알 수 없는 스위트');
  const c = crypto.createCipheriv(s.alg, bytes(key, 32), bytes(nonce, s.nonceLen), { authTagLength: s.tagLen });
  if (aad && aad.length) c.setAAD(aad);
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);   // ct‖tag
}
function aeadOpen(key, nonce, aad, ctTag, suite) {
  const s = SUITES[suite || defaultSuite()] || fail('E2EE_SUITE', '알 수 없는 스위트');
  const buf = Buffer.from(ctTag);
  if (buf.length < s.tagLen) fail('E2EE_AUTH', '암호문이 태그보다 짧음');
  const ct = buf.subarray(0, buf.length - s.tagLen);
  const tag = buf.subarray(buf.length - s.tagLen);
  const d = crypto.createDecipheriv(s.alg, bytes(key, 32), bytes(nonce, s.nonceLen), { authTagLength: s.tagLen });
  if (aad && aad.length) d.setAAD(aad);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch (_) {
    fail('E2EE_AUTH', '복호/인증 실패');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. 상태 파일(~/.codingpt/e2ee.json, 0600) — PC 앱과 공유
// ──────────────────────────────────────────────────────────────────────────────

/** 신규 상태 골격. */
function blankState(deviceId) {
  const ikX = genX25519();
  const ikEd = genEd25519();
  return {
    v: 1,
    suite: SUITE,
    deviceId: deviceId == null ? null : deviceId,
    ikX: { pub: b64u(ikX.pub), priv: b64u(ikX.priv) },
    ikEd: { pub: b64u(ikEd.pub), priv: b64u(ikEd.priv) },
    epoch: 0,
    keys: {},              // { "1": b64u(MK_1), "2": … }  옛 epoch 보존 = 옛 스냅샷/알림 복호
    policy: 'preferred',   // off | preferred | required
    recoverySet: false,
    updatedAt: new Date().toISOString(),
  };
}

let _stateCache = null;

function loadState() {
  if (_stateCache) return _stateCache;
  const st = config.loadE2ee();
  if (st && st.v === 1 && st.ikX && st.ikEd) { _stateCache = st; return st; }
  return null;
}

function saveState(st) {
  st.updatedAt = new Date().toISOString();
  config.saveE2ee(st);
  _stateCache = st;
  return st;
}

/** 신원키 보장(멱등) — 없으면 생성·저장하고 반환. */
function ensureIdentity(opts) {
  const o = opts || {};
  let st = loadState();
  if (!st) st = saveState(blankState(o.deviceId));
  else if (o.deviceId != null && st.deviceId !== o.deviceId) { st.deviceId = o.deviceId; saveState(st); }
  return st;
}

function forgetState() { _stateCache = null; }              // 테스트/재로드용
function removeState() { forgetState(); return config.removeE2ee(); }

function identity() {
  const st = ensureIdentity();
  return { ikX: st.ikX.pub, ikEd: st.ikEd.pub, epoch: st.epoch | 0, policy: st.policy || 'preferred' };
}

function epoch() { const st = loadState(); return st ? (st.epoch | 0) : 0; }
function policy() { const st = loadState(); return (st && st.policy) || 'preferred'; }
function setPolicy(p) {
  if (!['off', 'preferred', 'required'].includes(p)) fail('E2EE_POLICY', '알 수 없는 정책');
  const st = ensureIdentity(); st.policy = p; return saveState(st).policy;
}

/** MK 저장(승인/부트스트랩 결과). epoch 이 현재보다 크면 현재 epoch 승격. */
function setMasterKey(ep, mk) {
  const st = ensureIdentity();
  const e = Number(ep);
  if (!Number.isInteger(e) || e < 1) fail('E2EE_EPOCH', 'epoch 는 1 이상 정수');
  st.keys[String(e)] = b64u(bytes(mk, 32));
  if (e > (st.epoch | 0)) st.epoch = e;
  _acctCache.delete(e);            // 같은 epoch 를 덮어쓰는 경우(복구·재승인) 파생키 캐시 무효화
  return saveState(st);
}

/** epoch 의 MK. 없으면 E2EE_NO_KEY (호출부는 평문 폴백). */
function masterKey(ep) {
  const st = loadState();
  if (!st) fail('E2EE_NO_KEY', '열쇠 없음');
  const e = ep == null ? (st.epoch | 0) : Number(ep);
  const v = st.keys && st.keys[String(e)];
  if (!v) fail('E2EE_NO_KEY', `epoch ${e} 열쇠 없음`);
  return unb64u(v, 32);
}
const hasKey = (ep) => { try { masterKey(ep); return true; } catch (_) { return false; } };

/** 계정 최초 기기 — MK_1 자가 생성(부트스트랩). 이미 열쇠가 있으면 그대로 반환. */
function bootstrapMasterKey() {
  const st = ensureIdentity();
  if ((st.epoch | 0) >= 1 && st.keys[String(st.epoch)]) return { epoch: st.epoch | 0, created: false };
  setMasterKey(1, randomBytes(32));
  return { epoch: 1, created: true };
}

// 계정키(K_rpc/K_notif/…) 캐시 — MK 당 1회 파생.
const _acctCache = new Map();
function accountKeys(ep) {
  const e = ep == null ? epoch() : Number(ep);
  const hit = _acctCache.get(e);
  if (hit) return hit;
  const mk = masterKey(e);
  const k = {
    rpc: hkdf(mk, null, D.rpc, 32),
    rpcResp: hkdf(mk, null, D.rpcResp, 32),
    notif: hkdf(mk, null, D.notif, 32),
    snapshot: hkdf(mk, null, D.snapshot, 32),
  };
  _acctCache.set(e, k);
  return k;
}
function clearCache() { _acctCache.clear(); forgetState(); }

// Crockford base32(혼동 문자 I·L·O·U 제외) — 사람이 눈으로 읽고 옮겨 적을 수 있는 표기.
const FP32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 기기 신원 지문 — 두 화면에서 사람이 대조해 MITM(악성 서버가 공개키를 바꿔치기)을 잡는 값.
 *
 * ⚠ 엔트로피가 이 기능의 안전성 그 자체다. 짧은 숫자는 **오프라인 그라인딩으로 뚫린다**:
 *  서버는 userId 와 피해 기기의 실제 공개키를 둘 다 알고 있으므로, 자기 키쌍을 계속 갈아
 *  "같은 표시값"이 나오는 키를 찾을 수 있다. 실측(이 Mac 1코어):
 *    · 4자리 숫자(약 13비트) → 17,059회 시도 / 1.3초에 일치 키 발견
 *    · 6자리 숫자(약 20비트) → 1,018,566회 / 80초
 *  즉 사용자가 숫자를 비교해도 MITM 을 못 잡고, 승인 즉시 서버가 마스터키를 얻는다.
 *  그래서 대조용 값은 **60비트**(base32 12글자)로 낸다 — 2^60 은 오프라인 그라인딩 사거리 밖이다.
 *
 * 반환:
 *  · safety   "K7M2-9QXF-B4TR" — 보안 대조용(60비트). 승인 화면에서 이걸 비교해야 한다.
 *  · short    "0878" — **보안값이 아니다.** 승인 요청이 여러 개일 때 "어느 요청인지" 구분하는 용도.
 *             UI 에서 이 값만 비교하도록 유도하면 안 된다(문구로 역할을 분명히 할 것).
 *  · legacy   "418 209" — 구 버전 UI 호환(6자리). 신규 UI 는 safety 를 쓴다.
 */
function fingerprint(ikXPub, userId) {
  const out = hkdf(bytes(ikXPub, 32), D.fp, String(userId == null ? '' : userId), 16);
  // 60비트 = 5비트 × 12글자. 상위 8바이트에서 뽑는다.
  const hi = out.readUInt32BE(0);
  const lo = out.readUInt32BE(4);
  let v = (BigInt(hi) << 32n) | BigInt(lo);
  let s = '';
  for (let i = 0; i < 12; i++) { s = FP32[Number(v & 31n)] + s; v >>= 5n; }
  const six = out.readUInt32BE(8) % 1000000;
  const sixs = String(six).padStart(6, '0');
  return {
    safety: `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`,
    short: String(out.readUInt32BE(12) % 10000).padStart(4, '0'),
    legacy: `${sixs.slice(0, 3)} ${sixs.slice(3)}`,
    toString() { return this.safety; }, // 구 호출부가 문자열로 쓰던 것 호환
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. MK 봉인 / 해제 (기기 승인 = NaCl sealed-box 등가)
// ──────────────────────────────────────────────────────────────────────────────

function grantAad(ep, recipientIkX) {
  return Buffer.concat([Buffer.from('grant'), u32(ep), bytes(recipientIkX, 32)]);
}
function grantSigMsg(ep, recipientIkX, sealed) {
  return Buffer.concat([Buffer.from(D.grant), u32(ep), bytes(recipientIkX, 32), sha256(sealed)]);
}

/**
 * MK_epoch 를 수신 기기의 공개키로 봉인. 서버는 암호문만 본다.
 *   sealed = ephPub(32) ‖ AEAD(K, nonce=0^12, aad="grant"‖epoch‖ikX, MK)
 *   sig    = Ed25519(승인자 ikEd, "cpt-e2ee/v1/grant"‖epoch‖ikX‖SHA256(sealed))
 * @returns {{sealed:string, sig:string, epoch:number, sealedBy:string}} b64u
 */
function sealTo(recipientIkX, opts) {
  const o = opts || {};
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const mk = o.mk ? bytes(o.mk, 32) : masterKey(ep);
  const rec = bytes(recipientIkX, 32);
  const eph = genX25519();
  const ss = x25519(eph.priv, rec);
  const K = hkdf(ss, sha256(eph.pub, rec), D.grant, 32);
  const sealedBuf = Buffer.concat([eph.pub, aeadSeal(K, Buffer.alloc(12), grantAad(ep, rec), mk, SUITE)]);
  const sealed = b64u(sealedBuf);
  const st = o.ikEdPriv ? null : loadState();
  const edPriv = o.ikEdPriv ? bytes(o.ikEdPriv) : (st && unb64u(st.ikEd.priv));
  const sig = edPriv ? b64u(sign(edPriv, grantSigMsg(ep, rec, sealedBuf))) : null;
  return { sealed, sig, epoch: ep, sealedBy: o.ikEdPub || (st ? st.ikEd.pub : null) };
}

/**
 * 봉인문 해제. approverIkEd 를 주면 서명 검증(서버가 만든 위조 봉인문 주입 차단).
 * @returns {Buffer} MK 32B
 */
function openFrom(sealed, opts) {
  const o = opts || {};
  const ep = Number(o.epoch);
  if (!Number.isInteger(ep) || ep < 1) fail('E2EE_EPOCH', 'epoch 필요');
  const st = o.ikXPriv ? null : loadState();
  const priv = o.ikXPriv ? bytes(o.ikXPriv, 32) : (st ? unb64u(st.ikX.priv, 32) : fail('E2EE_NO_IDENTITY', '신원키 없음'));
  const myPub = o.ikXPub ? bytes(o.ikXPub, 32) : (st ? unb64u(st.ikX.pub, 32) : null);
  const buf = bytes(sealed);
  if (buf.length < 32 + 32 + TAG_LEN) fail('E2EE_GRANT', '봉인문이 너무 짧음');
  if (o.approverIkEd) {
    if (!o.sig) fail('E2EE_GRANT_SIG', '서명 없음');
    if (!verify(bytes(o.approverIkEd, 32), grantSigMsg(ep, myPub, buf), o.sig)) fail('E2EE_GRANT_SIG', '승인 서명 검증 실패');
  }
  const ephPub = buf.subarray(0, 32);
  const ss = x25519(priv, ephPub);
  const K = hkdf(ss, sha256(ephPub, myPub), D.grant, 32);
  const mk = aeadOpen(K, Buffer.alloc(12), grantAad(ep, myPub), buf.subarray(32), SUITE);
  if (mk.length !== 32) fail('E2EE_GRANT', 'MK 길이 이상');
  return mk;
}

/** 승인 = 남은 MK 를 새 기기에 봉인해 업로드할 페이로드 생성(POST /e2ee/approve body). */
function approvePayload(enrollmentId, recipientIkX, ep) {
  const e = ep == null ? epoch() : Number(ep);
  const s = sealTo(recipientIkX, { epoch: e });
  return { enrollmentId, ikX: typeof recipientIkX === 'string' ? recipientIkX : b64u(recipientIkX), epoch: e, sealed: s.sealed, sig: s.sig };
}

/** grant 수신 처리 — 복호·검증 후 상태 저장. */
function acceptGrant(grant, opts) {
  const g = grant || {};
  const mk = openFrom(g.sealed, { epoch: g.epoch, sig: g.sig, approverIkEd: (opts && opts.approverIkEd) || null });
  setMasterKey(g.epoch, mk);
  clearCacheKeepState();
  return { epoch: Number(g.epoch) };
}
function clearCacheKeepState() { _acctCache.clear(); }

// ──────────────────────────────────────────────────────────────────────────────
// 4. 복구 코드 (MK 를 사람이 옮기는 형태 — 의존성 0)
// ──────────────────────────────────────────────────────────────────────────────
//  payload = [ver 0x01][epoch u16 BE][MK 32B] (35B) ‖ chk2 = SHA256(D.recovery‖payload)[0..2]
//  → 37B 를 Crockford base32(대문자, 패딩 없음, 혼동문자 매핑) → 정확히 5글자 × 12그룹(60자)
//  예: CPT1-04005-KEHBH-R9NV5-B9471-PRD4M-72E5S-A77DB-E4GTS-C0G4P-CG8JP-7AWHQ-MSH00
//  ('-'·공백·소문자는 파싱 시 무시. 잉여 비트까지 정규성 검사 → 1글자 오타 100% 검출)

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: I·L·O·U 제외
const B32_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < B32.length; i++) m.set(B32[i], i);
  m.set('O', 0); m.set('I', 1); m.set('L', 1); m.set('U', B32.indexOf('V'));   // 흔한 오타 흡수
  return m;
})();

function b32encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str) {
    const v = B32_MAP.get(ch);
    if (v == null) fail('E2EE_RECOVERY_CHARSET', `허용되지 않은 문자: ${ch}`);
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** MK → 복구 코드 문자열. */
function recoveryCode(opts) {
  const o = opts || {};
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const mk = o.mk ? bytes(o.mk, 32) : masterKey(ep);
  const body = Buffer.concat([Buffer.from([1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ep, 0); return b; })(), mk]);
  const chk = sha256(Buffer.from(D.recovery), body).subarray(0, 2);
  const code = b32encode(Buffer.concat([body, chk]));
  const groups = code.match(/.{1,5}/g);
  return 'CPT1-' + groups.join('-');
}

/** 복구 코드 → {epoch, mk}. 오타는 체크섬(16bit)으로 거부. */
function parseRecoveryCode(input) {
  if (typeof input !== 'string') fail('E2EE_RECOVERY', '문자열 아님');
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith('CPT1')) s = s.slice(4);
  if (s.length !== 60) fail('E2EE_RECOVERY_LEN', `길이 이상: ${s.length} (기대 60)`);
  // 혼동문자(O/I/L/U)를 정규 문자로 접은 뒤, **정규 인코딩과 일치하는지** 확인한다.
  //  60글자 = 300비트 > 37바이트(296비트) → 마지막 글자의 하위 4비트는 잉여다. 이걸 검사하지
  //  않으면 "마지막 한 글자 오타"가 같은 바이트로 복호돼 체크섬을 통과한다(실측 발견).
  const canon = [...s].map((ch) => {
    const v = B32_MAP.get(ch);
    if (v == null) fail('E2EE_RECOVERY_CHARSET', `허용되지 않은 문자: ${ch}`);
    return B32[v];
  }).join('');
  const raw = b32decode(canon).subarray(0, 37);
  if (b32encode(raw) !== canon) fail('E2EE_RECOVERY_CHECKSUM', '복구 코드가 올바르지 않습니다(오타 확인)');
  const body = raw.subarray(0, 35), chk = raw.subarray(35, 37);
  if (!crypto.timingSafeEqual(sha256(Buffer.from(D.recovery), body).subarray(0, 2), chk)) {
    fail('E2EE_RECOVERY_CHECKSUM', '복구 코드가 올바르지 않습니다(오타 확인)');
  }
  if (body[0] !== 1) fail('E2EE_RECOVERY_VER', '지원하지 않는 복구 코드 버전');
  return { epoch: body.readUInt16BE(1), mk: Buffer.from(body.subarray(3)) };
}

/** 복구 코드로 상태 복원. */
function restoreFromRecoveryCode(code) {
  const { epoch: ep, mk } = parseRecoveryCode(code);
  setMasterKey(ep, mk);
  const st = ensureIdentity(); st.recoverySet = true; saveState(st);
  clearCacheKeepState();
  return { epoch: ep };
}

/** epoch 회전(기기 revoke 후) — 새 MK 생성 후 남은 기기 목록에 재봉인. */
function rotate(recipients, opts) {
  const o = opts || {};
  const from = epoch();
  const to = o.toEpoch == null ? from + 1 : Number(o.toEpoch);
  if (to <= from) fail('E2EE_EPOCH', 'toEpoch 는 현재보다 커야 함');
  const mk = randomBytes(32);
  const grants = (recipients || []).map((r) => {
    const s = sealTo(r.ikX, { epoch: to, mk });
    return { deviceKeyId: r.deviceKeyId, ikX: typeof r.ikX === 'string' ? r.ikX : b64u(r.ikX), sealed: s.sealed, sig: s.sig };
  });
  setMasterKey(to, mk);
  clearCacheKeepState();
  return { fromEpoch: from, toEpoch: to, grants };
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. 스트림 세션 (제어채널 RPC 선협상 — 인스트림 핸드셰이크 금지)
// ──────────────────────────────────────────────────────────────────────────────
//  ⚠ 함정 #1: 구 데몬의 pty 스트림에 평문 JSON 을 보내면 셸에 그대로 타이핑된다.
//     그래서 핸드셰이크는 **제어 WS 의 e2ee.begin RPC** 로만 한다. 스트림에는 봉인 프레임만 흐른다.

/** routing 정규화 — transcript 에 들어가는 문자열(서버가 다른 pane/포트로 몰래 라우팅하면 confirm 불일치). */
function routingCanonical(purpose, routing) {
  const r = routing || {};
  if (purpose === 'pty') return ['pty', r.cwd == null ? '' : String(r.cwd), r.paneId == null ? '' : String(r.paneId), r.win == null ? '' : String(r.win)].join('|');
  if (purpose === 'tcp') return ['tcp', r.port == null ? '' : String(r.port)].join('|');
  return [String(purpose), JSON.stringify(r === null ? {} : r, Object.keys(r).sort())].join('|');
}

/**
 * transcript — LF 로 구분된 정규 바이트열. 3구현체가 **바이트 단위로 동일**해야 한다.
 *   0 suite / 1 purpose / 2 transport / 3 epoch / 4 hostDeviceId / 5 clientKey
 *   6 b64u(pubViewer) / 7 b64u(pubHost) / 8 b64u(nonceViewer) / 9 b64u(nonceHost)
 *   10 routingCanonical
 * transport(direct|relay|lan)와 hostDeviceId 가 들어 있으므로 릴레이/호스트 다운그레이드 공격은
 * confirm 불일치로 실패한다(Orca v2 의 transport 바인딩 이식).
 */
function transcript(p) {
  const lines = [
    p.suite || SUITE,
    String(p.purpose),
    String(p.transport || 'relay'),
    String(Number(p.epoch)),
    String(p.hostDeviceId == null ? '' : p.hostDeviceId),
    String(p.client == null ? '' : p.client),
    typeof p.pubViewer === 'string' ? p.pubViewer : b64u(p.pubViewer),
    typeof p.pubHost === 'string' ? p.pubHost : b64u(p.pubHost),
    typeof p.nonceViewer === 'string' ? p.nonceViewer : b64u(p.nonceViewer),
    typeof p.nonceHost === 'string' ? p.nonceHost : b64u(p.nonceHost),
    routingCanonical(p.purpose, p.routing),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * 키 스케줄(§2.4).
 *   ecdh = X25519(privSelf, pubPeer)
 *   salt = SHA256("cpt-e2ee/v1/salt" ‖ nonceViewer ‖ nonceHost)
 *   ikm  = ecdh(32) ‖ MK_epoch(32)                     ← MK 는 PSK 로만 섞인다(PFS)
 *   info = "cpt-e2ee/v1/session" ‖ 0x00 ‖ SHA256(transcript)
 *   okm  = HKDF(ikm, salt, info, 112)
 *   k_v2h=okm[0..32] k_h2v=okm[32..64] sid=okm[64..96] K_confirm=okm[96..112]
 */
function deriveSession(params) {
  const p = params;
  const suite = p.suite || SUITE;
  if (!SUITES[suite]) fail('E2EE_SUITE', `지원하지 않는 스위트: ${suite}`);
  const nonceViewer = bytes(p.nonceViewer, 32);
  const nonceHost = bytes(p.nonceHost, 32);
  const ecdh = x25519(p.privSelf, p.pubPeer);
  const mk = p.mk ? bytes(p.mk, 32) : masterKey(p.epoch);
  const salt = sha256(Buffer.from(D.salt), nonceViewer, nonceHost);
  const tr = transcript({ ...p, suite });
  const info = Buffer.concat([Buffer.from(D.session), Buffer.from([0]), sha256(tr)]);
  const okm = hkdf(Buffer.concat([ecdh, mk]), salt, info, 112);
  const kConfirm = okm.subarray(96, 112);
  return {
    suite,
    kV2H: okm.subarray(0, 32),
    kH2V: okm.subarray(32, 64),
    sid: okm.subarray(64, 96),
    kConfirm,
    confirm: hmac256(kConfirm, 'host-confirm'),
    viewerConfirm: hmac256(kConfirm, 'viewer-confirm'),
    transcript: tr,
  };
}

// ── 세션 레지스트리(프로세스 로컬. 재기동 시 전멸 → 클라는 토큰 재발급으로 복구) ──
//  ⚠ 키는 `role:sidHex` 다. sid 는 **양쪽이 같은 값**을 파생하므로(공유 식별자), 한 프로세스가
//    호스트 역할(pty/proxy)과 뷰어 역할(forward 로컬 리스너)을 동시에 가질 때 — PC 앱이 자기
//    머신의 데몬을 보는 경우가 실제로 있다 — sidHex 만으로 키를 잡으면 서로를 덮어써 카운터/키가
//    뒤섞인다. 역할까지 키에 넣어 격리한다.
const sessions = new Map();   // `${role}:${sidHex}` → session

function sweep(now) {
  const t = now || Date.now();
  for (const [k, s] of sessions) if (s.expiresAt <= t) sessions.delete(k);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (let i = 0; i < oldest.length - MAX_SESSIONS; i++) sessions.delete(oldest[i][0]);
  }
}

function register(derived, meta) {
  sweep();
  const sidHex = derived.sid.toString('hex');
  const s = {
    sid: derived.sid,
    sidHex,
    key: `${meta.role}:${sidHex}`,
    sidB64: b64u(derived.sid),
    suite: derived.suite,
    role: meta.role,                    // 'host' | 'viewer'
    purpose: meta.purpose,
    routing: meta.routing || null,
    epoch: Number(meta.epoch),
    kV2H: derived.kV2H,
    kH2V: derived.kH2V,
    confirm: derived.confirm,
    viewerConfirm: derived.viewerConfirm,
    createdAt: Date.now(),
    expiresAt: Date.now() + (meta.ttlMs || SESSION_TTL_MS),
    channels: new Map(),                // connId → {sendCtr, recvCtr}
    retired: new Set(),                 // 닫힌 connId — 재사용 거부(재연결 nonce 재사용 방지)
  };
  sessions.set(s.key, s);
  return s;
}

function sidHexOf(sid) {
  if (Buffer.isBuffer(sid)) return sid.toString('hex');
  if (sid && typeof sid === 'object' && sid.sidHex) return sid.sidHex;
  const s = String(sid);
  return /^[0-9a-f]{64}$/i.test(s) ? s.toLowerCase() : bytes(s, 32).toString('hex');
}

/** @param {string} [role] 'host'|'viewer' — 한 프로세스가 양쪽 역할을 가질 때 필수. */
function getSession(sid, role) {
  sweep();
  const hex = sidHexOf(sid);
  if (role) {
    const s = sessions.get(`${role}:${hex}`);
    if (!s) fail('E2EE_NO_SESSION', '세션 없음(만료/재기동) — 토큰 재발급 필요');
    return s;
  }
  const hit = [sessions.get(`host:${hex}`), sessions.get(`viewer:${hex}`)].filter(Boolean);
  if (hit.length === 0) fail('E2EE_NO_SESSION', '세션 없음(만료/재기동) — 토큰 재발급 필요');
  if (hit.length > 1) fail('E2EE_AMBIGUOUS_SESSION', '같은 sid 에 host/viewer 세션이 모두 있음 — role 을 지정하라');
  return hit[0];
}
const hasSession = (sid, role) => { try { getSession(sid, role); return true; } catch (_) { return false; } };
function closeSession(sid, role) {
  try { sessions.delete(getSession(sid, role).key); return true; } catch (_) { return false; }
}
function sessionCount() { sweep(); return sessions.size; }

/**
 * 호스트(데몬) 측 — 제어채널 `e2ee.begin` 핸들러 본체.
 * 이후 pty.js/proxy.js 는 스트림이 붙을 때 `e2ee.channel(sid, connId, 'host')` 로 채널을 만든다.
 * @param {object} p {purpose, suite, epoch, pub, nonce, client, hostDeviceId, transport, routing, ttlMs}
 * @returns {{sid,pub,nonce,confirm,epoch,suite,expiresAt}} 그대로 rpc_result.result 로 돌려주면 된다.
 */
function beginHost(p) {
  if (!enabled()) fail('E2EE_DISABLED', 'CPT_E2EE=0');
  const suite = SUITES[p.suite] ? p.suite : fail('E2EE_SUITE', `지원하지 않는 스위트: ${p.suite}`);
  const ep = Number(p.epoch);
  const st = ensureIdentity();
  if (!hasKey(ep)) fail('E2EE_EPOCH_MISMATCH', `epoch ${ep} 열쇠 없음(현재 ${st.epoch})`);
  // ⚠ hostDeviceId 는 **데몬 자신의 신원**을 쓴다(서버가 준 값을 그대로 신뢰하면, 악의적 릴레이가
  //   PC-B 로 몰래 라우팅하면서 PC-A 의 id 를 echo 해 트랜스크립트를 맞춰버릴 수 있다).
  //   서버가 다른 id 를 주장하면 즉시 실패 = 뷰어는 평문 폴백 또는 명시 에러로 간다.
  const selfId = st.deviceId == null ? null : st.deviceId;
  if (selfId != null && p.hostDeviceId != null && String(p.hostDeviceId) !== String(selfId)) {
    fail('E2EE_HOST_MISMATCH', `요청된 hostDeviceId(${p.hostDeviceId})가 이 기기(${selfId})가 아님`);
  }
  const kp = genX25519();
  const nonceHost = randomBytes(32);
  const derived = deriveSession({
    suite,
    purpose: p.purpose,
    transport: p.transport || 'relay',
    epoch: ep,
    hostDeviceId: selfId == null ? p.hostDeviceId : selfId,
    client: p.client,
    routing: p.routing,
    privSelf: kp.priv,
    pubPeer: bytes(p.pub, 32),
    pubViewer: bytes(p.pub, 32),
    pubHost: kp.pub,
    nonceViewer: bytes(p.nonce, 32),
    nonceHost,
  });
  const s = register(derived, { role: 'host', purpose: p.purpose, routing: p.routing, epoch: ep, ttlMs: p.ttlMs });
  return {
    sid: s.sidB64,
    pub: b64u(kp.pub),
    nonce: b64u(nonceHost),
    confirm: b64u(derived.confirm),
    epoch: ep,
    suite,
    expiresAt: new Date(s.expiresAt).toISOString(),
  };
}

/**
 * 뷰어 측 1단계 — 오퍼(pub/nonce) 생성. back 의 start 요청 body.e2ee 에 그대로 넣는다.
 * (데몬도 PC 로컬 리스너(forward.js)에서는 뷰어 역할을 한다.)
 */
function createViewerOffer(p) {
  if (!enabled()) fail('E2EE_DISABLED', 'CPT_E2EE=0');
  const suite = p && p.suite && SUITES[p.suite] ? p.suite : defaultSuite();
  const ep = p.epoch == null ? epoch() : Number(p.epoch);
  if (!hasKey(ep)) fail('E2EE_NO_KEY', `epoch ${ep} 열쇠 없음`);
  const kp = genX25519();
  const nonce = randomBytes(32);
  return {
    offer: { suite, epoch: ep, pub: b64u(kp.pub), nonce: b64u(nonce) },
    pending: {
      suite, epoch: ep, purpose: p.purpose, transport: p.transport || 'relay',
      hostDeviceId: p.hostDeviceId == null ? null : p.hostDeviceId,
      client: p.client, routing: p.routing || null,
      priv: kp.priv, pub: kp.pub, nonce,
      ttlMs: p.ttlMs,
    },
  };
}

/** 뷰어 측 2단계 — 호스트 answer 수용(confirm 검증 = 다운그레이드/MITM 차단). */
function acceptHostAnswer(pending, answer) {
  if (!pending || !answer) fail('E2EE_PROTOCOL', 'pending/answer 필요');
  if (answer.suite && answer.suite !== pending.suite) fail('E2EE_SUITE', '스위트 불일치');
  if (Number(answer.epoch) !== Number(pending.epoch)) fail('E2EE_EPOCH_MISMATCH', 'epoch 불일치');
  const derived = deriveSession({
    suite: pending.suite,
    purpose: pending.purpose,
    transport: pending.transport,
    epoch: pending.epoch,
    hostDeviceId: pending.hostDeviceId,
    client: pending.client,
    routing: pending.routing,
    privSelf: pending.priv,
    pubPeer: bytes(answer.pub, 32),
    pubViewer: pending.pub,
    pubHost: bytes(answer.pub, 32),
    nonceViewer: pending.nonce,
    nonceHost: bytes(answer.nonce, 32),
  });
  const gotConfirm = bytes(answer.confirm, 32);
  if (!crypto.timingSafeEqual(derived.confirm, gotConfirm)) {
    // transcript(호스트/pane/포트/transport/epoch) 불일치 또는 MK 불일치 → 평문 폴백 또는 명시 에러.
    fail('E2EE_CONFIRM', '호스트 키확인 실패(라우팅 변조 또는 열쇠 불일치)');
  }
  if (answer.sid && b64u(derived.sid) !== String(answer.sid)) fail('E2EE_PROTOCOL', 'sid 불일치');
  const s = register(derived, { role: 'viewer', purpose: pending.purpose, routing: pending.routing, epoch: pending.epoch, ttlMs: pending.ttlMs });
  return s;
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. 프레이밍 (PTY / TCP — 바이너리 전용)
// ──────────────────────────────────────────────────────────────────────────────
//  header(12B) = [0]=ver 0x01
//                [1]= dir | kind<<4        dir 0x01 v→h / 0x02 h→v · kind 0x0 data / 0x1 ctrl
//                [2..6]  connId u32 BE     WS 연결마다 새 난수(재연결 nonce 재사용 방지)
//                [6..12] counter u48 BE    (connId, 방향)별 1부터
//  nonce = header (그대로 12B, 결정적)
//  AAD   = header ‖ sid(32B)
//  평문  = header(12B 사본) ‖ payload      ← 복호 후 대조: 리플레이/방향혼동/스플라이싱 차단
//  오버헤드 = 12(겉) + 12(사본) + 16(태그) = 40B/프레임

const newConnId = () => { let v = 0; while (v === 0) v = randomBytes(4).readUInt32BE(0); return v; };

function makeHeader(dir, kind, connId, counter) {
  const h = Buffer.alloc(HDR_LEN);
  h[0] = FRAME_VER;
  h[1] = (dir & 0x0f) | ((kind & 0x0f) << 4);
  h.writeUInt32BE(connId >>> 0, 2);
  h.writeUIntBE(counter, 6, 6);
  return h;
}
function parseHeader(buf) {
  return {
    ver: buf[0],
    dir: buf[1] & 0x0f,
    kind: (buf[1] >> 4) & 0x0f,
    connId: buf.readUInt32BE(2),
    counter: buf.readUIntBE(6, 6),
  };
}

const outDir = (role) => (role === 'host' ? DIR.H2V : DIR.V2H);
const inDir = (role) => (role === 'host' ? DIR.V2H : DIR.H2V);
const outKey = (s) => (s.role === 'host' ? s.kH2V : s.kV2H);
const inKey = (s) => (s.role === 'host' ? s.kV2H : s.kH2V);

function chanState(s, connId) {
  let c = s.channels.get(connId);
  if (!c) {
    if (s.retired.has(connId)) fail('E2EE_CONN_REUSE', 'connId 재사용 거부');
    c = { sendCtr: 0, recvCtr: 0 };
    s.channels.set(connId, c);
  }
  return c;
}

/**
 * 채널 = WS 연결 1개. 봉인/해제와 카운터를 소유한다.
 *  const ch = e2ee.channel(sid);              // 연결을 여는 쪽: connId 자동 생성
 *  const ch = e2ee.channel(sid, connId);      // 상대가 정한 connId 를 알 때
 *  ch.seal(buf, KIND.DATA) / ch.open(frame) → {kind, payload}
 */
function channel(sid, connId, role) {
  const s = getSession(sid, role);
  const id = connId == null ? newConnId() : (connId >>> 0);
  const c = chanState(s, id);
  const suite = s.suite;
  return {
    sid: s.sidB64,
    key: s.key,
    connId: id,
    role: s.role,
    purpose: s.purpose,
    suite,
    get sentFrames() { return c.sendCtr; },
    get recvFrames() { return c.recvCtr; },

    seal(payload, kind) {
      const k = kind == null ? KIND.DATA : kind;
      if (c.sendCtr >= MAX_COUNTER) fail('E2EE_COUNTER_EXHAUSTED', '카운터 소진 — 세션 재수립 필요');
      const counter = ++c.sendCtr;
      const hdr = makeHeader(outDir(s.role), k, id, counter);
      const pt = Buffer.concat([hdr, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
      const ct = aeadSeal(outKey(s), hdr, Buffer.concat([hdr, s.sid]), pt, suite);
      return Buffer.concat([hdr, ct]);
    },

    /** 제어 JSON(resize 등)은 원본 JSON 그대로 ctrl kind 로 실어 보낸다(§함정 4). */
    sealCtrl(obj) { return this.seal(Buffer.from(JSON.stringify(obj), 'utf8'), KIND.CTRL); },

    open(frame) {
      const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
      if (buf.length < FRAME_OVERHEAD) fail('E2EE_BAD_FRAME', `프레임이 너무 짧음(${buf.length})`);
      const hdr = buf.subarray(0, HDR_LEN);
      const h = parseHeader(hdr);
      if (h.ver !== FRAME_VER) fail('E2EE_BAD_FRAME', `버전 ${h.ver}`);
      if (h.dir !== inDir(s.role)) fail('E2EE_DIR', '방향 혼동 프레임 거부');
      if (h.kind !== KIND.DATA && h.kind !== KIND.CTRL) fail('E2EE_BAD_FRAME', `알 수 없는 kind ${h.kind}`);
      if (h.connId !== id) fail('E2EE_CONN_MISMATCH', 'connId 불일치');
      if (h.counter <= c.recvCtr) fail('E2EE_REPLAY', `카운터 역행/재사용(${h.counter} <= ${c.recvCtr})`);
      const pt = aeadOpen(inKey(s), hdr, Buffer.concat([hdr, s.sid]), buf.subarray(HDR_LEN), suite);
      if (pt.length < HDR_LEN) fail('E2EE_BAD_FRAME', '내부 헤더 없음');
      if (!crypto.timingSafeEqual(pt.subarray(0, HDR_LEN), hdr)) fail('E2EE_SPLICE', '내부 헤더 불일치(스플라이싱)');
      c.recvCtr = h.counter;
      return { kind: h.kind, payload: Buffer.from(pt.subarray(HDR_LEN)), connId: id, counter: h.counter };
    },

    /** ctrl 프레임을 JSON 으로. data 프레임이면 null. */
    openJson(frame) {
      const r = this.open(frame);
      if (r.kind !== KIND.CTRL) return null;
      return JSON.parse(r.payload.toString('utf8'));
    },

    close() { s.channels.delete(id); s.retired.add(id); },
  };
}

/** 상대가 먼저 프레임을 보내는 경우(proxy.js: connId 를 첫 프레임 헤더에서 학습). */
function channelFromFrame(sid, frame, role) {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buf.length < FRAME_OVERHEAD) fail('E2EE_BAD_FRAME', '프레임이 너무 짧음');
  const h = parseHeader(buf.subarray(0, HDR_LEN));
  if (h.counter !== 1) fail('E2EE_PROTOCOL', '새 connId 의 첫 프레임 카운터는 1이어야 함');
  return channel(sid, h.connId, role);
}

/** 프레임 헤더만 훔쳐보기(라우팅/디버깅용 — 복호 없음). */
function peekFrame(frame) {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buf.length < HDR_LEN) return null;
  const h = parseHeader(buf.subarray(0, HDR_LEN));
  return h.ver === FRAME_VER ? h : null;
}
const frameOverhead = () => FRAME_OVERHEAD;

// ──────────────────────────────────────────────────────────────────────────────
// 7. 봉투 (JSON payload — fs RPC / agent_event / 커맨드)
// ──────────────────────────────────────────────────────────────────────────────
//  env = { v:1, suite, epoch, nonce:b64u12, ct:b64u }
//  nonce = [부팅난수 4B][카운터 u64 BE 8B]   ← 프로세스 재기동에도 충돌 없음
//  AAD   = 도메인("…/rpc" | "…/rpc-resp") ‖ epoch u32 ‖ hostDeviceId u32
//  라우팅 필드(hostDeviceId, timeoutMs, seq, kind …)는 **봉투 밖 평문** 유지.

// nonce = [부팅난수 8B][카운터 u32 BE 4B]
//
// ⚠ 난수 폭이 8바이트여야 하는 이유(4바이트였고, 그게 실제 취약점이었다):
//  봉투 키(K_rpc)는 **MK 에서만 파생돼 계정 전역**이다 — 같은 계정의 모든 기기·모든 프로세스 부팅이
//  같은 키를 쓴다. 따라서 nonce 충돌 = 부팅난수 충돌이고, 4바이트면 생일 문제로
//  (기기×부팅) 인스턴스 N 개에서 확률 ≈ N²/2^33 이다. 폰 앱 재시작이 연 수천 회 × 여러 기기면
//  1e-4~1e-3 수준으로 올라간다. ChaCha20-Poly1305 에서 nonce 재사용은 키스트림 XOR 복원 +
//  Poly1305 one-time key 노출 → **위조 가능**이라는 치명 실패다.
//  8바이트로 넓히면 같은 조건에서 ≈ N²/2^65 로 떨어져 사실상 불가능해진다.
//  카운터는 부팅당 2^32 건(42억 RPC)까지 — 실사용 상한을 한참 넘는다. 소진 시 아래에서 명시적으로 막는다.
//  ⚠ 이 분할은 앱(e2eeProto.js)의 생성기와 같아야 한다. nonce 는 와이어로 전달되므로 복호 자체는
//  분할이 달라도 되지만, 수신측 리플레이 창이 prefix 기준으로 집계되므로 갈라지면 탐지 정확도가 떨어진다.
const BOOT_PREFIX = randomBytes(8);
let _envCtr = 0n;
function envNonce() {
  _envCtr += 1n;
  if (_envCtr > 0xffffffffn) fail('E2EE_COUNTER_EXHAUSTED', '봉투 카운터 소진 — 재기동이 필요합니다');
  const b = Buffer.alloc(4); b.writeUInt32BE(Number(_envCtr), 0);
  return Buffer.concat([BOOT_PREFIX, b]);
}

// 수신 리플레이 방어 — 송신자 prefix 별 (최대 카운터 + 최근 본 카운터 집합).
const _envSeen = new Map();   // key = dir|epoch|prefixHex → {max, seen:Set}
function envReplayCheck(key, ctr) {
  let e = _envSeen.get(key);
  if (!e) { e = { max: 0n, seen: new Set() }; _envSeen.set(key, e); }
  if (e.seen.has(ctr)) fail('E2EE_REPLAY', '봉투 nonce 재사용');
  if (ctr <= e.max - BigInt(ENV_WINDOW)) fail('E2EE_REPLAY', '너무 오래된 봉투(윈도우 밖)');
  e.seen.add(ctr);
  if (ctr > e.max) e.max = ctr;
  if (e.seen.size > ENV_WINDOW * 2) {
    for (const v of e.seen) if (v <= e.max - BigInt(ENV_WINDOW)) e.seen.delete(v);
  }
  if (_envSeen.size > 256) { for (const k of _envSeen.keys()) { if (k !== key) { _envSeen.delete(k); break; } } }
}

function envAad(dir, ep, hostDeviceId) {
  return Buffer.concat([Buffer.from(dir === 'resp' ? D.rpcResp : D.rpc), u32(ep), u32(hostDeviceId || 0)]);
}
function envKey(dir, ep) {
  const k = accountKeys(ep);
  return dir === 'resp' ? k.rpcResp : k.rpc;
}

/**
 * JSON payload 봉인. 라우팅 필드는 호출부가 봉투 밖에 그대로 둔다.
 * @param {object} obj  평문 payload (예: {id,m:'fs.read',p:{…},ts})
 * @param {object} opts {dir:'req'|'resp', epoch?, hostDeviceId?, suite?}
 */
function sealEnvelope(obj, opts) {
  const o = opts || {};
  const dir = o.dir === 'resp' ? 'resp' : 'req';
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const suite = o.suite && SUITES[o.suite] ? o.suite : defaultSuite();
  const nonce = envNonce();
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = aeadSeal(envKey(dir, ep), nonce, envAad(dir, ep, o.hostDeviceId), pt, suite);
  return { v: 1, suite, epoch: ep, nonce: b64u(nonce), ct: b64u(ct) };
}

/** 봉투 해제. 리플레이(같은 nonce/오래된 카운터) 거부. */
function openEnvelope(env, opts) {
  const o = opts || {};
  if (!env || env.v !== 1 || typeof env.ct !== 'string') fail('E2EE_PROTOCOL', '봉투 형식 아님');
  const suite = SUITES[env.suite] ? env.suite : fail('E2EE_SUITE', `지원하지 않는 스위트: ${env.suite}`);
  const dir = o.dir === 'resp' ? 'resp' : 'req';
  const ep = Number(env.epoch);
  const nonce = unb64u(env.nonce, 12);
  const pt = aeadOpen(envKey(dir, ep), nonce, envAad(dir, ep, o.hostDeviceId), unb64u(env.ct), suite);
  if (o.replay !== false) {
    // prefix 8B | counter u32 4B (송신측 envNonce 와 같은 분할이어야 집계가 맞는다)
    envReplayCheck(`${dir}|${ep}|${nonce.subarray(0, 8).toString('hex')}`, BigInt(nonce.readUInt32BE(8)));
  }
  return JSON.parse(pt.toString('utf8'));
}

// 편의: sealed RPC 요청/응답 (control.js 의 method:'sealed' 배관용)
const sealRpc = (method, params, opts) => sealEnvelope({ id: crypto.randomUUID(), m: method, p: params == null ? {} : params, ts: Date.now() }, { ...(opts || {}), dir: 'req' });
const openRpc = (env, opts) => openEnvelope(env, { ...(opts || {}), dir: 'req' });
const sealRpcResult = (result, opts) => sealEnvelope({ ok: true, r: result === undefined ? null : result }, { ...(opts || {}), dir: 'resp' });
const sealRpcError = (err, opts) => sealEnvelope({ ok: false, e: (err && err.message) || String(err), code: (err && err.code) || null }, { ...(opts || {}), dir: 'resp' });
const openRpcResult = (env, opts) => openEnvelope(env, { ...(opts || {}), dir: 'resp' });

// ──────────────────────────────────────────────────────────────────────────────
// 8. 알림 body / 스냅샷 번들
// ──────────────────────────────────────────────────────────────────────────────
//  알림: "cptenc:1:<epoch>:<b64u nonce12>:<b64u ct‖tag>"   (K_notif)
//   ⚠ 규칙(불변식 5·함정 7): body 를 봉인할 때는 subtitle 을 반드시 함께 보낸다.
//     notificationService 가 `subtitle || body.slice(0,120)` 로 FCM 본문을 만들기 때문에,
//     subtitle 이 없으면 잠금화면에 암호문이 노출된다. 아래 sealNotification() 이 이를 강제한다.

const NOTIF_PREFIX = 'cptenc:1:';

function sealNotifBody(text, opts) {
  const o = opts || {};
  if (text == null || text === '') return null;
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([Buffer.from(D.notif), u32(ep)]);
  const ct = aeadSeal(accountKeys(ep).notif, nonce, aad, Buffer.from(String(text), 'utf8'), SUITE);
  return `${NOTIF_PREFIX}${ep}:${b64u(nonce)}:${b64u(ct)}`;
}

const isSealedNotifBody = (s) => typeof s === 'string' && s.startsWith(NOTIF_PREFIX);

function openNotifBody(s) {
  if (!isSealedNotifBody(s)) return s;
  const parts = s.split(':');
  if (parts.length !== 5) fail('E2EE_PROTOCOL', '알림 body 형식 아님');
  const ep = Number(parts[2]);
  const aad = Buffer.concat([Buffer.from(D.notif), u32(ep)]);
  return aeadOpen(accountKeys(ep).notif, unb64u(parts[3], 12), aad, unb64u(parts[4]), SUITE).toString('utf8');
}

/**
 * 알림 payload 봉인 — subtitle 보장 규칙을 코드로 강제.
 * @param {object} n {title, subtitle, body, …}  나머지 라우팅 필드(cwd/win/kind…)는 그대로 평문.
 */
function sealNotification(n, opts) {
  const out = { ...(n || {}) };
  if (!out.body) return out;
  const sealed = sealNotifBody(out.body, opts);
  if (!sealed) return out;
  if (!out.subtitle) {
    // 잠금화면 도달(우리 최대 우위)을 지키기 위한 최소 평문 요약. 상세는 암호문에만 있다.
    out.subtitle = out.title ? '새 알림' : '알림';
  }
  out.body = sealed;
  out.enc = 'cptenc/1';
  return out;
}

//  스냅샷: "CPTS1\0" ‖ epoch u32 BE ‖ nonce12 ‖ ct ‖ tag16   (K_snap, AAD="CPTS1"‖epoch)
//   태그가 맨 끝이라 스트리밍 업로드에도 그대로 쓸 수 있다(멀티파트 200MB 경로).
const SNAP_MAGIC = Buffer.from('CPTS1\0', 'binary');
const SNAP_HDR = SNAP_MAGIC.length + 4 + 12;

function sealSnapshot(buf, opts) {
  const o = opts || {};
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([Buffer.from('CPTS1'), u32(ep)]);
  const ct = aeadSeal(accountKeys(ep).snapshot, nonce, aad, Buffer.isBuffer(buf) ? buf : Buffer.from(buf), SUITE);
  return Buffer.concat([SNAP_MAGIC, u32(ep), nonce, ct]);
}
const isSealedSnapshot = (buf) => Buffer.isBuffer(buf) && buf.length >= SNAP_HDR && buf.subarray(0, 6).equals(SNAP_MAGIC);

function openSnapshot(buf) {
  if (!isSealedSnapshot(buf)) fail('E2EE_PROTOCOL', '스냅샷 봉인 헤더 아님');
  const ep = buf.readUInt32BE(6);
  const nonce = buf.subarray(10, 22);
  const aad = Buffer.concat([Buffer.from('CPTS1'), u32(ep)]);
  return aeadOpen(accountKeys(ep).snapshot, nonce, aad, buf.subarray(SNAP_HDR), SUITE);
}
const snapshotEpoch = (buf) => (isSealedSnapshot(buf) ? buf.readUInt32BE(6) : null);

/**
 * 스트리밍 봉인 — 200MB 번들을 메모리에 두 벌 올리지 않기 위한 Transform.
 *   fs.createReadStream(bundle).pipe(e2ee.sealSnapshotStream()).pipe(업로드)
 * 태그가 맨 끝에 붙는 포맷이라 멀티파트 업로드에도 그대로 쓸 수 있다(Cloudflare 100MB 경계 규율 유지).
 */
function sealSnapshotStream(opts) {
  const { Transform } = require('stream');
  const o = opts || {};
  const ep = o.epoch == null ? epoch() : Number(o.epoch);
  const nonce = randomBytes(12);
  const c = crypto.createCipheriv(SUITES[SUITE].alg, accountKeys(ep).snapshot, nonce, { authTagLength: TAG_LEN });
  c.setAAD(Buffer.concat([Buffer.from('CPTS1'), u32(ep)]));
  let head = false;
  const pushHead = (self) => { if (!head) { self.push(Buffer.concat([SNAP_MAGIC, u32(ep), nonce])); head = true; } };
  return new Transform({
    transform(chunk, _enc, cb) { pushHead(this); this.push(c.update(chunk)); cb(); },
    final(cb) { pushHead(this); this.push(c.final()); this.push(c.getAuthTag()); cb(); },
  });
}

/** 스트리밍 해제 — 헤더를 앞에서 떼고, 마지막 16B(태그)를 유보했다가 final 에서 검증한다. */
function openSnapshotStream() {
  const { Transform } = require('stream');
  let hdr = Buffer.alloc(0), d = null, tail = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      let buf = Buffer.from(chunk);
      if (!d) {
        hdr = Buffer.concat([hdr, buf]);
        if (hdr.length < SNAP_HDR) return cb();
        if (!hdr.subarray(0, 6).equals(SNAP_MAGIC)) return cb(new E2eeError('E2EE_PROTOCOL', '스냅샷 봉인 헤더 아님'));
        const ep = hdr.readUInt32BE(6);
        try {
          d = crypto.createDecipheriv(SUITES[SUITE].alg, accountKeys(ep).snapshot, hdr.subarray(10, 22), { authTagLength: TAG_LEN });
          d.setAAD(Buffer.concat([Buffer.from('CPTS1'), u32(ep)]));
        } catch (e) { return cb(e); }
        buf = hdr.subarray(SNAP_HDR);
        hdr = Buffer.alloc(0);
      }
      const all = Buffer.concat([tail, buf]);
      if (all.length <= TAG_LEN) { tail = all; return cb(); }
      tail = all.subarray(all.length - TAG_LEN);
      this.push(d.update(all.subarray(0, all.length - TAG_LEN)));
      cb();
    },
    final(cb) {
      if (!d || tail.length !== TAG_LEN) return cb(new E2eeError('E2EE_PROTOCOL', '스냅샷이 잘렸음'));
      try { d.setAuthTag(tail); this.push(d.final()); cb(); }
      catch (_) { cb(new E2eeError('E2EE_AUTH', '스냅샷 복호/인증 실패')); }
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 9. capability / 협상 판정
// ──────────────────────────────────────────────────────────────────────────────

// capability 이름은 **단계별 점 표기**로 통일한다(caps 규약 `<도메인>.v<N>`, back config/caps.js 가 정본).
//  이전에 데몬만 'e2ee/v1' 슬래시 표기를 써서 back·PC·앱(e2ee.keys.v1 …)과 교집합이 **영구 공집합**이었다 —
//  협상이 항상 HOST_UNSUPPORTED 로 떨어져 "켜도 안 켜지는" 상태가 안전한 평문으로 위장돼 있었다.
//  단계를 쪼개는 이유: 뭉뚱그린 이름을 선언하면 상대가 아직 처리 코드가 없는 단계(스트림 등)까지
//  켰다고 믿고 프레임을 보내 조용히 유실된다.
const CAP = 'e2ee.keys.v1';   // 열쇠 수립/배포 (A단계)
const CAP_RPC = 'e2ee.rpc.v1';  // 봉투 RPC (B단계)

/** 데몬 hello 에 실을 능력 — 처리 코드가 있는 것만 선언(불변식 3). */
function caps() {
  if (!enabled()) return [];
  if (!hasKey()) return [];
  // 열쇠가 있으면 봉투 RPC 도 처리할 수 있다(같은 모듈이 둘 다 구현). 스트림은 e2ee-gate 가 스코프로 추가.
  return [CAP, CAP_RPC];
}

/** 연결별 사용 판정: policy!=='off' && 상대가 CAP 보유 && epoch 일치. */
function shouldUse(peerCaps, peerEpoch, opts) {
  const o = opts || {};
  const pol = o.policy || policy();
  if (!enabled() || pol === 'off') return { use: false, reason: 'POLICY_OFF' };
  const list = Array.isArray(peerCaps) ? peerCaps : [];
  // 상대가 열쇠 수립 능력을 선언했는지만 본다(단계별 세부 능력은 각 사용 지점이 따로 확인).
  if (!list.includes(CAP)) return { use: false, reason: 'HOST_UNSUPPORTED', required: pol === 'required' };
  const mine = o.epoch == null ? epoch() : Number(o.epoch);
  if (!mine || !hasKey(mine)) return { use: false, reason: 'NO_GRANT', required: pol === 'required' };
  if (peerEpoch != null && Number(peerEpoch) !== mine) return { use: false, reason: 'EPOCH_MISMATCH', required: pol === 'required' };
  return { use: true, reason: null };
}

// ──────────────────────────────────────────────────────────────────────────────
// 10. 크로스플랫폼 골든 벡터 생성기 (test/vectors/e2ee-v1.json)
// ──────────────────────────────────────────────────────────────────────────────
//  모든 입력이 고정 상수 → Node/모바일(@stablelib)/Rust 가 같은 바이트를 내야 한다.
function vectors() {
  const seed = (tag, n) => sha256(`cpt-e2ee/v1/testvec/${tag}`).subarray(0, n);
  // X25519 개인키는 32B 아무 값이나 가능(clamping 은 내부에서).
  const vPriv = seed('viewer-priv', 32);
  const hPriv = seed('host-priv', 32);
  const vPub = rawPub(crypto.createPublicKey(importXPriv(vPriv)));
  const hPub = rawPub(crypto.createPublicKey(importXPriv(hPriv)));
  const mk = seed('mk', 32);
  const nonceV = seed('nonce-viewer', 32);
  const nonceH = seed('nonce-host', 32);

  const base = {
    suite: SUITE, purpose: 'pty', transport: 'relay', epoch: 2, hostDeviceId: 12,
    client: 'ck_abc123', routing: { cwd: 'proj/a', paneId: 'p1', win: 3 },
  };
  const tr = transcript({ ...base, pubViewer: vPub, pubHost: hPub, nonceViewer: nonceV, nonceHost: nonceH });
  const derived = deriveSession({ ...base, privSelf: vPriv, pubPeer: hPub, pubViewer: vPub, pubHost: hPub, nonceViewer: nonceV, nonceHost: nonceH, mk });

  const frames = [];
  for (const [kind, connId, counter, payloadHex] of [
    [KIND.DATA, 0x11223344, 1, '6c73202d6c610a'],       // "ls -la\n"
    [KIND.CTRL, 0x11223344, 2, Buffer.from('{"type":"resize","cols":118,"rows":48}').toString('hex')],
    [KIND.DATA, 0xdeadbeef, 281474976710655, ''],       // 카운터 상한(u48) · 빈 payload
  ]) {
    const payload = Buffer.from(payloadHex, 'hex');
    const hdr = makeHeader(DIR.V2H, kind, connId, counter);
    const ct = aeadSeal(derived.kV2H, hdr, Buffer.concat([hdr, derived.sid]), Buffer.concat([hdr, payload]), SUITE);
    frames.push({ dir: DIR.V2H, kind, connId, counter, payload: payload.toString('hex'), frame: Buffer.concat([hdr, ct]).toString('hex') });
  }

  const ak = {
    rpc: hkdf(mk, null, D.rpc, 32), rpcResp: hkdf(mk, null, D.rpcResp, 32),
    notif: hkdf(mk, null, D.notif, 32), snapshot: hkdf(mk, null, D.snapshot, 32),
  };
  const envNonceFixed = seed('env-nonce', 12);
  const envPt = Buffer.from(JSON.stringify({ id: 'fixed-id', m: 'fs.read', p: { path: 'proj/a/package.json' }, ts: 1769000000000 }), 'utf8');
  const envCt = aeadSeal(ak.rpc, envNonceFixed, envAad('req', 2, 12), envPt, SUITE);

  const snapNonce = seed('snap-nonce', 12);
  const snapPt = Buffer.from('PACK-fake-git-bundle');
  const snapCt = aeadSeal(ak.snapshot, snapNonce, Buffer.concat([Buffer.from('CPTS1'), u32(2)]), snapPt, SUITE);

  const notifNonce = seed('notif-nonce', 12);
  const notifCt = aeadSeal(ak.notif, notifNonce, Buffer.concat([Buffer.from(D.notif), u32(2)]), Buffer.from('작업이 완료되었습니다', 'utf8'), SUITE);

  return {
    suite: SUITE,
    note: '고정 입력 골든 벡터. Node/@stablelib/Rust 3구현체가 동일 바이트를 내야 한다. hex 는 소문자.',
    kex: { viewerPriv: vPriv.toString('hex'), viewerPub: vPub.toString('hex'), hostPriv: hPriv.toString('hex'), hostPub: hPub.toString('hex'), shared: x25519(vPriv, hPub).toString('hex') },
    hkdf: { ikm: Buffer.alloc(32, 7).toString('hex'), salt: Buffer.alloc(16, 9).toString('hex'), info: 'cpt-e2ee/v1/test', len: 64, okm: hkdf(Buffer.alloc(32, 7), Buffer.alloc(16, 9), 'cpt-e2ee/v1/test', 64).toString('hex') },
    accountKeys: { mk: mk.toString('hex'), rpc: ak.rpc.toString('hex'), rpcResp: ak.rpcResp.toString('hex'), notif: ak.notif.toString('hex'), snapshot: ak.snapshot.toString('hex') },
    session: {
      input: { ...base, mk: mk.toString('hex'), viewerPriv: vPriv.toString('hex'), hostPub: hPub.toString('hex'), nonceViewer: nonceV.toString('hex'), nonceHost: nonceH.toString('hex') },
      transcript: tr.toString('utf8'),
      transcriptSha256: sha256(tr).toString('hex'),
      kV2H: derived.kV2H.toString('hex'), kH2V: derived.kH2V.toString('hex'),
      sid: derived.sid.toString('hex'), confirm: derived.confirm.toString('hex'), viewerConfirm: derived.viewerConfirm.toString('hex'),
    },
    frames,
    envelope: { dir: 'req', epoch: 2, hostDeviceId: 12, nonce: envNonceFixed.toString('hex'), plaintext: envPt.toString('utf8'), ct: envCt.toString('hex') },
    snapshot: { epoch: 2, nonce: snapNonce.toString('hex'), plaintext: snapPt.toString('utf8'), blob: Buffer.concat([SNAP_MAGIC, u32(2), snapNonce, snapCt]).toString('hex') },
    notif: { epoch: 2, nonce: notifNonce.toString('hex'), plaintext: '작업이 완료되었습니다', body: `${NOTIF_PREFIX}2:${b64u(notifNonce)}:${b64u(notifCt)}` },
    recovery: { epoch: 2, mk: mk.toString('hex'), code: recoveryCode({ epoch: 2, mk }) },
    grantAadSample: { epoch: 2, ikX: hPub.toString('hex'), aad: grantAad(2, hPub).toString('hex') },
  };
}

module.exports = {
  // 상수/식별
  SUITE, SUITE_AES, SUITES, CAP, CAP_RPC, DIR, KIND, FRAME_VER, HDR_LEN, FRAME_OVERHEAD, D,
  E2eeError, enabled, defaultSuite, frameOverhead, caps, shouldUse,
  // 인코딩/프리미티브(테스트·다른 모듈 공용)
  b64u, unb64u, sha256, hmac256, hkdf, randomBytes, genX25519, genEd25519, x25519, sign, verify,
  aeadSeal, aeadOpen,
  // 상태/신원
  loadState, saveState, ensureIdentity, removeState, forgetState, identity, epoch, policy, setPolicy,
  setMasterKey, masterKey, hasKey, bootstrapMasterKey, accountKeys, clearCache, fingerprint,
  // MK 봉인/승인
  sealTo, openFrom, approvePayload, acceptGrant, rotate,
  // 복구 코드
  recoveryCode, parseRecoveryCode, restoreFromRecoveryCode,
  // 세션
  transcript, routingCanonical, deriveSession, beginHost, createViewerOffer, acceptHostAnswer,
  getSession, hasSession, closeSession, sessionCount, sweep,
  // 프레이밍
  channel, channelFromFrame, peekFrame, newConnId, makeHeader, parseHeader,
  // 봉투
  sealEnvelope, openEnvelope, sealRpc, openRpc, sealRpcResult, sealRpcError, openRpcResult,
  // 알림/스냅샷
  sealNotifBody, openNotifBody, isSealedNotifBody, sealNotification,
  sealSnapshot, openSnapshot, isSealedSnapshot, snapshotEpoch, sealSnapshotStream, openSnapshotStream,
  // 테스트 벡터
  vectors,
};
