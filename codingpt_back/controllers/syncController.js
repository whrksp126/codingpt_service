/**
 * 동기화 컨트롤러(M4) — sync 채널 REST 프록시.
 *  presigned URL 발급 + 데몬 RPC 오케스트레이션은 syncService 가 담당. 여기선 요청/응답만.
 *  데몬 오프라인이면 통일된 409(mapRpcError).
 */
const syncService = require('../services/syncService');
const { successResponse, errorResponse } = require('../utils/response');

function mapErr(res, e) {
  if (e && e.message === 'DAEMON_OFFLINE') return errorResponse(res, new Error('PC 데몬이 연결되어 있지 않습니다.'), 409);
  return errorResponse(res, e, (e && e.statusCode) || 500);
}

// POST /api/daemon/sync/checkpoint  body:{ workspaceId, reason?, includeAgentSession?, cwd? }
//  cwd 는 역방향 핸드오프(클라우드 실폴더서 스냅샷)용 오버라이드. 미지정=ws.localPath.
async function checkpoint(req, res) {
  try {
    const { workspaceId, reason, includeAgentSession, cwd, background } = req.body || {};
    const result = await syncService.checkpoint(req.user.id, workspaceId, { reason, includeAgentSession, cwd, background: !!background });
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// POST /api/daemon/sync/checkpoint/begin  body:{ workspaceId, reason?, cwd? }
//  → { checkpointId, putUrls:{bundle,session}, cwd, reason }
//  데몬이 **직접**(deviceToken) 부른다 — 좌표만 받고 로컬 작업/업로드는 데몬이 스스로 한다.
//  ⚠ 인증은 accountAuth 여야 한다. authMiddleware(JWT 전용)로 붙이면 데몬이 401 을 받고 PC 는
//   영구히 구 경로로 폴백해, 기능이 "정상 동작하는 것처럼 보이면서" 조용히 무발현이 된다.
async function checkpointBegin(req, res) {
  try {
    const { workspaceId, reason, cwd } = req.body || {};
    const result = await syncService.checkpointBegin(req.user.id, workspaceId, { reason, cwd });
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// POST /api/daemon/sync/checkpoint/commit
//  body:{ workspaceId, checkpointId, skipped?, unchanged?, baseCommit, commit, sizeBytes, hasSession, enc?, epoch? }
//  → { …entry, head } 또는 { skipped:true, unchanged:true, checkpointId, head }
async function checkpointCommit(req, res) {
  try {
    const b = req.body || {};
    const result = await syncService.checkpointCommit(req.user.id, b.workspaceId, b);
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// POST /api/daemon/sync/materialize  body:{ workspaceId, checkpointId?, targetCwd, reinstall? }
async function materialize(req, res) {
  try {
    const { workspaceId, checkpointId, targetCwd, reinstall } = req.body || {};
    const result = await syncService.materialize(req.user.id, workspaceId, { checkpointId, targetCwd, reinstall });
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// GET /api/daemon/sync/status?workspaceId=&cwd=
async function status(req, res) {
  try {
    const result = await syncService.status(req.user.id, req.query.workspaceId, { cwd: req.query.cwd });
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// POST /api/daemon/sync/resolve  body:{ workspaceId, conflictId, choices?, bulk? }
async function resolve(req, res) {
  try {
    const { workspaceId, conflictId, choices, bulk } = req.body || {};
    const result = await syncService.resolve(req.user.id, workspaceId, { conflictId, choices, bulk });
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// GET /api/daemon/sync/checkpoints?workspaceId=
async function listCheckpoints(req, res) {
  try {
    const result = await syncService.listCheckpoints(req.user.id, req.query.workspaceId);
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

// POST /api/daemon/sync/multipart/:action  body:{ wsId, checkpointId, kind, uploadId?, partNumber?, parts? }
//  대용량 번들 멀티파트 업로드(데몬 콜백, accountAuth). action = init | part-url | complete | abort.
const MULTIPART_ACTIONS = {
  'init': syncService.multipartInit,
  'part-url': syncService.multipartPartUrl,
  'complete': syncService.multipartComplete,
  'abort': syncService.multipartAbort,
};
async function multipart(req, res) {
  try {
    const fn = MULTIPART_ACTIONS[req.params.action];
    if (!fn) return errorResponse(res, new Error('알 수 없는 멀티파트 액션입니다.'), 404);
    const result = await fn(req.user.id, req.body || {});
    return successResponse(res, result);
  } catch (e) { return mapErr(res, e); }
}

module.exports = { checkpoint, checkpointBegin, checkpointCommit, materialize, status, resolve, listCheckpoints, multipart };
