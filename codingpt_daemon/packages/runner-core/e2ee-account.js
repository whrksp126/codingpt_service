/**
 * e2ee-account.js — 데몬의 **계정 열쇠 클라이언트**(기능2 2b · 계약 §2.6)
 *
 * ── 왜 이 파일인가 ────────────────────────────────────────────────────────────
 * 암호 코어(`./e2ee`)와 봉투 배관(`control.js`)은 이미 완비돼 있었지만 **열쇠를 얻는 코드가
 * 어디에도 없었다**(`packages/**` 에서 `api/daemon/e2ee` 0건, `acceptGrant` 호출자 0건).
 * 그래서 PC 데몬은 영구히 `e2ee.caps() === []` 였고 — 즉 앱이 봉인을 시도하면 데몬이 못 열고
 * 클라이언트가 "서버 미지원" 으로 캐시해 평문으로 내려가는 **"암호화된 척하는 평문"** 상태였다.
 * 이 파일이 그 한 조각(REST 왕복 + 봉인문 수령·보관·갱신)을 채운다.
 *
 * 규율(어기면 이 기능의 존재 의미가 사라진다)
 *  · 암호 원시연산은 **한 줄도 여기 쓰지 않는다** — 전부 `./e2ee`(3구현체 골든 벡터의 정본).
 *    이 파일은 REST 형태 + 순서 + 재시도 정책만 담당한다.
 *  · MK(마스터키)는 로그·에러 메세지·서버 요청 본문에 **절대** 실리지 않는다. 여기서 로그로 찍는
 *    것은 epoch / keyId / 상태 문자열뿐이다(회귀 테스트가 로그 문자열을 실제로 grep 한다).
 *  · 사용자의 AI 자격증명(Keychain·~/.claude·구독 토큰)은 읽지 않는다(ToS 경계 — daemon CLAUDE.md).
 *  · 상태 파일은 기존 `config.saveE2ee`(=`<stateDir>/e2ee.json`, 0600) 하나만 쓴다. 새 포맷 금지.
 *
 * ── 부트스트랩을 데몬이 하지 않는 이유(판단) ─────────────────────────────────
 * back `/e2ee/enroll` 은 계정에 열쇠가 하나도 없으면 `state:'bootstrap'` 을 돌려주고, 그때
 * `/e2ee/bootstrap` 으로 **MK_1 을 자가 생성**할 수 있다. 데몬은 그 경로를 **자동으로 타지 않는다**.
 *  ① 신뢰 사슬의 기점을 사람이 아무것도 보지 않은 상태에서 세우게 되고, 그러면 이후 모든 승인이
 *     "PC 화면을 볼 수 있는 사람" 만 할 수 있게 된다. 폰만 들고 외출한 사용자는 자기 폰을 승인할
 *     기기가 없어 **영구히 잠긴다**(집에 가야 풀린다) — 원격 제품에서 가장 나쁜 실패다.
 *  ② 앱(폰)은 사람이 로그인한 화면에서 부트스트랩한다(`codingpt_app/src/services/e2ee.ts:431`).
 *     둘이 동시에 시도하면 한쪽은 409 이고, 진 쪽은 이긴 쪽의 승인을 기다려야 한다.
 *     헤드리스 데몬이 이기면 ①의 상황이 된다.
 *  ③ 승인 UX(두 화면 대조)의 의미가 사라진다 — 사람 없이 세운 기점은 대조할 상대가 없다.
 * → 계정에 열쇠가 없으면 이 파일은 **기다린다**(`keyState:'none'`, phase `bootstrap`, 사유 문구).
 *   사람이 명시적으로 시작하고 싶을 때만 `bootstrap()`(cpt.sock `e2ee.bootstrap`)을 부른다.
 *
 * ── 폴링 정책(부팅 폭주 금지) ────────────────────────────────────────────────
 * pull 이 **정본**이고, "데몬 2초 재연결 폭주" 사고 이력이 있는 제품이므로 모든 대기는
 * **지수 백오프 + 상한 + 지터**다(값은 nextDelay 참조). 특히 승인이 거절/만료된 뒤의 재신청은
 * back 이 신뢰 기기에 **푸시 알림을 다시 쏘는** 경로라 상한을 6시간까지 늘린다(알림 폭탄 방지).
 *
 * ── 서버 힌트(가속기 — 정본이 아니다) ────────────────────────────────────────
 * 2026-07-27 부터 back 은 `fanoutDeviceApproval` 과 같은 사실을 연결된 데몬에게도
 * `{type:'e2ee_hint', kind}` 로 내려보낸다(caps `e2ee.hint.v1`). 이유: 다른 기기에서 회전하면
 * 이 데몬은 최대 `TRUSTED_MS`(15분)간 옛 세대로 남고 그 사이 봉투가 전부 `E2EE_EPOCH_MISMATCH` 로
 * 거절돼 화면이 '확인 중' 에 머문다. `hintResync` 가 그 프레임을 받아 즉시 화해를 예약한다.
 *  ★ 힌트는 **힌트일 뿐**이다(불변식): 프레임 내용으로 열쇠/세대/정책을 바꾸지 않고, 프레임으로
 *    루프를 **시작하지도** 않는다. 서버가 세대를 주장해 데몬을 옛/새 세대로 몰 수 있게 되면 그
 *    순간 서버가 신뢰 경계 안으로 들어온다 — 정본은 keyring 왕복 + 승인자 Ed25519 서명 검증.
 *  ★ 프레임이 없거나 구 back(선언 없음)이면 아무 일도 없다 = 15분 폴링이 그대로 유일 경로(폴백 유지).
 */
'use strict';

const os = require('os');
const gate = require('./e2ee-gate');
const configLib = require('./config');

// ── 백오프/주기(ms) ───────────────────────────────────────────────────────────
const BOOT_MIN_MS = 1500;          // hello_ack 직후 첫 시도 — 부팅 순간의 동시 요청과 겹치지 않게
const BOOT_JITTER_MS = 1500;       //  (여러 PC 가 같은 back 재배포로 동시에 재접속하는 상황 대비)
const ENROLL_BASE_MS = 5000;       // 일시 실패(네트워크·5xx·429) 재시도
const ENROLL_MAX_MS = 5 * 60 * 1000;
const PENDING_BASE_MS = 5000;      // 승인 대기 중 키링 폴링(사람이 폰을 켜는 시간 규모)
const PENDING_MAX_MS = 60 * 1000;
const TRUSTED_MS = 15 * 60 * 1000; // 열쇠 보유 중 정기 확인(rotate/revoke 감지) — 힌트가 없을 때의 유일한 경로
const RESOLVED_BASE_MS = 10 * 60 * 1000;  // 거절/만료 후 재신청 — 알림이 다시 발사되는 경로라 느리게
const RESOLVED_MAX_MS = 6 * 60 * 60 * 1000;
const BOOTSTRAP_BASE_MS = 5 * 60 * 1000;  // 계정에 열쇠 없음(사람이 앱에서 켤 때까지 대기)
const BOOTSTRAP_MAX_MS = 60 * 60 * 1000;
const OFF_MS = 60 * 60 * 1000;     // policy='off' — 승인 알림을 만들지 않기 위해 신청 자체를 멈춘다
const KICK_MIN_GAP_MS = 30 * 1000; // 재접속 폭주가 폴링 폭주로 증폭되지 않게(kick 최소 간격)
// ── 서버 힌트(e2ee_hint) 수용 간격 ───────────────────────────────────────────
//  HINT_COALESCE_MS: 힌트 수신 → 실제 왕복까지의 지연. ① 한 사용자 조작이 프레임 두 장을 낼 수 있어
//   (revoke = rotated + rotate_needed) 합쳐야 하고, ② back 은 keyring 저장 **직후** 팬아웃하지만
//   그 저장은 아직 withKeyring 락 안이라(deviceTrustService) 곧바로 읽으면 락을 기다린다 —
//   조금 미루면 왕복 1회로 최신 세대를 읽는다. 사람이 체감하는 값(0.4초)이라 UX 손실은 없다.
//  HINT_MIN_GAP_MS: 힌트를 **수용**하는 최소 간격. 재접속 kick(30s)보다 짧게 잡는 근거 — 힌트는
//   계정당 드문 사건(회전/정책 변경)이고 회전 직후 15분 평문이 이 라운드가 닫는 결함 자체라
//   반응성이 목적이다. 대신 상한은 반드시 있어야 한다: 프레임이 폭주하면(서버 버그·악의) 왕복이
//   초당으로 늘어 back 레이트리밋(E2EE_*_MAX_PER_MIN)에 부딪히고 로그가 오염된다.
//   5초 = 최악의 경우 데몬 1대당 분당 12회(15분 폴링 기준선의 3배 미만) — 감쇠 없이도 안전한 상한.
//   ★ 이 상한은 프레임을 **미루는** 장치이고 버리는 장치가 아니다(hintResync 불변식 ⑤): 창 안에 온
//    힌트는 `lastHintAt + HINT_MIN_GAP_MS` 시점에 1회 예약된다. 버렸을 때의 대가가 '회전 직후 최대
//    15분 평문/EPOCH_MISMATCH' 라서 상한을 지키는 것보다 사실을 잃지 않는 것이 항상 더 중요하다.
const HINT_COALESCE_MS = 400;
const HINT_MIN_GAP_MS = 5 * 1000;
const JITTER = 0.2;                // ±20%
const FETCH_CACHE_MS = 2000;       // PC 설정 화면이 state/pending/keyring 을 연달아 부를 때 왕복 축소

