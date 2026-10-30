// 외부 연동 API(/api/v1) — 다른 서비스가 API 키로 내 PC 의 에이전트 세션을 만들고 이어 간다.
//  서버는 통로다: 세션 소유·허용 폴더 판정은 데몬 external.js 가 하고, 여기는 키를 auth 로 바꿔 필드 단위로 넘긴다.
//  ★ 공개 본문을 통째로 넘기지 않는다 — auth 를 호출자가 덮어쓰면 다른 키의 세션을 건드릴 수 있다.
//  ★ 프롬프트·답변을 로그에 남기지 않는다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ExternalApiKey, DaemonDevice } = require('../models');
const relay = require('../services/daemonRelayService');
const { successResponse, errorResponse } = require('../utils/response');

const KEY_PREFIX = 'cptx_';
const MAX_KEYS = 50;
const WAIT_MAX_S = 25;        // Cloudflare 가 끊기 전에 돌려준다. 호출자는 이어서 다시 부른다
const WAIT_POLL_MS = 700;
const STATUS = {
  BAD_REQUEST: 400, NOT_A_REPO: 400, UNAUTHORIZED: 401, PATH_NOT_ALLOWED: 403, BYPASS_NOT_ALLOWED: 403, EXTERNAL_DISABLED: 403,
  SESSION_NOT_FOUND: 404, THREAD_NOT_FOUND: 404, REQ_NOT_PENDING: 409, THREAD_BUSY: 409, THREAD_BUSY_IN_TERMINAL: 409, TOO_MANY_LIVE: 429,
  DAEMON_OFFLINE: 503, AGENT_UNAVAILABLE: 503, AGENT_NOT_LOGGED_IN: 503, TIMEOUT: 504,
};
const DOC_FILES = {
  docs: ['API.md', 'text/markdown; charset=utf-8'],
  skill: ['SKILL.md', 'text/markdown; charset=utf-8'],
  sdk: ['codingpt.mjs', 'text/javascript; charset=utf-8'],
};

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function codedFail(res, code, message) {
  return errorResponse(res, Object.assign(new Error(message), { publicDetail: { code } }), STATUS[code] || 500);
}
function failRpc(res, e) {
  if (e && e.message === 'DAEMON_OFFLINE') return codedFail(res, 'DAEMON_OFFLINE', 'PC 가 꺼져 있거나 CodingPT 데몬이 연결되어 있지 않습니다');
  const timedOut = e && /타임아웃/.test(String(e.message));
  const code = timedOut ? 'TIMEOUT' : (e && e.code ? String(e.code) : 'EXTERNAL_ERROR');
  return codedFail(res, code, timedOut ? 'PC 응답이 늦습니다. 결과를 확인한 뒤 다시 시도하세요' : String((e && e.message) || '요청이 실패했습니다'));
}
function keyView(k) {
  return {
    id: k.id, name: k.name, prefix: k.key_prefix, deviceId: k.device_id, allowedPaths: k.allowed_paths || [], allowBypass: !!k.allow_bypass,
    lastUsedAt: k.last_used_at, createdAt: k.created_at,
  };
}

// ── 키로 인증 ────────────────────────────────────────────────────────────────
async function apiKeyAuth(req, res, next) {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
    if (!m || !m[1].startsWith(KEY_PREFIX)) return codedFail(res, 'UNAUTHORIZED', 'API 키가 필요합니다');
    const key = await ExternalApiKey.findOne({ where: { key_hash: sha256(m[1]), revoked_at: null } });
    if (!key) return codedFail(res, 'UNAUTHORIZED', 'API 키가 올바르지 않습니다');
    req.apiKey = key;
    if (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60000) {
      ExternalApiKey.update({ last_used_at: new Date() }, { where: { id: key.id } }).catch(() => { /* 표시용 */ });
    }
    return next();
  } catch (e) { return errorResponse(res, e, 500); }
}

function callPc(req, method, params, timeoutMs) {
  const k = req.apiKey;
  const auth = { keyId: k.id, keyName: k.name, paths: k.allowed_paths || [], allowBypass: !!k.allow_bypass };
  return relay.callRpc(k.user_id, method, { ...params, auth }, timeoutMs, { runnerId: k.device_id });
}
const route = (fn) => async (req, res) => {
  try { return successResponse(res, await fn(req, req.body || {})); } catch (e) { return failRpc(res, e); }
};
function pick(o, names) {
  const out = {};
  for (const n of names) if (o[n] !== undefined) out[n] = o[n];
  return out;
}

const caps = route((req) => callPc(req, 'ext.caps', {}, 15000));
const workspaces = route((req) => callPc(req, 'ext.workspaces', {}, 15000));
const workspaceCreate = route((req, b) => callPc(req, 'ext.workspaceCreate', pick(b, ['name', 'parentPath']), 30000));
const createSession = route((req, b) => callPc(req, 'ext.create',
  pick(b, ['cwd', 'worktree', 'agent', 'model', 'effort', 'mode', 'prompt', 'title', 'clientId']), 60000));
