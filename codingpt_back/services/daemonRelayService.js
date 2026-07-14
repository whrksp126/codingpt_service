/**
 * BYO-PC 데몬 릴레이 — "교환원"
 *
 * 사용자 PC의 codingpt_daemon 은 인바운드 포트를 열지 않는다. 대신 데몬이 back 으로
 * 아웃바운드 WS 를 먼저 걸어 상시 대기하고, 앱이 터미널을 열면 back 이 그 연결로
 * 지시(stream_open)를 보내 데몬이 스트림 전용 WS 를 추가로 다이얼(dial-back)한다.
 *
 *  · 제어 채널: GET /api/daemon/connect  (Bearer deviceToken, JSON 메시지)
 *  · 스트림   : GET /api/daemon/stream/:streamToken  (데몬→back, 스트림당 1개)
 *  · 앱 터미널: GET /api/daemon/terminal/:token  (앱→back, 불투명 토큰 — terminalProxyController 패턴)
 *
 * 와이어 계약(앱↔데몬 PTY)은 기존 termproxy 와 동일: 바이너리=stdin, 텍스트 JSON
 * {type:'resize',cols,rows}=리사이즈, PTY 출력은 raw 그대로 → 앱 TerminalWebView 무수정.
 *
 * ToS 경계: 이 릴레이를 지나는 것은 터미널 표시 바이트뿐이다. 사용자 claude 의
 * API 요청/자격증명은 PC→Anthropic 직결이며 우리 인프라를 거치지 않는다.
 *
 * 단일 back 인스턴스 전제(인메모리 Map — pendingPermissions 와 동일).
 */
const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { DaemonDevice } = require('../models');
const pushService = require('./pushService');

const wss = new WebSocket.Server({ noServer: true });

const STREAM_OPEN_TIMEOUT_MS = 10 * 1000; // stream_open 지시 후 데몬 dial-back 대기
const RPC_TIMEOUT_MS = 15 * 1000; // fs RPC 응답 대기
const TERM_TOKEN_TTL_MS = 60 * 60 * 1000; // 앱 터미널 토큰 1시간(접근 시 갱신)
const PING_INTERVAL_MS = 30 * 1000; // Cloudflare 유휴 WS ~100s 컷 대비
const LAST_SEEN_FLUSH_MS = 60 * 1000; // last_seen_at DB 반영 주기
const AGENT_BUF_MAX = 1000;             // 채널별 롤링 버퍼 상한(계약 §2.3)
const AGENT_BUF_TTL_MS = 5 * 60 * 1000; // 또는 최근 5분(둘 중 큰 쪽 유지)

// userId(str) → { runners: Map(deviceId → conn), activeRunnerId }  (M5: 로컬+클라우드 러너 다중화)
//   conn = { deviceId, kind:'local'|'cloud', deviceName, platform, daemonVersion, ws, connectedAt, lastSeenFlushedAt, rpcSeq, pendingRpc }
//   MVP 원칙 "한 번에 하나의 활성 타겟" → 러너별로 연결은 유지하되 RPC/스트림은 activeRunnerId 로만 라우팅.
//   핸드오프(Slice4)가 setActiveRunner 로 활성 러너를 전환한다.
const connections = new Map();

