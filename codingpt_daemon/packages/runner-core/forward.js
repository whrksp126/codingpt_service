/**
 * 로컬 포트 포워더 — "다른 PC" 워크스페이스의 dev 서버를 이 기기의 127.0.0.1:<port> 로 미러.
 *
 * proxy.js openTcpStream(대상 PC 쪽: back→로컬 dial-back)의 반대 방향이다. 이 파일은 "보는 기기"
 * 쪽에서 127.0.0.1:<port> 리스너를 열고, TCP 연결 1개당 back 의 /api/daemon/forward/<token> WS 를
 * 1개 다이얼해 raw 바이트를 양방향 파이프한다(back 이 대상 PC 데몬의 같은 포트와 브리지).
 * 프리뷰 웹뷰가 localhost URL 을 그대로 로드할 수 있어 프록시 URL 치환/표시 역매핑이 필요 없다.
 *
 * 보안: 리스너는 loopback(127.0.0.1) 전용 — 외부 기기에서 접속 불가. 토큰은 back 발급
 * ((port, 대상PC)당 재사용, TTL 1h·사용 시 연장)이며 여기서는 보관만 하고 해석하지 않는다.
 */
const net = require('net');
const WebSocket = require('ws');
const e2eeGate = require('./e2ee-gate');
const lanLib = require('./lan');

// port → { server, token, serverUrl, sid, upstream, conns:Set<net.Socket> } — 리스너는 포트당 1개(멱등).
const forwards = new Map();

// 127.0.0.1:<port> 리스너 기동. 이미 있으면 token/serverUrl 만 갱신(새 연결부터 새 토큰으로 다이얼).
//  bind 실패(EADDRINUSE 등)는 throw 가 아니라 구조화 반환 — 호출측(PC 앱)이 프록시 폴백을 결정한다.
//
//  E2EE(D단계): 이 쪽은 **뷰어**다(데몬이 보는 기기 = PC 앱). e2ee.sid 를 받으면 연결마다 프레임을
//   봉인한다(dir=v→h). sid 는 뷰어측 세션 파생이 끝나 e2ee 모듈에 등록된 뒤에 넘어와야 한다 —
//   ⚠ cpt-server.js `forward.start` 는 upstream 은 전달하지만(2026-07-25) **e2ee 는 아직 전달하지
//   않는다** — PC 뷰어 offer 를 누가 만드는가가 미결이다(계약 §3.8). 그 배관이 붙기 전까지 이 인자는
//   항상 비어 있고, 포워딩은 평문으로 동작한다(설계 준수: 무마찰 폴백).
//
//  LAN 직결(임무 F, F1): upstream 을 주면 연결마다 상류를 고른다.
//    upstream = { mode:'lan', host, lanPort, grantId, secret, clientKey, kind, hostDeviceId, remotePort? }
//   릴레이는 **영구 폴백**이다: 직결이 (a) 쿨다운 중이거나 (b) 첫 바이트 수신 전에 실패하면
//   그 연결만 조용히 릴레이로 재시도한다 — 사용자에게는 아무것도 보이지 않는다.
//   ⚠ 프리뷰 첫 요청 유실 = "영원히 빈 화면" 이므로 폴백 시 **버퍼된 바이트를 그대로 승계**한다.
function startLocalForward({ serverUrl, port, token, e2ee, upstream }) {
  const sid = (e2ee && e2ee.sid) || null;
  const existing = forwards.get(port);
  if (existing) {
    existing.token = token;
    existing.serverUrl = serverUrl;
    existing.sid = sid;
    if (upstream !== undefined) existing.upstream = normalizeUpstream(upstream);
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    const entry = { server: null, token, serverUrl, sid, upstream: normalizeUpstream(upstream), conns: new Set(), lanSession: null };
    const server = net.createServer((sock) => handleConn(entry, port, sock));
    entry.server = server;
    let listening = false;
    server.on('error', (e) => {
      if (!listening) {
        // bind 실패 — 등록 없이 실패 반환(대표: 이 PC 의 자기 dev 서버가 같은 포트 점유 = EADDRINUSE).
        resolve({ ok: false, error: (e && e.code) || 'LISTEN_ERROR' });
        return;
      }
      // 가동 중 리스너 오류(드묾) — 정리해 다음 start 가 재생성하게 한다.
      console.warn(`[forward] 리스너 오류(port ${port}): ${e.message}`);
      stopLocalForward(port);
    });
    server.listen({ host: '127.0.0.1', port }, () => {
      listening = true;
      forwards.set(port, entry);
      console.log(`[forward] 로컬 포워더 대기 127.0.0.1:${port}`);
      resolve({ ok: true });
    });
  });
}

