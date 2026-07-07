module.exports = (sequelize, DataTypes) => {
  // BYO-PC 데몬 기기 등록. 페어링(pair/claim) 시 생성되고, 데몬은 device token 으로
  // 제어 WS(/api/daemon/connect)에 인증한다. 토큰 원문은 저장하지 않고 sha256 해시만 보관.
  const DaemonDevice = sequelize.define('DaemonDevice', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'user', key: 'id' } },
    device_name: { type: DataTypes.STRING(128), allowNull: false }, // 예: "MacBook Pro"(hostname)
    platform: { type: DataTypes.STRING(32), allowNull: true }, // darwin/win32/linux
    daemon_version: { type: DataTypes.STRING(32), allowNull: true },
    token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true }, // sha256(deviceToken)
    last_seen_at: { type: DataTypes.DATE, allowNull: true }, // 제어 WS 마지막 생존 시각
    revoked_at: { type: DataTypes.DATE, allowNull: true }, // 연결 해제(재페어링 필요)
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'daemon_device',
    timestamps: false,
  });

  DaemonDevice.associate = (models) => {
    if (models.User) DaemonDevice.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return DaemonDevice;
};
