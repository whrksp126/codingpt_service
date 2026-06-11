module.exports = (sequelize, DataTypes) => {
  // 관리자가 정의하는 GitHub 레포 "정의(블루프린트)".
  // 실제 레포는 학습자 계정에 이 name 으로 생성된다(getOrCreateRepo).
  // 레슨은 lesson.meta.github.repoId 로 이 정의를 참조한다.
  const GithubRepo = sequelize.define('GithubRepo', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(255), // GitHub repo 이름으로 사용
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    visibility: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'public',
    },
    readme: {
      type: DataTypes.TEXT, // 레포 최초 생성 시 시드될 README.md 내용
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
    tableName: 'github_repo',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  GithubRepo.associate = (models) => {
    GithubRepo.hasMany(models.UserGithubRepo, { foreignKey: 'github_repo_id' });
  };

  return GithubRepo;
};
