const { Op } = require('sequelize');
const { UsageEvent } = require('../models');
const BILLING = require('../config/billing');
const subscriptionService = require('./subscriptionService');

// 정규화 사용량 unit 계산: (Claude USD 원가 × 마진) + (컴퓨팅 ms × 환산)
function computeMeteredUnits(costUsd, computeMs = 0) {
  const usd = Number(costUsd) || 0;
  const ms = Number(computeMs) || 0;
  const units = usd * BILLING.USD_TO_UNIT * BILLING.MARKUP + ms * BILLING.COMPUTE_UNIT_PER_MS;
  return Math.max(0, Math.ceil(units));
}

// 월 구독 전용 모델 — 크레딧 충전 없음. 한도 초과 = 리셋 대기 또는 플랜 업그레이드.

class UsageService {
  computeMeteredUnits = computeMeteredUnits;

  /**
   * 에이전트 턴 1회 사용량 적재. agentController.send 의 done 이벤트에서 fire-and-forget 으로 호출.
   * 스트림을 절대 블록/중단하지 않는다 — 호출부에서 .catch 로 흡수.
   */
  async recordTurn({ userId, sessionId, projectId, costUsd, usage, computeMs = 0 }) {
    if (!userId) return null;
    const u = usage || {};
    const metered = computeMeteredUnits(costUsd, computeMs);

    // 월 구독 전용 — 모든 사용량은 plan 버킷.
    return UsageEvent.create({
      user_id: userId,
      session_id: sessionId || null,
      project_id: projectId || null,
      cost_usd: Number(costUsd) || 0,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
      cache_creation_tokens: u.cache_creation_input_tokens || 0,
      compute_ms: computeMs || 0,
      metered_units: metered,
      source: 'plan',
      credit_units_charged: 0,
      created_at: new Date(),
    });
  }

  // 롤링 윈도우(초) 동안 plan 버킷에서 소모한 unit 합.
  async sumWindowUnits(userId, windowSeconds) {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const sum = await UsageEvent.sum('metered_units', {
      where: { user_id: userId, source: 'plan', created_at: { [Op.gte]: since } },
    });
    return Number(sum) || 0;
  }

  // 윈도우 내 가장 오래된 plan 이벤트 기준 리셋 시각(그 이벤트가 윈도우 밖으로 나가는 시점).
  async windowResetAt(userId, windowSeconds) {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const row = await UsageEvent.findOne({
      where: { user_id: userId, source: 'plan', created_at: { [Op.gte]: since } },
      order: [['created_at', 'ASC']],
      attributes: ['created_at'],
    });
    if (!row) return null;
    return new Date(new Date(row.created_at).getTime() + windowSeconds * 1000);
  }

  // 적용 플랜 + 현재 윈도우/주간 사용량 + 크레딧 잔액을 한 번에 로드(게이트/상태 공용).
  async _loadAllowanceContext(userId) {
    const plan = await subscriptionService.resolvePlanForUser(userId);
    const windowSeconds = plan ? plan.window_seconds : BILLING.DEFAULT_WINDOW_SECONDS;
    const windowLimit = plan ? Number(plan.window_unit_limit) : 0; // 0/누락 = 무제한 취급
    const weeklyLimit = plan && plan.weekly_unit_limit != null ? Number(plan.weekly_unit_limit) : null;
    const weeklySeconds = BILLING.DEFAULT_WEEKLY_SECONDS;

    const [windowUsed, weeklyUsed] = await Promise.all([
      this.sumWindowUnits(userId, windowSeconds),
      weeklyLimit != null ? this.sumWindowUnits(userId, weeklySeconds) : Promise.resolve(0),
    ]);

    return { plan, windowSeconds, windowLimit, weeklyLimit, weeklySeconds, windowUsed, weeklyUsed };
  }

  /**
   * 프리플라이트 게이트 — 턴 시작 허용 여부.
   * 반환: { allowed, source, reason, windowResetAt, weeklyResetAt, ...사용량/한도 }
   * 한 턴 실제 비용은 시작 전 미상 → "시작 허용"만 판단하고 done 에서 정산(약간 오버슈트 허용).
   */
  async checkAllowance(userId) {
    const ctx = await this._loadAllowanceContext(userId);
    const windowExceeded = ctx.windowLimit > 0 && ctx.windowUsed >= ctx.windowLimit;
    const weeklyExceeded = ctx.weeklyLimit != null && ctx.weeklyLimit > 0 && ctx.weeklyUsed >= ctx.weeklyLimit;

    // 월 구독 전용: 한도 초과 시 차단(리셋 대기 또는 플랜 업그레이드). 크레딧 없음.
    let allowed = true;
    let reason = null;
    if (windowExceeded || weeklyExceeded) {
      allowed = false;
      reason = weeklyExceeded ? 'weekly_exceeded' : 'window_exceeded';
    }

    let windowResetAt = null;
    let weeklyResetAt = null;
    if (windowExceeded) windowResetAt = await this.windowResetAt(userId, ctx.windowSeconds);
    if (weeklyExceeded) weeklyResetAt = await this.windowResetAt(userId, ctx.weeklySeconds);

    return {
      allowed,
      reason,
      planCode: ctx.plan ? ctx.plan.code : null,
      windowSeconds: ctx.windowSeconds,
      windowUsedUnits: ctx.windowUsed,
      windowLimitUnits: ctx.windowLimit > 0 ? ctx.windowLimit : null,
      weeklySeconds: ctx.weeklySeconds,
      weeklyUsedUnits: ctx.weeklyUsed,
      weeklyLimitUnits: ctx.weeklyLimit,
      windowResetAt,
      weeklyResetAt,
    };
  }

  /**
   * 앱 사용량 pill / 웹 대시보드용 상태 (월 구독 플랜 한도).
   */
  async getUsageStatus(userId) {
    const a = await this.checkAllowance(userId);
    return {
      plan: a.planCode,
      windowSeconds: a.windowSeconds,
      windowUsedUnits: a.windowUsedUnits,
      windowLimitUnits: a.windowLimitUnits,
      windowResetAt: a.windowResetAt,
      weeklySeconds: a.weeklySeconds,
      weeklyUsedUnits: a.weeklyUsedUnits,
      weeklyLimitUnits: a.weeklyLimitUnits,
      weeklyResetAt: a.weeklyResetAt,
      enforced: BILLING.ENFORCE,
    };
  }

  // 사용 내역(페이지네이션) — 웹 account/usage.
  async getHistory(userId, { page = 1, limit = 20 } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const { rows, count } = await UsageEvent.findAndCountAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      offset: (p - 1) * l,
      limit: l,
    });
    return { rows, total: count, page: p, limit: l };
  }
}

module.exports = new UsageService();
module.exports.computeMeteredUnits = computeMeteredUnits;
