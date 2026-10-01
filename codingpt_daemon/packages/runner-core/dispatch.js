/**
 * dispatch.js — F1 한 줄 지시(automation-design §3). 설계 정본: codingpt_daemon/docs/automation-design.md.
 *
 * 한 줄 요약: "폰이 모든 PC 의 카탈로그를 모아(dispatch.catalog) 활성 PC 에 넘긴다(dispatch.plan) → 그 PC 가
 *  **사용자 자신의 CLI 를 헤드리스로** 1턴 돌려 플랜 JSON 을 받는다 → 실패·미로그인·타임아웃이면 결정적
 *  이름 매칭 폴백 → 클라가 플랜 카드로 조정 후 [시작](기존 task.create / auto.create)". 자동 실행 없음.
 *
 * 경계:
 *  · 이 모듈은 **계획만** 한다. 작업·자동화 생성은 클라가 기존 RPC 로 한다(§3.1 6).
 *  · 헤드리스 CLI 는 원본 바이너리(agents.resolveBin — 우리 래퍼 제외 → 훅·statusLine 주입 없음)를 빈 폴더에서
 *    도구 없이 1턴만 돌린다. 자격증명은 읽지 않는다(CLI 가 자기 로그인으로 부른다 — agent.js 와 같은 등급).
 *  · 카탈로그 내용(README 머리·커밋 제목)은 봉인 경로로만 폰에 간다. 알림·ui_command 에는 planId 만.
 *  · 주입(configure): notify, backFetch, deviceId, log, tasks, agents, fsRead(= fs.readHead). 테스트는 스텁.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const runtime = require('./runtime');
const taskGit = require('./task-git');

const { codedError } = taskGit;

// ── 상수 ─────────────────────────────────────────────────────────────────────
const ERROR_CODES = ['DISPATCH_DISABLED', 'DISPATCH_NOT_FOUND', 'PLANNER_UNAVAILABLE', 'PLANNER_TIMEOUT',
  'PLANNER_FAILED', 'BAD_PLAN', 'CATALOG_TOO_LARGE'];
const FALLBACK_REASONS = ['PLANNER_UNAVAILABLE', 'PLANNER_TIMEOUT', 'PLANNER_FAILED', 'BAD_PLAN'];
const PLANNER_ORDER = ['claude', 'codex', 'gemini'];
const TASK_AGENT_IDS = new Set(PLANNER_ORDER);
const INSTRUCTION_MAX_BYTES = 4000;
const CATALOG_IN_MAX_BYTES = 256 * 1024;
const CATALOG_OUT_MAX_BYTES = 48 * 1024;
const CATALOG_MAX_WS = 40;
const CATALOG_CACHE_MS = 10 * 60 * 1000;
const PLANNER_CACHE_MS = 10 * 60 * 1000;
const PLAN_KEEP_MS = 24 * 3600 * 1000;
const OP_IDS_KEEP = 20;
const README_HEAD_BYTES = 600;
const COMMIT_SUBJECT_MAX = 80;
const TOP_DIRS_MAX = 12;
const REPO_BUDGET_MS = 3000;
const REPO_CONCURRENCY = 4;
const PLAN_TASKS_MAX = 4;
const PLAN_RUNS_MAX = 4;
const PLAN_AUTOS_MAX = 3;
const PLAN_QUESTIONS_MAX = 3;
const PROMPT_MAX_BYTES = 30000;
const TITLE_MAX = 200;
const TRUST_RE = /Do you trust|trust this folder/i;
const TOP_DIR_SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'tmp', '__pycache__', 'Pods']);
const TRIGGER_TYPES = new Set(['schedule', 'git.commits', 'github.issues', 'pr.ci_failed', 'pr.review_comments', 'task.event']);
const ACTION_TYPES = new Set(['task.create', 'terminal.prompt', 'notify']);
// §3.5 1 불용어
const STOPWORDS = new Set(['좀', '해줘', '해주세요', 'the', 'a', 'to', 'in', 'on', '추가', '수정', '만들어']);

// 와이어 모양(§3.2·§3.3) — task-contract.test.js 가 rpc-dispatch.* 픽스처와 대조한다.
const CATALOG_FIELDS = ['host', 'hostName', 'generatedAt', 'agents', 'workspaces', 'truncated'];
const WORKSPACE_FIELDS = ['id', 'name', 'path', 'subdir', 'remoteUrl', 'github', 'branch', 'dirtyCount', 'readmeHead',
  'recentCommits', 'topDirs', 'lastActivityAt'];
const PLAN_FIELDS = ['v', 'planner', 'summary', 'tasks', 'automations', 'questions'];
const PLANNER_FIELDS = ['agent', 'mode', 'durationMs', 'fallbackReason'];
const PLAN_TASK_FIELDS = ['host', 'workspaceId', 'repo', 'subdir', 'base', 'title', 'prompt', 'agents', 'confidence', 'why'];

// 플래너 시스템 프롬프트(고정 한국어) — 도구 없이 스키마 JSON 하나만.
const SYS_PROMPT = [
  '너는 작업 계획기다. 도구를 쓰지 말고, 설명 없이 아래 JSON 스키마의 객체 하나만 출력해라(코드 블록·머리말 금지).',
  '입력: "카탈로그"(사용자 PC 들의 저장소 목록 JSON)와 "지시"(사용자 한 문장).',
  '할 일: 지시를 수행할 작업(tasks)을 정하고, 지시에 반복·조건("매일", "…마다", "…하면", "자동으로")이 있을 때만 자동화(automations)를 제안한다.',
  '스키마:',
  '{"summary": string(한 줄 요약),',
  ' "tasks": [{"host": 카탈로그 host 숫자, "workspaceId": 카탈로그 workspaces[].id, "subdir": "" 또는 그 워크스페이스 topDirs 중 하나,',
  '            "base": 브랜치 이름(모르면 카탈로그 branch), "title": 짧은 제목, "prompt": 에이전트에게 줄 구체적 지시,',
  '            "agents": [{"id": "claude"|"codex"|"gemini"(그 host 에 installed 인 것만), "count": 1~4}], "confidence": 0~1, "why": 한 줄 근거}],',
  ' "automations": [{"host": 숫자, "draft": {"name": string, "trigger": {"type": "schedule", "cron": "0 9 * * *", "tz": "Asia/Seoul"}',
  '                  | {"type": "github.issues", "repo": 카탈로그 path, "labels": [..], "state": "open"} | {"type": "git.commits", "repo": path, "branch": "main", "remote": "origin"},',
  '                  "actions": [{"type": "task.create", "repo": path, "agents": [{"id": "claude", "count": 1}], "title": "{issue.title}", "prompt": "…"}]}, "why": string}],',
  ' "questions": [모호한 점이 있으면 짧은 질문, 최대 3개]}',
  '규칙: tasks 최대 4개, 모든 tasks 의 agents count 합 ≤ 4. automations 최대 3개. 카탈로그에 없는 host/workspaceId 는 쓰지 마라.',
  '반복·조건 표현이 없으면 automations 는 빈 배열. 확신이 없으면 confidence 를 낮추고 questions 에 적어라.',
].join('\n');

// ── 주입 ─────────────────────────────────────────────────────────────────────
const noop = () => {};
let inj = {
  notify: noop,          // ({ids:[planId], reason:'done'|'failed'}) → cpt-server.notifyDispatchChanged
  backFetch: null,       // (method, apiPath, body) → json
  deviceId: () => null,
  log: (m) => console.log(m),
  tasks: null,           // require('./tasks') — recentAgent()
  agents: null,          // require('./agents') — list/resolveBin/loginStatus/CATALOG
  fsRead: null,          // (rel, maxBytes) → string (fs.readHead)
  now: () => Date.now(),
  hostName: null,        // () → string (기본 daemon.json deviceName || hostname)
};
let timings = { plannerTimeoutMs: 90000, sweepMs: 3600 * 1000, repoBudgetMs: REPO_BUDGET_MS };

function configure(opts = {}) {
  for (const k of ['notify', 'backFetch', 'deviceId', 'log', 'fsRead', 'now', 'hostName']) {
    if (opts[k] !== undefined) inj[k] = typeof opts[k] === 'function' ? opts[k] : (k === 'now' ? () => Date.now() : (k === 'log' ? noop : null));
  }
  if (inj.notify == null) inj.notify = noop;
  if (inj.deviceId == null) inj.deviceId = () => null;
  if (opts.tasks !== undefined) inj.tasks = opts.tasks;
  if (opts.agents !== undefined) inj.agents = opts.agents;
  if (opts.timings && typeof opts.timings === 'object') timings = { ...timings, ...opts.timings };
  return module.exports;
}
const nowFn = () => inj.now();
const log = (m) => { try { inj.log(m); } catch (_) { /* noop */ } };
function agentsLib() { return inj.agents || require('./agents'); }
function tasksLib() { try { return inj.tasks || require('./tasks'); } catch (_) { return null; } }
function fsLib() { return require('./fs'); }
function readHead(rel, max) {
  try { return inj.fsRead ? String(inj.fsRead(rel, max) || '') : fsLib().readHead(rel, max); } catch (_) { return ''; }
}
function busEmit(type, payload) {
  let ev = null;
  try { ev = require('./events'); } catch (_) { ev = null; }
  if (!ev || typeof ev.emit !== 'function') return;
  try { ev.emit(type, payload); } catch (e) { log(`[dispatch] 이벤트 발행 실패(${type}): ${e && e.message}`); }
}

