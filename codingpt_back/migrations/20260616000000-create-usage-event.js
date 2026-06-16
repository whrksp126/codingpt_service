'use strict';

// 사용량 미터링 원천 테이블 — 에이전트 턴 1회당 1행.
// (user_id, created_at) 인덱스가 롤링 윈도우 합산의 핵심.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('usage_event', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      session_id: { type: Sequelize.STRING(128), allowNull: true },
      project_id: { type: Sequelize.STRING(128), allowNull: true },
      cost_usd: { type: Sequelize.DECIMAL(12, 6), allowNull: false, defaultValue: 0 },
      input_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      output_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      cache_read_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      cache_creation_tokens: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      compute_ms: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      metered_units: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      source: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'plan' },
      credit_units_charged: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('usage_event', ['user_id', 'created_at'], { name: 'idx_usage_event_user_created' });
    await queryInterface.addIndex('usage_event', ['user_id', 'source'], { name: 'idx_usage_event_user_source' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('usage_event');
  },
};
