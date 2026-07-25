/**
 * 기기 신뢰(E2EE 열쇠 배포) 서비스 — 기능2 A단계.
 *
 * 이 단계에서 트래픽 암호화는 **하지 않는다**. 하는 일은 딱 하나:
 *   "계정 마스터키(MK)를 새 기기에 안전하게 옮기는 표면" + "서버가 절대 MK 평문을 못 보는 구조".
 *
 * 흐름(설계 §3 · Signal/WhatsApp 모델)
 *   1) 새 기기: 로그인 직후 자기 신원키쌍(ikX/ikEd)을 만들고 `POST /e2ee/enroll`
 *      → 계정에 열쇠가 아직 없으면 state:'bootstrap'(자기가 MK_1 생성) / 있으면 state:'pending'
 *   2) pending 이면 서버가 **기존 알림·approval 배관 그대로** 신뢰 기기들에 팬아웃
 *      (notificationService = 인박스 + FCM + 크로스기기 dismiss, relay.fanoutDeviceApproval = 인앱 시트)
 *   3) 신뢰 기기가 확인번호 4자리를 눈으로 대조하고 1탭 승인 → **자기 로컬 MK 를 새 기기 공개키로 봉인**해
 *      `POST /e2ee/approve` 로 업로드. 서버는 봉인문(암호문)만 저장/중계한다.
 *   4) 새 기기는 enroll 재호출(또는 WS resolved)로 봉인문을 받아 자기 개인키로 열어 MK 획득.
 *
 * ★ 서버가 MK 평문을 받을 수 없는 근거(설계 불변식)
 *   · 평문 MK 를 담을 **필드가 존재하지 않는다**. 요청 본문은 화이트리스트로만 읽고,
 *     mk/masterKey/secret/plaintext 류 키가 오면 400 PLAINTEXT_KEY_REJECTED 로 거절한다(오전송 방어).
 *   · `sealed` 는 길이가 **정확히 80B**(ephPub32 || ct32 || tag16)여야 한다 → 32B 원문 키는 형식부터 불합격.
 *   · 봉인/서명은 전부 클라이언트가 만들고, 수신 기기는 `sig` 를 **키링의 승인자 ikEd** 로 검증한다.
 *     서버가 만든 봉인문은 서명이 없어 수신 기기가 거부한다(서버 주입 불가).
 *   · 서버는 추가로 Ed25519 서명을 자체 검증해 쓰레기 grant 가 키링을 오염시키는 것을 막는다(선택 검증).
 *
 * 저장 위치(★ DB 마이그레이션 0)
 *   objectstore `workspace/<uid>/e2ee/keyring.json` (s3Service 경유 → 비공개 prefix) + 프로세스 캐시.
 *   근거는 파일 하단 STORAGE_RATIONALE 주석 참조. 대기 중 enrollment 는 **인메모리 전용**
 *   (pairCodes/approvalService 선례 — TTL 짧고, 소실되면 새 기기가 멱등 재신청하면 끝).
 *
 * 서명 정본 바이트열(다른 구현체가 반드시 맞춰야 하는 계약):
 *   msg = "cpt-e2ee/v1/grant" || 0x00 || ascii(epoch) || 0x00 || ikX_recipient(32B) || SHA256(sealed)(32B)
 *   sig = Ed25519(ikEd_approver, msg)
 */
const crypto = require('crypto');
const s3Service = require('./s3Service');
const notificationService = require('./notificationService');
const pushService = require('./pushService');

function relay() { return require('./daemonRelayService'); } // lazy — 순환 require 회피

// ── 설정 ──────────────────────────────────────────────────────────────
function envOff(v) { return /^(0|false|off|no)$/i.test(String(v == null ? '' : v).trim()); }
function intEnv(name, dflt) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : dflt; }

// 서버 킬스위치 — 끄면 caps 에서 e2ee.keys.v1 이 회수되고(config/caps.js) 이 라우트들도 503.
const E2EE_ENABLED = !envOff(process.env.E2EE_ENABLED);
// 서명 자체검증 스위치(문제 시 탈출구). 끄면 서버는 형식만 보고 저장한다 — 수신 기기의 검증이 정본이므로
//  보안은 유지되지만, 잘못된 서명이 키링에 남아 "클라에서만 조용히 실패"하는 디버깅 지옥이 열린다.
const VERIFY_SIG = !envOff(process.env.E2EE_VERIFY_SIG);
const ENROLL_TTL_MS = intEnv('E2EE_ENROLL_TTL_MS', 10 * 60 * 1000);
const MAX_PENDING_PER_USER = intEnv('E2EE_MAX_PENDING', 5);
const ENROLL_MAX_PER_MIN = intEnv('E2EE_ENROLL_MAX_PER_MIN', 10);
const DECIDE_MAX_PER_MIN = intEnv('E2EE_DECIDE_MAX_PER_MIN', 30);
// 거부 후 재시도 억제 — 사용자가 "아니오"를 눌렀는데 같은 키가 계속 조르면 알림 폭탄이 된다.
const DENY_BLOCK_MAX = 3;
const DENY_BLOCK_MS = 10 * 60 * 1000;
const ANDROID_CHANNEL = String(process.env.E2EE_ANDROID_CHANNEL || process.env.APPROVAL_ANDROID_CHANNEL || 'codingpt_default');
const SWEEP_MS = 30 * 1000;

const KEY_MAX = 32;         // 계정당 기기 키 상한(키링 blob 크기 상한)
const GRANT_MAX = 256;      // 봉인문 행 상한
const EPOCH_KEEP = 8;       // 보관할 과거 epoch 수(옛 스냅샷 복호용 — §6-19). 그보다 오래된 grant 는 정리
const SEALED_LEN = 80;      // ephPub(32) || AEAD(MK32) + tag(16)
const SIG_LEN = 64;
const PUB_LEN = 32;
const RECOVERY_MAX = 256;   // 복구 코드 봉인문(형식은 클라 정의 — 서버는 불투명 바이트로만 취급)
const POLICIES = ['off', 'preferred', 'required'];
const LABEL_MAX = 64;
const SUITE = 'cpt-e2ee/v1';

// 평문 키를 실수로 올리는 것을 잡는 그물 — 이런 이름의 필드는 존재하지 않으며, 오면 거절한다.
const FORBIDDEN_FIELDS = ['mk', 'masterKey', 'master_key', 'plaintext', 'secret', 'key', 'privateKey', 'priv'];

// ── 에러 ──────────────────────────────────────────────────────────────
function err(message, statusCode, code, extra) {
  return Object.assign(new Error(message), { statusCode, code, publicDetail: { code, ...(extra || {}) } });
}

