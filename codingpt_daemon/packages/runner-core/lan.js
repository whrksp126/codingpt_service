/**
 * lan.js — LAN 직결(임무 F): 호스트 리스너 + 뷰어 클라이언트 + 경로 상태(승격/강등)
 *
 * 왜 이 파일이 있나: 프리뷰·fs·터미널 바이트가 "폰 → back(클라우드) → 데몬"으로 두 번 대양을
 * 건너는 대신, 같은 Wi-Fi 안에서 곧바로 만나게 한다. 릴레이는 **영구 폴백**으로 그대로 남는다
 * (NAT/셀룰러/공용망/외부 접속에 필수) — LAN 은 순수 추가 경로다.
 *
 * ── 절대 불변식(과거 실사고에서 온 것) ────────────────────────────────────
 *  1) 데몬의 "인바운드 포트 0" 불변식을 깨는 유일한 지점이다. 그래서 열되 **좁게** 연다:
 *     · 리스너는 **사설 IP 주소에만 바인드**한다(0.0.0.0 금지 — 공용 IP 를 물고 있는 머신에서
 *       포트 자체가 인터넷에 노출되는 것을 코드로 막는다). 사설 주소가 하나도 없으면 시작조차 안 한다.
 *     · 피어(remoteAddress)와 우리 쪽(localAddress) 모두 사설 대역이어야 한다. 아니면 즉시 파괴.
 *     · UPnP/NAT-PMP 로 포트를 여는 코드는 영구 금지.
 *  2) 인증은 **단명 grant 의 challenge-response** 다 — grant secret 은 와이어에 절대 흐르지 않는다
 *     (§2.3). 서버(back)가 제어 WS 로 미리 통지한 grant 만 유효하고, 단일 사용·TTL·clientKey/피어
 *     바인딩을 모두 검증한다. 실패는 즉시 연결 종료 + IP 단위 레이트 리밋.
 *  3) 실패 코드에 `DAEMON_OFFLINE`/"데몬이 연결" 문구를 **절대** 넣지 않는다. 모바일이 그 정규식으로
 *     호스트 오프라인을 판정하기 때문에(WorkspaceShellContext), 직결 실패가 "PC 꺼짐"으로 오탐되면
 *     차단 오버레이가 뜬다. LAN 전용 코드는 LAN_* 접두사만 쓴다.
 *  4) 터미널(pty) 채널은 pty.js 의 `attachPty` 를 그대로 재사용한다 — tmux 세션/tid 결정,
 *     window-size latest, 첫 resize nudge, early 버퍼는 **한 벌**이다(전송만 다르다). 그리고
 *     스트림 아이덴티티(paneId + clientKey = pkey)를 릴레이와 **동일하게** 쓴다: 경로 전환이
 *     "새 기기가 새로 attach" 로 보이면 같은 세션에 tmux 클라이언트가 2개 붙어 크기 핑퐁이 난다
 *     (12R/17R 사고). pkey 가 같으면 attachPty 가 옛 스트림을 displace 해 항상 1개만 남는다.
 *  5) fs.watch/unwatch 는 LAN scope 에서 제외한다 — fs.js 의 watcher 가 프로세스 전역 1개라서
 *     LAN watch 가 릴레이 watch 를 끈다(IDE 라이브 동기화가 조용히 죽는 최악의 형태).
 *
 * ── 단계 게이팅 ───────────────────────────────────────────────────────────
 *  CPT_LAN=0            → 전면 OFF(리스너·클라이언트·caps 선언까지 사라짐. 한 스위치 원복)
 *  CPT_LAN_SCOPE=       off | tcp(기본) | rpc | all
 *      off  아무것도 안 함
 *      tcp  프리뷰 포워딩(F1)만
 *      rpc  tcp + fs/terminal 관리 RPC(F2)
 *      all  rpc + 터미널 PTY(F3)
 *  CPT_LAN_PORT         고정 포트(미지정 시 lan.json → 47321, 충돌 시 +1×20)
 *  CPT_LAN_BIND         디버그용 명시 바인드 주소(콤마 구분)
 *  CPT_LAN_LINKLOCAL=1  링크로컬(169.254/fe80) 허용(기본 거부)
 *
 * 의존성 0(node 내장 + runtime 만). pty 는 **지연 require** — node-pty 가 깨진 번들에서도
 * 리스너/프리뷰 경로는 살아야 한다.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');

// ── 와이어 상수(cpt-lan/1, 설계 §2.2) ──────────────────────────────────────
// 프레임 = LEN(4,BE = TYPE+CH+PAYLOAD 길이) | TYPE(1) | CH(2,BE) | PAYLOAD
const PROTO = 1;
const T_CTRL = 0x01;  // CH=0, UTF-8 JSON (핸드셰이크·open·rpc)
const T_DATA = 0x02;  // CH=n, raw bytes            (= WS 바이너리 프레임 등가 = stdin/TCP)
const T_TEXT = 0x03;  // CH=n, UTF-8                (= WS 텍스트 프레임 등가 = resize JSON)
const T_CLOSE = 0x04; // CH=n
const T_PING = 0x05;  // CH=0
const T_PONG = 0x06;  // CH=0
const MAX_FRAME = 1024 * 1024;      // LEN 상한. 초과 = 프로토콜 위반 → 즉시 소켓 파괴
const HS_DEADLINE_MS = 3000;        // 핸드셰이크 미완료 데드라인
const PING_MS = 25000;              // keepalive
const IDLE_MS = 90000;              // 무신호 판정
const MAX_CONNS = 64;               // 동시 연결
const MAX_CHANNELS = 256;           // 연결당 채널
const MAX_UNAUTH = 8;               // 미인증 소켓
const AUTH_FAIL_MAX = 3;            // 60s 내 실패 3회 → 그 IP 60s 차단
const AUTH_FAIL_WINDOW_MS = 60000;
const AUTH_BLOCK_MS = 60000;
const ALL_SCOPES = ['tcp', 'rpc', 'pty'];

// LAN RPC 허용 집합 — "지연 이득이 큰 읽기/쓰기"만. 승인·에이전트·동기화·트랜스크립트는 서버가
//  단일 순서 권위를 갖고(이벤트 push 가 제어 WS 에 바인딩돼 있다) 릴레이로 남긴다.
//  fs.watch/unwatch 는 전역 단일 watcher 사고 방지로 **영구 제외**(파일 상단 불변식 5).
const RPC_ALLOW_PREFIX = ['fs.', 'net.', 'terminal.', 'ws.'];
const RPC_DENY = new Set(['fs.watch', 'fs.unwatch', 'sealed']);

function scope() {
  if (String(process.env.CPT_LAN || '') === '0') return 'off';
  const v = String(process.env.CPT_LAN_SCOPE || 'tcp').trim().toLowerCase();
  return ['off', 'tcp', 'rpc', 'all'].includes(v) ? v : 'tcp';
}
function enabled() { return scope() !== 'off'; }
// kind: 'tcp' | 'rpc' | 'pty'
function allows(kind) {
  const s = scope();
  if (s === 'off') return false;
  if (kind === 'tcp') return true;              // tcp/rpc/all 전부
  if (kind === 'rpc') return s === 'rpc' || s === 'all';
  if (kind === 'pty') return s === 'all';
  return false;
}
function scopesForDaemon() { return ALL_SCOPES.filter(allows); }

function rpcAllowed(method) {
  const m = String(method || '');
  if (!m || RPC_DENY.has(m) || m.startsWith('e2ee.')) return false;
  return RPC_ALLOW_PREFIX.some((p) => m.startsWith(p));
}

// ── 주소 분류(사설/링크로컬/루프백) ────────────────────────────────────────
// IPv4-mapped IPv6('::ffff:192.168.0.5')와 scope id('fe80::1%en0')를 정규화한다 — 안 하면
//  피어 검사가 조용히 통과/실패한다(가장 위험한 종류의 버그).
function normalizeAddr(a) {
  let s = String(a || '').trim().toLowerCase();
  if (!s) return '';
  const pct = s.indexOf('%');
  if (pct > 0) s = s.slice(0, pct);
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  return s;
}
function classifyAddr(a) {
  const s = normalizeAddr(a);
  const out = { addr: s, family: s.includes(':') ? 6 : 4, private: false, loopback: false, linkLocal: false };
  if (!s) return out;
  if (out.family === 4) {
    const p = s.split('.').map((x) => parseInt(x, 10));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return out;
    if (p[0] === 127) { out.loopback = true; out.private = true; return out; }
    if (p[0] === 169 && p[1] === 254) { out.linkLocal = true; out.private = true; return out; }
    if (p[0] === 10) { out.private = true; return out; }
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) { out.private = true; return out; }
    if (p[0] === 192 && p[1] === 168) { out.private = true; return out; }
    return out;
  }
  if (s === '::1') { out.loopback = true; out.private = true; return out; }
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) {
    out.linkLocal = true; out.private = true; return out;
  }
  // fc00::/7 (ULA)
  if (s.startsWith('fc') || s.startsWith('fd')) { out.private = true; return out; }
  return out;
}
function allowLinkLocal() { return String(process.env.CPT_LAN_LINKLOCAL || '') === '1'; }
// 연결 양단이 우리 정책을 만족하는가. 실패 이유를 코드로 돌려준다(로그용).
function peerPolicy(remote, local, o = {}) {
  const r = classifyAddr(remote);
  const l = classifyAddr(local);
  if (!r.private) return { ok: false, code: 'PEER_NOT_PRIVATE', remote: r.addr };
  if (r.linkLocal && !(o.allowLinkLocal || allowLinkLocal())) return { ok: false, code: 'PEER_LINK_LOCAL', remote: r.addr };
  if (r.loopback && o.allowLoopback === false) return { ok: false, code: 'PEER_LOOPBACK_DENIED', remote: r.addr };
  if (l.addr && !l.private) return { ok: false, code: 'LOCAL_NOT_PRIVATE', remote: r.addr };
  return { ok: true, remote: r.addr, family: r.family };
}

// 이 머신의 사설 주소 목록 — 리스너 바인드 대상 + back 에 알려줄 endpoint.
//  loopback 은 **보고하지 않는다**(원격 뷰어가 127.0.0.1 로 시도하면 자기 자신에 연결해 반드시
//  실패하고, 그 실패가 쿨다운을 태운다). 링크로컬도 기본 제외.
function localAddrs() {
  const out = [];
  let ifaces = {};
  try { ifaces = os.networkInterfaces() || {}; } catch (_) { return out; }
  for (const [ifname, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (!a || a.internal) continue;
      const c = classifyAddr(a.address);
      if (!c.private || c.loopback) continue;
      if (c.linkLocal && !allowLinkLocal()) continue;
      out.push({ host: c.addr, ifname, family: c.family });
      if (out.length >= 8) return out;
    }
  }
  return out;
}
function addrsKey(list) { return list.map((a) => `${a.host}@${a.ifname}`).sort().join(','); }

// ── grant 저장소(인메모리) ────────────────────────────────────────────────
// back 이 제어 WS 로 미리 통지한 것만 유효하다. 데몬 재시작으로 전부 사라지는 것은 **정상**이며,
//  클라이언트는 LAN_AUTH_FAILED 를 받으면 grant 를 재발급받아 1회 재시도한다(§5.5).
const grants = new Map(); // grantId -> {secret:Buffer, clientKey, kind, scopes[], expiresAt, uses, maxUses, peer}
const MAX_GRANTS = 64;
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;

function secretBuf(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  const s = String(secret || '');
  if (!s) return null;
  const b = Buffer.from(s, 'base64');
  return b.length >= 16 ? b : null;
}

function addGrant(g) {
  const o = g || {};
  const grantId = String(o.grantId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(grantId)) return { ok: false, error: 'BAD_GRANT_ID' };
  const secret = secretBuf(o.secret);
  if (!secret) return { ok: false, error: 'BAD_SECRET' }; // 32B(b64) 기대, 최소 16B
  const clientKey = String(o.clientKey || '').trim();
  if (!clientKey || clientKey.length > 128) return { ok: false, error: 'BAD_CLIENT_KEY' };
  const want = Array.isArray(o.scopes) ? o.scopes.filter((s) => ALL_SCOPES.includes(s)) : ['tcp'];
  if (!want.length) return { ok: false, error: 'BAD_SCOPES' };
  const exp = o.expiresAt ? Date.parse(o.expiresAt) : (Date.now() + 10 * 60 * 1000);
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, error: 'EXPIRED' };
  const expiresAt = Math.min(exp, Date.now() + MAX_GRANT_TTL_MS); // 서버가 긴 TTL 을 줘도 우리가 상한을 건다
  const maxUses = Math.min(32, Math.max(1, Number(o.maxUses) || 1)); // 기본 단일 사용
  if (grants.size >= MAX_GRANTS) sweepGrants();
  if (grants.size >= MAX_GRANTS) {
    // 그래도 가득 = 폭주. 가장 먼저 만료되는 것을 버린다(정상 운용에선 도달하지 않는다).
    let victim = null;
    for (const [k, v] of grants) if (!victim || v.expiresAt < victim[1].expiresAt) victim = [k, v];
    if (victim) grants.delete(victim[0]);
  }
  grants.set(grantId, {
    secret, clientKey, kind: String(o.kind || '') || 'unknown',
    scopes: want, expiresAt, uses: 0, maxUses,
    peer: o.peer ? normalizeAddr(o.peer) : null, // back 이 뷰어 IP 힌트를 주면 바인딩 검증에 쓴다
  });
  return { ok: true, grantId, scopes: want, expiresAt };
}

function sweepGrants(now = Date.now()) {
  let n = 0;
  for (const [k, v] of grants) if (v.expiresAt <= now || v.uses >= v.maxUses) { grants.delete(k); n++; }
  return n;
}
function grantCount() { return grants.size; }
function clearGrants() { grants.clear(); }

// challenge-response — secret 은 어느 방향으로도 와이어에 나가지 않는다.
//  mac  = HMAC-SHA256(secret, "<grantId>|<nonceB64>|<clientKey>")   뷰어 → 호스트
//  smac = HMAC-SHA256(secret, "srv|<grantId>|<nonceB64>|<clientKey>") 호스트 → 뷰어(상호 인증)
//   smac 이 있어야 같은 Wi-Fi 의 공격자가 데몬을 사칭해 뷰어의 파일 쓰기/키 입력을 받아내는
//   시나리오를 막을 수 있다(뷰어의 mac 만 검증하면 사칭 호스트도 통과한다). 구 뷰어는 이 필드를
//   무시하면 되므로 additive.
function macFor(secret, grantId, nonceB64, clientKey) {
  const k = secretBuf(secret);
  if (!k) return '';
  return crypto.createHmac('sha256', k).update(`${grantId}|${nonceB64}|${clientKey}`, 'utf8').digest('base64');
}
function srvMacFor(secret, grantId, nonceB64, clientKey) {
  const k = secretBuf(secret);
  if (!k) return '';
  return crypto.createHmac('sha256', k).update(`srv|${grantId}|${nonceB64}|${clientKey}`, 'utf8').digest('base64');
}
function macEq(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

// ── 프레임 인코딩/디코딩 ──────────────────────────────────────────────────
function encodeFrame(type, ch, payload) {
  const p = payload == null ? Buffer.alloc(0)
    : (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  if (3 + p.length > MAX_FRAME) throw new Error('LAN_FRAME_TOO_LARGE');
  const b = Buffer.allocUnsafe(7 + p.length);
  b.writeUInt32BE(3 + p.length, 0);
  b[4] = type & 0xff;
  b.writeUInt16BE(ch & 0xffff, 5);
  if (p.length) p.copy(b, 7);
  return b;
}
function encodeCtrl(obj) { return encodeFrame(T_CTRL, 0, JSON.stringify(obj)); }

// 스트림 → 프레임. onFrame/onError 가 false 를 돌려주면(또는 위반) 파서가 멈춘다.
function createFramer(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let dead = false;
  return function push(chunk) {
    if (dead) return false;
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (buf.length < 4) return true;
      const len = buf.readUInt32BE(0);
      if (len < 3 || len > MAX_FRAME) { dead = true; onError('LAN_PROTO'); return false; }
      if (buf.length < 4 + len) return true;
      const type = buf[4];
      const ch = buf.readUInt16BE(5);
      const payload = Buffer.from(buf.subarray(7, 4 + len)); // 복사 — 다음 concat 이 뷰를 덮는다
      buf = Buffer.from(buf.subarray(4 + len));
      if (onFrame(type, ch, payload) === false) { dead = true; return false; }
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  호스트(리스너) 측
// ══════════════════════════════════════════════════════════════════════════
let servers = [];          // net.Server[] — 사설 주소당 1개(0.0.0.0 금지)
let boundPort = 0;
let boundHosts = [];
let srvHooks = {};         // { rpc(method,params)->Promise, onLanChange(info) }
let srvOpts = {};          // { bindHosts, allowLoopback, allowLinkLocal }
let selfInfo = {};         // { deviceId, machineId, daemonVersion }
const liveConns = new Set();
let ifTimer = null;
let sweepTimer = null;
let lastKey = '';
const authFails = new Map(); // ip -> { n, first, until }

function lanStateFile() { return path.join(runtime.stateDir(), 'lan.json'); }
function loadLanState() {
  try { return JSON.parse(fs.readFileSync(lanStateFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function saveLanState(state) {
  try {
    fs.mkdirSync(runtime.stateDir(), { recursive: true });
    fs.writeFileSync(lanStateFile(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(lanStateFile(), 0o600); } catch (_) { /* 덮어쓰기 시 mode 무시 플랫폼 */ }
  } catch (_) { /* 상태 파일 실패는 무해 — 다음 기동에 포트만 바뀐다 */ }
}
// 재시작 시 같은 포트로 복구(리스너 복구 요건) — 명시 env > lan.json > 기본.
//  CPT_LAN_PORT=0 이면 **OS 할당**(에페메랄). 기본을 고정 포트로 두는 이유: 데몬이 재시작해도 같은
//  좌표로 돌아와야 뷰어의 캐시/재시도가 헛돌지 않는다(back 보고는 어느 쪽이든 실제 포트로 한다).
function preferredPort() {
  if (String(process.env.CPT_LAN_PORT || '').trim() === '0') return 0;
  const envP = Number(process.env.CPT_LAN_PORT);
  if (Number.isInteger(envP) && envP >= 1024 && envP <= 65535) return envP;
  const st = loadLanState();
  const p = Number(st && st.port);
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) return p;
  return 47321;
}

