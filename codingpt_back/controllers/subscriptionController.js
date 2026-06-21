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

// PUT /api/subscription/plans/:id — 플랜 편집 (어드민, 무인증 — 본인 전용 서비스)
const updatePlan = async (req, res) => {
  try {
    const plan = await subscriptionService.updatePlan(req.params.id, req.body || {});
    return successResponse(res, plan);
  } catch (error) {
    return errorResponse(res, error, 400);
  }
};

// GET /api/subscription/me — 내 구독 요약(상태·기간·예약 변경·연체 grace 포함, 없으면 null)
const getMine = async (req, res) => {
  try {
    const sub = await subscriptionService.getMineEnriched(req.user.id);
    return successResponse(res, sub);
  } catch (error) {
    return errorResponse(res, error);
  }
};

// POST /api/subscription/cancel — 해지 (기본: 기간 말 해지). body: { immediate?, reason? }
const cancel = async (req, res) => {
  try {
    const immediate = !!(req.body && req.body.immediate);
    const reason = (req.body && req.body.reason) || null;
    const sub = await subscriptionService.cancel(req.user.id, { immediate, reason });
    return successResponse(res, sub);
  } catch (error) {
    return errorResponse(res, error, 400);
  }
};

// POST /api/subscription/resume — 해지 취소(재개). 스토어 구독은 storeManaged 플래그 반환.
const resume = async (req, res) => {
  try {
    const result = await subscriptionService.resume(req.user.id);
    return successResponse(res, result);
  } catch (error) {
    return errorResponse(res, error, 400);
  }
};

// POST /api/subscription/change — 플랜 변경. body: { code }. 업=즉시 비례정산, 다운=기간말 예약.
const change = async (req, res) => {
  try {
    const code = req.body && req.body.code;
    if (!code) return errorResponse(res, new Error('code 가 필요합니다.'), 400);
    const result = await subscriptionService.changePlan(req.user.id, code);
    return successResponse(res, result);
  } catch (error) {
    return errorResponse(res, error, 400);
  }
};

module.exports = { getPlans, updatePlan, getMine, cancel, resume, change };