// 보관할 과거 epoch 수. back `deviceTrustService.EPOCH_KEEP` 와 같은 값이다(계정 전역의 진실).
//  ★ 여기서 "옛 MK 를 전부 지우기" 를 하지 않는 이유: 지난 알림 body(`cptenc:1:`)와 구 스냅샷은
//   옛 세대 키로만 열린다 — 지우면 회전 즉시 그 PC 의 과거 알림·복원이 영구히 🔒 가 된다(계약 §2.3
//   "삭제 금지"). 반대로 무한 보관도 하지 않는다: **실행을 유발하는 봉투/스트림은 현재 세대만**
//   받도록 control.js/beginHost 가 이미 강제하므로(§2.3 epoch 규칙), 오래된 키는 읽기 전용으로만
//   남고 창(8세대)을 넘기면 정리된다. 정책을 더 좁히려면 CPT_E2EE_KEEP_EPOCHS=1 로 운영할 수 있다.
const KEEP_EPOCHS = Math.max(1, Number(process.env.CPT_E2EE_KEEP_EPOCHS) || 8);

const LABEL_MAX = 64;

// ── 모듈 상태 ─────────────────────────────────────────────────────────────────
const st = {
  started: false,
  timer: null,
  running: false,
  lastRunAt: 0,
  lastKickAt: 0,
  nextAt: 0,
  phase: 'boot',          // boot | bootstrap | pending | trusted | resolved | revoked | error | off
  keyState: 'none',       // none | enrolled | pending | trusted  ← 사람이 "확인 중/평문" 을 구분하는 값
  delay: 0,               // 현재 백오프(지터 적용 전)
  enrollmentId: null,
  pendingSince: null,
  accountEpoch: null,     // 서버가 말하는 계정 epoch(null = 아직 모른다)
  recoverySet: false,
  userRef: '',            // 확인 숫자/지문 파생 기준(= userId 문자열). 폰과 같은 값이어야 한다.
  reason: null,
  lastError: null,
  devices: [],            // 최근 키링 스냅샷(공개 정보만)
  onKeyChange: null,      // 열쇠/세대 변화 직후 콜백(control.announceHello — hello 재신고)
  cache: { pending: null, pendingAt: 0, keyring: null, keyringAt: 0 },
  // ★ 백오프는 **kind 별로** 보관한다. 하나만 두면 phaseKind 가 교대하는 순간(resolved↔pending)
  //  prev 가 매번 0 으로 리셋돼 상한까지 자라지 못한다 — 실측 결함: 거절/만료 재신청이 10분 고정으로
  //  굳어 back 이 승인 요청 푸시를 10분마다 영구히 다시 쏜다(저자가 막으려던 알림 폭탄 그 자체).
  delays: {},             // kind → 직전 대기(지터 적용 전)
  queryOffUntil: 0,       // PC 조회(pending/keyring)의 네거티브 캐시 만료 시각
  policySync: null,       // {policy, code, message} — 정책 서버 동기화 실패(조용한 실패 금지)
  // 서버 힌트(e2ee_hint) — 전부 **진단용 카운터**다. 열쇠 판정에 쓰이는 값은 하나도 없다.
  lastHintAt: 0,          // 마지막으로 **수용한** 힌트 시각(throttle 기준)
  hintSeen: 0,            // 받은 프레임 수
  hintRuns: 0,            // 힌트가 실제로 유발한 화해 예약 수(= 추가 왕복 상한 관측치)
  hintPending: false,     // 화해 중 도착 → 끝난 직후 한 번 재확인
};

function log(msg) { console.log(`[e2ee] ${msg}`); }
function warn(msg) { console.warn(`[e2ee] ${msg}`); }

// 코어 모듈 — 킬스위치/스코프/테스트 override 는 게이트가 판정한다(암호 코드 0줄 규율).
function core() {
  const e = gate.load();
  return e && typeof e.ensureIdentity === 'function' ? e : null;
}

function coded(code, message) { return Object.assign(new Error(message), { code }); }

// back 은 successResponse(=data 를 최상위) 규약이다. 구/신 형태를 모두 받는다(`.data` 함정 방지).
function unwrap(res) {
  if (res && typeof res === 'object' && res.data && typeof res.data === 'object') return res.data;
  return res && typeof res === 'object' ? res : {};
}

// 지연 require — cpt-server 가 e2ee-local 을 lazy 로 물고 e2ee-local 이 이 파일을 물기 때문에
//  top-level require 는 "부분 초기화된 exports" 함정이 된다(e2ee-gate 헤더의 같은 이유).
function backFetch(method, apiPath, body) {
  return require('./cpt-server').backFetch(method, apiPath, body);
}

function jitter(ms) {
  const d = ms * JITTER;
  return Math.max(500, Math.round(ms - d + Math.random() * 2 * d));
}

/**
 * 다음 대기 시간(순수 함수 — 테스트가 상한/증가율을 고정한다).
 * @param {string} kind boot|enroll|pending|trusted|resolved|bootstrap|off
 * @param {number} prev 직전 대기(지터 적용 전). 0 = 첫 진입
 */
function nextDelay(kind, prev) {
  const p = Number(prev) || 0;
  switch (kind) {
    case 'boot': return BOOT_MIN_MS;
    case 'enroll': return Math.min(p ? p * 2 : ENROLL_BASE_MS, ENROLL_MAX_MS);
    case 'pending': return Math.min(p ? Math.round(p * 1.7) : PENDING_BASE_MS, PENDING_MAX_MS);
    case 'resolved': return Math.min(p ? p * 2 : RESOLVED_BASE_MS, RESOLVED_MAX_MS);
    case 'bootstrap': return Math.min(p ? p * 2 : BOOTSTRAP_BASE_MS, BOOTSTRAP_MAX_MS);
    case 'off': return OFF_MS;
    case 'trusted': default: return TRUSTED_MS;
  }
}

function schedule(kind, { reset } = {}) {
  // prev 는 **그 kind 의 직전 값**이다(st.delay 는 마지막 스케줄의 값이라 kind 가 바뀌면 0 이 된다).
  //  이 한 줄이 없으면 resolved 가 pending 과 교대할 때마다 10분으로 리셋돼 상한(6시간)에 도달하지 못한다.
  if (!st.delays) st.delays = {};
  const base = nextDelay(kind, reset ? 0 : (Number(st.delays[kind]) || 0));
  st.delays[kind] = base;
  st.phaseKind = kind;
  st.delay = base;
  const wait = kind === 'boot' ? BOOT_MIN_MS + Math.floor(Math.random() * BOOT_JITTER_MS) : jitter(base);
  st.nextAt = Date.now() + wait;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.timer = null; void runOnce(); }, wait);
  if (st.timer.unref) st.timer.unref();
  return wait;
}

// ── 신원/라벨 ─────────────────────────────────────────────────────────────────
function identityOf(e) {
  const cfg = configLib.load() || {};
  // deviceId 를 상태 파일에 심어 둔다 — 봉투 AAD 의 host 대조(e2ee-gate.selfDeviceId)가 이 값을 쓴다.
  e.ensureIdentity({ deviceId: cfg.deviceId != null ? Number(cfg.deviceId) : undefined });
  const id = e.identity();
  const cfgName = cfg.deviceName || os.hostname().replace(/\.local$/, '');
  return { ikX: id.ikX, ikEd: id.ikEd, label: String(cfgName || 'PC').slice(0, LABEL_MAX) };
}

// userRef = 확인 숫자/지문 파생 기준. back 이 응답에 실어 주면 그 값이 정본이고(앱과 동일 규칙:
//  e2ee.ts fpRef), 아직 안 싣는 배포에서는 `GET /api/daemon/me` 의 id 로 대체한다.
function takeUserRef(body) {
  const v = body && (body.userRef != null ? body.userRef : body.user_ref);
  if (typeof v === 'string' && v && v !== st.userRef) { st.userRef = v; persistUserRef(); }
}
// ★ `loadState()` 가 아니라 `ensureIdentity()` 를 쓴다: 신규 설치 1회차에는 runOnce 가 ensureUserRef 를
//  identityOf 보다 먼저 부르므로 그 시점엔 파일이 없고, loadState()==null 이면 **아무것도 쓰지 않은 채**
//  st.userRef 만 채워져 다시 시도하지 않는다 → 파일에 userRef 가 영구히 없다. 그러면 데몬 재기동(PC 앱
//  업데이트마다 발생) 직후 PC 가 userRef='' 로 파생한 **틀린 안전코드**를 아무 경고 없이 표시하고,
//  사람이 두 화면을 대조하는 유일한 MITM 방어가 무력화된다(실측 결함).
function persistUserRef() {
  const e = core();
  if (!e || !st.userRef) return;
  try {
    const s = e.ensureIdentity();
    if (s && s.userRef !== st.userRef) { s.userRef = st.userRef; e.saveState(s); }
  } catch (_) { /* 표시용 값이라 저장 실패는 무해(손상 상태에서는 덮어쓰지 않는다) */ }
}
// 상태 파일에서 동기 복원 — state()/pending()/keyring() 은 네트워크를 기다리지 않으므로(계약 §2.4)
//  파일에 있는 사실은 **그 자리에서** 읽어야 한다. 없으면 빈 문자열을 유지하고, 그때는 파생값을
//  내보내지 않는다(decorate) — 틀린 값을 그리는 것보다 '—' 가 낫다.
function loadUserRef(e) {
  if (st.userRef || !e) return st.userRef;
  try {
    const s = e.loadState();
    if (s && typeof s.userRef === 'string' && s.userRef) st.userRef = s.userRef;
  } catch (_) { /* noop */ }
  return st.userRef;
}
async function ensureUserRef(e) {
  if (loadUserRef(e)) return st.userRef;
  try {
    const me = unwrap(await backFetch('GET', '/api/daemon/me'));
    if (me && me.id != null) { st.userRef = String(me.id); persistUserRef(); }
  } catch (e2) {
    // 실패는 무해 — 확인 숫자 대조 UI 만 나중에 등장한다(열쇠 취득 자체는 진행된다).
    st.lastError = (e2 && e2.message) || String(e2);
  }
  return st.userRef;
}