// 사용자 엔트리 확보(없으면 생성).
function userEntry(userId, create) {
  const key = String(userId);
  let e = connections.get(key);
  if (!e && create) { e = { runners: new Map(), activeRunnerId: null }; connections.set(key, e); }
  return e || null;
}
// RPC/스트림 대상 러너 선택 — 기본은 활성 러너. opts.runnerId/opts.kind 로 특정 러너 지정 가능.
function pickConn(userId, opts) {
  const e = userEntry(userId, false);
  if (!e || e.runners.size === 0) return null;
  if (opts && opts.runnerId != null) return e.runners.get(Number(opts.runnerId)) || null;
  if (opts && opts.kind) { for (const c of e.runners.values()) if (c.kind === opts.kind) return c; return null; }
  return e.runners.get(e.activeRunnerId) || null;
}
// 활성 러너 전환(핸드오프). 대상 러너가 연결돼 있어야 성공.
function setActiveRunner(userId, runnerId) {
  const e = userEntry(userId, false);
  if (!e || !e.runners.has(Number(runnerId))) return false;
  e.activeRunnerId = Number(runnerId);
  return true;
}
// 연결된 러너 목록(상태/핸드오프 UI 용).
function listRunners(userId) {
  const e = userEntry(userId, false);
  if (!e) return [];
  return [...e.runners.values()].map((c) => ({
    deviceId: c.deviceId, kind: c.kind, deviceName: c.deviceName,
    platform: c.platform, active: c.deviceId === e.activeRunnerId, connectedAt: c.connectedAt,
  }));
}
// 연결된 클라우드 러너 목록(동면 스위퍼용) — 활동시각/바쁨 상태 포함.
function listCloudRunners() {
  const out = [];
  for (const [userId, entry] of connections) {
    for (const conn of entry.runners.values()) {
      if (conn.kind !== 'cloud') continue;
      out.push({
        userId: Number(userId),
        deviceId: conn.deviceId,
        lastActivityAt: conn.lastActivityAt || conn.connectedAt,
        hasLiveTerminal: (conn.liveTerminals || 0) > 0,
        hasInflight: conn.pendingRpc.size > 0,
      });
    }
  }
  return out;
}

// streamToken → { userId, kind, resolve, reject, timer }
const pendingStreams = new Map();
// 앱 터미널 토큰 → { userId, expiresAt }
const termTokens = new Map();
// userId(str) → Set<res>  파일 변경 이벤트 SSE 구독자(앱). 데몬 fs_event 를 여기로 broadcast.
const eventClients = new Map();
// ── 에이전트 이벤트 채널(M3-1) — WSS 다중화 + 롤링 버퍼(리플레이) ──
// userId(str) → { seq, items:[{rseq, at, payload}] }  릴레이 롤링 버퍼(agent 채널). SSE 와 병행.
const agentBuf = new Map();
// userId(str) → Set<ws>  에이전트 이벤트 WSS 구독자(앱).
const agentWsClients = new Map();

const SECRET = process.env.PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || 'cpt-preview-secret';

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ── 제어 채널 ─────────────────────────────────────────────────────────

// GET /api/daemon/connect 업그레이드. Bearer deviceToken 을 DB 해시 대조로 인증.
async function handleControlUpgrade(req, socket, head) {
  socket.on('error', () => { /* 인증 중 끊김 무시 */ });
  let device = null;
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      device = await DaemonDevice.findOne({ where: { token_hash: sha256(token), revoked_at: null } });
    }
  } catch (e) {
    console.error('[daemonRelay] 제어 채널 인증 오류:', e.message);
  }
  if (!device) { try { socket.destroy(); } catch (_) { /* noop */ } return; }

  wss.handleUpgrade(req, socket, head, (ws) => registerControl(ws, device));
}

