/**
 * issues — 이슈(할 일) 한 벌: CodingPT 자체 이슈 + 외부 서비스 이슈를 **같은 모양**으로 다룬다(2026-10-06).
 *
 * 사용자 결정:
 *  · 연동 없이도 쓸 수 있어야 한다 → 자체 이슈는 이 PC 에 저장한다(`<stateDir>/issues.json`). 구조는 서버로 옮겨도 그대로 쓸 수 있게 평평하게.
 *  · 외부 서비스는 언제든 붙일 수 있어야 한다 → 제공자(provider) 표 하나에 `list/create/update` 만 구현하면 같은 화면에 섞인다.
 *    첫 제공자는 GitHub(이 PC 에 로그인된 `gh` 를 그대로 쓴다 — 토큰을 우리가 보관하지 않는다).
 *  · 자체 이슈와 외부 이슈를 따로 보이게 하지 않는다 → `list` 는 합쳐서 주고, 화면이 출처로 거른다.
 *
 * 공통 모양(와이어):
 *   { id, number, key, title, body, status, priority, labels[], cwd, source:{provider, url, repo}, link, createdAt, updatedAt }
 *   status   = todo | in_progress | in_review | done        (외부 상태는 이 넷으로 접는다)
 *   priority = none | low | medium | high | urgent
 *   link     = 이 이슈로 시작한 일 { mode: task|terminal|orch, taskId?, tid?, cwd, agent, startedAt } | null
 *
 * 외부 이슈는 복사해 두지 않는다(정본은 그 서비스다). 우리가 얹는 것은 "진행 중/리뷰 중" 같은 작업 상태와 link 뿐이고
 * `overlays` 에 따로 적는다 — 그 서비스에 없는 상태를 그 서비스에 쓰지 않는다.
 *
 * 순수 스토어 + 주입(tasks·launchPrompted·notify). RPC 는 orch.js 가 `orch.issue*` 로 내보낸다(전송·권한·능력 배관을 그대로 쓴다).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtime = require('./runtime');

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const MODES = ['task', 'terminal', 'orch'];
const TITLE_MAX = 200; const BODY_MAX = 20000; const LABEL_MAX = 12;
const EXT_CACHE_MS = 60 * 1000;

const inj = {
  tasks: null,            // tasks.js (internalCreate · _internals.load)
  taskGit: null,          // task-git.js (gh)
  launchPrompted: null,   // ({cwd, agent, model, prompt, name, issueId}) → {tid, tsession}
  onDone: null,           // ({id, key, link, cwd}) — 이슈가 완료로 **바뀐 순간** 한 번. 그 이슈가 남긴 흔적(터미널 이름·한 줄 메모)을 치운다(orch.js)
  absOf: null,            // (cwdRel) → 절대경로
  notify: () => {},       // 바뀜 신호(식별자만)
  now: () => Date.now(),
};
function configure(opts = {}) {
  for (const k of Object.keys(inj)) if (opts[k] !== undefined) inj[k] = opts[k];
  return module.exports;
}
function coded(code, message, extra) { return Object.assign(new Error(message), { code }, extra || {}); }

// ── 스토어 ───────────────────────────────────────────────────────────────────
let mem = null;
function file() { return path.join(runtime.stateDir(), 'issues.json'); }
function load() {
  if (mem) return mem;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    mem = { v: 1, seq: Number(j.seq) || 0, items: Array.isArray(j.items) ? j.items : [], overlays: j.overlays && typeof j.overlays === 'object' ? j.overlays : {} };
  } catch (_) { mem = { v: 1, seq: 0, items: [], overlays: {} }; }
  return mem;
}
function save() {
  const f = file();
  const tmp = f + '.tmp';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(mem), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function changed(ids) { try { inj.notify({ ids: [].concat(ids || []) }); } catch (_) { /* noop */ } }
