module.exports = (sequelize, DataTypes) => {
    const StudyHeatmapLog = sequelize.define('StudyHeatmapLog', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        product_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        section_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        lesson_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        created_at: {
            type: DataTypes.DATE,
            allowNull: false
        },
    },
    {
        tableName: 'study_heatmap_log',
        timestamps: false,
    });
  
    StudyHeatmapLog.associate = (models) => {
        StudyHeatmapLog.belongsTo(models.User, { foreignKey: 'user_id' });
        StudyHeatmapLog.belongsTo(models.Product, { foreignKey: 'product_id' });
        StudyHeatmapLog.belongsTo(models.Section, { foreignKey: 'section_id' });
        StudyHeatmapLog.belongsTo(models.Lesson, { foreignKey: 'lesson_id' });
    };
  
    return StudyHeatmapLog;
  };