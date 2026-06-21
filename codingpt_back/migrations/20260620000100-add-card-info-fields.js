'use strict';

// 결제 수단(카드) 표시용 — 빌링키 발급 시 PortOne 에서 카드 브랜드/끝4자리를 받아 저장.
// 시크릿 아님(마스킹된 표시용). 결제 탭에서 "Mastercard ···3781" 형태로 노출.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_subscription', 'card_brand', {
      type: Sequelize.STRING(32), allowNull: true,
    });
    await queryInterface.addColumn('user_subscription', 'card_last4', {
      type: Sequelize.STRING(4), allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_subscription', 'card_last4');
    await queryInterface.removeColumn('user_subscription', 'card_brand');
  },
};