// ── b64url 헬퍼 ───────────────────────────────────────────────────────
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
// 정확한 바이트 길이 + 정규형(재인코딩 일치)만 통과. 패딩/공백/비정규 입력을 조용히 삼키지 않는다.
function decodeExact(value, bytes, field) {
  if (typeof value !== 'string' || !value) throw err(`${field} 가 필요합니다.`, 400, 'BAD_FIELD', { field });
  if (value.length > 4096) throw err(`${field} 가 너무 깁니다.`, 400, 'BAD_FIELD', { field });
  let raw;
  try { raw = Buffer.from(value, 'base64url'); } catch (_) { throw err(`${field} 형식이 잘못되었습니다.`, 400, 'BAD_FIELD', { field }); }
  if (raw.length !== bytes) {
    throw err(`${field} 길이가 잘못되었습니다(${bytes}B 여야 합니다).`, 400, 'BAD_LENGTH', { field, expected: bytes, got: raw.length });
  }
  if (b64u(raw) !== value) throw err(`${field} 는 b64url(no-pad) 정규형이어야 합니다.`, 400, 'BAD_ENCODING', { field });
  return raw;
}
function decodeMax(value, maxBytes, field) {
  if (typeof value !== 'string' || !value) throw err(`${field} 가 필요합니다.`, 400, 'BAD_FIELD', { field });
  let raw;
  try { raw = Buffer.from(value, 'base64url'); } catch (_) { throw err(`${field} 형식이 잘못되었습니다.`, 400, 'BAD_FIELD', { field }); }
  if (!raw.length || raw.length > maxBytes) throw err(`${field} 길이가 잘못되었습니다.`, 400, 'BAD_LENGTH', { field, max: maxBytes, got: raw.length });
  if (b64u(raw) !== value) throw err(`${field} 는 b64url(no-pad) 정규형이어야 합니다.`, 400, 'BAD_ENCODING', { field });
  return raw;
}

// 평문 키 오전송 그물 — body 최상위에 금지 필드가 있으면 즉시 거절(로그에도 값을 남기지 않는다).
function rejectPlaintextFields(body) {
  const b = body && typeof body === 'object' ? body : {};
  for (const f of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(b, f)) {
      throw err('서버는 마스터키 평문을 받지 않습니다. 봉인문(sealed)만 업로드하세요.', 400, 'PLAINTEXT_KEY_REJECTED', { field: f });
    }
  }
}

// ── 지문/확인번호(순수) ───────────────────────────────────────────────
// 사람이 두 화면에서 눈으로 대조하는 값. **공개키에서 결정적으로 파생**한다 —
//  서버가 랜덤으로 발급하면 공개키를 바꿔치기해도 두 화면 값이 같아져 MITM 을 못 잡는다.
//
// ⚠ 엔트로피가 곧 안전성이다. 서버는 userId 와 피해 기기의 실제 공개키를 둘 다 알고 있어서
//  "같은 표시값이 나오는 자기 키쌍"을 오프라인으로 찾을 수 있다. 실측: 4자리 1.3초 / 6자리 80초.
//  그래서 **대조용 값은 60비트(base32 12글자)** 로 낸다. 4자리는 "승인 요청이 여럿일 때 어느 것인지"
//  구분하는 보조값일 뿐이며 보안 근거가 아니다(UI 문구로 역할을 분명히 해야 한다).
//  ⚠ 이 파생은 데몬(runner-core/e2ee.js fingerprint)·앱과 **바이트 단위로 같아야** 한다 —
//  값이 갈라지면 사용자가 두 화면을 비교할 수 없다.
const FP32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32(I·L·O·U 제외)
function fingerprintOf(userId, ikXRaw) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikXRaw), Buffer.from(`${SUITE}/fp`), Buffer.from(String(userId)), 16));
  let v = (BigInt(okm.readUInt32BE(0)) << 32n) | BigInt(okm.readUInt32BE(4));
  let s = '';
  for (let i = 0; i < 12; i++) { s = FP32[Number(v & 31n)] + s; v >>= 5n; }
  const six = String(okm.readUInt32BE(8) % 1000000).padStart(6, '0');
  return {
    safetyCode: `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`, // 60비트 — 실제 대조 대상
    verifyCode: String(okm.readUInt32BE(12) % 10000).padStart(4, '0'), // 요청 구분용(보안값 아님)
    fingerprint: `${six.slice(0, 3)} ${six.slice(3)}`,             // 구 UI 호환
  };
}

// ── Ed25519 grant 서명 검증(순수) ─────────────────────────────────────
const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // SPKI(Ed25519) 고정 헤더
// ⚠ 이 바이트열은 데몬(runner-core/e2ee.js)·앱(e2eeProto.js)과 **바이트 단위로 같아야** 한다.
//  서명은 승인자(다른 기기)가 만들고 서버가 검증하므로, 한 바이트라도 다르면 모든 grant 가
//  SIG_INVALID 로 거절되어 **열쇠가 단 한 대도 배포되지 않는다**(기능 전체가 조용히 죽는다).
//  epoch 는 문자열이 아니라 **u32 big-endian** 이다(데몬/앱 구현이 정본 — 2:1).
//  이 형식을 바꿀 때는 3개 구현체를 동시에 바꾸고 교차 검증 테스트를 함께 갱신할 것.
function grantSigMessage(epoch, ikXRaw, sealedRaw) {
  const ep = Buffer.alloc(4);
  ep.writeUInt32BE(Number(epoch) >>> 0, 0);
  return Buffer.concat([
    Buffer.from(`${SUITE}/grant`, 'utf8'),
    ep,
    Buffer.from(ikXRaw),
    crypto.createHash('sha256').update(Buffer.from(sealedRaw)).digest(),
  ]);
}
function verifyGrantSig({ epoch, ikXRaw, sealedRaw, sigRaw, approverIkEdRaw }) {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(approverIkEdRaw)]), format: 'der', type: 'spki' });
    return crypto.verify(null, grantSigMessage(epoch, ikXRaw, sealedRaw), pub, Buffer.from(sigRaw));
  } catch (_) { return false; }
}

// ── 키링 저장(objectstore) ────────────────────────────────────────────
//
// STORAGE_RATIONALE — 왜 DB 가 아니라 objectstore + 인메모리 캐시인가
//  · 제약: 이 라운드는 **마이그레이션 금지**. daemon_device 에 남는 컬럼이 없고, 의미가 잡힌 컬럼
//    (container_id 등)을 공개키 저장에 전용하면 cloudRunnerService 가 그 컬럼을 쓰는 순간 열쇠가 날아간다.
//  · 데이터 성격이 workspaceService(project.json)와 동일하다: 계정당 수십 개 × 수백 바이트의 작은 메타.
//    그 서비스가 이미 "DB 없이 objectstore 만으로 관리(단일/소수 사용자 전제)"를 선례로 확립했다.
//  · 담는 것은 **공개키 + 암호문 + 서명**뿐이다(자격증명 아님 → token_hash 처럼 DB 로 지킬 필요 없음).
//    경로는 s3Service 경유라 익명 read 가 403(공개 prefix 는 tts/static, lesson-assets 뿐).
//  · 계정 삭제 시 workspace/<uid> 재귀 삭제에 함께 지워진다(별도 정리 코드 불필요).
//  · 한계: objectstore 에 CAS 가 없다 → 프로세스 내 유저별 직렬화 큐(withKeyring)로 lost-update 를 막는다.
//    back 다중 인스턴스가 되면 진짜 테이블/락이 필요하다(보고서 "마이그레이션 필요 여부" 참조).
const keyringKey = (uid) => `workspace/${uid}/e2ee/keyring.json`;
const safeUid = (userId) => String(userId == null ? '' : userId).replace(/[^A-Za-z0-9_-]/g, '');

