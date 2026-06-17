'use strict';

// 구독 플랜에 사용자 표시용 카피 컬럼 추가 — 단일 출처(웹/앱이 /api/subscription/plans 로 동적 렌더).
// tagline(한 줄 설명), features(불릿 배열 JSONB), badge(예: "가장 인기"), highlight(강조 카드),
// display_multiplier(예: "5x"). 어드민에서 실시간 편집.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('subscription_plan', 'tagline', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn('subscription_plan', 'features', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('subscription_plan', 'badge', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.addColumn('subscription_plan', 'highlight', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn('subscription_plan', 'display_multiplier', { type: Sequelize.STRING(16), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('subscription_plan', 'display_multiplier');
    await queryInterface.removeColumn('subscription_plan', 'highlight');
    await queryInterface.removeColumn('subscription_plan', 'badge');
    await queryInterface.removeColumn('subscription_plan', 'features');
    await queryInterface.removeColumn('subscription_plan', 'tagline');
  },
};
