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
const { SERVER_CAPS } = require('../config/caps');
// (구) pushService 직접 발송(maybePush)은 제거 — FCM 은 notificationService.createNotification 내부에서 한 번만.

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
    caps: c.caps || [], // 진단용(hello.caps). 구 데몬은 [] — 구 클라이언트는 이 필드를 무시한다.
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

// 상대가 보낸 caps 배열 정규화(hello / ui_hello 공용) — 배관이므로 절대 throw 하지 않는다.
//  신뢰 경계: caps 는 인증된 상대가 보내지만 "자기 신고" 값이므로 그대로 저장/에코하지 않는다.
//  문자열만·길이 상한·중복 제거·개수 상한(로그/응답이 비대해지는 것과 메모리 증식을 동시에 막음).
//  배열이 아니거나(구버전=필드 부재) 전부 버려지면 [] → 게이팅은 자동으로 "기존 동작" 폴백.
const CAPS_MAX = 32;
function normCaps(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v) {
    if (typeof c !== 'string') continue;
    const s = c.trim().slice(0, 64);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= CAPS_MAX) break;
  }
  return out;
}

// ── 제어 채널 ─────────────────────────────────────────────────────────

// 인증 실패 negative cache — 폐기 토큰의 구버전 데몬(401 을 무시하고 백오프 없이 재시도하는
//  옛 바이너리)이 초 단위로 두드려도 DB 조회·로그 없이 즉시 401 로 쳐낸다. 해시키라 원문 무보관.
const authFailCache = new Map(); // tokenHash → expiresAt
const AUTH_FAIL_TTL_MS = 60 * 1000;