function blockedIp(ip, now = Date.now()) {
  const e = authFails.get(ip);
  return !!(e && e.until && e.until > now);
}
function noteAuthFail(ip, now = Date.now()) {
  let e = authFails.get(ip);
  if (!e || now - e.first > AUTH_FAIL_WINDOW_MS) e = { n: 0, first: now, until: 0 };
  e.n += 1;
  if (e.n >= AUTH_FAIL_MAX) { e.until = now + AUTH_BLOCK_MS; e.n = 0; e.first = now; }
  authFails.set(ip, e);
  return e;
}
function sweepAuthFails(now = Date.now()) {
  for (const [ip, e] of authFails) {
    if ((!e.until || e.until <= now) && now - e.first > AUTH_FAIL_WINDOW_MS) authFails.delete(ip);
  }
}
// 테스트 전용 — 레이트리밋 상태 초기화(고의 실패를 낸 케이스가 뒤 케이스를 오염시키지 않게).
function __resetLimits() { authFails.clear(); unauthCount = 0; }

function bindTargets() {
  if (Array.isArray(srvOpts.bindHosts) && srvOpts.bindHosts.length) return srvOpts.bindHosts.slice(0, 8);
  const env = String(process.env.CPT_LAN_BIND || '').trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const hosts = localAddrs().map((a) => a.host);
  // 루프백도 함께 — 이 머신의 PC 앱이 자기 데몬으로 직결하는 경로(cptsock 선례)와 테스트용.
  //  원격 뷰어에게 보고하지는 않는다(localAddrs 주석 참조).
  if (srvOpts.allowLoopback !== false) hosts.push('127.0.0.1');
  return hosts;
}

