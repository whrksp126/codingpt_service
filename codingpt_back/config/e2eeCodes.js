// E2EE 봉투 계층의 **오류 코드 → HTTP 상태** 사전(정본 한 곳).
//
// 왜 이 파일인가: 매핑이 컨트롤러 안에 흩어져 있으면 "이 코드가 어떤 상태로 나가는가"를 아무도
//  한눈에 못 본다. 그래서 실제로 사고가 났다 — 열쇠 없는 PC 데몬이 `E2EE_NO_KEY`(구조적 미지원)를
//  회신하는데 컨트롤러의 미지원 집합에 그 코드가 없어 **502**로 올라갔고, 앱은 그것을 "일시 장애"로
//  읽었다(폴백 규칙이 관대해서 화면은 살았지만 진단이 불가능했다: 언제부터 평문인지 아무도 모른다).
//  코드가 늘 때마다 같은 실수를 반복하지 않으려면 표가 한 장이어야 한다.
//
// 클라이언트 계약(정본은 앱 `src/services/e2ee/e2eeState.ts mayFallbackFor()`):
//  · policy≠'required' 면 **봉투 계층의 모든 실패가 평문 폴백 대상**이다 → 상태 코드는 "폴백할지"를
//    정하지 않는다. 이미 규칙 기반이라 어떤 상태를 주더라도 화면이 죽지 않는다.
//  · 상태 코드가 실제로 지배하는 것은 **앱의 미지원 네거티브 캐시 10분**이다
//    (`e2ee.ts sealedRpc`: `r.status===404||501` → 즉시 캐시, `r.status>=500` → 캐시,
//     4xx + 코드 있음 → 캐시하지 않음). 그래서 아래 3구간이 서로 다른 의미를 갖는다.
//
// ── 구간 ─────────────────────────────────────────────────────────────────────
//  501 = 구조적 미지원. "이 호스트에서는 지금 봉투를 쓸 수 없다"가 사실이고 **재시도로 낫지 않는다**
//        (데몬에 모듈이 없다 / CPT_E2EE=0 / 스코프 미달 / 이 PC 에 계정 열쇠가 0개).
//        → 앱이 조용히 평문으로 내려가고 10분 캐시해 왕복 자체를 줄이는 것이 옳은 처방이다.
//        code 없는 실패(구 데몬이 method 'sealed' 를 몰라 throw · RPC 타임아웃)도 이 바구니다:
//        구분 수단이 없고 어느 쪽이든 처방이 같다.
//  409 = 계약 위반(재시도로 낫지 않지만 **구조적 미지원도 아니다**). 아래 §계약위반 참조.
//  502 = 데몬이 봉투를 다루려다 실패했다(열기/봉인/메서드). 코드를 보존해 진단 가능하게 한다.
//
// ── §계약위반을 501/502 로 보내면 안 되는 이유(이 라운드의 판단) ────────────────
//  `E2EE_EPOCH_MISMATCH` · `E2EE_REPLAY` · `E2EE_HOST_MISMATCH` 는 공통 성질이 있다:
//   (a) **같은 봉투를 그대로 다시 보내면 영원히 같은 결과**다 → 클라가 재시도 루프를 돌면 안 된다.
//   (b) 그러나 **상태가 바뀌면 즉시 낫는다** — 회전 후 keyring 을 refresh 하면 다음 봉투는 새 epoch,
//       카운터가 진행되면 다음 nonce 는 신선하고, host 를 바로 지정하면 라우팅이 맞는다.
//       → "영구 미지원" 으로 캐시하면 안 된다.
//  501/502 는 둘 다 앱의 10분 미지원 캐시를 켠다(위 계약). 그러면 `e2ee.revoke` 로 세대를 회전할 때마다
//  **정상 기기가 10분간 평문으로 떨어진다** — 사용자가 보안 조작을 한 직후에 암호화가 10분 꺼지는,
//  방향이 정확히 거꾸로인 동작이다. 그래서 4xx 로 내린다.
//  4xx 중 409 Conflict 를 고른 근거: RFC 9110 의 "대상 리소스의 **현재 상태와 충돌**해서 완료할 수
//  없다"가 세대 회전·nonce 재사용·호스트 바인딩 어긋남 셋 모두의 정확한 서술이다(412 는 조건부 요청
//  헤더 전용, 422 는 서버가 내용을 이해했다는 뜻이라 봉투를 못 여는 서버가 쓸 수 없다).
//  ※ 409 는 `DAEMON_OFFLINE` 과 상태 코드를 공유한다. 계약이 "클라는 detail.code 로만 분기한다"이고
//    (모바일의 오프라인 UX 감지도 상태가 아니라 코드/문구를 본다 — `WorkspaceShellContext.tsx:1121`
//    `/데몬이 연결|DAEMON_OFFLINE/`) 두 경우의 처방("지금 이 상태로는 안 되니 상태가 바뀐 뒤 다시")이
//    같으므로 의도적으로 같은 상태를 쓴다. 이 조합은 §2.2 계약표(501/502 2구간)의 개정이다.
//
// ⚠ 이 표에 코드를 추가할 때는 데몬 `runner-core/control.js handleSealedRpc` / `e2ee.js` /
//   `e2ee-local.js` 의 codedError 목록과 대조할 것. 데몬에 없는 코드를 여기 넣는 건 무해하지만,
//   데몬에 있는데 여기 없으면 그 코드는 "모르는 코드" 기본값(502)으로 나가 위 사고가 재발한다.

