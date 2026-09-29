/**
 * BYO 에이전트 채널 — 사용자 자신의 로컬 `claude` CLI 를 구조화 모드로 spawn 한다.
 *
 * ToS 경계(codingpt_daemon/CLAUDE.md): 실행은 사용자 PC·사용자 구독. 자격증명(Keychain·~/.claude
 * OAuth)은 읽지도 옮기지도 않는다. 우리는 claude 의 stdout(stream-json)을 8-이벤트로 정규화해
 * 제어 WS 로 push 하고, stdin(stream-json)으로 폰의 메시지·승인을 되돌려 넣을 뿐이다.
 *
 * 이벤트 계약(runner-contract §5.2 / 앱 services/agentService.ts AgentEvent 와 1:1):
 *   agent_init / text / thinking / tool_use / tool_result / permission_request / done / error
 *
 * 승인: claude 를 `--permission-prompt-tool` + 번들 MCP(lib/approval-mcp.js)로 띄운다.
 *   게이트된 도구 호출 → MCP → 유닉스소켓 → 여기서 permission_request 이벤트 → 앱 승인 → 결정 반환.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const fsLib = require('./fs');
const runtime = require('./runtime');
const sockPathLib = require('./sock-path');
const { spawnCli, execFileCliSync, ptyCommand, killTree } = require('./spawn-util');

const NODE_BIN = process.execPath;
const APPROVAL_MCP = path.join(__dirname, 'approval-mcp.js');
// win32 는 named pipe(\\.\pipe\cpt-approval-<pid>) — 계약 2. darwin/linux 는 기존 tmpdir 소켓 그대로.
const APPROVAL_SOCK = sockPathLib.approvalSockPath(process.pid);

// claude 바이너리 좌표 — darwin 은 기존 그대로 'claude'(PATH 조회). win32 는 .cmd shim 일 수 있어
//  PATH 이름만으로는 spawn 이 안 된다(EINVAL) → 감지 카탈로그(agents.js)로 절대경로를 확정한다.
function claudeBin() {
  if (process.env.CODINGPT_CLAUDE_BIN) return process.env.CODINGPT_CLAUDE_BIN;
  if (process.platform === 'win32') {
    try { const p = require('./agents').resolveBinSync('claude'); if (p) return p; } catch (_) { /* 폴백 */ }
  }
  return 'claude';
}
const MAX_LOG = 3000;        // 세션별 이벤트 링버퍼(백로그 리플레이용 — 인메모리)
const COALESCE_MS = 50;      // 텍스트 델타 코얼레싱 주기
const INIT_TIMEOUT_MS = 15000;
// ── 세션 이벤트 로그 영속화(M3-2) — 데몬 재시작/세션 종료 후에도 리플레이 ──
//  우리 정규화 이벤트(seq 부여)를 사용자 PC ~/.codingpt/sessions/<id>.jsonl 에 append.
//  (claude 원본 대화는 ~/.claude/projects 에 별도로 있고, 이건 우리 이벤트 스트림의 사본.)
const sessionsDir = () => path.join(runtime.stateDir(), 'sessions'); // 지연 평가(로컬=~/.codingpt, 클라우드=주입)
const SESSION_RETAIN_MS = 30 * 24 * 60 * 60 * 1000; // 30일 지난 세션 로그는 정리

