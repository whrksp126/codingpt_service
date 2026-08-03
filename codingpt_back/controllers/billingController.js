const jwt = require('jsonwebtoken');
const billingService = require('../services/billingService');
const rcBillingService = require('../services/rcBillingService');
const portoneService = require('../services/portoneService');
const BILLING = require('../config/billing');
const lemonSqueezyService = require('../services/lemonSqueezyService');
const { User, UserSubscription } = require('../models');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');

// GET /api/billing/portone-config — 결제수단 변경 등 결제창에 필요한 storeId/channelKey (시크릿 아님)
const portoneConfig = async (req, res) => {
  try {
    return successResponse(res, {
      storeId: portoneService.getStoreId(),
      channelKey: portoneService.getChannelKey('subscription'),
    });
  } catch (error) { return errorResponse(res, error); }
};

const ACCESS_SECRET = process.env.ACCESS_SECRET;

// POST /api/billing/checkout — 구독 체크아웃 의도 생성 → 결제창 파라미터 반환. body: { type:'subscription', code }
const checkout = async (req, res) => {
  try {
    const { type, code } = req.body || {};
    if (!code) return errorResponse(res, new Error('code 가 필요합니다.'), 400);
    if (code === 'supporter') return errorResponse(res, new Error('Supporter는 글로벌 결제 페이지를 이용해 주세요.'), 400);
    const result = await billingService.createCheckout(req.user.id, { type: type || 'subscription', code });
    return successResponse(res, result);
  } catch (error) { return errorResponse(res, error, 400); }
};

// 글로벌 웹 구독 — Lemon Squeezy 호스팅 체크아웃/고객 포털.
const lemonSqueezyCheckout = async (req, res) => {
  try {
    if (!BILLING.SALES_OPEN) return errorResponse(res, new Error('Supporter 결제를 준비하고 있어요.'), 403);
    const { code } = req.body || {};
    if (code !== 'supporter') return errorResponse(res, new Error('지원하지 않는 플랜입니다.'), 400);
    const current = await UserSubscription.findOne({ where: { user_id: req.user.id, status: ['active', 'past_due'] } });
    if (current) return errorResponse(res, new Error('이미 이용 중인 구독이 있어요.'), 409);
    const user = await User.findByPk(req.user.id, { attributes: ['id', 'email', 'nickname'] });
    if (!user) return errorResponse(res, new Error('사용자를 찾을 수 없습니다.'), 404);
    const url = await lemonSqueezyService.createSupporterCheckout({ userId: user.id, email: user.email, name: user.nickname });
    if (!url) throw new Error('결제 URL을 생성하지 못했습니다.');
    return successResponse(res, { url });
  } catch (error) { return errorResponse(res, error, error.statusCode || 400); }
};

const lemonSqueezyPortal = async (req, res) => {
  try {
    const sub = await UserSubscription.findOne({ where: { user_id: req.user.id, source: 'lemonsqueezy', status: ['active', 'past_due', 'paused'] } });
    if (!sub || !sub.billing_key) return errorResponse(res, new Error('관리할 Supporter 구독이 없습니다.'), 404);
    const url = await lemonSqueezyService.getCustomerPortalUrl(sub.billing_key);
    if (!url) throw new Error('구독 관리 페이지를 열지 못했습니다.');
    return successResponse(res, { url });
  } catch (error) { return errorResponse(res, error, error.statusCode || 400); }
};

// POST /api/billing/subscribe — 빌링키 발급 후 구독 활성화. body: { paymentId, billingKey }
const subscribe = async (req, res) => {
  try {
    const { paymentId, billingKey } = req.body || {};
    if (!paymentId || !billingKey) return errorResponse(res, new Error('paymentId 와 billingKey 가 필요합니다.'), 400);
    const result = await billingService.subscribeWithBillingKey(req.user.id, paymentId, billingKey);
    return successResponse(res, { paymentId, applied: result.applied, alreadyPaid: !!result.alreadyPaid });
  } catch (error) { return errorResponse(res, error, 400); }
};

// GET /api/billing/payments — 결제 내역(영수증)
const getPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { rows, total } = await billingService.getPayments(req.user.id, { page, limit });
    return paginatedResponse(res, rows, page, limit, total);
  } catch (error) { return errorResponse(res, error); }
};

// GET /api/billing/payments/:id — 단건 영수증 (소유권 강제)
const getPaymentReceipt = async (req, res) => {
  try {
    const receipt = await billingService.getPaymentReceipt(req.user.id, req.params.id);
    return successResponse(res, receipt);
  } catch (error) { return errorResponse(res, error, error.status || 400); }
};

// GET /api/billing/payment-method — 저장된 결제 수단(표시용). 무료 계정 포함.
const getPaymentMethodInfo = async (req, res) => {
  try {
    return successResponse(res, await billingService.getPaymentMethod(req.user.id));
  } catch (error) { return errorResponse(res, error); }
};

// POST /api/billing/payment-method — 결제수단(빌링키) 등록/교체. body: { billingKey, retryNow? }
const updatePaymentMethod = async (req, res) => {
  try {
    const { billingKey, retryNow } = req.body || {};
    if (!billingKey) return errorResponse(res, new Error('billingKey 가 필요합니다.'), 400);
    const result = await billingService.updatePaymentMethod(req.user.id, billingKey, { retryNow: retryNow !== false });
    return successResponse(res, result);
  } catch (error) { return errorResponse(res, error, 400); }
};

// POST /api/billing/web-session — 앱→웹 핸드오프. 토큰을 URL 에 직접 싣지 않기 위해 일회용 코드(90초, 1회 소진)를
//  발급하고, 웹이 로드 시 /api/users/handoff/redeem 으로 코드를 토큰으로 교환한다(로그·프록시 노출 방지).
const createWebSession = async (req, res) => {
  try {
    const { code } = await require('../services/userService').issueHandoff(req.user.id);
    return successResponse(res, { code, webUrl: BILLING.PAYMENT_WEB_URL });
  } catch (error) { return errorResponse(res, error); }
};

// POST /api/billing/iap/sync — 스토어 구매 직후 RevenueCat entitlement 확인 후 즉시 활성화.
const iapSync = async (req, res) => {
  try {
    const result = await rcBillingService.syncFromRevenueCat(req.user.id);
    return successResponse(res, result);
  } catch (error) { return errorResponse(res, error, 400); }
};

module.exports = { checkout, lemonSqueezyCheckout, lemonSqueezyPortal, subscribe, getPayments, getPaymentReceipt, getPaymentMethodInfo, updatePaymentMethod, portoneConfig, createWebSession, iapSync };