// 완료로 넘어간 순간을 알린다 — 완료된 이슈의 이름이 터미널 탭·워크스페이스 메모에 영구히 남지 않게(2026-10-08).
//  link 는 지우지 않는다("이 이슈로 무엇을 했는가" 의 기록이다). 치우는 쪽 예외는 이슈 저장을 막지 않는다.
function settled(id, key, link, cwd) {
  if (typeof inj.onDone !== 'function') return;
  try { inj.onDone({ id, key: key || null, link: link || null, cwd: (link && link.cwd) || cwd || '' }); } catch (_) { /* noop */ }
}

// ── 입력 검증 ────────────────────────────────────────────────────────────────
function str(v, max, name, { required = false } = {}) {
  if (v == null || v === '') { if (required) throw coded('BAD_PARAMS', `${name} 이(가) 필요합니다`); return ''; }
  if (typeof v !== 'string') throw coded('BAD_PARAMS', `${name} 은(는) 글자여야 합니다`);
  return v.slice(0, max);
}
function oneOf(v, list, name, dflt) {
  if (v == null || v === '') return dflt;
  if (!list.includes(v)) throw coded('BAD_PARAMS', `${name} 은(는) ${list.join('|')} 중 하나입니다`);
  return v;
}
function labelsOf(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, LABEL_MAX);
}
function cwdOf(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.includes('\0') || v.split('/').includes('..')) throw coded('BAD_PARAMS', 'cwd 가 올바르지 않습니다');
  return v.replace(/^\/+|\/+$/g, '');
}

// ── 제공자(외부 서비스) ──────────────────────────────────────────────────────
//  제공자 하나 = { list(cwd) → [raw], create(cwd, {title, body}) → raw, update(cwd, number, patch) }.
//  raw = { number, title, body, open, labels[], url, repo, createdAt, updatedAt }.
const extCache = new Map();   // `${provider}\n${cwd}` → { at, items, error }
const repoCwd = new Map();    // `${provider}:${repo}` → cwd (ID 에서 폴더를 되찾는다)

const GH_FIELDS = 'number,title,body,state,labels,url,createdAt,updatedAt';
function ghRaw(x) {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(String(x.url || ''));
  return {
    number: x.number, title: x.title || '', body: x.body || '', open: String(x.state || '').toUpperCase() !== 'CLOSED',
    labels: (x.labels || []).map((l) => (l && l.name) || '').filter(Boolean), url: x.url || '', repo: m ? m[1] : '',
    createdAt: Date.parse(x.createdAt) || null, updatedAt: Date.parse(x.updatedAt) || null,
  };
}
async function ghRun(cwd, args, timeout) {
  const tg = inj.taskGit;
  if (!tg || !inj.absOf) throw coded('PROVIDER_UNAVAILABLE', 'GitHub 를 쓸 수 없습니다');
  let abs;
  try { abs = inj.absOf(cwd); } catch (_) { throw coded('BAD_PARAMS', '폴더를 찾을 수 없습니다'); }
  const r = await tg.gh(args, { cwd: abs, timeout: timeout || 20000 });
  if (!r.ok) {
    const err = String(r.err || r.out || '');
    if (err === 'GH_MISSING') throw coded('GH_MISSING', 'gh 가 설치되어 있지 않습니다');
    if (/not a git repository|no git remotes|none of the git remotes/i.test(err)) throw coded('NOT_GITHUB', 'GitHub 저장소가 아닙니다');
    if (/gh auth login|authentication|HTTP 401/i.test(err)) throw coded('GH_AUTH', 'gh 로그인이 필요합니다');
    if (/has disabled issues|issues are disabled/i.test(err)) throw coded('ISSUES_DISABLED', '이 저장소는 이슈를 쓰지 않습니다');
    throw coded('PROVIDER_ERROR', err.split('\n')[0].slice(0, 200) || 'GitHub 요청이 실패했습니다');
  }
  return r.out;
}
const PROVIDERS = {
  github: {
    async list(cwd) { return JSON.parse(await ghRun(cwd, ['issue', 'list', '--state', 'all', '--limit', '80', '--json', GH_FIELDS]) || '[]').map(ghRaw); },
    async create(cwd, { title, body, labels }) {
      const args = ['issue', 'create', '--title', title, '--body', body || ''];
      for (const l of labels || []) args.push('--label', l);
      const out = await ghRun(cwd, args, 30000);
      const m = /\/issues\/(\d+)/.exec(out);
      if (!m) throw coded('PROVIDER_ERROR', '만든 이슈를 확인하지 못했습니다');
      return ghRaw(JSON.parse(await ghRun(cwd, ['issue', 'view', m[1], '--json', GH_FIELDS])));
    },
    async update(cwd, number, patch) {
      const edit = ['issue', 'edit', String(number)];
      if (patch.title != null) edit.push('--title', patch.title);
      if (patch.body != null) edit.push('--body', patch.body);
      if (edit.length > 3) await ghRun(cwd, edit, 30000);
      if (patch.open === false) await ghRun(cwd, ['issue', 'close', String(number)], 30000);
      if (patch.open === true) await ghRun(cwd, ['issue', 'reopen', String(number)], 30000);
    },
  },
};
const extId = (provider, repo, number) => `${provider === 'github' ? 'gh' : provider}:${repo}#${number}`;
function parseExtId(id) {
  const m = /^(gh):(.+)#(\d+)$/.exec(String(id || ''));
  return m ? { provider: 'github', repo: m[2], number: Number(m[3]) } : null;
}
async function extList(provider, cwd, { fresh = false } = {}) {
  const key = `${provider}\n${cwd}`;
  const hit = extCache.get(key);
  if (!fresh && hit && inj.now() - hit.at < EXT_CACHE_MS) return hit;
  let rec;
  try {
    const items = await PROVIDERS[provider].list(cwd);
    for (const x of items) if (x.repo) repoCwd.set(`${provider}:${x.repo}`, cwd);
    rec = { at: inj.now(), items, error: null };
  } catch (e) {
    rec = { at: inj.now(), items: (hit && hit.items) || [], error: (e && e.code) || 'PROVIDER_ERROR' };
  }
  extCache.set(key, rec);
  return rec;
}

