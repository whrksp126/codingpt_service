/**
 * 알림 동기화 컨트롤러 — REST /api/notifications (인증: accountAuth, JWT|deviceToken 겸용).
 * 비즈니스 로직은 notificationService, 라이브 팬아웃은 daemonRelayService(notif_event).
 */
const notificationService = require('../services/notificationService');
const { successResponse, errorResponse } = require('../utils/response');

// POST /api/notifications — 알림 발행(클라이언트 발행 경로. 에이전트 알림은 릴레이가 내부 생성).
async function create(req, res) {
  try {
    const notification = await notificationService.createNotification(req.account.userId, req.body || {});
    return successResponse(res, notification);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// GET /api/notifications?limit=50&beforeId=<id> — 목록(최신순) + unreadCount.
async function list(req, res) {
  try {
    const result = await notificationService.list(req.account.userId, {
      limit: req.query.limit,
      beforeId: req.query.beforeId,
    });
    return successResponse(res, result);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/notifications/read — body { ids:[...] } 또는 { scope:{cwd, win|null} } → { ids:[처리된 id...] }
async function markRead(req, res) {
  try {
    const b = req.body || {};
    const result = await notificationService.markRead(req.account.userId, { ids: b.ids, scope: b.scope });
    return successResponse(res, result);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/notifications/read-all → { ids:[...] }
async function markAllRead(req, res) {
  try {
    const result = await notificationService.markAllRead(req.account.userId);
    return successResponse(res, result);
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

module.exports = { create, list, markRead, markAllRead };
