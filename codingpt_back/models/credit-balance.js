module.exports = (sequelize, DataTypes) => {
  // 사용자별 크레딧 잔액(머티리얼라이즈) — 빠른 조회용. 원장(credit_ledger)이 정본.
  const CreditBalance = sequelize.define('CreditBalance', {
    user_id: { type: DataTypes.INTEGER, primaryKey: true },
    balance_units: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'credit_balance',
    timestamps: false,
  });

  CreditBalance.associate = (models) => {
    CreditBalance.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return CreditBalance;
};
