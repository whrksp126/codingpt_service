/**
 * agent-control.js — 이름으로 부르는 에이전트 표면(`cpt agent …`, RPC `actl.*`).
 *
 * herdr 의 `agent start/prompt/wait/read` 계약을 우리 관찰 체계 위에 얹은 것이다(2026-10-30, docs/herdr-comparison.md).
 *  · orch 는 "묶음·일·시도" 를 기록하는 큰 층이고, 여기는 그보다 얇은 한 건짜리다 — 에이전트에게 말을 걸고 답을 받는다.
 *  · 터미널 실행·입력·관찰은 orch 가 주입받은 것(orch.deps())을 그대로 쓴다. 구현을 또 두지 않는다.
 *  · 다른 PC 에서도 같은 메서드를 부른다(`cpt --machine <이름> agent …` → 봉투 RPC). 그래서 모든 메서드는 **금방 돌아온다** —
 *    긴 대기는 호출하는 쪽이 `actl.get` 을 폴링한다(릴레이·Cloudflare 가 긴 요청을 끊는다). 끊겨도 잃는 것이 없다.
 *
 * 상태 어휘: working · blocked(승인·질문이 사람을 기다림) · idle · starting · gone · unknown(판단할 근거 없음 — 끝났다는 뜻이 아니다).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_ALIAS = { esc: 'Escape', escape: 'Escape', enter: 'Enter', tab: 'Tab', 'shift+tab': 'BTab', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', bspace: 'BSpace', backspace: 'BSpace' };
const ACTIVITY_MS = 5000;     // 프롬프트를 넣은 뒤 일을 시작했다는 신호를 기다리는 시간(herdr agent_prompt_stalled 와 같은 값)
const POLL_MS = 250;

function codedError(code, message) { return Object.assign(new Error(message), { code }); }
function orch() { return require('./orch'); }
function inj() {
  const d = orch().deps();
  if (!d || !d.createTerminal || !d.launch) throw codedError('AGENT_UNAVAILABLE', '이 PC 에서는 에이전트를 제어할 수 없습니다');
  return d;
}
function agentState() { return require('./agent-state'); }
function storeFile() { return path.join(runtime.stateDir(), 'agent-names.json'); }
function loadNames() {
  try { const v = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}
function saveNames(v) { fs.writeFileSync(storeFile(), JSON.stringify(v, null, 2), { mode: 0o600 }); }

/** 내부 상태 → 공개 상태. needsInput 은 "다 끝나고 입력을 기다림"(idle_prompt)이라 질문이 걸려 있을 때만 blocked 다. */
function publicState(rec) {
  if (!rec) return 'unknown';
  switch (rec.state) {
    case 'working': return 'working';
    case 'permission': return 'blocked';
    case 'needsInput': return rec.pending ? 'blocked' : 'idle';
    case 'idle': return 'idle';
    case 'launching': return 'starting';
    case 'ended': return 'gone';
    default: return 'unknown';
  }
}
function recOf(tsession) {
  const all = agentState().snapshot(null, { includeUnknown: true }) || [];
  return all.find((r) => r.key === tsession) || null;
}
function view(entry, rec) {
  return {
    name: entry.name || null,
    ref: entry.tsession,
    kind: (rec && rec.agent) || entry.kind || null,
    state: publicState(rec),
    cwd: entry.cwd != null ? entry.cwd : (rec && rec.cwdRel) || '',
    tid: entry.tid != null ? entry.tid : (rec && rec.tid),
    summary: rec && rec.summary ? String(rec.summary).slice(0, 400) : null,
    since: rec ? rec.since : null,
  };
}

