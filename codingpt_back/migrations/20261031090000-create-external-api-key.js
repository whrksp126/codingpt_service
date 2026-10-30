'use strict';

// 외부 서비스가 내 PC 의 에이전트를 부를 때 쓰는 키. 키는 PC 한 대에 묶인다. 원문은 저장하지 않고 sha256 만 보관한다.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('external_api_key', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      device_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'daemon_device', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(60), allowNull: false },
      key_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      key_prefix: { type: Sequelize.STRING(16), allowNull: false },
      allowed_paths: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      allow_bypass: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('external_api_key', ['user_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('external_api_key');
  },
};
