// e2ee.js — 종단간 암호화(기능2) PC UI 측 상태/조작.
//
// ★ 사람이 눈으로 대조하는 값 = **60비트 안전 코드**(safetyCode, "K7M2-9QXF-B4TR"). 4자리는 요청
//   구분용 번호로만 쓴다 — 서버는 userId 와 상대 ikX 를 알고 있어 "같은 4자리가 나오는 자기 키쌍"을
//   1코어 1.3초에 찾는다(실측). 즉 4자리 대조는 MITM 을 못 막는다. 파생 정본은 계약 §2.10 이고
//   구현은 vendor/e2ee/e2ee-proto.js(= 앱 e2eeProto.js 동일 사본 · 데몬 fingerprint() · back
//   deviceTrustService 와 바이트 동일)이다. **서버가 준 안전 코드는 표시하지 않는다.**
//
// ★ 열쇠 custody 결정: **마스터키(MK)는 JS 로 내려오지 않는다.**
//   PC 앱과 사이드카 데몬은 같은 머신·같은 신뢰 도메인이고(설계 §2.3), 데몬은 이미
//   `~/.codingpt/e2ee.json`(0600) 의 소유자이며 node 내장 crypto 를 갖고 있다.
//   그래서 MK 가 필요한 연산(봉인/개봉/서명/봉투 RPC)은 전부 `cpt.sock` 로 데몬에 위임하고,
//   여기서는 **공개 입력 파생**(확인 숫자 4자리·지문 6자리·QR 핀)만 vendored 코어로 계산한다.
//   → Rust 에 암호 크레이트를 넣지 않아도 되고, deviceToken 처럼 비밀이 JS 에 노출되지 않는다.
//
// cpt.sock 계약(데몬 runner-core 가 구현 — `e2ee.` 접두사만 Rust 가 통과시킨다):
//   e2ee.state                        → { available, state, epoch, policy, scope, ikX, userRef,
//                                         enrollmentId, recoverySet, reason,
//                                         keyState, checking, nextCheckInMs, phase, accountEpoch }
//        ★ 진행상태 정본 = keyState(none|enrolled|pending|trusted) + checking. `state` 는 UI 도메인
//          6값(off|unsupported|bootstrap|pending|trusted|error)뿐이라 "확인 중" 과 "확인 끝났고
//          열쇠 0개(=영구 평문)" 를 구분하지 못한다 — 둘 다 'bootstrap' 이다. 판정은 e2ee-label.js.
//   e2ee.bootstrap                    → { ok:true, epoch } | { ok:false, error }
//        사람이 버튼을 눌렀을 때만. 데몬은 자동으로 부트스트랩하지 않는다(계정 신뢰 기점 = 사람의 몫).
//   e2ee.pending                      → { pending:[{enrollmentId,label,platform,ikX,requestedAt,
//                                          verifyCode(서버 계산 요청 번호 — 로컬 값과 대조만 한다.
//                                          안전 코드는 서버에서 받지 않고 ikX 로 직접 계산)}] }
//   e2ee.approve {enrollmentId, ikX}   → { ok:true }        (MK 봉인 + 서명 + 업로드)
//   e2ee.deny    {enrollmentId}        → { ok:true }
//   e2ee.policy  {policy}              → { policy }
//   e2ee.keyring                       → { epoch, devices:[{deviceKeyId,label,platform,ikX,state}] }
//   e2ee.revoke  {deviceKeyId}         → { epoch }           (신뢰 해제 + epoch 회전)
//   e2ee.recovery.create               → { code }            (1회 표시)
//   e2ee.recovery.restore {code}       → { ok:true, epoch }  (전 기기 소실 시 복원)
//   e2ee.openText {text}               → { text, locked }    (알림 body "cptenc:1:…" 복호)
//   e2ee.rpc {method, params, hostDeviceId, timeoutMs}
//                                      → { ok:true, r } | { ok:false, e, code }
//
// ★ 무마찰 불변식: 데몬이 구버전이라 위 명령을 모르면 **전부 조용히 미지원 상태로 떨어진다**.
//   워크스페이스·터미널·IDE·프리뷰·알림은 그대로 동작한다(평문). 여기서 throw 를 새어나가게 하지 않는다.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";
import { verifyCode4, fingerprint6, safetyCode, qrPin, isSealedBody } from "../vendor/e2ee/e2ee-proto.js";
import { b64uDec } from "../vendor/e2ee/e2ee-core.js";
import { selfStateLabel, needsBootstrap, canRestore } from "./e2ee-label.js";
import { classifyRpcFail, isDaemonUnsupported, mayFallback, rpcFailCode } from "./e2ee-fallback.js";
import { hostE2eeEpoch } from "./host-lock.js";

// UI 가 읽는 단일 상태(모바일 e2ee.ts getStatus() 와 같은 정보 구조).
export const e2ee = {
  available: false,       // 데몬이 e2ee 명령을 이해하는가
  // off | unsupported | bootstrap | pending | trusted | error | unavailable
  //  ★ 이건 **UI 도메인**이고 진행상태 정본이 아니다(데몬 pcState() 가 이 6값만 반환한다 —
  //    e2ee-account.js:531-539). "확인 중 vs 영구 평문" 은 아래 keyState/checking 으로 판정한다.
  //    확장값(none|enrolled)이 실려 오는 경우도 방어적으로 함께 본다(구/미래 데몬).
  state: "off",
  // ── 열쇠 취득 진행상태(데몬 e2ee-local.js state() 가 싣는 정본 필드 — 계약 §2.4) ──
  //  이 셋을 버리면 계정에 열쇠가 0개인 **영구 평문**과 "아직 확인 중" 이 같은 대기색이 된다.
  keyState: null,         // none | enrolled | pending | trusted  (null = 구 데몬이라 모른다)
  checking: false,        // 지금 확인 중인가(왕복 중이거나 재시도 예약됨)
  nextCheckInMs: null,    // 다음 확인까지 남은 ms(진단 표기)
  phase: null,            // 데몬 진단 phase(boot|bootstrap|pending|trusted|resolved|revoked|error|off|no_enroll_client)
  accountEpoch: null,     // 서버가 말하는 계정 epoch(null = 아직 모른다)
  epoch: 0,
  policy: "preferred",    // off | preferred | required
  scope: "rpc",
  ikX: null,              // 이 머신(데몬) 기기 공개키 b64u — 지문 계산 입력
  userRef: "",            // 확인 숫자 파생 기준(서버가 준 문자열 — 모바일과 동일 값이어야 한다)
  // ★ 사람이 실제로 대조하는 값 = 60비트 안전 코드("K7M2-9QXF-B4TR"). 항상 ikX 에서 로컬 계산이며
  //   서버가 준 문자열은 쓰지 않는다(서버 위조 차단이 이 UX 의 존재 이유다 — 계약 §2.10).
  safetyCode: null,
  verifyCode: null,       // 요청 구분용 4자리 — **대조값 아님**(서버가 1코어 1.3초에 같은 값을 만든다)
  fingerprint: null,      // 감사용 6자리(기기 목록 표기)
  recoverySet: false,
  autoBootError: null,    // 개정 4 자동 부트스트랩 최근 실패(성공/불필요 시 null) — 행동 행 문구용
  reason: null,
  pending: [],            // 승인 대기 중인 다른 기기들(확인 숫자는 로컬 계산)
  devices: [],            // 열쇠를 가진 기기(키링)
};

