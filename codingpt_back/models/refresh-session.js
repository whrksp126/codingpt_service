module.exports = (sequelize, DataTypes) => {
  // 기기별 refresh 토큰 세션. refresh 토큰 원문은 저장하지 않고 sha256 해시만 보관하며,
  // 세션별로 독립 폐기(revoke)할 수 있다. (기존 User.refresh_token 단일 컬럼의 평문·폐기불가 문제 해소)
  const RefreshSession = sequelize.define('RefreshSession', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'user', key: 'id' } },
    token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true }, // sha256(refreshToken)
    expires_at: { type: DataTypes.DATE, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    last_used_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'refresh_session',
    timestamps: false,
  });

  RefreshSession.associate = (models) => {
    if (models.User) RefreshSession.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return RefreshSession;
};
