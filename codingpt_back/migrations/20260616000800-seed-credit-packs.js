'use strict';

// 크레딧 충전팩 시드 (멱등 upsert by code).
// ⚠️ 가격·unit 은 PLACEHOLDER — 실측(환율·마진) 후 갱신.
//   units_per_krw ≈ USD_TO_UNIT / 환율. 마진은 metered_units 에 이미 반영되어 KRW→unit 직매핑.
//   예) 환율 ₩1,300/USD, USD_TO_UNIT 1e6 → ≈ 769 units/KRW.

const PACKS = [
  // code, name, price_krw(≥1000), credit_units, bonus_units, sort_order
  ['credit_1000', '₩1,000 충전', 1000, 750000, 0, 0],
  ['credit_5000', '₩5,000 충전', 5000, 3750000, 150000, 1],
  ['credit_10000', '₩10,000 충전', 10000, 7500000, 500000, 2],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    for (const [code, name, price, units, bonus, sort] of PACKS) {
      await queryInterface.sequelize.query(
        `INSERT INTO credit_pack
           (code, name, price_krw, credit_units, bonus_units, is_active, sort_order, created_at, updated_at)
         VALUES (:code, :name, :price, :units, :bonus, true, :sort, NOW(), NOW())
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           price_krw = EXCLUDED.price_krw,
           credit_units = EXCLUDED.credit_units,
           bonus_units = EXCLUDED.bonus_units,
           sort_order = EXCLUDED.sort_order,
           updated_at = NOW()`,
        { replacements: { code, name, price, units, bonus, sort } },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM credit_pack WHERE code IN ('credit_1000', 'credit_5000', 'credit_10000')`,
    );
  },
};
