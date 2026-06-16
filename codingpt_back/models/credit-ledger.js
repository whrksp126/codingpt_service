module.exports = (sequelize, DataTypes) => {
  // 크레딧 원장(정본) — 충전(+)/차감(−)/만료(−)/환불(±) 모든 변동 + 변동 후 잔액.
  // 웹 account/credits 의 "충전/차감/잔여" 내역을 그대로 렌더한다(환금성 심사 필수).
  const CreditLedger = sequelize.define('CreditLedger', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    delta_units: { type: DataTypes.BIGINT, allowNull: false }, // +충전 / −차감·만료 / +환불회수
    reason: { type: DataTypes.STRING(24), allowNull: false }, // charge|consume|expire|refund|adjust
    balance_after: { type: DataTypes.BIGINT, allowNull: false },
    ref_type: { type: DataTypes.STRING(24), allowNull: true }, // payment|usage_event|lot
    ref_id: { type: DataTypes.STRING(64), allowNull: true },
    memo: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'credit_ledger',
    timestamps: false,
    indexes: [
      { name: 'idx_credit_ledger_user_created', fields: ['user_id', 'created_at'] },
    ],
  });

  CreditLedger.associate = (models) => {
    CreditLedger.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return CreditLedger;
};