function listenOne(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    let settled = false;
    s.on('error', (e) => {
      if (settled) { console.warn(`[lan] 리스너 오류(${host}:${port}): ${e.message}`); try { s.close(); } catch (_) { /* noop */ } return; }
      settled = true;
      reject(e);
    });
    s.on('connection', (sock) => onConnection(sock));
    s.listen({ host, port, ipv6Only: false }, () => {
      settled = true;
      resolve(s);
    });
  });
}

// 리스너 기동. 포트는 OS 가 아니라 우리가 고정 후보를 시도한다(+1×20) — back 에 보고한 포트와
//  실제가 어긋나면 안 되므로 **첫 바인드로 확정한 포트**를 나머지 주소에 강제한다.
async function bindAll() {
  const hosts = bindTargets();
  if (!hosts.length) return { ok: false, code: 'LAN_NO_PRIVATE_ADDR' };
  const base = preferredPort();
  let port = 0;
  let first = null;
  let lastErr = null;
  // base=0 = OS 할당(1회 시도로 끝). 그 외는 고정 후보에서 +1 씩 20회 탐색.
  const tries = base === 0 ? 1 : 20;
  for (let i = 0; i < tries && !first; i++) {
    const p = base === 0 ? 0 : (base + i > 65535 ? 1024 + ((base + i) % 1000) : base + i);
    try { first = await listenOne(hosts[0], p); port = p; } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) continue;
      break;
    }
  }
  if (!first) return { ok: false, code: (lastErr && lastErr.code) || 'LISTEN_ERROR' };
  // OS 할당이면 실제 포트를 확정한 뒤 나머지 주소에 **같은 포트**를 강제한다 — back 에 보고한 포트와
  //  실제가 어긋나면 뷰어가 영원히 붙지 못한다.
  if (!port) { try { port = first.address().port; } catch (_) { port = 0; } }
  if (!port) { try { first.close(); } catch (_) { /* noop */ } return { ok: false, code: 'LISTEN_ERROR' }; }
  servers = [first];
  boundHosts = [hosts[0]];
  boundPort = port;
  for (const h of hosts.slice(1)) {
    try { servers.push(await listenOne(h, port)); boundHosts.push(h); } catch (e) {
      // 개별 주소 실패는 치명적이지 않다(인터페이스가 방금 사라졌을 수 있다).
      console.warn(`[lan] ${h}:${port} 바인드 건너뜀: ${(e && e.code) || e.message}`);
    }
  }
  saveLanState({ port: boundPort, lastAddrs: localAddrs(), at: new Date().toISOString() });
  return { ok: true, port: boundPort, hosts: boundHosts };
}

