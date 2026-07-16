'use strict';

// 알림 동기화 테이블. 모델: models/notification.js
// 모바일/PC 클라이언트가 공유하는 알림 인박스 — 에이전트 이벤트(done/승인대기/오류)·클라이언트 발행 알림을
// 서버에 영속화하고, WSS/SSE(notif_event)로 라이브 팬아웃 + 미접속 시 FCM 으로 보낸다.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('notification', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'user', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      source: { type: Sequelize.STRING(16), allowNull: false }, // agent | pc | mobile | system 등 발행 주체
      kind: { type: Sequelize.STRING(32), allowNull: true }, // done | permission_request | error 등
      title: { type: Sequelize.STRING(200), allowNull: false },
      subtitle: { type: Sequelize.STRING(300), allowNull: true }, // 비어있으면 서버가 kind+ws_name 으로 조합
      body: { type: Sequelize.TEXT, allowNull: true },
      workspace_id: { type: Sequelize.STRING(80), allowNull: true },
      ws_name: { type: Sequelize.STRING(120), allowNull: true },
      cwd: { type: Sequelize.TEXT, allowNull: true }, // 워크스페이스 폴더(스코프 읽음 처리 키)
      win: { type: Sequelize.INTEGER, allowNull: true }, // tmux window(터미널 탭). NULL=ws 수준 알림
      session_id: { type: Sequelize.STRING(120), allowNull: true }, // 에이전트 세션 식별
      read_at: { type: Sequelize.DATE, allowNull: true }, // NULL=미읽음
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    // 목록 조회(최신순 페이지네이션) / 미읽음 카운트 / (cwd,win) 스코프 읽음 처리용 인덱스.
    await queryInterface.addIndex('notification', ['user_id', 'created_at']);
    await queryInterface.addIndex('notification', ['user_id', 'read_at']);
    await queryInterface.addIndex('notification', ['user_id', 'read_at', 'cwd']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('notification');
  },
};
