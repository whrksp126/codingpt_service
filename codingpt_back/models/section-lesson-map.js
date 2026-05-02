module.exports = (sequelize, DataTypes) => {
    const SectionLessonMap = sequelize.define('SectionLessonMap', {
      section_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      lesson_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
    }, {
      tableName: 'section_lesson_map',
      timestamps: false,
    });
  
    SectionLessonMap.associate = (models) => {
      SectionLessonMap.belongsTo(models.Section, { foreignKey: 'section_id' });
      SectionLessonMap.belongsTo(models.Lesson, { foreignKey: 'lesson_id' });
    };
  
    return SectionLessonMap;
  };
  