module.exports = (sequelize, DataTypes) => {
  const Slide = sequelize.define('Slide', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    contents: {
      type: DataTypes.JSON,
      allowNull: false
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
  }, {
    tableName: 'slide',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  Slide.associate = (models) => {
    Slide.hasMany(models.LessonSlideMap, { foreignKey: 'slide_id' });
    Slide.hasMany(models.CodeFillGap, { foreignKey: 'slide_id' });
  };

  return Slide;
};
