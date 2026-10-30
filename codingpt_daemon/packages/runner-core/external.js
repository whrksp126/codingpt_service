/**
 * external.js — 외부 서비스가 이 PC 의 에이전트를 쓰는 표면(RPC `ext.*`, 공개 API = back `/api/v1`).
 *
 * 사용자 결정(2026-10-31):
 *  · 외부 서비스는 **자기가 만든 세션만** 보고 이어 가고 지운다. 사람이 CodingPT 에서 하던 대화는 보이지 않는다.
 *  · 승인·질문은 호출한 서비스로 그대로 전달돼 거기서 답한다. CodingPT 화면에서 답해도 된다(먼저 답한 쪽이 이긴다).
 *  · 승인 없이 실행(bypassPermissions·dontAsk)은 키에서 허용했을 때만 된다.
 *
 * 대화 엔진은 conv.* 를 그대로 쓴다 — 세션 파일·프로세스·승인이 사람의 채팅과 같은 길을 타서 CodingPT 화면에서도 그대로 보인다.
 *
 * 경계:
 *  · `auth` 는 back 이 API 키에서 만들어 넣는다. 공개 API 의 본문은 여기 닿기 전에 필드 단위로 걸러진다.
 *  · 소유자가 다른 세션은 "없는 세션" 으로 답한다(존재 여부도 알려 주지 않는다).
 *  · 프롬프트·답변을 로그에 남기지 않는다.
 *  · 끄기: daemon.json externalApi:false / CPT_EXTERNAL=0.
 *
 * 키 관리(external.*, `cpt external`) — 사용자 결정(2026-10-31): 같은 PC 의 에이전트가 키를 만들고 관리해도 된다.
 *  · 원문은 데몬이 받아 ~/.codingpt/keys/ 에 0600 파일로만 쓴다. CLI 응답에는 싣지 않는다 — 대화 기록에 키가 남지 않게.
 *  · 프로젝트에는 파일 경로만 적는다(.codingpt.json). 그래서 프로젝트 폴더를 커밋해도 키가 새지 않는다.
 *  · 만들고 폐기할 때마다 사용자에게 알린다. 릴레이로는 열지 않는다(이 PC 터미널 전용).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');

const BYPASS_MODES = new Set(['bypassPermissions', 'dontAsk']);
const TITLE_MAX = 80;

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function conv(method, params) { return require('./conv').rpc(method, params, null); }
function fsLib() { return require('./fs'); }
function taskGit() { return require('./task-git'); }
function storeFile() { return path.join(runtime.stateDir(), 'external-sessions.json'); }
//  tasks 의 worktrees 폴더와 나눈다 — 거기는 tasks 가 정리 주인이다.
function worktreesDir() { return path.join(runtime.stateDir(), 'external-worktrees'); }

function load() {
  try { const v = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
function save(v) { fs.writeFileSync(storeFile(), JSON.stringify(v, null, 2), { mode: 0o600 }); }

function enabled() {
  if (process.env.CPT_EXTERNAL === '0') return false;
  try { return (require('./config').load() || {}).externalApi !== false; } catch (_) { return true; }
}
function authOf(p) {
  const a = p && p.auth;
  if (!a || !a.keyId) throw coded('UNAUTHORIZED', '키 정보가 없습니다');
  return a;
}
function realish(p) { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } }
function under(child, parent) { return child === parent || child.startsWith(parent.replace(/[\\/]+$/, '') + path.sep); }

/** 키가 허용한 폴더 안인지. 심링크로 빠져나가지 못하게 실제 경로로 비교한다. paths 가 비어 있으면 홈 전체. */
function allowedAbs(auth, cwd) {
  let abs;
  try { abs = fsLib().safeResolve(String(cwd || '').replace(/^~\/?/, '')); } catch (_) { throw coded('PATH_NOT_ALLOWED', '홈 폴더 밖 경로입니다'); }
  const real = realish(abs);
  const paths = Array.isArray(auth.paths) ? auth.paths.filter(Boolean) : [];
  if (paths.length && !paths.some((b) => {
    let root;
    try { root = realish(fsLib().safeResolve(String(b).replace(/^~\/?/, ''))); } catch (_) { return false; }
    return under(real, root);
  })) throw coded('PATH_NOT_ALLOWED', '이 키가 허용하지 않은 폴더입니다');
  return real;
}
function checkMode(auth, mode) {
  if (mode && BYPASS_MODES.has(mode) && !auth.allowBypass) throw coded('BYPASS_NOT_ALLOWED', '이 키는 승인 없이 실행할 수 없습니다. CodingPT 설정에서 키를 다시 만드세요');
}
function own(auth, id) {
  const e = load()[String(id || '')];
  if (!e || e.keyId !== auth.keyId) throw coded('SESSION_NOT_FOUND', '세션을 찾을 수 없습니다');
  return e;
}
function viewOf(id, entry, thread) {
  const t = thread || {};
  return {
    id, agent: t.agent || null, title: t.title || entry.title || '', state: t.state || 'stopped', mode: t.mode || null, model: t.model || null,
    cwd: entry.cwd, repo: entry.repo || null, branch: entry.branch || null, worktree: !!entry.branch,
    pending: t.pending || 0, preview: t.preview || '', usage: t.usage || null, createdAt: entry.createdAt, lastAt: t.lastAt || entry.createdAt,
  };
}
/** 내부 이벤트 → 공개 이벤트. state 는 세션 필드로 이미 나간다. */
function eventOf(ev) {
  if (ev.op === 'msg') return { seq: ev.seq, ts: ev.ts, type: 'message', message: ev.msg };
  if (ev.op === 'req') return { seq: ev.seq, ts: ev.ts, type: 'request', request: ev.req };
  if (ev.op === 'turn') return { seq: ev.seq, ts: ev.ts, type: 'turn', phase: ev.phase, ok: ev.ok, subtype: ev.subtype, usage: ev.usage, costUsd: ev.costUsd };
  if (ev.op === 'notice') return { seq: ev.seq, ts: ev.ts, type: 'notice', level: ev.level, code: ev.code, text: ev.text };
  return null;
}

