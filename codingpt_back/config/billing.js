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
  ENFORCE: String(process.env.BILLING_ENFORCE || 'false').toLowerCase() === 'true',

  // 신규 구독 판매 on/off. BYO 원격 조작 서비스 피벗(M0)으로 신규 판매를 중단한다.
  //  false 면 새 구독 생성 경로(웹 createCheckout/subscribe, IAP initial-purchase/sync)가 거부된다.
  //  기존 구독자의 갱신·해지·플랜변경·결제수단변경은 영향 없음. (M5 에서 실행시간 과금으로 재설계.)
  // Supporter 출시 전에는 명시적으로 켜야만 판매한다(결제사/스토어 상품 누락 상태의 우발 판매 방지).
  SALES_OPEN: String(process.env.SUBSCRIPTION_SALES_ENABLED || 'false').toLowerCase() === 'true',

  // 결제 웹 서비스 베이스 URL (한도 도달 시 앱이 유도할 업그레이드/충전 페이지)
  PAYMENT_WEB_URL: process.env.PAYMENT_WEB_URL || 'https://codingpt.ghmate.com',

  // 글로벌 웹 구독(Lemon Squeezy, Merchant of Record).
  // API 키/웹훅 시크릿은 백엔드 env 에만 두고, 체크아웃은 서버에서 생성한다.
  // 초기 설정 때 사용한 LEMONSQUEEZY_* 이름도 계속 허용한다. 운영 env 이름 차이로
  // 체크아웃/웹훅이 조용히 비활성화되지 않게 표준명 → 호환명 순서로 읽는다.
  LEMON_SQUEEZY_API_KEY: process.env.LEMON_SQUEEZY_API_KEY || process.env.LEMONSQUEEZY_API_KEY || '',
  LEMON_SQUEEZY_STORE_ID: process.env.LEMON_SQUEEZY_STORE_ID || process.env.LEMONSQUEEZY_STORE_ID || '',
  LEMON_SQUEEZY_SUPPORTER_VARIANT_ID: process.env.LEMON_SQUEEZY_SUPPORTER_VARIANT_ID || process.env.LEMONSQUEEZY_VARIANT_ID || '',
  LEMON_SQUEEZY_WEBHOOK_SECRET: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '',

  // 미가입 사용자의 기본 플랜 코드
  DEFAULT_PLAN_CODE: process.env.BILLING_DEFAULT_PLAN_CODE || 'free',

  // 연체(Dunning): 갱신 결제 실패 시 grace 동안 plan 권한을 유지하고 재시도한다.
  //  컷오프(→ canceled): 시도 횟수 >= MAX_ATTEMPTS 또는 연체 경과일 >= GRACE_DAYS (둘 중 먼저).
  DUNNING_MAX_ATTEMPTS: num(process.env.BILLING_DUNNING_MAX_ATTEMPTS, 4),
  DUNNING_GRACE_DAYS: num(process.env.BILLING_DUNNING_GRACE_DAYS, 7),
};