// ── 경로 ─────────────────────────────────────────────────────────────────────
function dispatchDir() { return path.join(runtime.stateDir(), 'dispatch'); }
function plannerCwd() { return path.join(dispatchDir(), 'cwd'); }
function planFile(planId) { return path.join(dispatchDir(), `${planId}.json`); }
function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch (_) { /* noop */ }
}
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) { /* noop */ }
  fs.renameSync(tmp, file);
}
function rootReal() { try { return fs.realpathSync(runtime.root()); } catch (_) { return path.resolve(runtime.root()); } }
function relHome(abs) {
  const root = rootReal();
  let r = abs;
  try { r = fs.realpathSync(abs); } catch (_) { /* noop */ }
  if (r !== root && !r.startsWith(root + path.sep)) return null;
  return path.relative(root, r).split(path.sep).join('/');
}
/** 작업 워크스페이스(worktree) 술어 — PC/앱 `isTaskWorkspace` 와 같은 기준(홈-상대 `<stateDir>/worktrees/`). */
function isTaskWorkspacePath(localPath) {
  const wt = path.relative(runtime.root(), path.join(runtime.stateDir(), 'worktrees')).split(path.sep).join('/');
  const lp = String(localPath || '').replace(/^\/+/, '');
  return lp === wt || lp.startsWith(wt + '/');
}