async function makeWorktree(abs, { branch, base }, title) {
  const tg = taskGit();
  const info = await tg.repoInfo(abs);
  if (!info) throw coded('NOT_A_REPO', 'git 저장소가 아니어서 worktree 를 만들 수 없습니다');
  const t6 = crypto.randomBytes(3).toString('hex');
  const slug = String(title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';
  const name = branch ? String(branch).trim() : `cpt/ext-${slug}-${t6}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) || name.includes('..')) throw coded('BAD_REQUEST', '브랜치 이름이 올바르지 않습니다');
  const start = base ? String(base).trim() : 'HEAD';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,120}$/.test(start) || !(await tg.refExists(info.top, start))) throw coded('BAD_REQUEST', `기준 브랜치를 찾을 수 없습니다: ${start}`);
  const absDir = path.join(worktreesDir(), `${slug}-${t6}`);
  fs.mkdirSync(worktreesDir(), { recursive: true });
  await tg.worktreeAdd(info.top, { branch: name, absDir, startPoint: start });
  try { await tg.copyEnvFiles(info.top, info.subdir, absDir); } catch (_) { /* .env 복사 실패는 치명적이지 않다 */ }
  return { cwd: info.subdir ? path.join(absDir, info.subdir) : absDir, branch: name };
}

async function rpcWorkspaces(p) {
  const auth = authOf(p);
  const r = await require('./cpt-server').backFetch('GET', '/api/daemon/workspaces');
  const rows = Array.isArray(r) ? r : (r && (r.workspaces || r.data)) || [];
  const out = [];
  for (const w of rows) {
    const cwd = w.localPath || w.local_path;
    if (!cwd) continue;
    try { allowedAbs(auth, cwd); } catch (_) { continue; }
    out.push({ name: w.name || path.basename(cwd), path: cwd });
  }
  return { workspaces: out };
}

async function rpcWorkspaceCreate(p) {
  const auth = authOf(p);
  const parentPath = String(p.parentPath || '').trim();
  if (!parentPath) throw coded('BAD_REQUEST', 'parentPath 가 필요합니다');
  allowedAbs(auth, parentPath);
  return require('./workspace').handle('ws.create', { name: String(p.name || ''), parentPath });
}

async function rpcCreate(p) {
  const auth = authOf(p);
  const mode = p.mode ? String(p.mode) : 'default';
  checkMode(auth, mode);
  const title = String(p.title || '').trim().slice(0, TITLE_MAX);
  const clientId = p.clientId ? `ext-${auth.keyId}-${String(p.clientId).slice(0, 80)}` : null;
  const abs = allowedAbs(auth, p.cwd);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw coded('BAD_REQUEST', '폴더가 없습니다');
  const prior = clientId ? Object.entries(load()).find(([, e]) => e.keyId === auth.keyId && e.clientId === clientId) : null;
  if (prior) return { session: viewOf(prior[0], prior[1], (await conv('conv.since', { threadId: prior[0], sinceSeq: 1e9 })).thread) };

  const wt = p.worktree ? await makeWorktree(abs, typeof p.worktree === 'object' ? p.worktree : {}, title) : null;
  const cwd = wt ? wt.cwd : abs;
  const r = await conv('conv.create', {
    cwd: fsLib().relOf(cwd), agent: p.agent || 'claude', mode, model: p.model || undefined, effort: p.effort || undefined,
    text: p.prompt || undefined, clientId: clientId || undefined,
  });
  const id = r.thread.id;
  const label = `[${String(auth.keyName || '외부').slice(0, 24)}] ${title || String(p.prompt || '').trim().slice(0, 40)}`.trim();
  const entry = { keyId: auth.keyId, keyName: auth.keyName || null, clientId, cwd, repo: wt ? abs : null, branch: wt ? wt.branch : null, title, createdAt: Date.now() };
  const all = load(); all[id] = entry; save(all);
  let thread = r.thread;
  try { thread = (await conv('conv.set', { threadId: id, title: label })).thread; } catch (_) { /* 제목은 표시용 */ }
  //  사람도 CodingPT 에서 바로 보고 끼어들 수 있게 대화 탭을 연다. worktree 는 사이드바에 없으므로 이 탭이 입구다.
  try { require('./surfaces').add({ cwd: abs, id: 'c-' + id, kind: 'chat', threadId: id, title: label }); } catch (_) { /* 표시 실패가 세션을 막지 않는다 */ }
  return { session: viewOf(id, entry, thread), seq: r.seq };
}

async function rpcList(p) {
  const auth = authOf(p);
  const store = require('./conv-store');
  const sessions = Object.entries(load()).filter(([, e]) => e.keyId === auth.keyId)
    .map(([id, e]) => viewOf(id, e, store.getThread(id)));
  sessions.sort((a, b) => b.lastAt - a.lastAt);
  return { sessions };
}

async function rpcGet(p) {
  const auth = authOf(p);
  const e = own(auth, p.id);
  const after = Math.max(0, Number(p.after) | 0);
  const r = await conv('conv.since', { threadId: p.id, sinceSeq: after });
  const events = (r.events || []).map(eventOf).filter(Boolean);
  const last = (r.events || []).length ? r.events[r.events.length - 1].seq : after;
  return { session: viewOf(p.id, e, r.thread), events, cursor: last, more: !!r.more, partial: r.live || [], pending: r.pending || [] };
}

async function rpcSend(p) {
  const auth = authOf(p);
  own(auth, p.id);
  const text = String(p.text == null ? '' : p.text);
  if (!text.trim()) throw coded('BAD_REQUEST', '보낼 내용이 필요합니다');
  return conv('conv.send', { threadId: p.id, clientId: p.clientId ? String(p.clientId).slice(0, 120) : crypto.randomUUID(), text });
}

async function rpcRespond(p) {
  const auth = authOf(p);
  own(auth, p.id);
  return conv('conv.respond', {
    threadId: p.id, reqId: p.requestId, decision: p.decision, always: !!p.always, message: p.message, answers: p.answers,
    by: auth.keyName || 'external',
  });
}

async function rpcSet(p) {
  const auth = authOf(p);
  own(auth, p.id);
  checkMode(auth, p.mode ? String(p.mode) : '');
  const r = await conv('conv.set', { threadId: p.id, ...(p.mode ? { mode: String(p.mode) } : {}), ...(p.model ? { model: String(p.model) } : {}) });
  return { session: viewOf(p.id, own(auth, p.id), r.thread) };
}

async function rpcInterrupt(p) { own(authOf(p), p.id); return conv('conv.interrupt', { threadId: p.id }); }
async function rpcStop(p) { own(authOf(p), p.id); return conv('conv.stop', { threadId: p.id }); }

/** 대화를 지운다. worktree 는 일의 결과물이라 남긴다(브랜치도 그대로). */
async function rpcDelete(p) {
  const auth = authOf(p);
  const e = own(auth, p.id);
  await conv('conv.remove', { threadId: p.id });
  try { require('./surfaces').remove({ cwd: e.repo || e.cwd, id: 'c-' + p.id }); } catch (_) { /* noop */ }
  const all = load(); delete all[p.id]; save(all);
  return { ok: true, ...(e.branch ? { keptBranch: e.branch, keptWorktree: e.cwd } : {}) };
}

// ── 키 관리(이 PC 전용) ──────────────────────────────────────────────────────
function keysDir() { return path.join(runtime.stateDir(), 'keys'); }
function back(method, apiPath, body) { return require('./cpt-server').backFetch(method, apiPath, body); }
function keyFileOf(key) {
  const slug = String(key.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'key';
  return path.join(keysDir(), `${slug}-${key.id}.key`);
}
function tell(title, body) {
  back('POST', '/api/notifications', { source: 'external', kind: 'external_key', title, body }).catch(() => { /* 알림 실패가 키 작업을 막지 않는다 */ });
}
function publicKey(k) {
  const keyFile = keyFileOf(k);
  return { id: k.id, name: k.name, prefix: k.prefix, allowedPaths: k.allowedPaths, allowBypass: k.allowBypass, lastUsedAt: k.lastUsedAt, keyFile: fs.existsSync(keyFile) ? keyFile : null };
}
function thisDevice() { return (require('./config').load() || {}).deviceId; }

async function keyCreate(p) {
  const name = String(p.name || '').trim();
  if (!name) throw coded('BAD_REQUEST', '키 이름이 필요합니다');
  const auth = { paths: [] };
  const allowedPaths = (Array.isArray(p.paths) ? p.paths : []).map((x) => allowedAbs(auth, x));
  const r = await back('POST', '/api/daemon/api-keys', { name, allowedPaths, allowBypass: p.allowBypass === true });
  const key = r.key;
  const keyFile = keyFileOf(key);
  fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, r.secret + '\n', { mode: 0o600 });
  tell('외부 연동 키가 만들어졌어요', `${name} · ${allowedPaths.join(', ') || '홈 폴더 전체'}${key.allowBypass ? ' · 승인 없이 실행 허용' : ''}`);
  return { ...publicKey(key), keyFile };
}
async function keyList() {
  const r = await back('GET', '/api/daemon/api-keys');
  const me = thisDevice();
  return { keys: (r.keys || []).filter((k) => k.deviceId === me).map(publicKey) };
}
async function keyRevoke(p) {
  const target = String(p.target || '').trim();
  const { keys } = await keyList();
  const hits = keys.filter((k) => String(k.id) === target || k.name === target || k.prefix === target);
  if (!hits.length) throw coded('KEY_NOT_FOUND', `키를 찾을 수 없습니다: ${target}`);
  if (hits.length > 1) throw coded('KEY_AMBIGUOUS', `같은 이름의 키가 여럿입니다. id 로 지정하세요: ${hits.map((k) => k.id).join(', ')}`);
  await back('DELETE', `/api/daemon/api-keys/${hits[0].id}`);
  if (hits[0].keyFile) fs.rmSync(hits[0].keyFile, { force: true });
  tell('외부 연동 키가 폐기됐어요', hits[0].name);
  return { ok: true, id: hits[0].id, name: hits[0].name };
}

/** 프로젝트 연결 — 키 + 키 경로 설정 + SDK + 스킬을 한 번에. 키는 이 폴더만 허용이 기본이다. */
async function connect(p) {
  const dir = allowedAbs({ paths: [] }, p.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw coded('BAD_REQUEST', '폴더가 없습니다');
  const cfgFile = path.join(dir, '.codingpt.json');
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) { /* 처음 연결 */ }
  const live = prior && prior.keyId ? (await keyList()).keys.find((k) => k.id === prior.keyId && k.keyFile) : null;
  let key = live;
  const reused = !!live && !p.renew;
  if (!reused) {
    key = await keyCreate({ name: p.name || path.basename(dir), paths: p.paths && p.paths.length ? p.paths : [dir], allowBypass: p.allowBypass });
    if (live) await keyRevoke({ target: String(live.id) });
  }
  const base = String((require('./config').load() || {}).serverUrl || '').replace(/\/+$/, '');
  const fetchText = async (rel) => {
    const res = await fetch(base + rel);
    if (!res.ok) throw coded('EXTERNAL_ERROR', `${rel} 을 받지 못했습니다(HTTP ${res.status})`);
    return res.text();
  };
  const [sdk, skill] = await Promise.all([fetchText('/api/v1/sdk/codingpt.mjs'), fetchText('/api/v1/skill')]);
  const files = [cfgFile];
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); files.push(f); };
  put('codingpt.mjs', sdk);
  put('.claude/skills/codingpt/SKILL.md', skill);
  put('.agents/skills/codingpt/SKILL.md', skill);
  if (p.mcp) {
    const f = path.join(dir, '.mcp.json');
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* 새 파일 */ }
    cur.mcpServers = { ...(cur.mcpServers || {}), codingpt: { command: 'node', args: ['codingpt.mjs', 'mcp'] } };
    fs.writeFileSync(f, JSON.stringify(cur, null, 2) + '\n');
    files.push(f);
  }
  fs.writeFileSync(cfgFile, JSON.stringify({ url: base, keyFile: key.keyFile, keyId: key.id, name: key.name }, null, 2) + '\n');
  return { ok: true, reused, name: key.name, allowedPaths: key.allowedPaths, allowBypass: key.allowBypass, keyFile: key.keyFile, files };
}

const LOCAL = { 'external.keyCreate': keyCreate, 'external.keyList': keyList, 'external.keyRevoke': keyRevoke, 'external.connect': connect };
function local(method, params) {
  const fn = LOCAL[method];
  if (!fn) return Promise.reject(coded('BAD_METHOD', `알 수 없는 명령입니다: ${method}`));
  return Promise.resolve().then(() => fn(params || {}));
}

async function rpcCaps() {
  const r = await conv('conv.caps', {});
  return { agents: r.agents, modes: r.modes, maxLive: r.maxLive };
}

const METHODS = {
  'ext.caps': rpcCaps, 'ext.workspaces': rpcWorkspaces, 'ext.workspaceCreate': rpcWorkspaceCreate,
  'ext.create': rpcCreate, 'ext.list': rpcList, 'ext.get': rpcGet, 'ext.send': rpcSend, 'ext.respond': rpcRespond,
  'ext.set': rpcSet, 'ext.interrupt': rpcInterrupt, 'ext.stop': rpcStop, 'ext.delete': rpcDelete,
};

function handle(method, params) {
  const fn = METHODS[method];
  if (!fn) return Promise.reject(coded('BAD_METHOD', `알 수 없는 명령입니다: ${method}`));
  if (!enabled()) return Promise.reject(coded('EXTERNAL_DISABLED', '이 PC 는 외부 연동을 꺼 두었습니다'));
  return Promise.resolve().then(() => fn(params || {}));
}

module.exports = { handle, local, METHODS, _internals: { allowedAbs, eventOf, storeFile, worktreesDir, keysDir } };
