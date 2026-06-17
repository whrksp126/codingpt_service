const { Op } = require('sequelize');
const { Payment, UserSubscription, SubscriptionPlan, sequelize } = require('../models');
const subscriptionService = require('./subscriptionService');

// RevenueCat(Apple App Store / Google Play) 인앱 구독 연동.
//  - 웹훅: RC 서버가 구매/갱신/취소/만료/환불을 통지 → user_subscription 전이.
//  - 동기화: 구매 직후 앱이 호출 → RC REST 로 entitlement 확인 후 즉시 활성화(웹훅 지연 보정).
//  app_user_id = 우리 user.id (앱에서 Purchases.logIn(user.id) 로 귀속).
//  product_id ↔ 플랜은 subscription_plan.apple_product_id / google_product_id 로 매핑.

const REST_BASE = process.env.RC_REST_API_BASE || 'https://api.revenuecat.com/v1';
const REST_KEY = process.env.RC_REST_API_KEY || '';

const ACTIVATE_TYPES = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'];
const STORE_CHANNEL = { APP_STORE: 'appstore', MAC_APP_STORE: 'appstore', PLAY_STORE: 'googleplay', AMAZON: 'amazon', STRIPE: 'stripe' };

class RcBillingService {
  // product_id(우선) 또는 entitlement id(=플랜 code) 로 플랜을 찾는다.
  async resolvePlan({ productId = null, entitlementIds = [] } = {}) {
    if (productId) {
      const byProduct = await SubscriptionPlan.findOne({
        where: { [Op.or]: [{ apple_product_id: productId }, { google_product_id: productId }] },
      });
      if (byProduct) return byProduct;
    }
    for (const code of entitlementIds || []) {
      const p = await subscriptionService.getPlanByCode(code);
      if (p) return p;
    }
    return null;
  }

  // 스토어 출처 구독 1행(최신) — 취소/만료/연체 통지 시 대상.
  async _findStoreSub(userId) {
    return UserSubscription.findOne({
      where: { user_id: userId, source: 'revenuecat' },
      order: [['id', 'DESC']],
    });
  }

  async _patchStoreSub(userId, patch) {
    const sub = await this._findStoreSub(userId);
    if (!sub) return false;
    Object.assign(sub, patch, { updated_at: new Date() });
    await sub.save();
    return true;
  }

  // 매출 추적용 Payment 기록 (멱등 by transaction_id).
  async _recordPayment(userId, plan, ev) {
    const txid = String(ev.transaction_id || ev.id || '');
    if (!txid) return null;
    const paymentId = `rc-${txid}`;
    const existing = await Payment.findOne({ where: { payment_id: paymentId } });
    if (existing) return existing;
    const channel = STORE_CHANNEL[ev.store] || 'store';
    const amount = ev.price_in_purchased_currency != null
      ? Math.round(Number(ev.price_in_purchased_currency))
      : (plan ? plan.price_krw : 0);
    return Payment.create({
      payment_id: paymentId, user_id: userId, type: 'subscription', source: 'revenuecat', channel,
      ref_id: plan ? plan.id : null, amount_krw: Number.isFinite(amount) ? amount : 0, status: 'paid',
      pg_tx_id: txid, billing_key: ev.original_transaction_id ? String(ev.original_transaction_id) : null,
      raw_response: ev, paid_at: new Date(), created_at: new Date(), updated_at: new Date(),
    });
  }

  // RC 웹훅 이벤트 1건 처리. (ack 는 컨트롤러에서 이미 200 반환)
  async handleEvent(ev) {
    if (!ev || !ev.type) return { ignored: 'no_event' };
    const userId = parseInt(ev.app_user_id, 10);
    if (!Number.isInteger(userId)) return { ignored: 'non_numeric_app_user_id', appUserId: ev.app_user_id };
    const type = ev.type;

    if (ACTIVATE_TYPES.includes(type)) {
      const plan = await this.resolvePlan({ productId: ev.product_id, entitlementIds: ev.entitlement_ids });
      if (!plan) return { ignored: 'plan_not_found', productId: ev.product_id };
      await sequelize.transaction(async (t) => {
        await subscriptionService.activateSubscription(userId, plan.id, {
          source: 'revenuecat',
          billingKey: ev.original_transaction_id ? String(ev.original_transaction_id) : null,
          paymentId: String(ev.transaction_id || ev.id || ''),
          periodMonths: 1,
        }, t);
      });
      await this._recordPayment(userId, plan, ev);
      return { applied: type, userId, plan: plan.code };
    }

    if (type === 'CANCELLATION') {
      // UNSUBSCRIBE(자동갱신 끔) → 기간 말 해지. 그 외(환불/지원취소) → 즉시 해지.
      const refund = ev.cancel_reason && ev.cancel_reason !== 'UNSUBSCRIBE';
      await this._patchStoreSub(userId, refund ? { status: 'canceled' } : { cancel_at_period_end: true });
      return { applied: 'CANCELLATION', userId, refund: !!refund };
    }
    if (type === 'EXPIRATION') {
      await this._patchStoreSub(userId, { status: 'canceled' });
      return { applied: 'EXPIRATION', userId };
    }
    if (type === 'BILLING_ISSUE') {
      await this._patchStoreSub(userId, { status: 'past_due' });
      return { applied: 'BILLING_ISSUE', userId };
    }
    // TRANSFER / SUBSCRIPTION_PAUSED / TEST / 기타 — 무시(로그만).
    return { ignored: type, userId };
  }

  // 앱 구매 직후 즉시 동기화 — RC REST 로 활성 entitlement 확인 후 활성화. 웹훅 지연 보정.
  async syncFromRevenueCat(userId) {
    if (!REST_KEY) throw new Error('RC_REST_API_KEY 미설정 — 스토어 결제 동기화 불가.');
    const res = await fetch(`${REST_BASE}/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${REST_KEY}` },
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch (_) { json = {}; }
    if (!res.ok) throw new Error(`RevenueCat REST 오류 (${res.status}): ${json.message || text}`);

    const subscriber = json.subscriber || {};
    const entitlements = subscriber.entitlements || {};
    const now = Date.now();
    let best = null; // 가장 늦게 만료되는 활성 entitlement
    for (const [entId, ent] of Object.entries(entitlements)) {
      const exp = ent.expires_date ? Date.parse(ent.expires_date) : null;
      const active = exp === null || exp > now;
      if (!active) continue;
      const plan = await this.resolvePlan({ productId: ent.product_identifier, entitlementIds: [entId] });
      if (!plan) continue;
      const expMs = exp || Number.MAX_SAFE_INTEGER;
      if (!best || expMs > best.expMs) best = { plan, ent, entId, expMs };
    }
    if (!best) return { active: false };

    await subscriptionService.activateSubscription(userId, best.plan.id, {
      source: 'revenuecat',
      paymentId: `rc-sync-${userId}`,
      periodMonths: 1,
    });
    return { active: true, plan: best.plan.code };
  }
}

module.exports = new RcBillingService();
