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

const proxyPermission = (payload) => postJson('/permission', payload);
const getFile = ({ userId, projectId, path }) => {
  const qs = new URLSearchParams();
  if (path != null) qs.set('path', String(path));
  if (projectId != null) qs.set('projectId', String(projectId));
  if (userId != null) qs.set('userId', String(userId));
  return getJson(`/file?${qs.toString()}`);
};

module.exports = { isEnabled, proxyQuery, proxyPermission, getFile, WORKER_URL };