// 실 저장소(테스트에서 _setStore 로 교체 가능).
let store = {
  async load(uid) {
    const res = await s3Service.getFileContent(keyringKey(uid));
    if (!res || !res.success) {
      // ★ 404 와 그 외 실패를 반드시 구분한다. 장애를 "빈 키링"으로 뭉개면 부트스트랩이 한 번 더 허용돼
      //   계정 열쇠가 갈라진다(모든 기기가 서로 못 읽는 최악의 상태).
      if (res && (res.error === 'NoSuchKey' || res.error === 'NotFound')) return null;
      throw err('열쇠 저장소에 접근할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503, 'KEYRING_UNAVAILABLE');
    }
    let content = res.content;
    if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
    try { return JSON.parse(content); } catch (_) {
      throw err('열쇠 저장소가 손상되었습니다.', 500, 'KEYRING_CORRUPT');
    }
  },
  async save(uid, obj) {
    const res = await s3Service.saveFile(keyringKey(uid), JSON.stringify(obj));
    if (!res || !res.success) throw err('열쇠를 저장할 수 없습니다.', 503, 'KEYRING_WRITE_FAILED');
  },
};

const cache = new Map();   // uid → keyring 객체(프로세스 캐시 = 쓰기 관통)
const chains = new Map();  // uid → Promise (유저별 read-modify-write 직렬화)

function emptyKeyring() {
  return { v: 1, suite: SUITE, epoch: 0, policy: 'preferred', keys: [], grants: [], recovery: null, nextKeyId: 1, updatedAt: null };
}
function normalizeKeyring(k) {
  const base = emptyKeyring();
  if (!k || typeof k !== 'object') return base;
  const out = {
    ...base,
    epoch: Number.isInteger(k.epoch) && k.epoch >= 0 ? k.epoch : 0,
    policy: POLICIES.includes(k.policy) ? k.policy : 'preferred',
    keys: Array.isArray(k.keys) ? k.keys.slice(0, KEY_MAX) : [],
    grants: Array.isArray(k.grants) ? k.grants.slice(0, GRANT_MAX) : [],
    recovery: k.recovery && typeof k.recovery === 'object' ? k.recovery : null,
    updatedAt: k.updatedAt || null,
  };
  out.nextKeyId = Number.isInteger(k.nextKeyId) && k.nextKeyId > 0
    ? k.nextKeyId
    : out.keys.reduce((m, x) => Math.max(m, Number(x.keyId) || 0), 0) + 1;
  return out;
}

async function loadKeyring(userId) {
  const uid = safeUid(userId);
  if (!uid) throw err('인증이 필요합니다.', 401, 'UNAUTHENTICATED');
  if (cache.size > 500 && !cache.has(uid)) cache.clear(); // 무한 성장 방지(그냥 다시 읽으면 된다)
  if (cache.has(uid)) return cache.get(uid);
  const raw = await store.load(uid);
  const k = normalizeKeyring(raw);
  cache.set(uid, k);
  return k;
}
async function saveKeyring(userId, k) {
  const uid = safeUid(userId);
  k.updatedAt = new Date().toISOString();
  await store.save(uid, k);
  cache.set(uid, k);
  return k;
}
// 유저별 직렬화 — objectstore 는 CAS 가 없으므로 read-modify-write 를 겹치게 하면 승인 2건이 서로를 덮는다.
function withKeyring(userId, fn) {
  const uid = safeUid(userId);
  const prev = chains.get(uid) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const tail = next.then(() => {}, () => {});
  chains.set(uid, tail);
  // 큐가 비면 엔트리를 지운다(유저 수만큼 Map 이 영구히 남지 않게).
  tail.then(() => { if (chains.get(uid) === tail) chains.delete(uid); });
  return next;
}

function trustedKeys(k) { return k.keys.filter((x) => x.state === 'trusted'); }
function keyByIkX(k, ikX) { return k.keys.find((x) => x.ikX === ikX) || null; }
function grantFor(k, epoch, keyId) { return k.grants.find((g) => g.epoch === epoch && g.recipientKeyId === keyId) || null; }
function publicGrant(g) {
  return g ? { epoch: g.epoch, sealed: g.sealed, sealedByKeyId: g.sealedByKeyId, sig: g.sig, createdAt: g.createdAt } : null;
}
function publicKeyRow(userId, row) {
  const fp = fingerprintOf(userId, Buffer.from(row.ikX, 'base64url'));
  return {
    keyId: row.keyId, label: row.label, platform: row.platform, kind: row.kind,
    deviceId: row.deviceId ?? null, state: row.state, ikX: row.ikX, ikEd: row.ikEd,
    fingerprint: fp.fingerprint, verifyCode: fp.verifyCode,
    enrolledAt: row.enrolledAt, revokedAt: row.revokedAt || null, lastGrantEpoch: row.lastGrantEpoch ?? null,
  };
}

// ── 대기 중 enrollment(인메모리) ──────────────────────────────────────
// enrollmentId → { id, userId, ikX, ikEd, label, platform, kind, verifyCode, fingerprint,
//                  requestedAt, expiresAt, requestIp, notifId, resolved }
const pending = new Map();
const byUser = new Map();     // uid → Set<enrollmentId>
const denyCount = new Map();  // `${uid}:${ikX}` → { count, at }
const rateEnroll = new Map(); // uid → { windowStart, count }
const rateDecide = new Map();

function pendingIds(userId) { const s = byUser.get(safeUid(userId)); return s ? [...s] : []; }
function registerPending(rec) {
  pending.set(rec.id, rec);
  const uid = safeUid(rec.userId);
  let s = byUser.get(uid);
  if (!s) { s = new Set(); byUser.set(uid, s); }
  s.add(rec.id);
}
function unregisterPending(rec) {
  pending.delete(rec.id);
  const uid = safeUid(rec.userId);
  const s = byUser.get(uid);
  if (s) { s.delete(rec.id); if (!s.size) byUser.delete(uid); }
}
function pendingByIkX(userId, ikX) {
  for (const id of pendingIds(userId)) { const r = pending.get(id); if (r && r.ikX === ikX) return r; }
  return null;
}

// 레이트 리밋(순수 판정) — 1분 창.
function allowRate(map, userId, now, max) {
  const key = safeUid(userId);
  let r = map.get(key);
  if (!r || now - r.windowStart >= 60000) { r = { windowStart: now, count: 0 }; map.set(key, r); }
  r.count += 1;
  return r.count <= max;
}
function denyBlocked(userId, ikX, now) {
  const d = denyCount.get(`${safeUid(userId)}:${ikX}`);
  if (!d) return false;
  if (now - d.at >= DENY_BLOCK_MS) { denyCount.delete(`${safeUid(userId)}:${ikX}`); return false; }
  return d.count >= DENY_BLOCK_MAX;
}
function noteDeny(userId, ikX, now) {
  const key = `${safeUid(userId)}:${ikX}`;
  const d = denyCount.get(key);
  if (d && now - d.at < DENY_BLOCK_MS) { d.count += 1; d.at = now; } else denyCount.set(key, { count: 1, at: now });
}

// ── 팬아웃 ────────────────────────────────────────────────────────────
function fanout(userId, event) {
  try { relay().fanoutDeviceApproval(userId, event); } catch (_) { /* 팬아웃 실패가 승인 자체를 막지 않는다 */ }
}

function enabledGate() {
  if (!E2EE_ENABLED) throw err('종단간 암호화 기능이 현재 비활성화되어 있습니다.', 503, 'E2EE_DISABLED');
}

// ── 입력 정규화(순수) ─────────────────────────────────────────────────
function str(v, max) { return v == null ? null : String(v).slice(0, max); }
function normalizeIdentity(body) {
  rejectPlaintextFields(body);
  const b = body && typeof body === 'object' ? body : {};
  const ikXRaw = decodeExact(b.ikX, PUB_LEN, 'ikX');
  const ikEdRaw = decodeExact(b.ikEd, PUB_LEN, 'ikEd');
  const kind = ['host', 'controller'].includes(b.kind) ? b.kind : 'controller';
  return {
    ikX: b64u(ikXRaw), ikEd: b64u(ikEdRaw), ikXRaw, ikEdRaw,
    label: str(b.label, LABEL_MAX) || (kind === 'host' ? 'PC' : '기기'),
    platform: str(b.platform, 32) || null,
    kind,
  };
}
function newEnrollmentId() { return 'e_' + crypto.randomBytes(6).toString('hex'); }

// ── A. 등록 신청(멱등) ────────────────────────────────────────────────
// 반환:
//  { state:'bootstrap', epoch:0 }                            계정 최초 → 이 기기가 MK_1 을 만든다
//  { state:'trusted', epoch, keyId, grant }                   이미 승인됨(같은 ikX) → 봉인문 수령
//  { state:'pending', enrollmentId, verifyCode, expiresAt }   신뢰 기기 승인 대기
async function enroll(userId, deviceId, body, meta) {
  enabledGate();
  const now = Date.now();
  const id = normalizeIdentity(body);
  if (!allowRate(rateEnroll, userId, now, ENROLL_MAX_PER_MIN)) {
    throw err('요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', 429, 'RATE_LIMITED');
  }
  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    const existing = keyByIkX(k, id.ikX);
    if (existing && existing.state === 'trusted') {
      // 기기 메타 갱신(이름 변경/기기행 연결)만 하고 봉인문을 돌려준다 — 재부팅마다 호출되는 멱등 경로.
      let dirty = false;
      if (id.label && existing.label !== id.label) { existing.label = id.label; dirty = true; }
      if (deviceId != null && existing.deviceId !== Number(deviceId)) { existing.deviceId = Number(deviceId); dirty = true; }
      if (dirty) await saveKeyring(userId, k);
      return {
        state: 'trusted', epoch: k.epoch, keyId: existing.keyId, policy: k.policy,
        grant: publicGrant(grantFor(k, k.epoch, existing.keyId)),
        recoverySet: !!k.recovery,
      };
    }
    if (existing && existing.state === 'revoked') {
      throw err('이 기기의 열쇠는 해제되었습니다. 새 신원키로 다시 신청해 주세요.', 409, 'KEY_REVOKED');
    }
    // 계정에 열쇠가 없다 → 이 기기가 부트스트랩(승인해 줄 기기가 없으므로 서버가 1회 허용).
    if (k.epoch === 0 && trustedKeys(k).length === 0) {
      return { state: 'bootstrap', epoch: 0, policy: k.policy, suite: SUITE };
    }
    if (denyBlocked(userId, id.ikX, now)) {
      throw err('이 기기의 승인 요청이 반복 거절되었습니다. 잠시 후 다시 시도해 주세요.', 429, 'ENROLL_BLOCKED');
    }
    // 이미 대기 중이면 같은 enrollment 를 반환하고 팬아웃만 다시 쏜다(새 기기 앱 재시작/폴링).
    const already = pendingByIkX(userId, id.ikX);
    if (already) {
      fanout(userId, { kind: 'request', ...publicPending(already) });
      return { state: 'pending', ...publicPending(already), policy: k.policy };
    }
    if (pendingIds(userId).length >= MAX_PENDING_PER_USER) {
      throw err('승인 대기 중인 기기가 너무 많습니다.', 429, 'TOO_MANY_PENDING');
    }
    if (k.keys.length >= KEY_MAX) throw err('계정에 등록된 기기 열쇠가 너무 많습니다.', 409, 'KEY_LIMIT');

    const fp = fingerprintOf(userId, id.ikXRaw);
    const rec = {
      id: newEnrollmentId(), userId: Number(userId), ikX: id.ikX, ikEd: id.ikEd,
      label: id.label, platform: id.platform, kind: id.kind,
      verifyCode: fp.verifyCode, fingerprint: fp.fingerprint,
      requestedAt: now, expiresAt: now + ENROLL_TTL_MS,
      requestIp: maskIp(meta && meta.ip), notifId: null, resolved: false,
    };
    registerPending(rec);
    console.log(`[e2ee] 등록 신청 user=${userId} id=${rec.id} label="${rec.label}" code=${rec.verifyCode} epoch=${k.epoch} trusted=${trustedKeys(k).length}`);
    await announce(userId, rec);
    return { state: 'pending', ...publicPending(rec), policy: k.policy };
  });
}

