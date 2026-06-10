module.exports = (sequelize, DataTypes) => {
  // 학습자 × 레포정의(github_repo) → 학습자 계정에 실제 생성된 GitHub 레포 매핑.
  // 레슨 완료 시 이 매핑으로 레포를 재사용(재생성 방지)하고 어디에 커밋할지 식별한다.
  // (기존 user_class_repo 를 대체 — 레포가 클래스가 아닌 레포정의에 종속)
  const UserGithubRepo = sequelize.define('UserGithubRepo', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    github_repo_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    repo_full_name: {
      type: DataTypes.STRING(255), // owner/repo
      allowNull: false,
    },
    default_branch: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'main',
    },
    html_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_at: {
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
    tableName: 'user_github_repo',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['user_id', 'github_repo_id'], name: 'uniq_user_github_repo' },
    ],
  });

  UserGithubRepo.associate = (models) => {
    UserGithubRepo.belongsTo(models.User, { foreignKey: 'user_id' });
    UserGithubRepo.belongsTo(models.GithubRepo, { foreignKey: 'github_repo_id' });
  };

  return UserGithubRepo;
};
