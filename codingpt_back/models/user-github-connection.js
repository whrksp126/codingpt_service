module.exports = (sequelize, DataTypes) => {
  // 학습자별 GitHub OAuth 연동 정보. access_token 은 AES-256-GCM 암호문으로 저장한다.
  // (utils/cryptoToken.js 로 암복호화)
  const UserGithubConnection = sequelize.define('UserGithubConnection', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    github_user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    github_login: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    access_token_enc: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    scope: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    avatar_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    connected_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'user_github_connection',
    timestamps: true,
    createdAt: 'connected_at',
    updatedAt: 'updated_at',
  });

  UserGithubConnection.associate = (models) => {
    UserGithubConnection.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return UserGithubConnection;
};
