module.exports = (sequelize, DataTypes) => {
  // 알림 채널 — 다른 서비스가 웹훅 URL(token)로 메시지를 보내면 CodingPT 앱에 푸시+대화방으로 쌓인다.
  //  채널마다 PC 한 대의 작업 폴더를 묶어 두면, 그 방에서 바로 에이전트에게 일을 시킨다(외부 세션 ext.* 재사용).
  //  token 은 "이 방에 글을 올릴 권한"만 있다(명령 실행 권한 없음) → 언제든 다시 복사할 수 있게 원문 보관.
  const AlertChannel = sequelize.define('AlertChannel', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(60), allowNull: false },
    description: { type: DataTypes.STRING(300), allowNull: true },
    token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    device_id: { type: DataTypes.INTEGER, allowNull: true },   // AI 가 일할 PC
    cwd: { type: DataTypes.TEXT, allowNull: true },            // AI 가 일할 폴더(그 PC 의 절대경로)
    agent: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'claude' },
    agent_mode: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'default' },
    use_worktree: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    muted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_via: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'app' }, // app | api
    api_key_id: { type: DataTypes.INTEGER, allowNull: true },  // api 로 만들었다면 그 키
    thread_id: { type: DataTypes.STRING(120), allowNull: true }, // 지금 이어 가는 AI 대화
    agent_cursor: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    agent_state: { type: DataTypes.STRING(16), allowNull: true }, // working | waiting | idle | stopped | error
    unread_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_message_at: { type: DataTypes.DATE, allowNull: true },
    last_preview: { type: DataTypes.STRING(200), allowNull: true },
    last_level: { type: DataTypes.STRING(12), allowNull: true },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'alert_channel', timestamps: false, underscored: true });
  return AlertChannel;
};
