'use strict';

// 알림 채널 — 다른 서비스가 웹훅으로 CodingPT 앱에 알림을 보내고, 그 방에서 바로 PC 에이전트에게 일을 시킨다.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('alert_channel', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(60), allowNull: false },
      description: { type: Sequelize.STRING(300), allowNull: true },
      token: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      device_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'daemon_device', key: 'id' }, onDelete: 'SET NULL' },
      cwd: { type: Sequelize.TEXT, allowNull: true },
      agent: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'claude' },
      agent_mode: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'default' },
      use_worktree: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      muted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_via: { type: Sequelize.STRING(12), allowNull: false, defaultValue: 'app' },
      api_key_id: { type: Sequelize.INTEGER, allowNull: true },
      thread_id: { type: Sequelize.STRING(120), allowNull: true },
      agent_cursor: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      agent_state: { type: Sequelize.STRING(16), allowNull: true },
      unread_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_message_at: { type: Sequelize.DATE, allowNull: true },
      last_preview: { type: Sequelize.STRING(200), allowNull: true },
      last_level: { type: Sequelize.STRING(12), allowNull: true },
      archived_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('alert_channel', ['user_id']);
    await queryInterface.addIndex('alert_channel', ['thread_id']);

    await queryInterface.createTable('alert_channel_message', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      channel_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'alert_channel', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      role: { type: Sequelize.STRING(12), allowNull: false },
      level: { type: Sequelize.STRING(12), allowNull: true },
      title: { type: Sequelize.STRING(200), allowNull: true },
      body: { type: Sequelize.TEXT, allowNull: true },
      url: { type: Sequelize.TEXT, allowNull: true },
      fields: { type: Sequelize.JSONB, allowNull: true },
      source: { type: Sequelize.STRING(60), allowNull: false, defaultValue: '' },
      dedupe_key: { type: Sequelize.STRING(120), allowNull: true },
      repeat_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      thread_id: { type: Sequelize.STRING(120), allowNull: true },
      meta: { type: Sequelize.JSONB, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('alert_channel_message', ['channel_id', 'id']);
    await queryInterface.addIndex('alert_channel_message', ['channel_id', 'dedupe_key']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('alert_channel_message');
    await queryInterface.dropTable('alert_channel');
  },
};
