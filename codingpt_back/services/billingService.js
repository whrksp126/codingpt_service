const crypto = require('crypto');
const { Payment, SubscriptionPlan, sequelize } = require('../models');
const portoneService = require('./portoneService');
const subscriptionService = require('./subscriptionService');
const BILLING = require('../config/billing');

// 영수증 종류 한글 라벨
const KIND_LABELS = {
  subscription_initial: '구독 시작',
  renewal: '구독 갱신',
  upgrade_proration: '업그레이드 비례정산',
  plan_change: '플랜 변경',
  payment_method_retry: '결제 재시도',
  refund: '환불',
};

// 결제 오케스트레이션 (월 구독 전용): 체크아웃 의도 생성 → 빌링키 발급 → 첫 달 청구 + 구독 활성화.
// 크레딧 충전(환금성) 모델은 제거됨.

class BillingService {
  // 구독 체크아웃 의도 생성. 서버 권위 금액으로 payment(ready) 행을 만들고
  // 웹이 PortOne 빌링키 발급창을 띄우는 데 필요한 값들을 반환한다.
  async createCheckout(userId, { type, code }) {
    if (!BILLING.SALES_OPEN) throw new Error('현재 신규 구독 판매가 중단되었습니다.');
    if (type !== 'subscription') throw new Error('지원하지 않는 결제 유형입니다. (월 구독만 지원)');
    const plan = await subscriptionService.getPlanByCode(code);
    if (!plan || !plan.is_active) throw new Error('존재하지 않는 플랜입니다.');
    if (plan.price_krw <= 0) throw new Error('무료 플랜은 결제가 필요하지 않습니다.');
    // INICIS oid(주문번호)는 최대 40자 — sub-{userId}-{26hex} = 33~38자로 제한 내 유지.
    const paymentId = `sub-${userId}-${crypto.randomBytes(13).toString('hex')}`;
    await Payment.create({
      payment_id: paymentId, user_id: userId, type: 'subscription', channel: 'inicis_billing',
      ref_id: plan.id, amount_krw: plan.price_krw, status: 'ready',
      kind: 'subscription_initial', description: `${plan.name} 구독`,
      created_at: new Date(), updated_at: new Date(),
    });
    return {
      paymentId, amountKrw: plan.price_krw, orderName: `${plan.name} 구독`,
      storeId: portoneService.getStoreId(), channelKey: portoneService.getChannelKey('subscription'),
      billing: true, // 빌링키 발급(정기결제 특약)
      customData: { userId, paymentId, type: 'subscription', code: plan.code },
    };
  }

  // 서버 검증 + 구독 활성화. subscribe 흐름 + 웹훅 재조정의 공통 진입점. payment_id 멱등.
  async verifyAndApplyPayment(paymentId, expectedUserId = null) {
    if (!paymentId) throw new Error('paymentId 가 필요합니다.');
    if (!portoneService.isEnabled()) throw new Error('PortOne 미설정 (PORTONE_API_SECRET).');

    // PortOne 정본 재조회 (클라이언트/웹훅 body 불신)
    const pg = await portoneService.getPayment(paymentId);
    const pgStatus = pg.status;
    const pgAmount = pg.amount && (pg.amount.total != null ? pg.amount.total : pg.amount.paid);

    return sequelize.transaction(async (t) => {
      const payment = await Payment.findOne({
        where: { payment_id: paymentId }, transaction: t, lock: t.LOCK.UPDATE,
      });
      if (!payment) throw new Error('결제 내역을 찾을 수 없습니다.');

      if (payment.status === 'paid') {
        return { payment, applied: false, alreadyPaid: true };
      }
      if (expectedUserId != null && payment.user_id !== expectedUserId) {
        throw new Error('결제 소유자가 일치하지 않습니다.');
      }
      if (pgStatus !== 'PAID') {
        payment.status = pgStatus === 'CANCELLED' ? 'cancelled' : 'failed';
        payment.raw_response = pg;
        payment.updated_at = new Date();
        await payment.save({ transaction: t });
        throw new Error(`결제가 완료되지 않았습니다 (status=${pgStatus}).`);
      }
      if (Number(pgAmount) !== Number(payment.amount_krw)) {
        payment.status = 'failed';
        payment.raw_response = pg;
        payment.updated_at = new Date();
        await payment.save({ transaction: t });
        throw new Error(`결제 금액 불일치 (기대 ${payment.amount_krw}, 실제 ${pgAmount}).`);
      }
      let cd = pg.customData;
      if (typeof cd === 'string') { try { cd = JSON.parse(cd); } catch (_) { cd = null; } }
      if (cd && cd.userId != null && Number(cd.userId) !== Number(payment.user_id)) {
        throw new Error('결제 customData 사용자 불일치.');
      }

      const nowPaid = new Date();
      const periodEnd = new Date(nowPaid); periodEnd.setMonth(periodEnd.getMonth() + 1);
      payment.status = 'paid';
      payment.paid_at = nowPaid;
      payment.pg_tx_id = pg.pgTxId || pg.transactionId || null;
      payment.billing_key = (pg.billingKey || (pg.method && pg.method.billingKey)) || payment.billing_key;
      if (!payment.kind) payment.kind = 'subscription_initial';
      if (!payment.period_start) { payment.period_start = nowPaid; payment.period_end = periodEnd; }
      payment.raw_response = pg;
      payment.updated_at = nowPaid;
      await payment.save({ transaction: t });

      await subscriptionService.activateSubscription(payment.user_id, payment.ref_id, {
        billingKey: payment.billing_key, paymentId, periodMonths: 1,
      }, t);

      return { payment, applied: true };
    });
  }