// GET /api/daemon/connect 업그레이드. Bearer deviceToken 을 DB 해시 대조로 인증.
async function handleControlUpgrade(req, socket, head) {
  socket.on('error', () => { /* 인증 중 끊김 무시 */ });
  let device = null;
  let tokenHash = null;
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      tokenHash = sha256(token);
      const failUntil = authFailCache.get(tokenHash);
      if (failUntil && failUntil > Date.now()) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) { /* noop */ }
        try { socket.destroy(); } catch (_) { /* noop */ }
        return;
      }
      device = await DaemonDevice.findOne({ where: { token_hash: tokenHash, revoked_at: null } });
    }
  } catch (e) {
    console.error('[daemonRelay] 제어 채널 인증 오류:', e.message);
    tokenHash = null; // DB 일시 오류 — "토큰 무효" 로 오인해 캐시(60s 차단)하지 않는다
  }
  if (!device) {
    // 401 을 명시 응답 — 삭제/해제된 deviceToken 의 데몬이 이를 보고 재연결 폭주를 멈춘다
    //  (그냥 destroy 하면 데몬이 일시 네트워크 오류로 오인해 영원히 재시도).
    if (tokenHash) {
      if (authFailCache.size > 1000) authFailCache.clear(); // 무한 성장 방지(악의적 난수 토큰)
      authFailCache.set(tokenHash, Date.now() + AUTH_FAIL_TTL_MS);
    }
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) { /* noop */ }
    try { socket.destroy(); } catch (_) { /* noop */ }
    return;
  }
  if (tokenHash) authFailCache.delete(tokenHash); // 재페어링 등으로 유효해진 토큰 즉시 회복

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
    caps: [],                   // 데몬이 hello.caps 로 신고한 능력(구버전 데몬 = 영구 []). 게이팅/진단용.
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
  fanoutRunnerStatus(userId, { deviceId: conn.deviceId, online: true, kind: conn.kind, deviceName: conn.deviceName });

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
      // capability 협상(설계 §2-(d)) — 옵셔널 필드. 구버전 데몬은 안 보내므로 caps 가 [] 로 남고,
      //  교집합 게이팅이 자동으로 "기존 동작" 폴백이 된다(여기서 아무 기능도 켜지 않는다 = 배관만).
      //  hello 는 재연결·버전업마다 다시 오므로 그때마다 최신 신고로 덮는다(부재 시엔 유지하지 않고 비움 —
      //  다운그레이드 설치 후에도 상태가 남지 않게).
      if ('caps' in msg) conn.caps = normCaps(msg.caps);
      DaemonDevice.update(
        { device_name: conn.deviceName, platform: conn.platform, daemon_version: conn.daemonVersion, updated_at: new Date() },
        { where: { id: conn.deviceId } }
      ).catch(() => { /* noop */ });
      if (conn.caps.length) console.log(`[daemonRelay] 데몬 caps device=#${conn.deviceId} v=${conn.daemonVersion} caps=${conn.caps.join(',')}`);
      // serverCaps 는 additive — 구 데몬의 hello_ack 핸들러는 serverTime 만 읽고 나머지를 무시한다.
      try { ws.send(JSON.stringify({ type: 'hello_ack', serverTime: new Date().toISOString(), serverCaps: SERVER_CAPS })); } catch (_) { /* noop */ }
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
      maybeNotify(userId, msg.sessionId, msg.event); // 알림 영속화 + 팬아웃 + (미접속 시) FCM
      return;
    }
    if (msg.type === 'sync_event') {
      // 동기화 이벤트(sync_status/sync_progress/sync_conflict) — 앱에 팬아웃.
      //  버퍼링하지 않는다(오래된 sync_conflict 리플레이로 해결된 충돌 시트가 되살아나는 것 방지).
      fanoutSyncEvent(userId, msg.event);
      return;
    }
    if (msg.type === 'ui_command') {
      // 데몬(cpt CLI)→UI 클라이언트 커맨드 중계 — 결과(ui_result)는 요청이 온 이 conn 으로 회신.
      handleUiCommand(userId, conn, msg);
      return;
    }
  });

  const cleanup = () => {
    clearInterval(ka);
    // 미해결 RPC 는 실패로 정리(무한 대기 방지).
    for (const [, p] of conn.pendingRpc) { clearTimeout(p.timer); try { p.reject(new Error('DAEMON_OFFLINE')); } catch (_) { /* noop */ } }
    conn.pendingRpc.clear();
    // 이 데몬 conn 이 기다리던 ui_command 응답은 회신처가 사라짐 → 타이머만 정리하고 폐기.
    for (const [uiId, p] of uiPending) {
      if (p.conn === conn) { clearTimeout(p.timer); uiPending.delete(uiId); }
    }
    const entry = connections.get(userId);
    if (entry && entry.runners.get(conn.deviceId) === conn) {
      entry.runners.delete(conn.deviceId);
      // 활성 러너가 끊겼으면 남은 러너로 이전(있으면), 없으면 null.
      if (entry.activeRunnerId === conn.deviceId) {
        entry.activeRunnerId = entry.runners.size ? entry.runners.keys().next().value : null;
      }
      if (entry.runners.size === 0) connections.delete(userId);
      console.log(`[daemonRelay] 러너 연결 종료 userId=${userId} kind=${conn.kind} device=#${conn.deviceId} aliveMs=${Date.now() - conn.connectedAt} 남은러너=${entry.runners.size}`);
      fanoutRunnerStatus(userId, { deviceId: conn.deviceId, online: false, kind: conn.kind, deviceName: conn.deviceName });
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
// client — 구독 기기 종류('pc'|'mobile', 기본 mobile). FCM 억제 판정(hasActiveMobileClient)에 사용.
function addEventClient(userId, res, client) {
  const key = String(userId);
  let set = eventClients.get(key);
  if (!set) { set = new Set(); eventClients.set(key, set); }
  res._cptClient = client === 'pc' ? 'pc' : 'mobile';
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

// 모바일 클라이언트만 접속 판정 — FCM 억제 기준(PC 만 붙어 있으면 폰엔 푸시가 가야 함).
//  WSS 는 스트림 접속 쿼리 &client= 태그, SSE 는 addEventClient 의 client 태그로 구분(기본 mobile).
function hasActiveMobileClient(userId) {
  const key = String(userId);
  const ws = agentWsClients.get(key);
  if (ws) for (const c of ws) { if (c._cptClient === 'mobile') return true; }
  const sse = eventClients.get(key);
  if (sse) for (const r of sse) { if ((r._cptClient || 'mobile') === 'mobile') return true; }
  return false;
}

// present 기기가 "최근에도 실제로 쓰이는지" 판정 창(5분). foregroundAt(포커스/포그라운드 전환 +
//  입력 활동 ui_activity 로 갱신)이 이 안이면 fresh=true. 소리(alertClientKey)는 focus 만 보지만,
//  폰 FCM 억제는 fresh 까지 본다 — 창은 포커스돼 있으나 자리를 비운 지 오래면 폰으로 넘기기 위함.
const PRESENCE_FRESH_MS = 5 * 60 * 1000;

// 알림을 보낼 "지금 사용자가 보고 있는(present) 기기" 를 고른다 — 알림 present-device 라우팅.
//  · present = ui_hello 한 접속 클라이언트 중 foreground=true 인 것(가장 최근 포그라운드된 하나).
//    (PC 는 창 포커스, 모바일은 AppState=active 를 presence 로 보고 → foreground 갱신)
//  · fresh = 그 기기가 최근(PRESENCE_FRESH_MS) 활성 — 폰 FCM 억제 판정용.
//  · 없으면 null → 호출부가 폰 FCM 푸시로 대체.
//  반환: { clientKey, kind, foregroundAt, fresh } 또는 null.
function presentClient(userId) {
  const set = agentWsClients.get(String(userId));
  if (!set) return null;
  let best = null;
  for (const ws of set) {
    const m = ws._cptMeta;
    if (!m || !m.clientKey || !m.foreground) continue;
    if (!best || (m.foregroundAt || 0) > (best.foregroundAt || 0)) best = m;
  }
  if (!best) return null;
  const fresh = (Date.now() - (best.foregroundAt || 0)) < PRESENCE_FRESH_MS;
  return { clientKey: best.clientKey, kind: best.kind, foregroundAt: best.foregroundAt || 0, fresh };
}

// 접속 중인 UI 클라이언트(화면) 목록 — 기기 타겟팅용(cpt devices / --on). executor(활성 기기) 표기.
//  handleUiCommand 의 executor 선정과 동일 정렬(foreground → lastActivityAt → pc)로 1위를 executor 로 마킹.
function listUiClients(userId) {
  const set = agentWsClients.get(String(userId));
  const out = [];
  if (set) for (const ws of set) {
    const m = ws._cptMeta;
    if (!m || ws.readyState !== WebSocket.OPEN) continue;
    out.push({
      clientKey: m.clientKey || '', deviceId: m.deviceId ?? null, deviceName: m.deviceName || '',
      kind: m.kind, foreground: !!m.foreground, lastActivityAt: m.lastActivityAt || 0, executor: false,
      // ui_hello.caps — "이 화면이 응답할 수 있는 기능"(예: 승인 카드). 데몬이 "요청을 만들어도 되는가"를
      //  판단하는 근거(§2-(d) 게이팅). 구 클라이언트는 안 보내므로 [].
      caps: m.caps || [],
    });
  }
  out.sort((a, b) =>
    ((b.foreground ? 1 : 0) - (a.foreground ? 1 : 0)) ||
    (b.lastActivityAt - a.lastActivityAt) ||
    ((b.kind === 'pc' ? 1 : 0) - (a.kind === 'pc' ? 1 : 0)));
  if (out.length) out[0].executor = true;
  return out;
}

// 알림 팬아웃 — notif_event(new/read) 를 SSE(폴백) + WSS 양쪽에 즉시 전달(버퍼/리플레이 없음).
//  프레임 형태 {type:'notif_event', event} — fanoutSyncEvent 미러. notificationService 가 호출.
function fanoutNotifEvent(userId, event) {
  const payload = { type: 'notif_event', event };
  broadcastEvent(userId, payload); // SSE
  const key = String(userId);
  const set = agentWsClients.get(key);
  if (set) { const frame = JSON.stringify(payload); for (const ws of set) { try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ } } }
}

// 회원 탈퇴 통지 — 접속 중인 모든 UI 클라이언트(폰/태블릿/PC)에 {type:'account_deleted'} 를 보내고
//  소켓을 닫는다. 클라이언트는 이를 받으면 즉시 로컬 로그아웃/페어링 해제 → 로그인 화면.
//  탈퇴 처리(DB 삭제) "전"에 호출해야 소켓이 아직 살아 있다.
function fanoutAccountDeleted(userId) {
  const payload = { type: 'account_deleted' };
  broadcastEvent(userId, payload); // SSE 폴백
  const set = agentWsClients.get(String(userId));
  if (set) {
    const frame = JSON.stringify(payload);
    for (const ws of set) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ }
      // 전송 플러시 여유 후 종료 — 즉시 close 하면 프레임이 유실될 수 있다.
      setTimeout(() => { try { ws.close(4001, 'account-deleted'); } catch (_) { /* noop */ } }, 300);
    }
  }
}

