module.exports = (sequelize, DataTypes) => {
  // 봇의 할 일(Orca Items) — status: needs_you | in_progress | waiting | planned | done | canceled
  //  ask = { question, options[], recommended } — 사람이 골라야 할 때(Needs you). notes = [{ at, actor, text }] 최근 100개.
  const BotItem = sequelize.define('BotItem', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    channel_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'in_progress' },
    done_means: { type: DataTypes.TEXT, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    ask: { type: DataTypes.JSONB, allowNull: true },
    notes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    dedupe_key: { type: DataTypes.STRING(120), allowNull: true },
    source_message_id: { type: DataTypes.BIGINT, allowNull: true },
    url: { type: DataTypes.TEXT, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'bot_item', timestamps: false, underscored: true });
  return BotItem;
};
