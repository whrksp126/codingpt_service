const workspaceService = require('../services/workspaceService');
const workspaceNameService = require('../services/workspaceNameService');
const RUNNER = require('../config/runner'); // CLOUD_RUNNER_ENABLED — 클라우드 러너 제공 잠정 중단 게이트
const { successResponse, errorResponse } = require('../utils/response');

// 바이브코딩 사용자 워크스페이스 — objectstore 기반 CRUD.
// 모든 핸들러는 authMiddleware 통과 후 req.user.id 로 사용자 스코핑.

async function list(req, res) {
  try {
    const metas = await workspaceService.listWorkspaces(req.user.id);
    // 멀티기기: 각 로컬 워크스페이스에 호스트 이름/온라인 상태 인리치(사이드바 프로젝트 그룹/상태점).
    const workspaces = await workspaceService.enrichHosts(req.user.id, metas);
    return successResponse(res, { workspaces });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function create(req, res) {
  try {
    const { name, description, stack, thumb, kind, compute, localPath, remoteUrl } = req.body || {};
    // 클라우드 러너 잠정 중단 — 명시적 compute:'cloud'(클라우드 러너 볼륨 지정) 생성만 거부.
    //  compute 누락(채팅/바이브코딩 objectstore 워크스페이스 기본값)은 기존 동작 유지. 기존 클라우드
    //  워크스페이스의 조회/목록/삭제도 그대로(데이터 보존, 사용자가 정리 가능).
    if (compute === 'cloud' && !RUNNER.CLOUD_ENABLED) {
      return errorResponse(res, new Error('클라우드 워크스페이스 생성이 잠정 중단되어 있어요. 내 PC 폴더에 만들어 주세요.'), 403);
    }
    const workspace = await workspaceService.createWorkspace(req.user.id, { name, description, stack, thumb, kind, compute, localPath, remoteUrl });
    return successResponse(res, { workspace }, 'Created', 201);
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

// 프로젝트 그룹 수동 교정 — 분리(단독 프로젝트로) / 합치기(대상 워크스페이스의 프로젝트로).
async function projectDetach(req, res) {
  try {
    const workspace = await workspaceService.detachProject(req.user.id, req.params.workspaceId);
    return successResponse(res, { workspace });
  } catch (err) {
    return errorResponse(res, err, err.statusCode || 500);
  }
}

async function projectAttach(req, res) {
  try {
    const { targetWorkspaceId } = req.body || {};
    const workspace = await workspaceService.attachProject(req.user.id, req.params.workspaceId, targetWorkspaceId);
    return successResponse(res, { workspace });
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

module.exports = { list, create, getOne, update, duplicate, remove, suggestName, projectDetach, projectAttach };
