module.exports = (sequelize, DataTypes) => {
  // 학습자 × 클래스 → GitHub 레포 매핑. 클래스 단위로 레포 1개를 생성/재사용하기 위한 식별 테이블.
  // 레슨 완료 시 이 매핑을 통해 어느 레포의 어느 폴더에 커밋할지 결정한다.
  const UserClassRepo = sequelize.define('UserClassRepo', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    class_id: {
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
    tableName: 'user_class_repo',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['user_id', 'class_id'], name: 'uniq_user_class_repo' },
    ],
  });

  UserClassRepo.associate = (models) => {
    UserClassRepo.belongsTo(models.User, { foreignKey: 'user_id' });
    UserClassRepo.belongsTo(models.Class, { foreignKey: 'class_id' });
  };

  return UserClassRepo;
};