function sessionFile(id) {
  const safe = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(sessionsDir(), safe + '.jsonl');
}
// 프레임 1건을 디스크에 append(순서 보존). 실패해도 이벤트 흐름을 막지 않는다.
function persistFrame(id, frame) {
  if (!id) return;
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); fs.appendFileSync(sessionFile(id), JSON.stringify(frame) + '\n'); }
  catch (_) { /* 영속 실패는 무시(라이브 전달은 계속) */ }
}
// 디스크 로그 읽기 → 프레임 배열. 파일 없으면 null.
function readPersisted(id) {
  let raw;
  try { raw = fs.readFileSync(sessionFile(id), 'utf8'); } catch (_) { return null; }
  const out = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) { /* 손상 라인 스킵 */ } }
  return out;
}
// 디스크 로그의 마지막 seq(이어받기 seq 연속성용). 없으면 0.
function lastSeqOf(id) {
  const frames = readPersisted(id);
  if (!frames || !frames.length) return 0;
  let max = 0; for (const f of frames) if (typeof f.seq === 'number' && f.seq > max) max = f.seq;
  return max;
}
// 오래된 세션 로그 정리(데몬 기동 시 1회).
function pruneSessionLogs() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(sessionsDir())) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(sessionsDir(), f);
      try { if (now - fs.statSync(full).mtimeMs > SESSION_RETAIN_MS) fs.unlinkSync(full); } catch (_) { /* noop */ }
    }
  } catch (_) { /* 디렉토리 없음 등 무시 */ }
}
pruneSessionLogs();

// sessionId(claude session_id) → session
const sessions = new Map();
// spawnId → session (init 전 승인/상관용)
const spawns = new Map();
// requestId → { socket }  (대기 중 승인)
const pendingApprovals = new Map();

let pushWs = null;           // 현재 제어 WS (이벤트 push 대상). 재접속 시 갱신.
let approvalServer = null;

// ── 이벤트 push ────────────────────────────────────────────────────
function rawSend(obj) {
  if (pushWs && pushWs.readyState === 1) {
    try { pushWs.send(JSON.stringify(obj)); } catch (_) { /* noop */ }
  }
}

// 세션 로그에 적재(seq++) + 디스크 영속(M3-2) + 제어 WS push. must-not-drop = 로그+agent.backlog.
function emit(session, event) {
  const seq = ++session.seq;
  const frame = { type: 'agent_event', sessionId: session.id, seq, event };
  session.log.push(frame);
  if (session.log.length > MAX_LOG) session.log.shift();
  persistFrame(session.id, frame); // 재시작/세션종료 후에도 리플레이 가능하게 디스크에 남긴다
  rawSend(frame);
}

// 텍스트 델타 코얼레싱 — 토큰 단위 push 폭주 방지.
function flushText(session) {
  if (session._textBuf) { const t = session._textBuf; session._textBuf = ''; emit(session, { type: 'text', role: 'assistant', text: t }); }
  if (session._thinkBuf) { const t = session._thinkBuf; session._thinkBuf = ''; emit(session, { type: 'thinking', text: t }); }
  if (session._flushTimer) { clearTimeout(session._flushTimer); session._flushTimer = null; }
}
function pushTextDelta(session, kind, delta) {
  if (kind === 'text') session._textBuf = (session._textBuf || '') + delta;
  else session._thinkBuf = (session._thinkBuf || '') + delta;
  if (!session._flushTimer) session._flushTimer = setTimeout(() => flushText(session), COALESCE_MS);
}

// ── claude stream-json → 8-이벤트 매핑 ──────────────────────────────
function relPathOf(input) {
  const p = input && (input.file_path || input.path || input.notebook_path);
  if (!p) return null;
  try { return fsLib.relOf(p); } catch (_) { return null; }
}
// 앱 services/agentService.ts 의 AgentDiff 스키마와 1:1.
//  write:{kind,oldContent,newContent} / edit:{kind,oldString,newString} / multiedit:{kind,edits:[{oldString,newString}]}
function buildDiff(tool, input) {
  if (!input) return null;
  if (tool === 'Write') {
    let oldContent = '';
    try { const abs = fsLib.safeResolve(fsLib.relOf(input.file_path)); oldContent = fs.readFileSync(abs, 'utf-8'); } catch (_) { /* 신규 파일 */ }
    return { kind: 'write', oldContent, newContent: String(input.content ?? '') };
  }
  if (tool === 'Edit') return { kind: 'edit', oldString: String(input.old_string ?? ''), newString: String(input.new_string ?? '') };
  if (tool === 'MultiEdit') return { kind: 'multiedit', edits: (input.edits || []).map((e) => ({ oldString: String(e.old_string ?? ''), newString: String(e.new_string ?? '') })) };
  return null;
}

