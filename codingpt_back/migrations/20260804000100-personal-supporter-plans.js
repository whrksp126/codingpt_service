'use strict';

// BYO 개인 원격 워크스페이스 피벗의 상품 정본.
// - free 행은 내부 호환을 위해 code 를 유지하되 사용자 표시를 Personal 로 바꾼다.
// - Supporter 는 핵심 기능을 잠그지 않는 선택형 월 후원 구독이다.
// - 과거 cloud AI 용 Pro/Max 는 기존 구독/영수증 참조를 위해 행은 보존하고 신규 카탈로그에서만 숨긴다.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE subscription_plan
          SET name = 'Personal',
              price_krw = 0,
              window_unit_limit = 0,
              weekly_unit_limit = NULL,
              window_seconds_limit = 0,
              weekly_seconds_limit = NULL,
              tagline = '내 PC의 AI 코딩을 어디서나 그대로 이어서 사용하세요.',
              features = CAST(:personalFeatures AS jsonb),
              badge = NULL,
              highlight = false,
              display_multiplier = NULL,
              is_active = true,
              sort_order = 0,
              updated_at = NOW()
        WHERE code = 'free'`,
      {
        replacements: {
          personalFeatures: JSON.stringify([
            '외부망 원격 연결과 모바일 푸시',
            '채팅·터미널·IDE·웹 프리뷰',
            '개인 기기 등록 무제한',
          ]),
        },
      },
    );

    await queryInterface.sequelize.query(
      `INSERT INTO subscription_plan
         (code, name, price_krw, window_seconds, window_unit_limit, weekly_unit_limit,
          window_seconds_limit, weekly_seconds_limit, billing_period, is_active, sort_order,
          tagline, features, badge, highlight, display_multiplier,
          apple_product_id, google_product_id, created_at, updated_at)
       VALUES
         ('supporter', 'Supporter', 4900, 18000, 0, NULL,
          0, NULL, 'monthly', true, 1,
          'Personal의 모든 기능은 그대로. CodingPT의 지속적인 개발과 운영을 응원해 주세요.',
          CAST(:supporterFeatures AS jsonb), '선택형 후원', true, NULL,
          NULL, NULL, NOW(), NOW())
       ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          price_krw = EXCLUDED.price_krw,
          window_seconds = EXCLUDED.window_seconds,
          window_unit_limit = EXCLUDED.window_unit_limit,
          weekly_unit_limit = EXCLUDED.weekly_unit_limit,
          window_seconds_limit = EXCLUDED.window_seconds_limit,
          weekly_seconds_limit = EXCLUDED.weekly_seconds_limit,
          billing_period = EXCLUDED.billing_period,
          is_active = EXCLUDED.is_active,
          sort_order = EXCLUDED.sort_order,
          tagline = EXCLUDED.tagline,
          features = EXCLUDED.features,
          badge = EXCLUDED.badge,
          highlight = EXCLUDED.highlight,
          display_multiplier = EXCLUDED.display_multiplier,
          apple_product_id = NULL,
          google_product_id = NULL,
          updated_at = NOW()`,
      {
        replacements: {
          supporterFeatures: JSON.stringify([
            'Personal의 모든 기능',
            'Personal과 동일한 기기 무제한 이용',
            'CodingPT 개발과 서버 운영 후원',
          ]),
        },
      },
    );

    await queryInterface.sequelize.query(
      `UPDATE subscription_plan
          SET is_active = false, updated_at = NOW()
        WHERE code IN ('pro', 'max')`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM subscription_plan WHERE code = 'supporter'`);
    await queryInterface.sequelize.query(
      `UPDATE subscription_plan
          SET name = 'Free', is_active = true, updated_at = NOW()
        WHERE code = 'free'`,
    );
    await queryInterface.sequelize.query(
      `UPDATE subscription_plan
          SET is_active = true, updated_at = NOW()
        WHERE code IN ('pro', 'max')`,
    );
  },
};
