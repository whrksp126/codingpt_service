'use strict';

// 인앱결제(IAP, RevenueCat 경유 Apple/Google) 지원 컬럼 추가.
//  - user_subscription.source / payment.source: 결제 출처(provenance). 'portone'(웹 PG) | 'revenuecat'(스토어 IAP).
//    스토어 구독은 PortOne 갱신 스위퍼에서 제외하기 위해 구분이 필요(잘못된 PG 청구 방지).
//  - subscription_plan.apple_product_id / google_product_id: 스토어 상품 ID ↔ 플랜 매핑 단일 출처.
//    RC 웹훅이 product_id 로 플랜을 찾는다. 어드민에서 편집 가능.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_subscription', 'source', {
      type: Sequelize.STRING(16), allowNull: false, defaultValue: 'portone',
    });
    await queryInterface.addColumn('payment', 'source', {
      type: Sequelize.STRING(16), allowNull: false, defaultValue: 'portone',
    });
    await queryInterface.addColumn('subscription_plan', 'apple_product_id', {
      type: Sequelize.STRING(64), allowNull: true,
    });
    await queryInterface.addColumn('subscription_plan', 'google_product_id', {
      type: Sequelize.STRING(64), allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('subscription_plan', 'google_product_id');
    await queryInterface.removeColumn('subscription_plan', 'apple_product_id');
    await queryInterface.removeColumn('payment', 'source');
    await queryInterface.removeColumn('user_subscription', 'source');
  },
};
