module.exports = (sequelize, DataTypes) => {
  // 봇 자동화 — kind: event(알림이 오면 착수, filter.minLevel 이상) | schedule(요일+시각, schedule.tz 기준)
  const BotAutomation = sequelize.define('BotAutomation', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    channel_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
    kind: { type: DataTypes.STRING(12), allowNull: false },
    schedule: { type: DataTypes.JSONB, allowNull: true },
    filter: { type: DataTypes.JSONB, allowNull: true },
    prompt: { type: DataTypes.TEXT, allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_run_at: { type: DataTypes.DATE, allowNull: true },
    next_run_at: { type: DataTypes.DATE, allowNull: true },
    run_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'bot_automation', timestamps: false, underscored: true });
  return BotAutomation;
};
