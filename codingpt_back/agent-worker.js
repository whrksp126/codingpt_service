/**
 * 샌드박스/프리뷰 워커 서버 (러너 인프라)
 *
 * 사용자 코드의 dev 서버·멀티 터미널·인터랙티브 PTY 를 **메인 API 프로세스(back) 밖**
 * 별도 컨테이너의 격리 샌드박스에서 구동한다. back 은 preview/terminal 을 이 워커로
 * SSE/HTTP/WS 프록시(agentProxyService)만 한다. 워크스페이스는 호스트 가시 named volume
 * (/workspace, AGENT_WORKSPACE_ROOT)에 둔다.
 *
 * 구조 선례: executor-server.js(별도 실행 서버) + executeService.js(SSE 프록시).
 *
 * 보안: 이 워커는 **내부 네트워크 전용**(compose expose 만, ports 매핑 금지).
 *       userId 는 back 이 인증 후 신뢰 가능한 값으로 실어 보낸다(워커는 재검증 안 함).
 *
 * 이력: 과거 클라우드 AI 에이전트(우리 키 SDK) 실행부(/query·/permission·/file(s))가 여기 있었으나
 *       BYO 원격 조작 서비스로 피벗하며 전면 제거됨. 남은 preview/sandbox 인프라는 M5 클라우드 러너가 재사용.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const workspaceFs = require('./services/workspaceFsService');
const sandboxManager = require('./services/sandboxManager');

const app = express();
const PORT = process.env.AGENT_WORKER_PORT || 5400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 프로젝트 dir 탐지: 워크스페이스 루트(→ depth1 하위) 중 package.json 에 scripts.dev 가진 dir.
function detectProjectDir(userId, projectId) {
  const base = workspaceFs.workspaceDir(userId, projectId); // /workspace/cpt-agent/<uid>/<projectId> (워커 fs == 샌드박스 경로)
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

/** 포트 포워더 보장(localhost 바인딩 서버를 0.0.0.0 으로 노출) → 노출 포트 반환. body:{ userId, port } */
app.post('/portforward', async (req, res) => {
  const { userId, port } = req.body || {};
  const p = parseInt(port, 10);
  if (userId == null || !Number.isFinite(p)) return res.status(400).json({ success: false, message: 'userId, port 필요' });
  try { const exposed = await sandboxManager.ensurePortForwarder(userId, p); return res.json({ success: true, exposed }); }
  catch (e) { return res.status(500).json({ success: false, message: e.message || '포워더 실패' }); }
});

// ── 멀티 터미널(tmux 윈도우) ─────────────────────────────────────────
// 세션 'cpt' 안의 윈도우 = 터미널 탭. WebView 는 단일 PTY 로 attach 하고 활성 윈도우를 따라간다.
app.get('/terminals', async (req, res) => {
  const { userId, projectId } = req.query;
  if (userId == null) return res.status(400).json({ success: false, message: 'userId 가 필요합니다.' });
  try {
    // 세션이 아직 없으면 윈도우 0 을 프로젝트 dir 에서 생성(워크스페이스 루트엔 package.json 이 없어 npm run dev 가 실패).
    const cwd = detectProjectDir(userId, projectId) || workspaceFs.workspaceDir(userId, projectId);
    const windows = await sandboxManager.listWindows(userId, cwd);
    return res.json({ success: true, windows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || '윈도우 목록 실패' }); }
});

app.post('/terminals/new', async (req, res) => {
  const { userId, projectId, name } = req.body || {};
  if (userId == null) return res.status(400).json({ success: false, message: 'userId 가 필요합니다.' });
  try {
    const cwd = detectProjectDir(userId, projectId) || workspaceFs.workspaceDir(userId, projectId);
    const index = await sandboxManager.newWindow(userId, { name: name || 'shell', cwd });
    return res.json({ success: true, index });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || '윈도우 생성 실패' }); }
});

app.post('/terminals/select', async (req, res) => {
  const { userId, index } = req.body || {};
  if (userId == null || index == null) return res.status(400).json({ success: false, message: 'userId, index 가 필요합니다.' });
  try { await sandboxManager.selectWindow(userId, index); return res.json({ success: true }); }
  catch (e) { return res.status(500).json({ success: false, message: e.message || '윈도우 전환 실패' }); }
});

app.post('/terminals/close', async (req, res) => {
  const { userId, index } = req.body || {};
  if (userId == null || index == null) return res.status(400).json({ success: false, message: 'userId, index 가 필요합니다.' });
  try { await sandboxManager.killWindow(userId, index); return res.json({ success: true }); }
  catch (e) { return res.status(500).json({ success: false, message: e.message || '윈도우 종료 실패' }); }
});