  // PortOne 정본 검증 후 Payment 를 paid 로만 플립한다(구독 활성화/기간 변경 없음).
  // 업그레이드 비례정산·갱신처럼 구독 mutation 을 호출부(subscriptionService)가 직접 제어할 때 사용.
  async verifyPaymentPaid(paymentId, expectedUserId = null) {
    if (!paymentId) throw new Error('paymentId 가 필요합니다.');
    if (!portoneService.isEnabled()) throw new Error('PortOne 미설정 (PORTONE_API_SECRET).');
    const pg = await portoneService.getPayment(paymentId);
    const pgStatus = pg.status;
    const pgAmount = pg.amount && (pg.amount.total != null ? pg.amount.total : pg.amount.paid);
    return sequelize.transaction(async (t) => {
      const payment = await Payment.findOne({ where: { payment_id: paymentId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!payment) throw new Error('결제 내역을 찾을 수 없습니다.');
      if (payment.status === 'paid') return { payment, alreadyPaid: true };
      if (expectedUserId != null && payment.user_id !== expectedUserId) throw new Error('결제 소유자가 일치하지 않습니다.');
      if (pgStatus !== 'PAID') {
        payment.status = pgStatus === 'CANCELLED' ? 'cancelled' : 'failed';
        payment.raw_response = pg; payment.updated_at = new Date();
        await payment.save({ transaction: t });
        throw new Error(`결제가 완료되지 않았습니다 (status=${pgStatus}).`);
      }
      if (Number(pgAmount) !== Number(payment.amount_krw)) {
        payment.status = 'failed'; payment.raw_response = pg; payment.updated_at = new Date();
        await payment.save({ transaction: t });
        throw new Error(`결제 금액 불일치 (기대 ${payment.amount_krw}, 실제 ${pgAmount}).`);
      }
      payment.status = 'paid';
      payment.paid_at = new Date();
      payment.pg_tx_id = pg.pgTxId || pg.transactionId || null;
      payment.raw_response = pg;
      payment.updated_at = new Date();
      await payment.save({ transaction: t });
      return { payment, applied: true };
    });
  }

  // 결제수단(빌링키) 등록/교체 — 무료 계정 포함(사용자 레벨 저장). 활성 구독이 있으면 거기도 반영,
  // 연체 상태면 즉시 갱신 재시도. 재구독 없이 카드만 바꾼다.
  async updatePaymentMethod(userId, billingKey, { retryNow = true } = {}) {
    if (!billingKey) throw new Error('billingKey 가 필요합니다.');
    const { User } = require('../models');
    const card = await portoneService.fetchCardInfo(billingKey); // 표시용(비치명적)

    // 1) 사용자 레벨 저장 (구독 없어도 가능)
    const user = await User.findByPk(userId);
    if (user) {
      user.billing_key = billingKey;
      if (card) { user.card_brand = card.brand; user.card_last4 = card.last4; }
      await user.save();
    }

    // 2) 활성/연체 구독이 있으면 함께 반영 + 연체면 즉시 재시도
    let status = 'none', recovered = false;
    const sub = await subscriptionService.getCurrentSubscription(userId);
    if (sub) {
      if (sub.source && sub.source !== 'portone') throw new Error('스토어 구독은 스토어에서 결제 수단을 변경하세요.');
      sub.billing_key = billingKey;
      if (card) { sub.card_brand = card.brand; sub.card_last4 = card.last4; }
      sub.updated_at = new Date();
      await sub.save();
      status = sub.status;
      if (retryNow && sub.status === 'past_due') {
        const r = await subscriptionService.chargeRenewal(sub); // 멱등 — 동일 기간 이중청구 방지
        recovered = r.status === 'renewed' || r.status === 'active';
        status = recovered ? 'active' : sub.status;
      }
    }
    const savedCard = card || (user && user.card_last4 ? { brand: user.card_brand, last4: user.card_last4 } : null);
    return { updated: true, status, recovered, card: savedCard };
  }

  // 저장된 결제 수단(표시용) — 사용자 레벨. 무료 계정 포함.
  async getPaymentMethod(userId) {
    const { User } = require('../models');
    const user = await User.findByPk(userId);
    if (user && user.card_last4) return { brand: user.card_brand || null, last4: user.card_last4 };
    return null;
  }

  // 구독 활성화 — 빌링키 발급 후 첫 달 청구 + 구독 활성화.
  async subscribeWithBillingKey(userId, paymentId, billingKey) {
    if (!BILLING.SALES_OPEN) throw new Error('현재 신규 구독 판매가 중단되었습니다.');
    if (!billingKey) throw new Error('billingKey 가 필요합니다.');
    if (!portoneService.isEnabled()) throw new Error('PortOne 미설정 (PORTONE_API_SECRET).');

    const payment = await Payment.findOne({ where: { payment_id: paymentId } });
    if (!payment) throw new Error('결제 내역을 찾을 수 없습니다.');
    if (payment.user_id !== userId) throw new Error('결제 소유자가 일치하지 않습니다.');
    if (payment.type !== 'subscription') throw new Error('구독 결제가 아닙니다.');
    if (payment.status === 'paid') return { applied: false, alreadyPaid: true };

    payment.billing_key = billingKey;
    payment.updated_at = new Date();
    await payment.save();

    await portoneService.payWithBillingKey({
      paymentId, billingKey, orderName: `구독 결제`, amountKrw: payment.amount_krw,
      customData: { userId, paymentId, type: 'subscription' },
    });

    const result = await this.verifyAndApplyPayment(paymentId, userId);
    // 카드 표시정보 캡처 (비치명적)
    try {
      const sub = await subscriptionService.getCurrentSubscription(userId);
      if (sub && (!sub.card_brand || !sub.card_last4)) {
        const card = await portoneService.fetchCardInfo(billingKey);
        if (card) { sub.card_brand = card.brand; sub.card_last4 = card.last4; await sub.save(); }
      }
    } catch (_) { /* noop */ }
    return result;
  }

  // 결제 내역(영수증) — 플랜명·종류 라벨·기간을 붙여 가독화. ref_id→플랜명은 1회 조회로 N+1 방지.
  async getPayments(userId, { page = 1, limit = 20 } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const { rows, count } = await Payment.findAndCountAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      offset: (p - 1) * l, limit: l,
    });
    const planMap = await this._planNameMap(rows);
    return { rows: rows.map((r) => this._toReceipt(r, planMap)), total: count, page: p, limit: l };
  }