function handleClaudeMessage(session, o) {
  if (!o || typeof o.type !== 'string') return;
  switch (o.type) {
    case 'system':
      if (o.subtype === 'init') {
        if (!session.id && o.session_id) bindSessionId(session, o.session_id);
        emit(session, { type: 'agent_init', sessionId: session.id, model: o.model || '', cwd: o.cwd || session.absCwd });
      }
      return;
    case 'stream_event': {
      const ev = o.event; if (!ev) return;
      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta') pushTextDelta(session, 'text', ev.delta.text || '');
        else if (ev.delta.type === 'thinking_delta') pushTextDelta(session, 'thinking', ev.delta.thinking || '');
      }
      return;
    }
    case 'assistant': {
      // 텍스트/thinking 는 stream_event 델타로 이미 흘렸으므로 여기선 tool_use 만.
      const blocks = (o.message && o.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'tool_use') { flushText(session); emit(session, { type: 'tool_use', toolUseId: b.id, tool: b.name, input: b.input || {}, relPath: relPathOf(b.input) }); }
      }
      return;
    }
    case 'user': {
      const blocks = (o.message && o.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          flushText(session);
          const content = Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || '').join('') : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''));
          emit(session, { type: 'tool_result', toolUseId: b.tool_use_id, ok: !b.is_error, content });
        }
      }
      return;
    }
    case 'result':
      flushText(session);
      session.state = 'idle';
      emit(session, { type: 'done', ok: !o.is_error, subtype: o.subtype, summary: o.result || '', costUsd: o.total_cost_usd, usage: o.usage });
      return;
    default:
      return; // rate_limit_event 등 무시
  }
}

// ── 라인버퍼 stdout 파서 ────────────────────────────────────────────
function attachStdout(session) {
  let buf = '';
  session.proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      try { handleClaudeMessage(session, o); } catch (e) { emit(session, { type: 'error', message: e.message }); }
    }
  });
  session.proc.stderr.on('data', (d) => { session.lastStderr = String(d).slice(-2000); });
  session.proc.on('exit', (code) => {
    flushText(session);
    if (session.state !== 'idle' || code) {
      session.state = code ? 'crashed' : 'stopped';
      if (code) emit(session, { type: 'error', message: `claude 종료(code=${code}). ${session.lastStderr || ''}`.trim() });
    } else { session.state = 'stopped'; }
    if (session.id) sessions.delete(session.id);
    spawns.delete(session.spawnId);
  });
}

function bindSessionId(session, claudeId) {
  session.id = claudeId;
  sessions.set(claudeId, session);
  // M3-2: 이어받기(같은 claude session_id 재사용) 시 디스크 로그의 마지막 seq 이후로 이어 붙인다
  //  → seq 충돌 없이 하나의 세션 로그가 전체 수명을 커버한다.
  const last = lastSeqOf(claudeId);
  if (last > session.seq) session.seq = last;
  // start 시 첫 프롬프트는 id 확정 전에 stdin 으로 보냈으므로(user 이벤트 미emit) 여기서 로그에 남긴다.
  if (session._pendingUserText != null) { const t = session._pendingUserText; session._pendingUserText = null; emit(session, { type: 'user', text: t }); }
  if (session._resolveInit) { session._resolveInit(claudeId); session._resolveInit = null; }
}

