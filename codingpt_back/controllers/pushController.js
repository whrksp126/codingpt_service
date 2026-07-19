const pushService = require('../services/pushService');
const { successResponse, errorResponse } = require('../utils/response');

// POST /api/push/register  (auth) body:{ token, platform, provider?, alertWhenPcActive? } — 기기 푸시 토큰 등록/갱신
const register = async (req, res) => {
  try {
    const { token, platform, provider, alertWhenPcActive } = req.body || {};
    const device = await pushService.registerDevice(req.user.id, { token, platform, provider, alertWhenPcActive });
    successResponse(res, { id: device.id, platform: device.platform, enabled: device.enabled });
  } catch (error) {
    console.error('푸시 등록 오류:', error);
    errorResponse(res, error, 400);
  }
};

// POST /api/push/preferences  (auth) body:{ alertWhenPcActive } — 라우팅 토글(사용자의 모든 기기 일괄)
const preferences = async (req, res) => {
  try {
    const { alertWhenPcActive } = req.body || {};
    if (typeof alertWhenPcActive !== 'boolean') throw Object.assign(new Error('alertWhenPcActive(boolean) 이 필요합니다.'), { statusCode: 400 });
    const updated = await pushService.setAlertWhenPcActive(req.user.id, alertWhenPcActive);
    successResponse(res, { updated, alertWhenPcActive });
  } catch (error) {
    console.error('푸시 설정 오류:', error);
    errorResponse(res, error, error.statusCode || 400);
  }
};

// POST /api/push/unregister  (auth) body:{ token } — 기기 등록 해제
const unregister = async (req, res) => {
  try {
    const { token } = req.body || {};
    const removed = await pushService.unregisterDevice(req.user.id, token);
    successResponse(res, { removed });
  } catch (error) {
    console.error('푸시 해제 오류:', error);
    errorResponse(res, error, 400);
  }
};

module.exports = { register, unregister, preferences };