// 모양 설정(계정 전체 동기화) 팬아웃 — {type:'appearance_event', event:{appearance}}.
//  어느 기기서 바꾸든 같은 계정의 모든 접속 클라이언트(PC/모바일)에 즉시 반영(구 클라이언트는 무시해도 안전).
function fanoutAppearance(userId, appearance) {
  const payload = { type: 'appearance_event', event: { appearance } };
  broadcastEvent(userId, payload); // SSE 폴백
  const set = agentWsClients.get(String(userId));
  if (set) { const frame = JSON.stringify(payload); for (const ws of set) { try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ } } }
}

// 러너(데몬) 연결 상태 팬아웃 — 접속/종료 즉시 {type:'runner_status', event:{deviceId, online, kind, deviceName}}.
//  클라이언트 사이드바의 호스트 온라인 점/오프라인 UX 를 라이브로 갱신하는 용도(구 클라이언트는 무시해도 안전).
function fanoutRunnerStatus(userId, event) {
  const payload = { type: 'runner_status', event };
  broadcastEvent(userId, payload); // SSE
  const set = agentWsClients.get(String(userId));
  if (set) { const frame = JSON.stringify(payload); for (const ws of set) { try { if (ws.readyState === WebSocket.OPEN) ws.send(frame); } catch (_) { /* noop */ } } }
}

