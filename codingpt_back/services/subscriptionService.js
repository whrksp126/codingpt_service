const { Op } = require('sequelize');
const { SubscriptionPlan, UserSubscription, sequelize } = require('../models');
const BILLING = require('../config/billing');

class SubscriptionService {
  // 활성 플랜 카탈로그 (정렬)
  async getPlans() {
    return SubscriptionPlan.findAll({
      where: { is_active: true },
      order: [['sort_order', 'ASC'], ['id', 'ASC']],
    });
  }

  async getPlanByCode(code) {
    return SubscriptionPlan.findOne({ where: { code } });
  }

  async getPlanById(id) {
    return SubscriptionPlan.findByPk(id);
  }

  // 어드민: 플랜 편집 (한도/가격/카피). 화이트리스트 필드만 반영 — 어드민 조절판에서 호출.
  async updatePlan(id, fields = {}) {
    const plan = await SubscriptionPlan.findByPk(id);
    if (!plan) throw new Error('존재하지 않는 플랜입니다.');
    const ALLOWED = [
      'name', 'price_krw', 'window_seconds', 'window_unit_limit', 'weekly_unit_limit',
      'sort_order', 'is_active', 'tagline', 'features', 'badge', 'highlight', 'display_multiplier',
    ];
    const NUMERIC = ['price_krw', 'window_seconds', 'window_unit_limit', 'weekly_unit_limit', 'sort_order'];
    const patch = {};
    for (const key of ALLOWED) {
      if (!(key in fields)) continue;
      let val = fields[key];
      if (NUMERIC.includes(key)) {
        if (val === null || val === '') { val = null; }
        else { val = Number(val); if (!Number.isFinite(val) || val < 0) throw new Error(`${key} 값이 올바르지 않습니다.`); }
        // window_unit_limit 은 NOT NULL(0=무제한), weekly 는 nullable
        if (key !== 'weekly_unit_limit' && val === null) continue;
      }
      if (key === 'features' && val != null && !Array.isArray(val)) {
        throw new Error('features 는 배열이어야 합니다.');
      }
      patch[key] = val;
    }
    patch.updated_at = new Date();
    await plan.update(patch);
    return plan;
  }

  // 사용자의 활성 구독 (status='active' 만, 없으면 null)
  async getActiveSubscription(userId) {
    return UserSubscription.findOne({
      where: { user_id: userId, status: 'active' },
      include: [{ model: SubscriptionPlan }],
    });
  }

  // 사용자의 "현재 구독" — 활성 + 연체(past_due) 포함. 관리(해지/재개/변경)·한도 산정의 단일 출처.
  async getCurrentSubscription(userId) {
    return UserSubscription.findOne({
      where: { user_id: userId, status: { [Op.in]: ['active', 'past_due'] } },
      include: [{ model: SubscriptionPlan }],
    });
  }

  // 한도 산정을 위한 적용 플랜: 활성 구독 플랜 또는 기본(free) 플랜.
  // 연체(past_due)는 grace 기간 내에서만 플랜 권한을 유지(그 후 free 폴백; 스위퍼가 곧 canceled 로 전이).
  async resolvePlanForUser(userId) {
    const sub = await this.getCurrentSubscription(userId);
    if (sub && sub.SubscriptionPlan) {
      if (sub.status === 'past_due') {
        const graceMs = BILLING.DUNNING_GRACE_DAYS * 86_400_000;
        const within = sub.past_due_since && (Date.now() - new Date(sub.past_due_since).getTime() < graceMs);
        if (!within) return this.getPlanByCode(BILLING.DEFAULT_PLAN_CODE);
      }
      return sub.SubscriptionPlan;
    }
    const def = await this.getPlanByCode(BILLING.DEFAULT_PLAN_CODE);
    return def; // 시드가 없으면 null — 호출부에서 방어(무제한 취급)
  }