// IP 는 감사 UI 표시용 — 마지막 옥텟/세그먼트를 가려 저장한다(위치 추정 정보 최소화).
function maskIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return null;
  if (s.includes('.')) return s.replace(/\.\d+$/, '.*').slice(0, 45);
  return s.split(':').slice(0, 4).join(':') + ':*';
}
function publicPending(rec) {
  return {
    // ★ 필드명이 `deviceKind` 인 이유: 이 객체는 `{kind:'request', ...publicPending(rec)}` 로 스프레드돼
    //   팬아웃 이벤트가 된다. 여기서 `kind` 를 쓰면 이벤트 종류('request')를 기기 종류로 덮어써
    //   클라이언트가 승인 시트를 영원히 못 띄운다(실제로 한 번 밟은 함정).
    enrollmentId: rec.id, label: rec.label, platform: rec.platform, deviceKind: rec.kind,
    ikX: rec.ikX, ikEd: rec.ikEd, verifyCode: rec.verifyCode, fingerprint: rec.fingerprint,
    requestedAt: new Date(rec.requestedAt).toISOString(), expiresAt: new Date(rec.expiresAt).toISOString(),
    requestIp: rec.requestIp,
  };
}

// 신뢰 기기들에 승인 요청 알리기 — **새 배관 없음**:
//  ① notificationService.createNotification → 인박스 + FCM + (해소 시) 크로스기기 dismiss
//  ② relay.fanoutDeviceApproval → 접속 중 화면에 인앱 승인 시트
async function announce(userId, rec) {
  fanout(userId, { kind: 'request', ...publicPending(rec) });

  // present 라우팅 사전 판정 — ★ 여기서 새 기기 자신이 present(모바일 활성)일 수 있다.
  //  그 경우 createNotification 의 suppressAll 게이트가 FCM 을 전량 억제해 **승인해 줄 폰에 알림이 안 간다**.
  //  (새 태블릿을 켠 순간 그 태블릿이 활성 기기가 되는 흔한 시나리오 = 기능 자체가 죽는 경로)
  //  → 게이트에 걸렸으면 같은 notifId 태그로 직접 1회 재발송한다(태그가 같아 배너 중복 아님. approvalService.escalate 선례).
  let present = null;
  try { present = relay().presentClient(userId); } catch (_) { /* noop */ }
  const route = notificationService._computeRoute(present);

  const push = {
    channelId: ANDROID_CHANNEL,
    category: 'CPT_DEVICE_APPROVAL', // iOS 미등록 카테고리 = 버튼 없는 배너(안전 폴백)
    data: {
      deviceApprovalId: rec.id, verifyCode: rec.verifyCode, label: rec.label,
      platform: rec.platform || '', expiresAt: String(rec.expiresAt),
    },
  };
  const deeplink = `codingpt://device-approval/${rec.id}`;
  let notification = null;
  try {
    notification = await notificationService.createNotification(Number(userId), {
      source: 'system',
      kind: 'device_approval',
      title: '새 기기 승인 요청',
      // subtitle 을 명시하는 이유: FCM 본문이 subtitle 우선이라 **확인번호가 잠금화면에 노출되지 않는다**.
      //  (확인번호는 비밀이 아니지만, 잠금화면에 숫자만 떠 있으면 사용자가 대조 없이 승인할 유인이 된다)
      subtitle: `${rec.label} 에서 접속을 시도했어요`,
      body: `확인번호 ${rec.verifyCode}${rec.platform ? ` · ${rec.platform}` : ''}`,
      sessionId: rec.id,
      deeplink,
      push,
    });
  } catch (e) {
    console.warn('[e2ee] 승인 알림 생성 실패:', e && e.message);
  }
  rec.notifId = notification ? notification.id : null;

  if (route.suppressAll || route.pcActive) {
    pushService.sendToUser(Number(userId), {
      kind: 'device_approval', sessionId: rec.id, notifId: rec.notifId,
      title: '새 기기 승인 요청', body: `${rec.label} 에서 접속을 시도했어요`,
      deeplink, channelId: push.channelId, category: push.category, data: push.data,
    }, { pcActive: false }).catch(() => { /* fire-and-forget */ });
  }
}

