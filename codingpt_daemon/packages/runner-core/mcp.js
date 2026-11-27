/**
 * mcp.js — 이 PC 의 claude 에 MCP 서버를 붙이고 상태를 본다(RPC `mcp.*`). 봇 "연결" 화면이 쓴다(2026-11-27).
 *
 *  사용자 결정(2026-11-27): 외부 서비스 행동은 각 서비스의 **공식 MCP 서버**로 한다. 붙이는 일은 사용자 자신의 claude CLI 가 한다
 *   (`claude mcp add/list/remove/login`) — 자격증명(OAuth 토큰)은 claude 가 이 PC 에 보관하고 우리는 만지지 않는다(데몬 절대 규칙).
 *
 *  · mcp.list                 → { servers:[{ name, url, transport, status }] }   status: connected | needs_auth | failed | pending | unknown
 *  · mcp.add {name,url,transport} → claude mcp add --scope user  (모든 프로젝트의 claude 가 쓴다 — 봇 대화 포함)
 *  · mcp.remove {name}
 *  · mcp.loginStart {name, browser} → browser=true: 이 PC 의 브라우저를 연다(PC 앞에 있을 때).
 *                                    아니면 `--no-browser` 로 띄워 인증 주소를 돌려준다(폰에서 열기) → { loginId, url }
 *  · mcp.loginFinish {loginId, redirect} → 폰 브라우저가 마지막에 간 주소(localhost 리다이렉트)를 그대로 넘긴다.
 *  · mcp.loginCancel {loginId}
 */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const logins = new Map(); // loginId → { proc, url, out, timer, done }

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function claude() { return require('./conv-engine-claude'); }

async function bin() {
  const at = await claude().locate();
  if (!at || !at.bin) throw coded('AGENT_UNAVAILABLE', '이 PC 에서 claude 를 찾지 못했습니다');
  return at.bin;
}