// 핵심 3종(done/permission_request/error) 발생 시 알림 영속화(notification 행) + 팬아웃 + (모바일 미접속 시) FCM.
//  (구) maybePush 의 직접 FCM 발송을 대체 — 푸시는 createNotification 내부에서 한 번만(이중 푸시 방지).
//  RUNNER_OFFLINE 은 알림 아님(연결 인디케이터).
const NOTIF_KINDS = new Set(['done', 'permission_request', 'error']);
function maybeNotify(userId, sessionId, event) {
  if (!event || !event.type || !NOTIF_KINDS.has(event.type)) return;
  // 순환 require 회피(notificationService → daemonRelayService) — 호출 시점 lazy require.
  const notificationService = require('./notificationService');
  // 이벤트에서 추출 가능한 본문 텍스트(형태가 다양하므로 best-effort).
  const body = String(event.text || event.message || event.summary || event.error || event.tool || '').slice(0, 2000) || null;
  notificationService.createNotification(Number(userId), {
    source: 'agent',
    kind: event.type,
    title: 'Claude Code',
    sessionId: sessionId || null,
    body,
  }).catch((e) => { console.warn('[daemonRelay] 알림 생성 실패:', e && e.message); });
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

// ── ui_command 중계(데몬↔UI 클라이언트 왕복) ──────────────────────────
// 데몬(cpt CLI)이 control WS 로 보낸 {type:'ui_command'} 를 접속 중인 UI 클라이언트(agent stream WSS 중
// ui_hello 를 보낸 곳)로 중계하고, executor 의 {type:'ui_result'} 를 요청이 온 데몬 conn 으로 회신한다.
//  · executor 선정 = lastActivityAt 최대(동률이면 kind==='pc' 우선) — "사용자가 지금 보고 있는 화면".
//  · broadcast 모드 = 전 클라이언트에 전송하되 executor 1곳만 executor:true(회신도 executor 만).
const UI_CMD_TIMEOUT_DEFAULT_MS = 10 * 1000; // 데몬이 timeoutMs 를 안 주면 10s
const UI_CMD_TIMEOUT_MAX_MS = 60 * 1000;     // 데몬이 줘도 상한 60s
const UI_CMD_RATE_LIMIT = 10;                // 유저당 초당 ui_command 상한
// uiId → { conn(요청 데몬), daemonMsgId, timer, executorWs }  왕복 대기 중인 커맨드.
const uiPending = new Map();
// userId(str) → { windowStart, count }  유저당 1초 창 카운터(간단 rate limit).
const uiCmdRate = new Map();
// 클라이언트 발신 표면 전파(surface_broadcast) 의 uiId 시퀀스.
let surfaceBcastSeq = 0;

// 유저당 초당 UI_CMD_RATE_LIMIT 건 초과 여부(1초 창 카운터).
function allowUiCommand(userId) {
  const now = Date.now();
  let r = uiCmdRate.get(userId);
  if (!r || now - r.windowStart >= 1000) { r = { windowStart: now, count: 0 }; uiCmdRate.set(userId, r); }
  r.count += 1;
  return r.count <= UI_CMD_RATE_LIMIT;
}

// 데몬 ui_command 1건 처리 — 검증→rate limit→executor 선정→전송→pending 등록(타임아웃 포함).
function handleUiCommand(userId, conn, msg) {
  // 회신은 항상 요청이 온 데몬 conn 으로(로컬+클라우드 다중 연결 대비).
  const reply = (ok, extra) => {
    try { conn.ws.send(JSON.stringify({ type: 'ui_result', id: msg.id, ok, ...extra })); } catch (_) { /* noop */ }
  };
  if (msg.id == null || typeof msg.cmd !== 'string' || !msg.cmd) {
    reply(false, { error: '잘못된 ui_command 형식입니다(id/cmd 필요)', code: 'BAD_REQUEST' });
    return;
  }
  if (!allowUiCommand(userId)) {
    reply(false, { error: 'ui_command 가 너무 잦습니다(초당 ' + UI_CMD_RATE_LIMIT + '건 제한)', code: 'RATE_LIMITED' });
    return;
  }
  // 대상 = ui_hello 를 보낸(=_cptMeta 있는) 열린 WSS 클라이언트만.
  const set = agentWsClients.get(String(userId));
  const clients = [];
  if (set) for (const ws of set) { if (ws._cptMeta && ws.readyState === WebSocket.OPEN) clients.push(ws); }
  if (clients.length === 0) {
    reply(false, { error: '연결된 화면(UI 클라이언트)이 없습니다', code: 'NO_UI_CLIENT' });
    return;
  }
  // executor(활성 기기) 선정: foreground(지금 최전면) 우선 → lastActivityAt 최대 → 동률이면 kind==='pc'.
  //  foreground 를 1순위로 두어야 백그라운드 기기가 최근활동만으로 "활성 기기"를 뺏지 않는다.
  clients.sort((a, b) =>
    ((b._cptMeta.foreground ? 1 : 0) - (a._cptMeta.foreground ? 1 : 0)) ||
    (b._cptMeta.lastActivityAt - a._cptMeta.lastActivityAt) ||
    ((b._cptMeta.kind === 'pc' ? 1 : 0) - (a._cptMeta.kind === 'pc' ? 1 : 0)));
  let executor = clients[0];
  // 명시 타겟(mode:'target' + target:{deviceId|clientKey}) — 지정한 기기 1곳으로만 라우팅.
  //  매칭 기기가 접속 중이 아니면 즉시 실패(마법 폴백 금지 — 에이전트가 cpt devices 로 재시도).
  if (msg.target && typeof msg.target === 'object') {
    const t = msg.target;
    const match = clients.find((ws) =>
      (t.deviceId != null && ws._cptMeta.deviceId === t.deviceId) ||
      (t.clientKey && ws._cptMeta.clientKey === t.clientKey));
    if (!match) {
      reply(false, { error: '대상 기기가 접속돼 있지 않습니다', code: 'TARGET_OFFLINE' });
      return;
    }
    executor = match;
  }

  // uiId 는 데몬이 보낸 id(전역 유일 uuid) 재사용 — 회신 매칭 키.
  const uiId = String(msg.id);
  const rawTimeout = Number(msg.timeoutMs);
  const timeoutMs = Math.min(
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : UI_CMD_TIMEOUT_DEFAULT_MS,
    UI_CMD_TIMEOUT_MAX_MS
  );
  const timer = setTimeout(() => {
    uiPending.delete(uiId);
    reply(false, { error: 'UI 클라이언트가 응답하지 않습니다(타임아웃)', code: 'UI_TIMEOUT' });
  }, timeoutMs);
  uiPending.set(uiId, { conn, daemonMsgId: msg.id, timer, executorWs: executor });

  const targets = msg.mode === 'broadcast' ? clients : [executor];
  for (const ws of targets) {
    try {
      ws.send(JSON.stringify({ type: 'ui_command', uiId, cmd: msg.cmd, params: msg.params || {}, executor: ws === executor }));
    } catch (_) { /* noop — 전송 실패는 타임아웃/EXECUTOR_GONE 이 수습 */ }
  }
}

// UI 클라이언트(WSS)가 끊길 때 — 이 ws 가 executor 였던 pending 은 응답이 영영 안 오므로 즉시 실패 회신.
function failPendingForExecutor(ws) {
  for (const [uiId, p] of uiPending) {
    if (p.executorWs !== ws) continue;
    uiPending.delete(uiId);
    clearTimeout(p.timer);
    try {
      p.conn.ws.send(JSON.stringify({ type: 'ui_result', id: p.daemonMsgId, ok: false, error: '실행 화면(UI 클라이언트) 연결이 끊어졌습니다', code: 'UI_EXECUTOR_GONE' }));
    } catch (_) { /* noop */ }
  }
}

// GET /api/daemon/agent/stream?token=<JWT>|?ticket=<t> 업그레이드(앱/PC→back). 에이전트 이벤트 WSS 구독.
//  WebSocket 은 Authorization 헤더를 못 실으므로 access token 을 쿼리로 받아 검증한다.
//  ticket — deviceToken 기기(PC)용 60초 1회용 불투명 티켓(issueUiTicket). JWT 없이 스트림 구독.
//  &client=pc|mobile(기본 mobile) — 구독 기기 종류 태그(FCM 억제 판정용).
function handleAgentStreamUpgrade(token, req, socket, head) {
  const q = new URLSearchParams(String(req.url || '').split('?')[1] || '');
  let userId = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
      userId = decoded && (decoded.id || decoded.userId);
    } catch (_) { userId = null; }
  }
  if (!userId) userId = redeemUiTicket(q.get('ticket') || ''); // JWT 실패/부재 → 티켓 분기
  if (!userId) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  const client = q.get('client') === 'pc' ? 'pc' : 'mobile';
  wss.handleUpgrade(req, socket, head, (ws) => registerAgentWs(ws, String(userId), client));
}

