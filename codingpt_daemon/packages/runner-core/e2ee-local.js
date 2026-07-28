/**
 * e2ee-local.js — cpt.sock 의 `e2ee.*` 커맨드(PC 앱 전용 내부 표면).
 *
 * 왜 이 파일인가(설계 근거):
 *  · **마스터키는 PC UI JS 로 내려가지 않는다.** MK 가 필요한 연산(봉인/개봉/서명/봉투 RPC)은 전부
 *    데몬이 수행하고 PC 는 공개 입력 파생(확인 숫자·지문)만 한다(`codingpt_pc/src/js/e2ee.js` 헤더).
 *    Rust 는 `e2ee.` 접두사만 통과시키는 얇은 브리지다(`cptsock.rs:143-149`).
 *  · 암호는 `./e2ee`(코어)가 전담하고 이 파일은 **커맨드 매핑 + 실패 표현 규약**만 담당한다.
 *    모듈 로드는 `./e2ee-gate` 를 거친다 — 킬스위치(CPT_E2EE=0)·스코프·테스트 모듈 override 를
 *    한 곳에서 판정하기 위함이다(암호 코드 0줄 규율).
 *
 * ── 응답 규약(어기면 PC 가 조용히 오동작) ───────────────────────────────────
 *  ① **소켓 에러(ok:false)는 "이 데몬은 E2EE 를 모른다"는 뜻으로만 쓴다.** PC `cpt()` 는 IPC 실패를
 *     보면 `available=false, state='unsupported'` 로 내려앉는다 — 즉 그 커맨드만 실패하는 게 아니라
 *     **E2EE 전체가 미지원 표시**가 된다(`e2ee.js:76-85`). 그래서 정상적인 도메인 실패(승인 대상 없음,
 *     복구 코드 오타, 열쇠 없음 …)는 반드시 `{ok:false, error}` **result** 로 회신한다.
 *     예외: `e2ee.rpc` 의 "미지원/중계 실패"는 **일부러 throw** 한다 — 그게 평문 폴백 신호이고,
 *     PC 는 10분 네거티브 캐시로 왕복을 멈춘다(§2.7). 다음 `refreshE2ee`(60s)가 상태를 복구한다.
 *  ② `e2ee.rpc` 는 성공했는데 결과가 비어도 `{ok:true, r:{}}` 를 돌려준다. `null` 을 주면 PC 가
 *     "미지원 폴백"으로 오해해 같은 변형(fs.write)을 **평문으로 한 번 더** 실행한다(이중 실행).
 *  ③ 봉투 AAD 의 hostDeviceId 는 **요청 본문에 실은 값(미지정=0)** 이다(계약 §2.3). 여기서 자기
 *     deviceId 를 쓰면 활성 러너 위임(host 미지정) 호출이 100% 복호 실패하고 그것이 "서버 미지원"으로
 *     캐시돼 평문으로 내려간다 = 잠금 배지는 켜져 있고 트래픽은 평문.
 *
 * ── 열쇠 취득 배관(계약 §2.6 의 2b) ─────────────────────────────────────────
 *  서버가 원천인 커맨드는 `./e2ee-account`(2026-07-26 신설) 로 위임한다. 그 모듈이 없는 구 번들에서는
 *  "빈 목록 / 명확한 도메인 실패" 를 돌려주므로 이 파일은 양쪽 배포에서 그대로 동작한다.
 *  `e2ee.bootstrap` 은 **사람이 명시적으로 눌렀을 때만** 부르는 커맨드다(자동 호출 지점 없음 —
 *  근거는 e2ee-account.js 헤더: 헤드리스 데몬이 계정 신뢰 기점을 세우면 폰만 든 사용자가 잠긴다).
 */
const gate = require('./e2ee-gate');

const POLICIES = ['off', 'preferred', 'required'];
const RPC_TIMEOUT_DEFAULT_MS = 15000;
const RPC_TIMEOUT_MAX_MS = 60000;

