module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false
    },
    google_id: {
      type: DataTypes.STRING,
      allowNull: true // Apple 전용 계정은 google_id 가 없다(로그인 수단은 login_type 으로 구분).
    },
    apple_id: {
      type: DataTypes.STRING, // Apple 'sub'(계정당 안정적 식별자). 이메일 비공개 릴레이 대비 정본 키.
      allowNull: true
    },
    apple_refresh_token: {
      type: DataTypes.TEXT, // authorizationCode 교환으로 얻은 refresh_token. 탈퇴 시 revoke(5.1.1(v)).
      allowNull: true
    },
    apple_client_id: {
      type: DataTypes.STRING, // 위 토큰이 발급된 client_id(번들ID/ServicesID) — revoke 에 동일 값 필요.
      allowNull: true
    },
    refresh_token: {
      type: DataTypes.STRING,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    profile_img: {
      type: DataTypes.STRING
    },
    nickname: {
      type: DataTypes.STRING,
      allowNull: false
    },
    xp: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    role: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'user',
    },
    password_hash: {
      type: DataTypes.STRING(255), // 심사용 ID/PW 계정만 사용(scrypt). 소셜 계정은 null.
      allowNull: true,
    },
    login_type: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'google',
    },
    // 저장된 결제 수단(빌링키) — 무료 계정도 카드 등록 가능. 구독 시 재사용/표시.
    billing_key: { type: DataTypes.STRING(255), allowNull: true },
    card_brand: { type: DataTypes.STRING(32), allowNull: true },
    card_last4: { type: DataTypes.STRING(4), allowNull: true },
    // 모양 설정(계정 전체 동기화) — {uiFont, codeFont, termStyle}. 변경 시 appearance_event 팬아웃.
    appearance: { type: DataTypes.JSONB, allowNull: true },
  }, {
    tableName: 'user',
    timestamps: false,
  });

  User.associate = (models) => {
    User.hasMany(models.Review, { foreignKey: 'user_id' });
    User.hasMany(models.MyClass, { foreignKey: 'user_id' });
    User.hasMany(models.StudyHeatmapLog, { foreignKey: 'user_id' });
    User.hasOne(models.UserGithubConnection, { foreignKey: 'user_id' });
    User.hasMany(models.UserGithubRepo, { foreignKey: 'user_id' });
    User.hasMany(models.UsageEvent, { foreignKey: 'user_id' });
  };

  return User;
};