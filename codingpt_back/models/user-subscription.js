module.exports = (sequelize, DataTypes) => {
  // 사용자 구독 상태. status='active' 1행만 유효(부분 유니크 인덱스).
  const UserSubscription = sequelize.define('UserSubscription', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' }, // active|past_due|canceled|paused
    source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'portone' }, // portone(웹 PG) | revenuecat(스토어 IAP)
    billing_key: { type: DataTypes.STRING(255), allowNull: true }, // PortOne 빌링키 | RC original_transaction_id
    card_brand: { type: DataTypes.STRING(32), allowNull: true }, // 표시용 카드 브랜드/발급사
    card_last4: { type: DataTypes.STRING(4), allowNull: true }, // 표시용 카드 끝 4자리
    current_period_start: { type: DataTypes.DATE, allowNull: true },
    current_period_end: { type: DataTypes.DATE, allowNull: true }, // 다음 갱신 청구일
    cancel_at_period_end: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    scheduled_plan_id: { type: DataTypes.INTEGER, allowNull: true }, // 다운그레이드 예약 → 갱신 시 plan_id 로 전환 후 클리어
    canceled_at: { type: DataTypes.DATE, allowNull: true }, // 해지 확정 시각
    past_due_since: { type: DataTypes.DATE, allowNull: true }, // 연체 진입 시각(grace 컷오프 판정)
    renewal_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_payment_id: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'user_subscription',
    timestamps: false,
    indexes: [
      { name: 'idx_user_subscription_user_status', fields: ['user_id', 'status'] },
      { name: 'idx_user_subscription_status_period', fields: ['status', 'current_period_end'] },
    ],
  });

  UserSubscription.associate = (models) => {
    UserSubscription.belongsTo(models.User, { foreignKey: 'user_id' });
    UserSubscription.belongsTo(models.SubscriptionPlan, { foreignKey: 'plan_id' });
    UserSubscription.belongsTo(models.SubscriptionPlan, { foreignKey: 'scheduled_plan_id', as: 'ScheduledPlan' });
  };

  return UserSubscription;
};
