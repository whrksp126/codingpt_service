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
const WebSocket = require('ws');
const { DaemonDevice } = require('../models');

const wss = new WebSocket.Server({ noServer: true });

const STREAM_OPEN_TIMEOUT_MS = 10 * 1000; // stream_open 지시 후 데몬 dial-back 대기
const RPC_TIMEOUT_MS = 15 * 1000; // fs RPC 응답 대기
const TERM_TOKEN_TTL_MS = 60 * 60 * 1000; // 앱 터미널 토큰 1시간(접근 시 갱신)
const PING_INTERVAL_MS = 30 * 1000; // Cloudflare 유휴 WS ~100s 컷 대비
const LAST_SEEN_FLUSH_MS = 60 * 1000; // last_seen_at DB 반영 주기

// userId(str) → { deviceId, deviceName, platform, daemonVersion, ws, connectedAt, lastSeenFlushedAt, rpcSeq, pendingRpc }
const connections = new Map();
// streamToken → { userId, kind, resolve, reject, timer }
const pendingStreams = new Map();
// 앱 터미널 토큰 → { userId, expiresAt }
const termTokens = new Map();
// userId(str) → Set<res>  파일 변경 이벤트 SSE 구독자(앱). 데몬 fs_event 를 여기로 broadcast.
const eventClients = new Map();

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
  // 같은 사용자의 기존 연결은 교체(데몬 재시작/재접속) — 새 연결이 항상 이긴다.
  const prev = connections.get(userId);
  if (prev) { try { prev.ws.close(4000, 'replaced'); } catch (_) { /* noop */ } }

  const conn = {
    deviceId: device.id,
    deviceName: device.device_name,
    platform: device.platform,
    daemonVersion: device.daemon_version,
    ws,
    connectedAt: Date.now(),
    lastSeenFlushedAt: 0,
    rpcSeq: 0,
    pendingRpc: new Map(), // id → { resolve, reject, timer }
  };
  connections.set(userId, conn);
  console.log(`[daemonRelay] 데몬 연결 userId=${userId} device=${device.device_name}(#${device.id})`);
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
    }
  });

  const cleanup = () => {
    clearInterval(ka);
    // 미해결 RPC 는 실패로 정리(무한 대기 방지).
    for (const [, p] of conn.pendingRpc) { clearTimeout(p.timer); try { p.reject(new Error('DAEMON_OFFLINE')); } catch (_) { /* noop */ } }
    conn.pendingRpc.clear();
    if (connections.get(userId) === conn) {
      connections.delete(userId);
      console.log(`[daemonRelay] 데몬 연결 종료 userId=${userId} aliveMs=${Date.now() - conn.connectedAt}`);
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
function openStream(userId, kind, params) {
  const conn = connections.get(String(userId));
  if (!conn) return Promise.reject(new Error('DAEMON_OFFLINE'));
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
function callRpc(userId, method, params) {
  const conn = connections.get(String(userId));
  if (!conn) return Promise.reject(new Error('DAEMON_OFFLINE'));
  const id = ++conn.rpcSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pendingRpc.delete(id);
      reject(new Error('데몬이 응답하지 않습니다(RPC 타임아웃).'));
    }, RPC_TIMEOUT_MS);
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
function issueTerminalToken(userId, cwd) {
  if (!connections.has(String(userId))) {
    const err = new Error('PC 데몬이 연결되어 있지 않습니다.');
    err.statusCode = 409;
    throw err;
  }
  const token = termTokenFor(userId);
  // cwd(데몬 홈-기준 상대경로) — 진입한 워크스페이스 폴더에서 터미널을 시작. 빈 문자열=홈.
  termTokens.set(token, { userId, cwd: typeof cwd === 'string' ? cwd : '', expiresAt: Date.now() + TERM_TOKEN_TTL_MS });
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
    try {
      // cols/rows 는 앱이 접속 직후 resize 프레임으로 보정하므로 기본값으로 시작. cwd=진입 워크스페이스 폴더.
      daemonWs = await openStream(sess.userId, 'pty', { cols: 80, rows: 24, cwd: sess.cwd || '' });
    } catch (e) {
      const msg = e.message === 'DAEMON_OFFLINE' ? 'PC 데몬이 오프라인입니다.' : ('터미널을 열 수 없습니다: ' + e.message);
      try { appWs.send('\r\n\x1b[31m' + msg + '\x1b[0m\r\n'); appWs.close(); } catch (_) { /* noop */ }
      return;
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

function getConnection(userId) {
  return connections.get(String(userId)) || null;
}

function disconnectDevice(deviceId) {
  for (const [, conn] of connections) {
    if (conn.deviceId === Number(deviceId)) {
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
  openStream,
  callRpc,
  issueTerminalToken,
  getConnection,
  disconnectDevice,
  addEventClient,
  removeEventClient,
  proxyHttp,
  proxyWs,
};
