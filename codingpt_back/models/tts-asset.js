module.exports = (sequelize, DataTypes) => {
  const TTSAsset = sequelize.define('TTSAsset', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    // 원본 입력 텍스트 (감정 표현 대괄호 포함 그대로)
    text: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    voice_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    model_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'eleven_v3'
    },
    // stability / similarity_boost / style / use_speaker_boost / speed 등
    settings: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    // objectstore 오디오 객체 키: codingpt/tts/library/{id}/audio.mp3
    object_key: {
      type: DataTypes.TEXT,
      allowNull: true,
      unique: true
    },
    duration: {
      type: DataTypes.FLOAT,
      allowNull: true
    },
    file_size: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    // { version, total_duration, alignment: { words, characters } }
    timestamps: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    // sha256(text|voice_id|model_id|canonical(settings)) — dedupe 조회용 (non-unique)
    content_hash: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    // 관리 화면 표시용 파일명 (generateFileName)
    name: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    // 가상 폴더 경로 (이미지처럼 조직화). '' = 루트, 'html/intro' 등
    folder: {
      type: DataTypes.STRING(500),
      allowNull: false,
      defaultValue: ''
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
    tableName: 'tts_asset',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['content_hash'] }
    ]
  });

  // 참조는 slide.contents JSON 안의 tts.assetId 로만 이뤄짐 — FK 연관관계 없음.
  TTSAsset.associate = () => {};

  return TTSAsset;
};
