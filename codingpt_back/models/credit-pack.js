module.exports = (sequelize, DataTypes) => {
  // 크레딧 충전팩 카탈로그 (환금성). price_krw ≥ 1000 (신용카드 일시불 최소금액).
  const CreditPack = sequelize.define('CreditPack', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(64), allowNull: false },
    price_krw: { type: DataTypes.INTEGER, allowNull: false }, // ≥ 1000
    credit_units: { type: DataTypes.BIGINT, allowNull: false }, // 충전 unit
    bonus_units: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }, // 보너스(역시 1년 소멸)
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'credit_pack',
    timestamps: false,
  });

  return CreditPack;
};