  // 내 구독 요약(웹/앱 공용) — 상태·기간·예약 다운그레이드·연체 grace 포함. 없으면 null(하위호환).
  async getMineEnriched(userId) {
    const sub = await UserSubscription.findOne({
      where: { user_id: userId, status: { [Op.in]: ['active', 'past_due'] } },
      include: [
        { model: SubscriptionPlan },
        { model: SubscriptionPlan, as: 'ScheduledPlan' },
      ],
    });
    if (!sub) return null;
    const plan = sub.SubscriptionPlan;
    const scheduled = sub.ScheduledPlan;
    const graceEndsAt = sub.past_due_since
      ? new Date(new Date(sub.past_due_since).getTime() + BILLING.DUNNING_GRACE_DAYS * 86_400_000)
      : null;
    return {
      status: sub.status,
      planCode: plan ? plan.code : null,
      planName: plan ? plan.name : null,
      priceKrw: plan ? plan.price_krw : null,
      source: sub.source,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      canceledAt: sub.canceled_at,
      scheduledPlan: scheduled ? { code: scheduled.code, name: scheduled.name, priceKrw: scheduled.price_krw } : null,
      pastDue: sub.status === 'past_due'
        ? { since: sub.past_due_since, attempts: sub.renewal_attempts, graceEndsAt }
        : null,
      paymentMethod: sub.card_last4 ? { brand: sub.card_brand || null, last4: sub.card_last4 } : null,
      manageInStore: sub.source !== 'portone',
    };
  }