// ── spawn ──────────────────────────────────────────────────────────
function ensureApprovalServer() {
  if (approvalServer) return;
  // named pipe(win32)는 파일이 아니다 — unlink 대상 아님(마지막 핸들이 닫히면 자동 소멸).
  if (!sockPathLib.isPipePath(APPROVAL_SOCK)) { try { fs.unlinkSync(APPROVAL_SOCK); } catch (_) { /* noop */ } }
  approvalServer = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n'); if (i < 0) return;
      let req; try { req = JSON.parse(buf.slice(0, i)); } catch (_) { try { sock.end(); } catch (_) {} return; }
      const session = spawns.get(req.spawnId);
      if (!session) { try { sock.write(JSON.stringify({ behavior: 'deny', message: '세션 없음' }) + '\n'); sock.end(); } catch (_) {} return; }
      const requestId = crypto.randomUUID();
      pendingApprovals.set(requestId, { socket: sock, sessionId: session.id });
      session.state = 'waiting_approval';
      emit(session, {
        type: 'permission_request', requestId, tool: req.tool_name,
        input: req.input || {}, relPath: relPathOf(req.input), diff: buildDiff(req.tool_name, req.input),
      });
    });
    sock.on('error', () => { /* noop */ });
  });
  approvalServer.on('error', (e) => console.error('[agent] 승인 소켓 오류:', e.message));
  approvalServer.listen(APPROVAL_SOCK);
}

function spawnClaude(session) {
  ensureApprovalServer();
  const mcpConfig = JSON.stringify({ mcpServers: { cptapproval: {
    command: NODE_BIN, args: [APPROVAL_MCP],
    env: { CPT_APPROVAL_SOCK: APPROVAL_SOCK, CPT_SPAWN_ID: session.spawnId },
  } } });
  const args = [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages',
    '--mcp-config', mcpConfig,
    '--permission-prompt-tool', 'mcp__cptapproval__approval_prompt',
  ];
  if (session.resumeId) args.push('--resume', session.resumeId);
  // spawnCli: darwin 은 cp.spawn 그대로, win32 의 .cmd shim 만 cmd.exe 경유(§spawn-util).
  session.proc = spawnCli(claudeBin(), args, {
    cwd: session.absCwd,
    env: process.env,          // 사용자 환경 그대로(자격증명은 우리가 안 건드림).
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  session.state = 'running';
  attachStdout(session);
  session.proc.on('error', (e) => {
    const msg = e.code === 'ENOENT' ? 'claude CLI 를 찾을 수 없습니다. 설치/로그인 후 다시 시도하세요.' : e.message;
    session.state = 'crashed';
    if (session._rejectInit) { session._rejectInit(Object.assign(new Error(msg), { code: 'AGENT_NOT_READY' })); session._rejectInit = null; }
    if (session.id) emit(session, { type: 'error', message: msg });
  });
}

function writeUser(session, text) {
  if (!session.proc || session.proc.exitCode != null) throw new Error('세션이 종료되었습니다.');
  session.state = 'running';
  session.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } }) + '\n');
  // M3-2: 사용자 프롬프트도 로그에 남겨 이어받기 복원 시 양방향 대화가 보이게 한다.
  //  id 확정 전(첫 프롬프트)이면 stash → bindSessionId 에서 emit.
  if (session.id) emit(session, { type: 'user', text: String(text) });
  else session._pendingUserText = String(text);
}

// ── agent.sessions (이어받기): ~/.claude/projects/<slug>/*.jsonl ────
function projectSlug(absCwd) { return absCwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function listSessions(absCwd) {
  const dir = path.join(runtime.claudeHome(), 'projects', projectSlug(absCwd));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stat; try { stat = fs.statSync(full); } catch (_) { continue; }
    let title = ''; let turns = 0;
    try {
      const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean);
      for (const ln of lines) {
        let o; try { o = JSON.parse(ln); } catch (_) { continue; }
        if (o.type === 'user' && o.message) {
          turns++;
          if (!title) {
            const c = o.message.content;
            const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');
            if (t) title = t.replace(/\s+/g, ' ').trim().slice(0, 60);
          }
        }
      }
    } catch (_) { /* noop */ }
    out.push({ id: f.replace(/\.jsonl$/, ''), title: title || '새 대화', lastAt: stat.mtime.toISOString(), turns, source: 'external' });
  }
  out.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  return out;
}

