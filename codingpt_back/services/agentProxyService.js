/**
 * 에이전트 워커 프록시 (M3-full Phase 1)
 *
 * back 이 /api/agent/* 요청을 agent-worker 로 전달한다.
 *  - proxyQuery: 워커 /query 의 SSE 를 라인 파싱해 onEvent 로 흘림 (executeService.js 패턴)
 *  - proxyPermission: 워커 /permission 으로 forward
 *  - getFile: 워커 /file 로 forward
 *
 * AGENT_WORKER_URL 미설정 시 컨트롤러가 이 프록시 대신 agentService 를 직접 호출(폴백).
 */
const http = require('http');
const { URL } = require('url');

const WORKER_URL = process.env.AGENT_WORKER_URL || 'http://agent-worker:5400';

function isEnabled() {
  return !!process.env.AGENT_WORKER_URL;
}

function postJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WORKER_URL}${pathname}`);
    const body = JSON.stringify(payload || {});
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c.toString(); });
        res.on('end', () => {
          let json = {};
          try { json = data ? JSON.parse(data) : {}; } catch (_) { /* noop */ }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WORKER_URL}${pathname}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c.toString(); });
        res.on('end', () => {
          let json = {};
          try { json = data ? JSON.parse(data) : {}; } catch (_) { /* noop */ }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 워커 /query SSE 프록시. 파싱된 이벤트 객체를 그대로 onEvent 로 전달.
 * abortController.abort() 시 업스트림 요청을 끊는다(앱→back 끊김 전파).
 * @returns {Promise<void>} 스트림 종료 시 resolve
 */
function proxyQuery(payload, { onEvent, abortController } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WORKER_URL}/query`);
    const body = JSON.stringify(payload || {});

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c.toString(); });
          res.on('end', () => {
            let msg = `에이전트 워커 오류 (${res.statusCode})`;
            try { const j = JSON.parse(errBody); if (j && j.message) msg = j.message; } catch (_) { /* noop */ }
            if (onEvent) onEvent({ type: 'error', message: msg });
            resolve();
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            try {
              const evt = JSON.parse(t.slice(5).trim());
              if (onEvent) onEvent(evt);
            } catch (err) {
              console.error('[agentProxyService] SSE 파싱 오류:', err, '라인:', t);
            }
          }
        });
        res.on('end', () => {
          const t = buffer.trim();
          if (t.startsWith('data:')) {
            try { const evt = JSON.parse(t.slice(5).trim()); if (onEvent) onEvent(evt); } catch (_) { /* noop */ }
          }
          resolve();
        });
        res.on('error', (err) => {
          if (onEvent) onEvent({ type: 'error', message: `워커 연결 오류: ${err.message}` });
          resolve();
        });
      },
    );

    req.on('error', (err) => {
      if (onEvent) onEvent({ type: 'error', message: `에이전트 워커 연결 실패: ${err.message} (${WORKER_URL})` });
      resolve();
    });

    // 앱→back 끊김 전파 → 업스트림(back→워커) 요청 끊기 → 워커 query() abort
    if (abortController && abortController.signal) {
      abortController.signal.addEventListener('abort', () => {
        try { req.destroy(); } catch (_) { /* noop */ }
      });
    }

    req.write(body);
    req.end();
  });
}

// ── dev 서버(미리보기) ──
const startDev = (payload) => postJson('/dev/start', payload);   // { userId, projectId }
const stopDev = (payload) => postJson('/dev/stop', payload);     // { userId }

// ── 멀티 터미널(tmux 윈도우) + 포트 감지 ──
const listTerminals = ({ userId, projectId }) => {
  const qs = new URLSearchParams();
  if (userId != null) qs.set('userId', String(userId));
  if (projectId != null) qs.set('projectId', String(projectId));
  return getJson(`/terminals?${qs.toString()}`);
};
const portForward = (payload) => postJson('/portforward', payload);         // { userId, port } → { exposed }
const newTerminal = (payload) => postJson('/terminals/new', payload);       // { userId, projectId }
const selectTerminal = (payload) => postJson('/terminals/select', payload); // { userId, index }
const closeTerminal = (payload) => postJson('/terminals/close', payload);   // { userId, index }
const clearTerminal = (payload) => postJson('/terminals/clear', payload);   // { userId }
const listPorts = ({ userId, projectId }) => {
  const qs = new URLSearchParams();
  if (userId != null) qs.set('userId', String(userId));
  if (projectId != null) qs.set('projectId', String(projectId));
  return getJson(`/ports?${qs.toString()}`);
};

/**
 * 미리보기 dev 서버 HTTP 프록시. back 의 원본 경로(/api/preview/<token>/...)를 보존해
 * 워커 /devproxy 로 포워딩(워커가 다시 샌드박스로). 요청/응답 스트림 그대로 파이프.
 *   port/basePath 지정 시(수동 감지 포트) → 워커가 그 포트로 프록시 + HTML <base> 주입(상대경로 보정).
 */