function registerControl(ws, device) {
  const userId = String(device.user_id);
  const entry = userEntry(userId, true);
  // 같은 기기(deviceId) 재접속만 교체 — 다른 종류 러너(로컬↔클라우드)는 공존시킨다.
  const prevSame = entry.runners.get(device.id);
  if (prevSame) { try { prevSame.ws.close(4000, 'replaced'); } catch (_) { /* noop */ } entry.runners.delete(device.id); }

  const conn = {
    deviceId: device.id,
    kind: device.runner_kind || 'local',
    deviceName: device.device_name,
    platform: device.platform,
    daemonVersion: device.daemon_version,
    ws,
    connectedAt: Date.now(),
    lastSeenFlushedAt: 0,
    lastActivityAt: Date.now(), // M5 Slice3: 동면 스위퍼가 쓰는 활동시각(RPC/스트림/인바운드 메시지 시 갱신). keepalive 는 활동 아님.
    liveTerminals: 0,           // 이 러너로 열린 앱 PTY 터미널 수(>0 이면 동면 금지).
    rpcSeq: 0,
    pendingRpc: new Map(), // id → { resolve, reject, timer }
  };
  entry.runners.set(device.id, conn);
  // 활성 러너가 없거나 죽었으면 이 러너를 활성으로(로컬-우선 기본 동작 보존). 핸드오프는 명시적으로만.
  if (entry.activeRunnerId == null || !entry.runners.has(entry.activeRunnerId)) entry.activeRunnerId = device.id;
  console.log(`[daemonRelay] 러너 연결 userId=${userId} kind=${conn.kind} device=${device.device_name}(#${device.id}) active=${entry.activeRunnerId}`);
  touchLastSeen(conn, true);

  let alive = true;
  ws.on('pong', () => { alive = true; touchLastSeen(conn, false); });
  const ka = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch (_) { /* noop */ } return; }
    alive = false;
    try { ws.ping(); } catch (_) { /* noop */ }
  }, PING_INTERVAL_MS);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 제어 채널은 JSON 텍스트만
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    conn.lastActivityAt = Date.now(); // 인바운드 메시지(rpc_result/agent_event/fs_event/sync_event 등)=러너 활동 → 동면 방지.
    if (msg.type === 'hello') {
      // 데몬 메타 갱신(버전업 반영). 이름/플랫폼/버전은 hello 가 정본.
      if (msg.deviceName) conn.deviceName = String(msg.deviceName).slice(0, 128);
      if (msg.platform) conn.platform = String(msg.platform).slice(0, 32);
      if (msg.daemonVersion) conn.daemonVersion = String(msg.daemonVersion).slice(0, 32);
      DaemonDevice.update(
        { device_name: conn.deviceName, platform: conn.platform, daemon_version: conn.daemonVersion, updated_at: new Date() },
        { where: { id: conn.deviceId } }
      ).catch(() => { /* noop */ });
      try { ws.send(JSON.stringify({ type: 'hello_ack', serverTime: new Date().toISOString() })); } catch (_) { /* noop */ }
      return;
    }
    if (msg.type === 'stream_fail' && msg.streamToken) {
      const pending = pendingStreams.get(msg.streamToken);
      if (pending) {
        pendingStreams.delete(msg.streamToken);
        clearTimeout(pending.timer);
        pending.reject(new Error(msg.message || '데몬이 스트림을 열지 못했습니다.'));
      }
      return;
    }
    if (msg.type === 'rpc_result' && msg.id != null) {
      const pending = conn.pendingRpc.get(msg.id);
      if (pending) {
        conn.pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error || 'RPC 실패'));
      }
      return;
    }
    if (msg.type === 'fs_event') {
      broadcastEvent(userId, { type: 'fs_event', event: msg.event, path: msg.path });
      return;
    }
    if (msg.type === 'agent_event') {
      // BYO 에이전트 이벤트(agent_init/text/tool_use/permission_request/done/…) — 앱에 팬아웃.
      // 순서는 데몬 seq(세션별)로 보장. M3-1: SSE(기존)와 WSS(버퍼+리플레이) 양쪽으로 내보낸다.
      const payload = { type: 'agent_event', sessionId: msg.sessionId, seq: msg.seq, event: msg.event };
      broadcastEvent(userId, payload);   // SSE(기존, 폴백)
      pushAgentEvent(userId, payload);   // WSS 버퍼 + 라이브(리플레이용 rseq 부여)
      maybePush(userId, msg.sessionId, msg.event); // M3-3: 앱이 안 보고 있을 때만 푸시
      return;
    }
    if (msg.type === 'sync_event') {
      // 동기화 이벤트(sync_status/sync_progress/sync_conflict) — 앱에 팬아웃.
      //  버퍼링하지 않는다(오래된 sync_conflict 리플레이로 해결된 충돌 시트가 되살아나는 것 방지).
      fanoutSyncEvent(userId, msg.event);
      return;
    }
  });

  const cleanup = () => {
    clearInterval(ka);
    // 미해결 RPC 는 실패로 정리(무한 대기 방지).
    for (const [, p] of conn.pendingRpc) { clearTimeout(p.timer); try { p.reject(new Error('DAEMON_OFFLINE')); } catch (_) { /* noop */ } }
    conn.pendingRpc.clear();
    const entry = connections.get(userId);
    if (entry && entry.runners.get(conn.deviceId) === conn) {
      entry.runners.delete(conn.deviceId);
      // 활성 러너가 끊겼으면 남은 러너로 이전(있으면), 없으면 null.
      if (entry.activeRunnerId === conn.deviceId) {
        entry.activeRunnerId = entry.runners.size ? entry.runners.keys().next().value : null;
      }
      if (entry.runners.size === 0) connections.delete(userId);
      console.log(`[daemonRelay] 러너 연결 종료 userId=${userId} kind=${conn.kind} device=#${conn.deviceId} aliveMs=${Date.now() - conn.connectedAt} 남은러너=${entry.runners.size}`);
    }
    DaemonDevice.update({ last_seen_at: new Date() }, { where: { id: conn.deviceId } }).catch(() => { /* noop */ });
  };
  ws.on('close', cleanup);
  ws.on('error', (e) => { console.log(`[daemonRelay] 제어 WS 오류 userId=${userId}: ${e && e.message}`); cleanup(); });
}

