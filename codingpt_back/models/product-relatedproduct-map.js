module.exports = (sequelize, DataTypes) => {
    const ProductRelatedProductMap = sequelize.define('ProductRelatedProductMap', {
      product_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      relatedproduct_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
    }, {
      tableName: 'product_relatedproduct_map',
      timestamps: false,
    });
  
    ProductRelatedProductMap.associate = (models) => {
      ProductRelatedProductMap.belongsTo(models.Product, { foreignKey: 'product_id' });
      ProductRelatedProductMap.belongsTo(models.Product, { foreignKey: 'relatedproduct_id', as: 'RelatedProduct' });
    };
  
    return ProductRelatedProductMap;
  };