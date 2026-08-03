module.exports = (sequelize, DataTypes) => {
  // 구독 플랜 카탈로그 (서버 권위 가격/한도). 가격·한도는 placeholder — 실측 후 시드 갱신.
  const SubscriptionPlan = sequelize.define('SubscriptionPlan', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(32), allowNull: false, unique: true }, // free(=Personal) | supporter | legacy pro/max
    name: { type: DataTypes.STRING(64), allowNull: false },
    price_krw: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 월 구독료(원)
    window_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 18000 }, // 롤링 윈도우 길이(5h)
    window_unit_limit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }, // (레거시) 윈도우당 허용 unit
    weekly_unit_limit: { type: DataTypes.BIGINT, allowNull: true }, // (레거시) 주간 캡(선택)
    // M5 Slice5 — 클라우드 실행시간(초) 쿼터. BYO=cost 불가시라 계측 대상은 클라우드 런타임 초.
    window_seconds_limit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }, // 윈도우당 허용 초(0=무제한)
    weekly_seconds_limit: { type: DataTypes.BIGINT, allowNull: true }, // 주간 캡(초, null=없음)
    billing_period: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'monthly' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 사용자 표시용 카피 (단일 출처 — 웹/앱이 /api/subscription/plans 로 렌더, 어드민 편집)
    tagline: { type: DataTypes.STRING(255), allowNull: true }, // 한 줄 설명
    features: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // 기능 불릿 배열
    badge: { type: DataTypes.STRING(32), allowNull: true }, // 예: "가장 인기"
    highlight: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // 강조 카드
    display_multiplier: { type: DataTypes.STRING(16), allowNull: true }, // 예: "5x"
    // 스토어 IAP 상품 ID (RC 웹훅 product_id → 플랜 매핑). free 는 null.
    apple_product_id: { type: DataTypes.STRING(64), allowNull: true },
    google_product_id: { type: DataTypes.STRING(64), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'subscription_plan',
    timestamps: false,
  });

  SubscriptionPlan.associate = (models) => {
    SubscriptionPlan.hasMany(models.UserSubscription, { foreignKey: 'plan_id' });
  };

  return SubscriptionPlan;
};