function closeServers() {
  for (const s of servers) { try { s.close(); } catch (_) { /* noop */ } }
  servers = [];
  boundHosts = [];
}

/**
 * 리스너 기동. **반드시 killStrayDaemons/takeoverExisting 이후에** 부를 것(§5.5) — 구 인스턴스가
 * 포트를 쥔 채면 +1 포트로 도망가 back 에 보고한 포트가 실제와 어긋난다.
 *   hooks.rpc(method, params) -> Promise<result>   (control.dispatchRpc 주입 — 순환 require 회피)
 *   hooks.onLanChange(info)                        (인터페이스 변경 → back 에 lan_update)
 */
async function start(config, hooks = {}, o = {}) {
  if (!enabled()) return { ok: false, code: 'LAN_DISABLED' };
  if (servers.length) return { ok: true, port: boundPort, hosts: boundHosts, reused: true };
  srvHooks = hooks || {};
  srvOpts = o || {};
  const cfg = config || {};
  selfInfo = {
    deviceId: cfg.deviceId || null,
    machineId: cfg.machineId || null,
    daemonVersion: cfg.daemonVersion || 'unknown',
  };
  const r = await bindAll();
  if (!r.ok) {
    // 사설 주소가 없다(셀룰러 테더링/공용 IP 단독) = 정상 상태. 릴레이로 돈다.
    console.log(`[lan] 리스너 미기동 (${r.code}) — 릴레이 경로만 사용`);
    return r;
  }
  console.log(`[lan] LAN 직결 대기 ${boundHosts.join(', ')}:${boundPort} (scope=${scope()})`);
  lastKey = addrsKey(localAddrs());
  if (!ifTimer) {
    ifTimer = setInterval(() => {
      const cur = localAddrs();
      const k = addrsKey(cur);
      if (k === lastKey) return;
      lastKey = k;
      console.log(`[lan] 인터페이스 변경 — 재바인딩 (${k || '사설 주소 없음'})`);
      // 기존 accept 된 연결은 유지된다(server.close 는 새 accept 만 막는다).
      closeServers();
      bindAll().then((rr) => {
        if (rr.ok) saveLanState({ port: boundPort, lastAddrs: cur, at: new Date().toISOString() });
        try { if (typeof srvHooks.onLanChange === 'function') srvHooks.onLanChange(info()); } catch (_) { /* noop */ }
      }).catch(() => { /* 다음 주기 */ });
    }, 30000);
    if (ifTimer.unref) ifTimer.unref();
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { sweepGrants(); sweepAuthFails(); }, 60000);
    if (sweepTimer.unref) sweepTimer.unref();
  }
  return r;
}

