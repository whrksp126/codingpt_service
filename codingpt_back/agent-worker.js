/**
 * 바이브코딩 에이전트 워커 서버 (M3-full Phase 1)
 *
 * Agent SDK query() 를 **메인 API 프로세스(back) 밖** 별도 컨테이너에서 실행한다.
 * back 은 /api/agent/* 를 이 워커로 SSE/HTTP 프록시(agentProxyService)만 한다.
 * 워크스페이스는 호스트 가시 named volume(/workspace, AGENT_WORKSPACE_ROOT)에 둔다.
 *
 * 구조 선례: executor-server.js(별도 실행 서버) + executeService.js(SSE 프록시).
 *
 * 보안: 이 워커는 **내부 네트워크 전용**(compose expose 만, ports 매핑 금지).
 *       userId 는 back 이 인증 후 신뢰 가능한 값으로 실어 보낸다(워커는 재검증 안 함).
 *
 * 주의: pendingPermissions(승인 대기)는 이 프로세스 메모리에 있으므로 **단일 인스턴스(replica=1)** 유지.
 *       /query 의 permission_request 와 /permission 응답이 같은 워커 프로세스에서 처리돼야 한다.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const agentService = require('./services/agentService');
const sandboxManager = require('./services/sandboxManager');

const app = express();
const PORT = process.env.AGENT_WORKER_PORT || 5400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 프로젝트 dir 탐지: 워크스페이스 루트(→ depth1 하위) 중 package.json 에 scripts.dev 가진 dir.
function detectProjectDir(userId, projectId) {
  const base = agentService.workspaceDir(userId, projectId); // /workspace/cpt-agent/<uid>/<projectId> (워커 fs == 샌드박스 경로)
  const hasDevScript = (dir) => {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      return !!(pj && pj.scripts && typeof pj.scripts.dev === 'string');
    } catch (_) { return false; }
  };
  if (hasDevScript(base)) return base;
  try {
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name !== 'node_modules' && !ent.name.startsWith('.')) {
        const d = path.join(base, ent.name);
        if (hasDevScript(d)) return d;
      }
    }
  } catch (_) { /* base 없음 등 */ }
  return null;
}

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'agent-worker', workspaceRoot: process.env.AGENT_WORKSPACE_ROOT || '(tmp)' });
});

/**
 * 에이전트 실행 — SDKMessage 를 SSE 로 스트리밍.
 * body: { prompt, userId, projectId, files, model, resumeSessionId, autoApprove }
 */
app.post('/query', async (req, res) => {
  const { prompt, userId, projectId, files, model, mode, resumeSessionId, autoApprove } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, message: '프롬프트가 필요합니다.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      success: false,
      message: 'ANTHROPIC_API_KEY 가 설정되지 않았습니다. 워커 .env 에 추가 후 재시작하세요.',
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (o) => {
    try {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
    } catch (_) {
      /* noop */
    }
  };

  // 클라이언트(back 프록시)가 끊으면 query() 중단. 정상 종료(finished)면 abort 안 함.
  const abortController = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) {
      try {
        abortController.abort();
      } catch (_) {
        /* noop */
      }
    }
  });

  try {
    await agentService.runAgentQuery({
      prompt,
      userId,
      projectId,
      seedFiles: files,
      model,
      mode,
      resumeSessionId,
      autoApprove: !!autoApprove,
      abortController,
      onEvent: send,
    });
  } catch (error) {
    console.error('[agent-worker] 에이전트 실행 오류:', error);
    send({ type: 'error', message: error.message || '에이전트 실행 중 오류가 발생했습니다.' });
  } finally {
    finished = true;
    try {
      res.end();
    } catch (_) {
      /* noop */
    }
  }
});

/**
 * 수정 승인 응답 — 대기 중인 canUseTool 해소.
 * body: { requestId, userId, decision, message }
 */