/**
 * 계정 세대(accountEpoch) **단조 래치**(2026-07-27 결함 — 한계 ③-2 의 근거가 죽어 있었다).
 *  ★ 왜 래치가 필요한가: PC 의 accountEpoch 유일한 원천이 데몬 `e2ee.state` 였고, 그 값은 데몬이
 *   keyring 을 폴링할 때만 갱신된다(e2ee-account.js callKeyring). 그런데 **같은 왕복이 acceptGrant 로
 *   로컬 epoch 도 올린다** → 두 값이 항상 같이 낡는다 = `accountEpoch === epoch` → host-lock.js 의
 *   계정 세대 대조(4번째 인자)가 **회전 직후 15분 창에서 절대 발화하지 않는다**(그 창을 위해 만든
 *   근거인데). 실측: 계정이 4로 회전한 직후 PC 가 읽는 accountEpoch=3 · epoch=3 → 자기 행은 초록.
 *   반대로 앱은 같은 순간 device_approval_event 의 epoch 를 즉시 반영해(e2ee.ts noteAccountEpoch)
 *   전 호스트 행이 '확인 중' 이 된다 → 같은 규칙·같은 실제 상태에서 폰과 PC 가 다른 색을 그렸다.
 *  그래서 **push 프레임의 epoch 를 refresh 완료 전에 먼저 반영**한다(앱과 같은 처방·같은 단조 규율).
 *  ⚠ 단조 증가만 받는다: 회전은 되돌아가지 않으므로 낡은 응답이 값을 되돌리면 배지가 깜빡인다.
 *  ⚠ **표시 전용**이다(host-lock.js 4번째 인자) — 이 값으로 봉인 여부를 게이팅하지 않는다.
 */
let accountEpochSeen = 0;
let accountEpochRef = ""; // 이 래치가 속한 계정(userRef) — 계정이 바뀌면 폐기한다
function noteAccountEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n <= accountEpochSeen) return false;
  accountEpochSeen = n;
  e2ee.accountEpoch = n;
  return true;
}
/**
 * 계정이 바뀌었으면 래치를 폐기한다(다음 계정 epoch 가 더 낮으면 배지가 '확인 중' 에 영구 고착된다 —
 *  resetHostLocks 와 같은 규율). 파생 기준을 **모를 때는 폐기하지 않는다**: ''(모름)로 판단하면
 *  부팅 직후 push 로 받아 둔 값을 첫 refresh 가 지운다.
 */
function noteAccountRef(ref) {
  const r = typeof ref === "string" ? ref : "";
  if (!r) return;
  if (accountEpochRef && r !== accountEpochRef) { accountEpochSeen = 0; e2ee.accountEpoch = null; }
  accountEpochRef = r;
}

function ready() { return e2ee.available && e2ee.state === "trusted" && e2ee.policy !== "off"; }
export function e2eeReady() { return ready(); }
/**
 * **승인할 수 있는** 대기 요청만 — 화면(설정 `기기` 섹션)은 이것만 그린다.
 *
 * ★ 2026-07-28 실사고: 폰이 "새 기기 승인 · Android" 카드를 보고 있었는데 그 요청은 **자기 자신의
 *  옛 enrollment** 였다(재설치·계정 전환으로 신원키가 갈라지면 같은 기기가 두 항목이 된다).
 *  누르면 서버가 403(NOT_TRUSTED: 승인은 이미 신뢰된 기기만)을 주므로 사용자는 "왜 승인이 안 되나"
 *  만 겪는다. 두 규칙으로 원천 차단한다:
 *   ① 내 ikX 와 같은 요청은 제외한다 — 자기 자신은 스스로를 승인할 수 없다.
 *   ② 이 기기에 계정 열쇠가 없으면(=ready 아님) **아무 요청도 그리지 않는다** — 승인 주체가 될 수
 *      없는 기기에 승인 UI 를 띄우면 그 화면의 모든 버튼이 무동작이다.
 *  서버(deviceTrustService.listPending)도 같은 두 규칙을 건다 — 어느 한쪽만으로도 막히게(이중 방어).
 */
export function e2eePendingApprovable() {
  if (!ready()) return [];
  const list = Array.isArray(e2ee.pending) ? e2ee.pending : [];
  return e2ee.ikX ? list.filter((p) => p && p.ikX !== e2ee.ikX) : list;
}
/**
 * 설정 화면 한 줄 라벨 — 판정은 e2ee-label.js 가 정본(테스트가 같은 함수를 본다).
 *  '확인 중'(대기색)과 '열쇠 없음'(꺼짐색)이 **다른 화면**이어야 한다: 전자는 곧 바뀌고 후자는
 *  사람이 켜기 전까지 영구 평문이다.
 */