// ── 열쇠 보관(기존 e2ee.js 저장 경로만 사용) ─────────────────────────────────
function pruneEpochs(e) {
  try {
    const s = e.loadState();
    if (!s || !s.keys) return 0;
    const cur = Number(s.epoch) || 0;
    const min = Math.max(1, cur - KEEP_EPOCHS + 1);
    let n = 0;
    for (const k of Object.keys(s.keys)) if (Number(k) < min) { delete s.keys[k]; n += 1; }
    if (n) { e.saveState(s); e.clearCache(); log(`옛 세대 열쇠 ${n}개 정리(보관 ${KEEP_EPOCHS}세대)`); }
    return n;
  } catch (_) { return 0; }
}

/** 봉인문 수령 — 승인자 서명을 **반드시** 검증한다(서버가 만든 위조 봉인문 주입 차단). */
function acceptGrant(e, grant, devices) {
  const g = grant || {};
  const ep = Number(g.epoch);
  if (!Number.isInteger(ep) || ep < 1 || !g.sealed) throw coded('E2EE_GRANT', '봉인문 형식이 올바르지 않습니다');
  const by = g.sealedByKeyId != null ? Number(g.sealedByKeyId) : null;
  const rows = Array.isArray(devices) ? devices : st.devices;
  const approver = rows.find((d) => Number(d.keyId) === by) || null;
  if (!approver || !approver.ikEd || !g.sig) {
    // 승인자 공개키를 모르면 검증이 불가능하다 → 받지 않는다. 검증 없이 받으면 서버가 자기 키로
    //  봉인한 MK 를 주입해 계정 전체를 대신 열 수 있다(그게 이 설계의 유일한 위협모델이다).
    throw coded('E2EE_GRANT_UNVERIFIABLE', '봉인문 승인자를 확인할 수 없습니다');
  }
  const r = e.acceptGrant({ epoch: ep, sealed: g.sealed, sig: g.sig }, { approverIkEd: approver.ikEd });
  pruneEpochs(e);
  st.keyState = 'trusted';
  st.phase = 'trusted';
  st.enrollmentId = null;
  st.pendingSince = null;
  st.reason = null;
  st.lastError = null;
  st.delays = {};        // 열쇠 취득 성공 = 모든 백오프 리셋(재신청 상한이 여기서만 0 으로 돌아간다)
  // ★ 로그에 sealed/MK 를 남기지 않는다(암호문도 남기지 않는다 — 진단에 필요한 것은 세대와 승인자다).
  log(`계정 열쇠 수령 epoch=${r.epoch} 승인자=#${by} (기기 ${rows.length}대)`);
  notifyKeyChange();
  return r;
}

// 열쇠/세대가 바뀌었다 → control 이 같은 소켓으로 hello 를 다시 신고해 caps·e2eeEpoch 를 갱신한다.
//  이게 없으면 승인 직후에도 back 의 conn.caps 에 e2ee.* 가 없어(연결 시점의 사실) 다음 재접속까지
//  앱/PC 는 이 PC 를 "열쇠 없음"으로 보고 평문으로 돈다 = 방금 승인이 아무 효과가 없는 것처럼 보인다.
function notifyKeyChange() {
  if (typeof st.onKeyChange !== 'function') return false;
  try { return !!st.onKeyChange(); } catch (_) { return false; }
}

// ── REST 왕복 ─────────────────────────────────────────────────────────────────
async function callEnroll(e) {
  const id = identityOf(e);
  const body = { ikX: id.ikX, ikEd: id.ikEd, label: id.label, platform: process.platform, kind: 'host' };
  const r = unwrap(await backFetch('POST', '/api/daemon/e2ee/enroll', body));
  takeUserRef(r);
  adoptPolicy(e, r.policy);
  return r;
}

async function callKeyring(e, { force } = {}) {
  const now = Date.now();
  if (!force && st.cache.keyring && now - st.cache.keyringAt < FETCH_CACHE_MS) return st.cache.keyring;
  const id = identityOf(e);
  const r = unwrap(await backFetch('GET', `/api/daemon/e2ee/keyring?ikX=${encodeURIComponent(id.ikX)}`));
  takeUserRef(r);
  adoptPolicy(e, r.policy);
  st.accountEpoch = Number.isFinite(Number(r.epoch)) ? Number(r.epoch) : st.accountEpoch;
  st.recoverySet = !!r.recoverySet;
  st.devices = Array.isArray(r.devices) ? r.devices : [];
  st.cache.keyring = r;
  st.cache.keyringAt = now;
  return r;
}

// 정책은 계정 전역 값이라 서버를 따라가지만 **단조 강화(monotonic hardening)** 로만 따라간다 —
//  서버가 더 약한 정책을 말할 때 로컬을 내리지 않는다. 두 방향 모두 사용자가 기기에서 직접 켠 값이고,
//  서버 값이 사용자 의사보다 최신인 경우는 없다(로컬 → 서버가 항상 선행한다).
//   · 'off'    = 킬스위치. 연결 없이도 즉시 원복돼야 하므로 서버 값으로 되살리지 않는다.
//   · 'required' = 다운그레이드 금지 스위치. 이쪽은 **강등을 막는 것 자체가 기능**이다. 그런데 서버
//     동기화는 구조적으로 항상 409 RECOVERY_REQUIRED 다(back deviceTrustService 는 recovery blob 을
//     요구하고, 그 blob 을 올리는 구현체가 데몬·앱 어디에도 없다 — 복구 코드는 자기완결 형식이라
//     의도적으로 서버에 올리지 않는다). 그래서 계정 policy 는 영구히 'preferred' 이고, 서버를 무조건
//     따라가면 사용자가 켠 '항상' 이 15분 뒤 조용히 '자동' 으로 되돌아가 모든 봉투 실패가 다시
//     평문으로 폴백한다(실측 결함 — 되돌림을 알리는 UI 신호가 0 이었다).
//  ⚠ 그래서 동기화 실패는 무음으로 두지 않고 st.policySync 로 화면에 노출한다(setPolicy 참조).
const POLICY_RANK = { preferred: 0, required: 1, off: 2 };
function adoptPolicy(e, p) {
  try {
    const cur = e.policy();
    if (!(typeof p === 'string' && ['off', 'preferred', 'required'].includes(p)) || p === cur) return cur;
    if ((POLICY_RANK[p] | 0) < (POLICY_RANK[cur] | 0)) {
      // 서버가 더 약하다 = 우리가 올린 값이 아직 계정에 반영되지 않았다. 로컬을 지킨다.
      return cur;
    }
    e.setPolicy(p);
    log(`계정 정책 동기화: ${cur} → ${p}`);
    return p;
  } catch (_) { return null; }
}

// 이 기기 열쇠가 해제된 경우 — 신원키를 새로 만들고 처음부터 다시 신청한다.
//  ★ 상태 파일을 통째로 버린다(계정이 우리를 해제했다 = 우리가 들고 있던 MK 는 회수 대상이다).
//   남겨 두면 "해제된 기기가 옛 세대 데이터를 계속 읽는" 상태가 된다.
function handleRevoked(e) {
  try { e.removeState(); } catch (_) { /* noop */ }
  try { e.clearCache(); } catch (_) { /* noop */ }
  st.keyState = 'none';
  st.phase = 'revoked';
  st.enrollmentId = null;
  st.pendingSince = null;
  st.devices = [];
  st.cache = { pending: null, pendingAt: 0, keyring: null, keyringAt: 0 };
  st.reason = '이 PC 의 열쇠가 계정에서 해제됐어요. 새 신원키로 다시 승인을 요청합니다.';
  warn('이 기기의 열쇠가 해제됨 — 신원키 재생성 후 재신청');
  try { identityOf(e); } catch (_) { /* 다음 주기에 재시도 */ }
  // ★ 해제도 '열쇠 사실 변화' 다 — 나머지 세 전이(acceptGrant/revoke/rollbackEpoch)와 같은 규율.
  //  이게 없으면 열쇠가 0개가 된 순간에도 back 의 conn.e2eeEpoch 는 옛 세대로 고착하고(재팬아웃
  //  지점은 러너 연결과 hello 수신 둘뿐이라 다음 재접속까지 수 시간), runner_status.e2eeEpoch>0 을
  //  본 앱/PC 배지는 계속 '암호화됨' 을 그린다 — 실제 트래픽은 100% 평문 릴레이다. 사용자가 방금
  //  '이 PC 신뢰 해제' 라는 보안 조작을 한 직후에 가장 나쁜 방향의 거짓 자물쇠가 만들어진다.
  notifyKeyChange();
}

