module.exports = (sequelize, DataTypes) => {
  // 알림 채널의 메시지. role: event(외부 서비스가 보낸 알림) | user(사람의 지시) | agent(AI 답) | system(상태·승인 요청)
  const AlertChannelMessage = sequelize.define('AlertChannelMessage', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    channel_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING(12), allowNull: false },
    level: { type: DataTypes.STRING(12), allowNull: true },   // info | success | warning | error | critical
    title: { type: DataTypes.STRING(200), allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: true },
    url: { type: DataTypes.TEXT, allowNull: true },
    fields: { type: DataTypes.JSONB, allowNull: true },       // [{ label, value }]
    source: { type: DataTypes.STRING(60), allowNull: false, defaultValue: '' },
    dedupe_key: { type: DataTypes.STRING(120), allowNull: true },
    repeat_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    thread_id: { type: DataTypes.STRING(120), allowNull: true },
    meta: { type: DataTypes.JSONB, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'alert_channel_message', timestamps: false, underscored: true });
  return AlertChannelMessage;
};
