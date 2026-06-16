module.exports = (sequelize, DataTypes) => {
  // 에이전트 턴 1회당 1행 — 사용량 미터링의 원천(롤링 윈도우 합산 소스 of truth).
  // recordTurn 이 done 이벤트(costUsd/usage)를 받아 적재한다.
  const UsageEvent = sequelize.define('UsageEvent', {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    session_id: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    project_id: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    cost_usd: {
      type: DataTypes.DECIMAL(12, 6), // Anthropic 청구 원가(USD)
      allowNull: false,
      defaultValue: 0,
    },
    input_tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    output_tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    cache_read_tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    cache_creation_tokens: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    compute_ms: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    // 정규화 사용량 unit (윈도우/크레딧 차감 대상)
    metered_units: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    // 이 턴이 어느 버킷에서 차감됐는지: 'plan'(윈도우) | 'credit'(충전 크레딧)
    source: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'plan',
    },
    // credit 턴일 때 크레딧에서 차감한 unit (plan 턴이면 0)
    credit_units_charged: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'usage_event',
    timestamps: false,
    indexes: [
      { name: 'idx_usage_event_user_created', fields: ['user_id', 'created_at'] },
      { name: 'idx_usage_event_user_source', fields: ['user_id', 'source'] },
    ],
  });

  UsageEvent.associate = (models) => {
    UsageEvent.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UsageEvent;
};
