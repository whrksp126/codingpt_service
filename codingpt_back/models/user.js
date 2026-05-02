module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false
    },
    google_id: {
      type: DataTypes.STRING,
      allowNull: false
    },
    refresh_token: {
      type: DataTypes.STRING,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    profile_img: {
      type: DataTypes.STRING
    },
    nickname: {
      type: DataTypes.STRING,
      allowNull: false
    },
    xp: {
      type: DataTypes.INTEGER, 
      allowNull: false,
      defaultValue: 0
    },
    heart: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5
    },
    heart_missing: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    hearts_refill_started_at: {
      type: DataTypes.DATE
    },
  }, {
    tableName: 'user',
    timestamps: false,
  });

  User.associate = (models) => {
    User.hasMany(models.Review, { foreignKey: 'user_id' });
    User.hasMany(models.MyClass, { foreignKey: 'user_id' });
    User.hasMany(models.StudyHeatmapLog, { foreignKey: 'user_id' });
  };

  return User;
};