// upstream 정규화 — 인식하지 못하는 mode 는 무시(=릴레이). 사설 주소가 아니면 아예 받지 않는다
//  (공용망에서는 직결 시도 자체를 하지 않는다는 규율을 진입점에서 강제).
function normalizeUpstream(u) {
  if (!u || u.mode !== 'lan') return null;
  const host = String(u.host || '').trim();
  const lanPort = Number(u.lanPort || u.port);
  if (!host || !Number.isInteger(lanPort)) return null;
  if (!lanLib.classifyAddr(host).private) {
    console.warn(`[forward] 직결 상류가 사설 주소가 아님 — 무시(${host})`);
    return null;
  }
  return {
    mode: 'lan', host, lanPort,
    grantId: u.grantId, secret: u.secret, clientKey: u.clientKey, kind: u.kind || 'pc',
    hostDeviceId: u.hostDeviceId != null ? u.hostDeviceId : null,
    remotePort: Number(u.remotePort) || 0,
    // grant 는 단일 사용이다. 데몬이 재시작하면(또는 세션이 끊기면) 남은 grant 로는 다시 못 붙는다 →
    //  호출측이 refresh() 를 주면 **1회 재발급 후 재시도**하고, 그 재시도는 강등 카운터를 쓰지 않는다
    //  (설계 §5.5: "LAN_AUTH_FAILED → grant 재발급 1회 재시도, 강등 카운터 무소모").
    refresh: typeof u.refresh === 'function' ? u.refresh : null,
    key: lanLib.pathKey(u.clientKey, u.hostDeviceId, host),
  };
}

// accept 소켓 1개 = 상류 1개. 상류 선택은 경로 상태(§6)가 정한다 — 쿨다운 중이면 시도조차 안 한다.
function handleConn(entry, port, sock) {
  const up = entry.upstream;
  if (up && lanLib.shouldTry(up.key)) { handleConnLan(entry, port, sock); return; }
  handleConnRelay(entry, port, sock, []);
}

// ── LAN 직결 상류 ─────────────────────────────────────────────────────────
// 세션은 **포워더당 1개**를 재사용해 채널로 다중화한다(연결마다 핸드셰이크하면 grant 단일 사용
//  정책과 충돌하고 지연도 커진다). 세션이 죽으면 캐시를 비우고 다음 연결이 다시 세운다.
function lanSession(entry, allowRefresh = true) {
  const up = entry.upstream;
  if (!up) return Promise.reject(Object.assign(new Error('직결 상류 없음'), { code: 'LAN_NO_UPSTREAM' }));
  if (entry.lanSession && entry.lanSession.p) return entry.lanSession.p;
  const p = lanLib.connect({
    host: up.host, port: up.lanPort, grantId: up.grantId, secret: up.secret,
    clientKey: up.clientKey, kind: up.kind, timeoutMs: 2500,
  }).then((s) => {
    s.onClose(() => { if (entry.lanSession && entry.lanSession.p === p) entry.lanSession = null; });
    return s;
  }).catch((e) => {
    if (entry.lanSession && entry.lanSession.p === p) entry.lanSession = null;
    // grant 소진/데몬 재시작 → 1회 재발급 재시도(강등 카운터 무소모).
    if (allowRefresh && e && e.code === 'LAN_AUTH_FAILED' && typeof up.refresh === 'function') {
      return Promise.resolve()
        .then(() => up.refresh())
        .then((fresh) => {
          if (!fresh || !fresh.grantId || !fresh.secret) throw e;
          entry.upstream = normalizeUpstream({ ...up, ...fresh, mode: 'lan' }) || up;
          return lanSession(entry, false);
        });
    }
    throw e;
  });
  entry.lanSession = { p };
  return p;
}

