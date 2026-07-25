/* eslint-disable */
// (PC) 이 파일은 **공개 입력 파생**(확인 숫자·지문·QR 핀)에만 쓴다 — 마스터키(MK)는 JS 로 오지 않는다.
//  MK 가 필요한 연산(봉인/개봉/서명/봉투)은 전부 사이드카 데몬(cpt.sock e2ee.*)이 수행한다.
// e2eeProto.js — cpt-e2ee/v1 **와이어 계약** 순수 함수 모음(설계 §2 정본의 코드화).
//
// ★ codingpt_app/src/services/e2ee/e2eeProto.js 의 동일 사본(import 경로만 다름). 데몬(runner-core/e2ee.js)은
//   node 내장 crypto 로 같은 계약을 구현한다 — **여기 정의된 바이트 배열이 유일한 정본**이다.
//   설계서가 `aad="grant"||epoch||ikX` 처럼 추상 표기한 부분의 **정확한 직렬화**를 여기서 확정한다:
//     label|epoch|... 형태의 ASCII 접두사 + 원시 바이트 이어붙임(아래 각 함수 주석 참조).
//
// 이 파일에는 저장/네트워크/플랫폼 코드가 없다(순수) — 그래서 테스트가 쉽고, 데몬/PC/모바일이 공유한다.
import {
  SUITE, aeadOpen, aeadSeal, b64uDec, b64uEnc, concat, copyOf, ctEq, fromUtf8, hkdf, hmacSha256,
  randomBytes, sha256, u8, utf8, x25519, x25519Public,
  ed25519Sign, ed25519Verify,
} from './e2ee-core.js';

// capability 문자열. 설계서 §2.8 은 'e2ee/v1' 로 적었지만 리포 규약(config/caps.js: 'approval.v1',
//  'transcript.v1')과 형식을 통일해 **'e2ee.v1'** 을 정본으로 한다 — 데몬 hello/ui_hello/SERVER_CAPS
//  세 곳이 같은 문자열이어야 교집합 게이팅이 성립한다(다르면 조용히 기능이 안 켜진다).
export const E2EE_CAP = 'e2ee.keys.v1';   // A단계(열쇠 배포). B/C/D 단계는 아래 CAP_* 참조
export const CAP_RPC = 'e2ee.rpc.v1';     // 봉투 RPC(POST /api/daemon/rpc)
export const CAP_STREAM = 'e2ee.stream.v1'; // e2ee.begin 선협상 + PTY/forward 프레임
export const CAP_SNAP = 'e2ee.snap.v1';   // 스냅샷 번들 봉인

// 도메인 문자열 — **바이트 그대로** HKDF/AAD 에 들어간다(오타 = 크로스플랫폼 불일치).
//  데몬 runner-core/e2ee.js 의 D 와 1:1. 서버는 이 값들을 모른다(암호문만 저장).
export const D = {
  salt: `${SUITE}/salt`, session: `${SUITE}/session`, grant: `${SUITE}/grant`, fp: `${SUITE}/fp`,
  rpc: `${SUITE}/rpc`, rpcResp: `${SUITE}/rpc-resp`, notif: `${SUITE}/notif`,
  snapshot: `${SUITE}/snapshot`, recovery: `${SUITE}/recovery`,
};
/** u32 BE — epoch·hostDeviceId·connId 의 정규 인코딩(데몬 u32() 미러). */
export function u32(n) {
  const b = new Uint8Array(4);
  const v = Number(n) >>> 0;
  b[0] = (v >>> 24) & 0xff; b[1] = (v >>> 16) & 0xff; b[2] = (v >>> 8) & 0xff; b[3] = v & 0xff;
  return b;
}
export const NOTIF_PREFIX = 'cptenc:1:'; // 알림 body 봉인 접두사(설계 §2.6)

// ── 키 계층(설계 §2.2) ─────────────────────────────────────────
//  MK 는 직접 암호화 키로 쓰지 않는다 — 목적별 HKDF 파생만.
export function deriveKey(mk, purpose) {
  return hkdf(u8(mk), new Uint8Array(0), utf8(`${SUITE}/${purpose}`), 32);
}
export const K_RPC = 'rpc';
export const K_RPC_RESP = 'rpc-resp';
export const K_NOTIF = 'notif';
export const K_SNAPSHOT = 'snapshot';