function touchLastSeen(conn, force) {
  const now = Date.now();
  if (!force && now - conn.lastSeenFlushedAt < LAST_SEEN_FLUSH_MS) return;
  conn.lastSeenFlushedAt = now;
  DaemonDevice.update({ last_seen_at: new Date() }, { where: { id: conn.deviceId } }).catch(() => { /* noop */ });
}

// ── 스트림(dial-back) ─────────────────────────────────────────────────

// 제어 채널로 stream_open 지시 → 데몬이 /api/daemon/stream/:token 으로 다이얼 → 그 WS resolve.
function openStream(userId, kind, params, opts) {
  const conn = pickConn(userId, opts); // 기본=활성 러너
  if (!conn) return Promise.reject(new Error('DAEMON_OFFLINE'));
  conn.lastActivityAt = Date.now(); // 스트림 오픈=활동
  const streamToken = 'ds-' + crypto.randomBytes(18).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStreams.delete(streamToken);
      reject(new Error('데몬이 응답하지 않습니다(스트림 타임아웃).'));
    }, STREAM_OPEN_TIMEOUT_MS);
    pendingStreams.set(streamToken, { userId: String(userId), kind, resolve, reject, timer });
    try {
      conn.ws.send(JSON.stringify({ type: 'stream_open', streamToken, kind, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      pendingStreams.delete(streamToken);
      reject(new Error('데몬 제어 채널 전송 실패: ' + e.message));
    }
  });
}

// ── fs RPC ────────────────────────────────────────────────────────────
// 제어 채널로 {type:'rpc'} 를 보내고 {type:'rpc_result'} 를 id 로 매칭해 Promise resolve.
function callRpc(userId, method, params, timeoutMs, opts) {
  const conn = pickConn(userId, opts); // 기본=활성 러너(로컬/클라우드). opts.runnerId/kind 로 특정 러너 지정.
  if (!conn) return Promise.reject(new Error('DAEMON_OFFLINE'));
  conn.lastActivityAt = Date.now(); // RPC=활동
  const id = ++conn.rpcSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pendingRpc.delete(id);
      reject(new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'));
    }, timeoutMs || RPC_TIMEOUT_MS);
    conn.pendingRpc.set(id, { resolve, reject, timer });
    try {
      conn.ws.send(JSON.stringify({ type: 'rpc', id, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      conn.pendingRpc.delete(id);
      reject(new Error('데몬 제어 채널 전송 실패: ' + e.message));
    }
  });
}

// ── 파일 이벤트 SSE(앱 구독) ──
function addEventClient(userId, res) {
  const key = String(userId);
  let set = eventClients.get(key);
  if (!set) { set = new Set(); eventClients.set(key, set); }
  set.add(res);
}

