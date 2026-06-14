const ideProjectService = require('../services/ideProjectService');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * 모바일 IDE 프로젝트 소스 조회
 * GET /api/lesson/ide/:projectId
 */
const getIdeProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await ideProjectService.getProject(projectId, req.user && req.user.id);
    successResponse(res, project);
  } catch (error) {
    errorResponse(res, error, error.statusCode || 500);
  }
};

/**
 * 모바일 IDE 에셋(이미지 등) — 이미지 프리뷰용 data URL(JSON) 반환.
 * RN <Image> 헤더 인증은 토큰 만료 시 재발급을 못 하므로, apiRequest(자동 refresh) 로
 * 받을 수 있게 base64 data URL 을 JSON 으로 내려준다.
 * GET /api/lesson/ide/:projectId/asset?path=<상대경로>
 */
const getIdeAsset = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { path } = req.query;
    const { buffer, contentType } = await ideProjectService.getAsset(projectId, path);
    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    successResponse(res, { dataUrl, contentType, size: buffer.length });
  } catch (error) {
    errorResponse(res, error, error.statusCode || 500);
  }
};

/**
 * 모바일 IDE 프로젝트 저장 — 편집(에이전트/사용자) 영속화
 * POST /api/lesson/ide/:projectId/save  body: { files: [{path, content}] }
 */
const saveIdeProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { files } = req.body || {};
    const result = await ideProjectService.saveProject(projectId, req.user && req.user.id, files);
    successResponse(res, result);
  } catch (error) {
    errorResponse(res, error, error.statusCode || 500);
  }
};

module.exports = { getIdeProject, getIdeAsset, saveIdeProject };
