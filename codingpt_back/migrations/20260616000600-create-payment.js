'use strict';

// PortOne 결제 1건(충전/구독 공통). payment_id 멱등키.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('payment', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      payment_id: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      type: { type: Sequelize.STRING(16), allowNull: false },
      channel: { type: Sequelize.STRING(24), allowNull: true },
      ref_id: { type: Sequelize.INTEGER, allowNull: true },
      amount_krw: { type: Sequelize.INTEGER, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'ready' },
      pg_tx_id: { type: Sequelize.STRING(255), allowNull: true },
      billing_key: { type: Sequelize.STRING(255), allowNull: true },
      customer_uid: { type: Sequelize.STRING(255), allowNull: true },
      raw_response: { type: Sequelize.JSONB, allowNull: true },
      paid_at: { type: Sequelize.DATE, allowNull: true },
      cancelled_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('payment', ['user_id', 'status'], { name: 'idx_payment_user_status' });
    await queryInterface.addIndex('payment', ['type', 'status'], { name: 'idx_payment_type_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payment');
  },
};
