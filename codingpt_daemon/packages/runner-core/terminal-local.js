'use strict';

// PC 앱(같은 기기)용 루프백 터미널 서버 — v3 뷰어 경로를 원격과 **완전히 같은 와이어**로 제공한다.
//
// 왜 필요한가(docs/terminal-v3-design.md §1-6): 예전엔 PC 로컬 터미널만 Rust 가 tmux 에 tty 로 직접
//  attach 해 별도 구현(리스·크기·과거·모드 조회 Rust 판)을 가졌다. v3 에서 정본은 데몬 VT 하나이므로
//  PC 도 뷰어여야 하고, 그러려면 PC 웹뷰가 데몬에 WS 로 붙을 자리가 있어야 한다. 릴레이(백엔드)를
//  같은 기기 안에서 왕복시키는 건 낭비라 127.0.0.1 전용 리스너를 둔다.
//
// 보안: 127.0.0.1 바인드 + 시작마다 새 난수 토큰. 토큰과 포트는 daemon.json(0600) 에 적어 PC 앱만 읽는다.
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');

let server = null, wss = null, state = null;

function parseParams(url) {
  const u = new URL(url, 'http://127.0.0.1');
  const q = u.searchParams;
  return {
    token: q.get('token') || '',
    cwd: q.get('cwd') || '', paneId: q.get('paneId') || '', client: q.get('client') || 'pc',
    win: q.get('win') != null && q.get('win') !== '' ? Number(q.get('win')) : undefined,
    cols: Number(q.get('cols')) || 80, rows: Number(q.get('rows')) || 24,
    deviceName: q.get('deviceName') || '',
  };
}

/** 시작 — 포트/토큰을 daemon.json 에 기록한다. 실패해도 데몬은 계속 뜬다(원격 경로는 영향 없음). */
function start() {
  if (server) return state;
  const pty = require('./pty');
  const token = crypto.randomBytes(24).toString('hex');
  server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let p;
    try { p = parseParams(req.url || ''); } catch (_) { socket.destroy(); return; }
    if (!req.url.startsWith('/v3/terminal') || p.token !== token) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ }
      const io = pty.wsPtyIo(ws, null);
      if (!io) { try { ws.close(); } catch (_) { /* noop */ } return; }
      io.transport = 'local';
      pty.attachPty({ ...p, terminalProtocol: 3 }, io).catch((e) => {
        console.error(`[term-local] attach 실패: ${(e && e.message) || e}`);
        try { io.close(); } catch (_) { /* noop */ }
      });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    state = { port, token };
    try {
      const cfg = config.load() || {};
      config.save({ ...cfg, terminalLocal: { port, token, protocol: 3 } });
    } catch (e) { console.warn(`[term-local] daemon.json 기록 실패: ${e.message}`); }
    console.log(`[term-local] PC 로컬 터미널 리스너 127.0.0.1:${port}`);
  });
  server.on('error', (e) => console.error(`[term-local] 리스너 오류: ${e.message}`));
  return state;
}

function stop() {
  try { wss && wss.close(); } catch (_) { /* noop */ }
  try { server && server.close(); } catch (_) { /* noop */ }
  server = null; wss = null; state = null;
}

module.exports = { start, stop, current: () => state, parseParams };
