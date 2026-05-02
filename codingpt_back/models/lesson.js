module.exports = (sequelize, DataTypes) => {
  const Lesson = sequelize.define('Lesson', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    order_no: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type:
      DataTypes.STRING
    },
  }, {
    tableName: 'lesson',
    timestamps: false,
  });

  Lesson.associate = (models) => {
    Lesson.hasMany(models.MyClassStatus, { foreignKey: 'lesson_id' });
    Lesson.hasMany(models.StudyHeatmapLog, { foreignKey: 'lesson_id' });
    // Lesson.hasMany(models.SectionLessonMap, { foreignKey: 'lesson_id' });
    // Lesson.hasMany(models.LessonSlideMap, { foreignKey: 'lesson_id' });
    Lesson.belongsToMany(models.Slide, {
      through: models.LessonSlideMap,
      foreignKey: 'lesson_id',
      otherKey: 'slide_id',
      timestamps: false,
      as: 'Slides',
    });
    Lesson.belongsToMany(models.Section, {
      through: models.SectionLessonMap,
      foreignKey: 'lesson_id',
      otherKey: 'section_id',
      timestamps: false,
      as: 'Sections',
    });
  };  

  return Lesson;
}