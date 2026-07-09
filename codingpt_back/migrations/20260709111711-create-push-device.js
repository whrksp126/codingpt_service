'use strict';

// 푸시 기기 등록 테이블(M3-3). 모델: models/push-device.js
// 앱(모바일)이 FCM/APNs 디바이스 토큰을 등록 → 서버가 done/승인대기/크래시 시 발송.
// 한 사용자가 여러 기기 가능. token 은 provider 발급 원문(재발급 시 upsert).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('push_device', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'user', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      platform: { type: Sequelize.STRING(16), allowNull: false }, // ios | android | web
      token: { type: Sequelize.STRING(512), allowNull: false, unique: true }, // FCM/APNs 디바이스 토큰
      provider: { type: Sequelize.STRING(16), allowNull: true }, // fcm | apns | expo (발송 경로)
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true }, // 발송 실패 누적/사용자 off 시 false
      last_seen_at: { type: Sequelize.DATE, allowNull: true }, // 마지막 등록/갱신 시각
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('push_device', ['user_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('push_device');
  },
};
