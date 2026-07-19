module.exports = (sequelize, DataTypes) => {
  // 푸시 기기 등록(M3-3). 앱이 FCM/APNs 디바이스 토큰을 등록 → 서버가 done/승인대기/크래시 시 발송.
  // token 은 provider 발급 원문(재발급 시 upsert). 한 사용자가 여러 기기 가능.
  const PushDevice = sequelize.define('PushDevice', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'user', key: 'id' } },
    platform: { type: DataTypes.STRING(16), allowNull: false }, // ios | android | web
    token: { type: DataTypes.STRING(512), allowNull: false, unique: true }, // FCM/APNs 디바이스 토큰
    provider: { type: DataTypes.STRING(16), allowNull: true }, // fcm | apns | expo
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // 라우팅 토글 — false(기본)=PC 사용 중이면 이 폰 무음, true=PC 사용 중에도 푸시. (notificationService present-device 라우팅)
    alert_when_pc_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    last_seen_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'push_device',
    timestamps: false,
  });

  PushDevice.associate = (models) => {
    if (models.User) PushDevice.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return PushDevice;
};
