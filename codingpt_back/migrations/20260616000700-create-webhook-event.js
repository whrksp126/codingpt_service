'use strict';

// PortOne 웹훅 원본 로그.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('webhook_event', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      provider: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'portone' },
      event_type: { type: Sequelize.STRING(64), allowNull: true },
      payment_id: { type: Sequelize.STRING(255), allowNull: true },
      signature_valid: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      raw_body: { type: Sequelize.TEXT, allowNull: true },
      processed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('webhook_event', ['payment_id'], { name: 'idx_webhook_event_payment' });
    await queryInterface.addIndex('webhook_event', ['processed', 'received_at'], { name: 'idx_webhook_event_processed' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('webhook_event');
  },
};
