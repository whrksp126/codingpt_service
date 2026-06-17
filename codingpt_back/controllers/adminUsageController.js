const adminUsageService = require('../services/adminUsageService');
const { successResponse, errorResponse } = require('../utils/response');

// GET /api/admin/usage/summary?days=14 — 사용량 실측 집계 (어드민, 무인증)
const getSummary = async (req, res) => {
  try {
    const data = await adminUsageService.getSummary({ days: req.query.days });
    return successResponse(res, data);
  } catch (error) {
    return errorResponse(res, error);
  }
};

module.exports = { getSummary };
