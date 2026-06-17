const { sequelize } = require('../models');
const BILLING = require('../config/billing');

// 어드민 사용량 분석(실측) — usage_event 집계. 한도 보정 근거 데이터.
// unit ↔ 원가: cost_usd 가 Anthropic 실원가, metered_units = cost_usd × USD_TO_UNIT × MARKUP.

class AdminUsageService {
  async getSummary({ days = 14 } = {}) {
    const d = Math.min(180, Math.max(1, parseInt(days, 10) || 14));
    const where = `ue.source='plan' AND ue.created_at >= NOW() - (:days || ' days')::interval`;
    const repl = { days: d };

    const [overallRows] = await sequelize.query(
      `SELECT COUNT(*)::int AS turns,
              COALESCE(SUM(ue.metered_units),0)::bigint AS units,
              COALESCE(SUM(ue.cost_usd),0)::numeric AS cost_usd,
              COUNT(DISTINCT ue.user_id)::int AS active_users
       FROM usage_event ue WHERE ${where}`,
      { replacements: repl },
    );

    const [byPlan] = await sequelize.query(
      `SELECT COALESCE(p.code,'free') AS plan_code,
              COUNT(DISTINCT ue.user_id)::int AS users,
              COUNT(*)::int AS turns,
              COALESCE(SUM(ue.metered_units),0)::bigint AS units,
              COALESCE(SUM(ue.cost_usd),0)::numeric AS cost_usd
       FROM usage_event ue
       LEFT JOIN user_subscription us ON us.user_id = ue.user_id AND us.status='active'
       LEFT JOIN subscription_plan p ON p.id = us.plan_id
       WHERE ${where}
       GROUP BY COALESCE(p.code,'free')
       ORDER BY units DESC`,
      { replacements: repl },
    );

    const [topUsers] = await sequelize.query(
      `SELECT ue.user_id, u.email,
              COALESCE(p.code,'free') AS plan_code,
              COUNT(*)::int AS turns,
              COALESCE(SUM(ue.metered_units),0)::bigint AS units,
              COALESCE(SUM(ue.cost_usd),0)::numeric AS cost_usd,
              COALESCE(SUM(ue.metered_units) FILTER (WHERE ue.created_at >= NOW() - INTERVAL '7 days'),0)::bigint AS weekly_units
       FROM usage_event ue
       JOIN "user" u ON u.id = ue.user_id
       LEFT JOIN user_subscription us ON us.user_id = ue.user_id AND us.status='active'
       LEFT JOIN subscription_plan p ON p.id = us.plan_id
       WHERE ${where}
       GROUP BY ue.user_id, u.email, COALESCE(p.code,'free')
       ORDER BY units DESC
       LIMIT 50`,
      { replacements: repl },
    );

    const o = overallRows[0] || {};
    const turns = Number(o.turns) || 0;
    const units = Number(o.units) || 0;
    const costUsd = Number(o.cost_usd) || 0;

    return {
      days: d,
      unitPerUsd: BILLING.USD_TO_UNIT * BILLING.MARKUP, // units = 원가$ × 이 값 (어드민 환산 힌트)
      markup: BILLING.MARKUP,
      enforced: BILLING.ENFORCE,
      overall: {
        turns,
        units,
        costUsd,
        activeUsers: Number(o.active_users) || 0,
        avgUnitsPerTurn: turns ? Math.round(units / turns) : 0,
        avgCostPerTurn: turns ? costUsd / turns : 0,
      },
      byPlan: byPlan.map((r) => ({
        planCode: r.plan_code,
        users: Number(r.users) || 0,
        turns: Number(r.turns) || 0,
        units: Number(r.units) || 0,
        costUsd: Number(r.cost_usd) || 0,
      })),
      topUsers: topUsers.map((r) => ({
        userId: r.user_id,
        email: r.email,
        planCode: r.plan_code,
        turns: Number(r.turns) || 0,
        units: Number(r.units) || 0,
        costUsd: Number(r.cost_usd) || 0,
        weeklyUnits: Number(r.weekly_units) || 0,
      })),
    };
  }
}

module.exports = new AdminUsageService();