// ── 온보딩 점검(agent.doctor) — 크레덴셜(토큰)은 절대 열람하지 않는다 ──────
// 설치 여부(claude/tmux) + 로그인 여부를 확인한다. 로그인 확인은 claude **자체의**
// `auth status`(비밀 아닌 loggedIn/계정 라벨만 리턴)로만 한다 — 우리가 Keychain·
// ~/.claude OAuth 토큰 파일을 직접 열지 않는다. (M5 Slice2: 클라우드 러너는 사용자가
// 컨테이너 안에서 자기 claude 에 직접 로그인해야 첫 턴이 가능하므로 실제 점검이 필요.)
function detectClaude() {
  const bin = claudeBin();
  try {
    const version = execFileCliSync(bin, ['--version'], { encoding: 'utf-8', timeout: 4000 }).trim();
    return { installed: true, version, bin };
  } catch (e) {
    return { installed: false, version: null, bin, error: (e && (e.code || e.message)) || 'unknown' };
  }
}
function doctor() {
  const tmuxPath = require('./pty').findTmux();
  return {
    claude: detectClaude(),                                  // {installed, version, bin}
    tmux: { installed: !!tmuxPath, path: tmuxPath || null }, // brew install tmux
    platform: process.platform,
    // 로그인 상태 = claude 자체 `auth status`(토큰 미노출) 결과. 크레덴셜 파일은 우리가 열지 않는다.
    login: { probed: true, ...safeStatus(authStatus()) },
  };
}

// ── BYO 로그인(M5 Slice2) — 사용자 자신의 claude 계정에 컨테이너/PC 에서 로그인 ──
// claude **자체의** `auth login` OAuth 플로우를 PTY 로 구동한다. 우리 역할은 (1) CLI 가
// 출력하는 인증 URL 캡처 → 앱 인앱브라우저로 중계, (2) 사용자가 콜백페이지에서 복사한
// 인증 코드를 되받아 CLI stdin 에 입력하는 것뿐이다. 크레덴셜(토큰)은 그 러너의
// CLAUDE_CONFIG_DIR(컨테이너/PC)에만 안착하며 우리는 읽지도 옮기지도 않는다.
const OAUTH_URL_RE = /(https?:\/\/[^\s'"]*oauth\/authorize[^\s'"]*)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ''); }

let loginState = null; // { proc, buf, url, exited, exitCode, onData }

function endLogin() {
  if (loginState && loginState.proc) { try { loginState.proc.kill(); } catch (_) { /* noop */ } }
  loginState = null;
}

// claude 자체 상태 리포트(auth status --json) — 토큰은 노출되지 않고 loggedIn + 계정 라벨만.
function authStatus() {
  try {
    const out = execFileCliSync(claudeBin(), ['auth', 'status', '--json'], { encoding: 'utf-8', timeout: 6000 });
    return JSON.parse(out);
  } catch (e) {
    const out = e && e.stdout ? String(e.stdout) : ''; // 비로그인 시 non-zero exit + stdout 에 json
    try { return JSON.parse(out); } catch (_) { return { loggedIn: false }; }
  }
}
function safeStatus(st) {
  st = st || {};
  return { loggedIn: !!st.loggedIn, authMethod: st.authMethod || null, email: st.email || null, subscriptionType: st.subscriptionType || null };
}

// 로그인 시작 → 인증 URL 캡처. PTY 를 살려두고 코드 입력(agent.loginSubmit)을 기다린다.
async function startLogin({ useConsole } = {}) {
  endLogin();
  const nodePty = require('node-pty');
  const args = ['auth', 'login', useConsole ? '--console' : '--claudeai'];
  // BROWSER=true → CLI 가 브라우저 대신 `true`(무동작)를 실행 → 데스크톱에서도 탭이 안 열림.
  //  컨테이너엔 브라우저가 없어 어차피 "visit: <URL>" 폴백만 출력된다.
  // win32 의 .cmd shim 은 ConPTY 도 직접 못 띄운다 — ptyCommand 가 cmd.exe 경유 좌표로 변환(darwin 무변경).
  const cmd = ptyCommand(claudeBin(), args);
  const proc = nodePty.spawn(cmd.file, cmd.args, {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: runtime.root(),
    env: { ...process.env, BROWSER: 'true' },
  });
  const state = { proc, buf: '', url: null, exited: false, exitCode: null, onData: null };
  loginState = state;
  proc.onData((d) => { state.buf += d; if (state.buf.length > 40000) state.buf = state.buf.slice(-40000); if (state.onData) state.onData(); });
  proc.onExit(({ exitCode }) => { state.exited = true; state.exitCode = exitCode; if (state.onData) state.onData(); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.onData = null; reject(new Error('로그인 URL 대기 시간 초과')); }, 20000);
    const check = () => {
      const m = stripAnsi(state.buf).match(OAUTH_URL_RE);
      if (m) { clearTimeout(timer); state.onData = null; state.url = m[1]; resolve(m[1]); return; }
      if (state.exited) { clearTimeout(timer); state.onData = null; reject(new Error('로그인 프로세스가 URL 출력 전에 종료되었습니다.')); }
    };
    state.onData = check; check();
  });
  return { url, authMethod: useConsole ? 'console' : 'claude.ai' };
}