function stop() {
  closeServers();
  for (const c of liveConns) { try { c.destroy(); } catch (_) { /* noop */ } }
  liveConns.clear();
  if (ifTimer) { clearInterval(ifTimer); ifTimer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  boundPort = 0;
  return { ok: true };
}

// hello 에 실어 back 에 알리는 좌표. 리스너가 없으면 null(구 데몬과 동일 취급 = LAN_UNSUPPORTED).
function info() {
  if (!servers.length || !boundPort) return null;
  const addrs = localAddrs();
  if (!addrs.length) return null; // 사설 주소 없음 = 알려줄 endpoint 가 없다
  return { proto: PROTO, port: boundPort, addrs, scopes: scopesForDaemon() };
}

let unauthCount = 0;

function onConnection(sock) {
  const remote = sock.remoteAddress;
  const pol = peerPolicy(remote, sock.localAddress, srvOpts);
  if (!pol.ok) {
    console.warn(`[lan] 연결 거부(${pol.code}) peer=${pol.remote || remote}`);
    try { sock.destroy(); } catch (_) { /* noop */ }
    return;
  }
  const ip = pol.remote;
  if (blockedIp(ip)) { try { sock.destroy(); } catch (_) { /* noop */ } return; }
  if (liveConns.size >= MAX_CONNS || unauthCount >= MAX_UNAUTH) {
    console.warn(`[lan] 연결 상한 초과 — 거부 peer=${ip}`);
    try { sock.write(encodeCtrl({ t: 'err', code: 'BUSY' })); } catch (_) { /* noop */ }
    try { sock.destroy(); } catch (_) { /* noop */ }
    return;
  }
  sock.setNoDelay(true);
  liveConns.add(sock);
  unauthCount += 1;
  let authed = false;
  let grantId = '';
  let g = null;
  let nonceB64 = '';
  let clientKey = '';
  let phase = 'hello';
  const channels = new Map(); // ch -> { kind, close(), write(buf) }
  let lastSeen = Date.now();

  const send = (buf) => { try { if (!sock.destroyed) sock.write(buf); } catch (_) { /* noop */ } };
  const sendCtrl = (obj) => send(encodeCtrl(obj));
  // 인증 실패. count=false 면 IP 레이트리밋에 **세지 않는다**.
  //  왜 구분하나: 레이트리밋의 목적은 스캐너/브루트포스 차단이다. "이미 쓴 grant"·"만료된 grant"는
  //  24-hex grantId 를 아는 쪽만 낼 수 있는 실패, 즉 **우리 클라이언트가 레이스로 낸 실패**다.
  //  그걸 세면 사용자의 폰이 새 grant 를 받아 재시도하려는 60초를 우리가 막아버린다(자가 DoS).
  const fail = (code, reason, count = true) => {
    console.warn(`[lan] 인증 실패(${code}) peer=${ip}${reason ? ' ' + reason : ''}`);
    if (count) noteAuthFail(ip);
    sendCtrl({ t: 'err', code });
    setTimeout(() => { try { sock.destroy(); } catch (_) { /* noop */ } }, 20); // err flush 여유
  };
  const hsTimer = setTimeout(() => {
    if (!authed) { console.warn(`[lan] 핸드셰이크 데드라인 초과 — 파괴 peer=${ip}`); try { sock.destroy(); } catch (_) { /* noop */ } }
  }, HS_DEADLINE_MS);
  if (hsTimer.unref) hsTimer.unref();
  const pingTimer = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_MS) { try { sock.destroy(); } catch (_) { /* noop */ } return; }
    const p = Buffer.allocUnsafe(8);
    p.writeBigUInt64BE(BigInt(Date.now()));
    send(encodeFrame(T_PING, 0, p));
  }, PING_MS);
  if (pingTimer.unref) pingTimer.unref();

  const closeChannel = (ch, reason) => {
    const c = channels.get(ch);
    if (!c) return;
    channels.delete(ch);
    try { c.close(reason); } catch (_) { /* noop */ }
  };

  const onFrame = (type, ch, payload) => {
    lastSeen = Date.now();
    if (type === T_PING) { send(encodeFrame(T_PONG, 0, payload)); return true; }
    if (type === T_PONG) return true;
    if (!authed) {
      // 핸드셰이크는 CTRL/CH0 만. 그 외 프레임은 프로토콜 위반.
      if (type !== T_CTRL || ch !== 0) { try { sock.destroy(); } catch (_) { /* noop */ } return false; }
      let m = null;
      try { m = JSON.parse(payload.toString('utf8')); } catch (_) { try { sock.destroy(); } catch (_) { /* noop */ } return false; }
      if (phase === 'hello') {
        if (!m || m.t !== 'hello' || Number(m.v) !== PROTO) { fail('BAD_GRANT', 'hello 형식'); return false; }
        grantId = String(m.grantId || '').trim();
        clientKey = String(m.client || '').trim();
        g = grants.get(grantId) || null;
        if (!g) { fail('BAD_GRANT', `미등록 grant(${grantId.slice(0, 10)})`); return false; }
        if (g.expiresAt <= Date.now()) { grants.delete(grantId); fail('EXPIRED', '', false); return false; }
        if (g.uses >= g.maxUses) { grants.delete(grantId); fail('BAD_GRANT', '재사용', false); return false; }
        if (g.clientKey !== clientKey) { fail('BAD_GRANT', 'clientKey 불일치'); return false; }
        if (g.peer && g.peer !== ip) { fail('PEER_MISMATCH', `${ip}≠${g.peer}`); return false; }
        nonceB64 = crypto.randomBytes(16).toString('base64');
        phase = 'auth';
        sendCtrl({
          t: 'chal', nonce: nonceB64,
          deviceId: selfInfo.deviceId, machineId: selfInfo.machineId,
          daemonVersion: selfInfo.daemonVersion,
          caps: ALL_SCOPES.filter((s) => allows(s) && g.scopes.includes(s)),
        });
        return true;
      }
      if (phase === 'auth') {
        if (!m || m.t !== 'auth') { fail('BAD_GRANT', 'auth 형식'); return false; }
        const want = macFor(g.secret, grantId, nonceB64, clientKey);
        if (!macEq(m.mac, want)) { fail('LAN_AUTH_FAILED', 'mac 불일치'); return false; }
        // 인증 성공 시점에만 사용 횟수를 소모한다 — 잘못된 mac 이 사용자의 grant 를 태우면
        //  공격자가 정상 사용자의 직결을 DoS 할 수 있다.
        g.uses += 1;
        if (g.uses >= g.maxUses) grants.delete(grantId);
        authed = true;
        phase = 'ok';
        unauthCount = Math.max(0, unauthCount - 1);
        clearTimeout(hsTimer);
        const scopes = ALL_SCOPES.filter((s) => allows(s) && g.scopes.includes(s));
        sendCtrl({
          t: 'ok', expiresAt: new Date(g.expiresAt).toISOString(), scopes,
          smac: srvMacFor(g.secret, grantId, nonceB64, clientKey), // 상호 인증(사칭 호스트 차단)
        });
        console.log(`[lan] 직결 인증 성공 peer=${ip} client=${clientKey} scopes=${scopes.join(',')}`);
        return true;
      }
      try { sock.destroy(); } catch (_) { /* noop */ }
      return false;
    }
    // ── 인증 후 ──
    if (type === T_CTRL) {
      if (ch !== 0) return true; // CH=0 만 제어
      let m = null;
      try { m = JSON.parse(payload.toString('utf8')); } catch (_) { return true; }
      if (!m || typeof m.t !== 'string') return true;
      if (m.t === 'open') { handleOpen(m); return true; }
      if (m.t === 'rpc') { handleRpc(m); return true; }
      if (m.t === 'close') { closeChannel(Number(m.ch) || 0, 'peer'); return true; }
      return true;
    }
    if (type === T_DATA || type === T_TEXT) {
      const c = channels.get(ch);
      if (!c) return true; // 이미 닫힌 채널로 온 잔여 바이트 — 조용히 버린다
      try { c.write(payload, type === T_TEXT); } catch (_) { /* noop */ }
      return true;
    }
    if (type === T_CLOSE) { closeChannel(ch, 'peer'); return true; }
    return true;
  };

  function scopeOk(kind) { return allows(kind) && g && g.scopes.includes(kind); }

  function handleOpen(m) {
    const ch = Number(m.ch) || 0;
    const kind = String(m.kind || '');
    const params = m.params || {};
    if (ch < 1 || ch > 65535) { sendCtrl({ t: 'openfail', ch, code: 'LAN_PROTO' }); return; }
    if (channels.has(ch)) { sendCtrl({ t: 'openfail', ch, code: 'LAN_CH_BUSY' }); return; }
    if (channels.size >= MAX_CHANNELS) { sendCtrl({ t: 'openfail', ch, code: 'BUSY' }); return; }
    if (!scopeOk(kind)) { sendCtrl({ t: 'openfail', ch, code: 'LAN_SCOPE' }); return; }
    if (kind === 'tcp') { openTcpChannel(ch, params); return; }
    if (kind === 'pty') { openPtyChannel(ch, params); return; }
    sendCtrl({ t: 'openfail', ch, code: 'LAN_KIND' });
  }

  // 프리뷰 포워딩(F1) — loopback 고정(proxy.js:120 의 SSRF 금지 원칙 승계. 임의 호스트 금지).
  function openTcpChannel(ch, params) {
    const port = Number(params && params.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) { sendCtrl({ t: 'openfail', ch, code: 'LAN_PORT' }); return; }
    let closed = false;
    const up = net.connect({ host: '127.0.0.1', port });
    up.setNoDelay(true);
    const entry = {
      kind: 'tcp',
      write(buf) { if (!closed) up.write(buf); },
      close() { closed = true; try { up.destroy(); } catch (_) { /* noop */ } },
    };
    up.on('connect', () => { channels.set(ch, entry); sendCtrl({ t: 'opened', ch }); });
    up.on('data', (buf) => {
      if (sock.destroyed) return;
      const ok = sock.write(encodeFrame(T_DATA, ch, buf));
      if (!ok) { up.pause(); sock.once('drain', () => { try { up.resume(); } catch (_) { /* noop */ } }); }
    });
    up.on('error', (e) => {
      if (channels.get(ch) === entry) { channels.delete(ch); send(encodeFrame(T_CLOSE, ch, JSON.stringify({ reason: e.code || 'error' }))); return; }
      sendCtrl({ t: 'openfail', ch, code: e.code || 'ECONNREFUSED' });
    });
    up.on('close', () => {
      if (channels.get(ch) === entry) { channels.delete(ch); send(encodeFrame(T_CLOSE, ch, '')); }
    });
  }

  // 터미널 PTY(F3) — pty.js 의 attachPty 를 그대로 재사용한다. io 어댑터만 다르다.
  //  · params 는 릴레이(daemonRelayService → openPtyStream)가 넘기는 키와 **완전 동일**해야 한다
  //    (paneId/client 가 pkey 재료 = 스트림 아이덴티티 승계의 전부 — 파일 상단 불변식 4).
  //  · early 버퍼: onMessage 등록 전에 도착한 프레임을 여기서 큐에 담아 순서대로 재생한다
  //    (첫 resize 유실 = 80x24 고착 재발 방지. 릴레이의 back early 버퍼가 없는 경로라 필수).
  function openPtyChannel(ch, params) {
    let ptyLib = null;
    try { ptyLib = require('./pty'); } catch (e) { sendCtrl({ t: 'openfail', ch, code: 'LAN_PTY_UNAVAILABLE' }); return; }
    if (!ptyLib || typeof ptyLib.attachPty !== 'function') { sendCtrl({ t: 'openfail', ch, code: 'LAN_PTY_UNAVAILABLE' }); return; }
    let closed = false;
    let cb = null;
    const inQ = [];
    let onCloseCb = null;
    const io = {
      transport: 'lan',
      send(chunk) {
        if (closed || sock.destroyed) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        // pty 출력은 흘려보낸다(백프레셔로 pty 를 멈추지 않는다 — 릴레이 경로와 동일 시맨틱).
        sock.write(encodeFrame(T_DATA, ch, buf));
      },
      onMessage(fn) { cb = fn; for (const [k, p] of inQ.splice(0)) fn(k, p); },
      onClose(fn) { onCloseCb = fn; if (closed) fn(); },
      close() {
        if (closed) return;
        closed = true;
        if (channels.get(ch) === entry) channels.delete(ch);
        send(encodeFrame(T_CLOSE, ch, ''));
        if (onCloseCb) { const f = onCloseCb; onCloseCb = null; f(); }
      },
    };
    const entry = {
      kind: 'pty',
      write(buf, isText) {
        if (isText) { const s = buf.toString('utf8'); if (cb) cb('text', s); else inQ.push(['text', s]); return; }
        if (cb) cb('stdin', buf); else inQ.push(['stdin', buf]);
      },
      close() {
        if (closed) return;
        closed = true;
        if (onCloseCb) { const f = onCloseCb; onCloseCb = null; f(); }
      },
    };
    channels.set(ch, entry);
    sendCtrl({ t: 'opened', ch });
    Promise.resolve()
      .then(() => ptyLib.attachPty(params, io))
      .catch((e) => {
        console.warn(`[lan] pty 채널 실패: ${(e && e.message) || e}`);
        try { io.close(); } catch (_) { /* noop */ }
      });
  }

  function handleRpc(m) {
    const id = m.id;
    const method = String(m.method || '');
    const reply = (obj) => sendCtrl({ t: 'rpc_result', id, ...obj });
    if (!scopeOk('rpc')) { reply({ ok: false, error: '직결 RPC 가 이 데몬에서 꺼져 있습니다', code: 'LAN_SCOPE' }); return; }
    if (!rpcAllowed(method)) { reply({ ok: false, error: `직결로는 지원하지 않는 요청입니다(${method})`, code: 'LAN_METHOD_NOT_ALLOWED' }); return; }
    if (typeof srvHooks.rpc !== 'function') { reply({ ok: false, error: '직결 RPC 배선이 없습니다', code: 'LAN_RPC_UNAVAILABLE' }); return; }
    Promise.resolve()
      .then(() => srvHooks.rpc(method, m.params))
      .then((result) => reply({ ok: true, result: result === undefined ? null : result }))
      // 오류 문구는 그대로 전달한다(클라가 릴레이와 동일하게 처리) — 단 LAN 계층이 문구를
      //  덧붙이지 않는다: "데몬이 연결" 류 문구가 섞이면 호스트 오프라인 오탐이 난다(불변식 3).
      .catch((e) => reply({ ok: false, error: (e && e.message) || String(e), code: (e && e.code) || undefined }));
  }

  const framer = createFramer(onFrame, (code) => {
    console.warn(`[lan] 프로토콜 위반(${code}) — 소켓 파괴 peer=${ip}`);
    try { sock.destroy(); } catch (_) { /* noop */ }
  });
  sock.on('data', (chunk) => framer(chunk));
  const cleanup = () => {
    clearTimeout(hsTimer);
    clearInterval(pingTimer);
    if (!authed) unauthCount = Math.max(0, unauthCount - 1);
    liveConns.delete(sock);
    for (const ch of [...channels.keys()]) closeChannel(ch, 'socket');
  };
  sock.on('close', cleanup);
  sock.on('error', cleanup);
}