// ── 첨부(이미지·파일) ────────────────────────────────────────────────────────
//  QA 처럼 "화면을 보여 주며" 적는 이슈를 위해(2026-10-07 사용자 요청). 파일은 이 PC 에 복사해 둔다:
//   <stateDir>/issue-files/<이슈 폴더>/<attId><확장자>
//  본문에는 `![이름](att:<attId>)` 로 자리를 적고, 시작할 때 그 자리를 **실제 경로**로 바꿔 에이전트가 읽게 한다.
//  외부 이슈에 붙인 첨부도 여기에만 둔다(그 서비스에 올리지 않는다 — overlays 가 든다).
const ATT_MAX_BYTES = 25 * 1024 * 1024;
const ATT_MAX_COUNT = 30;
const ATT_ID_RE = /^[a-z0-9]{6,32}$/;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
function filesRoot() { return path.join(runtime.stateDir(), 'issue-files'); }
const dirKey = (issueId) => crypto.createHash('sha1').update(String(issueId)).digest('hex').slice(0, 16);
function attPath(issueId, a) { return path.join(filesRoot(), dirKey(issueId), a.id + (a.ext || '')); }
function wireAtts(issueId, list) {
  return (Array.isArray(list) ? list : []).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, image: /^image\//.test(a.mime || ''), path: attPath(issueId, a) }));
}
/** 그 이슈가 첨부·상태를 적어 둘 곳 — 자체 이슈면 그 항목, 외부 이슈면 overlay. */
function holderOf(r) {
  if (r.local) return { id: r.local.id, holder: r.local };
  const id = extId(r.ext.provider, r.ext.repo, r.ext.number);
  const s = load();
  return { id, holder: s.overlays[id] || (s.overlays[id] = {}) };
}
/** { id, path, attId?, name? } → { issue, attachment } — path = 이 PC 의 절대 경로(붙여넣기·끌어다 놓기가 준다). */
async function attach(p = {}) {
  const r = await resolve(p.id);
  const src = str(p.path, 2000, 'path', { required: true });
  if (!path.isAbsolute(src)) throw coded('BAD_PARAMS', 'path 는 절대 경로여야 합니다');
  let st;
  try { st = fs.statSync(src); } catch (_) { throw coded('BAD_PARAMS', '파일을 찾을 수 없습니다'); }
  if (!st.isFile()) throw coded('BAD_PARAMS', '파일만 첨부할 수 있습니다');
  if (st.size > ATT_MAX_BYTES) throw coded('TOO_LARGE', '25MB 보다 큰 파일은 첨부할 수 없습니다');
  const { id, holder } = holderOf(r);
  if (!Array.isArray(holder.attachments)) holder.attachments = [];
  if (holder.attachments.length >= ATT_MAX_COUNT) throw coded('TOO_LARGE', `첨부는 ${ATT_MAX_COUNT}개까지입니다`);
  const attId = p.attId == null ? crypto.randomBytes(5).toString('hex') : String(p.attId);
  if (!ATT_ID_RE.test(attId)) throw coded('BAD_PARAMS', 'attId 가 올바르지 않습니다');
  if (holder.attachments.some((a) => a.id === attId)) return { issue: (await get({ id: p.id })).issue, attachment: wireAtts(id, holder.attachments).find((a) => a.id === attId) };
  const ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const a = { id: attId, name: (str(p.name, 120, 'name') || path.basename(src)).slice(0, 120), ext, mime: MIME[ext] || 'application/octet-stream', size: st.size, addedAt: inj.now() };
  const dest = attPath(id, a);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, 0o600); } catch (_) { /* noop */ }
  holder.attachments.push(a);
  holder.updatedAt = inj.now();
  save();
  changed([id]);
  return { issue: (await get({ id: p.id })).issue, attachment: wireAtts(id, [a])[0] };
}
async function detach(p = {}) {
  const r = await resolve(p.id);
  const { id, holder } = holderOf(r);
  const a = (holder.attachments || []).find((x) => x.id === String(p.attId || ''));
  if (!a) throw coded('BAD_PARAMS', '첨부를 찾을 수 없습니다');
  try { fs.rmSync(attPath(id, a), { force: true }); } catch (_) { /* noop */ }
  holder.attachments = holder.attachments.filter((x) => x.id !== a.id);
  holder.updatedAt = inj.now();
  save();
  changed([id]);
  return { issue: (await get({ id: p.id })).issue };
}
/** 본문의 `![이름](att:ID)` 를 실제 경로로 바꾸고, 첨부 목록을 덧붙인다(에이전트가 읽을 수 있게). */
function withAttachments(body, atts) {
  const list = atts || [];
  if (!list.length) return body || '';
  const by = new Map(list.map((a) => [a.id, a]));
  const used = new Set();
  let out = String(body || '').replace(/!\[([^\]]*)\]\(att:([a-z0-9]+)\)/g, (m, name, id) => {
    const a = by.get(id);
    if (!a) return m;
    used.add(id);
    return `[첨부 ${a.image ? '이미지' : '파일'} "${name || a.name}": ${a.path}]`;
  });
  const rest = list.filter((a) => !used.has(a.id));
  if (rest.length) out += `\n\n첨부(${rest.length}):\n` + rest.map((a) => `- ${a.name}: ${a.path}`).join('\n');
  return out + '\n\n(첨부 경로의 이미지는 직접 열어서 확인하세요 — 화면 캡처에 재현 상황이 담겨 있습니다.)';
}