  /**
   * 결제 검증 후 구독 활성화/전환. billingService(Phase 3)에서 호출.
   * 동일 사용자의 기존 활성 구독은 교체(업/다운그레이드)한다.
   */
  async activateSubscription(userId, planId, { billingKey = null, paymentId = null, periodMonths = 1, source = null } = {}, externalTx = null) {
    const run = async (t) => {
      const plan = await SubscriptionPlan.findByPk(planId, { transaction: t });
      if (!plan) throw new Error('존재하지 않는 플랜입니다.');

      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + (periodMonths || 1));

      const existing = await UserSubscription.findOne({
        where: { user_id: userId, status: 'active' },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (existing) {
        existing.plan_id = planId;
        if (source) existing.source = source; // 채널 전환(웹↔스토어) 시 출처 갱신
        existing.billing_key = billingKey || existing.billing_key;
        existing.current_period_start = now;
        existing.current_period_end = periodEnd;
        existing.cancel_at_period_end = false;
        existing.renewal_attempts = 0;
        existing.last_payment_id = paymentId || existing.last_payment_id;
        existing.updated_at = now;
        await existing.save({ transaction: t });
        return existing;
      }

      return UserSubscription.create({
        user_id: userId,
        plan_id: planId,
        status: 'active',
        source: source || 'portone',
        billing_key: billingKey,
        current_period_start: now,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        renewal_attempts: 0,
        last_payment_id: paymentId,
        created_at: now,
        updated_at: now,
      }, { transaction: t });
    };
    return externalTx ? run(externalTx) : sequelize.transaction(run);
  }

  // 해지 — 기간 말 해지(기본) 또는 즉시. (해지 사유 reason 은 로깅용, 스키마 미추가)
  async cancel(userId, { immediate = false, reason = null } = {}) {
    const sub = await this.getCurrentSubscription(userId);
    if (!sub) throw new Error('활성 구독이 없습니다.');
    // 스토어(App Store / Google Play) 구독은 우리 API 로 해지할 수 없다(스토어 정책).
    // DB 만 해지하면 스토어는 계속 청구하므로, 스토어 네이티브 해지로 유도.
    if (sub.source && sub.source !== 'portone') {
      const e = new Error('스토어에서 구독한 플랜이에요. 해지는 앱의 구독 관리(App Store / Google Play)에서 진행해 주세요.');
      e.code = 'store_managed';
      throw e;
    }
    if (reason) console.log(`[subscription] cancel reason (user ${userId}): ${reason}`);
    if (immediate) {
      sub.status = 'canceled';
      sub.canceled_at = new Date();
    } else {
      sub.cancel_at_period_end = true;
    }
    sub.updated_at = new Date();
    await sub.save();
    return sub;
  }

  // 해지 취소(재개) — 기간 말 해지 예약을 되돌린다. 스토어 구독은 스토어에서 처리.
  async resume(userId) {
    const sub = await this.getCurrentSubscription(userId);
    if (!sub) throw new Error('재개할 구독이 없습니다.');
    if (sub.source && sub.source !== 'portone') {
      return { resumed: false, storeManaged: true, deepLink: 'store', sub };
    }
    if (!sub.cancel_at_period_end) throw new Error('해지 예약 상태가 아닙니다.');
    if (sub.current_period_end && new Date(sub.current_period_end) <= new Date()) {
      throw new Error('이용 기간이 이미 종료되어 재개할 수 없습니다.');
    }
    sub.cancel_at_period_end = false;
    sub.canceled_at = null;
    // 예약 다운그레이드(scheduled_plan_id)는 유지 — 해지 취소 ≠ 예약 변경 취소.
    sub.updated_at = new Date();
    await sub.save();
    return { resumed: true, sub };
  }

  /**
   * 플랜 변경 (웹/PortOne 전용). 업그레이드=즉시 비례정산, 다운그레이드=기간말 예약.
   * 스토어 구독(source!=='portone')은 스토어 네이티브에서 변경.
   */
  async changePlan(userId, targetCode) {
    const sub = await this.getCurrentSubscription(userId);
    if (!sub) throw new Error('활성 구독이 없습니다.');
    if (sub.source && sub.source !== 'portone') {
      const e = new Error('스토어 구독은 앱의 구독 관리에서 변경하세요.');
      e.code = 'store_managed';
      throw e;
    }
    const target = await this.getPlanByCode(targetCode);
    if (!target || !target.is_active) throw new Error('존재하지 않는 플랜입니다.');
    if (!target.price_krw || target.price_krw <= 0) throw new Error('유효한 유료 플랜이 아닙니다.');
    const current = sub.SubscriptionPlan || (await this.getPlanById(sub.plan_id));
    if (!current) throw new Error('현재 플랜을 찾을 수 없습니다.');

    // 현재 플랜을 다시 선택 → 예약된 다운그레이드 취소.
    if (target.id === current.id) {
      if (sub.scheduled_plan_id) {
        sub.scheduled_plan_id = null;
        sub.updated_at = new Date();
        await sub.save();
        return { effect: 'schedule_cleared', planCode: current.code, status: sub.status, currentPeriodEnd: sub.current_period_end, scheduledPlanCode: null };
      }
      throw new Error('이미 이용 중인 플랜입니다.');
    }

    const isUpgrade = target.price_krw > current.price_krw;

    // ── 다운그레이드: 기간 말 예약 (청구 없음) ──
    if (!isUpgrade) {
      sub.scheduled_plan_id = target.id;
      sub.updated_at = new Date();
      await sub.save();
      return {
        effect: 'downgrade_scheduled', planCode: current.code, status: sub.status,
        currentPeriodEnd: sub.current_period_end, scheduledPlanCode: target.code,
        effectiveAt: sub.current_period_end, payment: null,
      };
    }

    // ── 업그레이드: 즉시 비례정산 (period 유지) ──
    if (sub.status === 'past_due') {
      throw new Error('결제 실패 상태에서는 업그레이드할 수 없습니다. 결제 수단을 먼저 업데이트해 주세요.');
    }
    const now = new Date();
    const periodStart = sub.current_period_start ? new Date(sub.current_period_start) : now;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end) : now;
    const periodMs = Math.max(1, periodEnd.getTime() - periodStart.getTime());
    const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
    const priceDelta = target.price_krw - current.price_krw;
    const proratedCharge = Math.round(priceDelta * (remainingMs / periodMs));

    const { Payment } = require('../models');

    // 차액이 0 이하(기간 거의 끝) → 청구 없이 즉시 전환, 0원 영수증 기록.
    if (proratedCharge <= 0) {
      const zeroPid = `pc-${sub.id}-${target.id}-${periodEnd.getTime()}`;
      await sequelize.transaction(async (t) => {
        const locked = await UserSubscription.findByPk(sub.id, { transaction: t, lock: t.LOCK.UPDATE });
        locked.plan_id = target.id;
        locked.scheduled_plan_id = null;
        locked.renewal_attempts = 0;
        locked.updated_at = new Date();
        await locked.save({ transaction: t });
        const exists = await Payment.findOne({ where: { payment_id: zeroPid }, transaction: t });
        if (!exists) {
          await Payment.create({
            payment_id: zeroPid, user_id: userId, type: 'subscription', source: 'portone',
            channel: 'inicis_billing', ref_id: target.id, amount_krw: 0, status: 'paid',
            kind: 'plan_change', description: `${target.name} 플랜 변경`,
            period_start: periodStart, period_end: periodEnd, paid_at: new Date(),
            created_at: new Date(), updated_at: new Date(),
          }, { transaction: t });
        }
      });
      return { effect: 'upgraded', planCode: target.code, status: 'active', currentPeriodEnd: periodEnd, scheduledPlanCode: null, payment: { paymentId: zeroPid, amountKrw: 0, kind: 'plan_change' } };
    }

    const portoneService = require('./portoneService');
    if (!portoneService.isEnabled() || !sub.billing_key) {
      throw new Error('결제 수단이 없어 업그레이드할 수 없습니다. 결제 수단을 먼저 등록해 주세요.');
    }
    const paymentId = `up-${sub.id}-${target.id}-${periodEnd.getTime()}`;
    let pay = await Payment.findOne({ where: { payment_id: paymentId } });
    if (pay && pay.status === 'paid') {
      // 멱등 재시도: 이미 청구됨 → 플랜만 보장.
      if (sub.plan_id !== target.id) { sub.plan_id = target.id; sub.scheduled_plan_id = null; sub.updated_at = new Date(); await sub.save(); }
      return { effect: 'upgraded', planCode: target.code, status: 'active', currentPeriodEnd: periodEnd, scheduledPlanCode: null, payment: { paymentId, amountKrw: pay.amount_krw, kind: 'upgrade_proration' } };
    }
    if (!pay) {
      pay = await Payment.create({
        payment_id: paymentId, user_id: userId, type: 'subscription', source: 'portone',
        channel: 'inicis_billing', ref_id: target.id, amount_krw: proratedCharge, status: 'ready',
        kind: 'upgrade_proration', description: `${target.name} 업그레이드 (비례정산)`,
        period_start: periodStart, period_end: periodEnd, billing_key: sub.billing_key,
        created_at: new Date(), updated_at: new Date(),
      });
    }
    await portoneService.payWithBillingKey({
      paymentId, billingKey: sub.billing_key, orderName: `${target.name} 업그레이드`,
      amountKrw: proratedCharge, customData: { userId, paymentId, type: 'subscription', code: target.code, kind: 'upgrade_proration' },
    });
    const billingService = require('./billingService');
    await billingService.verifyPaymentPaid(paymentId, userId); // PortOne 정본 검증 + paid 플립 (activate 안 함, period 미리셋)

    await sequelize.transaction(async (t) => {
      const locked = await UserSubscription.findByPk(sub.id, { transaction: t, lock: t.LOCK.UPDATE });
      locked.plan_id = target.id;
      locked.scheduled_plan_id = null;
      locked.renewal_attempts = 0;
      locked.updated_at = new Date();
      await locked.save({ transaction: t }); // current_period_start/end 유지
    });
    return { effect: 'upgraded', planCode: target.code, status: 'active', currentPeriodEnd: periodEnd, scheduledPlanCode: null, payment: { paymentId, amountKrw: proratedCharge, kind: 'upgrade_proration' } };
  }