// ══════════════════════════════════════════════════════════════════════════
//  뷰어(클라이언트) 측 — 데몬이 "보는 기기"일 때(PC 앱이 cpt.sock 으로 위임)
// ══════════════════════════════════════════════════════════════════════════
/**
 * connect({host, port, grantId, secret, clientKey, kind, timeoutMs}) -> Promise<session>
 *  session = { rttMs, scopes, deviceId, machineId, caps,
 *              openTcp(port), openPty(params), rpc(method, params, timeoutMs), ping(),
 *              close(), onClose(cb), alive }
 * 실패는 전부 code 가 붙은 Error(LAN_TIMEOUT / LAN_UNREACHABLE / LAN_AUTH_FAILED / LAN_PROTO …).
 */
function connect(o = {}) {
  const host = String(o.host || '').trim();
  const port = Number(o.port);
  const grantId = String(o.grantId || '').trim();
  const clientKey = String(o.clientKey || '').trim();
  const kind = String(o.kind || 'pc');
  const timeoutMs = Number(o.timeoutMs) || 4000;
  const secret = secretBuf(o.secret);
  return new Promise((resolve, reject) => {
    if (!host || !Number.isInteger(port) || !grantId || !clientKey || !secret) {
      reject(codedErr('LAN_BAD_ARGS', '직결 인자가 부족합니다')); return;
    }
    const pol = classifyAddr(host);
    if (!pol.private) { reject(codedErr('LAN_NOT_PRIVATE', '사설 주소가 아닙니다')); return; } // 공용망 시도 금지
    const t0 = Date.now();
    let settled = false;
    let authed = false;
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const chans = new Map();   // ch -> channel
    const pending = new Map(); // rpc id -> {resolve, reject, timer}
    const opens = new Map();   // ch -> {resolve, reject}
    const pingWaiters = [];    // ping() 대기자(FIFO)
    let nextCh = 1;
    let nextId = 1;
    let closeCb = null;
    let lastSeen = Date.now();
    const session = {
      rttMs: 0, scopes: [], caps: [], deviceId: null, machineId: null, alive: true, host, port,
    };

    const timer = setTimeout(() => finish(codedErr('LAN_TIMEOUT', '직결 응답이 없습니다')), timeoutMs);
    const pingTimer = setInterval(() => {
      if (Date.now() - lastSeen > IDLE_MS) { destroy('LAN_TIMEOUT'); return; }
      const p = Buffer.allocUnsafe(8); p.writeBigUInt64BE(BigInt(Date.now()));
      try { sock.write(encodeFrame(T_PING, 0, p)); } catch (_) { /* noop */ }
    }, PING_MS);
    if (pingTimer.unref) pingTimer.unref();

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { destroy(err.code || 'LAN_UNREACHABLE'); reject(err); return; }
      resolve(session);
    }
    function destroy(code) {
      session.alive = false;
      clearInterval(pingTimer);
      clearTimeout(timer);
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(codedErr(code || 'LAN_CLOSED', '직결이 끊겼습니다')); }
      pending.clear();
      for (const [, op] of opens) op.reject(codedErr(code || 'LAN_CLOSED', '직결이 끊겼습니다'));
      opens.clear();
      while (pingWaiters.length) pingWaiters.shift()(); // 대기 중 ping 은 해제(타이머는 자체 정리)
      for (const c of chans.values()) { try { if (c.onClose) c.onClose('session'); } catch (_) { /* noop */ } }
      chans.clear();
      try { sock.destroy(); } catch (_) { /* noop */ }
      if (closeCb) { const f = closeCb; closeCb = null; try { f(code); } catch (_) { /* noop */ } }
    }

    const send = (buf) => { try { if (!sock.destroyed) sock.write(buf); } catch (_) { /* noop */ } };
    const sendCtrl = (obj) => send(encodeCtrl(obj));

    sock.on('connect', () => {
      sendCtrl({ t: 'hello', v: PROTO, grantId, client: clientKey, kind });
    });

    const onFrame = (type, ch, payload) => {
      lastSeen = Date.now();
      if (type === T_PING) { send(encodeFrame(T_PONG, 0, payload)); return true; }
      if (type === T_PONG) { const w = pingWaiters.shift(); if (w) w(); return true; }
      if (type === T_CTRL) {
        let m = null;
        try { m = JSON.parse(payload.toString('utf8')); } catch (_) { return true; }
        if (!m || typeof m.t !== 'string') return true;
        if (m.t === 'chal') {
          session.deviceId = m.deviceId != null ? m.deviceId : null;
          session.machineId = m.machineId || null;
          session.caps = Array.isArray(m.caps) ? m.caps : [];
          session.daemonVersion = m.daemonVersion || null;
          sendCtrl({ t: 'auth', mac: macFor(secret, grantId, String(m.nonce || ''), clientKey) });
          session._nonce = String(m.nonce || '');
          return true;
        }
        if (m.t === 'ok') {
          // 상호 인증 — smac 이 오면 반드시 검증한다(사칭 호스트에게 파일/키입력을 넘기지 않는다).
          if (m.smac && !macEq(m.smac, srvMacFor(secret, grantId, session._nonce || '', clientKey))) {
            finish(codedErr('LAN_AUTH_FAILED', '상대 확인 실패')); return false;
          }
          authed = true;
          session.scopes = Array.isArray(m.scopes) ? m.scopes : [];
          session.rttMs = Date.now() - t0;
          finish(null);
          return true;
        }
        if (m.t === 'err') {
          const code = String(m.code || 'LAN_AUTH_FAILED');
          finish(codedErr(code === 'BUSY' ? 'LAN_BUSY' : (code === 'BAD_GRANT' || code === 'EXPIRED' ? 'LAN_AUTH_FAILED' : code), '직결이 거부되었습니다'));
          return false;
        }
        if (m.t === 'opened') { const op = opens.get(Number(m.ch)); if (op) { opens.delete(Number(m.ch)); op.resolve(); } return true; }
        if (m.t === 'openfail') {
          const c = Number(m.ch); const op = opens.get(c);
          chans.delete(c);
          if (op) { opens.delete(c); op.reject(codedErr(String(m.code || 'LAN_OPEN_FAILED'), '직결 채널을 열 수 없습니다')); }
          return true;
        }
        if (m.t === 'rpc_result') {
          const p = pending.get(m.id);
          if (!p) return true;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.result);
          else { const e = codedErr(m.code || 'LAN_RPC_FAILED', m.error || '직결 요청 실패'); p.reject(e); }
          return true;
        }
        return true;
      }
      if (type === T_DATA || type === T_TEXT) {
        const c = chans.get(ch);
        if (c && c.onData) { try { c.onData(payload, type === T_TEXT); } catch (_) { /* noop */ } }
        return true;
      }
      if (type === T_CLOSE) {
        const c = chans.get(ch);
        chans.delete(ch);
        const op = opens.get(ch);
        if (op) { opens.delete(ch); op.reject(codedErr('LAN_CLOSED', '채널이 닫혔습니다')); }
        if (c && c.onClose) { try { c.onClose('peer'); } catch (_) { /* noop */ } }
        return true;
      }
      return true;
    };
    const framer = createFramer(onFrame, () => finish(codedErr('LAN_PROTO', '프레임 규약 위반')));
    sock.on('data', (chunk) => framer(chunk));
    sock.on('error', (e) => {
      if (!settled) { finish(codedErr('LAN_UNREACHABLE', (e && e.code) || e.message)); return; }
      destroy('LAN_UNREACHABLE');
    });
    sock.on('close', () => {
      if (!settled) { finish(codedErr(authed ? 'LAN_CLOSED' : 'LAN_UNREACHABLE', '직결이 닫혔습니다')); return; }
      destroy('LAN_CLOSED');
    });

    // ── 세션 API ──
    function openChannel(kindName, params) {
      return new Promise((res, rej) => {
        if (!session.alive) { rej(codedErr('LAN_CLOSED', '직결이 끊겼습니다')); return; }
        if (nextCh > 65535) { rej(codedErr('LAN_CH_EXHAUSTED', '채널 번호 고갈')); return; }
        const ch = nextCh++;
        const channel = {
          ch, onData: null, onClose: null,
          write(buf) { send(encodeFrame(T_DATA, ch, buf)); },
          sendText(s) { send(encodeFrame(T_TEXT, ch, s)); },
          close() { if (chans.delete(ch)) send(encodeFrame(T_CLOSE, ch, '')); },
        };
        chans.set(ch, channel);
        const to = setTimeout(() => {
          if (opens.delete(ch)) { chans.delete(ch); rej(codedErr('LAN_TIMEOUT', '채널 오픈 시간 초과')); }
        }, 4000);
        if (to.unref) to.unref();
        opens.set(ch, {
          resolve: () => { clearTimeout(to); res(channel); },
          reject: (e) => { clearTimeout(to); rej(e); },
        });
        sendCtrl({ t: 'open', ch, kind: kindName, params: params || {} });
      });
    }
    session.openTcp = (p) => openChannel('tcp', { port: Number(p) });
    session.openPty = (params) => openChannel('pty', params || {});
    session.rpc = (method, params, ms = 15000) => new Promise((res, rej) => {
      if (!session.alive) { rej(codedErr('LAN_CLOSED', '직결이 끊겼습니다')); return; }
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); rej(codedErr('LAN_TIMEOUT', '직결 요청 시간 초과')); }, ms);
      if (t.unref) t.unref();
      pending.set(id, { resolve: res, reject: rej, timer: t });
      sendCtrl({ t: 'rpc', id, method, params: params || {} });
    });
    // PING/PONG 왕복 RTT — 소프트 실패(RTT 초과) 판정 재료.
    session.ping = (ms = 3000) => new Promise((res, rej) => {
      if (!session.alive) { rej(codedErr('LAN_CLOSED', '직결이 끊겼습니다')); return; }
      const t0p = Date.now();
      const t = setTimeout(() => {
        const i = pingWaiters.indexOf(w);
        if (i >= 0) pingWaiters.splice(i, 1);
        rej(codedErr('LAN_TIMEOUT', 'ping 응답 없음'));
      }, ms);
      if (t.unref) t.unref();
      const w = () => { clearTimeout(t); res(Date.now() - t0p); };
      pingWaiters.push(w);
      const p = Buffer.allocUnsafe(8); p.writeBigUInt64BE(BigInt(t0p));
      send(encodeFrame(T_PING, 0, p));
    });
    session.close = () => destroy('LAN_LOCAL_CLOSE');
    session.onClose = (fn) => { closeCb = fn; };
  });
}

