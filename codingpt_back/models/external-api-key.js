module.exports = (sequelize, DataTypes) => {
  // 외부 서비스용 API 키(/api/v1). PC 한 대에 묶이고, 원문은 만들 때 한 번만 보여 준다.
  const ExternalApiKey = sequelize.define('ExternalApiKey', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    device_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(60), allowNull: false },
    key_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true }, // sha256(원문)
    key_prefix: { type: DataTypes.STRING(16), allowNull: false }, // 목록에서 키를 알아보는 앞 글자
    allowed_paths: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // 비어 있으면 홈 전체
    allow_bypass: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // 승인 없이 실행 허용
    last_used_at: { type: DataTypes.DATE, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'external_api_key', timestamps: false, underscored: true });
  return ExternalApiKey;
};
