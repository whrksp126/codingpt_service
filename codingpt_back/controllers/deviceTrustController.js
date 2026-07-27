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

/**
 * 모든 응답에 `userRef` 를 실어 보낸다 — **사람이 대조하는 안전코드의 파생 기준**이다.
 *
 * ★ 왜 서버가 줘야 하는가(2026-07-26 실기기 실측으로 확인된 사고)
 *   안전코드/지문은 `HKDF(ikX, userRef)` 로 파생하므로 **모든 기기가 글자 하나까지 같은 ref** 를
 *   써야 화면 대조가 성립한다. 데몬·PC 는 `GET /api/daemon/me` 의 id 를 쓰는데, 앱은 이 필드가
 *   오기를 기다리고 있었고(앱 `e2ee.ts:604` 주석 "확인 숫자 기준은 서버 userRef") 서버는 **한 번도
 *   보내지 않았다**. 그래서 앱은 ref=''(빈 문자열)로 파생 → 같은 기기에 대해 데몬은 `0727`,
 *   앱은 `8212` 를 계산했다. 즉 **폰↔PC 안전코드 대조가 처음부터 동작한 적이 없다.**
 *   (실측: prod 로그 `code=0727` = 데몬/PC 계산값, 앱 화면은 "직접 계산한 값과 달랐습니다" 경고)
 *
 * 값은 비밀이 아니다 — 서버가 위조해도 **두 기기에 같게** 주므로 대조는 여전히 성립한다
 * (숫자를 지배하는 입력은 기기 공개키 ikX 다). 그래서 그냥 userId 를 문자열로 준다.
 * 클라이언트가 이 값을 못 받으면 **아무 숫자도 그리지 않아야** 한다(틀린 코드를 대조시키는 것이
 * 최악 — 앱 `fpRef()` 주석 참조). 세 구현체가 같은 규칙이어야 하므로 한쪽만 바꾸지 말 것.
 */
function ok(res, userId, data) {
  return successResponse(res, Object.assign({ userRef: String(userId) }, data || {}));
}

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
    return ok(res, req.account.userId, r);
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/bootstrap — 계정 최초 1회(승인해 줄 기기가 없을 때). 409 로 레이스 차단.
async function bootstrap(req, res) {
  try {
    const r = await deviceTrustService.bootstrap(req.account.userId, req.account.deviceId, req.body || {});
    return ok(res, req.account.userId, r);
  } catch (e) { return fail(res, e); }
}

// GET /api/daemon/e2ee/pending?ikX=… — 신뢰 기기의 승인 시트(캐치업). push 는 힌트, pull 이 정본.
//  ★ ikX(호출자 자기 공개키)는 **선택**이지만 주면 서버가 "이 기기가 승인할 수 있는 것"만 돌려준다
//   (자기 요청 제외 + 미신뢰 호출자면 빈 목록 — listPending 주석 참조). 구 클라이언트는 안 보내므로
//   그때는 기존 동작(전량)을 유지한다.
async function pending(req, res) {
  try {
    const ikX = typeof req.query?.ikX === 'string' ? req.query.ikX : null;
    return ok(res, req.account.userId, await deviceTrustService.listPending(req.account.userId, { ikX }));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/approve — 신뢰 기기가 MK 봉인문을 업로드. 서버는 암호문만 저장한다.
async function approve(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.approve(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/deny — 거절(+ 같은 키의 반복 신청 억제).
async function deny(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.deny(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// GET /api/daemon/e2ee/keyring?ikX=… — 감사 UI(기기·지문 목록) + 내 봉인문 수령.
async function keyring(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.keyring(req.account.userId, { ikX: (req.query || {}).ikX }));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/rotate — 기기 해제 후 epoch+1. 남은 기기 전부의 새 봉인문을 한 번에 올린다.
async function rotate(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.rotate(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

// PATCH /api/daemon/e2ee/policy — off|preferred|required (계정 전체 동기화 값).
//  user 테이블 컬럼 추가(마이그레이션) 없이 키링 blob 에 보관한다.
async function policy(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.setPolicy(req.account.userId, (req.body || {}).policy));
  } catch (e) { return fail(res, e); }
}

// POST /api/daemon/e2ee/recovery — 복구 코드 봉인문 등록/교체(전 기기 소실 대비).
async function recovery(req, res) {
  try {
    return ok(res, req.account.userId, await deviceTrustService.setRecovery(req.account.userId, req.body || {}));
  } catch (e) { return fail(res, e); }
}

module.exports = { enroll, bootstrap, pending, approve, deny, keyring, rotate, policy, recovery };