/** 이름 또는 ref(tsession) → 대상. 사라진 이름은 여기서 지운다(이름이 다음 점유자를 따라가면 엉뚱한 곳에 말을 건다). */
async function resolve(target) {
  const t = String(target || '').trim();
  if (!t) throw codedError('BAD_PARAMS', '대상 에이전트(이름 또는 ref)가 필요합니다');
  const names = loadNames();
  const named = names[t];
  if (named) {
    const pr = await inj().probe({ tsession: named.tsession });
    if (pr && pr.exists === false) {
      delete names[t]; saveNames(names);
      throw codedError('AGENT_NOT_FOUND', `에이전트 ${t} 의 터미널이 사라졌습니다`);
    }
    return { ...named, name: t };
  }
  const rec = recOf(t);
  if (rec && rec.tid != null) return { name: null, tsession: t, cwd: rec.cwdRel || '', tid: rec.tid };
  throw codedError('AGENT_NOT_FOUND', `에이전트를 찾을 수 없습니다: ${t} (cpt agent list 로 확인)`);
}

function normalizeCwd(cwd) {
  const s = String(cwd == null ? '' : cwd).trim();
  const home = require('os').homedir();
  if (s === '~') return '';
  if (s.startsWith('~/')) return s.slice(2);
  if (s.startsWith(home + '/')) return s.slice(home.length + 1);
  return s;
}

async function rpcList() {
  const names = loadNames();
  const seen = new Set();
  const agents = [];
  const all = agentState().snapshot(null, { includeUnknown: true }) || [];
  for (const [name, e] of Object.entries(names)) {
    const rec = all.find((r) => r.key === e.tsession) || null;
    seen.add(e.tsession);
    agents.push(view({ ...e, name }, rec));
  }
  for (const rec of all) {
    if (seen.has(rec.key) || rec.state === 'ended' || !rec.agent) continue;
    agents.push(view({ tsession: rec.key }, rec));
  }
  return { agents };
}

async function rpcGet(p) {
  const e = await resolve(p.target);
  return view(e, recOf(e.tsession));
}

async function rpcStart(p) {
  const d = inj();
  const name = p.name == null || p.name === '' ? null : String(p.name);
  if (name && !NAME_RE.test(name)) throw codedError('BAD_PARAMS', '이름은 영문 소문자로 시작하고 영문 소문자·숫자·-·_ 만, 32자 이내입니다');
  const names = loadNames();
  if (name && names[name]) {
    const pr = await d.probe({ tsession: names[name].tsession });
    if (pr && pr.exists) throw codedError('AGENT_NAME_TAKEN', `이름 ${name} 은 이미 쓰고 있습니다`);
  }
  const kind = String(p.kind || 'claude');
  let spec = null;
  try {
    const l = await d.agents.list();
    spec = (Array.isArray(l) ? l : (l && l.agents) || []).find((a) => a.id === kind) || null;
  } catch (_) { spec = null; }
  if (spec && spec.installed === false) throw codedError('AGENT_NOT_INSTALLED', `이 PC 에 ${kind} 가 설치돼 있지 않습니다`);
  const cwd = normalizeCwd(p.cwd);
  const term = await d.createTerminal({ cwd, name: name || kind });
  const mArgs = d.agentModels && p.model ? d.agentModels.launchArgs(kind, { model: p.model }) : [];
  const args = [...(p.skipPermissions ? orch().permissionArgs(kind) : []), ...mArgs];
  const res = await d.launch({ cwd, index: term.tid, id: kind, ...(args.length ? { args } : {}), fresh: true, timeoutMs: 15000 });
  if (res && res.busy) throw codedError('AGENT_START_FAILED', '터미널에서 다른 명령이 실행 중입니다');
  const entry = { kind, cwd, tid: term.tid, tsession: term.tsession, createdAt: Date.now() };
  if (name) { const cur = loadNames(); cur[name] = entry; saveNames(cur); }
  const live = await orch().waitAgentLive(term.tsession, Math.min(Number(p.timeoutMs) || 30000, 45000));
  const out = view({ ...entry, name }, recOf(term.tsession));
  if (!live) return { ...out, ready: false, code: 'AGENT_NOT_READY', hint: '화면을 읽어 무엇에 막혔는지 보세요(cpt agent read). 신뢰·로그인 화면이면 send-keys 로 넘기거나 사용자에게 알립니다.' };
  return { ...out, ready: true };
}

