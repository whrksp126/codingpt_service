// e2ee-label.js — "이 PC 의 열쇠 상태" 한 줄 라벨의 **판정 정본**(순수 함수, import 0개).
//
// 왜 이 파일인가:
//  데몬 `e2ee.state` 는 두 종류의 값을 함께 준다 — UI 도메인 `state` 와 **취득 진행상태
//  `keyState`(none|enrolled|pending|trusted) + `checking`**. 진행상태 정본은 후자다(계약 §2.4 규약 3).
//  PC 는 한동안 이 두 필드를 **버렸고**, 그래서 계정에 열쇠가 0개인 상태(= 사람이 켜 줄 때까지
//  **영구 평문**)를 `state:'bootstrap'` 만 보고 대기색(구 '준비 중')으로 그렸다 — "아직 확인 중" 과
//  구분되지 않았다. 그게 이 라운드가 없애려던 거짓 자물쇠의 다른 얼굴이다(화면은 곧 켜진다고
//  말하는데 트래픽은 계속 평문).
//
//  ★ 문구 정본 = docs/구현설계-2026-07-25/14-설정-카피-감사.md §4-1(앱 e2eeState.ts stateLabel 과
//   **글자까지 동일**해야 한다 — 사용자가 폰과 PC 를 나란히 놓고 본다). 2026-07-27 개정:
//   '이 기기 준비됨'→`열쇠 있음`, '준비 중'→`확인 중`(도메인 = 열쇠 있음/승인 대기/확인 중/열쇠 없음/
//   꺼짐/미지원/사용 불가/오류). **판정 순서·톤은 그대로다.**
//
//  ★ `state` 에 분기하지 않는다: 도메인이 데몬 버전에 따라 다르다(둘 다 배포돼 있다).
//   좁은 도메인 = off|unsupported|bootstrap|pending|trusted|error ('none'/'enrolled' 를 절대 안 준다
//   → 그걸 기다리는 분기는 도달 불가 죽은 코드였다) / 넓은 도메인(2026-07-26 pcState 확장) =
//   확인 중이면 bootstrap, 아니면 none, 봉인문 대기는 enrolled. **어느 쪽이 와도 같은 화면**이어야 한다.
//
//  설정 화면(settings.js)과 회귀 테스트(test/contract.mjs · test/e2ee-crossimpl.mjs)가 **같은 함수**를
//  본다. DOM·Tauri 의존이 없어야 크로스임플 테스트가 **실제 데몬 모듈의 출력**을 그대로 먹일 수 있다
//  (그게 "양쪽 절반이 각자 초록" 사고를 막는 유일한 방법이다 — host-lock.js 와 같은 규율).
//
// ⚠ 하위호환: `keyState` 가 **없는** 구 데몬 응답에서는 예전 판정을 그대로 쓴다(모르는 것을
//  '열쇠 없음' 으로 단정하지 않는다). 새 값이 추가돼도 안전한 쪽(대기/미지원)으로 눕는다.

/** 톤 도메인은 모바일 e2eeState.ts stateLabel() 과 동일하다: on(켜짐) | wait(대기) | off(꺼짐/평문). */
const L = (text, tone) => ({ text, tone });

/**
 * @param {object} s e2ee 상태 스냅샷(= 데몬 e2ee.state 응답을 그대로 넣어도 된다)
 *   {available, state, keyState, checking, phase, policy}
 * @param {boolean} [ready] 이 PC 가 봉인 가능한가(e2ee.js ready()). 생략 시 state==='trusted' 로 본다.
 */
