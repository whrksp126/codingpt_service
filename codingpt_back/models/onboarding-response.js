module.exports = (sequelize, DataTypes) => {
  // 온보딩 설문 응답(마케팅 리드). 로그인 전 익명 수집되므로 anon_id 가 기기별 upsert 키이고
  // user_id 는 nullable — 구글 로그인 성공 시 해당 anon_id 레코드에 user_id 를 연결한다.
  // 로그인을 끝내지 않은 사용자의 응답도 보존되어, 추후 관리자단에서 조회 가능하다.
  const OnboardingResponse = sequelize.define('OnboardingResponse', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    anon_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    job: {
      type: DataTypes.STRING(64),       // 직업 (단일 선택)
      allowNull: true,
    },
    referral_source: {
      type: DataTypes.STRING(64),       // 유입 경로 (단일 선택)
      allowNull: true,
    },
    ai_experience: {
      type: DataTypes.STRING(64),       // AI 사용 경험 (단일 선택)
      allowNull: true,
    },
    purposes: {
      type: DataTypes.JSONB,            // 사용 목적 (복수 선택, 문자열 배열)
      allowNull: true,
    },
    completed_at: {
      type: DataTypes.DATE,             // 개인화 완료(설문 제출) 시각
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'onboarding_response',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  OnboardingResponse.associate = (models) => {
    OnboardingResponse.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return OnboardingResponse;
};