async function rpcPrompt(p) {
  const d = inj();
  const text = String(p.text == null ? '' : p.text);
  if (!text.trim()) throw codedError('BAD_PARAMS', '보낼 내용이 필요합니다');
  const e = await resolve(p.target);
  const before = recOf(e.tsession);
  const state = publicState(before);
  //  승인·질문 창에 글을 넣으면 그 글이 답으로 들어간다 — 보내기 전에 막는다.
  if (state === 'blocked') throw codedError('AGENT_BLOCKED', '에이전트가 승인·질문을 기다리고 있습니다. agent read 로 내용을 보고 처리한 뒤 다시 보내세요');
  if (state === 'gone') throw codedError('AGENT_GONE', '에이전트가 종료됐습니다');
  const startV = before ? before.version : 0;
  await d.chatInput({ cwd: e.cwd, tid: e.tid, text, submit: true });
  //  "제출했다" 와 "일을 시작했다" 는 다르다 — 시작 신호를 봐야 성공이다. 못 봤다고 다시 보내면 안 된다(이중 지시).
  const deadline = Date.now() + ACTIVITY_MS;
  for (;;) {
    const r = recOf(e.tsession);
    const s = publicState(r);
    if (s === 'blocked' || s === 'working' || (r && r.version !== startV)) return { ...view(e, r), submitted: true, active: true };
    if (Date.now() >= deadline) return { ...view(e, r), submitted: true, active: false, code: 'AGENT_PROMPT_STALLED' };
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

async function rpcRead(p) {
  const d = inj();
  const e = await resolve(p.target);
  const lines = Math.max(10, Math.min(Number(p.lines) || 120, 2000));
  return { ...view(e, recOf(e.tsession)), text: await d.read({ cwd: e.cwd, tid: e.tid, lines }) };
}

/** 마지막 답 — 화면이 아니라 대화 기록에서 읽는다(TUI 화면은 줄바꿈·접힘으로 깨진다). 기록을 못 읽는 에이전트는 화면으로 대신한다. */
async function rpcResult(p) {
  const d = inj();
  const e = await resolve(p.target);
  const base = view(e, recOf(e.tsession));
  try {
    const o = await require('./transcript').handle('chat.open', { cwd: e.cwd, tid: e.tid, limit: 30 }, null);
    const msgs = (o && o.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.kind === 'text' && m.text) return { ...base, source: 'transcript', text: String(m.text) };
    }
  } catch (_) { /* 기록 없음 — 화면으로 */ }
  return { ...base, source: 'screen', text: await d.read({ cwd: e.cwd, tid: e.tid, lines: Number(p.lines) || 120 }) };
}

async function rpcSendKeys(p) {
  const d = inj();
  const e = await resolve(p.target);
  const raw = Array.isArray(p.keys) ? p.keys : [p.keys];
  const keys = raw.filter(Boolean).map((k) => {
    const s = String(k).toLowerCase();
    if (KEY_ALIAS[s]) return KEY_ALIAS[s];
    const m = /^ctrl\+([a-z])$/.exec(s);
    if (m) return `C-${m[1]}`;
    if (/^[0-9a-z]$/.test(s)) return s;
    throw codedError('BAD_PARAMS', `모르는 키입니다: ${k}`);
  });
  if (!keys.length) throw codedError('BAD_PARAMS', '보낼 키가 필요합니다');
  await d.keys({ cwd: e.cwd, tid: e.tid, keys });
  return { ok: true };
}

async function rpcStop(p) {
  const d = inj();
  const e = await resolve(p.target);
  if (!e.name && !p.force) throw codedError('AGENT_NOT_OWNED', '이름 없이 잡힌 에이전트는 네가 띄운 것이 아닐 수 있습니다. 정말이면 --force');
  await d.closeTerminal({ cwd: e.cwd, tid: e.tid });
  if (e.name) { const names = loadNames(); delete names[e.name]; saveNames(names); }
  return { ok: true };
}

const METHODS = { 'actl.list': rpcList, 'actl.get': rpcGet, 'actl.start': rpcStart, 'actl.prompt': rpcPrompt, 'actl.read': rpcRead, 'actl.result': rpcResult, 'actl.sendKeys': rpcSendKeys, 'actl.stop': rpcStop };

function handle(method, params) {
  const fn = METHODS[method];
  if (!fn) return Promise.reject(codedError('BAD_METHOD', `알 수 없는 명령입니다: ${method}`));
  return Promise.resolve().then(() => fn(params || {}));
}

// ── 다른 PC ─────────────────────────────────────────────────────────────────
//  허브(back)가 같은 계정의 기기끼리만 잇는다. 본문은 계정 열쇠로 봉인한 봉투로 보낸다(프롬프트·화면을 서버가 못 본다).
//  열쇠가 없는 계정만 평문 라우트(/api/daemon/agentctl)로 간다 — 사용자가 터미널을 폰에서 보는 것과 같은 신뢰 수준이다.
const PEER_TIMEOUT_MS = { 'actl.start': 50000, 'actl.prompt': 40000 };

function configOf() { try { return require('./config').load() || {}; } catch (_) { return {}; } }
function peerEnabled() { return process.env.CPT_PEER !== '0' && configOf().peerControl !== false; }

async function machines() {
  const back = require('./cpt-server').backFetch;
  const r = await back('GET', '/api/daemon/devices');
  const body = (r && (r.data || r)) || {};
  return (body.devices || []).filter((d) => d.role !== 'controller' && !d.virtual).map((d) => ({
    id: d.id, name: d.name, platform: d.platform, online: !!d.online, current: !!d.isCurrent,
  }));
}

async function pickMachine(sel) {
  const s = String(sel || '').trim();
  const all = await machines();
  const hits = all.filter((m) => String(m.id) === s || String(m.name).toLowerCase() === s.toLowerCase());
  const pool = hits.length ? hits : all.filter((m) => String(m.name).toLowerCase().includes(s.toLowerCase()));
  if (!pool.length) throw codedError('MACHINE_NOT_FOUND', `그런 PC 가 없습니다: ${s} (cpt machine list)`);
  if (pool.length > 1) throw codedError('MACHINE_AMBIGUOUS', `여러 PC 가 맞습니다: ${pool.map((m) => m.name).join(', ')}`);
  if (!pool[0].online) throw codedError('MACHINE_OFFLINE', `${pool[0].name} 이(가) 오프라인입니다`);
  return pool[0];
}

async function peerCall(machine, method, params) {
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) throw codedError('BAD_METHOD', `다른 PC 로 보낼 수 없는 명령입니다: ${method}`);
  const m = await pickMachine(machine);
  if (m.current) return handle(method, params);
  const timeoutMs = PEER_TIMEOUT_MS[method] || 20000;
  const raise = (e, code) => { throw codedError(code || 'PEER_ERROR', e || '요청이 실패했습니다'); };
  let sealed = null;
  try {
    sealed = await require('./e2ee-local').handle('e2ee.rpc', { method, params, hostDeviceId: m.id, timeoutMs });
  } catch (e) {
    //  결과 불명(시간 초과)에서 평문으로 다시 보내면 이중 실행이다. 봉투 자체를 못 쓸 때만 평문으로 내려간다.
    if (!['E2EE_UNSUPPORTED', 'E2EE_NO_KEY', 'E2EE_DISABLED'].includes(e && e.code)) throw e;
  }
  if (sealed) { if (sealed.ok) return sealed.r; raise(sealed.e, sealed.code); }
  const back = require('./cpt-server').backFetch;
  const r = await back('POST', '/api/daemon/agentctl', { hostDeviceId: m.id, method, params });
  return r && r.data !== undefined ? r.data : r;
}

module.exports = { handle, machines, peerCall, peerEnabled, publicState, _internals: { resolve, normalizeCwd, NAME_RE } };
