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
const fsLib = require('./fs');
const e2eeGate = require('./e2ee-gate');

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

function lsof(args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile('lsof', args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout || '')));
  });
}

// LISTEN 소켓 → [{ pid, port }] (127.0.0.1/*/::1 등 로컬 바인딩만, dev 포트대만).
async function listListenSockets() {
  // -Fpn: p<pid> 블록 + n<name> 라인(프로세스별로 그룹핑됨).
  const out = await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  const rows = [];
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') { pid = parseInt(line.slice(1), 10) || null; continue; }
    if (line[0] !== 'n' || !pid) continue;
    const m = line.slice(1).match(/(?:^\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (port > 1024 && port <= MAX_DEV_PORT && !IGNORE_PORTS.has(port)) rows.push({ pid, port });
  }
  return rows;
}

// pid[] → { pid: cwdAbs } (각 프로세스의 현재 작업 디렉토리).
async function cwdsForPids(pids) {
  if (!pids.length) return {};
  const out = await lsof(['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  const map = {};
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') { pid = parseInt(line.slice(1), 10) || null; continue; }
    if (line[0] === 'n' && pid) map[pid] = line.slice(1);
  }
  return map;
}

// 127.0.0.1 에 LISTEN 중인 TCP 포트 감지(macOS/Linux: lsof). 실패하면 빈 목록.
//  opts.cwd(홈-기준 상대) 를 주면 그 워크스페이스 폴더 아래에서 실행 중인 프로세스의 포트만 반환
//  (그 폴더 안 터미널에서 띄운 dev 서버만 감지 — 시스템/타 폴더 포트는 제외).
async function listPorts(opts = {}) {
  const rows = await listListenSockets();
  if (rows.length === 0) return { ports: [] };
  const cwdRel = opts && typeof opts.cwd === 'string' ? opts.cwd.trim() : '';
  if (!cwdRel) {
    const ports = Array.from(new Set(rows.map((r) => r.port))).sort((a, b) => a - b);
    return { ports };
  }
  let base;
  try { base = fsLib.safeResolve(cwdRel); } catch (_) { return { ports: [] }; }
  const prefix = base.replace(/\/+$/, '') + '/';
  const pids = Array.from(new Set(rows.map((r) => r.pid)));
  const cwds = await cwdsForPids(pids);
  const ports = new Set();
  for (const r of rows) {
    const c = cwds[r.pid];
    if (c && (c === base || c.startsWith(prefix))) ports.add(r.port);
  }
  return { ports: Array.from(ports).sort((a, b) => a - b) };
}

// back 지시(stream_open kind:'tcp')에 대한 dial-back → 로컬 포트로 raw TCP 브리지.
//  E2EE(D단계): params.sid 가 있으면 프레임을 봉인한다(purpose:'tcp', routing:{port} 로 선협상된 세션).
//  TCP 는 ctrl 프레임이 없다 — data 만 오간다. 세션 부재 시엔 평문으로 내려가지 않고 닫는다(뷰어가
//  암호문을 기대하는데 평문을 흘리면 HTTP 응답이 깨진 채 렌더된다).
function openTcpStream({ serverUrl, deviceToken }, { streamToken, params }) {
  const port = params && Number(params.port);
  if (!port || port <= 0 || port >= 65536) throw new Error('유효한 port 가 필요합니다.');
  const sid = (params && (params.sid || (params.e2ee && params.e2ee.sid))) || null;

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/api/daemon/stream/' + streamToken;
  const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });

  ws.on('open', () => {
    const enc = !!sid;
    if (enc && !(e2eeGate.allows('stream') && e2eeGate.sessionExists(sid, 'host'))) {
      console.warn(`[proxy] E2EE 세션을 찾을 수 없어 터널을 닫습니다(port ${port}, scope=${e2eeGate.scope()})`);
      try { ws.close(4090, 'E2EE_SESSION_UNKNOWN'); } catch (_) { /* noop */ }
      return;
    }
    // 봉인 채널은 첫 수신 프레임에서 학습(connId 는 뷰어가 정한다 — pty.js 와 동일 규율).
    //  TCP 는 뷰어(브라우저 요청)가 항상 먼저 보내므로 응답 전에 채널이 선다. 그래도 순서 안전을 위해 버퍼.
    let ch = null;
    const outQ = [];
    let outQBytes = 0;
    const OUT_Q_MAX = 4 * 1024 * 1024;
    const sealSend = (buf) => {
      try { ws.send(ch.seal(buf, e2eeGate.KIND_DATA), { binary: true }); } catch (_) { /* noop */ }
    };
    const flushOut = () => { const q = outQ.splice(0); outQBytes = 0; for (const b of q) sealSend(b); };

    // loopback 전용 — 임의 호스트 금지.
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      console.log(`[proxy] TCP 터널 연결 127.0.0.1:${port}${enc ? ' (e2ee)' : ''}`);
    });
    sock.setNoDelay(true);

    // ws(back) → 로컬 소켓
    ws.on('message', (data, isBinary) => {
      if (enc) {
        if (!isBinary) return; // 봉인 모드에 평문 프레임 = 폐기
        if (!ch) {
          ch = e2eeGate.hostChannelFromFrame(sid, data);
          if (!ch) { console.warn(`[proxy] 봉인 채널 확립 실패 — 폐기(port ${port})`); return; }
          flushOut();
        }
        const f = e2eeGate.openFrame(ch, data);
        if (!f) { console.warn(`[proxy] 프레임 복호 실패 — 폐기(port ${port})`); return; }
        if (f.kind !== e2eeGate.KIND_DATA) return; // tcp 는 ctrl 미사용
        try { sock.write(f.payload); } catch (_) { /* noop */ }
        return;
      }
      try { sock.write(isBinary ? data : Buffer.from(String(data))); } catch (_) { /* noop */ }
    });
    // 로컬 소켓 → ws(back). 바이너리로 전송(HTTP 응답 바이트 원형 유지).
    sock.on('data', (buf) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!enc) { try { ws.send(buf, { binary: true }); } catch (_) { /* noop */ } return; }
      if (ch) { sealSend(buf); return; }
      if (outQBytes + buf.length > OUT_Q_MAX) { console.warn(`[proxy] 봉인 채널 확립 전 버퍼 초과 — 폐기(port ${port})`); return; }
      outQ.push(buf); outQBytes += buf.length;
    });

    const cleanup = () => {
      if (ch && typeof ch.close === 'function') { try { ch.close(); } catch (_) { /* noop */ } } // connId 회수
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