// ── 모양 맞추기 ──────────────────────────────────────────────────────────────
function wireLocal(x) {
  return { id: x.id, number: x.number, key: '#' + x.number, title: x.title, body: x.body || '', status: x.status, priority: x.priority || 'none',
    labels: x.labels || [], cwd: x.cwd || '', source: { provider: 'codingpt', url: null, repo: null }, link: x.link || null,
    attachments: wireAtts(x.id, x.attachments), createdAt: x.createdAt, updatedAt: x.updatedAt };
}
function wireExt(provider, cwd, raw) {
  const id = extId(provider, raw.repo, raw.number);
  const ov = load().overlays[id] || {};
  //  그 서비스에서 닫혔으면 끝이다(우리 쪽 진행 표시보다 정본이 이긴다). 열려 있으면 우리가 얹은 작업 상태를 보인다.
  const status = !raw.open ? 'done' : (ov.status === 'in_progress' || ov.status === 'in_review' ? ov.status : 'todo');
  return { id, number: raw.number, key: `${raw.repo.split('/').pop()}#${raw.number}`, title: raw.title, body: raw.body, status,
    priority: ov.priority || 'none', labels: raw.labels, cwd, source: { provider, url: raw.url, repo: raw.repo }, link: ov.link || null,
    attachments: wireAtts(id, ov.attachments),
    createdAt: raw.createdAt, updatedAt: Math.max(raw.updatedAt || 0, ov.updatedAt || 0) || null };
}