function registerAgentWs(ws, userId, client) {
  let set = agentWsClients.get(userId);
  if (!set) { set = new Set(); agentWsClients.set(userId, set); }
  ws._cptClient = client === 'pc' ? 'pc' : 'mobile'; // 기기 종류 태그(hasActiveMobileClient 판정용)
  set.add(ws);
  // pong 기반 생존 확인 — 앱을 강제 종료/네트워크 단절 시 좀비 WSS 가 남아 hasActiveMobileClient 가
  //  계속 true 로 판정돼 FCM 이 영구 억제되던 버그 수정. 무응답이면 terminate → 'close' → cleanup.
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  const ka = setInterval(() => {
    if (ws._alive === false) { try { ws.terminate(); } catch (_) { /* noop */ } return; }
    ws._alive = false;
    try { if (ws.readyState === WebSocket.OPEN) ws.ping(); } catch (_) { /* noop */ }
  }, PING_INTERVAL_MS);
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
    if (msg.type === 'ui_hello') {
      // ui_command 수신 의사 표명(접속 직후 1회) — 메타가 있어야 중계 대상이 된다.
      //  foreground = 이 기기가 지금 사용자가 보고 있는 화면인지(알림 라우팅용 present 판정).
      //   접속 직후엔 foreground 로 간주(막 열었으니). 이후 presence 프레임으로 갱신.
      ws._cptMeta = {
        clientKey: typeof msg.clientKey === 'string' ? msg.clientKey.slice(0, 128) : '',
        kind: msg.kind === 'pc' ? 'pc' : 'mobile',
        // 이름 있는 기기 타겟팅용 — 계정 기기 레지스트리(DaemonDevice) id/이름. 구 클라는 안 보내므로 null.
        deviceId: Number.isInteger(msg.deviceId) ? msg.deviceId : null,
        deviceName: typeof msg.deviceName === 'string' ? msg.deviceName.slice(0, 128) : '',
        // 이 화면이 처리할 수 있는 신규 기능(§2-(d)). 구 클라는 안 보냄 → [] → 게이팅이 기존 동작으로 폴백.
        caps: normCaps(msg.caps),
        lastActivityAt: Date.now(),
        foreground: true,
        foregroundAt: Date.now(),
      };
      return;
    }
    if (msg.type === 'ui_activity') {
      // 사용자 입력 활동(클라이언트가 30s 스로틀로 전송) — executor 선정 기준 갱신. 입력=포그라운드.
      if (ws._cptMeta) { ws._cptMeta.lastActivityAt = Date.now(); ws._cptMeta.foreground = true; ws._cptMeta.foregroundAt = Date.now(); }
      return;
    }
    if (msg.type === 'presence') {
      // 포그라운드/백그라운드 전환 — 알림을 '지금 보고 있는 기기'로만 보내기 위한 present 신호.
      if (ws._cptMeta) {
        const active = !!msg.active;
        ws._cptMeta.foreground = active;
        if (active) ws._cptMeta.foregroundAt = Date.now();
      }
      return;
    }
    if (msg.type === 'surface_broadcast' && typeof msg.cmd === 'string') {
      // 클라이언트 발신 생명주기 전파 — 한 기기에서 표면(프리뷰/IDE)을 UI 로 닫으면 다른 기기도 같이 닫는다.
      //  (open 은 데몬 ui_command 브로드캐스트로 이미 양쪽에 열리지만, UI × 닫기는 로컬이라 전파 필요.)
      //  보낸 기기는 이미 로컬 처리했으므로 제외하고 나머지 UI 클라이언트에 apply-only(executor=false)로 팬아웃.
      //  루프 방지는 클라이언트가 담당(원격 적용 중엔 재-broadcast 안 함).
      if (!allowUiCommand(userId)) return;
      const others = agentWsClients.get(String(userId));
      if (others) {
        surfaceBcastSeq += 1;
        const uiId = 'sb-' + surfaceBcastSeq;
        for (const other of others) {
          if (other === ws || !other._cptMeta || other.readyState !== WebSocket.OPEN) continue;
          try { other.send(JSON.stringify({ type: 'ui_command', uiId, cmd: msg.cmd, params: msg.params || {}, executor: false })); } catch (_) { /* noop */ }
        }
      }
      return;
    }
    if (msg.type === 'ui_result' && msg.uiId != null) {
      // executor 의 커맨드 실행 결과 — pending 매칭 후 요청 데몬 conn 으로 회신.
      const uiId = String(msg.uiId);
      const pending = uiPending.get(uiId);
      if (!pending || pending.executorWs !== ws) return; // executor 회신만 인정(중복/비 executor 무시)
      uiPending.delete(uiId);
      clearTimeout(pending.timer);
      try {
        pending.conn.ws.send(JSON.stringify({ type: 'ui_result', id: pending.daemonMsgId, ok: !!msg.ok, result: msg.result, error: msg.error }));
      } catch (_) { /* noop */ }
      return;
    }
    // ack 는 MVP 에선 keepalive 로만 취급(버퍼 트리밍은 상한/TTL 로 처리).
  });
  const cleanup = () => {
    clearInterval(ka);
    failPendingForExecutor(ws); // 이 ws 가 executor 인 pending ui_command 즉시 실패 회신
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

// ── UI 스트림 티켓(PC 데스크톱) ───────────────────────────────────────
// deviceToken 기기는 user JWT 가 없어 /agent/stream?token= 을 못 쓴다 → POST /api/daemon/ui/ticket 으로
// 60초 1회용 불투명 티켓을 발급받아 ?ticket= 으로 업그레이드(issueTerminalToken 패턴 미러).
const UI_TICKET_TTL_MS = 60 * 1000;
const uiTickets = new Map(); // ticket → { userId, expiresAt }

function issueUiTicket(userId) {
  const ticket = 'uit-' + crypto.randomBytes(18).toString('hex');
  // 만료 티켓 청소 — 발급마다 훑어 누적 방지(스윕 주기 사이 보강).
  const now = Date.now();
  for (const [t, s] of uiTickets) { if (s.expiresAt < now) uiTickets.delete(t); }
  uiTickets.set(ticket, { userId: String(userId), expiresAt: now + UI_TICKET_TTL_MS });
  return ticket;
}

// 1회용 — 성공/실패 무관 조회 즉시 폐기. 유효하면 userId, 아니면 null.
function redeemUiTicket(ticket) {
  if (!ticket) return null;
  const s = uiTickets.get(ticket);
  if (s) uiTickets.delete(ticket);
  if (!s || s.expiresAt < Date.now()) return null;
  return s.userId;
}

// ── 앱 터미널 ─────────────────────────────────────────────────────────

// POST /api/daemon/terminal/start 에서 호출(인증 후). 데몬 오프라인이면 throw.
function issueTerminalToken(userId, cwd, paneId, win, client, runnerId) {
  // runnerId — 대상 호스트(DaemonDevice.id) 지정. 다른 PC 의 워크스페이스를 열 때 활성 러너를
  //  건드리지 않고 그 호스트로 직결한다(멀티 PC). 같은 userId 의 러너만 조회되므로 월경 불가.
  const rid = Number.isInteger(runnerId) ? runnerId
    : (typeof runnerId === 'string' && /^\d+$/.test(runnerId) ? parseInt(runnerId, 10) : null);
  if (!pickConn(userId, rid != null ? { runnerId: rid } : undefined)) {
    const err = new Error(rid != null ? '대상 PC 데몬이 연결되어 있지 않습니다.' : 'PC 데몬이 연결되어 있지 않습니다.');
    err.statusCode = 409;
    throw err;
  }
  // 토큰 = 스트림별 고유 난수. (구) 사용자당 고정 HMAC 토큰은 여러 pane/기기의 start 가 같은
  //  토큰의 {paneId, client, win} 을 서로 덮어써, 한 기기의 스트림이 다른 기기의 pane 세션에
  //  attach(-d 상호 킥 = "detached" 무한 반복)되는 혼선을 만들었다. 재접속은 각자의 토큰 URL 로
  //  그대로 가능(TTL 은 resolve 시 연장).
  const token = 'dterm-' + crypto.randomBytes(18).toString('hex');
  // 만료 토큰 청소 — 스트림별 토큰이라 방치하면 누적된다.
  const nowTs = Date.now();
  for (const [t, s] of termTokens) { if (s.expiresAt < nowTs) termTokens.delete(t); }
  // cwd(데몬 홈-기준 상대경로) — 진입한 워크스페이스 폴더에서 터미널을 시작. 빈 문자열=홈.
  // paneId — pane 별 독립 tmux 세션 식별(여러 터미널 pane 이 각자 다른 window 를 동시에 보게).
  // win — 이 pane 이 표시할 tmux window(정수). 앱이 미리 확보해 넘기면 데몬이 attach 와 동시에 select.
  // client — 요청 기기의 안정 키. pane 세션을 기기별로 분리(같은 세션 다중 attach 시 tmux 크기 공유 방지).
  const winNum = Number.isInteger(win) ? win : null;
  termTokens.set(token, { userId, cwd: typeof cwd === 'string' ? cwd : '', paneId: typeof paneId === 'string' ? paneId : '', win: winNum, client: typeof client === 'string' ? client : '', runnerId: rid, expiresAt: Date.now() + TERM_TOKEN_TTL_MS });
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
    // 브리지 성립 전(데몬 다이얼백 대기 중) 도착한 앱 메시지 버퍼 — 앱은 open 직후 곧바로 첫
    //  resize 를 보내는데, 리스너가 없으면 통째로 유실된다. 첫 resize 유실 = 창/클라이언트가
    //  80x24 로 남고, 이후 select 리사이즈가 스테일 크기와 핑퐁하며 셸 프롬프트가 누적된다(실측 근원).
    const early = [];
    const earlyFn = (data, isBinary) => { early.push([data, isBinary]); };
    appWs.on('message', earlyFn);
    // 이 터미널을 실제로 여는 대상 러너 conn — 라이브 터미널 카운트로 동면을 막는다.
    //  runnerId 지정(다른 PC 워크스페이스)이면 그 호스트로 직결, 아니면 활성 러너.
    const connOpts = Number.isInteger(sess.runnerId) ? { runnerId: sess.runnerId } : undefined;
    const ptyConn = pickConn(sess.userId, connOpts);
    try {
      // cols/rows 는 앱이 접속 직후 resize 프레임으로 보정하므로 기본값으로 시작. cwd=진입 워크스페이스 폴더.
      daemonWs = await openStream(sess.userId, 'pty', { cols: 80, rows: 24, cwd: sess.cwd || '', paneId: sess.paneId || '', win: Number.isInteger(sess.win) ? sess.win : undefined, client: sess.client || '' }, connOpts);
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
    appWs.off('message', earlyFn);
    bridge(appWs, daemonWs, `pty userId=${sess.userId}`);
    // 버퍼된 메시지(첫 resize 등)를 데몬으로 순서대로 재생.
    for (const [d, b] of early) {
      try { if (daemonWs.readyState === WebSocket.OPEN) daemonWs.send(d, { binary: b }); } catch (_) { /* noop */ }
    }
  });
}

