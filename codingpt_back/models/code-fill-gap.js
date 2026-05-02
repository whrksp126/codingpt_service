module.exports = (sequelize, DataTypes) => {
  const CodeFillGap = sequelize.define('CodeFillGap', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    slide_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
  }, {
    tableName: 'code_fill_gap',
    timestamps: false,
  });

  CodeFillGap.associate = (models) => {
    CodeFillGap.belongsTo(models.Slide, { foreignKey: 'slide_id' });
  };

  return CodeFillGap;
};

