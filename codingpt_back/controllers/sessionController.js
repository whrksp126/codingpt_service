const sessionService = require('../services/sessionService');
const { successResponse, errorResponse } = require('../utils/response');

// 워크스페이스 하위 세션(채팅) CRUD. mergeParams 로 req.params.workspaceId 접근.
// 모든 핸들러는 authMiddleware 통과 후 req.user.id 로 사용자 스코핑.

async function list(req, res) {
  try {
    const sessions = await sessionService.listSessions(req.user.id, req.params.workspaceId);
    return successResponse(res, { sessions });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function create(req, res) {
  try {
    const { title } = req.body || {};
    const session = await sessionService.createSession(req.user.id, req.params.workspaceId, { title });
    return successResponse(res, { session }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function getOne(req, res) {
  try {
    const result = await sessionService.getSession(req.user.id, req.params.workspaceId, req.params.sessionId);
    return successResponse(res, result);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function update(req, res) {
  try {
    const { title, sdkSessionId, messages } = req.body || {};
    const session = await sessionService.updateSession(req.user.id, req.params.workspaceId, req.params.sessionId, {
      title,
      sdkSessionId,
      messages,
    });
    return successResponse(res, { session });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function remove(req, res) {
  try {
    const result = await sessionService.deleteSession(req.user.id, req.params.workspaceId, req.params.sessionId);
    return successResponse(res, result);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

module.exports = { list, create, getOne, update, remove };