// ── 확인 숫자 / 지문 ───────────────────────────────────────────
//  ★ 파생 정본(4구현체 공통) — okm = HKDF(ikm=ikX, salt="cpt-e2ee/v1/fp", info=userId, **16바이트**)
//      safety(60비트 대조값) = okm[0..8]        → base32 12글자
//      fingerprint6(감사 표기) = u32BE(okm[8])  % 10^6
//      verifyCode4(요청 구분용) = u32BE(okm[12]) % 10^4
//    데몬 runner-core/e2ee.js `fingerprint()`(safety/legacy/short) · back deviceTrustService
//    `fingerprintOf()` 와 **바이트 단위로 같아야** 한다. 과거 이 파일만 4바이트 OKM 의 앞 4바이트를
//    썼기 때문에 앱/PC ↔ 데몬/back 의 표시값이 100% 어긋났고, 그러면 pickCode 규칙에 따라 화면이
//    **항상 "서버가 준 숫자"** 를 그리게 되어(verified=false) 서버 위조 차단이 완전히 무력화된다.
//  ★ 서버가 준 문자열을 믿지 않고 **항상 ikX 에서 로컬 계산**한다 — 서버가 숫자를 위조해
//    "사용자가 눈으로 비교하는 채널"을 무력화하는 것을 막는다.
function fpOkm(ikX, userId) {
  return hkdf(u8(ikX), utf8(`${SUITE}/fp`), utf8(String(userId == null ? '' : userId)), 16);
}
function u32At(b, off) {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}
/**
 * 숫자 표기 파생. digits 별 오프셋은 **정본이 정해져 있다**(위 표) — 임의 자릿수를 넣으면
 *  4자리 오프셋(12)을 쓰되, 다른 구현체와 대조 가능한 값은 4/6 뿐이다.
 */