// ── B. 부트스트랩(계정 최초 1회) ──────────────────────────────────────
// req { ikX, ikEd, label, platform, kind, sealed(자기 자신에게 봉인한 MK_1), sig, recovery? }
async function bootstrap(userId, deviceId, body) {
  enabledGate();
  const now = Date.now();
  if (!allowRate(rateDecide, userId, now, DECIDE_MAX_PER_MIN)) throw err('요청이 너무 잦습니다.', 429, 'RATE_LIMITED');
  const id = normalizeIdentity(body);
  const b = body || {};
  const sealedRaw = decodeExact(b.sealed, SEALED_LEN, 'sealed');
  const sigRaw = decodeExact(b.sig, SIG_LEN, 'sig');
  const recovery = normalizeRecovery(b.recovery);
  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    // ★ 1회 제약 — 이미 초기화된 계정에서 다시 부트스트랩하면 계정 열쇠가 갈라진다(전 기기 상호 복호 불가).
    if (k.epoch !== 0 || trustedKeys(k).length > 0) {
      throw err('이 계정은 이미 열쇠가 있습니다. 기존 기기에서 승인해 주세요.', 409, 'E2EE_ALREADY_INITIALIZED', { epoch: k.epoch });
    }
    const epoch = 1;
    if (VERIFY_SIG && !verifyGrantSig({ epoch, ikXRaw: id.ikXRaw, sealedRaw, sigRaw, approverIkEdRaw: id.ikEdRaw })) {
      throw err('봉인문 서명 검증에 실패했습니다.', 400, 'SIG_INVALID');
    }
    const keyId = k.nextKeyId++;
    k.keys.push({
      keyId, ikX: id.ikX, ikEd: id.ikEd, label: id.label, platform: id.platform, kind: id.kind,
      deviceId: deviceId != null ? Number(deviceId) : null, state: 'trusted',
      enrolledAt: new Date(now).toISOString(), revokedAt: null, lastGrantEpoch: epoch,
    });
    k.grants.push({ epoch, recipientKeyId: keyId, sealed: b64u(sealedRaw), sealedByKeyId: keyId, sig: b64u(sigRaw), createdAt: new Date(now).toISOString() });
    k.epoch = epoch;
    if (recovery) k.recovery = { ...recovery, epoch };
    await saveKeyring(userId, k);
    console.log(`[e2ee] 부트스트랩 user=${userId} keyId=${keyId} epoch=1 recovery=${recovery ? 1 : 0}`);
    fanout(userId, { kind: 'bootstrapped', epoch, keyId });
    return { epoch, keyId, policy: k.policy, recoverySet: !!k.recovery };
  });
}

function normalizeRecovery(r) {
  if (r == null) return null;
  if (typeof r !== 'object') throw err('recovery 형식이 잘못되었습니다.', 400, 'BAD_FIELD', { field: 'recovery' });
  const blobRaw = decodeMax(r.blob, RECOVERY_MAX, 'recovery.blob');
  return { alg: str(r.alg, 32) || 'cpt-recovery/1', blob: b64u(blobRaw), createdAt: new Date().toISOString() };
}

// ── C. 대기 목록(신뢰 기기의 승인 시트) ───────────────────────────────
async function listPending(userId) {
  enabledGate();
  const now = Date.now();
  const k = await loadKeyring(userId);
  const items = pendingIds(userId)
    .map((id) => pending.get(id))
    .filter((r) => r && !r.resolved && r.expiresAt > now)
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map(publicPending);
  return { pending: items, epoch: k.epoch, policy: k.policy, trustedCount: trustedKeys(k).length };
}

