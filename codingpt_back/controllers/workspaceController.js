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

// 로컬 워크스페이스의 귀속 PC 결정(JWT 경로) — 요청이 지정하면 소유 검증, 아니면 계정의 유일한 PC.
//  PC 가 여럿인데 지정이 없으면 추측하지 않는다(잘못 귀속시키면 다른 PC 목록에 유령이 생긴다).
//  그 경우는 목록 조회의 자동 복구도 손대지 않으므로, 클라이언트가 hostDeviceId 를 보내야 한다.
async function resolveOwnedHostForUser(userId, requestedId) {
  const { DaemonDevice } = require('../models');
  const rid = Number(requestedId);
  try {
    if (Number.isInteger(rid)) {
      const owned = await DaemonDevice.findOne({ where: { id: rid, user_id: userId, revoked_at: null } });
      if (owned && owned.role !== 'controller' && owned.runner_kind !== 'cloud') return rid;
    }
    const hosts = await DaemonDevice.findAll({
      where: { user_id: userId, revoked_at: null },
      attributes: ['id', 'role', 'runner_kind'],
    });
    const pcs = hosts.filter((d) => d.role !== 'controller' && d.runner_kind !== 'cloud');
    return pcs.length === 1 ? pcs[0].id : undefined;
  } catch (_) { return undefined; }
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
    // 로컬 워크스페이스는 **어느 PC 것인지**를 반드시 심는다.
    //  ★ 2026-09-07 실사고: 이 경로만 hostDeviceId 를 안 넘겨서, 여기로 등록된 워크스페이스가
    //   폰 사이드바에서 통째로 사라졌다(귀속이 없으면 클라가 '내 기기 것'으로 해석하는데,
    //   폰에서 그 PC 는 '내 기기'가 아니다). 데몬 경로(daemonController)는 원래부터 심고 있었다.
    //  클라이언트가 지정하면 소유 검증 후 그 PC, 없으면 계정의 PC 가 하나뿐일 때 그 PC.
    const hostDeviceId = compute === 'local'
      ? await resolveOwnedHostForUser(req.user.id, req.body && req.body.hostDeviceId)
      : undefined;
    const workspace = await workspaceService.createWorkspace(req.user.id, { name, description, stack, thumb, kind, compute, localPath, remoteUrl, hostDeviceId });
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