// ── 한 번의 화해(reconcile) ───────────────────────────────────────────────────
// 이 함수만이 상태를 바꾼다. 타이머·kick·PC 조회가 전부 여기로 모인다(재진입 금지).
async function runOnce() {
  if (st.running) return { skipped: 'busy' };
  const e = core();
  if (!e) {
    st.phase = 'off';
    st.keyState = 'none';
    st.reason = `E2EE 가 꺼져 있습니다(scope=${gate.scope()})`;
    schedule('off', { reset: true });
    return { skipped: 'disabled' };
  }
  const cfg = configLib.load();
  if (!cfg || !cfg.serverUrl || !cfg.deviceToken) {
    st.reason = '아직 페어링되지 않았습니다.';
    schedule('enroll');
    return { skipped: 'unpaired' };
  }
  // policy='off' = 사용자가 껐다. 승인 요청은 **다른 기기에 알림을 쏘는 행위**라 이때는 신청조차
  //  하지 않는다(끈 사람에게 알림이 가는 것이 가장 나쁜 배신이다). 이미 열쇠가 있으면 그대로 둔다.
  if (e.policy() === 'off' && !e.hasKey()) {
    st.phase = 'off';
    st.keyState = 'none';
    st.reason = '종단간 암호화가 꺼져 있어 열쇠를 요청하지 않습니다.';
    schedule('off', { reset: true });
    return { skipped: 'policy_off' };
  }

  st.running = true;
  st.lastRunAt = Date.now();
  try {
    await ensureUserRef(e);
    if (e.hasKey()) return await stepTrusted(e);
    return await stepAcquire(e);
  } catch (err) {
    st.lastError = (err && err.message) || String(err);
    const code = err && err.code;
    if (code === 'KEY_REVOKED') { handleRevoked(e); schedule('resolved', { reset: true }); return { phase: st.phase }; }
    // 열쇠 파일이 손상됐다 = 우리가 고칠 수 없다(덮어쓰면 계정 열쇠가 영구 소실된다 — e2ee.js
    //  ensureIdentity). 조르지 않고 사유만 정직하게 남긴다.
    if (code === 'E2EE_STATE_CORRUPT') {
      st.phase = 'error';
      st.keyState = 'none';
      st.reason = '열쇠 파일이 손상됐어요 — 덮어쓰지 않았습니다. 복구 코드로 복원하거나 지원에 문의해 주세요.';
      schedule('off', { reset: true });
      return { skipped: 'state_corrupt' };
    }
    // 서버가 이 기능을 끈 상태(E2EE_ENABLED=0 → 503 E2EE_DISABLED) 또는 라우트가 없는 구 back(404)이면
    //  조를 이유가 없다 — 1시간 간격으로 내려놓는다(5분마다 503 을 받아 로그를 채우는 것이 진짜 사고였다).
    //  ★ 판정은 **status 가 아니라 detail.code** 로 한다. back 은 objectstore 접근/쓰기 실패도 503 으로
    //   던지고(KEYRING_UNAVAILABLE·KEYRING_WRITE_FAILED) 배포 중 nginx/CF 503 도 같은 상태다. 그것을
    //   킬스위치로 오진하면 그 사이 사용자가 폰에서 승인해도 **최대 1시간 평문으로 남고**(승인 결과는
    //   pull 이 유일 경로다) 화면에는 '서버에서 꺼져 있어요' 라는 거짓 진단이 뜬다(실측 결함).
    if (code === 'E2EE_DISABLED' || err.status === 404) {
      st.phase = st.keyState === 'trusted' ? 'trusted' : 'off';
      st.reason = '서버에서 종단간 암호화가 꺼져 있어요(기존 방식으로 그대로 동작합니다).';
      schedule('off', { reset: true });
      return { skipped: 'server_off' };
    }
    if (st.keyState !== 'trusted') st.phase = 'error';
    // 그 밖(429 레이트리밋·5xx·네트워크 단절·응답 형식 이상)은 전부 같은 취급 = 물러났다가 재시도.
    //  어떤 실패도 위로 던지지 않는다 — 터미널·IDE·프리뷰는 평문 경로로 그대로 돌아야 한다(불변식 1).
    st.reason = st.keyState === 'trusted' ? null : '열쇠 확인에 실패했어요(잠시 후 다시 시도합니다).';
    warn(`열쇠 동기화 실패(${code || 'ERR'}): ${st.lastError}`);
    schedule(st.keyState === 'trusted' ? 'trusted' : 'enroll');
    return { error: st.lastError };
  } finally {
    st.running = false;
    // 화해 **중**에 도착한 서버 힌트 — 이 왕복이 사실을 지나쳤을 수 있다(back 은 keyring 을 저장한
    //  뒤 팬아웃하는데, 그 두 시점 사이에 우리 GET 이 끼면 옛 세대를 읽는다). 딱 한 번 재확인한다.
    //  여기서 처리하는 이유: 진행 중 runOnce 의 schedule() 이 `st.timer` 를 무조건 덮으므로
    //  hintResync 가 그때 타이머를 세워도 조용히 지워진다(= 회전 직후 15분 고착 그대로).
    if (st.hintPending) { st.hintPending = false; if (st.phase !== 'resolved') armHint(); }
  }
}

// 열쇠 보유 중 — rotate/revoke 감지(둘 다 데몬에 push 가 없다)
async function stepTrusted(e) {
  const kr = await callKeyring(e, { force: true });
  if (kr.myState === 'revoked') { handleRevoked(e); schedule('resolved', { reset: true }); return { phase: st.phase }; }
  const mine = Number(kr.epoch) || 0;
  if (mine > (e.epoch() | 0) && kr.myGrant) {
    acceptGrant(e, kr.myGrant, kr.devices);       // 회전 후 새 봉인문 수령
  } else if (mine > (e.epoch() | 0)) {
    // 회전은 됐는데 우리 봉인문이 아직 없다(back INCOMPLETE_ROTATION 은 막지만 배포 중간 상태 가능).
    st.reason = '열쇠 세대가 갱신되는 중이에요.';
    st.keyState = 'enrolled';
    schedule('pending');
    return { phase: 'rotating' };
  } else {
    st.keyState = 'trusted';
    st.phase = 'trusted';
    st.reason = null;
  }
  schedule('trusted', { reset: true });
  return { phase: st.phase, epoch: e.epoch() };
}

// 열쇠 없음 — enroll(멱등) → 상태별 분기
async function stepAcquire(e) {
  // 이미 대기 중이면 enroll 을 다시 부르지 않는다: back 의 enroll 은 대기 중 같은 키에 대해 **팬아웃을
  //  다시 쏘므로**(deviceTrustService.js:377-381) 폴링마다 부르면 승인 시트가 계속 튀어오른다.
  //  대기 중 확인은 키링 폴링으로 한다(내 봉인문이 올라왔는지만 보면 된다).
  if (st.keyState === 'pending' && st.enrollmentId) {
    const kr = await callKeyring(e, { force: true });
    if (kr.myGrant) { acceptGrant(e, kr.myGrant, kr.devices); schedule('trusted', { reset: true }); return { phase: 'trusted' }; }
    if (kr.myState === 'revoked') { handleRevoked(e); schedule('resolved', { reset: true }); return { phase: st.phase }; }
    // 서버가 "아직 대기 중" 이라고 말하면 그것으로 끝 — /pending 을 또 부르지 않는다(폴링 왕복 절반).
    if (kr.myState === 'pending') { schedule('pending'); return { phase: 'pending' }; }
    // 승인 요청이 사라졌다(거절/만료) → 재신청은 느리게(알림 재발사 경로).
    const stillPending = await isStillPending(e);
    if (!stillPending) {
      st.keyState = 'none';
      st.phase = 'resolved';
      st.enrollmentId = null;
      st.reason = '승인 요청이 만료되거나 거절됐어요. 잠시 후 다시 요청합니다.';
      schedule('resolved');
      return { phase: 'resolved' };
    }
    schedule('pending');
    return { phase: 'pending' };
  }

  const r = await callEnroll(e);
  const state = String(r.state || '');
  if (state === 'trusted') {
    if (r.grant) {
      // 승인자 ikEd 를 알아야 서명 검증이 된다 → 키링을 함께 읽는다(enroll 응답에는 없다).
      const kr = await callKeyring(e, { force: true });
      acceptGrant(e, r.grant.sealed ? r.grant : kr.myGrant, kr.devices);
      schedule('trusted', { reset: true });
      return { phase: 'trusted' };
    }
    // 승인은 됐는데 현재 세대 봉인문이 없다 → 회전 대기(다음 폴링에서 수령).
    st.keyState = 'enrolled';
    st.phase = 'pending';
    st.reason = '승인은 끝났고 열쇠 전달을 기다리는 중이에요.';
    schedule('pending');
    return { phase: 'awaiting_grant' };
  }
  if (state === 'pending') {
    st.keyState = 'pending';
    st.phase = 'pending';
    st.enrollmentId = r.enrollmentId || null;
    st.pendingSince = r.requestedAt || new Date().toISOString();
    st.reason = '다른 기기(폰/태블릿)에서 이 PC 를 승인해 주세요.';
    log(`승인 대기 등록 id=${st.enrollmentId} (확인번호는 승인 화면에서 대조)`);
    schedule('pending', { reset: true });
    return { phase: 'pending', enrollmentId: st.enrollmentId };
  }
  if (state === 'bootstrap') {
    // ★ 자동 부트스트랩 금지는 **데몬(헤드리스)에만** 해당한다(파일 헤더 판단). 개정 4(2026-07-27)
    //  이후 사람이 보고 있는 앱 표면(PC 렌더러 maybeAutoBootstrap / 모바일 services/e2ee.ts ③)이
    //  자동으로 켜므로, 수동 지시("폰에서 켜 주세요")는 이제 거짓 안내다 — 진행형으로 바꾼다.
    st.keyState = 'none';
    st.phase = 'bootstrap';
    st.reason = '계정 암호화 열쇠를 준비하는 중이에요. 그때까지는 기존 방식(평문)으로 그대로 동작합니다.';
    schedule('bootstrap');
    return { phase: 'bootstrap' };
  }
  st.keyState = 'none';
  st.phase = 'error';
  st.reason = '알 수 없는 등록 상태입니다.';
  warn(`알 수 없는 enroll 상태: ${state || '(없음)'}`);
  schedule('enroll');
  return { phase: 'error' };
}