export function e2eeStateLabel() { return selfStateLabel(e2ee, ready()); }
/** 이 PC 에 '계정 암호화 처음 켜기' 버튼을 노출할지(데몬은 자동 부트스트랩을 하지 않는다). */
export function e2eeNeedsBootstrap() { return needsBootstrap(e2ee); }
/** '복구 코드로 복원' 행을 노출할지 — 판정은 e2ee-label.js(앱 canRestore 와 동치, 테스트가 대조한다). */
export function e2eeCanRestore() { return canRestore(e2ee, ready()); }
/**
 * ui_hello 에 실을 caps — 실제로 그 단계를 수행할 수 있을 때만 신고(config/caps.js 규약).
 *  ★ 단계별로 쪼갠 문자열을 쓴다(서버 SERVER_CAPS 와 동일 이름): 'e2ee.v1' 처럼 뭉치면 아직 배관이
 *    없는 단계(스트림 등)를 켜서 프레임이 조용히 유실된다.
 */
export function e2eeCaps() {
  if (!ready()) return [];
  const caps = ["e2ee.keys.v1"];
  if (e2ee.scope !== "off") caps.push("e2ee.rpc.v1");
  if (e2ee.scope === "stream") caps.push("e2ee.stream.v1");
  return caps;
}
/** 정책이 'required' 인가 — LAN 직결(평문 leg)을 막는 근거. lan.js 가 순환 없이 조회한다. */
export function policyRequired() { return e2ee.policy === "required"; }

/** policy='required' 인데 준비가 안 됐다 = 암호화가 필요한 조작을 막고 사유를 보여준다. */
export function e2eeGate() {
  if (e2ee.policy !== "required" || ready()) return null;
  // keyState 가 진행상태 정본이다. 'enrolled' = 승인은 끝났고 봉인문(열쇠) 전달 대기.
  //  (state 확장값 none|enrolled 도 방어적으로 함께 본다 — 구/미래 데몬)
  if (e2ee.keyState === "pending" || e2ee.keyState === "enrolled"
    || e2ee.state === "pending" || e2ee.state === "enrolled") return "승인 대기 중 — 기존 기기에서 이 PC 를 승인해 주세요.";
  if (!e2ee.available || e2ee.state === "unsupported") return "이 PC 데몬이 아직 종단간 암호화를 지원하지 않아요(업데이트 필요).";
  // ★ 확인이 끝났는데 열쇠가 없다 = 저절로 풀리지 않는다. "준비하는 중" 이라고 말하면 사용자는
  //   기다리기만 하고 required 정책 아래에서 조작이 영구히 막힌다(무엇을 해야 하는지 알려야 한다).
  if (e2ee.keyState === "none" && !e2ee.checking) {
    return e2ee.phase === "bootstrap"
      ? "이 계정에 아직 암호화 열쇠가 없어요 — 설정 → 종단간 암호화 에서 '이 계정에 암호화 처음 켜기' 를 눌러 주세요."
      : "이 PC 에 아직 열쇠가 없어요(열쇠 확인을 기다리는 중이에요).";
  }
  return "종단간 암호화를 준비하는 중이에요.";
}

/**
 * cpt.sock 왕복 + 실패 코드 반환. `{ r, code }` — r=null 이면 실패이고 code 는 데몬이 실은 코드다
 *  (Rust cptsock.rs e2ee_local 이 `<CODE>: 메시지` 로 실어 준다. "" = 코드 없는 실패 = IPC 단절 등).
 *  ⚠ 코드를 모듈 변수에 담아 두지 않는다 — 봉인 호출은 동시에 여러 개 날아가므로(IDE 트리 + 자동저장)
 *   "마지막 실패 코드" 전역은 다른 호출의 코드를 읽는 레이스가 된다. 호출부가 **자기 반환값**을 본다.
 */
async function cptCoded(cmd, args) {
  try {
    const r = await api.e2eeLocal(cmd, args || {});
    return { r: r || null, code: "" };
  } catch (e) {
    // 데몬 미기동/구버전/명령 미지원 — 미지원 상태로 내려놓고 조용히 진행(평문 폴백).
    //  ★ 단, **모든** 실패를 미지원으로 보면 안 된다: 봉투 하나가 세대 불일치(409)로 실패한 것만으로
    //   available=false 가 되면 설정 배지가 '미지원' 으로 바뀌고 e2eeCaps() 가 빈 배열이 되어 다음
    //   hello 에서 이 PC 가 **스스로 능력을 취소**한다(조용한 평문). 판정은 e2ee-fallback.js 정본.
    const code = rpcFailCode(e);
    if (e2ee.available && isDaemonUnsupported(code)) { e2ee.available = false; e2ee.state = "unsupported"; }
    return { r: null, code };
  }
}
async function cpt(cmd, args) { return (await cptCoded(cmd, args)).r; }

/**
 * 표시값 파생 기준(계정 참조) — 데몬이 서버에서 받아 파일로 영속하는 문자열이 **유일한 정본**이다.
 *  ★ 모르면 `null` 을 돌려주고, 호출부는 **아무 값도 만들지 않는다.** 여기서 ''(빈 문자열)로 파생하면
 *   화면에 "그럴듯하지만 틀린" 안전코드가 아무 경고 없이 뜬다 — 폰과 절대 같아지지 않으므로 사용자는
 *   정당한 승인을 거절하거나(치명적 UX 실패) 경고를 무시하도록 학습한다. 어느 쪽이든 **사람이 두 화면을
 *   대조한다는 유일한 MITM 방어가 통째로 무효**가 된다(계약 §2.11-9 — 데몬도 같은 규율을 지킨다).
 *  데몬은 userRef 를 모를 때 ''(빈 문자열)을 보낸다(e2ee-local.js:143) → 그 상태를 그대로 '모름' 으로 읽는다.
 *  ⚠ 이 PC 가 자기 계정 id 로 대체 파생하지 않는다: 폰이 쓰는 기준(서버 userRef)과 다르면 두 화면이
 *   어긋나고, 그 어긋남이 "서버 위조" 와 구분되지 않는다. 모를 때는 모른다고 표시하는 것이 정직하다.
 */
function fpRef() { return e2ee.userRef ? e2ee.userRef : null; }