function handleConnLan(entry, port, sock) {
  const up = entry.upstream;
  sock.setNoDelay(true);
  entry.conns.add(sock);
  const pending = [];   // 상류 확립 전 도착한 로컬 바이트(순서 보존)
  let chan = null;
  let gotAny = false;   // 상류에서 바이트를 하나라도 받았나(= 폴백 불가 지점)
  let handedOver = false;
  const onLocalData = (buf) => { if (chan) chan.write(buf); else pending.push(buf); };
  sock.on('data', onLocalData);

  // 릴레이 강등 — 첫 바이트 전이면 이 연결을 그대로 릴레이로 넘긴다(버퍼 승계). 사용자 무자각.
  const fallback = (code, soft) => {
    if (handedOver) return;
    handedOver = true;
    if (soft) lanLib.noteSoftFail(up.key, code); else lanLib.noteHardFail(up.key, code);
    if (gotAny || sock.destroyed) { try { sock.destroy(); } catch (_) { /* noop */ } return; }
    console.log(`[forward] 직결 실패(${code}) — 이 연결만 릴레이로 전환(port ${port})`);
    sock.removeListener('data', onLocalData);
    handleConnRelay(entry, port, sock, pending.splice(0));
  };

  lanSession(entry)
    .then((s) => s.openTcp(up.remotePort || port))
    .then((c) => {
      if (handedOver || sock.destroyed) { try { c.close(); } catch (_) { /* noop */ } return; }
      chan = c;
      lanLib.noteSuccess(up.key);
      c.onData = (buf) => { gotAny = true; try { sock.write(buf); } catch (_) { /* noop */ } };
      c.onClose = () => { try { sock.end(); } catch (_) { /* noop */ } };
      for (const b of pending.splice(0)) c.write(b);
    })
    .catch((e) => {
      const code = (e && e.code) || 'LAN_UNREACHABLE';
      // 타임아웃/RTT 계열만 소프트 — 나머지(거부·인증 실패·프로토콜 위반)는 즉시 강등.
      fallback(code, code === 'LAN_TIMEOUT');
    });

  const cleanup = () => {
    entry.conns.delete(sock);
    if (chan) { try { chan.close(); } catch (_) { /* noop */ } chan = null; }
    if (!handedOver) { try { sock.destroy(); } catch (_) { /* noop */ } }
  };
  sock.on('close', cleanup);
  sock.on('error', cleanup);
}

