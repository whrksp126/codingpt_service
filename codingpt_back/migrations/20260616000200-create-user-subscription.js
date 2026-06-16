'use strict';

// 사용자 구독 상태. 활성 구독은 사용자당 1개(부분 유니크 인덱스).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_subscription', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      plan_id: { type: Sequelize.INTEGER, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active' },
      billing_key: { type: Sequelize.STRING(255), allowNull: true },
      current_period_start: { type: Sequelize.DATE, allowNull: true },
      current_period_end: { type: Sequelize.DATE, allowNull: true },
      cancel_at_period_end: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      renewal_attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_payment_id: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('user_subscription', ['user_id', 'status'], { name: 'idx_user_subscription_user_status' });
    await queryInterface.addIndex('user_subscription', ['status', 'current_period_end'], { name: 'idx_user_subscription_status_period' });
    // 활성 구독은 사용자당 1개 — 부분 유니크 인덱스
    await queryInterface.addIndex('user_subscription', ['user_id'], {
      name: 'uq_user_subscription_one_active',
      unique: true,
      where: { status: 'active' },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_subscription');
  },
};
