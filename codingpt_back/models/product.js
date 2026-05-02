module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define('Product', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    price: {
      type: DataTypes.INTEGER, allowNull: false,
      defaultValue: 0
    },
    lecture_intro: {
      type: DataTypes.JSON
    },
    category: {
      type: DataTypes.STRING
    },
    difficulty: {
      type: DataTypes.STRING
    },
  }, {
    tableName: 'product',
    timestamps: false,
  });

  Product.associate = (models) => {
    Product.hasMany(models.MyClass, { foreignKey: 'product_id' });
    Product.hasMany(models.ProductReviewMap, { foreignKey: 'product_id' });
    Product.hasMany(models.ProductRelatedProductMap, { foreignKey: 'product_id' });
    Product.hasMany(models.ProductRelatedProductMap, { foreignKey: 'relatedproduct_id', as: 'RelatedProduct' });
    Product.hasMany(models.ProductCurriculumMap, { foreignKey: 'product_id' });
    Product.belongsToMany(models.Class, {
      through: models.ProductClassMap,
      foreignKey: 'product_id',
      otherKey: 'class_id',
      timestamps: false,
      as: 'Classes',
    });
    Product.belongsToMany(models.StoreCategory, {
      through: models.StoreCategoryProductMap,
      foreignKey: 'product_id',
      otherKey: 'category_id',
      as: 'Categories',
    });
    Product.hasMany(models.StudyHeatmapLog, { foreignKey: 'product_id' });
  };

  return Product;
};