app.post('/permission', (req, res) => {
  const { requestId, userId, decision, message } = req.body || {};
  if (!requestId || (decision !== 'allow' && decision !== 'deny')) {
    return res.status(400).json({ success: false, message: 'requestId 와 decision(allow|deny) 이 필요합니다.' });
  }
  const ok = agentService.resolvePermissionResponse(requestId, userId, decision, message);
  if (!ok) {
    return res.status(404).json({ success: false, message: '대기 중인 승인 요청을 찾을 수 없습니다.' });
  }
  return res.json({ success: true, requestId, decision });
});

/**
 * 워크스페이스 파일 읽기 — 에이전트 편집 후 에디터 동기화용.
 * GET /file?path=<rel>&projectId=<id>&userId=<id>
 */
app.get('/file', (req, res) => {
  const { path: relPath, projectId, userId } = req.query;
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ success: false, message: 'path 가 필요합니다.' });
  }
  try {
    const content = agentService.readWorkspaceFile(userId, projectId, relPath);
    return res.json({ success: true, path: relPath, content });
  } catch (error) {
    const notFound = error.code === 'ENOENT';
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: notFound ? '파일을 찾을 수 없습니다.' : error.message || '파일을 읽을 수 없습니다.',
    });
  }
});

/**
 * 워크스페이스 파일 쓰기 — IDE 에디터 편집을 샌드박스 FS 에 반영(dev 서버/HMR 이 감지).
 * POST /file  body: { path, content, projectId, userId }
 */
app.post('/file', (req, res) => {
  const { path: relPath, content, projectId, userId } = req.body || {};
  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ success: false, message: 'path 가 필요합니다.' });
  }
  try {
    agentService.writeWorkspaceFile(userId, projectId, relPath, content);
    return res.json({ success: true, path: relPath });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || '파일을 쓸 수 없습니다.' });
  }
});

// ── dev 서버(미리보기) ──────────────────────────────────────────────
// 샌드박스에서 npm run dev 를 띄우고, /devproxy 로 그 포트를 프록시한다.
// back 이 userId 를 인증 후 실어 보낸다(워커는 재검증 안 함).

/**
 * dev 서버 기동 + 준비여부 반환(멱등 — 같은 projectId면 재기동 안 함).
 * body: { userId, projectId }
 * → { mode:'static' } (dev 스크립트 없음) | { mode:'dev', ready:boolean, port?, log? }
 */
app.post('/dev/start', async (req, res) => {
  const { userId, projectId, basePath: basePathIn, hmr } = req.body || {};
  if (userId == null || !projectId) {
    return res.status(400).json({ success: false, message: 'userId, projectId 가 필요합니다.' });
  }
  if (!sandboxManager.isEnabled()) {
    return res.json({ mode: 'static', reason: 'sandbox-disabled' });
  }
  const dir = detectProjectDir(userId, projectId);
  if (!dir) {
    return res.json({ mode: 'static' }); // 정적(순수 HTML) 폴백
  }
  // Vite base = 프록시 경로(back 이 발급한 토큰 경로). 미지정이면 projectId 경로.
  const basePath = basePathIn || `/api/preview/${projectId}/`;
  try {
    const cur = sandboxManager.getDevServer(userId);
    if (!cur || cur.projectId !== projectId || cur.basePath !== basePath) {
      await sandboxManager.startDevServer(userId, { projectId, dir, basePath, hmr });
    }
    const dev = sandboxManager.getDevServer(userId) || {};
    const port = dev.port || 5173;
    // 요청 내 짧은 폴링만(≤6s) — 앱이 짧은 간격으로 재호출(멱등)하며 폴링을 주도. 긴 블로킹으로 인한
    // 앱 HTTP 타임아웃(socket hang up) 방지. 첫 호출은 기동을 시작만 하고 대개 ready:false 로 빠르게 반환.
    const deadline = Date.now() + 6000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await sandboxManager.isDevReady(userId, port, basePath)) { ready = true; break; }
      await sleep(1200);
    }
    if (ready) return res.json({ mode: 'dev', ready: true, port });
    const log = await sandboxManager.readDevLog(userId, 30);
    return res.json({ mode: 'dev', ready: false, port, log });
  } catch (e) {
    console.error('[agent-worker] dev/start 오류:', e);
    return res.status(500).json({ success: false, message: e.message || 'dev 서버 기동 실패' });
  }
});