// ── 릴레이 상류(기존 경로 — 무수정) ──────────────────────────────────────
// accept 소켓 1개 = WS 1개(와이어 계약). 파이프/정리는 proxy.js openTcpStream 패턴 미러.
//  WS open 전 도착한 로컬 바이트는 버퍼 후 open 시 순서 재생 — 브라우저가 connect 직후 쏘는
//  첫 HTTP 요청이 유실되면 탭이 영원히 빈 화면이 된다.
//  replay = 직결 시도 중 이미 읽어 둔 바이트(강등 승계). 빈 배열이면 기존과 완전히 동일한 경로다.
function handleConnRelay(entry, port, sock, replay) {
  sock.setNoDelay(true);
  entry.conns.add(sock);
  // 토큰은 다이얼 시점의 entry 값 — start 재호출(토큰 갱신)이 이후 연결에 자연 반영된다.
  const wsUrl = entry.serverUrl.replace(/^http/, 'ws') + '/api/daemon/forward/' + entry.token;
  const ws = new WebSocket(wsUrl);
  const pending = Array.isArray(replay) && replay.length ? replay.slice() : []; // WS open 전 도착한 로컬 바이트(순서 보존)
  let open = false;
  // 봉인 채널은 **연결마다** 만든다(connId = 연결별 난수 — nonce 재사용 방지).
  //  이 쪽은 뷰어이고 **먼저 보내는 쪽**이라 connId 를 스스로 정한다(호스트는 첫 프레임에서 학습).
  //  sid 가 있는데 세션을 못 찾으면 평문으로 흘리지 않고 이 연결만 끊는다(호스트가 봉인을 기대한다).
  const ch = entry.sid ? e2eeGate.viewerChannel(entry.sid) : null;
  const sealFail = !!entry.sid && !ch;

  const sendUp = (buf) => {
    try {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(ch ? ch.seal(buf, e2eeGate.KIND_DATA) : buf, { binary: true });
    } catch (_) { /* noop */ }
  };

  // 로컬 소켓 → ws(back). 바이너리로 전송(HTTP 요청 바이트 원형 유지).
  sock.on('data', (buf) => {
    if (!open) { pending.push(buf); return; }
    sendUp(buf);
  });
  ws.on('open', () => {
    if (sealFail) {
      console.warn(`[forward] E2EE 세션 부재 — 이 연결을 닫습니다(port ${port})`);
      try { ws.close(4090, 'E2EE_SESSION_UNKNOWN'); } catch (_) { /* noop */ }
      try { sock.destroy(); } catch (_) { /* noop */ }
      return;
    }
    open = true;
    for (const buf of pending) sendUp(buf);
    pending.length = 0;
  });
  // ws(back) → 로컬 소켓
  ws.on('message', (data, isBinary) => {
    if (ch) {
      if (!isBinary) return; // 봉인 모드에 평문 프레임 = 폐기
      const f = e2eeGate.openFrame(ch, data);
      if (!f) { console.warn(`[forward] 프레임 복호 실패 — 폐기(port ${port})`); return; }
      if (f.kind !== e2eeGate.KIND_DATA) return; // tcp 는 ctrl 미사용
      try { sock.write(f.payload); } catch (_) { /* noop */ }
      return;
    }
    try { sock.write(isBinary ? data : Buffer.from(String(data))); } catch (_) { /* noop */ }
  });

  const cleanup = () => {
    if (ch && typeof ch.close === 'function') { try { ch.close(); } catch (_) { /* noop */ } } // connId 회수
    entry.conns.delete(sock);
    try { sock.destroy(); } catch (_) { /* noop */ }
    try {
      // CONNECTING 에 close() 하면 ws 가 "closed before established" 에러를 내므로 terminate.
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
    } catch (_) { /* noop */ }
  };
  sock.on('close', cleanup);
  sock.on('error', cleanup);
  ws.on('close', cleanup);
  ws.on('error', (e) => {
    // 토큰 만료(서버가 즉시 닫음)/back 다운 등 — 이 연결만 닫는다(리스너는 유지,
    //  다음 연결이 갱신된 토큰으로 재시도).
    console.warn(`[forward] 스트림 WS 오류(port ${port}): ${e.message}`);
    cleanup();
  });
}

// 리스너 + 활성 연결 정리. 미존재 포트는 조용히 성공(멱등).
function stopLocalForward(port) {
  const entry = forwards.get(port);
  if (!entry) return { ok: true };
  forwards.delete(port);
  if (entry.lanSession && entry.lanSession.p) {
    entry.lanSession.p.then((s) => { try { s.close(); } catch (_) { /* noop */ } }).catch(() => { /* 이미 실패 */ });
    entry.lanSession = null;
  }
  try { entry.server.close(); } catch (_) { /* noop */ }
  for (const sock of entry.conns) { try { sock.destroy(); } catch (_) { /* noop */ } }
  entry.conns.clear();
  return { ok: true };
}

function stopAllForwards() {
  for (const port of [...forwards.keys()]) stopLocalForward(port);
  return { ok: true };
}

module.exports = { startLocalForward, stopLocalForward, stopAllForwards };