// 구조적 미지원 — 501. (데몬 코드 위치: control.js:186/190/197/213 · e2ee.js:292/295/690 · e2ee-local.js:41/199/204)
const SEALED_STRUCTURAL = ['E2EE_UNSUPPORTED', 'E2EE_DISABLED', 'E2EE_SCOPE', 'E2EE_NO_KEY'];
// 계약 위반 — 409. 재전송 금지 + 영구 포기 금지(위 §계약위반).
const SEALED_CONTRACT = ['E2EE_EPOCH_MISMATCH', 'E2EE_REPLAY', 'E2EE_HOST_MISMATCH'];
// 데몬이 봉투를 다루다 실패 — 502(코드 보존).
//  ※ 구 데몬은 '열쇠 없음'까지 `E2EE_OPEN_FAILED` 로 뭉갠다(control.js 가 openRpc throw 를 통째로 이
//    코드로 바꿨다). 그것을 서버가 "hostEpoch===0 이니 실은 NO_KEY 겠지" 로 추론해 501 로 바꾸지는
//    않는다 — 추론이 틀리면(광고만 0 인 데몬) 정상 호스트를 영구 미지원으로 캐시시킨다. 정직화는
//    데몬이 코드를 바르게 던지는 쪽에서 한다. 구 데몬의 502 도 앱은 10분 캐시하므로 처방은 같다.
const SEALED_HANDLING = ['E2EE_OPEN_FAILED', 'E2EE_SEAL_FAILED', 'E2EE_BAD_METHOD', 'E2EE_NO_ENVELOPE'];

const SEALED_STATUS = Object.freeze({
  BAD_ENVELOPE: 400,      // 형식 게이트(서버가 볼 수 있는 유일한 검문) — 데몬 왕복 0회
  DAEMON_OFFLINE: 409,    // 대상 PC 가 연결돼 있지 않다(기존 통일 응답)
  ...Object.fromEntries(SEALED_STRUCTURAL.map((c) => [c, 501])),
  ...Object.fromEntries(SEALED_CONTRACT.map((c) => [c, 409])),
  ...Object.fromEntries(SEALED_HANDLING.map((c) => [c, 502])),
});

// code 가 아예 없는 실패(구 데몬 throw · RPC 타임아웃 · 전송 실패) = 구조적 미지원과 같은 처방.
const SEALED_NO_CODE_STATUS = 501;
const SEALED_NO_CODE = 'E2EE_UNSUPPORTED';
// 표에 없는 코드 = 데몬이 뭔가 시도하다 실패한 것으로 보고 502(코드는 그대로 보존해 진단).
const SEALED_UNKNOWN_STATUS = 502;

/**
 * 데몬(또는 릴레이) 오류 → { status, code }. 문구는 호출부가 정한다(코드만 계약이다).
 * @param {string|undefined|null} code
 */
function sealedStatusOf(code) {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) return { status: SEALED_NO_CODE_STATUS, code: SEALED_NO_CODE };
  const status = SEALED_STATUS[c];
  return { status: status || SEALED_UNKNOWN_STATUS, code: c };
}

module.exports = {
  SEALED_STATUS,
  SEALED_STRUCTURAL,
  SEALED_CONTRACT,
  SEALED_HANDLING,
  SEALED_NO_CODE_STATUS,
  SEALED_UNKNOWN_STATUS,
  sealedStatusOf,
};