/** claude 를 한 번 돌려 출력을 받는다. cwd = 홈(프로젝트 범위 .mcp.json 이 끼지 않게). */
async function run(args, { timeoutMs = 60000 } = {}) {
  const b = await bin();
  const env = await claude().buildEnv();
  return new Promise((resolve, reject) => {
    const p = spawn(b, args, { cwd: require('os').homedir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) { /* noop */ } reject(coded('TIMEOUT', 'claude 가 응답하지 않습니다')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(coded('AGENT_UNAVAILABLE', String(e && e.message))); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** `claude mcp list` 한 줄 → 서버. 형식(2.1.332 실측): "<name>: <url|cmd> (HTTP) - ✔ Connected" / "! Needs authentication" / "✗ Failed to connect" */
function parseList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(.+?): (.+?) - (.+)$/.exec(line.trim());
    if (!m) continue;
    let target = m[2].trim();
    let transport = 'stdio';
    const tm = /\s\((HTTP|SSE|stdio)\)$/i.exec(target);
    if (tm) { transport = tm[1].toLowerCase(); target = target.slice(0, tm.index); } else if (/^https?:\/\//.test(target)) transport = 'http';
    const st = m[3].toLowerCase();
    const status = /connected/.test(st) && !/fail/.test(st) ? 'connected' : /auth/.test(st) ? 'needs_auth' : /pending/.test(st) ? 'pending' : /fail|✗/.test(st) ? 'failed' : 'unknown';
    out.push({ name: m[1].trim(), url: /^https?:/.test(target) ? target : null, command: /^https?:/.test(target) ? null : target, transport, status });
  }
  return out;
}

function cleanName(v) {
  const n = String(v || '').trim();
  if (!NAME_RE.test(n)) throw coded('BAD_REQUEST', 'MCP 이름은 영문·숫자·-_. 로 64자 이내여야 합니다');
  return n;
}
function cleanUrl(v) {
  const u = String(v || '').trim();
  if (!/^https:\/\/[^\s]+$/.test(u) || u.length > 500) throw coded('BAD_REQUEST', 'MCP 주소는 https 여야 합니다');
  return u;
}

const HANDLERS = {
  async 'mcp.list'() {
    const r = await run(['mcp', 'list'], { timeoutMs: 90000 });
    return { servers: parseList(r.out) };
  },
  async 'mcp.add'(p) {
    const name = cleanName(p.name);
    const url = cleanUrl(p.url);
    const transport = p.transport === 'sse' ? 'sse' : 'http';
    const r = await run(['mcp', 'add', '--scope', 'user', '--transport', transport, name, url]);
    if (r.code !== 0 && !/already exists/i.test(r.err + r.out)) throw coded('MCP_FAILED', (r.err || r.out).trim().slice(0, 300) || 'MCP 를 추가하지 못했습니다');
    return { ok: true, name };
  },
  async 'mcp.remove'(p) {
    const name = cleanName(p.name);
    const r = await run(['mcp', 'remove', '--scope', 'user', name]);
    if (r.code !== 0 && !/not found|no .*server/i.test(r.err + r.out)) throw coded('MCP_FAILED', (r.err || r.out).trim().slice(0, 300) || 'MCP 를 지우지 못했습니다');
    return { ok: true };
  },
  async 'mcp.loginStart'(p) {
    const name = cleanName(p.name);
    const b = await bin();
    const env = await claude().buildEnv();
    const args = ['mcp', 'login', name, ...(p.browser ? [] : ['--no-browser'])];
    const proc = spawn(b, args, { cwd: require('os').homedir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const loginId = crypto.randomBytes(8).toString('hex');
    const ent = { proc, url: null, out: '', done: null };
    logins.set(loginId, ent);
    ent.timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) { /* noop */ } logins.delete(loginId); }, LOGIN_TTL_MS);
    if (ent.timer.unref) ent.timer.unref();
    ent.done = new Promise((resolve) => proc.on('close', (code) => { clearTimeout(ent.timer); resolve(code); }));
    const onData = (d) => { ent.out += d; if (!ent.url) { const m = /(https:\/\/[^\s"'<>]+)/.exec(ent.out); if (m) ent.url = m[1]; } };
    proc.stdout.on('data', onData); proc.stderr.on('data', onData);
    proc.on('error', () => {});
    // 주소가 나오거나(--no-browser) 끝날 때(브라우저 모드: 사용자가 PC 에서 마치면)까지 잠깐 기다린다
    const until = Date.now() + 15000;
    while (!ent.url && Date.now() < until && proc.exitCode == null) await new Promise((r) => setTimeout(r, 100));
    if (proc.exitCode != null) {
      logins.delete(loginId);
      if (proc.exitCode === 0) return { ok: true, done: true };
      throw coded('MCP_FAILED', ent.out.trim().slice(-300) || '로그인을 시작하지 못했습니다');
    }
    return { ok: true, loginId, url: p.browser ? null : ent.url };
  },
  async 'mcp.loginFinish'(p) {
    const ent = logins.get(String(p.loginId || ''));
    if (!ent) throw coded('LOGIN_NOT_FOUND', '로그인이 만료됐습니다. 다시 시작하세요');
    const redirect = String(p.redirect || '').trim();
    if (!/^https?:\/\/\S+$/.test(redirect)) throw coded('BAD_REQUEST', '브라우저 주소창의 주소 전체를 붙여 넣으세요');
    try { ent.proc.stdin.write(redirect + '\n'); } catch (_) { /* noop */ }
    const code = await Promise.race([ent.done, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    logins.delete(String(p.loginId));
    if (code === 0) return { ok: true };
    try { ent.proc.kill('SIGTERM'); } catch (_) { /* noop */ }
    throw coded('MCP_FAILED', ent.out.trim().slice(-300) || '로그인을 마치지 못했습니다');
  },
  async 'mcp.loginCancel'(p) {
    const ent = logins.get(String(p.loginId || ''));
    if (ent) { try { ent.proc.kill('SIGTERM'); } catch (_) { /* noop */ } logins.delete(String(p.loginId)); }
    return { ok: true };
  },
};

async function handle(method, params) {
  const fn = HANDLERS[method];
  if (!fn) throw coded('BAD_REQUEST', '알 수 없는 mcp 메서드: ' + method);
  return fn(params && typeof params === 'object' ? params : {});
}

module.exports = { handle, parseList };