const listSessions = route((req) => callPc(req, 'ext.list', {}, 15000));
const getSession = route((req) => callPc(req, 'ext.get', { id: req.params.id, after: Number(req.query.after) || 0 }, 15000));
const send = route((req, b) => callPc(req, 'ext.send', { id: req.params.id, ...pick(b, ['text', 'clientId']) }, 30000));
const respond = route((req, b) => callPc(req, 'ext.respond',
  { id: req.params.id, requestId: req.params.requestId, ...pick(b, ['decision', 'always', 'message', 'answers']) }, 15000));
const update = route((req, b) => callPc(req, 'ext.set', { id: req.params.id, ...pick(b, ['mode', 'model']) }, 15000));
const interrupt = route((req) => callPc(req, 'ext.interrupt', { id: req.params.id }, 15000));
const stop = route((req) => callPc(req, 'ext.stop', { id: req.params.id }, 15000));
const remove = route((req) => callPc(req, 'ext.delete', { id: req.params.id }, 20000));

/**
 * 새 이벤트를 기다린다(long-poll). 새 일이 있거나 일이 멈췄으면 바로 돌려준다.
 *  SSE 대신 쓰는 이유: 앞단이 긴 연결을 끊는다. 끊겨도 cursor 로 이어 받으니 잃는 것이 없다.
 */
async function events(req, res) {
  try {
    const after = Number(req.query.after) || 0;
    const wait = Math.max(0, Math.min(Number(req.query.wait) || 0, WAIT_MAX_S)) * 1000;
    const deadline = Date.now() + wait;
    for (;;) {
      const r = await callPc(req, 'ext.get', { id: req.params.id, after }, 15000);
      const running = r.session.state === 'working';
      if (r.events.length || (r.partial || []).length || !running || Date.now() >= deadline) return successResponse(res, r);
      await new Promise((ok) => setTimeout(ok, WAIT_POLL_MS));
      if (res.writableEnded || req.destroyed) return undefined;
    }
  } catch (e) { return failRpc(res, e); }
}

// ── 공개 문서(인증 없음) — 다른 프로젝트의 에이전트가 curl 로 바로 받아 쓴다 ──
function publicFile(kind) {
  const [file, type] = DOC_FILES[kind];
  return (req, res) => {
    try {
      const text = fs.readFileSync(path.join(__dirname, '..', 'public-external', file), 'utf8');
      res.set('Content-Type', type).set('Cache-Control', 'public, max-age=300').send(text);
    } catch (e) { errorResponse(res, new Error('문서를 찾을 수 없습니다'), 404); }
  };
}

// ── 키 관리 — PC 앱 설정과 같은 PC 의 `cpt external`(데몬). 폰 JWT 로는 만들 수 없다 ──
async function listKeys(req, res) {
  try {
    const rows = await ExternalApiKey.findAll({ where: { user_id: req.user.id, revoked_at: null }, order: [['created_at', 'DESC']] });
    return successResponse(res, { keys: rows.map(keyView) });
  } catch (e) { return errorResponse(res, e, 500); }
}
async function createKey(req, res) {
  try {
    const deviceId = req.account && req.account.deviceId;
    if (!deviceId) return errorResponse(res, new Error('키는 PC 앱에서 만듭니다'), 400);
    const device = await DaemonDevice.findOne({ where: { id: deviceId, user_id: req.user.id, revoked_at: null } });
    if (!device) return errorResponse(res, new Error('이 PC 를 찾을 수 없습니다'), 404);
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return errorResponse(res, new Error('이름이 필요합니다'), 400);
    const paths = (Array.isArray(b.allowedPaths) ? b.allowedPaths : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
    const count = await ExternalApiKey.count({ where: { user_id: req.user.id, revoked_at: null } });
    if (count >= MAX_KEYS) return errorResponse(res, new Error('키가 너무 많습니다. 쓰지 않는 키를 삭제하세요'), 400);
    const raw = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const key = await ExternalApiKey.create({
      user_id: req.user.id, device_id: deviceId, name, key_hash: sha256(raw), key_prefix: raw.slice(0, 12),
      allowed_paths: paths, allow_bypass: b.allowBypass === true,
    });
    return successResponse(res, { key: keyView(key), secret: raw });
  } catch (e) { return errorResponse(res, e, 500); }
}
async function revokeKey(req, res) {
  try {
    const [n] = await ExternalApiKey.update({ revoked_at: new Date() }, { where: { id: Number(req.params.id) || 0, user_id: req.user.id, revoked_at: null } });
    if (!n) return errorResponse(res, new Error('키를 찾을 수 없습니다'), 404);
    return successResponse(res, { ok: true });
  } catch (e) { return errorResponse(res, e, 500); }
}

module.exports = {
  apiKeyAuth, caps, workspaces, workspaceCreate, createSession, listSessions, getSession, events, send, respond, update, interrupt, stop, remove,
  publicFile, listKeys, createKey, revokeKey, _sha256: sha256,
};