function removeEventClient(userId, res) {
  const key = String(userId);
  const set = eventClients.get(key);
  if (set) { set.delete(res); if (set.size === 0) eventClients.delete(key); }
}

function broadcastEvent(userId, payload) {
  const set = eventClients.get(String(userId));
  if (!set || set.size === 0) return;
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of set) { try { res.write(line); } catch (_) { /* noop */ } }
}

// 동기화 이벤트 팬아웃 — SSE(폴백) + WSS(현재 구독) 양쪽에 즉시 전달(버퍼/리플레이 없음).
//  프레임 형태 {type:'sync_event', event} — 앱은 이 type 을 보고 sync UI(진행/충돌 시트)를 갱신.
function fanoutSyncEvent(userId, event) {
  const payload = { type: 'sync_event', event };
  broadcastEvent(userId, payload); // SSE
  const key = String(userId);
  const set = agentWsClients.get(key);
  if (set) { const frame = JSON.stringify(payload); for (const ws of set) { try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ } } }
}

// 앱이 지금 이벤트를 받고 있는가(WSS 또는 SSE 연결됨) — foreground 판정 근사치.
function hasActiveClient(userId) {
  const key = String(userId);
  const ws = agentWsClients.get(key);
  const sse = eventClients.get(key);
  return !!((ws && ws.size) || (sse && sse.size));
}

// M3-3: 핵심 3종(done/permission_request/crashed) 발생 시, 앱이 안 보고 있으면 푸시.
//  RUNNER_OFFLINE 은 푸시 아님(연결 인디케이터). 앱 연결 중이면 라이브로 보므로 스킵.
const PUSH_KIND = { done: 'done', permission_request: 'permission_request', error: 'crashed' };
const PUSH_TITLE = { done: '작업이 끝났어요', permission_request: '승인이 필요해요', crashed: '에이전트에 문제가 생겼어요' };
function maybePush(userId, sessionId, event) {
  if (!event || !event.type) return;
  const kind = PUSH_KIND[event.type];
  if (!kind) return;
  if (hasActiveClient(userId)) return; // 앱이 연결돼 라이브로 보는 중 → 푸시 불필요
  const sid = sessionId || '';
  pushService.sendToUser(userId, {
    kind, sessionId: sid, title: PUSH_TITLE[kind],
    deeplink: `codingpt://session/${encodeURIComponent(sid)}?kind=${kind}`,
  }).catch(() => { /* fire-and-forget */ });
}

// ── 에이전트 이벤트 채널(M3-1): 롤링 버퍼 + WSS 라이브 ──
// 데몬 agent_event 를 릴레이 순번(rseq)과 함께 버퍼에 넣고, 접속 중인 WSS 구독자에게 즉시 보낸다.
// 버퍼는 앱이 백그라운드/재접속 사이 놓친 이벤트를 attach(lastRseq) 로 리플레이하는 데 쓴다.
function pushAgentEvent(userId, payload) {
  const key = String(userId);
  let buf = agentBuf.get(key);
  if (!buf) { buf = { seq: 0, items: [] }; agentBuf.set(key, buf); }
  const rseq = ++buf.seq;
  const at = Date.now();
  buf.items.push({ rseq, at, payload });
  // 트리밍: 최근 1,000건 또는 5분(둘 중 큰 쪽) — 오래되고 상한 초과분만 버린다.
  const cutoff = at - AGENT_BUF_TTL_MS;
  while (buf.items.length > AGENT_BUF_MAX && buf.items[0].at < cutoff) buf.items.shift();
  const frame = JSON.stringify({ ...payload, rseq });
  const set = agentWsClients.get(key);
  if (set) for (const ws of set) { try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ } }
  return rseq;
}

// GET /api/daemon/agent/stream?token=<JWT> 업그레이드(앱→back). 에이전트 이벤트 WSS 구독.
//  WebSocket 은 Authorization 헤더를 못 실으므로 access token 을 쿼리로 받아 검증한다.
function handleAgentStreamUpgrade(token, req, socket, head) {
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
    userId = decoded && (decoded.id || decoded.userId);
  } catch (_) { userId = null; }
  if (!userId) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  wss.handleUpgrade(req, socket, head, (ws) => registerAgentWs(ws, String(userId)));
}

