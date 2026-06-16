'use strict';

// 크레딧 충전팩 카탈로그 (환금성). price_krw ≥ 1000 CHECK 제약.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('credit_pack', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(64), allowNull: false },
      price_krw: { type: Sequelize.INTEGER, allowNull: false },
      credit_units: { type: Sequelize.BIGINT, allowNull: false },
      bonus_units: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    // 환금성 심사: 온라인 카드 일시불 최소금액 ₩1,000
    await queryInterface.sequelize.query(
      `ALTER TABLE credit_pack ADD CONSTRAINT chk_credit_pack_min_price CHECK (price_krw >= 1000)`,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('credit_pack');
  },
};