function codedErr(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// probe — 연결+인증 왕복 1회. 승격 판정(§6)의 재료.
async function probe(o = {}) {
  const t0 = Date.now();
  try {
    const s = await connect({ ...o, timeoutMs: Number(o.timeoutMs) || 1500 });
    const rttMs = Date.now() - t0;
    s.close();
    return { ok: true, rttMs, endpoint: { host: o.host, port: o.port } };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'LAN_UNREACHABLE', rttMs: Date.now() - t0 };
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  경로 상태(승격/강등) — 설계 §6. 플래핑 방지가 전부다.
// ══════════════════════════════════════════════════════════════════════════
//  키 = (myClientKey, hostDeviceId, netFingerprint). netFingerprint = 성공한 endpoint 의 /24(v6=/64)
//  상태 = relay(기본·항상 동작) · probing · lan · cooldown
//  승격: probe 2연속 성공 && 각 RTT ≤ PROMOTE_RTT_MS
//  강등: 하드 실패 1회 즉시 / 소프트 실패 2연속(단 lan 진입 30s 는 소프트로 강등 안 함)
//  쿨다운: 60s → ×2 → 상한 15분. 쿨다운 중 시도 금지. revive() 는 1회 무시(앱 복귀·네트워크 변화).
const PROMOTE_OK_STREAK = 2;
const PROMOTE_RTT_MS = 800;
const MIN_DWELL_MS = 30000;
const SOFT_FAIL_STREAK = 2;
const COOLDOWN_MIN_MS = 60000;
const COOLDOWN_MAX_MS = 15 * 60 * 1000;

let nowFn = () => Date.now();
function __setNow(fn) { nowFn = typeof fn === 'function' ? fn : (() => Date.now()); } // 테스트 전용

const paths = new Map(); // key -> {state, okStreak, softStreak, since, cooldownUntil, cooldownMs}
function fingerprint(host) {
  const c = classifyAddr(host);
  if (!c.addr) return '';
  if (c.family === 4) return c.addr.split('.').slice(0, 3).join('.') + '.0/24';
  return c.addr.split(':').slice(0, 4).join(':') + '::/64';
}
function pathKey(clientKey, hostDeviceId, host) {
  return `${clientKey || ''}|${hostDeviceId != null ? hostDeviceId : ''}|${fingerprint(host)}`;
}
function pathEntry(key) {
  let e = paths.get(key);
  if (!e) { e = { state: 'relay', okStreak: 0, softStreak: 0, since: nowFn(), cooldownUntil: 0, cooldownMs: 0 }; paths.set(key, e); }
  return e;
}
function pathState(key) {
  const e = pathEntry(key);
  if (e.cooldownUntil > nowFn()) return 'cooldown';
  return e.state;
}
// 이 경로로 "새 연결"을 시도해도 되나. 쿨다운 중이면 false(= 조용히 릴레이).
function shouldTry(key) {
  const e = pathEntry(key);
  return !(e.cooldownUntil > nowFn());
}
function noteProbeOk(key, rttMs) {
  const e = pathEntry(key);
  if (e.cooldownUntil > nowFn()) return e.state;
  if (Number.isFinite(rttMs) && rttMs > PROMOTE_RTT_MS) { e.okStreak = 0; e.state = e.state === 'lan' ? 'lan' : 'probing'; return e.state; }
  e.okStreak += 1;
  e.softStreak = 0;
  // ⚠ 승격 자체로 쿨다운 승수를 리셋하지 않는다 — 리셋하면 승격↔강등 플래핑이 영원히 60s 쿨다운에
  //  머물러 백오프가 무의미해진다. 승수는 "충분히 오래 안정적으로 붙어 있었을 때"만 지운다(noteSuccess).
  if (e.state !== 'lan' && e.okStreak >= PROMOTE_OK_STREAK) { e.state = 'lan'; e.since = nowFn(); }
  else if (e.state !== 'lan') e.state = 'probing';
  return e.state;
}
// 실제로 바이트가 흐르고 있다 — 최소 체류를 넘겨 "안정"이 증명되면 연속 강등 승수를 초기화한다.
function noteSuccess(key) {
  const e = pathEntry(key);
  e.softStreak = 0;
  if (e.state === 'lan' && nowFn() - e.since >= MIN_DWELL_MS) e.cooldownMs = 0;
  if (e.state !== 'lan') { e.okStreak += 1; if (e.okStreak >= PROMOTE_OK_STREAK) { e.state = 'lan'; e.since = nowFn(); } else e.state = 'probing'; }
  return e.state;
}
function demote(e, reason) {
  e.state = 'relay';
  e.okStreak = 0;
  e.softStreak = 0;
  e.cooldownMs = e.cooldownMs ? Math.min(e.cooldownMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_MIN_MS;
  e.cooldownUntil = nowFn() + e.cooldownMs;
  e.since = nowFn();
  e.lastReason = reason || '';
  return e.state;
}
// 하드 실패(connect 거부·auth 실패·프레임 위반) = 즉시 강등. 최소 체류 예외.
function noteHardFail(key, reason) { return demote(pathEntry(key), reason || 'hard'); }
// 소프트 실패(RTT 초과·채널 오픈 타임아웃) = 2연속, 단 lan 진입 30s 내에는 강등하지 않는다.
function noteSoftFail(key, reason) {
  const e = pathEntry(key);
  e.softStreak += 1;
  if (e.state === 'lan' && nowFn() - e.since < MIN_DWELL_MS) return e.state; // 최소 체류(플랩 방지)
  if (e.softStreak >= SOFT_FAIL_STREAK) return demote(e, reason || 'soft');
  return e.state;
}
// 부활 트리거(앱 복귀·네트워크 변경·사용자 새로고침·토글 ON) — 쿨다운 1회 무시.
function revive(key) {
  const e = pathEntry(key);
  e.cooldownUntil = 0;
  e.okStreak = 0;
  e.softStreak = 0;
  if (e.state === 'relay') e.state = 'probing';
  return e.state;
}
function pathSnapshot() {
  const out = {};
  for (const [k, v] of paths) out[k] = { ...v };
  return out;
}
function resetPaths() { paths.clear(); }

module.exports = {
  // 게이팅
  enabled, scope, allows, scopesForDaemon, rpcAllowed,
  // 호스트
  start, stop, info, addGrant, sweepGrants, grantCount, clearGrants, localAddrs,
  // 뷰어
  connect, probe,
  // 경로 상태
  pathKey, pathState, shouldTry, noteProbeOk, noteSuccess, noteHardFail, noteSoftFail, revive,
  pathSnapshot, resetPaths, fingerprint,
  // 내부(테스트/진단 노출)
  PROTO, T_CTRL, T_DATA, T_TEXT, T_CLOSE, T_PING, T_PONG, MAX_FRAME,
  encodeFrame, encodeCtrl, createFramer, classifyAddr, peerPolicy, macFor, srvMacFor,
  lanStateFile, __setNow, __resetLimits,
};