/** dev 서버 종료. body: { userId } */
app.post('/dev/stop', async (req, res) => {
  const { userId } = req.body || {};
  try { await sandboxManager.stopDevServer(userId); } catch (_) { /* noop */ }
  return res.json({ success: true });
});

/**
 * dev 서버 HTTP 프록시. back 이 원본 경로를 보존해 `/devproxy/api/preview/<pid>/...` 로 보낸다.
 * 헤더 x-user-id 로 사용자 샌드박스를 선택 → http://cpt-sandbox-<uid>:<port><원본경로> 로 포워딩.
 */
app.all('/devproxy/*', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (userId == null) return res.status(400).end('x-user-id required');
  const dev = sandboxManager.getDevServer(userId);
  if (!dev) return res.status(503).end('dev server not running');
  const targetPath = req.originalUrl.replace(/^\/devproxy/, '') || '/';
  const headers = { ...req.headers };
  // Vite 5+ 의 allowedHosts 검증 통과: Host 를 localhost 로(컨테이너명/외부도메인은 차단됨).
  // TCP 연결 대상은 아래 host 옵션(컨테이너명)이고, 이 헤더는 Vite 의 호스트 화이트리스트 체크용.
  headers.host = `localhost:${dev.port}`;
  const upstream = http.request(
    { host: sandboxManager.containerName(String(userId).replace(/[^A-Za-z0-9_-]/g, '') || 'anon'), port: dev.port, path: targetPath, method: req.method, headers, timeout: 30000 },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => { if (!res.headersSent) res.status(502).end('dev proxy error: ' + e.message); else res.end(); });
  upstream.on('timeout', () => { try { upstream.destroy(); } catch (_) { /* noop */ } });
  req.pipe(upstream);
});

// ── 샌드박스 터미널(실셸) ───────────────────────────────────────────
// 모바일 IDE 터미널이 임의 명령을 샌드박스에서 실행하고 출력을 SSE 로 스트리밍한다.
// cd 추적: 명령 끝에 pwd 를 마커로 찍어 {type:'cwd'} 로 전달(출력에선 숨김) → 다음 호출에 그 cwd 를 보냄.
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
const TERM_PID_FILE = '/tmp/term.pid'; // 실행 중 터미널 명령의 세션 리더 pid(중지 시 그룹 kill)