// ── D. 승인 ───────────────────────────────────────────────────────────
// req { enrollmentId, ikX(에코), approverIkX, epoch, sealed, sig }
//  · ikX 에코 = 서버가 봉인 대상을 바꿔치기했는지 검증(§2.9 KEY_MISMATCH)
//  · approverIkX = 승인자 자기 공개키. 키링에서 trusted 여야 한다(대기 기기는 승인 불가)
async function approve(userId, body) {
  enabledGate();
  const now = Date.now();
  if (!allowRate(rateDecide, userId, now, DECIDE_MAX_PER_MIN)) throw err('요청이 너무 잦습니다.', 429, 'RATE_LIMITED');
  rejectPlaintextFields(body);
  const b = body || {};
  const enrollmentId = str(b.enrollmentId, 64) || '';
  const ikXRaw = decodeExact(b.ikX, PUB_LEN, 'ikX');
  const approverIkXRaw = decodeExact(b.approverIkX, PUB_LEN, 'approverIkX');
  const sealedRaw = decodeExact(b.sealed, SEALED_LEN, 'sealed');
  const sigRaw = decodeExact(b.sig, SIG_LEN, 'sig');
  const reqEpoch = Number(b.epoch);

  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    const rec = pending.get(enrollmentId);
    if (!rec || String(rec.userId) !== String(userId) || rec.resolved) {
      throw err('승인 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');
    }
    if (now >= rec.expiresAt) throw err('승인 요청이 만료되었습니다.', 410, 'EXPIRED');
    // ★ 봉인 대상 검증 — 클라가 에코한 ikX 가 신청서의 ikX 와 다르면 서버가 중간에서 바꿔치기한 것이다.
    if (rec.ikX !== b64u(ikXRaw)) throw err('기기 공개키가 일치하지 않습니다.', 409, 'KEY_MISMATCH');
    const approver = keyByIkX(k, b64u(approverIkXRaw));
    if (!approver || approver.state !== 'trusted') {
      throw err('승인은 이미 신뢰된 기기에서만 할 수 있습니다.', 403, 'NOT_TRUSTED');
    }
    if (!Number.isInteger(reqEpoch) || reqEpoch !== k.epoch) {
      throw err('열쇠 세대가 달라졌습니다. 다시 시도해 주세요.', 409, 'EPOCH_MISMATCH', { epoch: k.epoch });
    }
    if (VERIFY_SIG && !verifyGrantSig({ epoch: k.epoch, ikXRaw, sealedRaw, sigRaw, approverIkEdRaw: Buffer.from(approver.ikEd, 'base64url') })) {
      throw err('봉인문 서명 검증에 실패했습니다.', 400, 'SIG_INVALID');
    }
    if (k.keys.length >= KEY_MAX) throw err('계정에 등록된 기기 열쇠가 너무 많습니다.', 409, 'KEY_LIMIT');

    const keyId = k.nextKeyId++;
    k.keys.push({
      keyId, ikX: rec.ikX, ikEd: rec.ikEd, label: rec.label, platform: rec.platform, kind: rec.kind,
      deviceId: null, state: 'trusted', enrolledAt: new Date(now).toISOString(), revokedAt: null, lastGrantEpoch: k.epoch,
    });
    k.grants.push({
      epoch: k.epoch, recipientKeyId: keyId, sealed: b64u(sealedRaw),
      sealedByKeyId: approver.keyId, sig: b64u(sigRaw), createdAt: new Date(now).toISOString(),
    });
    pruneGrants(k);
    await saveKeyring(userId, k);
    resolvePending(rec, { approved: true, byKeyId: approver.keyId });
    console.log(`[e2ee] 승인 user=${userId} id=${rec.id} keyId=${keyId} by=#${approver.keyId} epoch=${k.epoch} waitedMs=${now - rec.requestedAt}`);
    return { ok: true, keyId, epoch: k.epoch };
  });
}

// ── E. 거절 / 취소 ────────────────────────────────────────────────────
async function deny(userId, body) {
  enabledGate();
  const now = Date.now();
  if (!allowRate(rateDecide, userId, now, DECIDE_MAX_PER_MIN)) throw err('요청이 너무 잦습니다.', 429, 'RATE_LIMITED');
  const enrollmentId = str((body || {}).enrollmentId, 64) || '';
  const rec = pending.get(enrollmentId);
  if (!rec || String(rec.userId) !== String(userId) || rec.resolved) throw err('승인 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');
  noteDeny(userId, rec.ikX, now);
  resolvePending(rec, { approved: false, reason: 'denied' });
  console.log(`[e2ee] 거절 user=${userId} id=${rec.id} label="${rec.label}"`);
  return { ok: true };
}

// 해소 공통 — 인덱스 제거 → resolved 팬아웃 → 알림 읽음(= 기존 크로스기기 dismiss 재사용).
function resolvePending(rec, { approved, reason, byKeyId }) {
  if (rec.resolved) return;
  rec.resolved = true;
  unregisterPending(rec);
  fanout(rec.userId, {
    kind: 'resolved', enrollmentId: rec.id, approved: !!approved,
    reason: reason || null, byKeyId: byKeyId ?? null, notifId: rec.notifId, at: Date.now(),
  });
  if (rec.notifId) {
    notificationService.markRead(Number(rec.userId), { ids: [rec.notifId] })
      .catch((e) => console.warn('[e2ee] markRead 실패:', e && e.message));
  }
}

// ── F. 키링(감사 UI + 봉인문 수령) ────────────────────────────────────
async function keyring(userId, { ikX } = {}) {
  enabledGate();
  const k = await loadKeyring(userId);
  let myGrant = null; let myKeyId = null; let myState = 'unknown';
  if (ikX) {
    const raw = decodeExact(ikX, PUB_LEN, 'ikX');
    const row = keyByIkX(k, b64u(raw));
    if (row) { myKeyId = row.keyId; myState = row.state; myGrant = publicGrant(grantFor(k, k.epoch, row.keyId)); }
    else myState = pendingByIkX(userId, b64u(raw)) ? 'pending' : 'unknown';
  }
  return {
    epoch: k.epoch, policy: k.policy, suite: SUITE, recoverySet: !!k.recovery,
    devices: k.keys.map((row) => publicKeyRow(userId, row)),
    // 현재 epoch 봉인문 전량 — 전부 암호문이고 계정 소유자만 받는다. 기기는 자기 recipientKeyId 것을 고른다.
    grants: k.grants.filter((g) => g.epoch === k.epoch).map((g) => ({ ...publicGrant(g), recipientKeyId: g.recipientKeyId })),
    myKeyId, myState, myGrant,
  };
}