function deriveDisplay() {
  const ref = fpRef();
  try {
    if (e2ee.ikX && ref) {
      const pub = b64uDec(e2ee.ikX);
      // 안전 코드는 pending 여부와 무관하게 항상 계산한다 — 설정의 "이 PC 안전 코드"(폰 화면과 대조)와
      //  승인 대기 화면이 같은 값을 쓴다(모바일 getStatus().safetyCode 미러).
      e2ee.safetyCode = safetyCode(pub, ref);
      e2ee.fingerprint = fingerprint6(pub, ref);
      // 요청번호는 "이 PC 가 승인을 기다리는 중" 일 때만 표시한다 — 판정은 keyState 가 정본.
      const waiting = e2ee.keyState === "pending" || e2ee.keyState === "enrolled"
        || e2ee.state === "pending" || e2ee.state === "enrolled";
      e2ee.verifyCode = waiting ? verifyCode4(pub, ref) : null;
    } else {
      // ikX 가 없거나(신원키 미생성) 파생 기준을 모른다 → 대조 UI 는 '—' 를 그린다(settings.js).
      e2ee.safetyCode = null;
      e2ee.fingerprint = null;
      e2ee.verifyCode = null;
    }
  } catch (_) { e2ee.safetyCode = null; e2ee.fingerprint = null; e2ee.verifyCode = null; }
  // 대기 목록:
  //  · safetyCode(대조 대상) = **항상 로컬 계산**. 서버가 이 값을 보내와도 쓰지 않는다.
  //  · verifyCode(요청 번호)만 서버 값과 비교한다 — 파생 기준(userRef)이 어긋나 서버 값과 다르면
  //    서버 값을 표기한다(폰과 PC 의 요청 번호가 달라 보이면 사용자가 어느 요청인지 못 고른다).
  //    대신 verified=false 로 표시해 "이 번호는 검증 불가, 대조는 안전 코드로" 를 UI 가 알린다.
  e2ee.pending = e2ee.pending.map((p) => {
    const server = typeof p.serverVerifyCode === "string" ? p.serverVerifyCode
      : (typeof p.verifyCodeFromServer === "string" ? p.verifyCodeFromServer
        : (typeof p.verifyCode === "string" ? p.verifyCode : null));
    // 파생 기준을 모르면 로컬 계산이 **전부 틀린 값**이다 → 대조 대상(안전코드/지문)은 비우고,
    //  요청번호는 서버 값만 구분용으로 남긴다. verified=false 가 UI 의 "대조 금지" 문구를 켠다.
    if (!ref) return { ...p, verifyCode: server, verified: false, safetyCode: null, fingerprint: null };
    try {
      const pub = b64uDec(p.ikX);
      const local = verifyCode4(pub, ref);
      const use = server && server !== local ? server : local;
      return {
        ...p, verifyCode: use, verified: !server || server === local,
        safetyCode: safetyCode(pub, ref), fingerprint: fingerprint6(pub, ref),
      };
    } catch (_) { return { ...p, verifyCode: "----", verified: false, safetyCode: "", fingerprint: "" }; }
  });
  e2ee.devices = e2ee.devices.map((d) => {
    if (!ref) return { ...d, fingerprint: null }; // 기기 목록 지문도 같은 규율(틀린 값 대신 '—')
    try { return { ...d, fingerprint: fingerprint6(b64uDec(d.ikX), ref) }; } catch (_) { return { ...d, fingerprint: "" }; }
  });
}

/** 상태 갱신(부팅·설정 진입·WS 이벤트·주기). 실패해도 조용히 미지원 처리. */
export async function refreshE2ee() {
  const st = await cpt("e2ee.state");
  if (!st) { deriveDisplay(); S.emit(); return; }
  e2ee.available = st.available !== false;
  e2ee.state = String(st.state || "off");
  // 진행상태(정본) — 없으면 null 로 둔다. 구 데몬을 '열쇠 없음' 으로 단정하지 않기 위함이다.
  e2ee.keyState = typeof st.keyState === "string" ? st.keyState : null;
  e2ee.checking = st.checking === true;
  e2ee.nextCheckInMs = st.nextCheckInMs != null ? Number(st.nextCheckInMs) : null;
  e2ee.phase = typeof st.phase === "string" ? st.phase : null;
  // ★ 순서 불변식: userRef(계정 식별)를 accountEpoch 보다 **먼저** 읽는다 — 계정 전환 판정이 래치보다
  //  늦으면 옛 계정의 세대가 새 계정 배지에 남는다(다음 줄의 noteAccountEpoch 가 그 래치를 쓴다).
  e2ee.userRef = typeof st.userRef === "string" ? st.userRef : "";
  noteAccountRef(e2ee.userRef);
  // 데몬이 말하는 계정 세대는 **폴링 시점의 사진**이라 push 로 이미 받아 둔 값보다 낡을 수 있다 →
  //  단조 래치로만 반영한다(되돌리면 배지가 초록↔확인중으로 깜빡인다).
  noteAccountEpoch(st.accountEpoch);
  const prevEpoch = e2ee.epoch;
  e2ee.epoch = Number(st.epoch || 0);
  // 새 세대 열쇠를 채택했다(데몬이 grant 를 받았다) = 봉투 계층의 상황이 바뀌었다 → 네거티브 캐시를
  //  즉시 만료시킨다. 남겨두면 회전 직후의 실패로 걸린 10분 동안 갱신을 끝냈는데도 봉인을 시도하지
  //  않아 전부 평문이면서 배지는 초록이다(계약 §2.7 자가복구 ③ 뒷문장 — 앱 adoptGrant 와 같은 처방).
  if (e2ee.epoch > prevEpoch) clearRpcUnsupported();
  if (st.policy) e2ee.policy = String(st.policy);
  if (st.scope) e2ee.scope = String(st.scope);
  e2ee.ikX = st.ikX || null;
  e2ee.recoverySet = !!st.recoverySet;
  e2ee.reason = st.reason || null;
  const pend = await cpt("e2ee.pending");
  e2ee.pending = pend && Array.isArray(pend.pending) ? pend.pending : [];
  const kr = await cpt("e2ee.keyring");
  e2ee.devices = kr && Array.isArray(kr.devices) ? kr.devices : [];
  deriveDisplay();
  S.emit();
  // ★ 개정 4(카피 감사 §3) — 상태가 확정된 이 시점에 자동화 2종을 건다(둘 다 멱등·스로틀).
  void normalizeE2eePolicy();
  void maybeAutoBootstrap();
}