// ── 시작한 일의 상태를 이슈에 비춘다(끌어오기 — 목록을 줄 때마다) ─────────────
//  작업(worktree)으로 시작한 이슈만 자동으로 따라간다: 리뷰 준비 → 리뷰 중, 머지 → 완료, 폐기 → 다시 할 일.
//  사람이 손으로 옮긴 상태(완료 등)는 덮지 않는다 — 진행 중/리뷰 중일 때만 옮긴다.
function taskStateOf(taskId) {
  try {
    const t = inj.tasks._internals.load().items.find((x) => x.id === taskId);
    if (!t) return 'gone';
    if (t.state === 'merged') return 'merged';
    if (t.state === 'closed' || t.state === 'failed' || t.state === 'discarded') return 'gone';
    if ((t.runs || []).some((r) => r.state === 'merged')) return 'merged';
    if ((t.runs || []).some((r) => r.state === 'review_ready')) return 'review';
    return 'running';
  } catch (_) { return null; }
}
function followLinks() {
  const s = load();
  let dirty = false;
  const done = [];
  const step = (holder, link, id, key) => {
    if (!link || link.mode !== 'task' || !link.taskId) return;
    if (holder.status !== 'in_progress' && holder.status !== 'in_review') return;
    const st = taskStateOf(link.taskId);
    const next = st === 'merged' ? 'done' : st === 'review' ? 'in_review' : st === 'gone' ? 'todo' : st === 'running' ? 'in_progress' : null;
    if (!next || next === holder.status) return;
    holder.status = next; holder.updatedAt = inj.now();
    if (next === 'done') done.push([id, key, link, holder.cwd]);
    if (st === 'gone') holder.link = null;
    dirty = true;
  };
  for (const x of s.items) step(x, x.link, x.id, '#' + x.number);
  for (const id of Object.keys(s.overlays)) step(s.overlays[id], s.overlays[id].link, id, null);
  if (dirty) save();
  for (const d of done) settled(...d);
}

// ── RPC ──────────────────────────────────────────────────────────────────────
/** { cwds?: string[], fresh? } → { issues, sources:[{provider, cwd, ok, error}], at } */
async function list(p = {}) {
  if (inj.tasks) followLinks();
  const s = load();
  const cwds = [...new Set((Array.isArray(p.cwds) ? p.cwds : []).map(cwdOf))].slice(0, 30);
  const sources = [{ provider: 'codingpt', cwd: null, ok: true, error: null }];
  let issues = s.items.map(wireLocal);
  const ext = await Promise.all(cwds.flatMap((cwd) => Object.keys(PROVIDERS).map(async (provider) => {
    const rec = await extList(provider, cwd, { fresh: !!p.fresh });
    return { provider, cwd, rec };
  })));
  const seen = new Set();
  for (const { provider, cwd, rec } of ext) {
    //  GitHub 저장소가 아닌 폴더, gh 를 안 쓰는 PC 는 출처 목록에 올리지 않는다(오류가 아니라 "해당 없음" 이다 —
    //  연동하지 않은 사용자에게 워크스페이스마다 경고를 띄우지 않는다).
    if (rec.error !== 'NOT_GITHUB' && rec.error !== 'GH_MISSING') sources.push({ provider, cwd, ok: !rec.error, error: rec.error });
    for (const raw of rec.items) {
      const w = wireExt(provider, cwd, raw);
      if (seen.has(w.id)) continue;   // 같은 저장소를 여는 폴더가 둘이면 한 번만
      seen.add(w.id);
      issues.push(w);
    }
  }
  issues.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { issues, sources, statuses: STATUSES, priorities: PRIORITIES, at: inj.now() };
}

