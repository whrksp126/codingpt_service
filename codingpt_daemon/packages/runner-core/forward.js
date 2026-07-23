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

// port → { server, token, serverUrl, conns:Set<net.Socket> } — 리스너는 포트당 1개(멱등).
const forwards = new Map();

// 127.0.0.1:<port> 리스너 기동. 이미 있으면 token/serverUrl 만 갱신(새 연결부터 새 토큰으로 다이얼).
//  bind 실패(EADDRINUSE 등)는 throw 가 아니라 구조화 반환 — 호출측(PC 앱)이 프록시 폴백을 결정한다.
function startLocalForward({ serverUrl, port, token }) {
  const existing = forwards.get(port);
  if (existing) {
    existing.token = token;
    existing.serverUrl = serverUrl;
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    const entry = { server: null, token, serverUrl, conns: new Set() };
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

// accept 소켓 1개 = WS 1개(와이어 계약). 파이프/정리는 proxy.js openTcpStream 패턴 미러.
//  WS open 전 도착한 로컬 바이트는 버퍼 후 open 시 순서 재생 — 브라우저가 connect 직후 쏘는
//  첫 HTTP 요청이 유실되면 탭이 영원히 빈 화면이 된다.
function handleConn(entry, port, sock) {
  sock.setNoDelay(true);
  entry.conns.add(sock);
  // 토큰은 다이얼 시점의 entry 값 — start 재호출(토큰 갱신)이 이후 연결에 자연 반영된다.
  const wsUrl = entry.serverUrl.replace(/^http/, 'ws') + '/api/daemon/forward/' + entry.token;
  const ws = new WebSocket(wsUrl);
  const pending = []; // WS open 전 도착한 로컬 바이트(순서 보존)
  let open = false;

  // 로컬 소켓 → ws(back). 바이너리로 전송(HTTP 요청 바이트 원형 유지).
  sock.on('data', (buf) => {
    if (!open) { pending.push(buf); return; }
    try { if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true }); } catch (_) { /* noop */ }
  });
  ws.on('open', () => {
    open = true;
    for (const buf of pending) {
      try { ws.send(buf, { binary: true }); } catch (_) { /* noop */ }
    }
    pending.length = 0;
  });
  // ws(back) → 로컬 소켓
  ws.on('message', (data, isBinary) => {
    try { sock.write(isBinary ? data : Buffer.from(String(data))); } catch (_) { /* noop */ }
  });

  const cleanup = () => {
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