export function verifyDigits(ikX, userId, digits) {
  const b = fpOkm(ikX, userId);
  const off = digits === 6 ? 8 : 12;
  const mod = Math.pow(10, digits);
  return String(u32At(b, off) % mod).padStart(digits, '0');
}
/** 승인 요청 구분용 확인 숫자(4자리, 예: "8813") — **보안 대조값이 아니다**(safetyCode 를 쓸 것). */
export function verifyCode4(ikX, userId) { return verifyDigits(ikX, userId, 4); }
/** 기기 목록 감사용 지문(6자리, "418 209" 표기) = 데몬 fingerprint().legacy. */
export function fingerprint6(ikX, userId) {
  const s = verifyDigits(ikX, userId, 6);
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
// Crockford base32(I·L·O·U 제외) — 사람이 읽고 옮겨 적는 표기.
const FP32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * 60비트 안전코드 — "K7M2-9QXF-B4TR". **실제 MITM 대조는 이 값으로 한다.**
 *
 * ⚠ 짧은 숫자는 방어력이 없다. 서버는 userId 와 피해 기기의 실제 ikX 를 둘 다 알고 있어서
 *  "같은 표시값이 나오는 자기 키쌍"을 오프라인으로 찾을 수 있다. 실측(1코어):
 *    4자리(약 13비트) → 17,059회 / 1.3초 · 6자리(약 20비트) → 1,018,566회 / 80초.
 *  즉 사용자가 4자리를 비교해도 MITM 이 통과하고 승인 즉시 서버가 MK 를 얻는다.
 *  60비트는 그 사거리 밖이다. verifyCode4 는 "요청이 여럿일 때 어느 것인지" 구분용으로만 남긴다.
 *  ★ 데몬(runner-core/e2ee.js fingerprint)·서버(deviceTrustService fingerprintOf)와 바이트 동일해야 한다.
 */
export function safetyCode(ikX, userId) {
  const b = fpOkm(ikX, userId);
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[i]);
  let s = '';
  for (let i = 0; i < 12; i++) { s = FP32[Number(v & 31n)] + s; v >>= 5n; }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** QR 핀닝용 짧은 지문 — QR 의 `k=` 값과 대조(설계 §3.2). sha256(ikX) 앞 16B. */
export function qrPin(ikX) { return b64uEnc(copyOf(sha256(u8(ikX)), 0, 16)); }

// ── 마스터키 봉인(grant) — NaCl sealed-box 등가(설계 §2.9) ──────
//  ★ 바이트 정본 = 데몬 runner-core/e2ee.js(grantAad/grantSigMsg). 설계서의 추상 표기
//    (`aad="grant"||epoch||ikX`)를 여기 형태로 확정한다 — epoch 는 **u32 BE**(문자열 아님).
//  aad = utf8("grant") || u32(epoch) || ikX(32)
function grantAad(epoch, ikX) { return concat(utf8('grant'), u32(epoch), u8(ikX)); }
/** 서명 대상 = utf8("cpt-e2ee/v1/grant") || u32(epoch) || ikX(32) || sha256(sealed) */
export function grantSigMsg(epoch, ikX, sealed) {
  return concat(utf8(D.grant), u32(epoch), u8(ikX), sha256(u8(sealed)));
}

/** MK 를 수신 기기 공개키(ikX)로 봉인 → ephPub(32) || AEAD(...). 승인자만 호출. */
export function sealGrant(mk, epoch, recipientIkX) {
  const ephPriv = randomBytes(32);
  const ephPub = x25519Public(ephPriv);
  const ss = x25519(ephPriv, recipientIkX);
  const key = hkdf(ss, sha256(concat(ephPub, u8(recipientIkX))), utf8(`${SUITE}/grant`), 32);
  const ct = aeadSeal(key, new Uint8Array(12), grantAad(epoch, recipientIkX), u8(mk));
  return concat(ephPub, ct);
}
/** 봉인문 개봉 → MK(32B) | null. 내 ikX 개인키로만 열린다. */
export function openGrant(sealed, myIkXPriv, myIkXPub, epoch) {
  const s = u8(sealed);
  if (s.length < 32 + 16) return null;
  const ephPub = copyOf(s, 0, 32);
  const ct = copyOf(s, 32);
  let ss;
  try { ss = x25519(myIkXPriv, ephPub); } catch (_) { return null; }
  const key = hkdf(ss, sha256(concat(ephPub, u8(myIkXPub))), utf8(`${SUITE}/grant`), 32);
  const pt = aeadOpen(key, new Uint8Array(12), grantAad(epoch, myIkXPub), ct);
  return pt && pt.length === 32 ? pt : null;
}
export function signGrant(approverEdPriv, epoch, recipientIkX, sealed) {
  return ed25519Sign(approverEdPriv, grantSigMsg(epoch, recipientIkX, sealed));
}
/** 승인자 공개키로 서명 검증 — 서버가 임의로 만든 봉인문 주입 차단(설계 §2.9). */
export function verifyGrantSig(approverEdPub, epoch, recipientIkX, sealed, sig) {
  if (!approverEdPub || !sig) return false;
  return ed25519Verify(u8(approverEdPub), grantSigMsg(epoch, recipientIkX, sealed), u8(sig));
}

// ── RPC 봉투(설계 §2.5) ────────────────────────────────────────
//  nonce = [8B 부팅 난수][4B 카운터 BE] — 같은 키로 논스 재사용 금지.
//  ⚠ 난수가 8B 여야 하는 이유: 봉투 키(K_rpc)는 MK 에서만 파생돼 **계정 전역**이다(모든 기기·모든
//   앱 재시작이 같은 키). 따라서 nonce 충돌 = 부팅난수 충돌이고, 4B 면 생일 문제로 (기기×부팅) N 개에서
//   확률 ≈ N²/2^33 — 앱 재시작이 잦은 모바일에서 현실적 확률이 된다. ChaCha20-Poly1305 의 nonce 재사용은
//   키스트림 복원 + 위조로 이어지는 치명 실패다. 8B 로 넓히면 ≈ N²/2^65 로 사실상 불가능해진다.
//   카운터는 부팅당 2^32 건. 데몬(runner-core/e2ee.js envNonce)과 같은 분할이어야 리플레이 창 집계가 맞는다.
//  aad   = utf8("cpt-e2ee/v1/rpc"|"…/rpc-resp") || u32(epoch) || u32(hostDeviceId||0)
export function rpcAad(label, epoch, hostDeviceId) {
  const dom = label === K_RPC_RESP ? D.rpcResp : D.rpc;
  return concat(utf8(dom), u32(epoch), u32(hostDeviceId == null ? 0 : hostDeviceId));
}
export function makeNonce(bootRand8, counter) {
  const n = new Uint8Array(12);
  n.set(u8(bootRand8).subarray(0, 8), 0);
  let c = BigInt(counter) & 0xffffffffn; // u32 — 부팅당 42억 건
  for (let i = 11; i >= 8; i--) { n[i] = Number(c & 0xffn); c >>= 8n; }
  return n;
}

/** 요청 봉투 생성. @returns {{v,suite,epoch,nonce,ct}} */
export function sealRpc(mk, epoch, hostDeviceId, bootRand4, counter, payload) {
  const key = deriveKey(mk, K_RPC);
  const nonce = makeNonce(bootRand4, counter);
  const ct = aeadSeal(key, nonce, rpcAad(K_RPC, epoch, hostDeviceId), utf8(JSON.stringify(payload)));
  return { v: 1, suite: SUITE, epoch, nonce: b64uEnc(nonce), ct: b64uEnc(ct) };
}
/** 응답 봉투 개봉 → 평문 객체 | null(복호 실패). */
export function openRpcResponse(mk, env, hostDeviceId) {
  if (!env || env.v !== 1 || env.suite !== SUITE) return null;
  const key = deriveKey(mk, K_RPC_RESP);
  let pt = null;
  try {
    pt = aeadOpen(key, b64uDec(env.nonce), rpcAad(K_RPC_RESP, env.epoch, hostDeviceId), b64uDec(env.ct));
  } catch (_) { return null; }
  if (!pt) return null;
  try { return JSON.parse(fromUtf8(pt)); } catch (_) { return null; }
}
/** (테스트/데몬 미러) 응답 봉인 — 클라가 자기 코어로 왕복 검증할 수 있게 대칭 함수를 노출한다. */
export function sealRpcResponse(mk, epoch, hostDeviceId, bootRand4, counter, payload) {
  const key = deriveKey(mk, K_RPC_RESP);
  const nonce = makeNonce(bootRand4, counter);
  const ct = aeadSeal(key, nonce, rpcAad(K_RPC_RESP, epoch, hostDeviceId), utf8(JSON.stringify(payload)));
  return { v: 1, suite: SUITE, epoch, nonce: b64uEnc(nonce), ct: b64uEnc(ct) };
}
export function openRpcRequest(mk, env, hostDeviceId) {
  if (!env || env.v !== 1 || env.suite !== SUITE) return null;
  const key = deriveKey(mk, K_RPC);
  let pt = null;
  try {
    pt = aeadOpen(key, b64uDec(env.nonce), rpcAad(K_RPC, env.epoch, hostDeviceId), b64uDec(env.ct));
  } catch (_) { return null; }
  if (!pt) return null;
  try { return JSON.parse(fromUtf8(pt)); } catch (_) { return null; }
}

// ── 알림 body 봉인(설계 §2.6) ──────────────────────────────────
//  body = "cptenc:1:<epoch>:<b64u nonce12>:<b64u ct>"  / aad = "cpt-e2ee/v1/notif|<epoch>"
//  ⚠ 데몬이 body 를 봉인할 때는 subtitle 을 반드시 함께 보낸다(잠금화면에 암호문 노출 방지).
//    = 우리 최대 우위(도달하는 알림)를 깎지 않기 위한 규칙. 클라는 접두사를 만나면 조용히 복호한다.
export function isSealedBody(s) { return typeof s === 'string' && s.startsWith(NOTIF_PREFIX); }
export function sealNotifBody(mk, epoch, text) {
  const key = deriveKey(mk, K_NOTIF);
  const nonce = randomBytes(12);
  const ct = aeadSeal(key, nonce, concat(utf8(D.notif), u32(epoch)), utf8(String(text)));
  return `${NOTIF_PREFIX}${epoch}:${b64uEnc(nonce)}:${b64uEnc(ct)}`;
}
/** @returns 평문 | null(키 없음/에폭 없음/변조). null 이면 UI 가 "🔒 암호화된 내용" 을 그린다. */
export function openNotifBody(keyForEpoch, body) {
  if (!isSealedBody(body)) return body == null ? null : String(body);
  const parts = String(body).slice(NOTIF_PREFIX.length).split(':');
  if (parts.length < 3) return null;
  const epoch = Number(parts[0]);
  const mk = keyForEpoch(epoch);
  if (!mk) return null;
  try {
    const pt = aeadOpen(deriveKey(mk, K_NOTIF), b64uDec(parts[1]), concat(utf8(D.notif), u32(epoch)), b64uDec(parts[2]));
    return pt ? fromUtf8(pt) : null;
  } catch (_) { return null; }
}

// ── 복구 코드 — **자기완결형**(데몬 runner-core/e2ee.js recoveryCode 와 동일 형식) ──
//  ★ 서버에 봉인문을 올리지 않는다: 코드 문자열 자체가 MK 를 담는다(서버 라운드트립 0, GET 라우트 불필요).
//    payload = [ver 0x01][epoch u16 BE][MK 32B](35B) || chk2 = SHA256(D.recovery||payload)[0..2]
//    → 37B → Crockford base32 60자 → "CPT1-" + 5자 12그룹
//  주의: 이 문자열은 **마스터키 그대로**다 — 화면에 1회만 보이고, 어디에도 저장/전송하지 않는다.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: I·L·O·U 제외
const B32_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < B32.length; i++) m.set(B32[i], i);
  m.set('O', 0); m.set('I', 1); m.set('L', 1); m.set('U', B32.indexOf('V')); // 흔한 오타 흡수
  return m;
})();
function b32encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const byte of u8(buf)) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of str) {
    const v = B32_MAP.get(ch);
    if (v == null) return null;
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}
function recoveryBody(epoch, mk) {
  const b = new Uint8Array(35);
  b[0] = 1;
  b[1] = (Number(epoch) >>> 8) & 0xff;
  b[2] = Number(epoch) & 0xff;
  b.set(u8(mk).subarray(0, 32), 3);
  return b;
}
/** MK → 복구 코드 문자열("CPT1-…"). */
export function recoveryCode(epoch, mk) {
  const body = recoveryBody(epoch, mk);
  const chk = copyOf(sha256(concat(utf8(D.recovery), body)), 0, 2);
  const code = b32encode(concat(body, chk));
  return 'CPT1-' + (code.match(/.{1,5}/g) || []).join('-');
}
/**
 * 복구 코드 → {epoch, mk} | null(오타/형식 오류).
 *  60자 = 300비트 > 37바이트(296비트)이므로 **정규 인코딩 재확인**까지 한다 — 안 하면 마지막 한 글자
 *  오타가 같은 바이트로 복호돼 체크섬을 통과한다(데몬에서 실측된 함정).
 */