function findLocal(id) {
  const s = load();
  const key = String(id || '').replace(/^#/, '');
  return s.items.find((x) => x.id === key) || (/^\d+$/.test(key) ? s.items.find((x) => x.number === Number(key)) : null) || null;
}
async function resolve(id) {
  const loc = findLocal(id);
  if (loc) return { local: loc };
  const ext = parseExtId(id);
  if (!ext) throw coded('ISSUE_NOT_FOUND', '이슈를 찾을 수 없습니다: ' + id);
  const cwd = repoCwd.get(`${ext.provider}:${ext.repo}`);
  if (cwd == null) throw coded('ISSUE_NOT_FOUND', '이 저장소의 이슈 목록을 먼저 불러와야 합니다');
  const rec = await extList(ext.provider, cwd);
  const raw = rec.items.find((x) => x.number === ext.number && x.repo === ext.repo);
  if (!raw) throw coded('ISSUE_NOT_FOUND', '이슈를 찾을 수 없습니다: ' + id);
  return { ext, cwd, raw };
}
async function get(p = {}) {
  const r = await resolve(p.id);
  return { issue: r.local ? wireLocal(r.local) : wireExt(r.ext.provider, r.cwd, r.raw) };
}

async function create(p = {}) {
  const title = str(p.title, TITLE_MAX, 'title').trim();
  const body = str(p.body, BODY_MAX, 'body');
  const cwd = cwdOf(p.cwd);
  const provider = oneOf(p.provider, ['codingpt', ...Object.keys(PROVIDERS)], 'provider', 'codingpt');
  //  화면의 자동 저장(draft)만 제목 없이 자체 이슈를 만든다 — 본문부터 적는 초안이고, 화면이 본문 첫 줄을 제목 자리에 보인다.
  //  그 밖(cpt issue create·외부 서비스)은 그대로 제목이 있어야 한다.
  if (!title && !(p.draft === true && provider === 'codingpt')) throw coded('BAD_PARAMS', 'title 이 필요합니다');
  const labels = labelsOf(p.labels) || [];
  if (provider !== 'codingpt') {
    if (!cwd) throw coded('BAD_PARAMS', '외부 서비스에 만들려면 워크스페이스(cwd)가 필요합니다');
    const raw = await PROVIDERS[provider].create(cwd, { title, body, labels });
    extCache.delete(`${provider}\n${cwd}`);
    if (raw.repo) repoCwd.set(`${provider}:${raw.repo}`, cwd);
    const w = wireExt(provider, cwd, raw);
    changed([w.id]);
    return { issue: w };
  }
  const s = load();
  const now = inj.now();
  const x = { id: 'iss_' + crypto.randomBytes(6).toString('hex'), number: ++s.seq, title, body,
    status: oneOf(p.status, STATUSES, 'status', 'todo'), priority: oneOf(p.priority, PRIORITIES, 'priority', 'none'),
    labels, cwd, link: null, createdAt: now, updatedAt: now };
  s.items.push(x);
  save();
  changed([x.id]);
  return { issue: wireLocal(x) };
}

async function update(p = {}) {
  const r = await resolve(p.id);
  const status = p.status == null ? null : oneOf(p.status, STATUSES, 'status');
  const priority = p.priority == null ? null : oneOf(p.priority, PRIORITIES, 'priority');
  const title = p.title == null ? null : str(p.title, TITLE_MAX, 'title').trim();
  if (title === '' && !r.local) throw coded('BAD_PARAMS', 'title 을 비울 수 없습니다');
  const body = p.body == null ? null : str(p.body, BODY_MAX, 'body');
  const labels = labelsOf(p.labels);
  const now = inj.now();
  if (r.local) {
    const x = r.local;
    const wasDone = x.status === 'done';
    if (title != null) x.title = title;
    if (body != null) x.body = body;
    if (status) x.status = status;
    if (priority) x.priority = priority;
    if (labels) x.labels = labels;
    if (p.cwd != null) x.cwd = cwdOf(p.cwd);
    x.updatedAt = now;
    save();
    changed([x.id]);
    if (!wasDone && x.status === 'done') settled(x.id, '#' + x.number, x.link, x.cwd);
    return { issue: wireLocal(x) };
  }
  const { ext, cwd, raw } = r;
  const id = extId(ext.provider, ext.repo, ext.number);
  const patch = {};
  if (title != null && title !== raw.title) patch.title = title;
  if (body != null && body !== raw.body) patch.body = body;
  if (status === 'done' && raw.open) patch.open = false;
  if (status && status !== 'done' && !raw.open) patch.open = true;
  if (Object.keys(patch).length) {
    await PROVIDERS[ext.provider].update(cwd, ext.number, patch);
    extCache.delete(`${ext.provider}\n${cwd}`);
  }
  const s = load();
  const ov = s.overlays[id] || (s.overlays[id] = {});
  if (status) ov.status = status === 'in_progress' || status === 'in_review' ? status : null;
  if (priority) ov.priority = priority;
  ov.updatedAt = now;
  save();
  changed([id]);
  if (status === 'done' && raw.open) settled(id, null, ov.link, cwd);
  const rec = await extList(ext.provider, cwd, { fresh: Object.keys(patch).length > 0 });
  const fresh = rec.items.find((x) => x.number === ext.number && x.repo === ext.repo) || raw;
  return { issue: wireExt(ext.provider, cwd, fresh) };
}

async function remove(p = {}) {
  const x = findLocal(p.id);
  if (!x) throw coded('BAD_PARAMS', '자체 이슈만 지울 수 있습니다(외부 이슈는 그 서비스에서 닫으세요)');
  const s = load();
  s.items = s.items.filter((y) => y.id !== x.id);
  try { fs.rmSync(path.join(filesRoot(), dirKey(x.id)), { recursive: true, force: true }); } catch (_) { /* noop */ }
  save();
  changed([x.id]);
  return { ok: true };
}

function promptOf(w, mode, agent) {
  const body = withAttachments(w.source.provider === 'codingpt' ? w.body : String(w.body || '').slice(0, 6000), w.attachments);
  const head = w.source.provider === 'codingpt'
    ? `이슈 ${w.key}: ${w.title}${body ? `\n\n${body}` : ''}`
    : `이 이슈를 해결해 주세요: ${w.source.url}\n\n제목: ${w.title}${body ? `\n\n${body}` : ''}`;
  const tail = `\n\n(CodingPT 이슈에서 시작한 일입니다. 끝나면 무엇을 했는지 요약해 주세요. 이슈 상태는 \`cpt issue update "${w.id}" --status in_review\` 로 바꿀 수 있습니다.)`;
  if (mode !== 'orch') return head + tail;
  return `${agent === 'codex' ? '$orch' : '/orch'} ${head}${tail}`;
}

/** { id, cwd?, mode, agent?, model? } → { issue, started:{mode, taskId?, tid?} } */
async function start(p = {}) {
  const r = await resolve(p.id);
  const w = r.local ? wireLocal(r.local) : wireExt(r.ext.provider, r.cwd, r.raw);
  const mode = oneOf(p.mode, MODES, 'mode', 'task');
  const cwd = cwdOf(p.cwd) || w.cwd;
  if (!cwd) throw coded('BAD_PARAMS', '어느 워크스페이스에서 시작할지(cwd) 필요합니다');
  const agent = str(p.agent, 40, 'agent') || 'claude';
  const model = str(p.model, 80, 'model') || null;
  const prompt = promptOf(w, mode, agent);
  const link = { mode, cwd, agent, startedAt: inj.now() };
  if (mode === 'task') {
    if (!inj.tasks || typeof inj.tasks.internalCreate !== 'function') throw coded('START_FAILED', '이 PC 에서는 작업 폴더를 만들 수 없습니다');
    const res = await inj.tasks.internalCreate({ repo: cwd, prompt, title: `${w.key} ${w.title}`.slice(0, 120), agents: [{ id: agent, model }] },
      { kind: 'issue', planId: 'i' + crypto.randomBytes(8).toString('hex') });
    const t = res && res.task;
    if (!t) throw coded('START_FAILED', '작업을 만들지 못했습니다');
    link.taskId = t.id;
  } else {
    if (!inj.launchPrompted) throw coded('START_FAILED', '터미널 실행 경로가 없습니다');
    const term = await inj.launchPrompted({ cwd, agent, model, prompt, name: `${w.key} ${w.title}`.slice(0, 40), issueId: w.id });
    link.tid = term.tid;
  }
  const s = load();
  const holder = r.local ? r.local : (s.overlays[w.id] || (s.overlays[w.id] = {}));
  holder.link = link;
  holder.status = 'in_progress';
  holder.updatedAt = inj.now();
  if (r.local && !holder.cwd) holder.cwd = cwd;
  save();
  changed([w.id]);
  return { issue: r.local ? wireLocal(r.local) : wireExt(r.ext.provider, r.cwd, r.raw), started: { mode, taskId: link.taskId || null, tid: link.tid == null ? null : link.tid, cwd } };
}

// ── 흔적 정리용 조회(동기 — orch.js 가 메모·터미널 이름의 근거를 물을 때) ──────
/** 지금 아는 상태. 자체 이슈는 정본, 외부 이슈는 마지막으로 불러온 목록 기준(모르면 null — 모름은 완료가 아니다). */
function statusOf(id) {
  const loc = findLocal(id);
  if (loc) return loc.status;
  const ext = parseExtId(id);
  if (!ext) return null;
  for (const rec of extCache.values()) {
    const raw = (rec.items || []).find((x) => x.number === ext.number && x.repo === ext.repo);
    if (raw) return raw.open ? ((load().overlays[String(id)] || {}).status || 'todo') : 'done';
  }
  return null;
}
/** 그 터미널(cwd, tid)에서 시작한 이슈 ID — 여럿이면 가장 최근에 시작한 것. 없으면 null. */
function linkedTo(cwd, tid) {
  if (tid == null) return null;
  const s = load();
  let best = null;
  const see = (id, link) => {
    if (!link || link.tid !== tid || (link.cwd || '') !== (cwd || '')) return;
    if (!best || (link.startedAt || 0) > best.at) best = { id, at: link.startedAt || 0 };
  };
  for (const x of s.items) see(x.id, x.link);
  for (const id of Object.keys(s.overlays)) see(id, s.overlays[id].link);
  return best ? best.id : null;
}
/** 자체 이슈 번호 → 이슈(없으면 null) — 연결 정보 없이 적힌 옛 메모("이슈 #7 완료")의 근거 찾기. */
function localByNumber(n) { return load().items.find((x) => x.number === Number(n)) || null; }

const METHODS = { issueList: list, issueGet: get, issueCreate: create, issueUpdate: update, issueDelete: remove, issueStart: start, issueAttach: attach, issueDetach: detach };
function _reset() { mem = null; extCache.clear(); repoCwd.clear(); }

module.exports = { configure, METHODS, STATUSES, PRIORITIES, MODES, PROVIDERS, _internals: { load, _reset, extCache, repoCwd, promptOf, wireLocal, parseExtId, followLinks, file, withAttachments, filesRoot, statusOf, linkedTo, localByNumber } };
