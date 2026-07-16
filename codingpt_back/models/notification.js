module.exports = (sequelize, DataTypes) => {
  // 알림 동기화 인박스. 에이전트 이벤트(done/승인대기/오류)·클라이언트(pc/mobile) 발행 알림을 영속화.
  // 라이브 팬아웃(notif_event)은 daemonRelayService, 생성/읽음 처리는 notificationService 가 담당.
  const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'user', key: 'id' } },
    source: { type: DataTypes.STRING(16), allowNull: false }, // agent | pc | mobile | system 등 발행 주체
    kind: { type: DataTypes.STRING(32), allowNull: true }, // done | permission_request | error 등
    title: { type: DataTypes.STRING(200), allowNull: false },
    subtitle: { type: DataTypes.STRING(300), allowNull: true }, // 비어있으면 서버가 kind+ws_name 으로 조합
    body: { type: DataTypes.TEXT, allowNull: true },
    workspace_id: { type: DataTypes.STRING(80), allowNull: true },
    ws_name: { type: DataTypes.STRING(120), allowNull: true },
    cwd: { type: DataTypes.TEXT, allowNull: true }, // 워크스페이스 폴더(스코프 읽음 처리 키)
    win: { type: DataTypes.INTEGER, allowNull: true }, // tmux window(터미널 탭). NULL=ws 수준 알림
    session_id: { type: DataTypes.STRING(120), allowNull: true }, // 에이전트 세션 식별
    read_at: { type: DataTypes.DATE, allowNull: true }, // NULL=미읽음
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'notification',
    timestamps: false,
    indexes: [
      { fields: ['user_id', 'created_at'] },
      { fields: ['user_id', 'read_at'] },
      { fields: ['user_id', 'read_at', 'cwd'] },
    ],
  });

  Notification.associate = (models) => {
    if (models.User) Notification.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return Notification;
};