app.post('/terminals/clear', async (req, res) => {
  const { userId } = req.body || {};
  if (userId == null) return res.status(400).json({ success: false, message: 'userId 가 필요합니다.' });
  try { await sandboxManager.clearActiveWindow(userId); return res.json({ success: true }); }
  catch (e) { return res.status(500).json({ success: false, message: e.message || '지우기 실패' }); }
});

/** 샌드박스 LISTEN 포트 감지 — 수동으로 띄운 서버까지 미리보기로 연결하기 위함. */
app.get('/ports', async (req, res) => {
  const { userId } = req.query;
  if (userId == null) return res.status(400).json({ success: false, message: 'userId 가 필요합니다.' });
  try {
    const ports = await sandboxManager.detectListeningPorts(userId);
    const dev = sandboxManager.getDevServer(userId);
    return res.json({ success: true, ports, devPort: dev ? dev.port : null });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || '포트 감지 실패' }); }
});

/**
 * dev 서버 HTTP 프록시. back 이 원본 경로를 보존해 `/devproxy/api/preview/<pid>/...` 로 보낸다.
 * 헤더 x-user-id 로 사용자 샌드박스를 선택 → http://cpt-sandbox-<uid>:<port><원본경로> 로 포워딩.
 */
app.all('/devproxy/*', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (userId == null) return res.status(400).end('x-user-id required');
  // x-target-port: 감지된 임의 포트(수동 서버). 없으면 관리형 dev 서버 포트.
  const targetPort = parseInt(req.headers['x-target-port'], 10);
  const basePath = req.headers['x-base-path'] || ''; // '/api/preview/<token>/' — 임의 포트일 때 <base> 주입 + 경로 prefix 제거
  let port;
  if (Number.isFinite(targetPort) && targetPort > 0) {
    port = targetPort;
  } else {
    const dev = sandboxManager.getDevServer(userId);
    if (!dev) return res.status(503).end('dev server not running');
    port = dev.port;
  }
  let targetPath = req.originalUrl.replace(/^\/devproxy/, '') || '/';
  // 임의 포트(--base 없이 / 에서 서빙)는 토큰 prefix 를 떼고 보낸다. 관리형(vite --base)은 경로 그대로.
  if (basePath && targetPath.startsWith(basePath)) {
    targetPath = '/' + targetPath.slice(basePath.length);
  } else if (basePath && ('/' + basePath.replace(/^\/|\/$/g, '')) === targetPath.replace(/\/$/, '')) {
    targetPath = '/';
  }
  const headers = { ...req.headers };
  delete headers['x-target-port']; delete headers['x-base-path'];
  // Vite 5+ 의 allowedHosts 검증 통과: Host 를 localhost 로(컨테이너명/외부도메인은 차단됨).
  // TCP 연결 대상은 아래 host 옵션(컨테이너명)이고, 이 헤더는 Vite 의 호스트 화이트리스트 체크용.
  headers.host = `localhost:${port}`;
  const containerHost = sandboxManager.containerName(String(userId).replace(/[^A-Za-z0-9_-]/g, '') || 'anon');
  const upstream = http.request(
    { host: containerHost, port, path: targetPath, method: req.method, headers, timeout: 30000 },
    (up) => {
      const ct = String(up.headers['content-type'] || '');
      const isHtml = /text\/html/i.test(ct);
      const isJs = /(javascript|ecmascript)/i.test(ct);
      // 임의 포트(--base 없는 dev 서버)는 에셋을 절대경로(/@vite/client, /src/..)로 emit → 하위경로 프록시에서 깨짐.
      // HTML·JS 응답의 알려진 vite 절대경로를 토큰 경로로 재작성(=runtime --base). gzip(content-encoding) 은 건너뜀.
      if (basePath && (isHtml || isJs) && !up.headers['content-encoding']) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf-8');
          // vite("/@vite/" "/src/" "/node_modules/" "/@fs/" 등) + Next.js("/_next/") + Nuxt("/_nuxt/")
          // 절대 경로 → basePath 접두(=runtime --base). 프레임워크별 best-effort(관리형은 --base 로 정확).
          body = body.replace(
            /(["'`(=])\/(@vite\/|@id\/|@fs\/|@react-refresh|src\/|node_modules\/|\.vite\/|_next\/|_nuxt\/|__nuxt\/|assets\/|vite\.svg|favicon\.ico)/g,
            (m, q, p) => q + basePath + p,
          );
          if (isHtml) {
            const baseTag = `<base href="${basePath}">`;
            if (/<head[^>]*>/i.test(body)) body = body.replace(/<head[^>]*>/i, (m) => m + baseTag);
            else body = baseTag + body;
          }
          const h = { ...up.headers }; delete h['content-length'];
          res.writeHead(up.statusCode || 200, h);
          res.end(body);
        });
        return;
      }
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

  const root = workspaceFs.workspaceDir(userId, projectId);
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

// ── 인터랙티브 PTY 터미널(WebSocket) ──────────────────────────────────
// /termproxy 의 ws 업그레이드를 여기서 종단(ws 라이브러리)하고, 사용자 샌드박스의 TTY 셸에 양방향 브리지.
//  · 클라→PTY: 바이너리 메시지=키 입력(stdin), 텍스트 JSON {type:'resize',cols,rows}=리사이즈.
//  · PTY→클라: raw 바이트(ANSI/readline/탭완성)를 그대로 ws.send.
let TermWss = null;
try { TermWss = new (require('ws').Server)({ noServer: true }); }
catch (_) { console.warn('[agent-worker] ws 미설치 — 인터랙티브 터미널 비활성'); }

async function handleTermWs(ws, userId, projectId) {
  let pty;
  try {
    const baseCwd = detectProjectDir(userId, projectId) || workspaceFs.workspaceDir(userId, projectId);
    pty = await sandboxManager.openPty(userId, { projectId, cwd: baseCwd, cols: 80, rows: 24 });
    console.log(`[agent-worker] termproxy 연결 userId=${userId} projectId=${projectId} cwd=${baseCwd}`);
  } catch (e) {
    console.warn(`[agent-worker] termproxy openPty 실패 userId=${userId}: ${e && e.message ? e.message : e}`);
    try { ws.send('\r\n\x1b[31m터미널을 열 수 없습니다: ' + (e && e.message ? e.message : e) + '\x1b[0m\r\n'); ws.close(); } catch (_) { /* noop */ }
    return;
  }
  const { exec, stream } = pty;
  const openedAt = Date.now();
  const onOut = (chunk) => { try { if (ws.readyState === 1) ws.send(chunk); } catch (_) { /* noop */ } };
  stream.on('data', onOut);
  stream.on('end', () => { console.log(`[agent-worker] termproxy PTY stream END userId=${userId} aliveMs=${Date.now() - openedAt}`); try { ws.close(); } catch (_) { /* noop */ } });
  stream.on('error', (e) => { console.log(`[agent-worker] termproxy PTY stream ERROR userId=${userId}: ${e && e.message}`); try { ws.close(); } catch (_) { /* noop */ } });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { try { stream.write(data); } catch (_) { /* noop */ } return; }
    const str = data.toString();
    try {
      const m = JSON.parse(str);
      if (m && m.type === 'resize' && m.cols && m.rows) { exec.resize({ h: m.rows | 0, w: m.cols | 0 }).catch(() => {}); return; }
    } catch (_) { /* JSON 아니면 일반 입력으로 폴백 */ }
    try { stream.write(str); } catch (_) { /* noop */ }
  });
  // Keepalive — Cloudflare 는 유휴 WebSocket 을 ~100초 후 끊는다. ping 으로 살려둔다(유휴 터미널 세션 유지).
  const ka = setInterval(() => { try { if (ws.readyState === 1) ws.ping(); } catch (_) { /* noop */ } }, 30000);
  const cleanup = () => { try { clearInterval(ka); } catch (_) { /* noop */ } try { stream.end(); } catch (_) { /* noop */ } try { stream.destroy(); } catch (_) { /* noop */ } };
  ws.on('close', (code, reason) => { console.log(`[agent-worker] termproxy WS CLOSE userId=${userId} code=${code} reason=${reason} aliveMs=${Date.now() - openedAt}`); cleanup(); });
  ws.on('error', (e) => { console.log(`[agent-worker] termproxy WS ERROR userId=${userId}: ${e && e.message}`); cleanup(); });
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 [agent-worker] listening on :${PORT} (workspaceRoot=${process.env.AGENT_WORKSPACE_ROOT || 'tmp'})`);
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  // 인터랙티브 터미널 — ws 종단 후 PTY 브리지.
  if (url === '/termproxy' || url.startsWith('/termproxy/')) {
    const userId = req.headers['x-user-id'];
    const projectId = req.headers['x-project-id'] || null;
    if (!TermWss || userId == null || !sandboxManager.isEnabled()) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
    TermWss.handleUpgrade(req, socket, head, (ws) => { handleTermWs(ws, userId, projectId); });
    return;
  }
  // 미리보기 HMR — Vite dev 서버로 ws 포워딩.
  if (url === '/devproxy' || url.startsWith('/devproxy/')) {
    const userId = req.headers['x-user-id'];
    const dev = userId != null ? sandboxManager.getDevServer(userId) : null;
    if (!dev) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
    const targetPath = url.replace(/^\/devproxy/, '') || '/';
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
    return;
  }
  try { socket.destroy(); } catch (_) { /* noop */ }
});