// ── 개정 4 자동화 ────────────────────────────────────────────────────
// ① 정책 '자동' 고정 — 정책 UI 는 삭제됐다(사용자 확정). 구 UI 로 '끄기/항상' 을 저장해 둔 기기는
//    되돌릴 수단이 없어지므로 여기서 1회 복원한다(env 킬스위치 CPT_E2EE=0 은 데몬 쪽 판정이라 무관).
let policyNormalized = false;
async function normalizeE2eePolicy() {
  if (policyNormalized || !e2ee.available) return;
  if (!e2ee.policy || e2ee.policy === "preferred") { policyNormalized = true; return; }
  policyNormalized = true; // 실패해도 재시도 폭주 금지 — 다음 앱 실행이 다시 시도한다
  try { await setPolicy("preferred"); } catch (_) { /* noop */ }
}
// ② 자동 부트스트랩 — 계정 열쇠 0개가 **확정**되면(needsBootstrap = keyState 기반) 이 화면이 켠다.
//    "데몬(헤드리스) 자동 부트스트랩 금지" 원칙은 유지된다: 주체가 사람이 보고 있는 앱 표면이라
//    모바일 앱의 기존 자동 부트스트랩과 같은 등급이다. 동시 시도(폰+PC)는 서버 409 가 중재하고
//    진 쪽은 자동으로 enroll 대기가 된다(e2ee-account.js 헤더).
//    ⚠ 스로틀 60s: 실패를 즉시 재시도하면 refresh 주기(60s)와 겹쳐 폭주한다. 성공 시 refreshE2ee 가
//    상태를 갱신하므로 다음 진입에서 needsBootstrap 이 꺼져 자연 종료된다.
let autoBootAt = 0;
async function maybeAutoBootstrap() {
  if (!state.paired || !e2ee.available) return;
  // 최초 계정뿐 아니라 완전 재설치 후 로컬 키가 없는 host도 자동으로 새 신뢰 기점을 준비한다.
  // pending/enrolled 상태를 제외하면 과거 키링 행 때문에 양쪽 새 기기가 서로를 기다린다.
  const missingHostKey = !ready()
    && !e2ee.checking
    && ["none", "pending", "enrolled"].includes(String(e2ee.keyState || e2ee.state));
  if (!needsBootstrap(e2ee) && !missingHostKey) { e2ee.autoBootError = null; return; }
  const now = Date.now();
  if (now - autoBootAt < 60000) return;
  autoBootAt = now;
  const r = await bootstrapAccount();
  e2ee.autoBootError = r && r.ok ? null : (r && r.error) || "bootstrap_failed";
  S.emit();
}

/** device_approval_event(WS) 반영 — push 는 즉시성 힌트, pull(refreshE2ee)이 정본. */
export function applyDeviceApprovalEvent(ev) {
  if (!ev) return;
  //  ★ 개정 12: 다른 기기가 이 PC 의 연동 코드를 맞혔다 → 데몬이 **자동으로** 봉인문을 올린다.
  if (ev.kind === "link_claim") {
    void (async () => {
      try { await cpt("e2ee.link.fulfill", { linkId: ev.linkId, ikX: ev.ikX }); } catch (_) { /* 코드 만료 시 재발급 */ }
      await refreshE2ee();
    })();
    return;
  }
  if (ev.kind === "link_done") { void refreshE2ee(); return; }
  if (ev.kind === "request") {
    if (ev.enrollmentId && ev.ikX) {
      const i = e2ee.pending.findIndex((p) => p.enrollmentId === ev.enrollmentId);
      // verifyCode(요청 번호)는 서버가 실어 보내면 그대로 받아 두고 deriveDisplay 가 로컬 값과 대조한다.
      //  안전 코드는 여기서 만들지 않는다 — ikX 에서 로컬 계산이 원칙이다(deriveDisplay).
      const row = {
        enrollmentId: ev.enrollmentId, label: ev.label || "새 기기", platform: ev.platform || null,
        ikX: ev.ikX, verifyCode: typeof ev.verifyCode === "string" ? ev.verifyCode : undefined,
        requestedAt: ev.requestedAt || new Date().toISOString(),
        //  ★ 개정 9(2026-07-28): 신청 기기의 기기 행 id — 설정의 기기 목록이 이 값으로 대기 건을 행에
        //   묶어 그 행에 '승인 대기' 를 붙인다(요약 줄은 사용자 요구로 삭제). 구 서버엔 없다 → null.
        deviceId: Number.isInteger(Number(ev.deviceId)) && Number(ev.deviceId) > 0 ? Number(ev.deviceId) : null,
      };
      if (i >= 0) e2ee.pending[i] = row; else e2ee.pending.push(row);
      deriveDisplay();
      S.emit();
    }
    void refreshE2ee();
  } else if (ev.kind === "resolved") {
    // 다른 기기가 먼저 처리 → 카드 즉시 회수(크로스기기 dismiss 와 같은 타이밍).
    e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== ev.enrollmentId);
    S.emit();
    void refreshE2ee();
  } else if (ev.kind === "nudge") {
    //  사용자가 다른 기기에서 [연동] 을 눌렀다 → 이 PC 가 대상이면 지금 재확인한다(데몬 백오프 무시).
    //   deviceId 가 없으면 계정 전체 대상이므로 그대로 재확인한다(무해 — 왕복 1회).
    void refreshE2ee();
  } else if (ev.kind === "rotated" || ev.kind === "policy" || ev.kind === "bootstrapped") {
    // 계정 세대/정책이 바뀌었다(다른 기기에서 회전·신뢰 해제·정책 변경·처음 켜기) → 즉시 재확인.
    //  ★ 이게 없으면 폰에서 회전해도 이 화면은 최대 60초(startE2ee 폴링 주기)간 **낡은 자물쇠**를
    //   그린다. 그 사이 이 PC 는 옛 세대로 계속 봉인해 E2EE_EPOCH_MISMATCH(409)를 맞고 평문으로
    //   내려가는데 배지는 초록이다 = 거짓 자물쇠(계약 §2.7 자가복구 ①, 앱 e2ee.ts 와 동일 처방).
    //  back 은 이 3종을 **이미** 팬아웃한다(deviceTrustService.js:504/696/722) — 새 배관 0개.
    //  ⚠ 억제창을 두지 않는다: push 는 드물고 정본이다(억제는 409 재시도 경로의 몫).
    //  ★ 프레임이 실어 주는 계정 세대를 **refresh 완료 전에** 먼저 반영한다(앱 e2ee.ts:1046 미러).
    //   이게 없으면 accountEpoch 의 유일한 원천이 데몬 폴링이고, 그 폴링은 로컬 epoch 도 같이 올리므로
    //   두 값이 항상 같이 낡아 계정 세대 대조가 **회전 직후 15분 창에서 한 번도 발화하지 않는다**
    //   (= 자기 행이 그 창 내내 초록 = 거짓 자물쇠. 폰은 같은 순간 '확인 중' 이라 화면끼리도 어긋난다).
    if (noteAccountEpoch(ev.epoch)) S.emit();
    void refreshE2ee();
  }
}