// ── 파라미터 ─────────────────────────────────────────────────────────────────
function reqOpId(p) {
  const v = p.opId;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw codedError('BAD_PARAMS', 'opId(UUID)가 필요합니다');
  return v;
}
function rand36(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += (bytes[i] % 36).toString(36);
  return s;
}
function bytesOf(s) { return Buffer.byteLength(String(s), 'utf8'); }
function capBytes(s, max) {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length <= max) return String(s);
  let end = max;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}
function validBranchName(b) {
  return typeof b === 'string' && b.length > 0 && b.length <= 200 && !b.startsWith('-') && !/[\s~^:?*[\\\x00-\x1f]/.test(b)
    && !b.includes('..') && !b.includes('@{') && !b.endsWith('/') && !b.endsWith('.lock') && !b.startsWith('/');
}

// ── 카탈로그(§3.2) ───────────────────────────────────────────────────────────
let catalogCache = null; // { at, value }

function githubOf(url) {
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function withBudget(promise, ms) {
  let timer = null;
  const cap = new Promise((res) => { timer = setTimeout(() => res(undefined), ms); if (timer.unref) timer.unref(); });
  try { return await Promise.race([promise, cap]); } finally { clearTimeout(timer); }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

function topDirsOf(abs) {
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return []; }
  return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !TOP_DIR_SKIP.has(e.name))
    .map((e) => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, TOP_DIRS_MAX);
}

function readmeOf(localPath) {
  for (const name of ['README.md', 'README', 'readme.md']) {
    const rel = `${String(localPath).replace(/\/+$/, '')}/${name}`;
    let abs = null;
    try { abs = fsLib().safeResolve(rel); } catch (_) { abs = null; }
    if (!abs || !fs.existsSync(abs)) continue;
    return readHead(rel, README_HEAD_BYTES);
  }
  return '';
}

async function workspaceInfo(w) {
  let abs;
  try { abs = fsLib().safeResolve(w.localPath); } catch (_) { return null; }
  let st = null;
  try { st = fs.statSync(abs); } catch (_) { st = null; }
  if (!st || !st.isDirectory()) return null; // 폴더 없음 → 항목 생략
  const minimal = {
    id: String(w.id), name: String(w.name || path.basename(abs)), path: String(w.localPath), subdir: '',
    remoteUrl: null, github: null, branch: null, dirtyCount: 0, readmeHead: '', recentCommits: [], topDirs: [], lastActivityAt: 0,
  };
  const full = (async () => {
    const info = await taskGit.repoInfo(abs);
    if (!info) return false; // 저장소 아님 — 작업을 만들 수 없으니 카탈로그에서 뺀다
    const top = relHome(info.top);
    if (top == null) return false;
    const opt = { cwd: abs, timeout: timings.repoBudgetMs };
    const [br, stt, logs, last, remote] = await Promise.all([
      taskGit.git(['symbolic-ref', '--short', '-q', 'HEAD'], opt),
      taskGit.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], opt),
      taskGit.git(['log', '-5', '--format=%s'], opt),
      taskGit.git(['log', '-1', '--format=%ct'], opt),
      taskGit.remoteUrl(abs),
    ]);
    const out = { ...minimal };
    out.path = top;
    out.subdir = info.subdir || '';
    out.remoteUrl = remote || null;
    out.github = githubOf(remote);
    out.branch = br.ok && br.out.trim() ? br.out.trim() : null;
    out.dirtyCount = stt.ok ? taskGit._parse.parseStatusZ(stt.out).length : 0;
    out.recentCommits = logs.ok ? logs.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).map((l) => l.slice(0, COMMIT_SUBJECT_MAX)) : [];
    out.lastActivityAt = last.ok ? (parseInt(last.out.trim(), 10) || 0) * 1000 : 0;
    out.topDirs = topDirsOf(abs);
    out.readmeHead = readmeOf(w.localPath);
    return out;
  })().catch(() => false);
  const res = await withBudget(full, timings.repoBudgetMs);
  if (res === false) return null;
  if (res === undefined) { // 3s 초과 — 가진 것만(이름·경로)
    minimal.topDirs = topDirsOf(abs);
    return minimal;
  }
  return res;
}

