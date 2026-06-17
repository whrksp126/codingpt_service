'use strict';

// 유료 플랜에 스토어 상품 ID 시드 (멱등 by code). Apple·Google 동일 식별자 사용.
//  pro → codingpt_pro_monthly, max → codingpt_max_monthly. free 는 결제 없음(null 유지).
// 이 값이 RC 웹훅의 product_id → 플랜 매핑 근거가 된다. App Store Connect / Play Console 에
// 동일 product id 로 자동갱신 구독을 등록해야 함(가격은 스토어에서 ₩24,900 / ₩129,000 로 설정).
// 어드민/스토어에서 product id 를 바꾸면 이 컬럼도 함께 맞춘다.

const PRODUCT_IDS = {
  pro: 'codingpt_pro_monthly',
  max: 'codingpt_max_monthly',
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    for (const [code, pid] of Object.entries(PRODUCT_IDS)) {
      await queryInterface.sequelize.query(
        `UPDATE subscription_plan
            SET apple_product_id = :pid, google_product_id = :pid, updated_at = NOW()
          WHERE code = :code`,
        { replacements: { pid, code } },
      );
    }
  },

  // 데이터 시드 — 롤백 시 product id 만 비움.
  async down(queryInterface) {
    for (const code of Object.keys(PRODUCT_IDS)) {
      await queryInterface.sequelize.query(
        `UPDATE subscription_plan
            SET apple_product_id = NULL, google_product_id = NULL, updated_at = NOW()
          WHERE code = :code`,
        { replacements: { code } },
      );
    }
  },
};
