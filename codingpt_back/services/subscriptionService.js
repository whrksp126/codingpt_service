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

  // 사용자의 활성 구독 (없으면 null)
  async getActiveSubscription(userId) {
    return UserSubscription.findOne({
      where: { user_id: userId, status: 'active' },
      include: [{ model: SubscriptionPlan }],
    });
  }

  // 한도 산정을 위한 적용 플랜: 활성 구독 플랜 또는 기본(free) 플랜.
  async resolvePlanForUser(userId) {
    const sub = await this.getActiveSubscription(userId);
    if (sub && sub.SubscriptionPlan) return sub.SubscriptionPlan;
    const def = await this.getPlanByCode(BILLING.DEFAULT_PLAN_CODE);
    return def; // 시드가 없으면 null — 호출부에서 방어(무제한 취급)
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

  // 해지 — 기간 말 해지(기본) 또는 즉시.
  async cancel(userId, { immediate = false } = {}) {
    const sub = await this.getActiveSubscription(userId);
    if (!sub) throw new Error('활성 구독이 없습니다.');
    if (immediate) {
      sub.status = 'canceled';
    } else {
      sub.cancel_at_period_end = true;
    }
    sub.updated_at = new Date();
    await sub.save();
    return sub;
  }

  // 결제 없이 기간만 연장 (무료 플랜/이미 청구됨).
  async _advancePeriod(sub) {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    sub.current_period_start = now;
    sub.current_period_end = end;
    sub.renewal_attempts = 0;
    sub.status = sub.cancel_at_period_end ? 'canceled' : 'active';
    sub.updated_at = now;
    await sub.save();
    return { status: sub.status };
  }

  // 갱신 청구 (빌링키). 멱등 paymentId = sub-{subId}-{periodEndEpoch}.
  async chargeRenewal(sub) {
    const portoneService = require('./portoneService');
    const { Payment } = require('../models');
    const plan = sub.SubscriptionPlan || (await SubscriptionPlan.findByPk(sub.plan_id));
    if (!plan) throw new Error('플랜을 찾을 수 없습니다.');

    // 스토어 IAP 구독은 Apple/Google 이 자동 갱신 → PortOne 청구 금지(RC RENEWAL 웹훅이 기간 연장).
    if (sub.source && sub.source !== 'portone') {
      return { status: 'skipped', reason: 'store_managed' };
    }
    if (sub.cancel_at_period_end) {
      sub.status = 'canceled';
      sub.updated_at = new Date();
      await sub.save();
      return { status: 'canceled', reason: 'cancel_at_period_end' };
    }
    if (!plan.price_krw || plan.price_krw <= 0) {
      return this._advancePeriod(sub);
    }
    if (!portoneService.isEnabled() || !sub.billing_key) {
      sub.status = 'past_due';
      sub.renewal_attempts = (sub.renewal_attempts || 0) + 1;
      sub.updated_at = new Date();
      await sub.save();
      return { status: 'past_due', reason: 'no_billing_key' };
    }

    const periodEpoch = sub.current_period_end ? new Date(sub.current_period_end).getTime() : Date.now();
    const paymentId = `sub-${sub.id}-${periodEpoch}`;
    let pay = await Payment.findOne({ where: { payment_id: paymentId } });
    if (pay && pay.status === 'paid') {
      return this._advancePeriod(sub); // 이미 청구됨 — 기간만 연장
    }
    if (!pay) {
      pay = await Payment.create({
        payment_id: paymentId, user_id: sub.user_id, type: 'subscription', channel: 'inicis_billing',
        ref_id: plan.id, amount_krw: plan.price_krw, status: 'ready', billing_key: sub.billing_key,
        created_at: new Date(), updated_at: new Date(),
      });
    }
    try {
      await portoneService.payWithBillingKey({
        paymentId, billingKey: sub.billing_key, orderName: `${plan.name} 구독 갱신`,
        amountKrw: plan.price_krw, customData: { userId: sub.user_id, paymentId, type: 'subscription', code: plan.code },
      });
      const billingService = require('./billingService');
      await billingService.verifyAndApplyPayment(paymentId); // 검증 + 기간 연장
      return { status: 'renewed', paymentId };
    } catch (e) {
      sub.renewal_attempts = (sub.renewal_attempts || 0) + 1;
      sub.status = sub.renewal_attempts >= 4 ? 'canceled' : 'past_due';
      sub.updated_at = new Date();
      await sub.save();
      return { status: sub.status, error: e.message };
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