function proxyDev(req, res, { userId, port, basePath } = {}) {
  const url = new URL(`${WORKER_URL}/devproxy${req.originalUrl}`);
  const headers = { ...req.headers, 'x-user-id': String(userId) };
  if (port) headers['x-target-port'] = String(port);
  if (basePath) headers['x-base-path'] = String(basePath);
  delete headers.host;
  const upstream = http.request(
    { hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers, timeout: 35000 },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => { if (!res.headersSent) res.status(502).end('preview proxy error: ' + e.message); else { try { res.end(); } catch (_) { /* noop */ } } });
  upstream.on('timeout', () => { try { upstream.destroy(); } catch (_) { /* noop */ } });
  req.pipe(upstream);
}

/**
 * 샌드박스 터미널 SSE 프록시 — 워커 /sandbox/exec 의 이벤트 스트림을 그대로 클라이언트로 파이프.
 * payload: { userId, projectId, command, cwd }
 */
function proxyExec(payload, res) {
  const url = new URL(`${WORKER_URL}/sandbox/exec`);
  const body = JSON.stringify(payload || {});
  const upstream = http.request(
    {
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    try { res.write(`data: ${JSON.stringify({ type: 'error', message: '워커 연결 실패: ' + e.message })}\n\n`); } catch (_) { /* noop */ }
    try { res.end(); } catch (_) { /* noop */ }
  });
  // 클라이언트가 끊으면 업스트림도 끊는다(워커 exec 는 120s 캡으로 자동 종료).
  res.on('close', () => { try { upstream.destroy(); } catch (_) { /* noop */ } });
  upstream.write(body);
  upstream.end();
}

/**
 * 미리보기 HMR(WebSocket) 업그레이드 프록시 — back 의 ws 업그레이드를 워커 /devproxy 로 포워딩.
 * 워커가 다시 샌드박스 dev 서버 ws 로 연결한다. (Vite 핫리로드용)
 */
function proxyDevWs(req, socket, head, { userId } = {}) {
  const url = new URL(`${WORKER_URL}/devproxy${req.url}`);
  const headers = { ...req.headers, 'x-user-id': String(userId) };
  delete headers.host;
  const proxyReq = http.request({
    hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: 'GET', headers, timeout: 0,
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}`.trim()];
    for (const [k, v] of Object.entries(proxyRes.headers || {})) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    const cleanup = () => { try { proxySocket.destroy(); } catch (_) { /* noop */ } try { socket.destroy(); } catch (_) { /* noop */ } };
    proxySocket.on('error', cleanup); socket.on('error', cleanup);
    proxySocket.on('close', cleanup); socket.on('close', cleanup);
  });
  proxyReq.on('error', () => { try { socket.destroy(); } catch (_) { /* noop */ } });
  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
}

/**
 * 인터랙티브 터미널(PTY) WebSocket 업그레이드 프록시 — back 의 ws 업그레이드를 워커 /termproxy 로 포워딩.
 * 워커가 ws 를 종단하고 사용자 샌드박스의 TTY 셸에 브리지한다. (proxyDevWs 와 동일 구조, 투명 파이프)
 */
function proxyTerminalWs(req, socket, head, { userId, projectId } = {}) {
  const url = new URL(`${WORKER_URL}/termproxy`);
  const headers = { ...req.headers, 'x-user-id': String(userId), 'x-project-id': String(projectId == null ? '' : projectId) };
  delete headers.host;
  const proxyReq = http.request({
    hostname: url.hostname, port: url.port || 80, path: '/termproxy', method: 'GET', headers, timeout: 0,
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}`.trim()];
    for (const [k, v] of Object.entries(proxyRes.headers || {})) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    const cleanup = () => { try { proxySocket.destroy(); } catch (_) { /* noop */ } try { socket.destroy(); } catch (_) { /* noop */ } };
    proxySocket.on('error', cleanup); socket.on('error', cleanup);
    proxySocket.on('close', cleanup); socket.on('close', cleanup);
  });
  proxyReq.on('error', () => { try { socket.destroy(); } catch (_) { /* noop */ } });
  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
}

const proxyPermission = (payload) => postJson('/permission', payload);
const writeFile = (payload) => postJson('/file', payload); // { userId, projectId, path, content }
const getFile = ({ userId, projectId, path }) => {
  const qs = new URLSearchParams();
  if (path != null) qs.set('path', String(path));
  if (projectId != null) qs.set('projectId', String(projectId));
  if (userId != null) qs.set('userId', String(userId));
  return getJson(`/file?${qs.toString()}`);
};
const listFiles = ({ userId, projectId }) => {
  const qs = new URLSearchParams();
  if (projectId != null) qs.set('projectId', String(projectId));
  if (userId != null) qs.set('userId', String(userId));
  return getJson(`/files?${qs.toString()}`);
};

module.exports = {
  isEnabled, proxyQuery, proxyPermission, getFile, listFiles, writeFile,
  startDev, stopDev, proxyDev, proxyDevWs, proxyTerminalWs, proxyExec,
  listTerminals, newTerminal, selectTerminal, closeTerminal, clearTerminal, listPorts, portForward,
  WORKER_URL,
};