/**
 * 연동 요청 다시 보내기 — 기기 목록의 [연동] 버튼(2026-07-28 사용자 요구).
 *  · 이 PC 가 대기 중이면 → 신뢰 기기들에 승인 요청을 **다시 알린다**(알림을 놓쳤을 때의 정상 경로).
 *  · 상대 기기에 열쇠가 없으면 → 그 기기가 즉시 재신청하도록 서버가 nudge 를 팬아웃한다.
 *  판단은 서버(deviceTrustService.nudge)가 한다 — 클라가 방향을 정하면 두 화면의 규칙이 갈라진다.
 *  ⚠ 데몬 RPC 가 아니라 back REST 를 직접 부른다(cpt.sock 에 이 명령이 없다 · back_api 는
 *   `/api/daemon/*` 를 그대로 통과시킨다 = 새 배관 0개, 승인 인박스와 같은 선례).
 */
// ── 기기 연동(코드) — ★ 개정 12. 승인 절차 대신 코드가 채널이다(데몬이 암호·네트워크를 다 한다). ──
/** 이 PC 가 연동 코드를 띄운다(열쇠 보유 PC 만). */
export async function linkStart() {
  const r = await cpt("e2ee.link.start");
  return r && r.ok ? { ok: true, code: r.code, ttlMs: r.ttlMs } : { ok: false, error: (r && r.error) || "연동 코드를 만들지 못했어요" };
}
export async function linkActive() {
  const r = await cpt("e2ee.link.active");
  return (r && r.active) || null;
}
export async function linkCancel() { try { await cpt("e2ee.link.cancel"); } catch (_) { /* noop */ } }
/** 다른 기기의 코드를 입력해 이 PC 를 연동한다. */
export async function linkClaim(code) {
  const r = await cpt("e2ee.link.claim", { code });
  if (r && r.ok) { await refreshE2ee(); return { ok: true }; }
  return { ok: false, error: (r && r.error) || "연동에 실패했어요" };
}

export async function nudgeDevice(deviceId) {
  try {
    const r = await api.backApi("POST", "/api/daemon/e2ee/nudge",
      { ikX: e2ee.ikX || undefined, deviceId: deviceId ?? undefined }, 12);
    const sent = r && (r.data ? r.data.sent : r.sent);
    return { ok: true, sent: sent || "nudge" };
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    // 쿨다운(429)은 실패가 아니다 — 방금 보낸 요청이 유효하다는 뜻이므로 그렇게 말한다.
    if (/NUDGE_COOLDOWN|429/.test(msg)) return { ok: true, sent: "cooldown" };
    // 실패 문구는 앱과 글자까지 같아야 한다(카피표 err.link — 두 화면을 나란히 보는 사용자 규율).
    return { ok: false, error: "연동 요청을 보내지 못했어요" };
  }
}

export async function approveDevice(enrollmentId) {
  const row = e2ee.pending.find((p) => p.enrollmentId === enrollmentId);
  if (!row) return { ok: false, error: "요청을 찾을 수 없어요." };
  const r = await cpt("e2ee.approve", { enrollmentId, ikX: row.ikX });
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "승인을 전달하지 못했어요." };
  e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== enrollmentId);
  S.emit();
  void refreshE2ee();
  return { ok: true };
}
export async function denyDevice(enrollmentId) {
  const r = await cpt("e2ee.deny", { enrollmentId });
  e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== enrollmentId);
  S.emit();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "거절을 전달하지 못했어요." };
  return { ok: true };
}
export async function setPolicy(policy) {
  e2ee.policy = policy; // 낙관적(토글 즉시 반영 = 킬스위치 체감)
  S.emit();
  await cpt("e2ee.policy", { policy });
  await refreshE2ee();
}
/**
 * 계정 최초 열쇠 생성(부트스트랩) — **사용자가 버튼을 눌렀을 때만**.
 *  데몬은 이 경로를 자동으로 타지 않는다(헤드리스가 신뢰 기점을 세우면 아무것도 대조하지 않은 승인
 *  사슬이 생기고, 폰만 든 사용자가 자기 폰을 승인해 줄 기기 없이 잠긴다 — 데몬 e2ee-account.js 헤더).
 *  그래서 PC 에 사람이 누를 자리가 필요하다: 이 버튼이 없으면 `phase='bootstrap'`(계정 열쇠 0개)에서
 *  사용자는 화면을 보고도 스스로 벗어날 수 없다.
 */
export async function bootstrapAccount() {
  const r = await cpt("e2ee.bootstrap");
  await refreshE2ee();
  if (!r || r.ok === false) return { ok: false, error: (r && (r.error || r.e)) || "열쇠를 만들지 못했어요(잠시 후 다시 시도해 주세요)." };
  return { ok: true, epoch: Number(r.epoch || 0) };
}
export async function createRecoveryCode() {
  const r = await cpt("e2ee.recovery.create");
  if (!r || !r.code) return null;
  e2ee.recoverySet = true;
  S.emit();
  return String(r.code);
}
/** 복구 코드로 복원(모든 신뢰 기기 소실) — 코드 자체가 열쇠를 담으므로 데몬이 파싱·저장한다. */
export async function restoreFromRecovery(code) {
  const r = await cpt("e2ee.recovery.restore", { code: String(code || "") });
  await refreshE2ee();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "복구 코드가 올바르지 않아요(오타 확인)." };
  return { ok: true };
}
export async function revokeTrust(deviceKeyId) {
  const r = await cpt("e2ee.revoke", { deviceKeyId });
  await refreshE2ee();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "신뢰 해제에 실패했어요." };
  return { ok: true };
}

