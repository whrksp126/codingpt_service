module.exports = (sequelize, DataTypes) => {
  const TTSSavedFile = sequelize.define('TTSSavedFile', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'user',
        key: 'id'
      }
    },
    tts_request_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'tts_requests',
        key: 'id'
      }
    },
    s3_path: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    file_name: {
      type: DataTypes.STRING(500),
      allowNull: false
    },
    original_text: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    voice_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    model_id: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    settings: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    timestamps: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    file_size: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    duration: {
      type: DataTypes.FLOAT,
      allowNull: true
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'tts_saved_files',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  TTSSavedFile.associate = (models) => {
    TTSSavedFile.belongsTo(models.User, { foreignKey: 'user_id' });
    TTSSavedFile.belongsTo(models.TTSRequest, { foreignKey: 'tts_request_id' });
  };

  return TTSSavedFile;
};

