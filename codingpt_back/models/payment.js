module.exports = (sequelize, DataTypes) => {
  // PortOne 결제 1건(충전/구독 공통). payment_id 가 멱등키.
  const Payment = sequelize.define('Payment', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    payment_id: { type: DataTypes.STRING(255), allowNull: false, unique: true }, // PortOne paymentId(멱등키)
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    type: { type: DataTypes.STRING(16), allowNull: false }, // charge|subscription
    channel: { type: DataTypes.STRING(24), allowNull: true }, // inicis_lump|inicis_billing
    ref_id: { type: DataTypes.INTEGER, allowNull: true }, // credit_pack.id 또는 subscription_plan.id (폴리모픽)
    amount_krw: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'ready' }, // ready|paid|failed|cancelled|partial_cancelled
    pg_tx_id: { type: DataTypes.STRING(255), allowNull: true },
    billing_key: { type: DataTypes.STRING(255), allowNull: true },
    customer_uid: { type: DataTypes.STRING(255), allowNull: true },
    raw_response: { type: DataTypes.JSONB, allowNull: true }, // 마지막 PortOne 조회 페이로드(감사)
    paid_at: { type: DataTypes.DATE, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'payment',
    timestamps: false,
    indexes: [
      { name: 'idx_payment_user_status', fields: ['user_id', 'status'] },
      { name: 'idx_payment_type_status', fields: ['type', 'status'] },
    ],
  });

  Payment.associate = (models) => {
    Payment.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return Payment;
};
