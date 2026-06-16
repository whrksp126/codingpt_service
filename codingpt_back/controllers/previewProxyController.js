/**
 * 미리보기 dev 서버 프록시 컨트롤러
 *
 * 바이브코딩 산출물(Vite 등)을 샌드박스에서 `npm run dev` 로 띄우고, 그 포트를 모바일 웹뷰로 프록시한다.
 *
 * 인증: dev/start·dev/stop 은 JWT(authMiddleware). 하지만 **에셋 서빙(GET /:token/*)은 WebView 가
 *       URL 을 직접 로드**하므로 JWT 헤더를 못 싣는다 → 정적 미리보기와 동일하게 **불투명 토큰**으로 보호한다.
 *       토큰은 dev/start(인증) 시 발급되고 token→{userId,...} 매핑으로 사용자 샌드박스를 고른다.
 * 단일 워커/back 인스턴스 전제(메모리 Map).
 */
const crypto = require('crypto');
const agentProxyService = require('../services/agentProxyService');
const { successResponse, errorResponse } = require('../utils/response');

const TTL_MS = 60 * 60 * 1000; // 토큰 1시간(접근 시 갱신)
const tokens = new Map(); // token → { userId, projectId, port, expiresAt }

// 토큰을 (userId,projectId)에 대해 **결정론적**으로 — 서버 시크릿 HMAC. 불추측이면서 재시작에도 동일.
// 그래야 dev 서버 base 가 안 바뀌어 프로세스 재시작/재폴링에도 미리보기가 그대로 유지된다.
const SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || 'cpt-preview-secret';
function tokenFor(userId, projectId) {
  return 'dev-' + crypto.createHmac('sha256', SECRET).update(`${userId}:${projectId}`).digest('hex').slice(0, 18);
}

function gc() {
  const now = Date.now();
  for (const [t, s] of tokens) { if (s.expiresAt < now) tokens.delete(t); }
}
const _sweeper = setInterval(gc, 5 * 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

// POST /api/preview/dev/start  body:{ projectId } → dev 서버 기동(+토큰 발급) 또는 static 폴백
async function startDev(req, res) {
  try {
    const userId = req.user && req.user.id;
    const { projectId } = req.body || {};
    if (!projectId) return errorResponse(res, new Error('projectId 가 필요합니다.'), 400);

    const token = tokenFor(userId, projectId);
    const basePath = `/api/preview/${token}/`;

    // HMR(WebSocket) 클라이언트가 이 프록시로 접속하도록 hmr 설정 도출 — 웹뷰가 back 에 닿은 그 host/port/proto 기준.
    // (host 는 생략 → Vite 클라이언트가 페이지 location.hostname 사용 → 에뮬레이터/도메인 모두 자동 일치)
    const fwdProto = req.headers['x-forwarded-proto'];
    const isHttps = fwdProto ? String(fwdProto).includes('https') : !!req.secure;
    const hostHeader = String(req.headers.host || '');
    const portMatch = hostHeader.match(/:(\d+)$/);
    const clientPort = portMatch ? Number(portMatch[1]) : (isHttps ? 443 : 80);
    const hmr = { protocol: isHttps ? 'wss' : 'ws', clientPort, path: basePath };

    const r = await agentProxyService.startDev({ userId, projectId, basePath, hmr });
    const body = r.body || {};
    if (body.mode === 'dev') {
      tokens.set(token, { userId, projectId, port: body.port || 5173, expiresAt: Date.now() + TTL_MS });
      return successResponse(res, { mode: 'dev', ready: !!body.ready, token, url: basePath, log: body.log || null });
    }
    // dev 스크립트 없음 / 샌드박스 비활성 → 정적 미리보기 폴백
    return successResponse(res, { mode: 'static' });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// POST /api/preview/dev/stop  body:{ projectId? }
async function stopDev(req, res) {
  try {
    const userId = req.user && req.user.id;
    const { projectId } = req.body || {};
    await agentProxyService.stopDev({ userId });
    if (projectId) tokens.delete(tokenFor(userId, projectId));
    return successResponse(res, { ok: true });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// ALL /api/preview/:token(/*)  — WebView 무인증 프록시. 토큰으로 사용자 샌드박스 선택.
function proxy(req, res) {
  const { token } = req.params;
  const sess = tokens.get(token);
  if (!sess || sess.expiresAt < Date.now()) {
    if (sess) tokens.delete(token);
    return res.status(404).end('preview session not found or expired');
  }
  sess.expiresAt = Date.now() + TTL_MS; // touch
  return agentProxyService.proxyDev(req, res, { userId: sess.userId });
}

// 토큰 → 세션 조회(HMR ws 업그레이드 핸들러용). 만료면 null.
function resolveToken(token) {
  const sess = tokens.get(token);
  if (!sess || sess.expiresAt < Date.now()) { if (sess) tokens.delete(token); return null; }
  sess.expiresAt = Date.now() + TTL_MS;
  return sess;
}

module.exports = { startDev, stopDev, proxy, resolveToken };
