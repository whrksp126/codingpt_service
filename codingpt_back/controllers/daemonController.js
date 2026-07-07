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

module.exports = { createPairCode, claimPairCode, getStatus, revokeDevice, startTerminal, fsList, fsRead, fsWrite, fsWatch, fsUnwatch, streamEvents };
