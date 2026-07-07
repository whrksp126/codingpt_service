/**
 * BYO-PC 데몬 컨트롤러 — 페어링/상태/터미널 토큰 HTTP API
 *
 * 페어링(기기 등록):
 *  1) 앱(인증됨) POST /api/daemon/pair/code → 8자리 일회용 코드 발급(10분)
 *  2) PC 데몬    POST /api/daemon/pair/claim {code, deviceName, ...} → deviceToken 발급
 *     (무인증 — 코드 자체가 비밀. 코드는 single-use, 만료 시 폐기)
 *  3) 데몬은 deviceToken 으로 제어 WS(/api/daemon/connect) 인증. 원문은 데몬만 보관,
 *     서버는 sha256 해시만 저장(daemon_device.token_hash).
 */
const crypto = require('crypto');
const { DaemonDevice } = require('../models');
const daemonRelayService = require('../services/daemonRelayService');
const { successResponse, errorResponse } = require('../utils/response');

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const pairCodes = new Map(); // code → { userId, expiresAt }

const _sweeper = setInterval(() => {
  const now = Date.now();
  for (const [c, s] of pairCodes) { if (s.expiresAt < now) pairCodes.delete(c); }
}, 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

// 헷갈리는 문자(0/O, 1/I/L) 제외 — 사용자가 눈으로 옮겨 적는 코드.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genPairCode() {
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return `${pick(4)}-${pick(4)}`;
}

