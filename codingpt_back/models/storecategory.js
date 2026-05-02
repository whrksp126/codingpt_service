module.exports = (sequelize, DataTypes) => {
  const StoreCategory = sequelize.define('StoreCategory', {
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
    tableName: 'storecategory',
    timestamps: false,
  });

  StoreCategory.associate = (models) => {
    StoreCategory.belongsToMany(models.Product, {
      through: models.StoreCategoryProductMap,
      foreignKey: 'category_id',
      otherKey: 'product_id',
      as: 'Products',
    });
  };

  return StoreCategory;
};
