/**
 * 인터랙티브 터미널(PTY) 프록시 컨트롤러
 *
 * 모바일 IDE의 실시간 터미널: 앱(xterm.js WebView) → back(ws 투명 프록시) → 워커(ws 종단)
 *  → 사용자 샌드박스 TTY 셸. 키 입력/방향키/탭완성을 실제 셸이 처리.
 *
 * 인증: /start 만 JWT(authMiddleware). ws 업그레이드(GET /api/terminal/:token)는 WebView/네이티브 WS 라
 *       Authorization 헤더를 못 싣는다 → 미리보기와 동일하게 **불투명 토큰**으로 보호.
 *       토큰은 /start(인증) 시 발급되고 token→{userId,projectId} 매핑으로 사용자 샌드박스를 고른다.
 * 단일 워커/back 인스턴스 전제(메모리 Map).
 */
const crypto = require('crypto');
const { successResponse, errorResponse } = require('../utils/response');

const TTL_MS = 60 * 60 * 1000; // 토큰 1시간(접근 시 갱신)
const tokens = new Map(); // token → { userId, projectId, expiresAt }

const SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || 'cpt-preview-secret';
function tokenFor(userId, projectId) {
  return 'term-' + crypto.createHmac('sha256', SECRET).update(`term:${userId}:${projectId}`).digest('hex').slice(0, 18);
}

function gc() {
  const now = Date.now();
  for (const [t, s] of tokens) { if (s.expiresAt < now) tokens.delete(t); }
}
const _sweeper = setInterval(gc, 5 * 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

// POST /api/terminal/start  body:{ projectId } → { token }
async function startTerminal(req, res) {
  try {
    const userId = req.user && req.user.id;
    const { projectId } = req.body || {};
    if (!projectId) return errorResponse(res, new Error('projectId 가 필요합니다.'), 400);
    const token = tokenFor(userId, projectId);
    tokens.set(token, { userId, projectId, expiresAt: Date.now() + TTL_MS });
    return successResponse(res, { token });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// 토큰 → 세션 조회(ws 업그레이드 핸들러용). 만료면 null.
function resolveToken(token) {
  const sess = tokens.get(token);
  if (!sess || sess.expiresAt < Date.now()) { if (sess) tokens.delete(token); return null; }
  sess.expiresAt = Date.now() + TTL_MS;
  return sess;
}

module.exports = { startTerminal, resolveToken };