export function selfStateLabel(s, ready) {
  const st = s || {};
  const policy = st.policy || "off";
  const keyState = typeof st.keyState === "string" ? st.keyState : null;
  const state = String(st.state || "off");
  const available = st.available !== false;
  const isReady = ready === undefined ? (available && state === "trusted" && policy !== "off") : !!ready;

  // 사용자가 끈 것이 최우선이다(열쇠가 있어도 '켜짐' 을 그리면 반대 방향의 거짓말이 된다 — 데몬
  //  pcState() 도 같은 순서다).
  if (policy === "off") return L("꺼짐", "off");
  // '켜짐' 이 아니라 '열쇠 있음' 이다: 자기 열쇠 보유 ≠ 트래픽 암호화(상대 호스트도 열쇠가 있어야 한다).
  //  실제 자물쇠는 host-lock.js 가 PC 별로 그린다 — 계약 §2.7 거짓 자물쇠 금지.
  if (isReady) return L("열쇠 있음", "on");
  // 데몬이 명령을 모르면(구 번들) 진행상태 필드도 신뢰할 수 없다 → 먼저 미지원으로 눕힌다.
  if (!available || state === "unsupported") return L("미지원", "off");
  if (state === "unavailable") return L("사용 불가", "off");
  // 승인 대기: keyState 가 정본이고 state 확장값은 방어적으로 함께 본다.
  //  enrolled = 승인은 끝났고 봉인문(열쇠) 전달을 기다리는 중 — 사용자가 할 일은 없다.
  if (keyState === "pending" || keyState === "enrolled" || state === "pending" || state === "enrolled") {
    return L("승인 대기", "wait");
  }
  if (state === "error") return L("오류", "off");
  // 서버/스코프에서 꺼진 경우(policy 는 preferred 인데 데몬이 'off') — 대기색을 쓰지 않는다.
  if (state === "off") return L("꺼짐", "off");
  if (keyState === "none") {
    // ★ 여기가 이 파일의 존재 이유: 같은 state('bootstrap')인데 두 화면이어야 한다.
    //  checking=true  → 지금 왕복 중(또는 재시도 예약됨) = "확인 중"
    //  checking=false → 확인이 끝났고 열쇠가 없다 = **평문**. 사람이 켜기 전엔 바뀌지 않는다.
    return st.checking === true ? L("확인 중", "wait") : L("열쇠 없음", "off");
  }
  if (st.checking === true) return L("확인 중", "wait");
  // 구 데몬(keyState 없음) — 모르는 것을 '열쇠 없음' 으로 단정하지 않는다. 예전 라벨 '준비 중' 은
  //  "곧 켜진다" 는 오해를 주는 유일한 문구였으므로 '확인 중' 으로 흡수했다(카피 감사 §2-A).
  if (state === "bootstrap") return L("확인 중", "wait");
  // 여기까지 온 값은 **알 수 없는 state** 다(사용자가 끈 것도 아니고 — policy≠off 는 첫 줄에서 걸렀다 —
  //  데몬이 껐다고 말한 것도 아니다 — state!=='off' 는 위에서 걸렀다) = 미결정. '꺼짐' 으로 단정하면
  //  사용자는 자기가 끈 적 없는 '꺼짐' 을 읽고 자세히 안에서는 '암호화 사용 = 자동' 이 선택된 자기모순
  //  화면을 본다(§2.7 모름을 단정하지 않는다). 앱 stateLabel() 의 마지막 줄과 **같은 값**이고,
  //  test/e2ee-crossimpl.mjs 4-B 절이 전 조합을 대조한다 — 한쪽만 바꾸면 즉시 터진다.
  return L("확인 중", "wait");
}

/**
 * 이 PC 에서 "계정 암호화 처음 켜기"(cpt.sock `e2ee.bootstrap`)를 노출해야 하는가.
 *  · 데몬은 이 경로를 **자동으로 타지 않는다**(헤드리스가 신뢰 기점을 세우면 폰만 든 사용자가 잠긴다
 *    — daemon e2ee-account.js 헤더). 그래서 사람이 누를 자리가 필요하다.
 *  · `phase==='bootstrap'`(= 서버가 "계정에 열쇠 0개" 라고 답한 상태)에서만 뜬다. `no_enroll_client`
 *    (취득 배관 없는 구 번들)나 진단 불가 상태에서 띄우면 눌러도 실패만 한다.
 */
export function needsBootstrap(s) {
  const st = s || {};
  if (!st || st.available === false) return false;
  if ((st.policy || "off") === "off") return false;
  if (st.keyState === "trusted" || st.state === "trusted") return false;
  return st.phase === "bootstrap";
}

/**
 * '복구 코드로 복원' 행을 노출할지 — 앱 `E2eeSettingsCard` 의 `canRestore` 와 **같은 조건**이어야 한다.
 *  PC 는 `state !== 'trusted' && state !== 'off'` 로 분기했다(계약 §2.4 규약 3 위반 = `state` 값 분기):
 *   · policy='off' 인데 열쇠는 있는 상태에서 state='off' 라 **복구 코드 만들기가 비활성**됐고(열쇠는
 *     있는데 만들 수 없다),
 *   · 사용 불가 상태의 PC 에도 복원 행이 떠서 **눌러도 실패**했다(앱은 감춘다).
 *  그래서 진행 판정은 `ready`(= e2ee.js ready())가, 노출 판정은 아래 한 곳이 정본이다.
 *  ⚠ 열쇠가 있으면 복원할 이유가 없다 → ready 면 감춘다(앱과 동일 순서).
 *  ⚠ 제외 목록은 앱 `canRestore` 와 **글자까지 같은 조건**으로 유지한다(unavailable·off). 'unsupported'
 *   도 눌러도 실패하는 상태지만 그건 **양쪽 공통 동작**이므로 여기서 한쪽만 좁히면 두 화면의 컨트롤
 *   유무가 다시 갈라진다 — 좁히려면 앱 E2eeSettingsCard 와 같은 커밋에서 함께 좁혀야 한다.
 *  동치 고정 = test/e2ee-crossimpl.mjs(앱 TSX 의 canRestore 식을 오려 같은 격자로 대조).
 */
export function canRestore(s, ready) {
  const st = s || {};
  const state = String(st.state || "off");
  const isReady = ready === undefined
    ? (st.available !== false && state === "trusted" && (st.policy || "off") !== "off")
    : !!ready;
  if (isReady) return false;
  return state !== "unavailable" && state !== "off";
}

export default { selfStateLabel, needsBootstrap, canRestore };
