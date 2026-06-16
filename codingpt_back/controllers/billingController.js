const jwt = require('jsonwebtoken');
const billingService = require('../services/billingService');
const BILLING = require('../config/billing');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');

const ACCESS_SECRET = process.env.ACCESS_SECRET;

// POST /api/billing/checkout — 구독 체크아웃 의도 생성 → 결제창 파라미터 반환. body: { type:'subscription', code }
const checkout = async (req, res) => {
  try {
    const { type, code } = req.body || {};
    if (!code) return errorResponse(res, new Error('code 가 필요합니다.'), 400);
    const result = await billingService.createCheckout(req.user.id, { type: type || 'subscription', code });
    return successResponse(res, result);
  } catch (error) { return errorResponse(res, error, 400); }
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

// GET /api/billing/payments — 구매내역
const getPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { rows, total } = await billingService.getPayments(req.user.id, { page, limit });
    return paginatedResponse(res, rows, page, limit, total);
  } catch (error) { return errorResponse(res, error); }
};

// POST /api/billing/web-session — 앱→웹 핸드오프. 같은 user_id 로 결제 웹에 로그인할 단기 토큰.
const createWebSession = async (req, res) => {
  try {
    const u = req.user;
    const token = jwt.sign({ id: u.id, email: u.email, role: u.role, scope: 'web' }, ACCESS_SECRET, { expiresIn: '30m' });
    return successResponse(res, { token, webUrl: BILLING.PAYMENT_WEB_URL });
  } catch (error) { return errorResponse(res, error); }
};

module.exports = { checkout, subscribe, getPayments, createWebSession };