// POST /api/daemon/pair/code  (인증) → { code, expiresAt }
async function createPairCode(req, res) {
  try {
    const userId = req.user && req.user.id;
    const code = genPairCode();
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    pairCodes.set(code, { userId, expiresAt });
    return successResponse(res, { code, expiresAt: new Date(expiresAt).toISOString() });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/pair/claim  (무인증 — 코드가 비밀)
// body: { code, deviceName, platform, daemonVersion } → { deviceId, deviceToken }
async function claimPairCode(req, res) {
  try {
    const { code, deviceName, platform, daemonVersion } = req.body || {};
    const normalized = String(code || '').trim().toUpperCase();
    const sess = pairCodes.get(normalized);
    if (!sess || sess.expiresAt < Date.now()) {
      pairCodes.delete(normalized);
      return errorResponse(res, new Error('페어링 코드가 유효하지 않거나 만료되었습니다.'), 400);
    }
    pairCodes.delete(normalized); // single-use

    const deviceToken = 'cptd_' + crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex');
    const device = await DaemonDevice.create({
      user_id: sess.userId,
      device_name: String(deviceName || 'PC').slice(0, 128),
      platform: platform ? String(platform).slice(0, 32) : null,
      daemon_version: daemonVersion ? String(daemonVersion).slice(0, 32) : null,
      token_hash: tokenHash,
    });
    console.log(`[daemon] 기기 페어링 완료 userId=${sess.userId} device=${device.device_name}(#${device.id})`);
    return successResponse(res, { deviceId: device.id, deviceToken });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// GET /api/daemon/status  (인증) → { online, current, devices }
async function getStatus(req, res) {
  try {
    const userId = req.user && req.user.id;
    const conn = daemonRelayService.getConnection(userId);
    const devices = await DaemonDevice.findAll({
      where: { user_id: userId, revoked_at: null },
      order: [['created_at', 'DESC']],
    });
    return successResponse(res, {
      online: !!conn,
      current: conn ? {
        deviceId: conn.deviceId,
        deviceName: conn.deviceName,
        platform: conn.platform,
        daemonVersion: conn.daemonVersion,
        connectedAt: new Date(conn.connectedAt).toISOString(),
      } : null,
      devices: devices.map((d) => ({
        deviceId: d.id,
        deviceName: d.device_name,
        platform: d.platform,
        daemonVersion: d.daemon_version,
        lastSeenAt: d.last_seen_at,
        online: !!(conn && conn.deviceId === d.id),
      })),
    });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/devices/:deviceId/revoke  (인증) — 기기 연결 해제(재페어링 필요)
async function revokeDevice(req, res) {
  try {
    const userId = req.user && req.user.id;
    const deviceId = Number(req.params.deviceId);
    const device = await DaemonDevice.findOne({ where: { id: deviceId, user_id: userId, revoked_at: null } });
    if (!device) return errorResponse(res, new Error('기기를 찾을 수 없습니다.'), 404);
    await device.update({ revoked_at: new Date() });
    daemonRelayService.disconnectDevice(deviceId);
    return successResponse(res, { deviceId, revoked: true });
  } catch (e) {
    return errorResponse(res, e, 500);
  }
}

// POST /api/daemon/terminal/start  (인증) → { token } — ws 업그레이드는 app.js 에서
async function startTerminal(req, res) {
  try {
    const userId = req.user && req.user.id;
    const token = daemonRelayService.issueTerminalToken(userId);
    return successResponse(res, { token });
  } catch (e) {
    return errorResponse(res, e, e.statusCode || 500);
  }
}

// 데몬 오프라인 시 통일된 409.
function mapRpcError(res, e) {
  if (e.message === 'DAEMON_OFFLINE') {
    return errorResponse(res, new Error('PC 데몬이 연결되어 있지 않습니다.'), 409);
  }
  return errorResponse(res, e, 500);
}

// GET /api/daemon/fs/list?path=  (인증) — 데몬 파일 목록
async function fsList(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.list', { path: req.query.path || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/tree?path=  (인증) — 선택 폴더 아래 파일 flat 목록(모바일 IDE 소스용)
async function fsTree(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.tree', { path: req.query.path || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/fs/read?path=  (인증) — 텍스트 파일 내용
async function fsRead(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.read', { path: req.query.path || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/write  (인증) body:{ path, content } — 텍스트 저장
async function fsWrite(req, res) {
  try {
    const { path: p, content } = req.body || {};
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.write', { path: p, content });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/watch  (인증) body:{ path } — 그 디렉토리 변경을 감시(단일). 이벤트는 /events SSE 로.
async function fsWatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.watch', { path: (req.body && req.body.path) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/fs/unwatch  (인증)
async function fsUnwatch(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'fs.unwatch', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// ── 워크스페이스(Slice2) — PC 에 결정적 스캐폴드 ──
// GET /api/daemon/ws/root  (인증) — 지정된 워크스페이스 루트(홈-기준 상대) 또는 null
async function wsGetRoot(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.getRoot', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/root  (인증) body:{ path } — 워크스페이스 루트 최초 1회(또는 변경) 지정
async function wsSetRoot(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.setRoot', { path: (req.body && req.body.path) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/ws/create  (인증) body:{ name } — 루트 아래 새 워크스페이스 폴더 스캐폴드
async function wsCreate(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'ws.create', { name: (req.body && req.body.name) || '' });
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// GET /api/daemon/events  (인증) — 파일 변경 이벤트 SSE. 데몬 fs_event 를 앱으로 push.
function streamEvents(req, res) {
  const userId = req.user && req.user.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  daemonRelayService.addEventClient(userId, res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) { /* noop */ } }, 25000);
  req.on('close', () => { clearInterval(ka); daemonRelayService.removeEventClient(userId, res); });
}

// ── 프리뷰(데몬 dev 서버) ──────────────────────────────────────────────
// 사용자가 PC 에서 직접 띄운 dev 서버를 폰 웹뷰로 미리보기. WebView 는 URL 을 직접 로드하므로
// JWT 를 못 싣는다 → 불투명 토큰(userId:port 결정론적 HMAC)으로 사용자/포트 바인딩.
// 사용자 Vite 등은 base='/' 라 런타임 절대경로(/node_modules/…)가 토큰 경로 밖으로 나간다 →
// 첫 로드 시 dpv 쿠키를 심고, 이후 non-/api 루트 요청을 쿠키로 데몬 프록시에 라우팅(previewCookieMiddleware).
const PREVIEW_SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || 'cpt-preview-secret';
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewTokens = new Map(); // token → { userId, port, expiresAt }
const _pvSweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, s] of previewTokens) { if (s.expiresAt < now) previewTokens.delete(t); }
}, 5 * 60 * 1000);
if (_pvSweeper.unref) _pvSweeper.unref();

function previewTokenFor(userId, port) {
  return 'dpv-' + crypto.createHmac('sha256', PREVIEW_SECRET).update(`${userId}:${port}`).digest('hex').slice(0, 18);
}
function resolvePreviewToken(token) {
  const s = previewTokens.get(token);
  if (!s || s.expiresAt < Date.now()) { if (s) previewTokens.delete(token); return null; }
  s.expiresAt = Date.now() + PREVIEW_TTL_MS;
  return s;
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// GET /api/daemon/preview/ports  (인증) — PC 에서 LISTEN 중인 포트 목록
async function previewPorts(req, res) {
  try {
    const result = await daemonRelayService.callRpc(req.user.id, 'net.ports', {});
    return successResponse(res, result);
  } catch (e) { return mapRpcError(res, e); }
}

// POST /api/daemon/preview/start  (인증) body:{ port } → 그 포트로의 무인증 프록시 토큰
async function previewStart(req, res) {
  const port = parseInt((req.body || {}).port, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    return errorResponse(res, new Error('유효한 port 가 필요합니다.'), 400);
  }
  const token = previewTokenFor(req.user.id, port);
  previewTokens.set(token, { userId: req.user.id, port, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return successResponse(res, { token, url: `/api/daemon/preview/${token}/`, port });
}

// ALL /api/daemon/preview/:token(/*)  (무인증) — 진입 프록시. dpv 쿠키를 심고 토큰 경로를 벗겨 데몬으로.
function previewEntry(req, res) {
  const { token } = req.params;
  const sess = resolvePreviewToken(token);
  if (!sess) return res.status(404).end('preview session not found or expired');
  // 이후 이 WebView 의 루트 절대경로 요청을 이 토큰으로 라우팅.
  res.setHeader('Set-Cookie', `dpv=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  const prefix = `/api/daemon/preview/${token}`;
  let path = req.originalUrl.slice(prefix.length) || '/';
  if (!path.startsWith('/')) path = '/' + path;
  return daemonRelayService.proxyHttp(sess.userId, sess.port, path, req, res);
}

// 미들웨어 — non-/api 루트 요청에 dpv 쿠키가 있으면 데몬 dev 서버로 프록시(Vite 절대경로/에셋).
function previewCookieMiddleware(req, res, next) {
  if (req.url.startsWith('/api/')) return next();
  const token = parseCookies(req.headers.cookie).dpv;
  if (!token) return next();
  const sess = resolvePreviewToken(token);
  if (!sess) return next();
  return daemonRelayService.proxyHttp(sess.userId, sess.port, req.originalUrl, req, res);
}

module.exports = {
  createPairCode, claimPairCode, getStatus, revokeDevice, startTerminal,
  fsList, fsTree, fsRead, fsWrite, fsWatch, fsUnwatch, streamEvents,
  wsGetRoot, wsSetRoot, wsCreate,
  previewPorts, previewStart, previewEntry, previewCookieMiddleware, resolvePreviewToken,
};
