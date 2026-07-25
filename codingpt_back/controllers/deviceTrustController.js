/**
 * 기기 신뢰(E2EE 열쇠 배포) 컨트롤러 — REST /api/daemon/e2ee/*
 *
 * 경로가 `/api/daemon/` 아래여야 하는 이유: PC 앱 브리지(bridge.rs back_api)는 이 접두사만
 *  화이트리스트로 통과시킨다 → Rust 무수정으로 PC 도 같은 API 를 쓸 수 있다(승인 인박스 선례).
 *
 * 인증: accountAuth(JWT|deviceToken 겸용). 모바일은 JWT, PC 데몬/앱은 deviceToken.
 *  ★ 이 표면은 "계정 로그인만으로 내 기기를 쓴다"는 기존 사용성을 그대로 둔다 — QR 재스캔 강요 없음.
 *
 * 컨트롤러는 얇게(back CLAUDE.md 규약): 검증/비즈니스는 deviceTrustService 가 전부 한다.
 * 서비스 에러는 { statusCode, code, publicDetail } 를 들고 오므로 그대로 HTTP 로 옮긴다.
 */
const deviceTrustService = require('../services/deviceTrustService');
const { successResponse, errorResponse } = require('../utils/response');

function fail(res, e) { return errorResponse(res, e, (e && e.statusCode) || 500); }

// 요청 IP — Cloudflare 경유이므로 CF-Connecting-IP 가 정본(레이트리밋 키 함정과 동일 규칙).
function ipOf(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip']
    || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();
}

// POST /api/daemon/e2ee/enroll — 모든 기기가 부팅/로그인 직후 호출(멱등).
//  → { state:'bootstrap'|'trusted'|'pending', … }
async function enroll(req, res) {
  try {
    const r = await deviceTrustService.enroll(req.account.userId, req.account.deviceId, req.body || {}, { ip: ipOf(req) });
    return successResponse(res, r);
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/bootstrap — 계정 최초 1회(승인해 줄 기기가 없을 때). 409 로 레이스 차단.
async function bootstrap(req, res) {
  try {
    const r = await deviceTrustService.bootstrap(req.account.userId, req.account.deviceId, req.body || {});
    return successResponse(res, r);
  } catch (e) { return fail(res, e); }
}

// GET /api/daemon/e2ee/pending — 신뢰 기기의 승인 시트(캐치업). push 는 힌트, pull 이 정본.
async function pending(req, res) {
  try {
    return successResponse(res, await deviceTrustService.listPending(req.account.userId));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/approve — 신뢰 기기가 MK 봉인문을 업로드. 서버는 암호문만 저장한다.
async function approve(req, res) {
  try {
    return successResponse(res, await deviceTrustService.approve(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/deny — 거절(+ 같은 키의 반복 신청 억제).
async function deny(req, res) {
  try {
    return successResponse(res, await deviceTrustService.deny(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// GET /api/daemon/e2ee/keyring?ikX=… — 감사 UI(기기·지문 목록) + 내 봉인문 수령.
async function keyring(req, res) {
  try {
    return successResponse(res, await deviceTrustService.keyring(req.account.userId, { ikX: (req.query || {}).ikX }));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/rotate — 기기 해제 후 epoch+1. 남은 기기 전부의 새 봉인문을 한 번에 올린다.
async function rotate(req, res) {
  try {
    return successResponse(res, await deviceTrustService.rotate(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// PATCH /api/daemon/e2ee/policy — off|preferred|required (계정 전체 동기화 값).
//  user 테이블 컬럼 추가(마이그레이션) 없이 키링 blob 에 보관한다.
async function policy(req, res) {
  try {
    return successResponse(res, await deviceTrustService.setPolicy(req.account.userId, (req.body || {}).policy));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/recovery — 복구 코드 봉인문 등록/교체(전 기기 소실 대비).
async function recovery(req, res) {
  try {
    return successResponse(res, await deviceTrustService.setRecovery(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

module.exports = { enroll, bootstrap, pending, approve, deny, keyring, rotate, policy, recovery };
