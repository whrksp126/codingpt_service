'use strict';

/**
 * M5 Slice5 — 실행시간(초) 과금 스키마.
 *
 * BYO 원격조작에선 우리가 사용자 토큰 비용(cost_usd)을 볼 수 없다. 계측 대상은 오직
 * "클라우드 컨테이너 실행시간(초)"이며 로컬 러너는 무제한(미계측)이다. 그래서 플랜 한도를
 * 토큰 unit(window_unit_limit/weekly_unit_limit, 존치)과 별개로 **초 쿼터**로 표현한다.
 *
 *  - subscription_plan.window_seconds_limit : 롤링 윈도우(window_seconds)당 허용 클라우드 실행시간(초). 0=무제한
 *  - subscription_plan.weekly_seconds_limit : 주간 캡(초). null=주간 캡 없음
 *  - daemon_device.container_started_at      : cloud 컨테이너 기동 시각(정지 시 span=now-이 값 → usage_event.compute_ms)
 *
 * 모델: models/subscription-plan.js, models/daemon-device.js
 * ⚠️ 실판매/강제는 별개 스위치(SUBSCRIPTION_SALES_ENABLED / BILLING_ENFORCE)로 제어 — 이 마이그레이션은 스키마+한도값만.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('subscription_plan', 'window_seconds_limit', {
      type: Sequelize.BIGINT, allowNull: false, defaultValue: 0, // 0=무제한
    });
    await queryInterface.addColumn('subscription_plan', 'weekly_seconds_limit', {
      type: Sequelize.BIGINT, allowNull: true, // null=주간 캡 없음
    });
    await queryInterface.addColumn('daemon_device', 'container_started_at', {
      type: Sequelize.DATE, allowNull: true,
    });

    // 초 쿼터 시드(클라우드 실행시간). 로컬은 무제한이라 무관. 값은 운영 실측 전 잠정 — 튜닝 대상.
    //  free: 윈도우 30분 / 주간 2시간 · pro: 5시간 / 40시간 · max: 10시간 / 200시간
    const seed = [
      { code: 'free', win: 1800, week: 7200 },
      { code: 'pro', win: 18000, week: 144000 },
      { code: 'max', win: 36000, week: 720000 },
    ];
    for (const s of seed) {
      await queryInterface.sequelize.query(
        'UPDATE subscription_plan SET window_seconds_limit = :win, weekly_seconds_limit = :week WHERE code = :code',
        { replacements: { win: s.win, week: s.week, code: s.code } },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('daemon_device', 'container_started_at');
    await queryInterface.removeColumn('subscription_plan', 'weekly_seconds_limit');
    await queryInterface.removeColumn('subscription_plan', 'window_seconds_limit');
  },
};
