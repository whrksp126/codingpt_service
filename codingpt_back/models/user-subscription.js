module.exports = (sequelize, DataTypes) => {
  // 사용자 구독 상태. status='active' 1행만 유효(부분 유니크 인덱스).
  const UserSubscription = sequelize.define('UserSubscription', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    plan_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' }, // active|past_due|canceled|paused
    source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'portone' }, // portone(웹 PG) | revenuecat(스토어 IAP)
    billing_key: { type: DataTypes.STRING(255), allowNull: true }, // PortOne 빌링키 | RC original_transaction_id
    current_period_start: { type: DataTypes.DATE, allowNull: true },
    current_period_end: { type: DataTypes.DATE, allowNull: true }, // 다음 갱신 청구일
    cancel_at_period_end: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
  };

  return UserSubscription;
};
