module.exports = (sequelize, DataTypes) => {
  // PortOne 웹훅 원본 로그 — ack + 재조정 + 리플레이 방지.
  const WebhookEvent = sequelize.define('WebhookEvent', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    provider: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'portone' },
    event_type: { type: DataTypes.STRING(64), allowNull: true },
    payment_id: { type: DataTypes.STRING(255), allowNull: true },
    signature_valid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    raw_body: { type: DataTypes.TEXT, allowNull: true }, // 수신 바이트 그대로
    processed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    received_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'webhook_event',
    timestamps: false,
    indexes: [
      { name: 'idx_webhook_event_payment', fields: ['payment_id'] },
      { name: 'idx_webhook_event_processed', fields: ['processed', 'received_at'] },
    ],
  });

  return WebhookEvent;
};
