const usageService = require('../services/usageService');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');

// GET /api/usage/status — 앱 사용량 pill / 웹 대시보드
const getStatus = async (req, res) => {
  try {
    const status = await usageService.getUsageStatus(req.user.id);
    return successResponse(res, status);
  } catch (error) {
    return errorResponse(res, error);
  }
};

// GET /api/usage/history?page=&limit= — 사용 내역
const getHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { rows, total } = await usageService.getHistory(req.user.id, { page, limit });
    return paginatedResponse(res, rows, page, limit, total);
  } catch (error) {
    return errorResponse(res, error);
  }
};

module.exports = { getStatus, getHistory };
