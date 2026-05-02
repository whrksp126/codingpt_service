module.exports = (sequelize, DataTypes) => {
    const ProductCurriculumMap = sequelize.define('ProductCurriculumMap', {
      product_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      curriculum_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
    }, {
      tableName: 'product_curriculum_map',
      timestamps: false,
    });
  
    ProductCurriculumMap.associate = (models) => {
      ProductCurriculumMap.belongsTo(models.Product, { foreignKey: 'product_id' });
      ProductCurriculumMap.belongsTo(models.Curriculum, { foreignKey: 'curriculum_id' });
    };
  
    return ProductCurriculumMap;
  };