  // 결제 없이 기간 연장 (무료/이미 청구됨/갱신 성공 공통). 직전 period_end 에서 이어붙여 드리프트 방지.
  // applyPlanId 가 있으면 그 플랜으로 전환(예약 다운그레이드 적용)하고 scheduled_plan_id 를 클리어한다.
  async _advancePeriod(sub, { applyPlanId = null } = {}) {
    const priorEnd = sub.current_period_end ? new Date(sub.current_period_end) : new Date();
    const end = new Date(priorEnd);
    end.setMonth(end.getMonth() + 1);
    if (applyPlanId) sub.plan_id = applyPlanId;
    sub.scheduled_plan_id = null;
    sub.current_period_start = priorEnd;
    sub.current_period_end = end;
    sub.renewal_attempts = 0;
    sub.past_due_since = null;
    sub.status = sub.cancel_at_period_end ? 'canceled' : 'active';
    if (sub.status === 'canceled' && !sub.canceled_at) sub.canceled_at = new Date();
    sub.updated_at = new Date();
    await sub.save();
    return { status: sub.status };
  }

  // 연체 처리 — 시도 횟수 증가 + grace 컷오프 판정.
  async _applyDunning(sub) {
    sub.renewal_attempts = (sub.renewal_attempts || 0) + 1;
    if (!sub.past_due_since) sub.past_due_since = new Date();
    const graceMs = BILLING.DUNNING_GRACE_DAYS * 86_400_000;
    const overGrace = Date.now() - new Date(sub.past_due_since).getTime() >= graceMs;
    if (sub.renewal_attempts >= BILLING.DUNNING_MAX_ATTEMPTS || overGrace) {
      sub.status = 'canceled';
      sub.canceled_at = new Date();
    } else {
      sub.status = 'past_due';
    }
    sub.updated_at = new Date();
    await sub.save();
    return { status: sub.status };
  }