async function isStillPending(e) {
  try {
    const p = unwrap(await backFetch('GET', '/api/daemon/e2ee/pending'));
    takeUserRef(p);
    const id = identityOf(e);
    return (Array.isArray(p.pending) ? p.pending : []).some((x) => x && x.ikX === id.ikX);
  } catch (_) { return true; }   // 판단 불가 = 기존 대기 유지(재신청으로 알림을 또 쏘지 않는다)
}

// ── 생명주기 ──────────────────────────────────────────────────────────────────
/** 멱등 기동. control.js 가 hello_ack(서버 e2ee.keys.v1 선언)에서 부른다. */
function start(opts) {
  // 콜백은 준 쪽(control)만 설정한다 — resync 가 먼저 ensureStarted 를 타도 지워지지 않게.
  if (opts && typeof opts.onKeyChange === 'function') st.onKeyChange = opts.onKeyChange;
  if (st.started) return { ok: true, already: true };
  st.started = true;
  st.lastKickAt = Date.now();
  schedule('boot', { reset: true });
  return { ok: true, firstRunInMs: Math.max(0, st.nextAt - Date.now()) };
}
function ensureStarted() { if (!st.started) start(); }

/**
 * 재접속/사용자 조작으로 "지금 확인해 달라" — 단, 재연결 폭주가 폴링 폭주로 증폭되지 않게
 * 최소 간격(30s)을 둔다. 이미 더 이른 시각에 예약돼 있으면 그대로 둔다.
 */
function resync() {
  ensureStarted();
  const now = Date.now();
  if (now - st.lastKickAt < KICK_MIN_GAP_MS) return { ok: false, throttled: true, nextInMs: Math.max(0, st.nextAt - now) };
  st.lastKickAt = now;
  if (st.nextAt && st.nextAt - now <= 3000) return { ok: true, alreadySoon: true };
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.timer = null; void runOnce(); }, 1000);
  if (st.timer.unref) st.timer.unref();
  st.nextAt = now + 1000;
  return { ok: true, nextInMs: 1000 };
}

/**
 * back 제어 WS `e2ee_hint` 수용 — "지금 keyring 을 다시 확인해 보라"는 **힌트**다(계약 §2.12).
 * 호출자는 control.js 의 프레임 핸들러 하나뿐이다.
 *
 * 불변식(하나라도 깨지면 서버가 신뢰 경계 안으로 들어온다)
 *  ① 프레임 내용으로 상태를 바꾸지 않는다 — `hint` 에서 읽는 것은 로그용 `kind` 문자열뿐이고
 *    epoch/policy/봉인문은 애초에 스키마에 없다. 세대 판정은 전적으로 runOnce → callKeyring →
 *    acceptGrant(승인자 Ed25519 서명 검증)가 한다.
 *  ② 힌트로 루프를 **시작하지 않는다**(`!st.started` → 무시). 기동은 control 이 hello_ack 에서
 *    서버 선언(e2ee.keys.v1)을 확인한 뒤에만 한다 — 프레임 한 장이 새 동작을 유발할 수 있으면
 *    caps 교리가 무의미해지고, '서버가 껐다'고 판정된 환경에서도 왕복이 되살아난다.
 *  ③ 백오프를 **리셋하지 않는다**(st.delays 무접촉). 리셋하면 서버가 프레임만 반복해 재신청
 *    상한(6시간)을 0 으로 되돌릴 수 있고, 그것이 곧 승인 알림 폭탄이다.
 *  ④ `phase==='resolved'`(거절/만료 후 재신청 대기)에서는 아예 받지 않는다 — 그 상태의 runOnce 는
 *    **새 enroll** 을 만들고 back 은 그때마다 신뢰 기기에 승인 요청 푸시를 다시 쏜다. 승인은 사람이
 *    폰에서 하는 일이라 서버 이벤트가 재신청을 더 급하게 만들 여지도 없다.
 *  ⑤ 프레임을 **버리지 않는다** — back 은 재전송하지 않으므로 버린 사실은 다음 정기 폴링(15분)까지
 *    영구 유실이다. 상한(throttle)·진행 중(running)은 전부 '폐기' 가 아니라 '지연' 으로 처리한다
 *    (throttled → 상한 시점 1회 예약 · running → st.hintPending → runOnce finally 재확인).
 *    유일한 예외는 ②(미기동)와 ④(resolved) — 그 둘은 "받으면 안 되는" 상태이지 미룰 일이 아니다.
 * @returns {{ok:boolean, throttled?:boolean, deferred?:boolean, alreadySoon?:boolean, ignored?:string}}
 */
function hintResync(hint) {
  if (!st.started) return { ok: false, ignored: 'not_started' };   // 불변식 ②
  st.hintSeen += 1;
  const kind = hint && typeof hint.kind === 'string' ? hint.kind.slice(0, 32) : '';
  const now = Date.now();
  if (st.phase === 'resolved') return { ok: false, ignored: 'resolved' };   // 불변식 ④
  // ★ 진행 중 판정을 **무엇보다 먼저** 한다. 이 검사가 alreadySoon/throttle 뒤에 있으면 영구히
  //  도달하지 못했다(실측 결함): 타이머 콜백은 st.nextAt 을 갱신하지 않고 schedule() 은 화해가
  //  **끝난 뒤** 부르므로 runOnce 가 도는 동안 st.nextAt 은 언제나 과거값 = alreadySoon 이 늘 참이다.
  //  그러면 힌트가 유일한 회복 수단인 그 레이스(back 은 keyring 을 저장한 뒤 팬아웃하는데 그 사이에
  //  우리 GET 이 끼면 옛 세대를 읽는다)에서 프레임을 버려 회전 직후 15분 고착이 그대로 남는다.
  if (st.running) { st.hintPending = true; return { ok: true, deferred: true, kind: kind || null }; }
  // 이미 곧 돌 예정이면 그대로 둔다 — 한 사용자 조작이 낸 프레임 여러 장이 왕복 N회로 증폭되지
  //  않게. throttle 보다 **먼저** 본다(대기 중인 예약을 헛되게 지우지 않도록).
  //  ★ `> now` 조건이 계약이다: 이미 발화해 소비된 예약(과거 시각)은 "곧 돌 예정" 이 아니다.
  if (st.nextAt > now && st.nextAt - now <= HINT_COALESCE_MS) return { ok: true, alreadySoon: true };
  if (now - st.lastHintAt < HINT_MIN_GAP_MS) {
    // 수용 상한(5초)은 **폐기가 아니라 지연**이다. back 은 프레임을 재전송하지 않으므로 여기서
    //  버리면 그 사실은 다음 정기 폴링(15분)까지 영구 유실된다 — 실측 결함: revoke → rotate_needed
    //  뒤 사람이 회전을 확정하는 '한 조작 두 프레임' 의 두 번째 장(간격 수백ms~수초 = 합침창 400ms
    //  밖 · throttle창 5s 안)이 사라져 데몬이 옛 세대로 남았다.
    //  마지막 수용 시각 + 상한 시점에 **딱 한 번** 화해를 예약한다(타이머 1개 · st.delays 무접촉
    //  → 분당 12회 상한은 그대로). lastHintAt 을 그 예약 시각으로 미뤄 두는 이유 = 프레임이 폭주해도
    //  같은 시각으로 수렴해 재예약이 누적되지 않게(멱등).
    const at = st.lastHintAt + HINT_MIN_GAP_MS;
    if (st.nextAt > now && st.nextAt <= at) return { ok: false, throttled: true, nextInMs: Math.max(0, st.nextAt - now) };
    st.lastHintAt = at;
    armHint(at - now);
    return { ok: false, throttled: true, deferred: true, nextInMs: Math.max(0, at - now), kind: kind || null };
  }
  st.lastHintAt = now;
  armHint();
  return { ok: true, nextInMs: HINT_COALESCE_MS, kind: kind || null };
}