// ── G. epoch 회전(기기 해제 후) ───────────────────────────────────────
// req { approverIkX, fromEpoch, toEpoch, grants:[{keyId, ikX, sealed, sig}], revokeKeyIds?, recovery? }
//  정책(불변식 8): 남아 있는 trusted 키는 **전부** 새 봉인문을 받아야 한다. 빠뜨린 키가 있으면 400 —
//   조용히 넘기면 그 기기가 다음 접속에서 영구 복호 불가(사용자에겐 "갑자기 안 됨")가 된다.
async function rotate(userId, body) {
  enabledGate();
  const now = Date.now();
  if (!allowRate(rateDecide, userId, now, DECIDE_MAX_PER_MIN)) throw err('요청이 너무 잦습니다.', 429, 'RATE_LIMITED');
  rejectPlaintextFields(body);
  const b = body || {};
  const approverIkX = b64u(decodeExact(b.approverIkX, PUB_LEN, 'approverIkX'));
  const fromEpoch = Number(b.fromEpoch);
  const toEpoch = Number(b.toEpoch);
  const revokeKeyIds = Array.isArray(b.revokeKeyIds) ? b.revokeKeyIds.filter(Number.isInteger).slice(0, KEY_MAX) : [];
  const grantsIn = Array.isArray(b.grants) ? b.grants.slice(0, KEY_MAX) : [];
  const recovery = normalizeRecovery(b.recovery);
  if (!grantsIn.length) throw err('grants 가 필요합니다.', 400, 'BAD_FIELD', { field: 'grants' });

  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    const approver = keyByIkX(k, approverIkX);
    if (!approver || approver.state !== 'trusted') throw err('회전은 신뢰된 기기에서만 할 수 있습니다.', 403, 'NOT_TRUSTED');
    if (fromEpoch !== k.epoch) throw err('열쇠 세대가 달라졌습니다.', 409, 'EPOCH_MISMATCH', { epoch: k.epoch });
    if (toEpoch !== k.epoch + 1) throw err('toEpoch 는 fromEpoch + 1 이어야 합니다.', 400, 'BAD_EPOCH');
    if (revokeKeyIds.includes(approver.keyId)) throw err('자기 자신을 해제하면서 회전할 수 없습니다.', 400, 'BAD_REVOKE');

    // 해제 대상 표시(먼저) → 남는 대상 산출
    const revokeSet = new Set(revokeKeyIds);
    const remaining = k.keys.filter((x) => x.state === 'trusted' && !revokeSet.has(x.keyId));
    const seen = new Map();
    for (const g of grantsIn) {
      const keyId = Number(g && g.keyId);
      const row = k.keys.find((x) => x.keyId === keyId && x.state === 'trusted');
      if (!row) throw err(`알 수 없는 keyId(${keyId}) 봉인문입니다.`, 400, 'UNKNOWN_KEY', { keyId });
      if (revokeSet.has(keyId)) throw err(`해제 대상(${keyId})에 새 봉인문을 줄 수 없습니다.`, 400, 'REVOKED_TARGET', { keyId });
      const ikXRaw = decodeExact(g.ikX, PUB_LEN, `grants[${keyId}].ikX`);
      if (row.ikX !== b64u(ikXRaw)) throw err(`keyId ${keyId} 의 공개키가 일치하지 않습니다.`, 409, 'KEY_MISMATCH', { keyId });
      const sealedRaw = decodeExact(g.sealed, SEALED_LEN, `grants[${keyId}].sealed`);
      const sigRaw = decodeExact(g.sig, SIG_LEN, `grants[${keyId}].sig`);
      if (VERIFY_SIG && !verifyGrantSig({ epoch: toEpoch, ikXRaw, sealedRaw, sigRaw, approverIkEdRaw: Buffer.from(approver.ikEd, 'base64url') })) {
        throw err(`keyId ${keyId} 봉인문 서명 검증 실패`, 400, 'SIG_INVALID', { keyId });
      }
      seen.set(keyId, { sealed: b64u(sealedRaw), sig: b64u(sigRaw) });
    }
    const missing = remaining.filter((x) => !seen.has(x.keyId)).map((x) => x.keyId);
    if (missing.length) {
      throw err('남아 있는 기기 전부에 새 봉인문이 필요합니다.', 400, 'INCOMPLETE_ROTATION', { missing });
    }

    for (const keyId of revokeSet) {
      const row = k.keys.find((x) => x.keyId === keyId);
      if (row && row.state === 'trusted') { row.state = 'revoked'; row.revokedAt = new Date(now).toISOString(); }
    }
    for (const [keyId, g] of seen) {
      k.grants.push({ epoch: toEpoch, recipientKeyId: keyId, sealed: g.sealed, sealedByKeyId: approver.keyId, sig: g.sig, createdAt: new Date(now).toISOString() });
      const row = k.keys.find((x) => x.keyId === keyId);
      if (row) row.lastGrantEpoch = toEpoch;
    }
    k.epoch = toEpoch;
    if (recovery) k.recovery = { ...recovery, epoch: toEpoch };
    pruneGrants(k);
    await saveKeyring(userId, k);
    console.log(`[e2ee] 회전 user=${userId} ${fromEpoch}→${toEpoch} 재봉인=${seen.size} 해제=${[...revokeSet].join(',') || '-'} by=#${approver.keyId}`);
    fanout(userId, { kind: 'rotated', epoch: toEpoch, revokedKeyIds: [...revokeSet], byKeyId: approver.keyId });
    return { epoch: toEpoch, resealed: seen.size, revoked: [...revokeSet] };
  });
}

// 오래된 epoch 의 봉인문 정리 — 옛 스냅샷 복호을 위해 최근 EPOCH_KEEP 세대는 남긴다(§6-19).
function pruneGrants(k) {
  const minEpoch = Math.max(1, k.epoch - EPOCH_KEEP + 1);
  k.grants = k.grants.filter((g) => g.epoch >= minEpoch).slice(-GRANT_MAX);
}

// ── H. 정책 토글 ──────────────────────────────────────────────────────
// user 테이블에 컬럼을 추가할 수 없으므로(마이그레이션 금지) 정책도 키링 blob 에 둔다.
//  전 기기 동기화가 필요한 값이라 팬아웃까지 함께.
async function setPolicy(userId, policy) {
  enabledGate();
  const p = String(policy || '').trim();
  if (!POLICIES.includes(p)) throw err("policy 는 'off'|'preferred'|'required' 여야 합니다.", 400, 'BAD_POLICY');
  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    if (p === 'required' && !k.recovery) {
      // 복구 코드 없이 required 를 켜면 기기 전량 소실 = 영구 손실이다(§7-5 사용자 결정).
      throw err('복구 코드를 먼저 만들어야 required 로 바꿀 수 있습니다.', 409, 'RECOVERY_REQUIRED');
    }
    k.policy = p;
    await saveKeyring(userId, k);
    fanout(userId, { kind: 'policy', policy: p, epoch: k.epoch });
    return { policy: p, epoch: k.epoch };
  });
}

// 복구 코드 봉인문 등록/교체(전 기기 소실 대비 — 불변식 8).
async function setRecovery(userId, body) {
  enabledGate();
  rejectPlaintextFields(body);
  const recovery = normalizeRecovery((body || {}).recovery);
  if (!recovery) throw err('recovery 가 필요합니다.', 400, 'BAD_FIELD', { field: 'recovery' });
  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    if (k.epoch === 0) throw err('먼저 열쇠를 만들어야 합니다.', 409, 'NOT_INITIALIZED');
    k.recovery = { ...recovery, epoch: k.epoch };
    await saveKeyring(userId, k);
    fanout(userId, { kind: 'recovery', epoch: k.epoch });
    return { recoverySet: true, epoch: k.epoch };
  });
}