// ── 앱 포트 포워딩 ────────────────────────────────────────────────────
// 원격 기기(폰/타 PC)가 자기 127.0.0.1:<port> 리스너로 받은 TCP 연결 1개당 WS 1개를 열어
// raw 바이트를 파이프(ssh -L 모델). back 은 데몬 dial-back TCP 스트림과 브리지만 한다.
// 터미널 릴레이와 동일 패턴, kind 만 'pty'→'tcp'.
const FWD_TOKEN_TTL_MS = 60 * 60 * 1000; // 포워딩 토큰 1시간(접근 시 갱신)
const fwdTokens = new Map(); // token → { userId, port, runnerId, expiresAt }

// POST /api/daemon/forward/start 에서 호출(인증 후). 대상 러너 오프라인이면 throw.
function issueForwardToken(userId, port, runnerId) {
  const rid = Number.isInteger(runnerId) ? runnerId
    : (typeof runnerId === 'string' && /^\d+$/.test(runnerId) ? parseInt(runnerId, 10) : null);
  if (!pickConn(userId, rid != null ? { runnerId: rid } : undefined)) {
    const err = new Error(rid != null ? '대상 PC 데몬이 연결되어 있지 않습니다.' : 'PC 데몬이 연결되어 있지 않습니다.');
    err.statusCode = 409;
    throw err;
  }
  const token = 'dfwd-' + crypto.randomBytes(18).toString('hex');
  // 만료 토큰 청소 — 발급마다 훑어 누적 방지(터미널과 동일).
  const nowTs = Date.now();
  for (const [t, s] of fwdTokens) { if (s.expiresAt < nowTs) fwdTokens.delete(t); }
  fwdTokens.set(token, { userId, port, runnerId: rid, expiresAt: Date.now() + FWD_TOKEN_TTL_MS });
  return token;
}

