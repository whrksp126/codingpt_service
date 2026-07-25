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

// port → { server, token, serverUrl, sid, conns:Set<net.Socket> } — 리스너는 포트당 1개(멱등).
const forwards = new Map();

// 127.0.0.1:<port> 리스너 기동. 이미 있으면 token/serverUrl 만 갱신(새 연결부터 새 토큰으로 다이얼).
//  bind 실패(EADDRINUSE 등)는 throw 가 아니라 구조화 반환 — 호출측(PC 앱)이 프록시 폴백을 결정한다.
//
//  E2EE(D단계): 이 쪽은 **뷰어**다(데몬이 보는 기기 = PC 앱). e2ee.sid 를 받으면 연결마다 프레임을
//   봉인한다(dir=v→h). sid 는 뷰어측 세션 파생이 끝나 e2ee 모듈에 등록된 뒤에 넘어와야 한다 —
//   ⚠ 현재 cpt-server.js `forward.start` 는 {serverUrl,port,token} 만 전달하므로(수정 금지 파일)
//   이 인자는 그 배관이 붙기 전까지 항상 비어 있고, 포워딩은 평문으로 동작한다(설계 준수: 무마찰 폴백).
function startLocalForward({ serverUrl, port, token, e2ee }) {
  const sid = (e2ee && e2ee.sid) || null;
  const existing = forwards.get(port);
  if (existing) {
    existing.token = token;
    existing.serverUrl = serverUrl;
    existing.sid = sid;
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    const entry = { server: null, token, serverUrl, sid, conns: new Set() };
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
