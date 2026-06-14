const projectService = require('../services/projectService');
const { successResponse, errorResponse } = require('../utils/response');

// 바이브코딩 사용자 프로젝트 — objectstore 워크스페이스 기반 CRUD.
// 모든 핸들러는 authMiddleware 통과 후 req.user.id 로 사용자 스코핑.

async function list(req, res) {
  try {
    const projects = await projectService.listProjects(req.user.id);
    return successResponse(res, { projects });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function create(req, res) {
  try {
    const { name, description, stack, thumb } = req.body || {};
    const project = await projectService.createProject(req.user.id, { name, description, stack, thumb });
    return successResponse(res, { project }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function getOne(req, res) {
  try {
    const project = await projectService.getProject(req.user.id, req.params.projectId);
    return successResponse(res, { project });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function update(req, res) {
  try {
    const { name, description, stack, thumb, unread } = req.body || {};
    const project = await projectService.updateProject(req.user.id, req.params.projectId, {
      name,
      description,
      stack,
      thumb,
      unread,
    });
    return successResponse(res, { project });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function duplicate(req, res) {
  try {
    const project = await projectService.duplicateProject(req.user.id, req.params.projectId);
    return successResponse(res, { project }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function remove(req, res) {
  try {
    const result = await projectService.deleteProject(req.user.id, req.params.projectId);
    return successResponse(res, result);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

module.exports = { list, create, getOne, update, duplicate, remove };
