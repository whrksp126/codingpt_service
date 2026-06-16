module.exports = (sequelize, DataTypes) => {
  // 구독 플랜 카탈로그 (서버 권위 가격/한도). 가격·한도는 placeholder — 실측 후 시드 갱신.
  const SubscriptionPlan = sequelize.define('SubscriptionPlan', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(32), allowNull: false, unique: true }, // free | pro | max
    name: { type: DataTypes.STRING(64), allowNull: false },
    price_krw: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, // 월 구독료(원)
    window_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 18000 }, // 롤링 윈도우 길이(5h)
    window_unit_limit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }, // 윈도우당 허용 unit
    weekly_unit_limit: { type: DataTypes.BIGINT, allowNull: true }, // 주간 캡(선택)
    billing_period: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'monthly' },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
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