function registerAgentWs(ws, userId) {
  let set = agentWsClients.get(userId);
  if (!set) { set = new Set(); agentWsClients.set(userId, set); }
  set.add(ws);
  const ka = setInterval(() => { try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch (_) { /* noop */ } }, PING_INTERVAL_MS);
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'attach') {
      // lastRseq 이후 버퍼 이벤트를 순서대로 리플레이한 뒤 attach_ack(headRseq).
      //  lastRseq < 0 = "지금부터"(첫 구독) → 리플레이 안 함(과거 세션/이미 본 이벤트 재적용 방지).
      //  재접속 시엔 앱이 마지막으로 받은 rseq 를 보내 놓친 구간만 채운다.
      const buf = agentBuf.get(userId);
      const raw = Number(msg.lastRseq);
      const since = Number.isFinite(raw) ? raw : 0;
      if (buf && since >= 0) for (const it of buf.items) {
        if (it.rseq > since) { try { ws.send(JSON.stringify({ ...it.payload, rseq: it.rseq })); } catch (_) { /* noop */ } }
      }
      try { ws.send(JSON.stringify({ type: 'attach_ack', headRseq: buf ? buf.seq : 0 })); } catch (_) { /* noop */ }
      return;
    }
    // ack 는 MVP 에선 keepalive 로만 취급(버퍼 트리밍은 상한/TTL 로 처리).
  });
  const cleanup = () => {
    clearInterval(ka);
    const s = agentWsClients.get(userId);
    if (s) { s.delete(ws); if (s.size === 0) agentWsClients.delete(userId); }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

// GET /api/daemon/stream/:streamToken 업그레이드(데몬→back).
function handleStreamUpgrade(streamToken, req, socket, head) {
  const pending = pendingStreams.get(streamToken);
  if (!pending) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  pendingStreams.delete(streamToken);
  clearTimeout(pending.timer);
  wss.handleUpgrade(req, socket, head, (ws) => pending.resolve(ws));
}

// ── 앱 터미널 ─────────────────────────────────────────────────────────

function termTokenFor(userId) {
  return 'dterm-' + crypto.createHmac('sha256', SECRET).update(`dterm:${userId}`).digest('hex').slice(0, 18);
}

// POST /api/daemon/terminal/start 에서 호출(인증 후). 데몬 오프라인이면 throw.
function issueTerminalToken(userId, cwd, paneId, win) {
  if (!pickConn(userId)) { // 활성 러너 없으면 오프라인
    const err = new Error('PC 데몬이 연결되어 있지 않습니다.');
    err.statusCode = 409;
    throw err;
  }
  const token = termTokenFor(userId);
  // cwd(데몬 홈-기준 상대경로) — 진입한 워크스페이스 폴더에서 터미널을 시작. 빈 문자열=홈.
  // paneId — pane 별 grouped tmux view 세션 식별(여러 터미널 pane 이 각자 다른 window 를 동시에 보게).
  // win — 이 pane 이 표시할 tmux window(정수). 앱이 미리 확보해 넘기면 데몬이 attach 와 동시에 select.
  const winNum = Number.isInteger(win) ? win : null;
  termTokens.set(token, { userId, cwd: typeof cwd === 'string' ? cwd : '', paneId: typeof paneId === 'string' ? paneId : '', win: winNum, expiresAt: Date.now() + TERM_TOKEN_TTL_MS });
  return token;
}

function resolveTermToken(token) {
  const sess = termTokens.get(token);
  if (!sess || sess.expiresAt < Date.now()) { if (sess) termTokens.delete(token); return null; }
  sess.expiresAt = Date.now() + TERM_TOKEN_TTL_MS;
  return sess;
}

// GET /api/daemon/terminal/:token 업그레이드(앱→back).
// 앱 핸드셰이크를 먼저 완료(빠른 open) 후 데몬에 PTY 스트림을 열어 브리지.
function handleAppTerminalUpgrade(token, req, socket, head) {
  const sess = resolveTermToken(token);
  if (!sess) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  wss.handleUpgrade(req, socket, head, async (appWs) => {
    let daemonWs = null;
    // 이 터미널을 실제로 여는 대상 러너 conn — 라이브 터미널 카운트로 동면을 막는다.
    const ptyConn = pickConn(sess.userId);
    try {
      // cols/rows 는 앱이 접속 직후 resize 프레임으로 보정하므로 기본값으로 시작. cwd=진입 워크스페이스 폴더.
      daemonWs = await openStream(sess.userId, 'pty', { cols: 80, rows: 24, cwd: sess.cwd || '', paneId: sess.paneId || '', win: Number.isInteger(sess.win) ? sess.win : undefined });
    } catch (e) {
      const msg = e.message === 'DAEMON_OFFLINE' ? 'PC 데몬이 오프라인입니다.' : ('터미널을 열 수 없습니다: ' + e.message);
      try { appWs.send('\r\n\x1b[31m' + msg + '\x1b[0m\r\n'); appWs.close(); } catch (_) { /* noop */ }
      return;
    }
    if (ptyConn) {
      ptyConn.liveTerminals = (ptyConn.liveTerminals || 0) + 1;
      const dec = () => { ptyConn.liveTerminals = Math.max(0, (ptyConn.liveTerminals || 1) - 1); };
      appWs.once('close', dec);
      appWs.once('error', dec);
    }
    bridge(appWs, daemonWs, `pty userId=${sess.userId}`);
  });
}

// ── 양방향 브리지 ─────────────────────────────────────────────────────
// 메시지 단위 릴레이(텍스트/바이너리 구분 보존 — resize JSON 은 텍스트, stdin 은 바이너리).
// raw 소켓 pipe 는 WS 마스킹(클라→서버만 마스킹) 때문에 불가.
function bridge(aWs, bWs, label) {
  const openedAt = Date.now();
  const relay = (from, to) => {
    from.on('message', (data, isBinary) => {
      try { if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary }); } catch (_) { /* noop */ }
    });
  };
  relay(aWs, bWs);
  relay(bWs, aWs);
  const ka = setInterval(() => {
    try { if (aWs.readyState === WebSocket.OPEN) aWs.ping(); } catch (_) { /* noop */ }
    try { if (bWs.readyState === WebSocket.OPEN) bWs.ping(); } catch (_) { /* noop */ }
  }, PING_INTERVAL_MS);
  const cleanup = (why) => {
    clearInterval(ka);
    try { aWs.close(); } catch (_) { /* noop */ }
    try { bWs.close(); } catch (_) { /* noop */ }
    console.log(`[daemonRelay] 브리지 종료 (${label}) why=${why} aliveMs=${Date.now() - openedAt}`);
  };
  aWs.on('close', () => cleanup('app-close'));
  bWs.on('close', () => cleanup('daemon-close'));
  aWs.on('error', () => cleanup('app-error'));
  bWs.on('error', () => cleanup('daemon-error'));
}

