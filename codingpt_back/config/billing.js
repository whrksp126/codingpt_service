// 과금/사용량 미터링 중앙 상수.
// 모든 값은 env 로 오버라이드 가능 — 가격/마진/한도는 Phase 1 실측 후 확정한다.
//
// 정규화 단위(unit): 공급자 비종속 내부 회계 단위.
//   metered_units = ceil( cost_usd * USD_TO_UNIT * MARKUP + compute_ms * COMPUTE_UNIT_PER_MS )
//   - USD_TO_UNIT : USD 1달러 → unit 수 (기본 1,000,000 → 1 unit = $0.000001)
//   - MARKUP      : 원가(Claude API + 컴퓨팅) 대비 마진배수 (여기에 마진이 산다)
//   - COMPUTE_UNIT_PER_MS : 샌드박스 런타임(ms) → unit 환산 (Phase 1 엔 0, Phase 5 에서 배선)
//
// 플랜/크레딧팩의 한도·충전량도 모두 이 unit 으로 표현된다.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

module.exports = {
  USD_TO_UNIT: num(process.env.BILLING_USD_TO_UNIT, 1_000_000),
  MARKUP: num(process.env.BILLING_MARKUP, 1.75),
  COMPUTE_UNIT_PER_MS: num(process.env.BILLING_COMPUTE_UNIT_PER_MS, 0),

  // 구독 플랜이 없을 때(미가입/Free 폴백) 상태 표시용 기본 윈도우.
  // 실제 한도는 subscription_plan 에서 온다(Phase 2).
  DEFAULT_WINDOW_SECONDS: num(process.env.BILLING_DEFAULT_WINDOW_SECONDS, 18_000), // 5시간
  DEFAULT_WEEKLY_SECONDS: num(process.env.BILLING_DEFAULT_WEEKLY_SECONDS, 604_800), // 7일

  // 크레딧 유효기간 (환금성 심사 필수: 결제일로부터 1년 이내 소멸)
  CREDIT_EXPIRY_DAYS: num(process.env.BILLING_CREDIT_EXPIRY_DAYS, 365),

  // 사용량 한도 강제 on/off. 기본 false — 한도/가격을 실측으로 보정하기 전엔 차단하지 않는다.
  // true 로 켜야 agentController 프리플라이트 게이트가 429/402 를 반환한다.
  ENFORCE: String(process.env.BILLING_ENFORCE || 'false').toLowerCase() === 'true',

  // 결제 웹 서비스 베이스 URL (한도 도달 시 앱이 유도할 업그레이드/충전 페이지)
  PAYMENT_WEB_URL: process.env.PAYMENT_WEB_URL || 'https://codingpt.ghmate.com',

  // 미가입 사용자의 기본 플랜 코드
  DEFAULT_PLAN_CODE: process.env.BILLING_DEFAULT_PLAN_CODE || 'free',

  // 연체(Dunning): 갱신 결제 실패 시 grace 동안 plan 권한을 유지하고 재시도한다.
  //  컷오프(→ canceled): 시도 횟수 >= MAX_ATTEMPTS 또는 연체 경과일 >= GRACE_DAYS (둘 중 먼저).
  DUNNING_MAX_ATTEMPTS: num(process.env.BILLING_DUNNING_MAX_ATTEMPTS, 4),
  DUNNING_GRACE_DAYS: num(process.env.BILLING_DUNNING_GRACE_DAYS, 7),
};