/**
 * 봉투 RPC — 데몬이 봉인해 back 에 보낸다(서버는 메서드명조차 못 본다).
 * @returns 결과 객체 | null(봉투가 왕복하지 못했다 → 호출부가 기존 평문 경로로 폴백) | throws
 *  ⚠ 실패를 빈 결과로 뭉개지 않는다 — 리컨실러가 "0개"로 오판해 레이아웃을 지운 사고가 있었다.
 *  폴백 표(계약 §2.7)의 두 행을 여기서 가른다:
 *   · 봉투 계층 실패(데몬 throw = cpt() null) → **폴백 허용**. 막으면 IDE 트리·파일 열기·800ms
 *     자동저장이 붉은 오류로 죽는다(= 자기 기기에서 잠긴다).
 *   · 200 + ok:false(호스트가 **이미 실행**했고 그 처리가 실패) → **폴백 금지** = throw. 폴백하면
 *     같은 변형(fs.write)을 평문으로 한 번 더 실행한다(이중 실행).
 *   · policy='required' → 두 경우 다 금지(throw) — 다운그레이드 공격 차단.
 */
//  ★ 네거티브 캐시: 데몬/서버에 봉투 배관이 없는 동안 **fs 호출마다 소켓 왕복이 한 번 더** 붙으면
//    IDE 트리/파일 열기가 전부 느려진다. 한 번 미지원을 보면 TTL 동안 곧바로 평문 경로로 간다.
const RPC_UNSUPPORTED_TTL_MS = 10 * 60 * 1000;
let rpcUnsupportedUntil = 0;
function noteRpcUnsupported() { rpcUnsupportedUntil = Date.now() + RPC_UNSUPPORTED_TTL_MS; }
/** 상태가 실제로 바뀌었을 때(새 세대 열쇠 채택) 캐시 만료 — 다음 호출이 곧바로 봉인을 재시도한다. */
function clearRpcUnsupported() { rpcUnsupportedUntil = 0; epochRetryUntil.clear(); }
/**
 * 지금 봉투 RPC 를 시도해 볼 가치가 있는가(테스트·진단용 — 앱 rpcAvailable() 미러).
 *  @param {number|null} [hostDeviceId] 넘기면 그 호스트의 세대 억제 게이트까지 본다(호스트별).
 *   ⚠ `undefined`(인자 없음) = 전역 게이트만. `null` 은 "호스트 미지정 = self" 라는 **유효한 키**다.
 */
export function rpcAvailable(hostDeviceId) {
  if (!ready() || Date.now() < rpcUnsupportedUntil) return false;
  return !(hostDeviceId !== undefined && epochGated(hostDeviceId));
}

// 세대 불일치 자가복구(계약 §2.7 자가복구 ②) — back 이 이 실패를 "상태가 바뀌면 즉시 낫는다" 로
//  정의했는데 그 '상태 갱신' 을 수행하는 주체가 PC 에는 없었다: 실패를 전부 미지원으로 캐시해 10분간
//  평문으로 내려가면서 배지는 초록을 유지했다(거짓 자물쇠).
//  ⚠ 억제 창이 필요하다 — IDE 트리·파일 열기·800ms 자동저장이 초당 여러 번 봉인하므로 실패마다
//    데몬 왕복(state+pending+keyring 3회)을 부르면 폭주가 된다. 창 안에서는 1회만 발사하고,
//    갱신 결과는 다음 시도가 쓴다(앱 EPOCH_REFRESH_GAP_MS 와 같은 20초).
const EPOCH_REFRESH_GAP_MS = 20 * 1000;
let epochRefreshAt = 0;
function refreshForEpochMismatch() {
  const now = Date.now();
  if (now - epochRefreshAt < EPOCH_REFRESH_GAP_MS) return;
  epochRefreshAt = now;
  void refreshE2ee();
}
// ★ '캐시 금지' 는 **상한 없음**이 아니다(2026-07-27 결함). 'epoch' 분류는 10분 네거티브 캐시를
//  일부러 건너뛰는데, 그 결과 유일한 브레이크가 사라져 **종료 조건 없는 왕복 폭주**가 됐다:
//   · 현 설치본(회전 push 미지원 데몬)은 회전을 최대 15분 뒤에야 폴링으로 본다 = 그 15분 내내 실패.
//   · 호출 빈도는 IDE 트리 + 800ms 자동저장 + 2.5s 디스크 리컨실러라 초당 수 회.
//   · 위 refreshForEpochMismatch 의 20s 억제창은 **로컬 refresh 만** 막고 봉투 재시도는 못 막는다.
//   · 왕복 1회 = cpt.sock → 데몬 → HTTPS POST /api/daemon/rpc(레이트리밋 없음) → 호스트 WS → 409.
//  그래서 refresh 억제창과 **같은 20초** 동안 그 호스트로의 봉투 재시도 자체를 멈춘다(이전 동작은
//  첫 실패 후 10분 침묵이었으니 20초는 그보다 훨씬 공격적인 재시도다 = 자가복구를 늦추지 않는다).
//  ⚠ 호스트별이다: 원인이 hostEpoch 뒤처짐이면 다른 PC 는 정상이므로 함께 멈추면 안 된다.
//  ⚠ 세대가 실제로 올라가면(clearRpcUnsupported) 즉시 만료 — 20초를 기다리지 않는다.
const epochRetryUntil = new Map(); // hostKey → ts
const hostKey = (h) => (h == null ? "self" : String(Number(h)));
function noteEpochRetryGate(h) { epochRetryUntil.set(hostKey(h), Date.now() + EPOCH_REFRESH_GAP_MS); }
function epochGated(h) {
  const t = epochRetryUntil.get(hostKey(h));
  if (t == null) return false;
  if (Date.now() >= t) { epochRetryUntil.delete(hostKey(h)); return false; }
  return true;
}