// ── 상태 조회/강제 종료 ───────────────────────────────────────────────

// 활성 러너 conn 반환(상태 표시용 — deviceName/platform/connectedAt). 없으면 null.
function getConnection(userId) {
  return pickConn(userId) || null;
}

function disconnectDevice(deviceId) {
  for (const [, entry] of connections) {
    const conn = entry.runners.get(Number(deviceId));
    if (conn) {
      try { conn.ws.close(4001, 'revoked'); } catch (_) { /* noop */ }
      return true;
    }
  }
  return false;
}

// ── 프리뷰 프록시(데몬 dev 서버) ───────────────────────────────────────
// dial-back TCP 터널(kind:'tcp')로 사용자 PC 의 127.0.0.1:<port> 에 붙어 HTTP/HMR 을 프록시한다.
// 데몬은 HTTP 를 해석하지 않고 raw 바이트만 릴레이 → back 이 HTTP 를 종단(요청 재구성/응답 파이프).

// 스트림 WS 를 Node Duplex(바이트 스트림)로 감싸 http.request 의 소켓으로 쓴다.
// createWebSocketStream 은 바이너리 메시지를 이어붙인 바이트 스트림을 준다(TCP 등가).
// http 가 호출하는 소켓 메서드 몇 개를 no-op 으로 스텁(Duplex 엔 없음).
function wsToSocket(ws) {
  const duplex = WebSocket.createWebSocketStream(ws, { allowHalfOpen: false });
  const noop = () => duplex;
  duplex.setNoDelay = duplex.setKeepAlive = duplex.setTimeout = noop;
  duplex.ref = duplex.unref = noop;
  return duplex;
}

