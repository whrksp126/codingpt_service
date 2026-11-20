// 알림 채널 — 앱(JWT·PC deviceToken) 라우트 /api/channels + 공개 웹훅 /api/v1/hooks/:token + API 키 /api/v1/channels.
//  로직은 services/channelService.js. 알림 본문·지시문은 로그에 남기지 않는다.
const svc = require('../services/channelService');
const { successResponse, errorResponse } = require('../utils/response');

const STATUS = {
  BAD_REQUEST: 400, TOO_MANY_CHANNELS: 400, UNAUTHORIZED: 401, PATH_NOT_ALLOWED: 403, BYPASS_NOT_ALLOWED: 403, EXTERNAL_DISABLED: 403,
  CHANNEL_NOT_FOUND: 404, DEVICE_NOT_FOUND: 404, SESSION_NOT_FOUND: 404,
  NO_WORKSPACE: 409, REQ_NOT_PENDING: 409, THREAD_BUSY: 409, THREAD_BUSY_IN_TERMINAL: 409, TOO_MANY_LIVE: 429,
  DAEMON_OFFLINE: 503, AGENT_UNAVAILABLE: 503, AGENT_NOT_LOGGED_IN: 503, TIMEOUT: 504,
};

function fail(res, e) {
  let code = e && e.code ? String(e.code) : null;
  if (!code && e && e.message === 'DAEMON_OFFLINE') code = 'DAEMON_OFFLINE';
  if (!code && e && /타임아웃/.test(String(e.message))) code = 'TIMEOUT';
  const status = (e && e.statusCode) || STATUS[code] || 500;
  if (status >= 500 && !code) console.warn('[channel] 실패:', e && e.message);
  const msg = code === 'DAEMON_OFFLINE' ? 'PC 가 꺼져 있거나 CodingPT 가 연결되어 있지 않습니다' : String((e && e.message) || '요청이 실패했습니다');
  return errorResponse(res, Object.assign(new Error(msg), { publicDetail: { code: code || 'ERROR' } }), status);
}
const uid = (req) => (req.account && req.account.userId) || (req.user && req.user.id);
const wrap = (fn) => async (req, res) => {
  try { return successResponse(res, await fn(req, req.body || {})); } catch (e) { return fail(res, e); }
};

// ── 앱 ───────────────────────────────────────────────────────────────────────
const list = wrap(async (req) => ({ channels: (await svc.list(uid(req))).map(svc.channelView) }));
const create = wrap(async (req, b) => ({ channel: svc.channelView(await svc.create(uid(req), b, { via: 'app' })) }));
const get = wrap(async (req) => ({ channel: svc.channelView(await svc.get(uid(req), req.params.id)) }));
const update = wrap(async (req, b) => ({ channel: svc.channelView(await svc.update(uid(req), req.params.id, b)) }));
const remove = wrap(async (req) => svc.archive(uid(req), req.params.id));
const rotate = wrap(async (req) => ({ channel: svc.channelView(await svc.rotateToken(uid(req), req.params.id)) }));
const read = wrap(async (req) => ({ channel: svc.channelView(await svc.markRead(uid(req), req.params.id)) }));
const messages = wrap(async (req) => {
  const r = await svc.listMessages(uid(req), req.params.id, { before: req.query.before, after: req.query.after, limit: req.query.limit });
  return { channel: svc.channelView(r.channel), messages: r.messages, hasMore: r.hasMore };
});
const send = wrap(async (req, b) => svc.sendToAgent(uid(req), req.params.id, { text: b.text, refs: b.refs, clientId: b.clientId }));
const newConversation = wrap(async (req) => ({ channel: svc.channelView(await svc.newConversation(uid(req), req.params.id)) }));
const respond = wrap(async (req, b) => svc.respond(uid(req), req.params.id, req.params.requestId,
  { decision: b.decision, always: b.always, message: b.message, answers: b.answers }));
const interrupt = wrap(async (req) => svc.interrupt(uid(req), req.params.id));
/** 앱에서 "테스트 알림 보내기" — 웹훅과 같은 길을 탄다. */
const test = wrap(async (req) => {
  const ch = await svc.get(uid(req), req.params.id);
  return svc.ingest(ch, { title: '테스트 알림', text: '이 채널로 알림이 잘 도착합니다.', level: 'info', source: 'CodingPT' }, { via: 'test' });
});

// ── 공개 웹훅(토큰 = URL) ─────────────────────────────────────────────────────
async function hookChannel(req, res) {
  const ch = await svc.byToken(req.params.token);
  if (!ch) { fail(res, Object.assign(new Error('채널을 찾을 수 없습니다. 웹훅 URL 을 확인하세요'), { code: 'CHANNEL_NOT_FOUND' })); return null; }
  return ch;
}
async function hookPost(req, res) {
  try {
    const ch = req.hookChannel || await hookChannel(req, res);
    if (!ch) return undefined;
    //  본문: JSON 객체 · 평문(text/plain) · 폼. 빈 JSON 이면 쿼리(?text=…)도 받는다(curl 한 줄용)
    let input = req.body;
    if (input == null || (typeof input === 'object' && !Object.keys(input).length)) input = req.query || {};
    const r = await svc.ingest(ch, input, { via: 'webhook' });
    return successResponse(res, { ok: true, channelId: ch.id, ...r });
  } catch (e) { return fail(res, e); }
}
async function hookInfo(req, res) {
  try {
    const ch = await hookChannel(req, res);
    if (!ch) return undefined;
    return successResponse(res, { ok: true, channel: { id: ch.id, name: ch.name } });
  } catch (e) { return fail(res, e); }
}
/** 토큰으로 채널을 미리 찾아 레이트리밋 키로 쓴다. */
async function resolveHook(req, res, next) {
  try {
    const ch = await hookChannel(req, res);
    if (!ch) return undefined;
    req.hookChannel = ch;
    return next();
  } catch (e) { return fail(res, e); }
}

// ── API 키(cptx_) ─────────────────────────────────────────────────────────────
const keyList = wrap(async (req) => ({ channels: (await svc.list(req.apiKey.user_id)).map(svc.publicChannelView) }));
const keyEnsure = wrap(async (req, b) => {
  const r = await svc.ensureByName(req.apiKey.user_id, b, req.apiKey);
  return { channel: svc.publicChannelView(r.channel), created: r.created };
});
const keySend = wrap(async (req, b) => {
  const ch = await svc.get(req.apiKey.user_id, req.params.id);
  return { ok: true, channelId: ch.id, ...(await svc.ingest(ch, b, { via: 'api' })) };
});

module.exports = {
  list, create, get, update, remove, rotate, read, messages, send, newConversation, respond, interrupt, test,
  hookPost, hookInfo, resolveHook, keyList, keyEnsure, keySend,
};