// 토큰은 (port,runner)당 재사용 — 동시 TCP 연결 여러 개가 같은 토큰으로 각자 WS 를 연다(삭제 금지).
function resolveForwardToken(token) {
  const sess = fwdTokens.get(token);
  if (!sess || sess.expiresAt < Date.now()) { if (sess) fwdTokens.delete(token); return null; }
  sess.expiresAt = Date.now() + FWD_TOKEN_TTL_MS;
  return sess;
}

// GET /api/daemon/forward/:token 업그레이드(앱→back). TCP 연결 1개 = WS 1개.
function handleForwardUpgrade(token, req, socket, head) {
  const sess = resolveForwardToken(token);
  if (!sess) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  wss.handleUpgrade(req, socket, head, async (appWs) => {
    let daemonWs = null;
    // 브리지 성립 전 도착한 앱 메시지 버퍼 — 클라이언트는 open 직후 첫 HTTP 요청 바이트를 보낸다.
    const early = [];
    const earlyFn = (data, isBinary) => { early.push([data, isBinary]); };
    appWs.on('message', earlyFn);
    try {
      daemonWs = await openStream(sess.userId, 'tcp', { port: sess.port }, sess.runnerId != null ? { runnerId: sess.runnerId } : undefined);
    } catch (_) {
      // raw TCP 바이트 스트림 — 에러 텍스트를 보내면 스트림이 오염되므로 그냥 닫는다.
      try { appWs.close(1011); } catch (_) { /* noop */ }
      return;
    }
    appWs.off('message', earlyFn);
    bridge(appWs, daemonWs, `fwd userId=${sess.userId} port=${sess.port}`);
    // 버퍼된 메시지(첫 요청 바이트)를 데몬으로 순서대로 재생.
    for (const [d, b] of early) {
      try { if (daemonWs.readyState === WebSocket.OPEN) daemonWs.send(d, { binary: b }); } catch (_) { /* noop */ }
    }
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
//  connOpts.runnerId 지정 시 그 호스트로 터널(원격 PC 프리뷰) — 미지정=활성 러너.
async function proxyHttp(userId, port, path, req, res, connOpts) {
  let ws;
  try {
    ws = await openStream(userId, 'tcp', { port }, connOpts);
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
async function proxyWs(userId, port, path, req, socket, head, connOpts) {
  let ws;
  try { ws = await openStream(userId, 'tcp', { port }, connOpts); }
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
  for (const [t, s] of fwdTokens) { if (s.expiresAt < now) fwdTokens.delete(t); }
  for (const [t, s] of uiTickets) { if (s.expiresAt < now) uiTickets.delete(t); }
  for (const [u, r] of uiCmdRate) { if (now - r.windowStart >= 1000) uiCmdRate.delete(u); } // 지난 창 카운터 정리
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
  issueForwardToken,
  handleForwardUpgrade,
  getConnection,
  disconnectDevice,
  setActiveRunner,
  listRunners,
  listCloudRunners,
  fanoutSyncEvent,
  fanoutNotifEvent,
  fanoutAccountDeleted,
  fanoutAppearance,
  hasActiveMobileClient,
  presentClient,
  listUiClients,
  issueUiTicket,
  addEventClient,
  removeEventClient,
  proxyHttp,
  proxyWs,
  pickConn,
  _normCaps: normCaps, // 테스트 노출(순수 함수) — 데몬 리포의 `_states` 컨벤션 미러
};
