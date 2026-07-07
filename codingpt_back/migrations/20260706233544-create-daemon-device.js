'use strict';

// BYO-PC 데몬 기기 등록 테이블. 모델: models/daemon-device.js
// 페어링 시 생성, device token 은 sha256 해시만 보관(token_hash).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('daemon_device', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'user', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      device_name: { type: Sequelize.STRING(128), allowNull: false },
      platform: { type: Sequelize.STRING(32), allowNull: true },
      daemon_version: { type: Sequelize.STRING(32), allowNull: true },
      token_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      last_seen_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('daemon_device', ['user_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('daemon_device');
  },
};
