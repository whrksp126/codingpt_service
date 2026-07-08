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
const { spawn } = require('child_process');
const fsLib = require('./fs');

const CLAUDE_BIN = process.env.CODINGPT_CLAUDE_BIN || 'claude';
const NODE_BIN = process.execPath;
const APPROVAL_MCP = path.join(__dirname, 'approval-mcp.js');
const APPROVAL_SOCK = path.join(os.tmpdir(), `cpt-approval-${process.pid}.sock`);
const MAX_LOG = 3000;        // 세션별 이벤트 링버퍼(백로그 리플레이용)
const COALESCE_MS = 50;      // 텍스트 델타 코얼레싱 주기
const INIT_TIMEOUT_MS = 15000;

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

// 세션 로그에 적재(seq++) + 제어 WS push. must-not-drop 은 로그+agent.backlog 로 보장.
function emit(session, event) {
  const seq = ++session.seq;
  const frame = { type: 'agent_event', sessionId: session.id, seq, event };
  session.log.push(frame);
  if (session.log.length > MAX_LOG) session.log.shift();
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
function buildDiff(tool, input) {
  if (!input) return null;
  if (tool === 'Write') return { kind: 'write', path: input.file_path || null, newText: String(input.content ?? '') };
  if (tool === 'Edit') return { kind: 'edit', path: input.file_path || null, oldText: String(input.old_string ?? ''), newText: String(input.new_string ?? '') };
  if (tool === 'MultiEdit') return { kind: 'multiedit', path: input.file_path || null, edits: input.edits || [] };
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
  if (session._resolveInit) { session._resolveInit(claudeId); session._resolveInit = null; }
}

// ── spawn ──────────────────────────────────────────────────────────
function ensureApprovalServer() {
  if (approvalServer) return;
  try { fs.unlinkSync(APPROVAL_SOCK); } catch (_) { /* noop */ }
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
  session.proc = spawn(CLAUDE_BIN, args, {
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
}

// ── agent.sessions (이어받기): ~/.claude/projects/<slug>/*.jsonl ────
function projectSlug(absCwd) { return absCwd.replace(/[^a-zA-Z0-9]/g, '-'); }
function listSessions(absCwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(absCwd));
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
      catch (e) { clearTimeout(timer); try { session.proc && session.proc.kill('SIGKILL'); } catch (_) {} spawns.delete(session.spawnId); throw e; }
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
      const s = sessions.get(p.sessionId); if (s && s.proc) { try { s.proc.kill('SIGINT'); } catch (_) {} }
      return { ok: true };
    }
    case 'agent.stop': {
      const s = sessions.get(p.sessionId); if (s && s.proc) { try { s.proc.stdin.end(); } catch (_) {} try { s.proc.kill('SIGTERM'); } catch (_) {} }
      return { ok: true };
    }
    case 'agent.status': {
      const s = sessions.get(p.sessionId); return { state: s ? s.state : 'stopped', seq: s ? s.seq : 0 };
    }
    case 'agent.backlog': {
      const s = sessions.get(p.sessionId); if (!s) return { events: [], gone: true };
      const since = Number(p.sinceSeq) || 0;
      return { events: s.log.filter((f) => f.seq > since) };
    }
    case 'agent.sessions': {
      const absCwd = fsLib.safeResolve(p.cwd || '');
      return { sessions: listSessions(absCwd) };
    }
    default: { const e = new Error('알 수 없는 agent 메서드: ' + method); throw e; }
  }
}

// 제어 WS 끊김 정리 — 자식 claude 는 유지(폰 재접속 시 backlog 로 따라잡음), push 대상만 해제.
function detachAll() { pushWs = null; }

module.exports = { handle, detachAll };
