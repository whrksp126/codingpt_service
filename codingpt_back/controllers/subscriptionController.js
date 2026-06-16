const subscriptionService = require('../services/subscriptionService');
const { successResponse, errorResponse } = require('../utils/response');

// GET /api/subscription/plans — 플랜 카탈로그 (공개)
const getPlans = async (req, res) => {
  try {
    const plans = await subscriptionService.getPlans();
    return successResponse(res, plans);
  } catch (error) {
    return errorResponse(res, error);
  }
};

// GET /api/subscription/me — 내 활성 구독 (없으면 null)
const getMine = async (req, res) => {
  try {
    const sub = await subscriptionService.getActiveSubscription(req.user.id);
    return successResponse(res, sub);
  } catch (error) {
    return errorResponse(res, error);
  }
};

// POST /api/subscription/cancel — 해지 (기본: 기간 말 해지)
const cancel = async (req, res) => {
  try {
    const immediate = !!(req.body && req.body.immediate);
    const sub = await subscriptionService.cancel(req.user.id, { immediate });
    return successResponse(res, sub);
  } catch (error) {
    return errorResponse(res, error, 400);
  }
};

module.exports = { getPlans, getMine, cancel };
