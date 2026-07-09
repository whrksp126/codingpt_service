/**
 * 프리뷰 프록시 — 포트 감지(RPC) + TCP 터널(dial-back 스트림)
 *
 * 사용자가 자기 PC 에서 직접 띄운 dev 서버(npm run dev 등)를 폰 웹뷰로 미리보기하기 위한 최소 구성.
 *  · net.ports  : 127.0.0.1(loopback)에 LISTEN 중인 포트 목록. 앱 "실행 중인 포트" 카드로 노출.
 *  · TCP 터널   : stream_open(kind:'tcp', params:{port}) → back 이 다이얼백한 WS ↔ net.connect(127.0.0.1, port)
 *                  raw 바이트 브리지. back 이 이 위로 HTTP/HMR 을 프록시한다(데몬은 HTTP 를 해석하지 않음).
 *
 * 보안: **loopback(127.0.0.1) 전용**. 임의 호스트로 connect 하지 않는다(SSRF 방지). 포트도 감지된 것/앱 요청분만.
 * ToS 경계: 여기서 하는 일은 로컬 포트 바이트 릴레이가 전부다. AI 자격증명 무접촉.
 */
const net = require('net');
const { execFile } = require('child_process');
const WebSocket = require('ws');

// 시스템/노이즈 포트는 미리보기 후보에서 제외(감지 목록만 정리 — 프록시 자체는 요청 포트로 함).
// dev 서버는 관례상 낮은 포트(<10000) → 에페메랄/고포트는 목록에서 제외해 노이즈를 줄인다.
const MAX_DEV_PORT = 10000;
const IGNORE_PORTS = new Set([
  22, 25, 53, 88, 111, 139, 445, 631, // 시스템
  5432, 3306, 6379, 27017, 11211, 6380, 6390, 33061, // DB/캐시
  5037, // adb
  7000, 5000, // macOS AirPlay/ControlCenter (흔한 오탐)
  1935, // RTMP
]);

// 127.0.0.1 에 LISTEN 중인 TCP 포트 감지(macOS/Linux: lsof). 실패하면 빈 목록.
function listPorts() {
  return new Promise((resolve) => {
    // -nP: 이름 해석 안 함(빠름), -iTCP -sTCP:LISTEN: LISTEN 소켓만, -Fn: 파싱용 필드 출력
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 4000 }, (err, stdout) => {
      if (err && !stdout) { resolve({ ports: [] }); return; }
      const ports = new Set();
      for (const line of String(stdout || '').split('\n')) {
        if (line[0] !== 'n') continue; // name 필드만
        // 예: n127.0.0.1:5173  n[::1]:5173  n*:3000  n127.0.0.1:5173->... (LISTEN엔 화살표 없음)
        const body = line.slice(1);
        const m = body.match(/(?:^\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/);
        if (!m) continue;
        const port = Number(m[1]);
        if (port > 1024 && port <= MAX_DEV_PORT && !IGNORE_PORTS.has(port)) ports.add(port);
      }
      resolve({ ports: Array.from(ports).sort((a, b) => a - b) });
    });
  });
}

// back 지시(stream_open kind:'tcp')에 대한 dial-back → 로컬 포트로 raw TCP 브리지.
function openTcpStream({ serverUrl, deviceToken }, { streamToken, params }) {
  const port = params && Number(params.port);
  if (!port || port <= 0 || port >= 65536) throw new Error('유효한 port 가 필요합니다.');

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });

  ws.on('open', () => {
    // loopback 전용 — 임의 호스트 금지.
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      console.log(`[proxy] TCP 터널 연결 127.0.0.1:${port}`);
    });
    sock.setNoDelay(true);

    // ws(back) → 로컬 소켓
    ws.on('message', (data, isBinary) => {
      try { sock.write(isBinary ? data : Buffer.from(String(data))); } catch (_) { /* noop */ }
    });
    // 로컬 소켓 → ws(back). 바이너리로 전송(HTTP 응답 바이트 원형 유지).
    sock.on('data', (buf) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true }); } catch (_) { /* noop */ }
    });

    const cleanup = () => {
      try { sock.destroy(); } catch (_) { /* noop */ }
      try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch (_) { /* noop */ }
    };
    sock.on('close', cleanup);
    sock.on('error', (e) => {
      // dev 서버 미기동/거부 → 스트림 닫아 back 이 502 처리.
      console.warn(`[proxy] 로컬 포트 ${port} 연결 오류: ${e.message}`);
      cleanup();
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  ws.on('error', (e) => console.error(`[proxy] 스트림 WS 오류: ${e.message}`));
}

module.exports = { listPorts, openTcpStream };
