'use strict';

// 구독 플랜 카탈로그.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('subscription_plan', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(64), allowNull: false },
      price_krw: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      window_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 18000 },
      window_unit_limit: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      weekly_unit_limit: { type: Sequelize.BIGINT, allowNull: true },
      billing_period: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'monthly' },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('subscription_plan');
  },
};
