module.exports = (sequelize, DataTypes) => {
    const MyClassStatus = sequelize.define('MyClassStatus', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      myclass_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      lesson_id: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      status: {
        type: DataTypes.INTEGER, allowNull:
        false, defaultValue: 1
      }, 
      results: {
        type: DataTypes.JSON,
        allowNull: false
      },
    }, {
      tableName: 'myclass_status',
      timestamps: false,
    });
  
    MyClassStatus.associate = (models) => {
      MyClassStatus.belongsTo(models.MyClass, { foreignKey: 'myclass_id' });
      MyClassStatus.belongsTo(models.Lesson, { foreignKey: 'lesson_id' });
    };
  
    return MyClassStatus;
  };