app.post('/sandbox/exec', async (req, res) => {
  const { userId, projectId, command, cwd } = req.body || {};
  if (userId == null || !command || typeof command !== 'string') {
    return res.status(400).json({ success: false, message: 'userId, command 가 필요합니다.' });
  }
  if (!sandboxManager.isEnabled()) {
    return res.status(503).json({ success: false, message: '샌드박스가 비활성화되어 있습니다.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch (_) { /* noop */ } };

  const root = agentService.workspaceDir(userId, projectId);
  // 시작 cwd: 지정 없으면 프로젝트 dir(package.json 있는 곳), 없으면 워크스페이스 루트.
  const baseCwd = cwd || detectProjectDir(userId, projectId) || root;
  send({ type: 'start', cwd: baseCwd });

  // cd <cwd> (실패 시 루트) → 명령 실행 → 끝에서 pwd 마커. subshell 미사용으로 cd 가 cwd 를 갱신.
  const inner =
    `echo $$ > ${TERM_PID_FILE}; `
    + `cd ${shq(baseCwd)} 2>/dev/null || cd ${shq(root)} 2>/dev/null; `
    + `${command}\n__rc=$?; printf '\\n__CWD__:%s\\n' "$(pwd)"; exit $__rc`;
  // setsid -w: 명령을 새 세션/프로세스 그룹 리더로(=$$=pgid) + 종료까지 대기(스트리밍 유지).
  // → Ctrl+C(중지) 시 그 그룹을 통째로 kill 해 자식까지 즉시 종료 가능.
  const wrapped = `setsid -w bash -lc ${shq(inner)}`;

  let lineBuf = '';
  let capturedCwd = null;
  const onData = (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (line.startsWith('__CWD__:')) capturedCwd = line.slice(8);
      else send({ type: 'output', data: line + '\n' });
    }
  };

  // 클라이언트가 끊으면(중지 버튼=XHR abort) 실행 중 프로세스 그룹을 SIGINT→SIGKILL 로 즉시 종료.
  let finished = false;
  res.on('close', () => {
    if (finished) return;
    const killCmd =
      `p=$(cat ${TERM_PID_FILE} 2>/dev/null); [ -n "$p" ] && { `
      + `kill -INT -"$p" 2>/dev/null; kill -INT "$p" 2>/dev/null; sleep 0.3; `
      + `kill -KILL -"$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; }; true`;
    sandboxManager.execBash(userId, killCmd).catch(() => { /* noop */ });
  });

  try {
    const r = await sandboxManager.execBash(userId, wrapped, { onData });
    if (lineBuf) {
      if (lineBuf.startsWith('__CWD__:')) capturedCwd = lineBuf.slice(8);
      else send({ type: 'output', data: lineBuf });
    }
    if (capturedCwd) send({ type: 'cwd', cwd: capturedCwd });
    send({ type: 'done', exitCode: r.exitCode, timedOut: r.timedOut });
  } catch (e) {
    console.error('[agent-worker] /sandbox/exec 오류:', e);
    send({ type: 'error', message: e.message || '명령 실행 실패' });
  } finally {
    finished = true;
    try { res.end(); } catch (_) { /* noop */ }
  }
});

// ── HMR(WebSocket) 프록시 ─────────────────────────────────────────────
// Vite HMR 은 WebSocket 으로 변경을 푸시한다. /devproxy 경로의 ws 업그레이드를 샌드박스 dev 서버로 포워딩.
function pipeUpgrade(clientSocket, proxyRes, proxySocket, proxyHead) {
  const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || ''}`.trim()];
  for (const [k, v] of Object.entries(proxyRes.headers || {})) {
    if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
    else lines.push(`${k}: ${v}`);
  }
  clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
  if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
  proxySocket.pipe(clientSocket);
  clientSocket.pipe(proxySocket);
  const cleanup = () => { try { proxySocket.destroy(); } catch (_) { /* noop */ } try { clientSocket.destroy(); } catch (_) { /* noop */ } };
  proxySocket.on('error', cleanup); clientSocket.on('error', cleanup);
  proxySocket.on('close', cleanup); clientSocket.on('close', cleanup);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 [agent-worker] listening on :${PORT} (workspaceRoot=${process.env.AGENT_WORKSPACE_ROOT || 'tmp'})`);
});

server.on('upgrade', (req, socket, head) => {
  if (!(req.url === '/devproxy' || req.url.startsWith('/devproxy/'))) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  const userId = req.headers['x-user-id'];
  const dev = userId != null ? sandboxManager.getDevServer(userId) : null;
  if (!dev) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
  const targetPath = req.url.replace(/^\/devproxy/, '') || '/';
  const headers = { ...req.headers };
  headers.host = `localhost:${dev.port}`; // Vite allowedHosts 통과(컨테이너명 차단)
  const uidSafe = String(userId).replace(/[^A-Za-z0-9_-]/g, '') || 'anon';
  const proxyReq = http.request({
    host: sandboxManager.containerName(uidSafe), port: dev.port, path: targetPath, method: 'GET', headers, timeout: 0,
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => pipeUpgrade(socket, proxyRes, proxySocket, proxyHead));
  proxyReq.on('error', () => { try { socket.destroy(); } catch (_) { /* noop */ } });
  if (head && head.length) proxyReq.write(head);
  proxyReq.end();
});
