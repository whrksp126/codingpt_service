'use strict';

// 사용자 레벨 결제 수단 — 무료 계정도 카드를 등록/변경할 수 있게(구독에 종속되지 않음).
// 구독 시 빌링키 재사용/표시. card_brand/card_last4 는 표시용(시크릿 아님).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'billing_key', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn('user', 'card_brand', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.addColumn('user', 'card_last4', { type: Sequelize.STRING(4), allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('user', 'card_last4');
    await queryInterface.removeColumn('user', 'card_brand');
    await queryInterface.removeColumn('user', 'billing_key');
  },
};
