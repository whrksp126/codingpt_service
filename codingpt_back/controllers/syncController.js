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
    const { workspaceId, reason, includeAgentSession, cwd } = req.body || {};
    const result = await syncService.checkpoint(req.user.id, workspaceId, { reason, includeAgentSession, cwd });
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

module.exports = { checkpoint, materialize, status, resolve, listCheckpoints };