export function parseRecoveryCode(input) {
  if (typeof input !== 'string') return null;
  let t = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (t.startsWith('CPT1')) t = t.slice(4);
  if (t.length !== 60) return null;
  let canon = '';
  for (const ch of t) {
    const v = B32_MAP.get(ch);
    if (v == null) return null;
    canon += B32[v];
  }
  const raw = b32decode(canon);
  if (!raw || raw.length < 37) return null;
  const r37 = copyOf(raw, 0, 37);
  if (b32encode(r37) !== canon) return null;
  const body = copyOf(r37, 0, 35);
  const chk = copyOf(r37, 35, 37);
  if (!ctEq(chk, copyOf(sha256(concat(utf8(D.recovery), body)), 0, 2))) return null;
  if (body[0] !== 1) return null;
  return { epoch: (body[1] << 8) | body[2], mk: copyOf(body, 3, 35) };
}
/** 사용자 입력 정규화(화면 표기용) — 그룹 하이픈을 다시 붙여 보여준다. */
export function normalizeRecoveryCode(input) {
  const t = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return t;
}

// ── 스트림 세션(설계 §2.4) — D단계(PTY/forward)용. 지금은 계약만 확정하고 게이팅 OFF ──
//  ⚠ PTY 와이어에는 early resize 버퍼·window-size latest·한글 input 델타 보정이 얹혀 있다.
//    프레임 경계에 암복호를 끼우면 isBinary/resize JSON 위치가 재정의되므로, 이 함수들을 실제로
//    켜는 것은 데몬/백엔드 회귀 테스트(stream-select / reconnect-race)를 암호 모드로 통과시킨 뒤다.
export const DIR_V2H = 0x01; // viewer → host
export const DIR_H2V = 0x02;
export const KIND_DATA = 0x0;
export const KIND_CTRL = 0x1;

