/**
 * 원격 승인 인박스 컨트롤러 — REST /api/daemon/approvals/*
 *
 * 경로가 `/api/daemon/` 아래여야 하는 이유: PC 앱의 back_api 브리지는 `/api/daemon/` 접두사만
 *  화이트리스트로 통과시킨다(Rust 무수정으로 PC 가 이 API 를 쓸 수 있게 하려면 이 접두사 필수).
 *
 * daemonController(1,100줄+)에 넣지 않고 파일을 분리한 이유:
 *  ① 인증 규칙이 다르다 — 생성/취소는 **실 deviceToken 기기(데몬)만**(모바일 JWT 로 위조 금지),
 *     응답/조회는 JWT|deviceToken 겸용. 한 파일에서 규칙이 섞이면 실수가 난다.
 *  ② 전용 서비스(approvalService)를 얇게 감싸기만 하며, daemonController 의 callRpc 프록시 관례와
 *     성격이 다르다(에러 코드/409 시맨틱을 그대로 노출해야 한다).
 *  선례: notificationController 도 accountAuth 기반 신규 도메인이라 파일을 분리했다.
 *
 * 인증: accountAuth(JWT|deviceToken 겸용)가 라우트에 붙어 req.account 를 채운다.
 */
const approvalService = require('../services/approvalService');
const { successResponse, errorResponse } = require('../utils/response');

// 에러 → HTTP. code/resolvedBy 는 클라이언트가 분기하는 계약이므로 errorResponse 의
//  publicDetail 경로로 본문 `detail` 에 실어 보낸다(approvalService.err 가 이미 채워준다).
function fail(res, e) {
  return errorResponse(res, e, (e && e.statusCode) || 500);
}

// 요청자 신원(누가 응답했는지 카드/로그에 표기) — deviceId 는 서버가 아는 값만 신뢰하고,
//  표시용 이름은 기기 레지스트리 → 클라이언트 신고 순으로 채운다.
function actorOf(req) {
  const acct = req.account || {};
  const b = req.body || {};
  const kind = acct.deviceId != null ? 'pc' : 'mobile';
  const name = (acct.device && acct.device.device_name)
    || (typeof b.deviceName === 'string' ? b.deviceName.slice(0, 64) : '')
    || (kind === 'pc' ? 'PC' : '모바일');
  return { kind, deviceId: acct.deviceId ?? null, deviceName: name };
}

// POST /api/daemon/approvals  (데몬 전용) — 승인 요청 등록. 응답 { id, deadlineAt, notifId, responders, defer }
//  defer:true 면 데몬은 즉시 훅을 defer(=TUI 폴백)해야 한다(상한 초과/기능 OFF).
async function create(req, res) {
  try {
    // 위조 방지: 모바일 JWT 로는 가짜 승인 카드를 만들 수 없다(실 deviceToken 기기만).
    if (req.account.deviceId == null) {
      return errorResponse(res, Object.assign(new Error('승인 요청은 PC 데몬만 등록할 수 있습니다.'),
        { publicDetail: { code: 'DEVICE_TOKEN_REQUIRED' } }), 403);
    }
    const hostName = (req.account.device && req.account.device.device_name) || '';
    const result = await approvalService.create(req.account.userId, req.account.deviceId, hostName, req.body || {});
    return successResponse(res, result);
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/approvals/:id/cancel  (데몬 전용) — body { reason }
//  reason: timeout | hook_gone | session_gone | terminal_answer
async function cancel(req, res) {
  try {
    if (req.account.deviceId == null) {
      return errorResponse(res, Object.assign(new Error('승인 취소는 PC 데몬만 요청할 수 있습니다.'),
        { publicDetail: { code: 'DEVICE_TOKEN_REQUIRED' } }), 403);
    }
    const result = await approvalService.cancel(req.account.userId, req.params.id, (req.body || {}).reason);
    return successResponse(res, result);
  } catch (e) { return fail(res, e); }
}

// GET /api/daemon/approvals — 대기 중 승인 목록(딥링크 콜드스타트·앱 복귀·PC 부팅 캐치업).
//  push 는 힌트, pull 이 정본 — 클라이언트는 재접속마다 이걸 다시 부른다.
async function list(req, res) {
  try {
    return successResponse(res, approvalService.list(req.account.userId));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/approvals/:id/respond — body { decision:'allow'|'deny'|'answer', message?, answer?, always? }
//  409 ALREADY_RESOLVED(다른 기기/터미널이 먼저) · 410 EXPIRED · 409 HOST_OFFLINE · 404 NOT_FOUND
async function respond(req, res) {
  try {
    const result = await approvalService.respond(req.account.userId, req.params.id, req.body || {}, actorOf(req));
    return successResponse(res, result);
  } catch (e) { return fail(res, e); }
}

module.exports = { create, cancel, list, respond };
