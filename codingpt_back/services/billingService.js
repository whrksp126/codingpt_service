const crypto = require('crypto');
const { Payment, sequelize } = require('../models');
const portoneService = require('./portoneService');
const subscriptionService = require('./subscriptionService');

// 결제 오케스트레이션 (월 구독 전용): 체크아웃 의도 생성 → 빌링키 발급 → 첫 달 청구 + 구독 활성화.
// 크레딧 충전(환금성) 모델은 제거됨.

class BillingService {
  // 구독 체크아웃 의도 생성. 서버 권위 금액으로 payment(ready) 행을 만들고
  // 웹이 PortOne 빌링키 발급창을 띄우는 데 필요한 값들을 반환한다.
  async createCheckout(userId, { type, code }) {
    if (type !== 'subscription') throw new Error('지원하지 않는 결제 유형입니다. (월 구독만 지원)');
    const plan = await subscriptionService.getPlanByCode(code);
    if (!plan || !plan.is_active) throw new Error('존재하지 않는 플랜입니다.');
    if (plan.price_krw <= 0) throw new Error('무료 플랜은 결제가 필요하지 않습니다.');
    const paymentId = `sub-${userId}-${crypto.randomUUID()}`;
    await Payment.create({
      payment_id: paymentId, user_id: userId, type: 'subscription', channel: 'inicis_billing',
      ref_id: plan.id, amount_krw: plan.price_krw, status: 'ready',
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

      payment.status = 'paid';
      payment.paid_at = new Date();
      payment.pg_tx_id = pg.pgTxId || pg.transactionId || null;
      payment.billing_key = (pg.billingKey || (pg.method && pg.method.billingKey)) || payment.billing_key;
      payment.raw_response = pg;
      payment.updated_at = new Date();
      await payment.save({ transaction: t });

      await subscriptionService.activateSubscription(payment.user_id, payment.ref_id, {
        billingKey: payment.billing_key, paymentId, periodMonths: 1,
      }, t);

      return { payment, applied: true };
    });
  }

  // 구독 활성화 — 빌링키 발급 후 첫 달 청구 + 구독 활성화.
  async subscribeWithBillingKey(userId, paymentId, billingKey) {
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

    return this.verifyAndApplyPayment(paymentId, userId);
  }

  // 결제 내역(웹 구매내역)
  async getPayments(userId, { page = 1, limit = 20 } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const { rows, count } = await Payment.findAndCountAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      offset: (p - 1) * l, limit: l,
    });
    return { rows, total: count, page: p, limit: l };
  }
}

module.exports = new BillingService();
