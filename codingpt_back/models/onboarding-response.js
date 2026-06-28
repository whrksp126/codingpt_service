module.exports = (sequelize, DataTypes) => {
  // 온보딩 설문 응답(익명). 로그인 전 anonId 로 식별 — 같은 기기 재제출 시 upsert(anon_id unique).
  // user_id 는 추후 로그인 연결 시 채울 수 있도록 nullable.
  const OnboardingResponse = sequelize.define('OnboardingResponse', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    anon_id: { type: DataTypes.STRING(128), allowNull: false, unique: true }, // 익명 식별자(앱 getOrCreateAnonId)
    job: { type: DataTypes.STRING(64), allowNull: true }, // 직업
    referral_source: { type: DataTypes.STRING(64), allowNull: true }, // 유입 경로
    ai_experience: { type: DataTypes.STRING(64), allowNull: true }, // AI 사용 수준
    purposes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // 사용 목적(복수)
    user_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'user', key: 'id' } }, // 추후 로그인 연결용
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'onboarding_response',
    timestamps: false,
  });

  OnboardingResponse.associate = (models) => {
    if (models.User) OnboardingResponse.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return OnboardingResponse;
};
