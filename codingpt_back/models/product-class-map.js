module.exports = (sequelize, DataTypes) => {
    const ProductClassMap = sequelize.define('ProductClassMap', {
      product_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      class_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
    }, {
      tableName: 'product_class_map',
      timestamps: false,
    });
  
    ProductClassMap.associate = (models) => {
      ProductClassMap.belongsTo(models.Product, { foreignKey: 'product_id' });
      ProductClassMap.belongsTo(models.Class, { foreignKey: 'class_id' });
    };
  
    return ProductClassMap;
  };