async function agentsSummary() {
  const lib = agentsLib();
  let items = [];
  try { items = await lib.list({ version: false }); } catch (_) { items = []; }
  const out = [];
  for (const id of PLANNER_ORDER) {
    const hit = items.find((a) => a.id === id);
    const installed = !!(hit && hit.installed);
    let loggedIn = false;
    if (installed) {
      let st = null;
      try { st = lib.loginStatus ? await lib.loginStatus(id) : null; } catch (_) { st = null; }
      loggedIn = st === 'in' ? true : st === 'out' ? false : null;
    }
    out.push({ id, installed, loggedIn });
  }
  return out;
}

function hostNameOf() {
  if (inj.hostName) { try { const n = inj.hostName(); if (n) return String(n); } catch (_) { /* noop */ } }
  try { const c = require('./config').load(); if (c && c.deviceName) return String(c.deviceName); } catch (_) { /* noop */ }
  return os.hostname();
}

/** 크기 상한(40개·48KB) — 넘치면 lastActivityAt 오래된 순으로 자른다(에러 아님). */
function capCatalog(cat) {
  let truncated = !!cat.truncated;
  cat.workspaces.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  if (cat.workspaces.length > CATALOG_MAX_WS) { cat.workspaces = cat.workspaces.slice(0, CATALOG_MAX_WS); truncated = true; }
  while (cat.workspaces.length && bytesOf(JSON.stringify(cat)) > CATALOG_OUT_MAX_BYTES) { cat.workspaces.pop(); truncated = true; }
  cat.truncated = truncated;
  return cat;
}

