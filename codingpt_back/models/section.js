module.exports = (sequelize, DataTypes) => {
  const Section = sequelize.define('Section', {
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
    doc_concept: {
      type: DataTypes.JSON,
      allowNull: false
    },
  }, {
    tableName: 'section',
    timestamps: false,
  });

  Section.associate = (models) => {
    Section.hasMany(models.SectionLessonMap, { foreignKey: 'section_id' });
    Section.belongsToMany(models.Class, {
      through: models.ClassSectionMap,
      foreignKey: 'section_id',
      otherKey: 'class_id',
      timestamps: false,
      as: 'Classes',
    });
    Section.belongsToMany(models.Lesson, {
      through: models.SectionLessonMap,
      foreignKey: 'section_id',
      otherKey: 'lesson_id',
      timestamps: false,
      as: 'Lessons',
    });
    Section.hasMany(models.StudyHeatmapLog, { foreignKey: 'section_id' });
  };  

  return Section;
};