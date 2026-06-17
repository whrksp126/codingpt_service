'use strict';

// 구독 플랜 한도 보정 + 카피 시드 (멱등 upsert by code).
// 한도 근거(공식 가격 검증 2026-06, platform.claude.com/docs/pricing):
//   Sonnet 4.6 입력 $3 / 출력 $15 / 캐시읽기 $0.30 per 1M. unit = 원가$ × 1,750,000(마진 1.75).
//   월 최대 원가 = weekly_unit_limit × 4.348주 ÷ 1.75M. 목표: 풀 사용해도 원가 ≤ 매출 40%(세금·수수료 후 손에 ~38%).
//   free=채팅 전용(워크스페이스 차단, agentController 게이트), pro 1x, max = pro × 5.
// 값은 어드민(/admin/plans)에서 실시간 조절 가능 — 실측 후 보정.

const PLANS = [
  {
    code: 'free', name: 'Free', price: 0, ws: 18000, wl: 50000, weekl: 150000, sort: 0,
    tagline: '코딩이 처음인 분께. 부담 없이 먼저 경험해 보세요.',
    features: ['AI 채팅으로 코딩 질문', '5시간마다 사용량 자동 충전', '워크스페이스는 Pro부터'],
    badge: null, highlight: false, mult: null,
  },
  {
    code: 'pro', name: 'Pro', price: 20000, ws: 18000, wl: 650000, weekl: 2300000, sort: 1,
    tagline: '매일 꾸준히 만들고 배우고 싶은 분께.',
    features: ['워크스페이스 바이브코딩', '넉넉한 사용량으로 매일 작업', '5시간 창 + 주간 한도 자동 충전', '모든 기능 사용'],
    badge: '가장 인기', highlight: true, mult: '1x',
  },
  {
    code: 'max', name: 'Max', price: 100000, ws: 18000, wl: 3300000, weekl: 11500000, sort: 2,
    tagline: '하루 종일 몰입해서 작업하는 분께.',
    features: ['Pro 대비 5배 사용량', '하루 종일 끊김 없는 작업', '대규모 프로젝트에 적합', '모든 기능 사용'],
    badge: null, highlight: false, mult: '5x',
  },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    for (const p of PLANS) {
      await queryInterface.sequelize.query(
        `INSERT INTO subscription_plan
           (code, name, price_krw, window_seconds, window_unit_limit, weekly_unit_limit,
            billing_period, is_active, sort_order, tagline, features, badge, highlight, display_multiplier, created_at, updated_at)
         VALUES (:code, :name, :price, :ws, :wl, :weekl,
            'monthly', true, :sort, :tagline, CAST(:features AS jsonb), :badge, :highlight, :mult, NOW(), NOW())
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           price_krw = EXCLUDED.price_krw,
           window_seconds = EXCLUDED.window_seconds,
           window_unit_limit = EXCLUDED.window_unit_limit,
           weekly_unit_limit = EXCLUDED.weekly_unit_limit,
           sort_order = EXCLUDED.sort_order,
           tagline = EXCLUDED.tagline,
           features = EXCLUDED.features,
           badge = EXCLUDED.badge,
           highlight = EXCLUDED.highlight,
           display_multiplier = EXCLUDED.display_multiplier,
           updated_at = NOW()`,
        {
          replacements: {
            code: p.code, name: p.name, price: p.price, ws: p.ws, wl: p.wl, weekl: p.weekl, sort: p.sort,
            tagline: p.tagline, features: JSON.stringify(p.features), badge: p.badge,
            highlight: p.highlight, mult: p.mult,
          },
        },
      );
    }
  },

  // 데이터 시드 — 롤백 시 이전 placeholder 로 되돌리지 않음(no-op). 플랜 행은 유지.
  async down() {},
};