async function rpcCatalog(p) {
  const now = nowFn();
  if (!p.refresh && catalogCache && now - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.value;
  if (!inj.backFetch) throw codedError('DISPATCH_DISABLED', '서버 연결이 없습니다');
  const host = inj.deviceId();
  const list = await inj.backFetch('GET', '/api/daemon/workspaces');
  const arr = Array.isArray(list) ? list : (list && Array.isArray(list.workspaces) ? list.workspaces : []);
  const seen = new Set();
  const mine = arr.filter((w) => {
    if (!w || w.compute !== 'local' || typeof w.localPath !== 'string' || !w.localPath) return false;
    if (host == null || String(w.hostDeviceId) !== String(host)) return false;
    if (isTaskWorkspacePath(w.localPath) || seen.has(String(w.id))) return false;
    seen.add(String(w.id));
    return true;
  });
  const [workspaces, agents] = await Promise.all([
    mapLimit(mine, REPO_CONCURRENCY, (w) => workspaceInfo(w).catch(() => null)),
    agentsSummary(),
  ]);
  const cat = capCatalog({
    host, hostName: hostNameOf(), generatedAt: now, agents,
    workspaces: workspaces.filter(Boolean), truncated: false,
  });
  catalogCache = { at: now, value: cat };
  return cat;
}

// ── 결정적 폴백(§3.5 — 순수 함수) ─────────────────────────────────────────────
function tokenize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * planFallback(instruction, catalog, {now, recentAgentByHost}) → Plan(mode:'fallback').
 *  점수: name 정확 +6(아니면 name 토큰 +3) · topDirs 고유 토큰 +3(→ subdir) · path 마지막 2 세그먼트 토큰 +2 ·
 *  github.repo 토큰 +3 · README 토큰 +1 씩(≤ +2) · 최근 7일 활동 +1. 최고점 ≥ 3 → 그 워크스페이스(동점 = 최신 활동).
 *  카탈로그 전체에 워크스페이스가 정확히 1개면 무조건 그것. 그 외 workspaceId:null. **자동화는 제안하지 않는다.**
 */
function planFallback(instruction, catalog, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const recent = opts.recentAgentByHost || {};
  const text = String(instruction || '').trim();
  const toks = new Set(tokenize(text));
  const hosts = (catalog && Array.isArray(catalog.hosts)) ? catalog.hosts.filter((h) => h && Array.isArray(h.workspaces)) : [];
  const cands = [];
  for (const h of hosts) for (const ws of h.workspaces) if (ws && ws.id) cands.push({ h, ws });
  const scoreOf = ({ ws }) => {
    let score = 0;
    let subdir = null;
    const nameNorm = String(ws.name || '').normalize('NFKC').toLowerCase();
    const nameToks = tokenize(ws.name);
    if (nameNorm && toks.has(nameNorm)) score += 6;
    else if (nameToks.some((t) => toks.has(t))) score += 3;
    const nameSet = new Set(nameToks);
    let bestDir = null; let bestHits = 0;
    for (const d of (Array.isArray(ws.topDirs) ? ws.topDirs : [])) {
      const own = tokenize(d).filter((t) => !nameSet.has(t));
      const hits = own.filter((t) => toks.has(t)).length + (toks.has(String(d).normalize('NFKC').toLowerCase()) ? 1 : 0);
      if (hits > bestHits) { bestHits = hits; bestDir = d; }
    }
    if (bestDir) { score += 3; subdir = ws.subdir ? `${ws.subdir}/${bestDir}` : bestDir; }
    const segs = String(ws.path || '').split('/').filter(Boolean).slice(-2);
    if (tokenize(segs.join(' ')).some((t) => toks.has(t))) score += 2;
    if (ws.github && ws.github.repo && tokenize(ws.github.repo).some((t) => toks.has(t))) score += 3;
    const readme = new Set(tokenize(ws.readmeHead));
    let rd = 0;
    for (const t of toks) { if (readme.has(t)) rd++; if (rd >= 2) break; }
    score += rd;
    if (ws.lastActivityAt && now - ws.lastActivityAt <= 7 * 24 * 3600 * 1000) score += 1;
    return { score, subdir };
  };
  let pick = null;
  let pickScore = 0;
  let pickSub = null;
  if (cands.length === 1) {
    pick = cands[0];
    const s = scoreOf(pick);
    pickScore = s.score; pickSub = s.subdir;
  } else {
    for (const c of cands) {
      const s = scoreOf(c);
      if (s.score < 3) continue;
      if (!pick || s.score > pickScore || (s.score === pickScore && (c.ws.lastActivityAt || 0) > (pick.ws.lastActivityAt || 0))) {
        pick = c; pickScore = s.score; pickSub = s.subdir;
      }
    }
  }
  const h = pick ? pick.h : hosts[0] || null;
  const agentOf = (host) => {
    const installed = new Set(((host && host.agents) || []).filter((a) => a && a.installed).map((a) => a.id));
    const rec = host ? recent[String(host.host)] : null;
    if (rec && TASK_AGENT_IDS.has(rec) && (installed.has(rec) || !installed.size)) return rec;
    return PLANNER_ORDER.find((id) => installed.has(id)) || 'claude';
  };
  const title = [...text.split('\n')[0]].slice(0, 60).join('').trim() || text.slice(0, 60);
  const task = {
    host: h ? h.host : null,
    workspaceId: pick ? pick.ws.id : null,
    repo: pick ? pick.ws.path : null,
    subdir: pick ? (pickSub != null ? pickSub : (pick.ws.subdir || '')) : '',
    base: pick ? (pick.ws.branch || 'main') : null,
    title,
    prompt: capBytes(text, PROMPT_MAX_BYTES),
    agents: [{ id: agentOf(h), count: 1 }],
    confidence: pick ? Math.min(1, Math.round((pickScore / 10) * 100) / 100) : 0,
    why: pick ? `이름으로 고름(점수 ${pickScore})` : '',
  };
  return {
    v: 1,
    planner: { agent: null, mode: 'fallback', durationMs: 0, fallbackReason: opts.reason || null },
    summary: title,
    tasks: h ? [task] : [],
    automations: [],
    questions: [],
  };
}

// ── 플랜 검증(§3.3 — 항목 단위로 버린다) ─────────────────────────────────────
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function validatePlan(raw, catalog, instruction) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hosts = new Map(((catalog && catalog.hosts) || []).filter((h) => h && h.host != null).map((h) => [String(h.host), h]));
  const tasks = [];
  let runs = 0;
  for (const it of (Array.isArray(raw.tasks) ? raw.tasks : [])) {
    if (tasks.length >= PLAN_TASKS_MAX) break;
    if (!it || typeof it !== 'object') continue;
    const h = hosts.get(String(it.host));
    if (!h) continue;
    const ws = (h.workspaces || []).find((w) => w && w.id === it.workspaceId);
    if (!ws) continue;
    const installed = new Set((h.agents || []).filter((a) => a && a.installed).map((a) => a.id));
    const merged = new Map();
    for (const a of (Array.isArray(it.agents) ? it.agents : [])) {
      if (!a || !TASK_AGENT_IDS.has(a.id) || !installed.has(a.id)) continue;
      merged.set(a.id, Math.min(4, (merged.get(a.id) || 0) + clampInt(a.count, 1, 4, 1)));
    }
    const agents = [...merged].map(([id, count]) => ({ id, count }));
    const n = agents.reduce((s, a) => s + a.count, 0);
    if (!n || runs + n > PLAN_RUNS_MAX) continue;
    const sub = typeof it.subdir === 'string' ? it.subdir.trim().replace(/^\/+|\/+$/g, '') : '';
    const dirs = Array.isArray(ws.topDirs) ? ws.topDirs : [];
    let subdir = ws.subdir || '';
    if (sub && dirs.includes(sub)) subdir = ws.subdir ? `${ws.subdir}/${sub}` : sub;
    else if (sub && sub === ws.subdir) subdir = sub;
    const prompt = typeof it.prompt === 'string' && it.prompt.trim() ? capBytes(it.prompt, PROMPT_MAX_BYTES) : capBytes(String(instruction || ''), PROMPT_MAX_BYTES);
    const conf = Number(it.confidence);
    tasks.push({
      host: h.host, workspaceId: ws.id, repo: ws.path, subdir,
      base: validBranchName(it.base) ? it.base : (ws.branch || 'main'),
      title: str(it.title, TITLE_MAX) || [...String(instruction || '')].slice(0, 60).join('').trim(),
      prompt, agents,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      why: str(it.why, 300),
    });
    runs += n;
  }
  const automations = [];
  for (const it of (Array.isArray(raw.automations) ? raw.automations : [])) {
    if (automations.length >= PLAN_AUTOS_MAX) break;
    if (!it || typeof it !== 'object') continue;
    const h = hosts.get(String(it.host));
    const d = it.draft;
    if (!h || !d || typeof d !== 'object' || Array.isArray(d)) continue;
    if (!d.trigger || !TRIGGER_TYPES.has(d.trigger.type)) continue;
    if (!Array.isArray(d.actions) || !d.actions.length || d.actions.length > 5) continue;
    if (!d.actions.every((a) => a && ACTION_TYPES.has(a.type))) continue;
    let draft;
    try { draft = JSON.parse(JSON.stringify(d)); } catch (_) { continue; }
    if (bytesOf(JSON.stringify(draft)) > 20000) continue;
    automations.push({ host: h.host, draft, why: str(it.why, 300) });
  }
  if (!tasks.length && !automations.length) return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim().slice(0, 300)).slice(0, PLAN_QUESTIONS_MAX);
  return {
    v: 1, planner: null,
    summary: str(raw.summary, 300) || [...String(instruction || '')].slice(0, 60).join('').trim(),
    tasks, automations, questions,
  };
}

