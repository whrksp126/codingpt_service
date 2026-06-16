module.exports = (sequelize, DataTypes) => {
  // 충전 단위(lot) — FIFO 소비 + 1년 만료(환금성 심사 필수). 충전 1건당 1 lot.
  const CreditLot = sequelize.define('CreditLot', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    source_payment_id: { type: DataTypes.STRING(255), allowNull: true }, // 이 lot 을 만든 충전 결제
    granted_units: { type: DataTypes.BIGINT, allowNull: false },
    remaining_units: { type: DataTypes.BIGINT, allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false }, // created_at + 1년
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'credit_lot',
    timestamps: false,
    indexes: [
      { name: 'idx_credit_lot_user_expires', fields: ['user_id', 'expires_at'] },
    ],
  });

  CreditLot.associate = (models) => {
    CreditLot.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return CreditLot;
};