// ── 페어링(새 PC) 경로 연동 — 추가 마찰 0 ─────────────────────────────
// QR 승인 시 앱이 세션의 ikX 로 MK 를 봉인해 올린다(daemonController.pairGrant).
//  · 여기서 키를 trusted 로 등록해 두면 PC 는 claim 응답 또는 enroll 멱등 호출로 봉인문을 받는다.
//  · 4자리 확인번호 대조 없이 신뢰하는 근거: QR(오프라인 채널)에 공개키 지문이 실려 앱이 자동 대조한다(§3.2).
async function grantForPairing(userId, { ikX, ikEd, label, platform, sealed, sig, epoch, approverIkX, deviceId }) {
  enabledGate();
  const id = normalizeIdentity({ ikX, ikEd, label, platform, kind: 'host' });
  const sealedRaw = decodeExact(sealed, SEALED_LEN, 'sealed');
  const sigRaw = decodeExact(sig, SIG_LEN, 'sig');
  const approver = b64u(decodeExact(approverIkX, PUB_LEN, 'approverIkX'));
  const reqEpoch = Number(epoch);
  return withKeyring(userId, async () => {
    const k = await loadKeyring(userId);
    const approverRow = keyByIkX(k, approver);
    if (!approverRow || approverRow.state !== 'trusted') throw err('승인은 신뢰된 기기에서만 할 수 있습니다.', 403, 'NOT_TRUSTED');
    if (!Number.isInteger(reqEpoch) || reqEpoch !== k.epoch) throw err('열쇠 세대가 달라졌습니다.', 409, 'EPOCH_MISMATCH', { epoch: k.epoch });
    if (VERIFY_SIG && !verifyGrantSig({ epoch: k.epoch, ikXRaw: id.ikXRaw, sealedRaw, sigRaw, approverIkEdRaw: Buffer.from(approverRow.ikEd, 'base64url') })) {
      throw err('봉인문 서명 검증에 실패했습니다.', 400, 'SIG_INVALID');
    }
    let row = keyByIkX(k, id.ikX);
    if (row && row.state === 'revoked') throw err('이 기기의 열쇠는 해제되었습니다.', 409, 'KEY_REVOKED');
    if (!row) {
      if (k.keys.length >= KEY_MAX) throw err('계정에 등록된 기기 열쇠가 너무 많습니다.', 409, 'KEY_LIMIT');
      row = {
        keyId: k.nextKeyId++, ikX: id.ikX, ikEd: id.ikEd, label: id.label, platform: id.platform,
        kind: 'host', deviceId: deviceId != null ? Number(deviceId) : null, state: 'trusted',
        enrolledAt: new Date().toISOString(), revokedAt: null, lastGrantEpoch: k.epoch,
      };
      k.keys.push(row);
    } else {
      row.state = 'trusted';
      row.lastGrantEpoch = k.epoch;
      if (deviceId != null) row.deviceId = Number(deviceId);
    }
    if (!grantFor(k, k.epoch, row.keyId)) {
      k.grants.push({ epoch: k.epoch, recipientKeyId: row.keyId, sealed: b64u(sealedRaw), sealedByKeyId: approverRow.keyId, sig: b64u(sigRaw), createdAt: new Date().toISOString() });
      pruneGrants(k);
    }
    await saveKeyring(userId, k);
    // 대기 중이던 같은 키의 enrollment 가 있으면 함께 해소(QR 과 4자리 경로가 경합한 경우).
    const p = pendingByIkX(userId, id.ikX);
    if (p) resolvePending(p, { approved: true, byKeyId: approverRow.keyId });
    console.log(`[e2ee] QR 페어링 열쇠 전달 user=${userId} keyId=${row.keyId} epoch=${k.epoch}`);
    return { keyId: row.keyId, epoch: k.epoch, grant: publicGrant(grantFor(k, k.epoch, row.keyId)) };
  });
}

// claim(무인증, sessionSecret 보유자)에 실어줄 봉인문 — 없으면 null(구 앱/미업로드 → 데몬이 enroll 로 폴백).
async function grantForDevice(userId, ikX) {
  if (!E2EE_ENABLED || !ikX) return null;
  try {
    const k = await loadKeyring(userId);
    const row = keyByIkX(k, ikX);
    if (!row || row.state !== 'trusted') return null;
    const g = grantFor(k, k.epoch, row.keyId);
    return g ? { epoch: k.epoch, keyId: row.keyId, ...publicGrant(g) } : null;
  } catch (_) { return null; }
}

// 기기 연결 해제(revokeDevice) 훅 — 그 기기의 열쇠를 즉시 무력화 표시하고 회전을 유도한다.
//  ★ 정책: 해제만으로는 이미 그 기기가 가진 MK_epoch 가 사라지지 않는다(오프라인 사본을 회수할 방법은 없다).
//   → 서버는 남은 신뢰 기기에 rotate_needed 를 팬아웃하고, 사용자가 승인하면 epoch+1 로 재봉인한다.
//   옛 objectstore 암호문은 재암호화하지 않는다(§7-6 사용자 결정 — "해제 전 받은 데이터는 회수 불가" 고지).
async function onDeviceRevoked(userId, deviceId) {
  if (!E2EE_ENABLED) return { changed: false };
  try {
    return await withKeyring(userId, async () => {
      const k = await loadKeyring(userId);
      const rows = k.keys.filter((x) => x.deviceId === Number(deviceId) && x.state === 'trusted');
      if (!rows.length) return { changed: false };
      for (const row of rows) { row.state = 'revoked'; row.revokedAt = new Date().toISOString(); }
      await saveKeyring(userId, k);
      console.log(`[e2ee] 기기 해제로 열쇠 무효화 user=${userId} device=#${deviceId} keys=${rows.map((r) => r.keyId).join(',')}`);
      fanout(userId, { kind: 'rotate_needed', epoch: k.epoch, revokedKeyIds: rows.map((r) => r.keyId), reason: 'device_revoked' });
      return { changed: true, revokedKeyIds: rows.map((r) => r.keyId), epoch: k.epoch };
    });
  } catch (e) {
    console.warn('[e2ee] 기기 해제 훅 실패:', e && e.message);
    return { changed: false };
  }
}

// ── 스위퍼(30s) — 만료 정리 ───────────────────────────────────────────
function sweep(now = Date.now()) {
  for (const rec of [...pending.values()]) {
    if (now >= rec.expiresAt) resolvePending(rec, { approved: false, reason: 'expired' });
  }
  for (const [key, r] of rateEnroll) if (now - r.windowStart >= 60000) rateEnroll.delete(key);
  for (const [key, r] of rateDecide) if (now - r.windowStart >= 60000) rateDecide.delete(key);
  for (const [key, d] of denyCount) if (now - d.at >= DENY_BLOCK_MS) denyCount.delete(key);
}
const _sweeper = setInterval(() => { try { sweep(); } catch (e) { console.warn('[e2ee] 스위퍼 오류:', e && e.message); } }, SWEEP_MS);
if (_sweeper.unref) _sweeper.unref();

module.exports = {
  enroll, bootstrap, listPending, approve, deny, keyring, rotate, setPolicy, setRecovery,
  grantForPairing, grantForDevice, onDeviceRevoked,
  ENABLED: E2EE_ENABLED,
  // 테스트 노출(순수 함수/인덱스) — approvalService `_` 컨벤션 미러.
  _fingerprintOf: fingerprintOf,
  _grantSigMessage: grantSigMessage,
  _verifyGrantSig: verifyGrantSig,
  _rejectPlaintextFields: rejectPlaintextFields,
  _decodeExact: decodeExact,
  _normalizeKeyring: normalizeKeyring,
  _allowRate: allowRate,
  _maskIp: maskIp,
  _publicPending: publicPending,
  _sweep: sweep,
  _pending: pending,
  _byUser: byUser,
  _denyCount: denyCount,
  _cache: cache,
  _setStore: (s) => { store = s; },
  _reset: () => { cache.clear(); chains.clear(); pending.clear(); byUser.clear(); denyCount.clear(); rateEnroll.clear(); rateDecide.clear(); },
  _config: {
    SUITE, SEALED_LEN, SIG_LEN, PUB_LEN, KEY_MAX, GRANT_MAX, EPOCH_KEEP, POLICIES,
    ENROLL_TTL_MS, MAX_PENDING_PER_USER, ENROLL_MAX_PER_MIN, DECIDE_MAX_PER_MIN,
    DENY_BLOCK_MAX, DENY_BLOCK_MS, ANDROID_CHANNEL, VERIFY_SIG, FORBIDDEN_FIELDS, RECOVERY_MAX,
  },
};