/** 모델 출력 문자열 → 첫 `{` ~ 마지막 `}` 를 JSON 으로. 실패 null. */
function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

// ── 플래너 선택·실행 ──────────────────────────────────────────────────────────
let plannerCache = null; // { at, usable:[{id, bin}] }
async function usablePlanners() {
  if (plannerCache && Date.now() - plannerCache.at < PLANNER_CACHE_MS) return plannerCache.usable;
  const lib = agentsLib();
  const usable = [];
  for (const id of PLANNER_ORDER) {
    let bin = null;
    try { bin = await lib.resolveBin(id); } catch (_) { bin = null; }
    if (!bin) continue;
    let st = null;
    try { st = lib.loginStatus ? await lib.loginStatus(id) : null; } catch (_) { st = null; }
    if (st === 'out') continue;
    usable.push({ id, bin });
  }
  plannerCache = { at: Date.now(), usable };
  return usable;
}
async function pickPlanner(prefer) {
  const usable = await usablePlanners();
  if (prefer && TASK_AGENT_IDS.has(prefer)) { const hit = usable.find((u) => u.id === prefer); if (hit) return hit; }
  return usable[0] || null;
}

function userPrompt(catalog, instruction) {
  return `## 카탈로그\n${JSON.stringify(catalog)}\n\n## 지시\n${instruction}\n`;
}

async function plannerEnv() {
  let base = null;
  try { base = await taskGit.baseTools(); } catch (_) { base = null; }
  const env = { ...((base && base.env) || process.env) };
  delete env.TMUX;
  // 우리 터미널 좌표(cpt 컨텍스트)를 헤드리스 CLI 에 넘기지 않는다 — 훅이 있더라도 이 PC 의 어느 터미널에도 붙지 않게.
  for (const k of Object.keys(env)) if (/^CPT_/.test(k)) delete env[k];
  env.CPT_HOOKS_DISABLED = '1';
  return env;
}

/**
 * 헤드리스 1턴 — CATALOG `headless` 규칙대로 → 파싱된 raw 플랜 객체.
 *  throw: PLANNER_TIMEOUT · PLANNER_FAILED{stderr 앞 300자} · BAD_PLAN(JSON 추출 실패).
 */
async function runHeadless(planner, instruction, catalog, planId) {
  const spec = ((agentsLib().CATALOG || []).find((c) => c.id === planner.id) || {}).headless;
  if (!spec) throw codedError('PLANNER_UNAVAILABLE', '헤드리스 실행 규칙이 없습니다');
  ensureDir(dispatchDir());
  ensureDir(plannerCwd());
  const env = await plannerEnv();
  const user = userPrompt(catalog, instruction);
  let args = spec.args.slice();
  args.push(...require('./agent-models').headlessArgs(planner.id, planner));
  let input = null;
  let outFile = null;
  if (spec.parse === 'claude-json') { args.push(spec.sysFlag, SYS_PROMPT); input = user; } else if (spec.parse === 'last-message') {
    outFile = path.join(dispatchDir(), `${planId}.last.txt`);
    args.push(spec.outFileFlag, outFile);
    input = `${SYS_PROMPT}\n\n${user}`;
  } else if (spec.parse === 'gemini-json') {
    args = [...args, spec.promptFlag, `${SYS_PROMPT}\n\n${user}`];
  } else throw codedError('PLANNER_UNAVAILABLE', '알 수 없는 헤드리스 형식입니다');
  let r;
  try {
    r = await taskGit.exec(planner.bin, args, { cwd: plannerCwd(), timeout: timings.plannerTimeoutMs, input, env });
    if (r.timedOut) throw codedError('PLANNER_TIMEOUT', '계획이 시간 안에 끝나지 않았습니다');
    if (TRUST_RE.test(r.out) || r.code !== 0) {
      throw codedError('PLANNER_FAILED', String(r.err || r.out || `exit ${r.code}`).trim().slice(0, 300));
    }
    let text = null;
    if (spec.parse === 'claude-json') {
      const j = parseLastJson(r.out);
      if (!j || j.is_error === true || typeof j.result !== 'string') throw codedError('PLANNER_FAILED', String((j && j.result) || r.err || '').slice(0, 300));
      text = j.result;
    } else if (spec.parse === 'last-message') {
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) { text = r.out; }
    } else {
      const j = parseLastJson(r.out);
      if (!j || typeof j.response !== 'string') throw codedError('PLANNER_FAILED', String(r.err || '').slice(0, 300));
      text = j.response;
    }
    const obj = extractJson(text);
    if (!obj) throw codedError('BAD_PLAN', '플랜 JSON 을 찾을 수 없습니다');
    return obj;
  } finally {
    if (outFile) { try { fs.rmSync(outFile, { force: true }); } catch (_) { /* noop */ } }
  }
}

