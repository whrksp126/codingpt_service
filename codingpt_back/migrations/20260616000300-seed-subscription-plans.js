'use strict';

// 구독 플랜 시드 (멱등 upsert by code).
// ⚠️ 가격·한도는 PLACEHOLDER — Phase 1 실측 데이터로 갱신 필요.
//   window_unit_limit/weekly_unit_limit 은 마진 포함 정규화 unit (config/billing.js 참조).
//   기준: 1 unit ≈ $0.000001 원가 × MARKUP(1.75). 예) 윈도우당 $3 원가 ≈ 5,250,000 unit.

const PLANS = [
  // code, name, price_krw, window_seconds, window_unit_limit, weekly_unit_limit, sort_order
  ['free', 'Free', 0, 18000, 500000, 2000000, 0],
  ['pro', 'Pro', 20000, 18000, 5000000, 70000000, 1],
  ['max', 'Max', 100000, 18000, 25000000, 350000000, 2],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    for (const [code, name, price, ws, wl, weekl, sort] of PLANS) {
      await queryInterface.sequelize.query(
        `INSERT INTO subscription_plan
           (code, name, price_krw, window_seconds, window_unit_limit, weekly_unit_limit, billing_period, is_active, sort_order, created_at, updated_at)
         VALUES (:code, :name, :price, :ws, :wl, :weekl, 'monthly', true, :sort, NOW(), NOW())
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           price_krw = EXCLUDED.price_krw,
           window_seconds = EXCLUDED.window_seconds,
           window_unit_limit = EXCLUDED.window_unit_limit,
           weekly_unit_limit = EXCLUDED.weekly_unit_limit,
           sort_order = EXCLUDED.sort_order,
           updated_at = NOW()`,
        { replacements: { code, name, price, ws, wl, weekl, sort } },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM subscription_plan WHERE code IN ('free', 'pro', 'max')`,
    );
  },
};