  // 단건 영수증 — payment_id 또는 id 로 조회 + 소유권 강제.
  async getPaymentReceipt(userId, idOrPaymentId) {
    const { Op } = require('sequelize');
    const numeric = /^\d+$/.test(String(idOrPaymentId));
    const where = numeric
      ? { [Op.or]: [{ payment_id: String(idOrPaymentId) }, { id: Number(idOrPaymentId) }] }
      : { payment_id: String(idOrPaymentId) };
    const row = await Payment.findOne({ where });
    if (!row) { const e = new Error('영수증을 찾을 수 없습니다.'); e.status = 404; throw e; }
    if (row.user_id !== userId) { const e = new Error('영수증 접근 권한이 없습니다.'); e.status = 403; throw e; }
    const planMap = await this._planNameMap([row]);
    return this._toReceipt(row, planMap);
  }

  async _planNameMap(rows) {
    const ids = [...new Set(rows.map((r) => r.ref_id).filter((v) => v != null))];
    if (!ids.length) return {};
    const plans = await SubscriptionPlan.findAll({ where: { id: ids } });
    return Object.fromEntries(plans.map((pl) => [pl.id, pl.name]));
  }

  _toReceipt(r, planMap) {
    return {
      id: Number(r.id),
      paymentId: r.payment_id,
      kind: r.kind || (r.type === 'subscription' ? 'renewal' : r.type),
      kindLabel: KIND_LABELS[r.kind] || (r.type === 'subscription' ? '구독' : r.type),
      description: r.description || null,
      planName: r.ref_id != null ? (planMap[r.ref_id] || null) : null,
      amountKrw: r.amount_krw,
      refundedAmountKrw: r.refunded_amount_krw || 0,
      status: r.status,
      source: r.source,
      channel: r.channel,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      paidAt: r.paid_at,
      createdAt: r.created_at,
    };
  }
}

module.exports = new BillingService();