function parseLastJson(out) {
  const s = String(out || '').trim();
  try { return JSON.parse(s); } catch (_) { /* 아래 */ }
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch (_) { /* 다음 */ } }
  return null;
}

// ── 플랜 저장소 ───────────────────────────────────────────────────────────────
const plans = new Map();   // planId → rec
let recentOps = [];        // [{opId, planId}]
const running = new Set(); // Promise(테스트 _drain)
function track(p) { running.add(p); p.finally(() => running.delete(p)).catch(() => {}); return p; }

function publicRec(rec) {
  const out = { planId: rec.planId, state: rec.state, startedAt: rec.startedAt, finishedAt: rec.finishedAt || null };
  if (rec.plan) out.plan = rec.plan;
  if (rec.error) out.error = rec.error;
  return out;
}

function activeReasons() {
  return [...plans.values()].filter((r) => r.state === 'planning').map((r) => `dispatch:${r.planId}`);
}
function activityChanged() {
  const reasons = activeReasons();
  busEmit('activity.changed', { active: reasons.length > 0, reasons, source: 'dispatch' });
}

function recentAgentByHost() {
  const host = inj.deviceId();
  const lib = tasksLib();
  let a = null;
  try { a = lib && typeof lib.recentAgent === 'function' ? lib.recentAgent() : null; } catch (_) { a = null; }
  return host != null && a ? { [String(host)]: a } : {};
}

async function runPlan(rec, instruction, catalog, planner) {
  const t0 = Date.now();
  let plan = null;
  let reason = null;
  if (!planner) reason = 'PLANNER_UNAVAILABLE';
  else {
    try {
      const raw = await runHeadless(planner, instruction, catalog, rec.planId);
      plan = validatePlan(raw, catalog, instruction);
      if (!plan) reason = 'BAD_PLAN';
    } catch (e) {
      reason = e && FALLBACK_REASONS.includes(e.code) ? e.code : 'PLANNER_FAILED';
      log(`[dispatch] ${rec.planId} 플래너 실패(${reason}): ${String((e && e.message) || '').slice(0, 200)}`);
    }
  }
  const durationMs = Date.now() - t0;
  try {
    if (plan) plan.planner = { agent: planner.id, mode: 'cli', durationMs, fallbackReason: null };
    else {
      plan = planFallback(instruction, catalog, { now: nowFn(), recentAgentByHost: recentAgentByHost(), reason });
      plan.planner = { agent: planner ? planner.id : null, mode: 'fallback', durationMs, fallbackReason: reason };
    }
    rec.state = 'done';
    rec.plan = plan;
  } catch (e) {
    rec.state = 'failed';
    rec.error = { code: 'BAD_PLAN', message: String((e && e.message) || e).slice(0, 300) };
  }
  rec.finishedAt = nowFn();
  try { writeJsonAtomic(planFile(rec.planId), publicRec(rec)); } catch (e) { log(`[dispatch] 플랜 저장 실패: ${e && e.message}`); }
  try { inj.notify({ ids: [rec.planId], reason: rec.state }); } catch (_) { /* noop */ }
  activityChanged();
}

