const { Op } = require('sequelize');
const { UsageEvent, DaemonDevice } = require('../models');
const BILLING = require('../config/billing');
const subscriptionService = require('./subscriptionService');

// (레거시) 정규화 사용량 unit: (Claude USD 원가 × 마진) + (컴퓨팅 ms × 환산).
//  BYO 원격조작에선 cost_usd 를 알 수 없어 사실상 0 — 게이트는 아래 초(seconds) 기반으로 판정한다.
function computeMeteredUnits(costUsd, computeMs = 0) {
  const usd = Number(costUsd) || 0;
  const ms = Number(computeMs) || 0;
  const units = usd * BILLING.USD_TO_UNIT * BILLING.MARKUP + ms * BILLING.COMPUTE_UNIT_PER_MS;
  return Math.max(0, Math.ceil(units));
}

// 월 구독 전용 모델 — 크레딧 충전 없음. 한도 초과 = 리셋 대기 또는 플랜 업그레이드.
// M5 Slice5: 과금 대상 = 클라우드 컨테이너 실행시간(초). 로컬 러너는 무제한(미계측).

class UsageService {
  computeMeteredUnits = computeMeteredUnits;

  /**
   * 사용량 1건 적재 — 클라우드 컨테이너 실행 span(정지 시) 또는 (레거시) 에이전트 턴.
   * 스트림/수명주기를 절대 블록하지 않는다 — 호출부에서 .catch 로 흡수.
   */
  async recordTurn({ userId, sessionId, projectId, costUsd = 0, usage, computeMs = 0 }) {
    if (!userId) return null;
    const u = usage || {};
    const metered = computeMeteredUnits(costUsd, computeMs);

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

  // 롤링 윈도우(초) 동안 소모한 클라우드 실행시간(초) — usage_event.compute_ms 합 / 1000.
  async sumWindowSeconds(userId, windowSeconds) {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const sumMs = await UsageEvent.sum('compute_ms', {
      where: { user_id: userId, source: 'plan', created_at: { [Op.gte]: since } },
    });
    return Math.floor((Number(sumMs) || 0) / 1000);
  }

  // 아직 정지되지 않아 usage_event 에 적재되지 않은 "실행 중" 클라우드 컨테이너 span(초).
  //  이 값을 used 에 더해야 장기 실행 러너도 게이트/pill 에 실시간 반영된다.
  async inflightCloudSeconds(userId) {
    const rows = await DaemonDevice.findAll({
      where: { user_id: userId, runner_kind: 'cloud', revoked_at: null, container_started_at: { [Op.ne]: null } },
      attributes: ['container_started_at'],
    });
    const now = Date.now();
    let ms = 0;
    for (const r of rows) { if (r.container_started_at) ms += Math.max(0, now - new Date(r.container_started_at).getTime()); }
    return Math.floor(ms / 1000);
  }

  // (레거시) 롤링 윈도우 unit 합 — 하위호환 상태 표시용.
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

  // 적용 플랜 + 현재 윈도우/주간 실행시간(초) 사용량 로드(게이트/상태 공용).
  async _loadAllowanceContext(userId) {
    const plan = await subscriptionService.resolvePlanForUser(userId);
    const windowSeconds = plan ? plan.window_seconds : BILLING.DEFAULT_WINDOW_SECONDS;
    const windowLimitSec = plan ? Number(plan.window_seconds_limit) : 0; // 0/누락 = 무제한
    const weeklyLimitSec = plan && plan.weekly_seconds_limit != null ? Number(plan.weekly_seconds_limit) : null;
    const weeklySeconds = BILLING.DEFAULT_WEEKLY_SECONDS;

    const [windowRecorded, weeklyRecorded, inflight, windowUnits] = await Promise.all([
      this.sumWindowSeconds(userId, windowSeconds),
      weeklyLimitSec != null ? this.sumWindowSeconds(userId, weeklySeconds) : Promise.resolve(0),
      this.inflightCloudSeconds(userId),
      this.sumWindowUnits(userId, windowSeconds), // 레거시 표시용
    ]);
    // 실행 중 컨테이너 시간은 아직 미적재라 양쪽 윈도우 used 에 동일하게 더한다.
    const windowUsedSec = windowRecorded + inflight;
    const weeklyUsedSec = weeklyLimitSec != null ? weeklyRecorded + inflight : 0;

    return { plan, windowSeconds, windowLimitSec, weeklyLimitSec, weeklySeconds, windowUsedSec, weeklyUsedSec, windowUnits };
  }

  /**
   * 프리플라이트 게이트 — 클라우드 턴/러너 시작 허용 여부(초 쿼터 기준).
   * 반환: { allowed, reason, planCode, window/weekly 초 사용량·한도·리셋 } + (레거시) unit 필드.
   */
  async checkAllowance(userId) {
    const ctx = await this._loadAllowanceContext(userId);
    const windowExceeded = ctx.windowLimitSec > 0 && ctx.windowUsedSec >= ctx.windowLimitSec;
    const weeklyExceeded = ctx.weeklyLimitSec != null && ctx.weeklyLimitSec > 0 && ctx.weeklyUsedSec >= ctx.weeklyLimitSec;

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
      // 초 쿼터(정본)
      windowUsedSeconds: ctx.windowUsedSec,
      windowLimitSeconds: ctx.windowLimitSec > 0 ? ctx.windowLimitSec : null,
      weeklyUsedSeconds: ctx.weeklyUsedSec,
      weeklyLimitSeconds: ctx.weeklyLimitSec,
      windowResetAt,
      weeklyResetAt,
      // (레거시) unit 필드 — 웹 대시보드 하위호환
      windowUsedUnits: ctx.windowUnits,
      windowLimitUnits: null,
      weeklySecondsWindow: ctx.weeklySeconds,
    };
  }

  /**
   * 앱 사용량 pill / 웹 대시보드용 상태 (클라우드 실행시간 초 쿼터).
   */
  async getUsageStatus(userId) {
    const a = await this.checkAllowance(userId);
    return {
      plan: a.planCode,
      windowSeconds: a.windowSeconds,
      windowUsedSeconds: a.windowUsedSeconds,
      windowLimitSeconds: a.windowLimitSeconds,
      windowResetAt: a.windowResetAt,
      weeklyUsedSeconds: a.weeklyUsedSeconds,
      weeklyLimitSeconds: a.weeklyLimitSeconds,
      weeklyResetAt: a.weeklyResetAt,
      // 레거시 하위호환
      windowUsedUnits: a.windowUsedUnits,
      windowLimitUnits: a.windowLimitUnits,
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
