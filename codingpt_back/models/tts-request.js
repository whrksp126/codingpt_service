module.exports = (sequelize, DataTypes) => {
  const TTSRequest = sequelize.define('TTSRequest', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true, // 인증되지 않은 사용자 허용
      references: {
        model: 'user',
        key: 'id'
      }
    },
    voice_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    model_id: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    text: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    text_with_emotions: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    settings: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    audio_url: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    audio_s3_path: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    timestamps: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    file_name: {
      type: DataTypes.STRING(500),
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
    status: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'pending'
    },
    is_saved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    s3_save_path: {
      type: DataTypes.TEXT,
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
    tableName: 'tts_requests',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  TTSRequest.associate = (models) => {
    TTSRequest.belongsTo(models.User, { foreignKey: 'user_id' });
    TTSRequest.hasOne(models.TTSSavedFile, { foreignKey: 'tts_request_id' });
  };

  return TTSRequest;
};