async function rpcPlan(p) {
  const opId = reqOpId(p);
  const prev = recentOps.find((o) => o.opId === opId);
  if (prev && plans.has(prev.planId)) {
    const rec = plans.get(prev.planId);
    return { accepted: true, planId: rec.planId, planner: rec.planner ? { agent: rec.planner } : null, replay: true };
  }
  const instruction = p.instruction;
  if (typeof instruction !== 'string' || !instruction.trim()) throw codedError('BAD_PARAMS', '지시가 필요합니다');
  if (bytesOf(instruction) > INSTRUCTION_MAX_BYTES) throw codedError('BAD_PARAMS', '지시가 너무 깁니다(4,000 바이트까지)');
  const catalog = p.catalog;
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.hosts)) throw codedError('BAD_PARAMS', 'catalog.hosts 가 필요합니다');
  let catBytes = 0;
  try { catBytes = bytesOf(JSON.stringify(catalog)); } catch (_) { throw codedError('BAD_PARAMS', 'catalog 가 올바르지 않습니다'); }
  if (catBytes > CATALOG_IN_MAX_BYTES) throw codedError('CATALOG_TOO_LARGE', '카탈로그가 너무 큽니다(256KB 까지)');
  const prefer = p.prefer && typeof p.prefer === 'object' ? p.prefer.agent : null;
  const picked = await pickPlanner(typeof prefer === 'string' ? prefer : null);
  // 플래너 모델·추론 강도(2026-10-02) — 사용자가 고른 값. 형식이 틀리면 무시(CLI 기본값).
  const pm = p.prefer && typeof p.prefer === 'object' ? p.prefer : {};
  const am = require('./agent-models');
  const planner = picked ? { ...picked, model: am.valid(pm.model) ? pm.model || null : null, effort: am.valid(pm.effort) ? pm.effort || null : null } : null;
  let planId;
  do { planId = 'p_' + rand36(10); } while (plans.has(planId));
  const rec = { planId, opId, state: 'planning', startedAt: nowFn(), finishedAt: null, plan: null, error: null, planner: planner ? planner.id : null };
  plans.set(planId, rec);
  recentOps.push({ opId, planId });
  if (recentOps.length > OP_IDS_KEEP) recentOps = recentOps.slice(-OP_IDS_KEEP);
  activityChanged();
  track(runPlan(rec, instruction.trim(), catalog, planner).catch((e) => log(`[dispatch] ${planId} 실패: ${e && e.message}`)));
  return { accepted: true, planId, planner: planner ? { agent: planner.id } : null };
}

function expired(rec) { return rec.finishedAt && nowFn() - rec.finishedAt > PLAN_KEEP_MS; }

async function rpcGet(p) {
  const planId = p.planId;
  if (typeof planId !== 'string' || !/^p_[0-9a-z]{10}$/.test(planId)) throw codedError('BAD_PARAMS', 'planId 가 올바르지 않습니다');
  let rec = plans.get(planId);
  if (!rec) {
    try {
      const j = JSON.parse(fs.readFileSync(planFile(planId), 'utf8'));
      if (j && j.planId === planId) rec = { ...j };
    } catch (_) { rec = null; }
  }
  if (rec && expired(rec)) {
    plans.delete(planId);
    try { fs.rmSync(planFile(planId), { force: true }); } catch (_) { /* noop */ }
    rec = null;
  }
  if (!rec) throw codedError('DISPATCH_NOT_FOUND', '계획을 찾을 수 없습니다');
  return publicRec(rec);
}

/** 24h 지난 플랜 파일·메모리 정리. */
function sweep() {
  for (const [id, rec] of plans) if (expired(rec)) plans.delete(id);
  let names = [];
  try { names = fs.readdirSync(dispatchDir()); } catch (_) { return; }
  for (const n of names) {
    if (!/^p_[0-9a-z]{10}\.json$/.test(n) && !/\.tmp$/.test(n) && !/\.last\.txt$/.test(n)) continue;
    const f = path.join(dispatchDir(), n);
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs > PLAN_KEEP_MS) fs.rmSync(f, { force: true });
    } catch (_) { /* noop */ }
  }
}

const HANDLERS = {
  'dispatch.catalog': rpcCatalog,
  'dispatch.plan': rpcPlan,
  'dispatch.get': rpcGet,
};

async function rpc(method, params) {
  if (!enabled()) throw codedError('DISPATCH_DISABLED', '이 PC 에서는 한 줄 지시를 쓸 수 없습니다');
  const h = HANDLERS[String(method || '')];
  if (!h) throw codedError('BAD_PARAMS', '알 수 없는 명령입니다: ' + method);
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return h(p);
}

function enabled() { return process.env.CPT_DISPATCH !== '0'; }

// ── 수명 ─────────────────────────────────────────────────────────────────────
let started = false;
let sweepTimer = null;
function start() {
  if (started || !enabled()) return;
  started = true;
  try { ensureDir(dispatchDir()); } catch (_) { /* noop */ }
  sweep();
  sweepTimer = setInterval(() => { try { sweep(); } catch (_) { /* noop */ } }, timings.sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();
}
function stop() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  started = false;
}

async function _drain() { while (running.size) await Promise.allSettled([...running]); }
function _reset() {
  stop();
  plans.clear(); recentOps = []; catalogCache = null; plannerCache = null;
}

module.exports = {
  configure, start, stop, rpc, activeReasons, planFallback, validatePlan, tokenize,
  ERROR_CODES, SYS_PROMPT, CATALOG_FIELDS, WORKSPACE_FIELDS, PLAN_FIELDS, PLANNER_FIELDS, PLAN_TASK_FIELDS,
  _internals: {
    extractJson, runHeadless, pickPlanner, capCatalog, workspaceInfo, isTaskWorkspacePath, githubOf, sweep, _drain, _reset,
    plans, planFile, dispatchDir,
    get timings() { return timings; },
  },
};
// OPTIONAL_CAPS(control.js) 능력 판정 — CPT_DISPATCH=0 이면 undefined → dispatch.v1 미광고.
Object.defineProperty(module.exports, 'handle', {
  enumerable: true,
  get() { return enabled() ? rpc : undefined; },
});
