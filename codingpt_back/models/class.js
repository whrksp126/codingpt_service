module.exports = (sequelize, DataTypes) => {
  const Class = sequelize.define('Class', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  }, {
    tableName: 'class',
    timestamps: false,
  });

  Class.associate = (models) => {
    Class.belongsToMany(models.Curriculum, {
      through: models.CurriculumClassMap,
      foreignKey: 'class_id',
      otherKey: 'curriculum_id',
      timestamps: false
    });
    Class.belongsToMany(models.Product, {
      through: models.ProductClassMap,
      foreignKey: 'class_id',
      otherKey: 'product_id',
      timestamps: false,
      as: 'Products',
    });
    Class.belongsToMany(models.Section, {
      through: models.ClassSectionMap,
      foreignKey: 'class_id',
      otherKey: 'section_id',
      timestamps: false,
      as: 'Sections',
    });
  };  

  return Class;
};