// 힌트 → 즉시 화해 예약. schedule() 을 쓰지 않는 이유 = st.delays(백오프)를 건드리지 않기 위해서다.
//  delayMs 를 주면 그만큼 미룬다(= throttle 창 안에 온 힌트를 버리지 않고 상한 시점으로 지연).
function armHint(delayMs) {
  st.hintRuns += 1;
  const wait = Math.max(0, Number.isFinite(delayMs) ? delayMs : HINT_COALESCE_MS);
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => { st.timer = null; void runOnce(); }, wait);
  if (st.timer.unref) st.timer.unref();
  st.nextAt = Date.now() + wait;
}

function stop() {
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  st.started = false;
  st.hintPending = false;
  return { ok: true };
}

// ── e2ee-local(cpt.sock) 위임 표면 ───────────────────────────────────────────
/**
 * `e2ee.state` 의 계정측 조각. **네트워크를 기다리지 않는다**(PC 는 60초마다 이걸 부른다) —
 * 마지막으로 확인한 사실 + 진행 여부를 정직하게 돌려준다.
 *  keyState: none | enrolled | pending | trusted  ← "확인 중"과 "평문"을 구분하는 정본 값
 *  state   : PC/앱의 기존 도메인(off|unsupported|bootstrap|pending|trusted|error) 매핑
 *
 * ⚠ 여기서 폴링 루프를 **시작하지 않는다**: PC 는 60초마다 이걸 부르므로 조회가 기동 트리거가 되면
 *  서버가 `e2ee.keys.v1` 을 선언하지 않은 환경에서도 폴링이 돈다(caps 교리 위반 + 503 로그 폭주).
 *  기동은 control 이 hello_ack 에서 서버 선언을 확인한 뒤에만 한다.
 */
// "확인 중" = 지금 왕복 중이거나, **한 번이라도 확인을 돌린 뒤** 아직 열쇠를 못 받은 상태.
//  ★ 한 번도 안 돌렸으면 false 다(그때 true 를 주면 화면이 영원히 "확인 중" 으로 남아 사용자가
//   평문으로 돌고 있다는 사실을 모른다 — 거짓 자물쇠의 다른 얼굴).
//  bootstrap(계정에 열쇠 없음)은 사람을 기다리는 것이므로 확인 중이 아니다.
function isChecking() {
  return st.running || (st.lastRunAt > 0 && st.keyState !== 'trusted' && st.phase !== 'off' && st.phase !== 'bootstrap');
}

// 정책 서버 동기화 실패는 **무음으로 두지 않는다** — 사용자는 '항상' 을 켰다고 믿는데 계정에는
//  적용되지 않은 상태이고, 그 사실을 알려 주는 신호가 로그 한 줄뿐이면 아무도 모른다.
function policySyncReason(pol) {
  const s = st.policySync;
  if (!s || s.policy !== pol) return null;
  if (s.code === 'RECOVERY_REQUIRED') {
    return "'항상' 이 이 계정에는 아직 적용되지 않았어요 — 먼저 복구 코드를 만들어 주세요(이 PC 에서는 그대로 적용됩니다).";
  }
  return '정책을 계정에 전파하지 못했어요(이 PC 에서는 그대로 적용됩니다).';
}

async function state() {
  const e = core();
  const keyed = !!(e && e.hasKey());
  if (keyed && st.keyState !== 'trusted') st.keyState = 'trusted';
  const pol = e ? e.policy() : 'off';
  loadUserRef(e);                       // 재기동 직후에도 파일의 사실을 그 자리에서 복원(네트워크 0)
  const checking = isChecking();
  return {
    state: pcState(keyed, pol, checking),
    keyState: st.keyState,
    checking,
    userRef: st.userRef,
    enrollmentId: st.enrollmentId,
    pendingSince: st.pendingSince,
    accountEpoch: st.accountEpoch,
    recoverySet: st.recoverySet,
    reason: policySyncReason(pol) || st.reason || (st.started ? null : '아직 열쇠 확인을 시작하지 않았어요(서버 연결 대기).'),
    lastError: st.lastError,
    nextCheckInMs: st.nextAt ? Math.max(0, st.nextAt - Date.now()) : null,
    phase: st.phase,
  };
}
// PC/앱 UI 도메인 매핑. **policy='off'(킬스위치)가 최우선**이다 — 열쇠를 갖고 있어도 사용자가 껐으면
//  화면은 'off' 여야 한다(자물쇠를 그리면 그게 거짓 자물쇠의 반대 방향 거짓말이 된다).
//
// ★ 도메인에 'none'(열쇠 없음) · 'enrolled'(등록됨·승인 대기)를 **실제로 내보낸다**(계약 §2.4 개정).
//  PC 는 두 값의 분기를 이미 갖고 있는데(settings.js: 'none'→"열쇠 없음"(off 톤) / 'enrolled'→"승인 대기")
//  데몬이 그 값을 만들지 않아 죽은 코드였고, 열쇠가 없는 **모든** 경우가 'bootstrap' 으로 접혀
//  노란 "준비 중"(진행 중)으로 표시됐다 — 사람이 폰에서 켜 주기 전까지 아무 일도 일어나지 않는
//  **확정 평문**을 "진행 중" 으로 위장하는 것이 이 라운드가 없애려던 거짓 자물쇠의 얼굴이다.
//  구분 규칙: 실제로 왕복 중이면(checking) 'bootstrap'(준비 중), 아니면 'none'(열쇠 없음).
function pcState(keyed, policy, checking) {
  if (policy === 'off') return 'off';
  if (keyed) return 'trusted';
  if (st.phase === 'off') return 'off';
  if (st.keyState === 'pending') return 'pending';
  if (st.keyState === 'enrolled') return 'enrolled';
  if (st.phase === 'error' || st.phase === 'revoked') return 'error';
  if (checking) return 'bootstrap';
  return 'none';
}

// ── PC 조회(60초 주기)의 왕복 게이트 ─────────────────────────────────────────
//  PC 는 `setInterval(refreshE2ee, 60000)` 으로 state → pending → keyring 세 커맨드를 부른다. 그래서
//  pending/keyring 이 무조건 backFetch 하면 **폴링 루프의 백오프·킬스위치를 전부 우회**한다:
//  서버가 e2ee.keys.v1 을 선언하지 않아 루프가 아예 안 도는 환경에서도, 서버 킬스위치로 503 이 계속
//  오는 환경에서도, 사용자가 policy='off' 로 끈 상태에서도 PC 1대당 분당 2회가 영구히 나간다
//  (이 라운드 전에는 계정 모듈이 없어 네트워크 0회였다 = 회귀). 규율은 state() 와 같다:
//  **네트워크를 기다리지 않는다 — 마지막으로 확인한 사실을 돌려준다.**
function queryGateOpen() {
  // 루프가 한 번도 관여하지 않았다(서버 미선언) → 왕복 금지.
  if (!st.started && !(st.lastRunAt > 0)) return false;
  // 서버가 껐다/라우트 없음/사용자 킬스위치로 판정된 뒤에는 조회도 같이 물러난다.
  if (st.phase === 'off') return false;
  if (st.queryOffUntil && Date.now() < st.queryOffUntil) return false;
  return true;
}
// 조회 실패의 네거티브 캐시 — 킬스위치/라우트 부재는 길게(1시간), 일시 장애는 짧게(5분) 물러난다.
function noteQueryFailure(err) {
  const code = err && err.code;
  const off = code === 'E2EE_DISABLED' || (err && err.status === 404);
  st.queryOffUntil = Date.now() + (off ? OFF_MS : ENROLL_MAX_MS);
}

/** 승인 시트 목록. 실패는 **빈 목록**(소켓 에러로 던지면 PC 가 E2EE 전체를 '미지원'으로 뒤집는다). */
async function pending() {
  const e = core();
  if (!e) return { pending: [] };
  const now = Date.now();
  if (st.cache.pending && now - st.cache.pendingAt < FETCH_CACHE_MS) return st.cache.pending;
  if (!queryGateOpen()) return st.cache.pending || { pending: [], epoch: st.accountEpoch || 0 };
  let body = {};
  try { body = unwrap(await backFetch('GET', '/api/daemon/e2ee/pending')); } catch (err) {
    st.lastError = (err && err.message) || String(err);
    noteQueryFailure(err);
    return { pending: [], epoch: st.accountEpoch || 0, error: st.reason || null };
  }
  takeUserRef(body);
  // ★ identityOf/decorate 는 try 안에 있어야 한다 — 상태 파일을 읽을 수 없는 상황(권한·손상)에서
  //  여기서 던지면 PC 가 E2EE 카드 전체를 '미지원' 으로 뒤집는다(계약 §2.4 규약①).
  try {
    loadUserRef(e);
    const mine = identityOf(e).ikX;
    const items = (Array.isArray(body.pending) ? body.pending : [])
      // 내 자신의 신청은 승인 시트에 넣지 않는다(자기 승인 불가 + 화면 혼동). 그건 state 가 표현한다.
      .filter((p) => p && p.ikX && p.ikX !== mine)
      .map((p) => decorate(e, p));
    const out = { pending: items, epoch: Number(body.epoch) || st.accountEpoch || 0, trustedCount: Number(body.trustedCount) || 0 };
    st.cache.pending = out;
    st.cache.pendingAt = now;
    return out;
  } catch (err) {
    st.lastError = (err && err.message) || String(err);
    return { pending: [], epoch: st.accountEpoch || 0, error: '열쇠 파일을 읽을 수 없어 승인 목록을 표시할 수 없어요.' };
  }
}