  // 갱신 청구 (빌링키). 멱등 paymentId = sub-{subId}-{periodEndEpoch}.
  // 예약 다운그레이드(scheduled_plan_id)가 있으면 이번 갱신부터 그 플랜으로 전환·그 가격으로 청구한다.
  async chargeRenewal(sub) {
    const portoneService = require('./portoneService');
    const { Payment } = require('../models');

    // 스토어 IAP 구독은 Apple/Google 이 자동 갱신 → PortOne 청구 금지(RC RENEWAL 웹훅이 기간 연장).
    if (sub.source && sub.source !== 'portone') {
      return { status: 'skipped', reason: 'store_managed' };
    }
    if (sub.cancel_at_period_end) {
      sub.status = 'canceled';
      sub.canceled_at = new Date();
      sub.updated_at = new Date();
      await sub.save();
      return { status: 'canceled', reason: 'cancel_at_period_end' };
    }

    // 이번 기간에 적용할 유효 플랜 = 예약 플랜이 있으면 그것, 없으면 현재 플랜.
    const scheduled = sub.scheduled_plan_id ? await SubscriptionPlan.findByPk(sub.scheduled_plan_id) : null;
    const plan = scheduled || sub.SubscriptionPlan || (await SubscriptionPlan.findByPk(sub.plan_id));
    if (!plan) throw new Error('플랜을 찾을 수 없습니다.');
    const applyPlanId = scheduled ? scheduled.id : null;

    if (!plan.price_krw || plan.price_krw <= 0) {
      return this._advancePeriod(sub, { applyPlanId }); // 무료 — 청구 없이 전환·연장
    }
    if (!portoneService.isEnabled() || !sub.billing_key) {
      return this._applyDunning(sub); // 결제 수단 없음 → 연체
    }

    const periodEpoch = sub.current_period_end ? new Date(sub.current_period_end).getTime() : Date.now();
    const paymentId = `sub-${sub.id}-${periodEpoch}`;
    const newStart = sub.current_period_end ? new Date(sub.current_period_end) : new Date();
    const newEnd = new Date(newStart); newEnd.setMonth(newEnd.getMonth() + 1);
    let pay = await Payment.findOne({ where: { payment_id: paymentId } });
    if (pay && pay.status === 'paid') {
      return this._advancePeriod(sub, { applyPlanId }); // 이미 청구됨 — 전환·연장
    }
    if (!pay) {
      pay = await Payment.create({
        payment_id: paymentId, user_id: sub.user_id, type: 'subscription', source: 'portone', channel: 'inicis_billing',
        ref_id: plan.id, amount_krw: plan.price_krw, status: 'ready', billing_key: sub.billing_key,
        kind: scheduled ? 'plan_change' : 'renewal',
        description: scheduled ? `${plan.name} 플랜 변경·갱신` : `${plan.name} 구독 갱신`,
        period_start: newStart, period_end: newEnd,
        created_at: new Date(), updated_at: new Date(),
      });
    }
    try {
      await portoneService.payWithBillingKey({
        paymentId, billingKey: sub.billing_key, orderName: `${plan.name} 구독 갱신`,
        amountKrw: plan.price_krw, customData: { userId: sub.user_id, paymentId, type: 'subscription', code: plan.code },
      });
      const billingService = require('./billingService');
      await billingService.verifyPaymentPaid(paymentId); // 검증 + paid 플립 (activate 안 함)
      await this._advancePeriod(sub, { applyPlanId }); // 직전 period_end 에서 이어붙이고 예약 플랜 적용
      return { status: 'renewed', paymentId, planCode: plan.code };
    } catch (e) {
      const r = await this._applyDunning(sub);
      return { status: r.status, error: e.message };
    }
  }

  // 갱신 대상 스캔 (스위퍼용) — 기간 만료된 활성/연체 구독.
  async findDueRenewals(limit = 50) {
    return UserSubscription.findAll({
      where: {
        status: { [Op.in]: ['active', 'past_due'] },
        source: 'portone', // 스토어 IAP 구독은 스위퍼 제외(스토어가 자동 갱신)
        current_period_end: { [Op.lte]: new Date() },
      },
      include: [{ model: SubscriptionPlan }],
      limit,
      order: [['current_period_end', 'ASC']],
    });
  }
}

module.exports = new SubscriptionService();
