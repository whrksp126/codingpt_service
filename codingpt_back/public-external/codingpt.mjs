#!/usr/bin/env node
// CodingPT 외부 연동 — SDK · CLI · MCP 서버가 한 파일이다. 의존성 없음(Node 18+).
//   SDK:  import { CodingPT } from './codingpt.mjs'
//   CLI:  node codingpt.mjs help
//   MCP:  node codingpt.mjs mcp
// 키 찾는 순서: apiKey 인자 → CODINGPT_API_KEY → 위로 올라가며 찾은 .codingpt.json 의 keyFile(cpt external connect 가 만든다)
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_URL = 'https://codingpt-back.ghmate.com';

/** 시작 폴더부터 위로 .codingpt.json 을 찾는다. 키 값이 아니라 키 파일 경로만 들어 있다. */
function projectConfig() {
  for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    for (let d = start; ; d = path.dirname(d)) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(d, '.codingpt.json'), 'utf8'));
        const file = String(c.keyFile || '').replace(/^~(?=\/)/, os.homedir());
        return { url: c.url, apiKey: fs.readFileSync(file, 'utf8').trim() };
      } catch { /* 없음 — 위로 */ }
      if (d === path.dirname(d)) break;
    }
  }
  return {};
}

export class CodingPTError extends Error {
  constructor(message, code, status) { super(message); this.name = 'CodingPTError'; this.code = code; this.status = status; }
}

export class CodingPT {
  constructor({ apiKey = process.env.CODINGPT_API_KEY, url = process.env.CODINGPT_URL } = {}) {
    const found = apiKey ? {} : projectConfig();
    apiKey = apiKey || found.apiKey;
    url = url || found.url || DEFAULT_URL;
    if (!apiKey) throw new CodingPTError('API 키가 없습니다. CodingPT 터미널에서 cpt external connect 를 실행하거나 CODINGPT_API_KEY 를 설정하세요', 'UNAUTHORIZED');
    this.apiKey = apiKey;
    this.base = String(url).replace(/\/+$/, '') + '/api/v1';
  }

  async _req(method, path, body) {
    const r = await fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new CodingPTError(j.message || `HTTP ${r.status}`, j.detail?.code || 'HTTP_ERROR', r.status);
    return j;
  }

  agents() { return this._req('GET', '/agents'); }
  workspaces() { return this._req('GET', '/workspaces'); }
  createWorkspace(o) { return this._req('POST', '/workspaces', o); }
  /** { cwd, prompt?, title?, worktree?: true|{branch,base}, mode?, model?, agent?, effort?, clientId? } */
  async createSession(o) { return (await this._req('POST', '/sessions', o)).session; }
  async sessions() { return (await this._req('GET', '/sessions')).sessions; }
  getSession(id, after = 0) { return this._req('GET', `/sessions/${id}?after=${after}`); }
  events(id, { after = 0, wait = 25 } = {}) { return this._req('GET', `/sessions/${id}/events?after=${after}&wait=${wait}`); }
  send(id, text, { clientId } = {}) { return this._req('POST', `/sessions/${id}/messages`, { text, clientId }); }
  /** decision: allow | deny | answer. answers = { "질문 문장": "고른 라벨" } */
  respond(id, requestId, o) { return this._req('POST', `/sessions/${id}/requests/${requestId}`, o); }
  update(id, o) { return this._req('PATCH', `/sessions/${id}`, o); }
  interrupt(id) { return this._req('POST', `/sessions/${id}/interrupt`); }
  stop(id) { return this._req('POST', `/sessions/${id}/stop`); }
  deleteSession(id) { return this._req('DELETE', `/sessions/${id}`); }