// 코어 모듈 — 없으면(구 번들) 또는 킬스위치 OFF 면 throw = PC 가 '미지원' 으로 내려앉는다(규약 ①).
//  callLazy(control.js) 와 같은 규율: 모듈 부재를 **명확한 실패**로 바꾼다(조용한 성공 금지).
function core() {
  const e = gate.load();
  if (!e || typeof e.identity !== 'function') {
    throw Object.assign(new Error('이 데몬은 종단간 암호화를 지원하지 않습니다(PC 앱 업데이트 필요)'), { code: 'E2EE_UNSUPPORTED' });
  }
  if (!gate.allows('rpc')) {
    throw Object.assign(new Error(`이 데몬에서 E2EE 가 꺼져 있습니다(scope=${gate.scope()})`), { code: 'E2EE_DISABLED' });
  }
  return e;
}

// 계정 표면(2b) — 있으면 위임, 없으면 null. 여기서 REST 를 직접 부르지 않는 이유: enroll/approve 는
//  서명·봉인 순서와 서버 계약(deviceTrustService)이 한 벌로 묶여야 해서 별 모듈이 정본이어야 한다.
function account() {
  try { return require('./e2ee-account'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    console.error('[e2ee] 계정 모듈 로드 실패:', e.message);
    return null;
  }
}
function accountFn(name) {
  const a = account();
  return a && typeof a[name] === 'function' ? a[name].bind(a) : null;
}
const NO_ACCOUNT = {
  ok: false,
  code: 'E2EE_NO_ENROLL_CLIENT',
  error: '이 PC 데몬에는 아직 열쇠 등록/승인 배관이 없습니다(업데이트 필요).',
};

function hasKey(e) { try { return !!e.hasKey(); } catch (_) { return false; } }

// ── e2ee.state ────────────────────────────────────────────────────────────
// PC 가 읽는 필드: {available, state, epoch, policy, scope, ikX, userRef, enrollmentId, recoverySet, reason}
//  state 도메인(PC settings.js:572-578): off | unsupported | bootstrap | pending | trusted | error
//
// ★ 열쇠 취득 진행상태(`keyState`)를 함께 싣는다 — **거짓 자물쇠 방지**의 핵심이다.
//  기존 `state` 는 PC/앱의 UI 도메인이라 "아직 확인 중" 과 "확인이 끝났고 평문이다" 를 구분하지
//  못한다(둘 다 bootstrap/pending 으로 보인다). 그러면 화면은 "준비 중" 인데 트래픽은 이미 평문으로
//  왕복하고, 사용자는 자기 데이터가 지금 어떤 상태인지 알 수 없다.
//  keyState: none(등록 전/보류) | enrolled(등록됨, 봉인문 대기) | pending(승인 대기) | trusted(열쇠 보유)
//  + checking(지금 확인 중인가) · nextCheckInMs(다음 확인까지) · phase(진단) 를 additive 로 노출한다.
//  구 PC/앱은 모르는 필드를 무시하므로 하위호환이다.
async function state() {
  const e = core();
  // ★ 상태 파일을 읽고 쓸 수 없는 상황(권한 사고·디스크 꽉 참·파일 손상)에서도 **던지지 않는다**:
  //  여기서 throw 하면 PC 는 그 커맨드만 실패하는 게 아니라 E2EE 카드 전체를 '미지원' 으로 뒤집는다
  //  (계약 §2.4 규약① — pending/keyring 은 이미 지키는데 state 만 어긋나 있었다). 실제로는 열쇠가
  //  있었을 수도 있는데 화면이 "이 데몬은 지원 안 함" 이라고 거짓 진단을 내린다.
  let id = null;
  let policy = 'preferred';
  let epoch = 0;
  let keyed = false;
  try {
    id = e.identity();                     // 신원키 멱등 생성(MK 아님 — 0600 파일)
    policy = e.policy();
    epoch = e.epoch();
    keyed = hasKey(e);
  } catch (err) {
    const corrupt = err && err.code === 'E2EE_STATE_CORRUPT';
    return {
      available: true,
      state: 'error',
      keyState: 'none',
      checking: false,
      nextCheckInMs: null,
      accountEpoch: null,
      phase: 'state_error',
      epoch: 0,
      policy,
      scope: gate.scope(),
      ikX: null,
      userRef: '',
      enrollmentId: null,
      recoverySet: false,
      reason: corrupt
        ? '열쇠 파일이 손상됐어요 — 덮어쓰지 않았습니다(사본을 남겼습니다). 복구 코드로 복원해 주세요.'
        : '열쇠 파일을 읽고 쓸 수 없어요(디스크 여유·권한을 확인해 주세요). 그동안은 기존 방식(평문)으로 동작합니다.',
      lastError: (err && err.message) || String(err),
    };
  }
  let extra = {};
  const fn = accountFn('state');
  if (fn) {
    try { extra = (await fn()) || {}; } catch (err) { extra = { reason: (err && err.message) || null }; }
  }
  const st = extra.state || (policy === 'off' ? 'off' : (keyed ? 'trusted' : 'bootstrap'));
  // 계정 모듈이 없는 구 번들에서는 "열쇠가 있으면 trusted, 없으면 none" — 취득 배관이 없으므로
  //  'pending' 을 주장하면 영원히 오지 않는 승인을 기다리는 것처럼 보인다(정직하게 none).
  const keyState = extra.keyState || (keyed ? 'trusted' : 'none');
  return {
    available: true,
    state: st,
    keyState,
    checking: extra.checking === true,
    nextCheckInMs: extra.nextCheckInMs != null ? extra.nextCheckInMs : null,
    accountEpoch: extra.accountEpoch != null ? extra.accountEpoch : null,
    phase: extra.phase || (fn ? null : 'no_enroll_client'),
    epoch,
    policy,
    scope: gate.scope(),
    ikX: id.ikX,
    // userRef = 확인 숫자/지문 파생 기준(서버가 준 문자열 — 폰과 **같은 값**이어야 두 화면 숫자가 같다).
    //  계정 모듈이 없으면 빈 문자열이고, 그때는 대조 UI 자체가 등장하지 않는다(pending 이 항상 비어 있다).
    userRef: typeof extra.userRef === 'string' ? extra.userRef : '',
    enrollmentId: extra.enrollmentId || null,
    recoverySet: !!(extra.recoverySet || recoverySetOf(e)),
    reason: extra.reason || (keyed ? null
      : '이 PC 는 아직 계정 열쇠를 받지 못했어요 — 그동안은 기존 방식(평문)으로 그대로 동작합니다.'),
  };
}

function recoverySetOf(e) {
  try { const st = e.loadState(); return !!(st && st.recoverySet); } catch (_) { return false; }
}

// ── 조회(계정 모듈이 정본) ────────────────────────────────────────────────
//  없으면 **빈 목록**을 준다(에러가 아니다) — 승인 시트/키링이 그냥 비어 보이는 것이 정직하고,
//  소켓 에러로 던지면 E2EE 카드 전체가 '미지원' 으로 뒤집힌다(규약 ①).
async function pending() {
  const fn = accountFn('pending');
  if (!fn) return { pending: [] };
  return (await fn()) || { pending: [] };
}
async function keyring() {
  const e = core();
  const fn = accountFn('keyring');
  if (!fn) return { epoch: e.epoch(), devices: [] };
  return (await fn()) || { epoch: e.epoch(), devices: [] };
}

// ── 승인/거절/해제(서버 업로드 필요) ─────────────────────────────────────
async function approve(a) {
  const fn = accountFn('approve');
  if (!fn) return NO_ACCOUNT;
  const enrollmentId = String((a && a.enrollmentId) || '').trim();
  const ikX = String((a && a.ikX) || '').trim();
  if (!enrollmentId || !ikX) return { ok: false, error: '승인 대상 정보가 부족합니다.' };
  return (await fn({ enrollmentId, ikX })) || { ok: true };
}
async function deny(a) {
  const fn = accountFn('deny');
  if (!fn) return NO_ACCOUNT;
  const enrollmentId = String((a && a.enrollmentId) || '').trim();
  if (!enrollmentId) return { ok: false, error: '거절 대상 정보가 부족합니다.' };
  return (await fn({ enrollmentId })) || { ok: true };
}
// 계정 최초 열쇠 생성 — **사용자가 화면에서 명시적으로 요청한 경우 전용**. 데몬이 자동으로 부르는
//  지점은 어디에도 없다(자동화하면 사람이 아무것도 대조하지 않은 신뢰 기점이 생기고, 폰만 든
//  사용자가 자기 폰을 승인해 줄 기기 없이 영구히 잠긴다 — e2ee-account.js 헤더의 판단).
async function bootstrap() {
  const fn = accountFn('bootstrap');
  if (!fn) return NO_ACCOUNT;
  return (await fn()) || { ok: false, error: '열쇠 생성에 실패했습니다.' };
}
async function revoke(a) {
  const fn = accountFn('revoke');
  if (!fn) return NO_ACCOUNT;
  const deviceKeyId = (a && a.deviceKeyId) != null ? a.deviceKeyId : null;
  if (deviceKeyId == null) return { ok: false, error: '해제 대상 기기를 알 수 없습니다.' };
  return (await fn({ deviceKeyId })) || { ok: false, error: '신뢰 해제에 실패했습니다.' };
}

// ── 정책(킬스위치) ────────────────────────────────────────────────────────
// 로컬 상태 파일이 정본이다(연결이 없어도 즉시 원복 가능해야 한다). 계정 모듈이 있으면 서버 동기화는
//  베스트에포트 — 실패해도 로컬 값은 유지한다(사용자가 끈 것을 서버 장애로 되살리면 안 된다).
async function setPolicy(a) {
  const e = core();
  const p = String((a && a.policy) || '');
  if (!POLICIES.includes(p)) return { ok: false, error: '알 수 없는 정책입니다.', policy: e.policy() };
  let policy;
  // 상태 파일을 쓸 수 없으면(손상·권한·디스크) 도메인 실패로 회신한다 — 여기서 던지면 그 조작만
  //  실패하는 게 아니라 PC 의 E2EE 카드 전체가 '미지원' 으로 뒤집힌다(규약 ①).
  try { policy = e.setPolicy(p); } catch (err) {
    return { ok: false, code: (err && err.code) || null, error: (err && err.message) || '정책을 저장할 수 없습니다.' };
  }
  // policy='off' 는 caps 를 회수하고(e2ee.caps() 가 [] 를 돌려준다) 봉투 처리도 닫는다 → back 의
  //  conn.caps·e2eeEpoch 를 **즉시** 갱신해야 다른 기기가 이 PC 로 봉인을 계속 보내지 않는다.
  //  다시 켤 때도 같은 이유로 재신고가 필요하다(연결 없이도 즉시 원복이라는 킬스위치 약속).
  const notify = accountFn('noteKeyChanged');
  if (notify) { try { notify(); } catch (_) { /* hello 재신고 실패는 다음 재접속에서 회복된다 */ } }
  const fn = accountFn('setPolicy');
  //  서버 동기화 실패는 로컬 값을 건드리지 않는다(무해) — 사유는 계정 모듈이 st.policySync 에 남겨
  //  다음 e2ee.state 의 reason 으로 사용자에게 보인다(조용한 실패 금지).
  if (fn) { try { await fn({ policy }); } catch (_) { /* 서버 동기화 실패는 무해 */ } }
  return { policy };
}

// ── 복구 코드 ─────────────────────────────────────────────────────────────
// 코드 자체가 열쇠다 — 1회 표시하고 저장하지 않는다. 서버에는 (계정 모듈이 있으면) 봉인문만 올린다.
async function recoveryCreate() {
  const e = core();
  if (!hasKey(e)) return { ok: false, error: '이 PC 에 아직 계정 열쇠가 없어 복구 코드를 만들 수 없어요.' };
  let code;
  try { code = e.recoveryCode(); } catch (err) { return { ok: false, error: (err && err.message) || '복구 코드 생성 실패' }; }
  // 다음 e2ee.state 조회에서 recoverySet 이 false 로 돌아가 화면이 깜빡이지 않게 상태 파일에 표시한다.
  try { const st = e.ensureIdentity(); st.recoverySet = true; e.saveState(st); } catch (_) { /* 표시 실패는 무해 */ }
  const fn = accountFn('setRecovery');
  if (fn) { try { await fn({ code }); } catch (_) { /* 서버 백업 실패는 무해(코드는 이미 사용자에게) */ } }
  return { code };
}
function recoveryRestore(a) {
  const e = core();
  const code = String((a && a.code) || '');
  if (!code) return { ok: false, error: '복구 코드를 입력하세요.' };
  try {
    const r = e.restoreFromRecoveryCode(code);
    // ★ 복원은 로컬 epoch 를 0→N 으로 올린다 = 열쇠 사실 변화. hello 재신고가 없으면 back 의
    //  conn.e2eeEpoch 가 다음 재접속까지 0 으로 남아 다른 기기 배지가 이 PC 를 계속 '평문(열쇠 없음)'
    //  으로 표시한다(결함 1의 반대 방향 거짓말). 계정 모듈의 같은 출구를 탄다.
    const notify = accountFn('noteKeyChanged');
    if (notify) { try { notify(); } catch (_) { /* 다음 재접속에서 회복된다 */ } }
    return { ok: true, epoch: r.epoch };
  } catch (err) {
    // 오타/버전 불일치 = 도메인 실패 → result 로(규약 ①).
    return { ok: false, error: (err && err.message) || '복구 코드가 올바르지 않습니다(오타 확인).' };
  }
}

// ── 알림 body 복호 ────────────────────────────────────────────────────────
// `{text, locked}` — 열쇠가 없거나 다른 epoch 면 locked:true + text:null(PC 가 🔒 자리표시자 유지).
function openText(a) {
  const e = core();
  const text = (a && a.text) != null ? String(a.text) : '';
  if (!e.isSealedNotifBody(text)) return { text, locked: false };
  try { return { text: e.openNotifBody(text), locked: false }; } catch (_) { return { text: null, locked: true }; }
}

// ── 봉투 RPC(뷰어 역할) ───────────────────────────────────────────────────
// PC UI 가 "이 요청을 봉인해서 다른 PC 로 보내 달라" 고 시키는 경로. 데몬이 봉인 → back 이 그대로 중계
//  → 상대 데몬이 열어 처리 → 응답 봉투를 그대로 회신 → 여기서 개봉. 서버는 메서드명조차 못 본다.
async function rpc(a) {
  const e = core();
  if (typeof e.sealRpc !== 'function' || typeof e.openRpcResult !== 'function') {
    throw Object.assign(new Error('이 데몬은 봉투 RPC 를 지원하지 않습니다'), { code: 'E2EE_UNSUPPORTED' });
  }
  if (!hasKey(e)) {
    // 열쇠가 없으면 봉인 자체가 불가능 = 평문 폴백 신호(throw). 도메인 실패로 주면 PC 가 IDE 에
    //  붉은 오류를 띄운다(sealedRpc 는 ok:false 를 throw 로 승격한다).
    throw Object.assign(new Error('이 PC 에 계정 열쇠가 없습니다'), { code: 'E2EE_NO_KEY' });
  }
  const method = String((a && a.method) || '');
  if (!method || method === 'sealed' || method.startsWith('e2ee.')) {
    throw Object.assign(new Error('봉투에 담을 수 없는 메서드입니다'), { code: 'E2EE_BAD_METHOD' });
  }
  // ★ AAD 규칙(§2.3): 명시된 hostDeviceId 를 그대로 쓰고, 미지정은 0(= 활성 러너 위임).
  //  같은 값을 **평문 형제 필드로** 본문에 실어야 상대 데몬이 같은 AAD 를 재구성할 수 있다.
  const host = (a && a.hostDeviceId != null && a.hostDeviceId !== '') ? Number(a.hostDeviceId) : null;
  const aadHost = host == null || !Number.isFinite(host) ? 0 : host;
  const timeoutMs = Math.min(Number((a && a.timeoutMs)) > 0 ? Number(a.timeoutMs) : RPC_TIMEOUT_DEFAULT_MS, RPC_TIMEOUT_MAX_MS);
  const epoch = e.epoch();
  const encOpts = { epoch, hostDeviceId: aadHost };
  const env = e.sealRpc(method, (a && a.params) || {}, encOpts);
  let res;
  try {
    res = await require('./cpt-server').backFetch('POST', '/api/daemon/rpc', {
      ...(host != null && Number.isFinite(host) ? { hostDeviceId: host } : {}),
      timeoutMs, env,
    });
  } catch (err) {
    // 404/501(구 back) · 409(오프라인) · 502 전부 "지금은 봉투를 못 쓴다" → 평문 폴백 신호(throw).
    throw Object.assign(new Error((err && err.message) || '봉투 RPC 중계 실패'), { code: 'E2EE_RELAY_FAILED' });
  }
  const body = (res && (res.data || res)) || {};
  if (!body.env) throw Object.assign(new Error('서버가 봉투 응답을 주지 않았습니다'), { code: 'E2EE_NO_ENVELOPE' });
  let out;
  try { out = e.openRpcResult(body.env, encOpts); } catch (err) {
    // 복호 실패(회전 직후·다른 epoch) = 폴백 허용 신호. 평문으로 뭉개지 않는다.
    throw Object.assign(new Error('응답을 복호할 수 없습니다(열쇠/epoch 불일치)'), { code: 'E2EE_DECRYPT_FAILED' });
  }
  if (out && out.ok) {
    // ⚠ 빈 결과에 null 을 주면 PC 가 폴백으로 오해해 같은 변형을 평문으로 재실행한다(규약 ②).
    return { ok: true, r: out.r === undefined || out.r === null ? {} : out.r };
  }
  return { ok: false, e: (out && out.e) || '요청이 실패했습니다', code: (out && out.code) || null };
}

/** 연동(개정 12) 위임 — 계정 모듈이 없으면 정직하게 미지원을 돌려준다(조용한 실패 금지). */
function linkCall(name, args) {
  const a = account();
  if (!a || typeof a[name] !== 'function') {
    return { ok: false, code: 'E2EE_UNSUPPORTED', error: '이 데몬은 기기 연동을 지원하지 않습니다(업데이트 필요).' };
  }
  return a[name](args);
}

/**
 * cpt.sock 디스패처 진입점 — `e2ee.` 로 시작하는 모든 커맨드.
 *  모르는 커맨드는 throw(= 이 데몬이 그 명령을 모른다는 정직한 신호).
 */
async function handle(cmd, args = {}) {
  switch (String(cmd)) {
    case 'e2ee.state': return state();
    case 'e2ee.pending': return pending();
    case 'e2ee.keyring': return keyring();
    case 'e2ee.approve': return approve(args);
    //  ★ 개정 12: 기기 연동(코드) — 승인 절차를 대체한다. 계정 모듈이 네트워크·암호를 다 한다.
    case 'e2ee.link.start': return linkCall('linkStart');
    case 'e2ee.link.active': return linkCall('linkActive');
    case 'e2ee.link.cancel': return linkCall('linkCancel');
    case 'e2ee.link.fulfill': return linkCall('linkFulfill', args);
    case 'e2ee.link.claim': return linkCall('linkClaim', args);
    case 'e2ee.deny': return deny(args);
    case 'e2ee.revoke': return revoke(args);
    case 'e2ee.bootstrap': return bootstrap();
    case 'e2ee.policy': return setPolicy(args);
    case 'e2ee.recovery.create': return recoveryCreate();
    case 'e2ee.recovery.restore': return recoveryRestore(args);
    case 'e2ee.openText': return openText(args);
    case 'e2ee.rpc': return rpc(args);
    default:
      throw Object.assign(new Error(`알 수 없는 e2ee 명령: ${cmd}`), { code: 'E2EE_UNKNOWN_CMD' });
  }
}

module.exports = { handle, state, pending, keyring, approve, deny, revoke, bootstrap, setPolicy, recoveryCreate, recoveryRestore, openText, rpc };
