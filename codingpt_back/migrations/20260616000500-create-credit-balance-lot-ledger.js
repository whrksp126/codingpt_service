'use strict';

// 크레딧 잔액 + lot(FIFO·1년 만료) + 원장(정본).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('credit_balance', {
      user_id: { type: Sequelize.INTEGER, primaryKey: true },
      balance_units: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.createTable('credit_lot', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      source_payment_id: { type: Sequelize.STRING(255), allowNull: true },
      granted_units: { type: Sequelize.BIGINT, allowNull: false },
      remaining_units: { type: Sequelize.BIGINT, allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('credit_lot', ['user_id', 'expires_at'], { name: 'idx_credit_lot_user_expires' });

    await queryInterface.createTable('credit_ledger', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      delta_units: { type: Sequelize.BIGINT, allowNull: false },
      reason: { type: Sequelize.STRING(24), allowNull: false },
      balance_after: { type: Sequelize.BIGINT, allowNull: false },
      ref_type: { type: Sequelize.STRING(24), allowNull: true },
      ref_id: { type: Sequelize.STRING(64), allowNull: true },
      memo: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('credit_ledger', ['user_id', 'created_at'], { name: 'idx_credit_ledger_user_created' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('credit_ledger');
    await queryInterface.dropTable('credit_lot');
    await queryInterface.dropTable('credit_balance');
  },
};