  /**
   * 이벤트를 실시간으로 받는다. 일이 멈추면(입력 대기·승인 대기·종료) { type:'settled', session, pending, cursor } 로 끝난다.
   *  ★ 지시 직후엔 턴이 아직 안 열려 idle 로 보일 수 있다 — 턴 끝·승인 대기를 봤거나 잠시 조용할 때만 멈춘 것으로 친다.
   */
  async *stream(id, { after = 0 } = {}) {
    let cursor = after; let quiet = 0; let sawEnd = false;
    for (;;) {
      const r = await this.events(id, { after: cursor, wait: 25 });
      for (const ev of r.events) { if (ev.type === 'turn') sawEnd = ev.phase === 'end'; yield ev; }
      cursor = r.cursor;
      const working = r.session.state === 'working';
      quiet = working || r.events.length ? 0 : quiet + 1;
      if (!r.more && !working && (r.pending.length || sawEnd || quiet >= 3)) { yield { type: 'settled', session: r.session, pending: r.pending, cursor }; return; }
      if (!working) await new Promise((ok) => setTimeout(ok, 1000));
    }
  }

  /** 턴이 끝나거나 승인을 기다릴 때까지 기다린다 → { session, pending, text, cursor } */
  async wait(id, { after = 0, timeoutMs = 600000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let text = '';
    const it = this.stream(id, { after });
    for (;;) {
      const next = await Promise.race([it.next(), new Promise((ok) => setTimeout(ok, Math.max(0, deadline - Date.now())))]);
      if (!next) throw new CodingPTError('기다리는 시간이 지났습니다. 세션은 계속 일하고 있습니다', 'TIMEOUT');
      const ev = next.value;
      if (ev.type === 'message' && ev.message.role === 'assistant' && ev.message.kind === 'text' && ev.message.text) text = ev.message.text;
      if (ev.type === 'settled') return { session: ev.session, pending: ev.pending, text, cursor: ev.cursor };
    }
  }

  /** 지시 하나를 보내고 답을 받는다. onRequest(req) 가 {decision,…} 을 돌려주면 승인·질문에 답하고 이어 간다. */
  async ask(id, text, { onRequest, timeoutMs } = {}) {
    let cursor = (await this.getSession(id, 1e9)).cursor;
    if (text) await this.send(id, text);
    for (;;) {
      const r = await this.wait(id, { after: cursor, timeoutMs });
      cursor = r.cursor;
      if (!r.pending.length || !onRequest) return r;
      for (const req of r.pending) await this.respond(id, req.id, await onRequest(req));
    }
  }
}

// ── MCP(stdio JSON-RPC) ─────────────────────────────────────────────────────
const str = { type: 'string' };
const TOOLS = [
  ['codingpt_workspaces', 'CodingPT 가 연결된 PC 의 워크스페이스 목록', {}, [], (c) => c.workspaces()],
  ['codingpt_session_create', 'PC 의 에이전트로 새 세션을 만들고 첫 지시를 보낸다. worktree:true 면 전용 브랜치에서 일한다',
    { cwd: str, prompt: str, title: str, worktree: { type: 'boolean' }, branch: str, base: str, mode: str, model: str }, ['cwd'],
    (c, a) => c.createSession({ cwd: a.cwd, prompt: a.prompt, title: a.title, mode: a.mode, model: a.model, worktree: a.branch || a.base ? { branch: a.branch, base: a.base } : a.worktree })],
  ['codingpt_sessions', '이 API 키로 만든 세션 목록', {}, [], (c) => c.sessions()],
  ['codingpt_session_send', '기존 세션에 이어서 지시한다', { id: str, text: str }, ['id', 'text'], (c, a) => c.send(a.id, a.text)],
  ['codingpt_session_wait', '세션이 일을 멈출 때까지 기다리고 마지막 답과 대기 중 승인·질문을 돌려준다. 오래 걸리면 다시 부른다',
    { id: str, after: { type: 'number' } }, ['id'], (c, a) => c.wait(a.id, { after: a.after || 0, timeoutMs: 50000 })
      .catch((e) => { if (e.code === 'TIMEOUT') return { stillWorking: true }; throw e; })],
  ['codingpt_session_events', '세션 이벤트를 읽는다(after 는 이전 응답의 cursor)', { id: str, after: { type: 'number' } }, ['id'], (c, a) => c.getSession(a.id, a.after || 0)],
  ['codingpt_session_respond', '승인·질문에 답한다. decision=allow|deny|answer. answers 는 {질문: 라벨}',
    { id: str, requestId: str, decision: str, always: { type: 'boolean' }, message: str, answers: { type: 'object' } }, ['id', 'requestId', 'decision'],
    (c, a) => c.respond(a.id, a.requestId, { decision: a.decision, always: a.always, message: a.message, answers: a.answers })],
  ['codingpt_session_interrupt', '지금 턴을 중단한다', { id: str }, ['id'], (c, a) => c.interrupt(a.id)],
  ['codingpt_session_delete', '세션을 지운다. worktree·브랜치는 남는다', { id: str }, ['id'], (c, a) => c.deleteSession(a.id)],
];

async function mcp() {
  const client = new CodingPT();
  const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  const onLine = async (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const reply = (result) => write({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') return reply({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codingpt', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') {
      return reply({ tools: TOOLS.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) });
    }
    if (m.method === 'tools/call') {
      const t = TOOLS.find((x) => x[0] === m.params?.name);
      if (!t) return write({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
      try { return reply({ content: [{ type: 'text', text: JSON.stringify(await t[4](client, m.params.arguments || {}), null, 2) }] }); }
      catch (e) { return reply({ isError: true, content: [{ type: 'text', text: `${e.code || 'ERROR'}: ${e.message}` }] }); }
    }
    if (m.id != null) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const HELP = `codingpt — PC 의 에이전트를 다른 프로젝트에서 부른다

  workspaces                                   워크스페이스 목록
  sessions                                     이 키로 만든 세션 목록
  new <폴더> "<지시>" [--worktree] [--branch b] [--base main] [--mode acceptEdits] [--title t] [--wait]
  send <세션> "<지시>" [--wait]                 이어서 지시
  wait <세션>                                   일을 멈출 때까지 기다리고 답 출력
  show <세션> [--after n]                       이벤트 보기
  allow <세션> <요청> | deny <세션> <요청> ["이유"] | answer <세션> <요청> '<JSON>'
  interrupt <세션> · stop <세션> · delete <세션>
  mcp                                          MCP 서버(stdio)
`;

async function cli(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) flags[argv[i].slice(2)] = true; else { flags[argv[i].slice(2)] = n; i++; } }
    else pos.push(argv[i]);
  }
  const [cmd, a, b, c] = pos;
  if (!cmd || cmd === 'help') { process.stdout.write(HELP); return; }
  if (cmd === 'mcp') return mcp();
  const cp = new CodingPT();
  const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
  const finish = async (id, after) => {
    const r = await cp.wait(id, { after });
    print({ id, state: r.session.state, pending: r.pending, text: r.text });
  };
  switch (cmd) {
    case 'workspaces': return print(await cp.workspaces());
    case 'sessions': return print(await cp.sessions());
    case 'new': {
      const worktree = flags.branch || flags.base ? { branch: flags.branch, base: flags.base } : !!flags.worktree;
      const s = await cp.createSession({ cwd: a, prompt: b, title: flags.title, mode: flags.mode, model: flags.model, worktree });
      return flags.wait ? finish(s.id, 0) : print(s);
    }
    case 'send': {
      const cur = (await cp.getSession(a, 1e9)).cursor;
      await cp.send(a, b);
      return flags.wait ? finish(a, cur) : print({ ok: true });
    }
    case 'wait': return finish(a, Number(flags.after) || 0);
    case 'show': return print(await cp.getSession(a, Number(flags.after) || 0));
    case 'allow': return print(await cp.respond(a, b, { decision: 'allow', always: !!flags.always, message: c }));
    case 'deny': return print(await cp.respond(a, b, { decision: 'deny', message: c }));
    case 'answer': return print(await cp.respond(a, b, { decision: 'answer', answers: JSON.parse(c) }));
    case 'interrupt': return print(await cp.interrupt(a));
    case 'stop': return print(await cp.stop(a));
    case 'delete': return print(await cp.deleteSession(a));
    default: process.stdout.write(HELP); process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.code || 'ERROR'}: ${e.message}\n`); process.exit(1); });
}
