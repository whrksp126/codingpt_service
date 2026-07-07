const workspaceService = require('../services/workspaceService');
const workspaceNameService = require('../services/workspaceNameService');
const { successResponse, errorResponse } = require('../utils/response');

// 바이브코딩 사용자 워크스페이스 — objectstore 기반 CRUD.
// 모든 핸들러는 authMiddleware 통과 후 req.user.id 로 사용자 스코핑.

async function list(req, res) {
  try {
    const workspaces = await workspaceService.listWorkspaces(req.user.id);
    return successResponse(res, { workspaces });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function create(req, res) {
  try {
    const { name, description, stack, thumb, kind, compute, localPath } = req.body || {};
    const workspace = await workspaceService.createWorkspace(req.user.id, { name, description, stack, thumb, kind, compute, localPath });
    return successResponse(res, { workspace }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function getOne(req, res) {
  try {
    const workspace = await workspaceService.getWorkspace(req.user.id, req.params.workspaceId);
    return successResponse(res, { workspace });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function update(req, res) {
  try {
    const { name, description, stack, thumb, unread } = req.body || {};
    const workspace = await workspaceService.updateWorkspace(req.user.id, req.params.workspaceId, {
      name,
      description,
      stack,
      thumb,
      unread,
    });
    return successResponse(res, { workspace });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function duplicate(req, res) {
  try {
    const workspace = await workspaceService.duplicateWorkspace(req.user.id, req.params.workspaceId);
    return successResponse(res, { workspace }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function remove(req, res) {
  try {
    const result = await workspaceService.deleteWorkspace(req.user.id, req.params.workspaceId);
    return successResponse(res, result);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

// 사용자 설명 → 워크스페이스 이름 후보 추천(신규 생성 플로우)
async function suggestName(req, res) {
  try {
    const { description } = req.body || {};
    const names = await workspaceNameService.suggestNames(description);
    return successResponse(res, { names });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

module.exports = { list, create, getOne, update, duplicate, remove, suggestName };
