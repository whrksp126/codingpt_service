/**
 * 계정 스코프 인증(멀티기기) — deviceToken(PC/컨트롤러) | user JWT(모바일) 겸용.
 *
 * daemonController.resolveAccount 를 추출해 미들웨어화한 것. 기존 컨트롤러들은 resolveAccount 를
 * 그대로 import 해 쓰고(하위호환), 신규 라우트(알림 등)는 미들웨어로 붙인다.
 *
 * 성공 시:
 *  - req.account = { userId, deviceId|null, device|null }  (deviceId=현재 기기 식별)
 *  - req.user    = 없으면 { id: userId } 채움 (기존 authMiddleware 사용 코드와 호환)
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { DaemonDevice } = require('../models');
const { errorResponse } = require('../utils/response');

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Authorization: Bearer <deviceToken> → 해당 DaemonDevice(폐기 안 됨). 아니면 null.
//  보안: 컨트롤러(모바일) 기기의 token_hash 는 sha256('ctrl:'+deviceUuid) 로, deviceUuid 는 비밀이
//  아니다(헤더/로그 노출·약한 난수). 이를 bearer 자격증명으로 인정하면 `Bearer ctrl:<uuid>` 로 계정
//  탈취가 가능하다. 컨트롤러는 원래 user JWT 로 인증하므로 deviceToken 매칭에서 role='controller' 를
//  반드시 제외한다(실제 랜덤 deviceToken 을 가진 PC/러너 기기만 인정).
async function resolveDeviceUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const raw = m[1].trim();
  // 실제 deviceToken 은 'cptd_' 접두사(createDeviceForUser). 컨트롤러 파생키('ctrl:...')는 bearer 로 불허.
  if (!raw.startsWith('cptd_')) return null;
  const device = await DaemonDevice.findOne({
    where: { token_hash: sha256(raw), revoked_at: null, role: { [Op.ne]: 'controller' } },
  });
  return device || null;
}

// 계정 스코프 인증 — deviceToken 우선, 아니면 user JWT. 실패 시 null.
async function resolveAccount(req) {
  const device = await resolveDeviceUser(req);
  if (device) return { userId: device.user_id, deviceId: device.id, device };
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) {
    try {
      const decoded = jwt.verify(m[1].trim(), process.env.ACCESS_SECRET, { algorithms: ['HS256'] });
      if (decoded && decoded.id) return { userId: decoded.id, deviceId: null, device: null };
    } catch (_) { /* deviceToken 도 JWT 도 아님 */ }
  }
  return null;
}

// Express 미들웨어 — 인증 실패 시 401.
async function accountAuth(req, res, next) {
  try {
    const acct = await resolveAccount(req);
    if (!acct) return errorResponse(res, new Error('인증이 필요합니다.'), 401);
    req.account = acct;
    if (!req.user) req.user = { id: acct.userId }; // 기존 req.user.id 사용 코드와 호환
    return next();
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

module.exports = accountAuth;
module.exports.resolveAccount = resolveAccount;
module.exports.resolveDeviceUser = resolveDeviceUser;