// 앱에서 받은 인증 코드를 CLI stdin 에 입력 → 로그인 완료. 진위는 auth status 로 확정.
async function submitLoginCode(code) {
  if (!loginState || !loginState.proc || loginState.exited) { const e = new Error('진행 중인 로그인 세션이 없습니다. 로그인을 다시 시작하세요.'); e.code = 'NO_LOGIN'; throw e; }
  const state = loginState;
  const marker = state.buf.length;
  try { state.proc.write(String(code || '').trim() + '\r'); } catch (_) { /* noop */ }
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const st = authStatus();
    if (st.loggedIn) { endLogin(); return { ok: true, status: safeStatus(st) }; }
    const tail = stripAnsi(state.buf).slice(marker);
    if (/invalid|incorrect|not\s*valid|expired|failed|error/i.test(tail)) { return { ok: false, message: '코드가 유효하지 않거나 만료되었습니다.' }; }
    if (state.exited) break;
  }
  const st = authStatus();
  if (st.loggedIn) { endLogin(); return { ok: true, status: safeStatus(st) }; }
  return { ok: false, message: '로그인을 완료하지 못했습니다. 다시 시도하세요.' };
}

// ── RPC 디스패치 (control.js 에서 호출) ─────────────────────────────
async function handle(method, params, ws) {
  pushWs = ws; // 최신 제어 WS 로 이벤트 push 대상 갱신
  const p = params || {};
  switch (method) {
    case 'agent.start': {
      const absCwd = fsLib.safeResolve(p.cwd || '');
      const session = {
        id: null, spawnId: 'spawn_' + crypto.randomBytes(9).toString('hex'),
        absCwd, resumeId: p.resumeId || null, state: 'starting', seq: 0, log: [],
        _textBuf: '', _thinkBuf: '', _flushTimer: null,
      };
      spawns.set(session.spawnId, session);
      const initP = new Promise((resolve, reject) => { session._resolveInit = resolve; session._rejectInit = reject; });
      spawnClaude(session);
      if (p.prompt) writeUser(session, p.prompt);
      const timer = setTimeout(() => { if (session._rejectInit) { session._rejectInit(new Error('에이전트 초기화 시간 초과')); session._rejectInit = null; } }, INIT_TIMEOUT_MS);
      try { const id = await initP; clearTimeout(timer); return { sessionId: id }; }
      catch (e) {
        clearTimeout(timer);
        if (session.proc) {
          if (process.platform === 'win32') killTree(session.proc.pid, 'SIGKILL'); // cmd.exe 경유 스폰은 트리째
          else { try { session.proc.kill('SIGKILL'); } catch (_) {} }
        }
        spawns.delete(session.spawnId); throw e;
      }
    }
    case 'agent.input': {
      const s = sessions.get(p.sessionId); if (!s) { const e = new Error('세션을 찾을 수 없습니다.'); e.code = 'SESSION_GONE'; throw e; }
      writeUser(s, p.text); return { ok: true };
    }
    case 'agent.approve': {
      const entry = pendingApprovals.get(p.requestId);
      if (!entry) return { ok: false, reason: 'not_pending' };
      pendingApprovals.delete(p.requestId);
      const allow = p.decision === 'allow';
      try { entry.socket.write(JSON.stringify(allow ? { behavior: 'allow' } : { behavior: 'deny', message: p.message || '거부됨' }) + '\n'); entry.socket.end(); } catch (_) { /* noop */ }
      const s = sessions.get(entry.sessionId); if (s) s.state = 'running';
      return { ok: true };
    }
    case 'agent.interrupt': {
      const s = sessions.get(p.sessionId);
      if (s && s.proc) {
        if (process.platform === 'win32') {
          // TODO(win32, §D-5): "턴만 중단"은 ConPTY(node-pty) 경유 스폰으로 바꿔 \x03 을 주입해야
          //  가능하다 — 현재 구조화 스폰은 파이프 stdio 라 SIGINT 등가가 없다. 1차는 트리 종료
          //  (= 세션 종료와 동일한 강도)로 동작만 보장한다. 실기 검증 라운드에서 승격할 것.
          killTree(s.proc.pid, 'SIGINT');
        } else { try { s.proc.kill('SIGINT'); } catch (_) {} }
      }
      return { ok: true };
    }
    case 'agent.stop': {
      const s = sessions.get(p.sessionId);
      if (s && s.proc) {
        try { s.proc.stdin.end(); } catch (_) {}
        if (process.platform === 'win32') killTree(s.proc.pid, 'SIGTERM'); // cmd.exe 경유 스폰은 직계만 죽이면 claude 가 남는다
        else { try { s.proc.kill('SIGTERM'); } catch (_) {} }
      }
      return { ok: true };
    }
    case 'agent.status': {
      const s = sessions.get(p.sessionId); return { state: s ? s.state : 'stopped', seq: s ? s.seq : 0 };
    }
    case 'agent.backlog': {
      // M3-2: 디스크 로그 우선(전체 이력 — 세션종료/데몬재시작 후에도 유효). 없으면 인메모리/gone.
      const since = Number(p.sinceSeq) || 0;
      const persisted = readPersisted(p.sessionId);
      if (persisted) return { events: persisted.filter((f) => typeof f.seq === 'number' && f.seq > since) };
      const s = sessions.get(p.sessionId);
      if (s) return { events: s.log.filter((f) => f.seq > since) };
      return { events: [], gone: true };
    }
    case 'agent.sessions': {
      const absCwd = fsLib.safeResolve(p.cwd || '');
      return { sessions: listSessions(absCwd) };
    }
    case 'agent.doctor': return doctor();
    // BYO 로그인(Slice2) — 크레덴셜은 이 러너의 CLAUDE_CONFIG_DIR 에만 안착, 우리는 미열람.
    case 'agent.login': return startLogin({ useConsole: !!p.useConsole });
    case 'agent.loginSubmit': return submitLoginCode(p.code);
    case 'agent.loginCancel': { endLogin(); return { ok: true }; }
    case 'agent.loginStatus': return safeStatus(authStatus());
    default: { const e = new Error('알 수 없는 agent 메서드: ' + method); throw e; }
  }
}

// 제어 WS 끊김 정리 — 자식 claude 는 유지(폰 재접속 시 backlog 로 따라잡음), push 대상만 해제.
function detachAll() { pushWs = null; }

module.exports = { handle, detachAll };
