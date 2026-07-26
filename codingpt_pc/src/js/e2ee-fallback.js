// e2ee-fallback.js — 봉투 RPC 실패의 **분류 정본**(순수 함수, import 0개).
//
// 왜 이 파일인가(계약 §2.7):
//  봉투 RPC 실패는 두 종류인데 처방이 정반대다.
//   ① **구조적 미지원** (구 데몬·서버, E2EE 꺼짐, 열쇠 없음) → 10분 네거티브 캐시로 왕복을 멈춘다.
//      캐시가 없으면 fs 호출마다 소켓 왕복이 한 번 더 붙어 IDE 트리·파일 열기가 전부 2배 느려진다.
//   ② **갱신하면 낫는 세대 불일치**(E2EE_EPOCH_MISMATCH · 복호 실패) → 열쇠 상태를 다시 받아 오면
//      다음 시도가 성공한다. 이걸 ①의 캐시에 넣으면 **갱신을 끝냈는데도 10분간 봉인을 시도하지 않아
//      전부 평문**이면서 배지는 초록이다(= 거짓 자물쇠. 계약 §2.7 자가복구 ③이 금지한 것).
//  PC 는 지금까지 둘을 구분하지 않고 `cpt()` 의 catch 한 곳에서 전부 ①로 처리했다(e2ee.js) — 그래서
//  회전 직후 첫 봉투 실패 하나가 10분 평문 + `available=false`(설정 배지 '미지원')를 만들었다.
//
// ★ 문자열 파싱을 여기 모으는 이유: 데몬 코드는 Rust 브리지가 `<CODE>: <메시지>` 로 실어 준다
//  (cptsock.rs e2ee_local — bridge.rs back_api 의 `HTTP 409 ALREADY_RESOLVED: …` 선례와 같은 규약).
//  한글 문구로 분기하면 문구가 바뀌는 순간 조용히 오분기한다.
//
// ⚠ 구 데몬은 back 4xx/5xx 를 전부 `E2EE_RELAY_FAILED` 로 뭉갠다(runner-core/e2ee-local.js rpc()
//  catch — back 의 detail.code 를 보존하지 않는다). 그 경우엔 **우리가 이미 갖고 있는 세대 근거**로
//  판정한다: 데몬 e2ee.state 의 accountEpoch(계정 세대)와 host-lock 의 runner_status.e2eeEpoch.
//  근거가 없으면 ②라고 추측하지 않는다 — 추측해서 캐시를 건너뛰면 미지원 데몬에서 왕복이 폭주한다.
//
// 모바일 대응물 = `src/services/e2ee/e2eeState.ts mayFallbackFor()` + `e2ee.ts refreshForEpochMismatch()`.
//  앱은 HTTP status/detail.code 를 직접 보므로 코드 도메인이 다르다(앱: 'E2EE_EPOCH_MISMATCH' 를 back
//  이 그대로 준다). 문구·톤이 아니라 **처방**이 같아야 한다: refresh 1회 + 억제창 + 캐시 제외.

/** 세대 불일치(양쪽 다 알고 있고 다르다). 하나라도 모르면 false — 모름을 불일치로 단정하지 않는다. */
export function epochMismatch(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  return x > 0 && y > 0 && x !== y;
}

/**
 * Rust 가 실어 준 데몬 에러 코드 추출. @param err Error | string @returns "E2EE_…" | ""
 *  형식: `<CODE>: <메시지>` (코드 없는 실패 = IPC 단절 등 → "")
 */
export function rpcFailCode(err) {
  const msg = err == null ? "" : String((err && err.message) || err);
  const m = /^([A-Z][A-Z0-9_]{2,63}):/.exec(msg);
  return m ? m[1] : "";
}

// 갱신하면 낫는 코드 — 데몬/back 이 "상태가 바뀌면 즉시 낫는다" 로 정의한 계약 위반들(계약 §2.3).
//  E2EE_DECRYPT_FAILED = 응답 봉투를 못 열었다(회전 직후 옛 열쇠) — 호스트 처리 결과가 아니다.
const EPOCH_CODES = ["E2EE_EPOCH_MISMATCH", "E2EE_DECRYPT_FAILED"];
// back 의 상태코드/코드를 데몬이 뭉개 버린 코드 — 세대 근거가 있을 때만 ②로 승격한다.
const OPAQUE_CODES = ["E2EE_RELAY_FAILED"];

/**
 * 봉투 RPC 실패 분류.
 * @param {object} o {code, myEpoch, accountEpoch, hostEpoch}
 *   myEpoch = 이 PC(데몬) 열쇠 세대 · accountEpoch = 서버가 말하는 계정 세대(모르면 null)
 *   hostEpoch = 그 호스트가 신고한 세대(runner_status, 모르면 undefined)
 * @returns {'epoch'|'unsupported'} 'epoch' = refresh 1회 + **캐시 금지** · 'unsupported' = 10분 캐시
 */
export function classifyRpcFail(o) {
  const code = String((o && o.code) || "");
  if (EPOCH_CODES.includes(code)) return "epoch";
  if (OPAQUE_CODES.includes(code)) {
    const my = (o && o.myEpoch) || 0;
    if (epochMismatch(my, o && o.accountEpoch)) return "epoch";
    if (epochMismatch(my, o && o.hostEpoch)) return "epoch";
  }
  return "unsupported";
}

/**
 * 이 실패로 **E2EE 전체를 '미지원' 으로 내려앉혀도 되는가**(e2ee.js cpt() 의 판정).
 *  PC `cpt()` 는 어떤 IPC 실패든 `available=false, state='unsupported'` 로 내렸다 — 그러면 봉투 하나가
 *  409 를 맞은 것만으로 설정 배지가 '미지원' 이 되고 `e2eeCaps()` 가 빈 배열이 된다(다음 hello 에서
 *  능력을 스스로 취소 = 조용한 평문). 데몬이 e2ee 를 **모른다**고 말한 코드에서만 내려앉는다.
 *  코드가 없는 실패(소켓 단절·타임아웃)는 예전 그대로 미지원으로 본다 — 데몬이 안 떠 있으면 사실이다.
 */
export function isDaemonUnsupported(code) {
  const c = String(code || "");
  if (!c) return true; // IPC 단절 등 — 기존 동작 유지
  return c === "E2EE_UNSUPPORTED" || c === "E2EE_UNKNOWN_CMD" || c === "E2EE_DISABLED";
}

/**
 * 평문 폴백 허용 여부(계약 §2.7 표의 PC 대응).
 * @param {string} policy off|preferred|required
 * @param {boolean} hostExecuted 호스트가 요청을 **실제로 실행**했는가
 *   (= 데몬이 응답 봉투를 열어 `{ok:false}` 를 돌려준 경우. 봉투 계층 실패는 throw 로 온다)
 * @returns {boolean}
 *  · required = 전부 금지(다운그레이드 공격 차단)
 *  · hostExecuted = 금지. 폴백하면 같은 변형(fs.write)을 평문으로 **이중 실행**한다.
 *  · 그 밖(봉투가 왕복하지 못했다) = 허용. 막으면 IDE 트리·자동저장이 붉은 오류로 죽는다(자기 잠금).
 */
export function mayFallback(policy, hostExecuted) {
  if (policy === "required") return false;
  return !hostExecuted;
}

export default { epochMismatch, rpcFailCode, classifyRpcFail, isDaemonUnsupported, mayFallback };