// 사람이 대조하는 값 — **로컬 파생**이 정본이고 서버 값은 대조용으로만 함께 싣는다(§2.10).
//  safetyCode(60비트)가 대조 대상이고 4자리는 요청 구분용이다(서버가 1.3초에 맞출 수 있다).
function decorate(e, row) {
  const out = { ...row };
  // ★ 파생 기준(userRef)을 모르면 **아무 값도 내보내지 않는다**. 여기서 ''(빈 문자열)로 파생하면
  //  폰 화면과 다른 안전코드가 나오는데, 승인 시트 문구는 "글자까지 똑같은지 확인하고 다르면 거절" 이라
  //  사용자를 정확히 틀린 값으로 유도한다(대조 방어 무력화 — 실측 결함). null 이면 PC 는 '—' 를 그린다.
  if (!st.userRef) {
    out.safetyCode = null;
    out.fingerprint = null;
    out.verifyCode = null;
    out.serverVerifyCode = typeof row.verifyCode === 'string' ? row.verifyCode : null;
    return out;
  }
  try {
    const fp = e.fingerprint(row.ikX, st.userRef);
    out.safetyCode = fp.safety;
    out.fingerprint = fp.legacy;
    out.serverVerifyCode = typeof row.verifyCode === 'string' ? row.verifyCode : null;
    out.verifyCode = fp.short;
    out.verified = !out.serverVerifyCode || out.serverVerifyCode === fp.short;
  } catch (_) { /* 파생 실패 = 서버 값 그대로 표시 */ }
  return out;
}

/** 키링(감사 UI) — PC 계약의 `deviceKeyId` 로 매핑한다(back 은 `keyId`). */
async function keyring() {
  const e = core();
  if (!e) return { epoch: 0, devices: [] };
  const cached = st.cache.keyring;
  if (!queryGateOpen()) {
    // 왕복 금지 상태 — 마지막 스냅샷(공개 정보)만 돌려준다. epoch 는 로컬 파일이 정본이다.
    return { epoch: e.epoch(), policy: e.policy(), devices: [], ...(cached ? { myState: cached.myState || 'unknown' } : {}) };
  }
  let kr = null;
  try { kr = await callKeyring(e); } catch (err) {
    st.lastError = (err && err.message) || String(err);
    noteQueryFailure(err);
    return { epoch: e.epoch(), devices: [], error: '키링을 불러올 수 없습니다.' };
  }
  // identityOf/decorate 는 try 안 — pending() 과 같은 규약①(소켓 에러로 던지지 않는다).
  try {
    loadUserRef(e);
    const mine = identityOf(e).ikX;
    return {
      epoch: Number(kr.epoch) || 0,
      policy: kr.policy || e.policy(),
      recoverySet: !!kr.recoverySet,
      myKeyId: kr.myKeyId != null ? Number(kr.myKeyId) : null,
      myState: kr.myState || 'unknown',
      devices: (Array.isArray(kr.devices) ? kr.devices : []).map((d) => ({
        ...decorate(e, d),
        deviceKeyId: Number(d.keyId),          // PC `e2ee.keyring` 계약 필드명
        isThisDevice: d.ikX === mine,
      })),
    };
  } catch (err) {
    st.lastError = (err && err.message) || String(err);
    return { epoch: Number(kr.epoch) || 0, devices: [], error: '열쇠 파일을 읽을 수 없어 기기 목록을 표시할 수 없어요.' };
  }
}

/** 승인 = 내 MK 를 신청 기기 공개키로 봉인해 업로드. 도메인 실패는 {ok:false}(규약 ①). */
async function approve(a) {
  const e = core();
  if (!e) return { ok: false, code: 'E2EE_UNSUPPORTED', error: '이 데몬은 종단간 암호화를 지원하지 않습니다.' };
  const enrollmentId = String((a && a.enrollmentId) || '').trim();
  const ikX = String((a && a.ikX) || '').trim();
  if (!enrollmentId || !ikX) return { ok: false, error: '승인 대상 정보가 부족합니다.' };
  if (!e.hasKey()) return { ok: false, code: 'E2EE_NO_KEY', error: '이 PC 에 계정 열쇠가 없어 다른 기기를 승인할 수 없어요.' };
  try {
    const kr = await callKeyring(e, { force: true });
    const epoch = Number(kr.epoch) || 0;
    if (epoch !== (e.epoch() | 0)) {
      return { ok: false, code: 'EPOCH_MISMATCH', error: '열쇠 세대가 달라졌어요. 화면을 새로 고친 뒤 다시 시도해 주세요.' };
    }
    const payload = e.approvePayload(enrollmentId, ikX, epoch);   // {enrollmentId, ikX, epoch, sealed, sig}
    const r = unwrap(await backFetch('POST', '/api/daemon/e2ee/approve', { ...payload, approverIkX: identityOf(e).ikX }));
    log(`기기 승인 업로드 완료 keyId=${r.keyId != null ? r.keyId : '?'} epoch=${r.epoch != null ? r.epoch : epoch}`);
    st.cache.keyringAt = 0;
    st.cache.pendingAt = 0;
    return { ok: true, keyId: r.keyId != null ? Number(r.keyId) : null, epoch: Number(r.epoch) || epoch };
  } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '승인에 실패했습니다.' };
  }
}

async function deny(a) {
  const enrollmentId = String((a && a.enrollmentId) || '').trim();
  if (!enrollmentId) return { ok: false, error: '거절 대상 정보가 부족합니다.' };
  try {
    await backFetch('POST', '/api/daemon/e2ee/deny', { enrollmentId });
    st.cache.pendingAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '거절에 실패했습니다.' };
  }
}

/**
 * 신뢰 해제 + epoch 회전. 남는 기기 **전부**에 새 봉인문을 올려야 back 이 받는다(INCOMPLETE_ROTATION).
 *
 * ⚠ 순서 함정: `e.rotate()` 는 로컬에 새 세대를 **즉시 커밋**하고 옛 세대 스트림 세션을 끊는다.
 *  서버 업로드가 실패하면 우리 epoch 만 앞서가 계정과 어긋나고(내 봉투가 전부 거절됨) 스스로 복구할
 *  방법이 없다 → 실패 시 상태 파일을 되돌린다(rollback). 세션이 끊긴 것은 무해하다: 클라이언트는
 *  이미 "sid 무효 → 토큰 재발급" 경로를 갖고 있다(데몬 재기동과 같은 상황).
 */
async function revoke(a) {
  const e = core();
  if (!e) return { ok: false, code: 'E2EE_UNSUPPORTED', error: '이 데몬은 종단간 암호화를 지원하지 않습니다.' };
  const target = (a && a.deviceKeyId) != null ? Number(a.deviceKeyId) : null;
  if (target == null || !Number.isFinite(target)) return { ok: false, error: '해제 대상 기기를 알 수 없습니다.' };
  if (!e.hasKey()) return { ok: false, code: 'E2EE_NO_KEY', error: '이 PC 에 계정 열쇠가 없어 해제할 수 없어요.' };
  let from = 0;
  let to = 0;
  try {
    const kr = await callKeyring(e, { force: true });
    from = Number(kr.epoch) || 0;
    if (from !== (e.epoch() | 0)) return { ok: false, code: 'EPOCH_MISMATCH', error: '열쇠 세대가 달라졌어요. 다시 시도해 주세요.' };
    if (kr.myKeyId != null && Number(kr.myKeyId) === target) {
      return { ok: false, error: '이 PC 자신은 해제할 수 없어요(다른 기기에서 해제해 주세요).' };
    }
    const rows = Array.isArray(kr.devices) ? kr.devices : [];
    const row = rows.find((d) => Number(d.keyId) === target);
    if (!row || row.state !== 'trusted') return { ok: false, error: '이미 해제된 기기예요.' };
    const remaining = rows.filter((d) => d.state === 'trusted' && Number(d.keyId) !== target);
    if (!remaining.length) return { ok: false, error: '남는 기기가 없어 해제할 수 없어요.' };
    to = from + 1;
    const rot = e.rotate(remaining.map((d) => ({ deviceKeyId: Number(d.keyId), ikX: d.ikX })), { toEpoch: to });
    try {
      const r = unwrap(await backFetch('POST', '/api/daemon/e2ee/rotate', {
        approverIkX: identityOf(e).ikX,
        fromEpoch: from,
        toEpoch: to,
        revokeKeyIds: [target],
        grants: rot.grants.map((g) => ({ keyId: Number(g.deviceKeyId), ikX: g.ikX, sealed: g.sealed, sig: g.sig })),
      }));
      pruneEpochs(e);
      st.cache.keyringAt = 0;
      st.accountEpoch = Number(r.epoch) || to;
      notifyKeyChange();       // 새 세대를 back 에 알린다(옛 세대로 오는 봉투는 이제 거절된다)
      log(`기기 해제 + 세대 회전 ${from}→${to} 재봉인=${rot.grants.length} 해제=#${target}`);
      return { epoch: Number(r.epoch) || to, ok: true, revoked: [target] };
    } catch (err) {
      rollbackEpoch(e, from, to);
      warn(`회전 업로드 실패 — 로컬 세대를 ${to}→${from} 되돌림: ${(err && err.message) || err}`);
      return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '기기 해제에 실패했습니다.' };
    }
  } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '기기 해제에 실패했습니다.' };
  }
}