/**
 * 평문 폴백을 **막아야 할 때** 던질 오류(policy='required' = 다운그레이드 공격 차단).
 *  ★ e2eeGate() 만으로는 부족하다: gate 는 "준비가 안 됐다" 만 본다. 열쇠가 있고(ready) 정책이
 *   'required' 인데 봉투 계층이 실패한 경우 gate 는 null 을 주므로, 그 자리에서 null 을 돌려주면
 *   호출부가 **평문 REST 로 폴백**한다 = 사용자가 "지원 안 하면 조작 차단" 을 골랐는데 조용히 평문.
 *   판정 정본은 e2ee-fallback.js mayFallback(policy, hostExecuted)(계약 §2.7 표).
 */
function noFallbackError() {
  return new Error(e2eeGate()
    || "종단간 암호화가 '항상' 으로 설정돼 있어 평문으로 보낼 수 없어요(암호화가 준비되면 자동으로 됩니다).");
}

export async function sealedRpc(method, params, hostDeviceId, timeoutMs) {
  // 게이트 3종: 열쇠 없음 · 미지원 네거티브 캐시(10분) · 세대 억제(그 호스트 20초).
  //  세 경우 다 **required 에서는 평문으로 내려가지 않는다**(throw) — 게이트가 정책의 구멍이 되면 안 된다.
  if (!ready() || Date.now() < rpcUnsupportedUntil || epochGated(hostDeviceId)) {
    if (!mayFallback(e2ee.policy, false)) throw noFallbackError(); // required 에서는 평문 폴백 금지
    return null;
  }
  const { r, code } = await cptCoded("e2ee.rpc", { method, params: params || {}, hostDeviceId: hostDeviceId ?? null, timeoutMs: timeoutMs || 15000 });
  if (!r) {
    // 봉투 계층 실패 = 봉투가 왕복하지 못했다. 두 갈래로 처방이 갈린다(계약 §2.7, e2ee-fallback.js 정본):
    //  · 'epoch'       → 열쇠 상태를 다시 받아 오면 낫는다 → refresh 1회(20s 억제) + **10분 캐시 금지**
    //                     대신 그 호스트로만 20초 재시도 게이트(캐시 금지 ≠ 상한 없음 — 위 주석)
    //  · 'unsupported' → 구조적 미지원 → 10분 캐시(왕복 절감)
    const kind = classifyRpcFail({
      code, myEpoch: e2ee.epoch,
      accountEpoch: e2ee.accountEpoch, hostEpoch: hostE2eeEpoch(hostDeviceId),
    });
    if (kind === "epoch") { refreshForEpochMismatch(); noteEpochRetryGate(hostDeviceId); }
    else noteRpcUnsupported();
    if (!mayFallback(e2ee.policy, false)) throw noFallbackError();
    return null; // 평문 폴백 신호
  }
  // ★ 여기부터는 봉투가 **왕복했다**: 호스트가 요청을 실제로 실행했고 그 처리가 실패한 것이다.
  //  절대 null 을 돌려주지 않는다 — 호출부가 폴백으로 오해해 같은 변형(fs.write)을 평문으로 한 번 더
  //  실행하는 이중 실행이 된다(계약 §2.7 표 2행 = 유일한 폴백 금지 행).
  if (r.ok === false) throw new Error(r.e || r.error || "요청이 실패했어요.");
  // ⚠ 성공했는데 결과가 비어 있어도 **절대 null 을 돌려주지 않는다** — 호출부가 폴백으로 오해해
  //   같은 변형(fs.write 등)을 평문으로 한 번 더 실행하는 이중 실행이 된다.
  const out = r.r === undefined ? r : r.r;
  return out === null || out === undefined ? {} : out;
}

// ── 알림 body 복호(비동기) ──────────────────────────────────────
//  MK 가 데몬에 있으므로 복호도 비동기다. 렌더는 동기라 "🔒 …" 자리표시자를 먼저 그리고,
//  복호되면 그 행만 갈아끼운 뒤 emit 한다(캐시로 반복 요청 방지).
const bodyCache = new Map(); // sealed body → 평문 | null
export function notifBodyText(body) {
  if (!isSealedBody(body)) return body || "";
  if (bodyCache.has(body)) return bodyCache.get(body) || "🔒 암호화된 내용(이 기기에 열쇠 없음)";
  bodyCache.set(body, null);
  void (async () => {
    const r = await cpt("e2ee.openText", { text: body });
    bodyCache.set(body, r && r.text ? String(r.text) : null);
    S.emit();
  })();
  return "🔒 복호화 중…";
}

/** QR 핀 대조(다른 기기가 이 PC 를 승인할 때 쓰는 값을 화면에 노출하기 위함). */
export function myQrPin() {
  try { return e2ee.ikX ? qrPin(b64uDec(e2ee.ikX)) : null; } catch (_) { return null; }
}

/**
 * 부팅 시 1회 + 주기 갱신(60s). 로그인 전이면 데몬이 unsupported/off 를 준다.
 *  ★ 이 PC 가 승인을 기다리는 동안에는 10s 로 조인다(개정 5: 대기 화면에서 '승인됐는지 확인' 버튼을
 *   없앴다 — 승인은 WS resolved 로 즉시 오지만 WS 가 끊긴 창에서도 화면이 스스로 넘어가야 한다).
 */
export function startE2ee() {
  void refreshE2ee();
  let tick = 0;
  setInterval(() => {
    if (!state.paired) return;
    tick += 10;
    const waiting = e2ee.keyState === "pending" || e2ee.keyState === "enrolled"
      || e2ee.state === "pending" || e2ee.state === "enrolled";
    if (waiting || tick >= 60) { tick = 0; void refreshE2ee(); }
  }, 10000);
}

// lan.js 가 순환 import 없이 정책을 물어볼 수 있게 전역에 최소 표면만 노출한다.
//  (모듈 간 상호 참조를 만들면 초기화 순서에 따라 한쪽이 undefined 가 된다)
try { globalThis.__cptE2ee = { policyRequired }; } catch (_) { /* noop */ }
