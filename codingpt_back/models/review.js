module.exports = (sequelize, DataTypes) => {
  const Review = sequelize.define('Review', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    score: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    review_text: {
      type: DataTypes.STRING,
      allowNull: false
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
  }, {
    tableName: 'review',
    timestamps: false,
  });

  Review.associate = (models) => {
    Review.belongsTo(models.User, { foreignKey: 'user_id' });
    Review.hasMany(models.ProductReviewMap, { foreignKey: 'review_id' });
  };

  return Review;
};