// HTTP 프록시 한 건 = dial-back 터널 한 개(요청마다 새 연결, Connection: close).
async function proxyHttp(userId, port, path, req, res) {
  let ws;
  try {
    ws = await openStream(userId, 'tcp', { port });
  } catch (e) {
    if (!res.headersSent) res.status(502).end('preview: 데몬 연결 실패 — ' + e.message);
    return;
  }
  const socket = wsToSocket(ws);
  const headers = { ...req.headers };
  delete headers.host; // dev 서버가 보는 Host 는 localhost:port
  headers.host = `localhost:${port}`;
  headers.connection = 'close'; // 단발 터널 — 응답 후 종료
  delete headers['accept-encoding']; // 재작성/버퍼링 대비 압축 회피(dev 서버는 대개 비압축)

  const upstream = http.request(
    { createConnection: () => socket, method: req.method, path, headers, timeout: 30000 },
    (up) => {
      if (!res.headersSent) res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) res.status(502).end('preview proxy error: ' + e.message);
    else { try { res.end(); } catch (_) { /* noop */ } }
    try { ws.close(); } catch (_) { /* noop */ }
  });
  upstream.on('timeout', () => { try { upstream.destroy(); } catch (_) { /* noop */ } });
  res.on('close', () => { try { ws.close(); } catch (_) { /* noop */ } });
  req.pipe(upstream);
}

// HMR 등 WebSocket 업그레이드 프록시 — dial-back 터널에 원본 업그레이드 요청을 재구성해 쓰고 raw 브리지.
async function proxyWs(userId, port, path, req, socket, head) {
  let ws;
  try { ws = await openStream(userId, 'tcp', { port }); }
  catch (_) { try { socket.destroy(); } catch (_2) { /* noop */ } return; }
  const tunnel = wsToSocket(ws);

  const headers = { ...req.headers };
  delete headers.host;
  headers.host = `localhost:${port}`;
  const lines = [`${req.method} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
    else lines.push(`${k}: ${v}`);
  }
  tunnel.write(lines.join('\r\n') + '\r\n\r\n');
  if (head && head.length) tunnel.write(head);

  tunnel.pipe(socket);
  socket.pipe(tunnel);
  const cleanup = () => {
    try { tunnel.destroy(); } catch (_) { /* noop */ }
    try { socket.destroy(); } catch (_) { /* noop */ }
    try { ws.close(); } catch (_) { /* noop */ }
  };
  tunnel.on('error', cleanup); socket.on('error', cleanup);
  tunnel.on('close', cleanup); socket.on('close', cleanup);
}

// 토큰/펜딩 스윕
const _sweeper = setInterval(() => {
  const now = Date.now();
  for (const [t, s] of termTokens) { if (s.expiresAt < now) termTokens.delete(t); }
}, 5 * 60 * 1000);
if (_sweeper.unref) _sweeper.unref();

module.exports = {
  handleControlUpgrade,
  handleStreamUpgrade,
  handleAppTerminalUpgrade,
  handleAgentStreamUpgrade,
  openStream,
  callRpc,
  issueTerminalToken,
  getConnection,
  disconnectDevice,
  setActiveRunner,
  listRunners,
  listCloudRunners,
  fanoutSyncEvent,
  addEventClient,
  removeEventClient,
  proxyHttp,
  proxyWs,
};