// 서버가 거절한 세대를 로컬에서 되돌린다(상태 파일 조작 — 암호 연산 아님).
function rollbackEpoch(e, from, to) {
  try {
    const s = e.loadState();
    if (!s) return false;
    if (s.keys) delete s.keys[String(to)];
    s.epoch = Number(from) || 0;
    e.saveState(s);
    e.clearCache();
    notifyKeyChange();   // 되돌린 세대도 back 에 알린다(앞서간 epoch 를 신고한 채로 두면 안 된다)
    return true;
  } catch (_) { return false; }
}

/**
 * 정책 서버 동기화(로컬이 정본, 여기는 계정 전파). 실패는 호출측이 무해 처리한다 —
 *  단 **무음으로 두지는 않는다**: 실패 사실을 st.policySync 에 남겨 e2ee.state 의 reason 으로 나간다.
 *  `required` 는 back 이 복구 blob 없으면 409 RECOVERY_REQUIRED 로 거절하는데(그 blob 을 올리는 구현체는
 *  의도적으로 없다), 그것을 완전 무음으로 삼키면 사용자는 '항상' 이 계정에 안 걸린 줄 모른 채
 *  다른 기기에서 평문 폴백이 계속 허용된다.
 */
async function setPolicy(a) {
  const p = String((a && a.policy) || '');
  try {
    const r = unwrap(await backFetch('PATCH', '/api/daemon/e2ee/policy', { policy: p }));
    st.policySync = null;
    return { policy: r.policy || p, epoch: r.epoch != null ? Number(r.epoch) : st.accountEpoch };
  } catch (err) {
    st.policySync = { policy: p, code: (err && err.code) || null, message: (err && err.message) || String(err) };
    warn(`정책 계정 전파 실패(${st.policySync.code || 'ERR'}) — 로컬 ${p} 는 유지된다`);
    throw err;
  }
}

/**
 * "열쇠 사실이 바뀌었다" 를 계정 모듈 밖(e2ee-local)에서 알릴 수 있게 하는 유일한 출구.
 *  복구 코드 복원(로컬 epoch 0→N)·정책 off/on(caps 회수/복귀)은 계정 모듈을 거치지 않는데,
 *  hello 재신고가 없으면 back 의 conn.caps/e2eeEpoch 가 다음 재접속까지 옛 사실로 남아 다른 기기의
 *  배지가 거짓말을 한다(양방향: 복원 후 '평문' / 해제·off 후 '암호화됨').
 */
function noteKeyChanged() { return notifyKeyChange(); }

/**
 * 계정 최초 열쇠 생성 — **사람이 명시적으로 요청했을 때만**(자동 호출 지점 없음, 파일 헤더 판단).
 * cpt.sock `e2ee.bootstrap` 으로 노출된다(PC UI 버튼이 붙으면 그때 쓰인다).
 */
async function bootstrap() {
  const e = core();
  if (!e) return { ok: false, code: 'E2EE_UNSUPPORTED', error: '이 데몬은 종단간 암호화를 지원하지 않습니다.' };
  if (e.hasKey()) return { ok: true, epoch: e.epoch(), already: true };
  try {
    const pre = await callEnroll(e);
    if (String(pre.state) !== 'bootstrap') {
      return { ok: false, code: 'E2EE_NOT_BOOTSTRAP', error: '이 계정에는 이미 열쇠가 있어요. 다른 기기에서 승인해 주세요.' };
    }
    const id = identityOf(e);
    const boot = e.bootstrapMasterKey();          // 로컬 커밋(epoch 1) — 실패 시 되돌린다
    try {
      const s = e.sealTo(id.ikX, { epoch: boot.epoch });   // 자기 자신에게 봉인
      const r = unwrap(await backFetch('POST', '/api/daemon/e2ee/bootstrap', {
        ikX: id.ikX, ikEd: id.ikEd, label: id.label, platform: process.platform, kind: 'host',
        sealed: s.sealed, sig: s.sig,
      }));
      st.keyState = 'trusted';
      st.phase = 'trusted';
      st.accountEpoch = Number(r.epoch) || boot.epoch;
      notifyKeyChange();
      log(`계정 최초 열쇠 생성(사용자 요청) epoch=${st.accountEpoch}`);
      return { ok: true, epoch: st.accountEpoch };
    } catch (err) {
      // ★ 409 ALREADY_INITIALIZED 등 — 로컬 MK_1 을 남기면 계정 열쇠가 갈라진다(전 기기 상호 복호 불가).
      rollbackEpoch(e, 0, boot.epoch);
      warn(`부트스트랩 실패 — 로컬 열쇠 폐기: ${(err && err.message) || err}`);
      return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '열쇠 생성에 실패했습니다.' };
    }
  } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '열쇠 생성에 실패했습니다.' };
  }
}

/**
 * 페어링(QR) 응답에 실려 온 봉인문 수용 — `POST /pair/claim` 이 `{e2ee:{epoch,sealed,sig,sealedByKeyId}}`
 * 를 함께 준다(daemonController.js:639-643). 승인자 ikEd 는 키링에서 읽어 **서명을 검증**한다.
 *  ⚠ 호출자는 `packages/daemon`(pair CLI)·PC 앱이다 — 이 라운드에서는 함수만 준비했다(미완 참조).
 */
async function acceptPairGrant(grant) {
  const e = core();
  if (!e) return { ok: false, code: 'E2EE_UNSUPPORTED' };
  try {
    const kr = await callKeyring(e, { force: true });
    acceptGrant(e, grant, kr.devices);
    return { ok: true, epoch: e.epoch() };
  } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '봉인문 수용 실패' };
  }
}

/** pair/session 에 실을 공개 신원(비밀 아님) — PC/CLI 가 QR 지문에 쓴다. */
function identityForPairing() {
  const e = core();
  if (!e) return null;
  const id = identityOf(e);
  return { ikX: id.ikX, ikEd: id.ikEd };
}

// ── 복구 코드는 서버를 쓰지 않는다(의도) ─────────────────────────────────────
//  `setRecovery` 를 **일부러 내보내지 않는다**: 복구 코드 문자열 자체가 MK 를 담는 자기완결 형식이고
//  (e2ee.js recoveryCode = 앱 e2eeProto.recoveryCode 와 동일), 앱도 서버에 봉인문을 올리지 않는다
//  (codingpt_app/src/services/e2ee.ts:758). 여기서 서버용 blob 포맷을 새로 만들면 **다른 구현체가
//  못 여는 봉인문**이 계정에 남는다(3구현체 동치 규율 위반). e2ee-local 은 이 함수가 없으면 서버
//  업로드 단계를 조용히 건너뛴다 — 그게 정확히 원하는 동작이다.

module.exports = {
  // 생명주기(control.js)
  start, stop, resync, runOnce,
  // back 제어 WS 힌트 수용(control.js `e2ee_hint` 핸들러 전용) — 가속기이고 정본이 아니다.
  hintResync,
  // e2ee-local(cpt.sock) 위임 표면
  state, pending, keyring, approve, deny, revoke, setPolicy, bootstrap, noteKeyChanged,
  // 페어링 경로(호출자는 packages/daemon·PC)
  acceptPairGrant, identityForPairing,
  // 테스트 노출 — 백오프 상한/보관 세대/내부 상태를 계약으로 고정한다
  _nextDelay: nextDelay,
  _state: st,
  _pruneEpochs: pruneEpochs,
  _reset: () => {
    stop();
    Object.assign(st, {
      running: false, lastRunAt: 0, lastKickAt: 0, nextAt: 0, phase: 'boot', keyState: 'none',
      delay: 0, phaseKind: null, delays: {}, enrollmentId: null, pendingSince: null, accountEpoch: null,
      recoverySet: false, userRef: '', reason: null, lastError: null, devices: [],
      queryOffUntil: 0, policySync: null,
      lastHintAt: 0, hintSeen: 0, hintRuns: 0, hintPending: false,
      cache: { pending: null, pendingAt: 0, keyring: null, keyringAt: 0 },
    });
  },
  _config: {
    BOOT_MIN_MS, ENROLL_BASE_MS, ENROLL_MAX_MS, PENDING_BASE_MS, PENDING_MAX_MS,
    TRUSTED_MS, RESOLVED_BASE_MS, RESOLVED_MAX_MS, BOOTSTRAP_BASE_MS, BOOTSTRAP_MAX_MS,
    OFF_MS, KICK_MIN_GAP_MS, KEEP_EPOCHS, FETCH_CACHE_MS,
    HINT_COALESCE_MS, HINT_MIN_GAP_MS,
  },
};
