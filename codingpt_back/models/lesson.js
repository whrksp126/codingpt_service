module.exports = (sequelize, DataTypes) => {
  const Lesson = sequelize.define('Lesson', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    order_no: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '이론'
    },
    description: {
      type: DataTypes.STRING
    },
    default_character: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    characters: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: []
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {}
    },
    published_at: {
      type: DataTypes.DATE,
      allowNull: true
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
    tableName: 'lesson',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  Lesson.associate = (models) => {
    Lesson.hasMany(models.MyClassStatus, { foreignKey: 'lesson_id' });
    Lesson.hasMany(models.StudyHeatmapLog, { foreignKey: 'lesson_id' });
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
};