/** 트랜스크립트(LF 구분 정규 바이트열) — 서버가 몰래 다른 PC/pane/포트로 라우팅하면 confirm 불일치. */
export function sessionTranscript(o) {
  const lines = [
    // 0 suite / 1 purpose / 2 transport / 3 epoch / 4 hostDeviceId / 5 clientKey …
    //  transport(relay|direct|lan)가 포함되므로 릴레이 다운그레이드도 confirm 불일치로 실패한다.
    o.suite || SUITE, String(o.purpose), String(o.transport || 'relay'),
    String(Number(o.epoch)), String(o.hostDeviceId == null ? '' : o.hostDeviceId), String(o.clientKey == null ? '' : o.clientKey),
    b64uEnc(o.pubViewer), b64uEnc(o.pubHost), b64uEnc(o.nonceViewer), b64uEnc(o.nonceHost),
    o.routingCanonical || '',
  ];
  return utf8(lines.join('\n'));
}
export function routingCanonical(purpose, routing) {
  const r = routing || {};
  if (purpose === 'pty') return `pty|${r.cwd || ''}|${r.paneId || ''}|${r.win == null ? '' : r.win}`;
  return `tcp|${r.port == null ? '' : r.port}`;
}
/** 세션키 파생. mk 를 PSK 로 섞어 PFS + 계정 인증을 동시에 얻는다. */
export function deriveSession(o) {
  const ecdh = x25519(o.privSelf, o.pubPeer);
  const salt = sha256(concat(utf8(D.salt), u8(o.nonceViewer), u8(o.nonceHost)));
  const ikm = concat(ecdh, u8(o.mk));
  const info = concat(utf8(D.session), new Uint8Array([0]), sha256(sessionTranscript(o)));
  const okm = hkdf(ikm, salt, info, 112);
  const kConfirm = copyOf(okm, 96, 112);
  return {
    kV2H: copyOf(okm, 0, 32),
    kH2V: copyOf(okm, 32, 64),
    sid: copyOf(okm, 64, 96),
    kConfirm,
    confirm: hmacSha256(kConfirm, utf8('host-confirm')),       // 호스트가 MK 보유 증명
    viewerConfirm: hmacSha256(kConfirm, utf8('viewer-confirm')),
  };
}
export function frameHeader(dir, kind, connId, counter) {
  const h = new Uint8Array(12);
  h[0] = 0x01;
  h[1] = (dir & 0x0f) | ((kind & 0x0f) << 4);
  h[2] = (connId >>> 24) & 0xff; h[3] = (connId >>> 16) & 0xff; h[4] = (connId >>> 8) & 0xff; h[5] = connId & 0xff;
  let c = BigInt(counter);
  for (let i = 11; i >= 6; i--) { h[i] = Number(c & 0xffn); c >>= 8n; }
  return h;
}
/** 프레임 봉인 — nonce=header, AAD=header||sid, 평문 앞에 header 반복(리플레이/방향혼동 차단). */
export function sealFrame(key, sid, dir, kind, connId, counter, payload) {
  const h = frameHeader(dir, kind, connId, counter);
  return concat(h, aeadSeal(key, h, concat(h, u8(sid)), concat(h, u8(payload))));
}
/** @returns {{dir,kind,connId,counter,payload}} | null */
export function openFrame(key, sid, frame) {
  const f = u8(frame);
  if (f.length < 12 + 12 + 16 || f[0] !== 0x01) return null;
  const h = copyOf(f, 0, 12);
  const pt = aeadOpen(key, h, concat(h, u8(sid)), copyOf(f, 12));
  if (!pt || pt.length < 12 || !ctEq(copyOf(pt, 0, 12), h)) return null;
  let counter = 0n;
  for (let i = 6; i < 12; i++) counter = (counter << 8n) | BigInt(h[i]);
  return {
    dir: h[1] & 0x0f,
    kind: (h[1] >> 4) & 0x0f,
    connId: ((h[2] << 24) | (h[3] << 16) | (h[4] << 8) | h[5]) >>> 0,
    counter: Number(counter),
    payload: copyOf(pt, 12),
  };
}

export default {
  E2EE_CAP, CAP_RPC, CAP_STREAM, CAP_SNAP, NOTIF_PREFIX, D, u32,
  deriveKey, K_RPC, K_RPC_RESP, K_NOTIF, K_SNAPSHOT,
  verifyDigits, verifyCode4, fingerprint6, safetyCode, qrPin,
  sealGrant, openGrant, signGrant, verifyGrantSig, grantSigMsg,
  rpcAad, makeNonce, sealRpc, openRpcResponse, sealRpcResponse, openRpcRequest,
  isSealedBody, sealNotifBody, openNotifBody,
  recoveryCode, parseRecoveryCode, normalizeRecoveryCode,
  DIR_V2H, DIR_H2V, KIND_DATA, KIND_CTRL,
  sessionTranscript, routingCanonical, deriveSession, frameHeader, sealFrame, openFrame,
};
