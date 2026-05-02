module.exports = (sequelize, DataTypes) => {
    const ProductReviewMap = sequelize.define('ProductReviewMap', {
      product_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true
      },
      review_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        primaryKey: true
      },
    }, {
      tableName: 'product_review_map',
      timestamps: false,
      id: false  // 자동 id 컬럼 생성 비활성화
    });
  
    ProductReviewMap.associate = (models) => {
      ProductReviewMap.belongsTo(models.Product, { foreignKey: 'product_id' });
      ProductReviewMap.belongsTo(models.Review, { foreignKey: 'review_id' });
    };
  
    return ProductReviewMap;
  };