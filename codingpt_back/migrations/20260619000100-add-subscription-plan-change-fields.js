'use strict';

// 프로덕션 수준 구독 흐름 지원 컬럼 추가 (플랜 변경/예약·해지 취소·연체·영수증).
//  user_subscription:
//   - scheduled_plan_id : 다운그레이드 예약 대상. 갱신 시 plan_id 로 전환 후 NULL 로 클리어.
//   - canceled_at       : 해지 확정 시각(즉시 해지 또는 기간말 해지가 실제 종료된 시각).
//   - past_due_since     : 연체 진입 시각 → 시간기반 grace 컷오프(DUNNING_GRACE_DAYS) 판정.
//  payment (영수증 메타):
//   - kind               : subscription_initial|renewal|upgrade_proration|plan_change|payment_method_retry|refund
//   - description        : 주문명 스냅샷(영수증 표기)
//   - period_start/end   : 이 결제가 커버하는 구독 기간
//   - refunded_amount_krw: 환불액(부분취소 추적, amount_krw 는 불변 유지)

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_subscription', 'scheduled_plan_id', {
      type: Sequelize.INTEGER, allowNull: true,
    });
    await queryInterface.addColumn('user_subscription', 'canceled_at', {
      type: Sequelize.DATE, allowNull: true,
    });
    await queryInterface.addColumn('user_subscription', 'past_due_since', {
      type: Sequelize.DATE, allowNull: true,
    });

    await queryInterface.addColumn('payment', 'kind', {
      type: Sequelize.STRING(24), allowNull: true,
    });
    await queryInterface.addColumn('payment', 'description', {
      type: Sequelize.STRING(255), allowNull: true,
    });
    await queryInterface.addColumn('payment', 'period_start', {
      type: Sequelize.DATE, allowNull: true,
    });
    await queryInterface.addColumn('payment', 'period_end', {
      type: Sequelize.DATE, allowNull: true,
    });
    await queryInterface.addColumn('payment', 'refunded_amount_krw', {
      type: Sequelize.INTEGER, allowNull: false, defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('payment', 'refunded_amount_krw');
    await queryInterface.removeColumn('payment', 'period_end');
    await queryInterface.removeColumn('payment', 'period_start');
    await queryInterface.removeColumn('payment', 'description');
    await queryInterface.removeColumn('payment', 'kind');
    await queryInterface.removeColumn('user_subscription', 'past_due_since');
    await queryInterface.removeColumn('user_subscription', 'canceled_at');
    await queryInterface.removeColumn('user_subscription', 'scheduled_plan_id');
  },
};
