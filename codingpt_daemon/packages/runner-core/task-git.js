/**
 * task-git.js — Agent Tasks 의 git/gh 실행기(설계 정본: codingpt_daemon/docs/agent-tasks-design.md §2.4·§2.9).
 *
 * 왜 따로 두나: tasks.js(오케스트레이션·상태기계)는 "무엇을 언제" 만 알고, "git 을 어떻게 안전하게
 *  부르나" 는 여기 한 곳에만 둔다. 그 "어떻게" 에 함정이 몰려 있다:
 *   · PATH — 데몬은 Finder/launchd 가 띄운 사이드카라 로그인 셸 PATH 가 없다(`/opt/homebrew/bin/gh`
 *     를 못 찾는다). agents.js 의 탐색 규칙(process PATH ∪ 로그인 셸 PATH ∪ 표준 위치)을 그대로 쓴다.
 *   · 기계 판독 출력 — 기본 `core.quotepath=true` 는 한글 경로를 8진수로 인용해 파일 목록을 깨고,
 *     사용자 `color.ui=always`·`diff.external`·textconv 가 출력을 바꾼다. 공통 접두로 전부 끈다.
 *   · 락 — `--no-optional-locks` 없이 status 를 부르면 에이전트가 같은 worktree 에서 도는 동안
 *     index.lock 충돌을 일으킨다.
 *   · 데드라인 — 넘으면 자식을 SIGTERM(2s 뒤 SIGKILL) 하고 TIMEOUT 으로 접는다. 자식이 계속 도는
 *     채로 op 락을 풀면 같은 worktree 에 git 이 둘 돈다.
 *
 * 불변식(§10): execFile 계열만(셸 문자열 금지) · 사용자 텍스트는 `--flag=value` 또는 stdin ·
 *  경로 앞엔 항상 `--` · 자격증명 env 를 만들거나 옮기지 않는다(`GIT_SSH_COMMAND` 도 설정하지 않는다 —
 *  사용자 core.sshCommand/1Password 에이전트를 덮는다) · `gh auth token` 을 부르지 않는다.
 *
 * 모든 실행 함수는 throw 하지 않고 `{ok, code, out, err, timedOut}` 을 돌려준다. 도메인 판정(에러 코드)은
 *  이 파일의 상위 헬퍼(commit/push/prCreate …)가 하고, 던지는 에러는 `{code, message}` 만 싣는다(§2.13).
 */
const fs = require('fs');
const path = require('path');
const { spawnCli } = require('./spawn-util');

const MAX_BUFFER = 16 * 1024 * 1024;
const TOOLS_CACHE_MS = 60 * 1000;
const KILL_GRACE_MS = 2000;

// 기계 판독 git 호출의 공통 접두(§2.4). 사용자 설정이 출력 형식을 바꾸지 못하게 한다.
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=never'];
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames'];

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function agentsLib() { return require('./agents'); }

// ── 실행기 ───────────────────────────────────────────────────────────────────
/**
 * 자식 실행 — {ok, code, out, err, timedOut}. 데드라인에 SIGTERM → 2s 뒤 SIGKILL, 그리고 **종료를
 *  기다린 뒤** 회신한다(호출측 락이 자식보다 먼저 풀리지 않게). input 이 있으면 stdin 으로 흘린다.
 */
function exec(bin, args, { cwd, timeout = 15000, input, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, out: '', err: String((e && e.message) || e), timedOut: false });
      return;
    }
    const outBufs = []; const errBufs = [];
    let outLen = 0; let errLen = 0;
    let timedOut = false;
    let killTimer = null;
    child.stdout.on('data', (b) => { if (outLen < MAX_BUFFER) { outBufs.push(b); outLen += b.length; } });
    child.stderr.on('data', (b) => { if (errLen < MAX_BUFFER) { errBufs.push(b); errLen += b.length; } });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) { /* noop */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }, KILL_GRACE_MS);
    }, Math.max(1, timeout));
    let spawnErr = null;
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const out = Buffer.concat(outBufs).toString('utf8');
      let err = Buffer.concat(errBufs).toString('utf8');
      if (spawnErr && !err) err = String(spawnErr.message || spawnErr);
      resolve({ ok: !timedOut && !spawnErr && code === 0, code: code == null ? -1 : code, out, err, timedOut });
    });
    // ★ 자식이 stdin 을 다 읽기 전에 죽으면(파이프 버퍼 ~64KB 초과 본문) EPIPE 'error' 가 stdin 에서 난다 —
    //   리스너가 없으면 uncaught 로 데몬 전체가 죽는다. 결과 판정은 close 가 한다.
    child.stdin.on('error', () => { /* noop */ });
    try {
      if (input != null) child.stdin.end(String(input));
      else child.stdin.end();
    } catch (_) { /* 자식이 stdin 을 안 읽고 죽었다 — close 가 수습 */ }
  });
}

// ── 도구 해석(git/gh) — 60초 캐시, 실패도 캐시(재시도 폭주 방지) ─────────────────────

function buildEnv(gitPath, ghPath, dirs) {
  const seen = new Set();
  const list = [];
  for (const d of [gitPath && path.dirname(gitPath), ghPath && path.dirname(ghPath), ...dirs]) {
    if (!d || seen.has(d)) continue;
    seen.add(d); list.push(d);
  }
  const env = {
    ...process.env,
    PATH: list.join(path.delimiter),
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    GIT_PAGER: 'cat',
    LANG: process.env.LANG || 'en_US.UTF-8',
  };
  // ★ 에러 분류가 영어 메시지(index.lock·nothing to commit·Not possible to fast-forward·rejected …)에 기댄다.
  //   Homebrew git 은 ko/ja 카탈로그가 있어 LANG=ko_KR 에서 번역된다 → 메시지만 C 로 고정한다.
  //   문자 인코딩(LC_CTYPE)은 사용자 값을 유지(-z·quotepath=false 출력은 바이트 그대로라 무관).
  const ctype = process.env.LC_ALL || process.env.LC_CTYPE || env.LANG;
  delete env.LC_ALL; // LC_ALL 이 남으면 LC_MESSAGES 를 덮는다
  env.LC_CTYPE = ctype;
  env.LC_MESSAGES = 'C';
  env.LANGUAGE = 'C';
  delete env.TMUX; // 중첩 가드 우회(데몬 컨벤션)
  return env;
}

/**
 * 바이너리 해석(로컬만, 네트워크 없음) — git/gh 경로·버전·env. git()/gh() 는 이것만 기다린다.
 *  gh 인증(네트워크 `gh auth status`·`gh api user`)은 따로 캐시한다 — 캐시가 식은 순간 모든 git 호출이
 *  최대 ~20s 씩 gh 조사를 기다리던 문제(오프라인이면 매번)를 없앤다.
 */
async function resolveBase() {
  const agents = agentsLib();
  let login = [];
  try { login = await agents.probeLoginPath(); } catch (_) { login = []; }
  const dirs = agents.searchDirs(login);
  const gitPath = agents.findBin('git', dirs);
  const ghPath = agents.findBin('gh', dirs);
  const env = buildEnv(gitPath, ghPath, dirs);
  const git = { ok: false, path: gitPath || null, version: null };
  if (!gitPath) git.error = 'GIT_MISSING';
  else {
    const r = await exec(gitPath, ['--version'], { env, timeout: 8000 });
    if (r.ok) {
      git.ok = true;
      const m = /(\d+\.\d+[\w.]*)/.exec(r.out);
      git.version = m ? m[1] : r.out.trim().slice(0, 40);
    } else {
      // macOS `/usr/bin/git` 은 CLT 심 — CLT 가 없으면 비정상 종료 + xcode-select 안내를 낸다.
      git.error = /xcode-select|command line developer tools/i.test(r.err + r.out) ? 'GIT_CLT_MISSING' : 'GIT_MISSING';
    }
  }
  const gh = { installed: !!ghPath, path: ghPath || null, version: null };
  if (ghPath) {
    const v = await exec(ghPath, ['--version'], { env, timeout: 8000 });
    if (v.ok) { const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(v.out); gh.version = m ? m[1] : null; }
  }
  return { git, gh, env };
}

// 네트워크 실패(오프라인·GitHub 장애)는 "로그인 안 됨" 이 아니다.
const GH_NET_RE = /error connecting|internet connection|timed? ?out|dial tcp|no such host|connection (refused|reset)|network is unreachable|TLS handshake|githubstatus/i;

/** gh 인증 조사(네트워크) — {authenticated, user, error?}. */
async function resolveAuth(base) {
  if (!base.gh.installed) return { authenticated: false, user: null, error: 'GH_MISSING' };
  const { env } = base;
  const a = await exec(base.gh.path, ['auth', 'status', '--hostname', 'github.com'], { env, timeout: 8000 });
  if (a.ok) {
    const out = { authenticated: true, user: null };
    const u = await exec(base.gh.path, ['api', 'user', '--jq', '.login'], { env, timeout: 5000 });
    if (u.ok) out.user = u.out.trim() || null;
    return out;
  }
  if (a.code === 1 && !a.timedOut && !GH_NET_RE.test(a.err + '\n' + a.out)) return { authenticated: false, user: null, error: 'GH_NOT_AUTHED' };
  return { authenticated: false, user: null, error: 'GH_ERROR' };
}

let baseCache = null; // { at, value }
let baseInflight = null;
let authCache = null; // { at, key, value }
let authInflight = null;

function baseTools({ refresh } = {}) {
  if (!refresh && baseCache && Date.now() - baseCache.at < TOOLS_CACHE_MS) return Promise.resolve(baseCache.value);
  if (!refresh && baseInflight) return baseInflight;
  const p = resolveBase().then((value) => {
    baseCache = { at: Date.now(), value };
    return value;
  }).finally(() => { if (baseInflight === p) baseInflight = null; });
  baseInflight = p;
  return p;
}

function ghAuth(base, { refresh } = {}) {
  const key = base.gh.path || '';
  if (!refresh && authCache && authCache.key === key && Date.now() - authCache.at < TOOLS_CACHE_MS) return Promise.resolve(authCache.value);
  if (!refresh && authInflight && authInflight.key === key) return authInflight.p;
  const p = resolveAuth(base).then((value) => {
    authCache = { at: Date.now(), key, value };
    return value;
  }).finally(() => { if (authInflight && authInflight.p === p) authInflight = null; });
  authInflight = { key, p };
  return p;
}

function combine(base, auth) {
  const gh = { ...base.gh, authenticated: !!(auth && auth.authenticated), user: (auth && auth.user) || null, host: 'github.com' };
  if (!base.gh.installed) gh.error = 'GH_MISSING';
  else if (auth && auth.error) gh.error = auth.error;
  return { git: base.git, gh, env: base.env };
}

/** tools({refresh}) → {git:{ok,path,version,error?}, gh:{installed,path,version,authenticated,user,host,error?}, env} */
async function tools({ refresh } = {}) {
  const base = await baseTools({ refresh });
  const auth = await ghAuth(base, { refresh });
  return combine(base, auth);
}

/** 캐시만 본다(없으면 null) — task.list 처럼 블록하면 안 되는 자리에서 쓴다. */
function toolsCached() {
  if (!baseCache || !authCache || authCache.key !== (baseCache.value.gh.path || '')) return null;
  return combine(baseCache.value, authCache.value);
}

function resetCache() { baseCache = null; baseInflight = null; authCache = null; authInflight = null; }

/** git(args, {cwd, timeout=15000, input}) — 공통 접두 포함. git 이 없으면 {ok:false, code:-1, err}. */
async function git(args, { cwd, timeout = 15000, input, raw } = {}) {
  const t = await baseTools(); // ★ gh 인증 조사(네트워크)를 기다리지 않는다
  if (!t.git.ok) return { ok: false, code: -1, out: '', err: t.git.error || 'GIT_MISSING', timedOut: false };
  return exec(t.git.path, raw ? args : [...GIT_PREFIX, ...args], { cwd, timeout, input, env: t.env });
}

/** gh(args, {cwd, timeout=30000, input}). gh 가 없으면 {ok:false, code:-1, err:'GH_MISSING'}. */
async function gh(args, { cwd, timeout = 30000, input } = {}) {
  const t = await baseTools();
  if (!t.gh.installed) return { ok: false, code: -1, out: '', err: 'GH_MISSING', timedOut: false };
  return exec(t.gh.path, args, { cwd, timeout, input, env: t.env });
}

/** gh 사용 전제 — 설치·인증 여부를 코드로 던진다(NOT_GITHUB 보다 먼저, §2.4). */
async function requireGh() {
  const t = await tools();
  if (!t.gh.installed) throw codedError('GH_MISSING', 'GitHub CLI(gh) 가 이 PC 에 없습니다');
  if (!t.gh.authenticated) {
    // 캐시된 "미인증" 이 사용자가 방금 로그인한 뒤에도 60초 남는 것을 막는다 — 한 번 새로 확인.
    const t2 = await tools({ refresh: true });
    if (!t2.gh.installed) throw codedError('GH_MISSING', 'GitHub CLI(gh) 가 이 PC 에 없습니다');
    if (!t2.gh.authenticated) {
      if (t2.gh.error === 'GH_ERROR') throw codedError('GH_ERROR', 'gh 상태 확인에 실패했습니다');
      throw codedError('GH_NOT_AUTHED', 'gh 로그인이 필요합니다(PC 터미널에서 gh auth login 또는 GH_TOKEN 환경변수)');
    }
  }
}

// ── 파서 ─────────────────────────────────────────────────────────────────────
function splitZ(out) { return String(out || '').split('\0').filter((s) => s !== ''); }

/** `status --porcelain=v1 -z` → [{xy, path}] (rename 의 원경로 항목은 건너뛴다). */
function parseStatusZ(out) {
  const parts = String(out || '').split('\0');
  const items = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.length < 4) continue;
    const xy = p.slice(0, 2);
    items.push({ xy, path: p.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // 다음 항목 = 원경로
  }
  return items;
}

/** `worktree list --porcelain` → [{path, head, branch|null, detached, bare}] */
function parseWorktreeList(out) {
  const items = [];
  let cur = null;
  for (const line of String(out || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false }; items.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7);
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
  }
  return items;
}

/** `diff --numstat -z` (--no-renames) → Map(path → {additions, deletions, binary}) */
function parseNumstatZ(out) {
  const map = new Map();
  for (const rec of splitZ(out)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    map.set(m[3], { additions: binary ? 0 : parseInt(m[1], 10), deletions: binary ? 0 : parseInt(m[2], 10), binary });
  }
  return map;
}

/** `diff --name-status -z` (--no-renames) → [{status, path}] */
function parseNameStatusZ(out) {
  const parts = splitZ(out);
  const items = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const st = parts[i][0];
    items.push({ status: st === 'A' || st === 'D' ? st : 'M', path: parts[i + 1] });
  }
  return items;
}

// ── 저장소 조회 ───────────────────────────────────────────────────────────────
/** 저장소 정규화(§2.5 1) — {top, common, subdir}(절대·realpath). 저장소가 아니면 null. */
async function repoInfo(absPath) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: absPath });
  if (!r.ok || r.out.trim() !== 'true') return null;
  const t = await git(['rev-parse', '--show-toplevel'], { cwd: absPath });
  const c = await git(['rev-parse', '--git-common-dir'], { cwd: absPath });
  if (!t.ok || !c.ok) return null;
  let top = t.out.trim();
  let common = path.resolve(absPath, c.out.trim());
  try { top = fs.realpathSync(top); } catch (_) { /* noop */ }
  try { common = fs.realpathSync(common); } catch (_) { /* noop */ }
  let real = absPath;
  try { real = fs.realpathSync(absPath); } catch (_) { /* noop */ }
  const subdir = path.relative(top, real).split(path.sep).join('/');
  return { top, common, subdir: subdir.startsWith('..') ? '' : subdir };
}

async function refExists(cwd, ref) {
  const r = await git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { cwd });
  return r.ok ? r.out.trim() : null;
}

async function remoteUrl(cwd) {
  const r = await git(['config', '--get', 'remote.origin.url'], { cwd });
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

async function worktreeList(cwd) {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd });
  if (!r.ok) return [];
  return parseWorktreeList(r.out).map((w) => {
    let p = w.path;
    try { p = fs.realpathSync(p); } catch (_) { /* 사라진 worktree — 원문 유지 */ }
    return { ...w, path: p };
  });
}

async function statusItems(cwd, { timeout } = {}) {
  const r = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, timeout });
  if (!r.ok) throw codedError(r.timedOut ? 'TIMEOUT' : 'WORKTREE_MISSING', `git status 실패: ${r.err.trim().slice(0, 200)}`);
  return parseStatusZ(r.out);
}

/** 브랜치 목록(git.branches) — {current, detached, dirtyCount, branches:[{name}], remoteUrl} */
async function branches(cwd) {
  const r = await git(['for-each-ref', '--count=200', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], { cwd });
  const names = r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const h = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd });
  const current = h.ok ? h.out.trim() : null;
  let dirtyCount = 0;
  try { dirtyCount = (await statusItems(cwd)).length; } catch (_) { dirtyCount = 0; }
  return {
    current, detached: !current, dirtyCount,
    branches: names.map((name) => ({ name })),
    remoteUrl: await remoteUrl(cwd),
  };
}

// ── worktree ─────────────────────────────────────────────────────────────────
/** `worktree add --no-track -b <branch> -- <absDir> <startPoint>`. 실패 시 되돌린 뒤 WORKTREE_ADD_FAILED. */
async function worktreeAdd(top, { branch, absDir, startPoint, timeout = 10 * 60 * 1000 }) {
  if (fs.existsSync(absDir)) throw codedError('WORKTREE_ADD_FAILED', '작업 폴더가 이미 있습니다');
  const r = await git(['worktree', 'add', '--no-track', '-b', branch, '--', absDir, startPoint], { cwd: top, timeout });
  if (!r.ok) {
    await git(['worktree', 'remove', '--force', '--', absDir], { cwd: top }).catch(() => {});
    await git(['branch', '-D', branch], { cwd: top }).catch(() => {});
    await git(['worktree', 'prune'], { cwd: top }).catch(() => {});
    throw codedError(r.timedOut ? 'TIMEOUT' : 'WORKTREE_ADD_FAILED', (r.err || r.out).trim().slice(0, 300) || 'worktree add 실패');
  }
  if (fs.existsSync(path.join(absDir, '.gitmodules'))) {
    const s = await git(['submodule', 'update', '--init', '--recursive'], { cwd: absDir, timeout });
    if (!s.ok) console.warn(`[task-git] 서브모듈 초기화 실패(무시): ${s.err.trim().slice(0, 200)}`);
  }
  return true;
}

/** 되돌리기(creating 재개 불가·생성 실패) — 전부 멱등, 실패 무해. */
async function worktreeRevert(top, { branch, absDir }) {
  await git(['worktree', 'remove', '--force', '--', absDir], { cwd: top }).catch(() => {});
  await git(['branch', '-D', branch], { cwd: top }).catch(() => {});
  await git(['worktree', 'prune'], { cwd: top }).catch(() => {});
}

/**
 * env 파일 복사(§2.5 7) — top 과 top/<subdir> 의 `.env`/`.env.*`(example/sample 제외) 중 **worktree 안에서**
 *  check-ignore 가 참이고 심링크가 아니며 1MB 이하인 것만. 반환 = worktree 상대경로 목록.
 */
async function copyEnvFiles(top, subdir, wtAbs) {
  const out = [];
  const dirs = [''];
  if (subdir) dirs.push(subdir);
  for (const rel of dirs) {
    const src = path.join(top, rel);
    let names = [];
    try { names = fs.readdirSync(src); } catch (_) { continue; }
    for (const name of names) {
      if (!(name === '.env' || name.startsWith('.env.'))) continue;
      if (/\.(example|sample)$/i.test(name) || /^\.env\.(example|sample)\b/i.test(name)) continue;
      const from = path.join(src, name);
      let st;
      try { st = fs.lstatSync(from); } catch (_) { continue; }
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) continue;
      const relPath = (rel ? rel + '/' : '') + name;
      const to = path.join(wtAbs, relPath);
      if (fs.existsSync(to)) continue; // 추적 파일이면 worktree 에 이미 있다 — 덮지 않는다
      if (!fs.existsSync(path.dirname(to))) continue;
      const ci = await git(['check-ignore', '-q', '--', relPath], { cwd: wtAbs });
      if (!ci.ok) continue; // ignored 가 아닌 파일은 복사하지 않는다(커밋될 수 있다)
      try {
        fs.copyFileSync(from, to);
        try { fs.chmodSync(to, st.mode & 0o777); } catch (_) { /* noop */ }
        out.push(relPath);
      } catch (_) { /* 한 파일 실패는 무시 */ }
    }
  }
  return out;
}

// ── diff/통계 ────────────────────────────────────────────────────────────────
async function mergeBaseOf(dir, baseSha) {
  const r = await git(['merge-base', baseSha, 'HEAD'], { cwd: dir });
  return r.ok ? r.out.trim() : baseSha;
}

function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

const TEXT_SCAN_MAX = 4 * 1024 * 1024;
/** 미추적 파일 → {additions, binary}. 텍스트만 줄수를 센다(바이너리 = NUL 포함 또는 4MB 초과). */
function untrackedStat(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { additions: 0, binary: true };
    if (st.size > TEXT_SCAN_MAX) return { additions: 0, binary: true };
    const buf = readHead(abs, st.size);
    if (buf.subarray(0, 8000).includes(0)) return { additions: 0, binary: true };
    if (!buf.length) return { additions: 0, binary: false };
    const s = buf.toString('utf8');
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    if (s[s.length - 1] !== '\n') n++;
    return { additions: n, binary: false };
  } catch (_) { return { additions: 0, binary: true }; }
}

/**
 * 파일 목록(§2.9) — merge-base 대비 워킹트리+인덱스(추적) + 미추적(`?`). 경로로 dedupe.
 *  반환 [{path, status, additions, deletions, binary}] + mergeBase.
 */
async function changedFiles(dir, baseSha) {
  const mergeBase = await mergeBaseOf(dir, baseSha);
  const ns = await git(['diff', '--numstat', '-z', ...DIFF_FLAGS, mergeBase], { cwd: dir, timeout: 30000 });
  const nm = await git(['diff', '--name-status', '-z', ...DIFF_FLAGS, mergeBase], { cwd: dir, timeout: 30000 });
  const un = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: dir, timeout: 30000 });
  if (!ns.ok || !nm.ok || !un.ok) {
    const bad = [ns, nm, un].find((x) => !x.ok);
    throw codedError(bad.timedOut ? 'TIMEOUT' : 'WORKTREE_MISSING', `git diff 실패: ${bad.err.trim().slice(0, 200)}`);
  }
  const stats = parseNumstatZ(ns.out);
  const files = new Map();
  for (const { status, path: p } of parseNameStatusZ(nm.out)) {
    const s = stats.get(p) || { additions: 0, deletions: 0, binary: false };
    files.set(p, { path: p, status, additions: s.additions, deletions: s.deletions, binary: s.binary });
  }
  for (const p of splitZ(un.out)) {
    if (files.has(p)) continue;
    const s = untrackedStat(path.join(dir, p));
    files.set(p, { path: p, status: '?', additions: s.additions, deletions: 0, binary: s.binary });
  }
  return { mergeBase, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/**
 * refreshRun 통계(§2.9) — {dirty, uncommitted, ahead, diff:{files,additions,deletions}, pushed, head}.
 *  diff 는 워킹트리+인덱스+미추적을 merge-base 에 대고 한 번에 센다(numstat 중복 금지).
 */
async function runStat(dir, baseSha) {
  const st = await statusItems(dir);
  const { mergeBase, files } = await changedFiles(dir, baseSha);
  const rc = await git(['rev-list', '--count', `${mergeBase}..HEAD`], { cwd: dir });
  const ahead = rc.ok ? parseInt(rc.out.trim(), 10) || 0 : 0;
  let additions = 0; let deletions = 0;
  for (const f of files) { additions += f.additions; deletions += f.deletions; }
  let pushed = false;
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: dir });
  if (up.ok && up.out.trim()) {
    const c = await git(['rev-list', '--count', '@{upstream}..HEAD'], { cwd: dir });
    pushed = c.ok && parseInt(c.out.trim(), 10) === 0;
  }
  const h = await git(['rev-parse', 'HEAD'], { cwd: dir });
  return {
    dirty: st.length > 0, uncommitted: st.length, ahead, pushed,
    diff: { files: files.length, additions, deletions }, head: h.ok ? h.out.trim() : null, mergeBase,
  };
}

/** 한 파일의 diff 본문 — 추적은 merge-base 대비, 미추적은 /dev/null 대비. */
async function fileDiffText(dir, mergeBase, file, untracked) {
  const args = untracked
    ? ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file]
    : ['diff', ...DIFF_FLAGS, mergeBase, '--', file];
  const r = await git(args, { cwd: dir, timeout: 30000 });
  // --no-index 는 차이가 있으면 exit 1 이다(정상).
  if (!r.ok && !(untracked && r.code === 1)) return null;
  return r.out;
}

// ── 커밋/푸시 ────────────────────────────────────────────────────────────────
const LOCK_RE = /index\.lock|Unable to create .*\.lock|another git process/i;
const SIGN_RE = /gpg failed|signing failed|ssh-keygen|failed to sign|error: gpg/i;
const HOOK_RE = /husky|pre-commit|lint-staged|commit-msg|hook/i;

async function withLockRetry(fn) {
  const waits = [500, 1000, 2000];
  let r = await fn();
  for (const w of waits) {
    if (r.ok || !LOCK_RE.test(r.err + r.out)) return r;
    await new Promise((res) => setTimeout(res, w));
    r = await fn();
  }
  return r;
}

/**
 * git.commit(§2.9) — exclude 복사 시크릿, identity 확인, 훅/서명/락 분류. 성공 {sha, short}.
 *  실패는 throw {code, message, stderrTail?}.
 */
async function commit(dir, { message, noVerify = false, exclude = [], deadline } = {}) {
  const left = () => (deadline ? Math.max(1000, deadline - Date.now()) : 5 * 60 * 1000);
  const email = await git(['config', 'user.email'], { cwd: dir });
  if (!email.ok || !email.out.trim()) throw codedError('GIT_IDENTITY_MISSING', 'git 사용자 이메일(user.email)이 설정되어 있지 않습니다');
  // exclude pathspec 은 **지금 ignore 가 아닌** 복사본에만 건다 — ignored 경로를 pathspec 에 이름으로 적으면
  //  `git add` 가 "paths are ignored" 로 exit 1 한다(실측). 복사본은 원래 ignored 만 고르지만(§2.5 7),
  //  에이전트가 .gitignore 를 고쳤으면 커밋 대상이 되므로 그때만 명시적으로 뺀다.
  const live = [];
  for (const f of exclude) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    const ci = await git(['check-ignore', '-q', '--', f], { cwd: dir });
    if (!ci.ok) live.push(f);
  }
  const pathspec = ['.', ...live.map((f) => `:(exclude)${f}`)];
  const add = await withLockRetry(() => git(['add', '-A', '--', ...pathspec], { cwd: dir, timeout: left() }));
  if (!add.ok) {
    if (add.timedOut) throw codedError('TIMEOUT', 'git add 시간 초과');
    if (LOCK_RE.test(add.err)) throw codedError('GIT_LOCKED', '저장소가 잠겨 있습니다(index.lock)');
    throw codedError('GH_ERROR', `git add 실패: ${add.err.trim().slice(0, 200)}`);
  }
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: dir });
  if (staged.ok) throw codedError('NOTHING_TO_COMMIT', '커밋할 변경이 없습니다');
  const args = ['commit', `--message=${message}`];
  if (noVerify) args.push('--no-verify');
  const r = await withLockRetry(() => git(args, { cwd: dir, timeout: left() }));
  if (!r.ok) {
    const all = r.err + '\n' + r.out;
    if (r.timedOut) throw codedError('TIMEOUT', 'git commit 시간 초과');
    if (LOCK_RE.test(all)) throw codedError('GIT_LOCKED', '저장소가 잠겨 있습니다(index.lock)');
    if (SIGN_RE.test(all)) throw codedError('GIT_SIGN_FAILED', '커밋 서명에 실패했습니다');
    if (/nothing to commit/i.test(all)) throw codedError('NOTHING_TO_COMMIT', '커밋할 변경이 없습니다');
    if (/Please tell me who you are|empty ident|user\.email/i.test(all)) throw codedError('GIT_IDENTITY_MISSING', 'git 사용자 정보가 없습니다');
    // 훅 실패: 문구에 훅 이름이 있거나, --no-verify 없이 실패했는데 위 어느 것도 아닌 경우(훅 스크립트 실패).
    if (!noVerify || HOOK_RE.test(all)) {
      const e = codedError('COMMIT_HOOK_FAILED', '커밋 훅이 실패했습니다');
      e.stderrTail = all.trim().slice(-2048);
      throw e;
    }
    throw codedError('GH_ERROR', `git commit 실패: ${all.trim().slice(0, 200)}`);
  }
  const h = await git(['rev-parse', 'HEAD'], { cwd: dir });
  const sha = h.out.trim();
  return { sha, short: sha.slice(0, 7) };
}

async function push(dir, branch, { timeout = 3 * 60 * 1000 } = {}) {
  const url = await remoteUrl(dir);
  if (!url) throw codedError('NO_REMOTE', '원격 저장소(origin)가 없습니다');
  const r = await git(['push', '-u', 'origin', branch], { cwd: dir, timeout });
  if (!r.ok) {
    const all = r.err + '\n' + r.out;
    if (r.timedOut) throw codedError('TIMEOUT', 'git push 시간 초과');
    if (/rejected|non-fast-forward/i.test(all)) throw codedError('PUSH_REJECTED', '푸시가 거부됐습니다');
    if (/Authentication failed|Permission denied|could not read Username|403|terminal prompts disabled/i.test(all)) {
      throw codedError('AUTH_FAILED', '원격 인증에 실패했습니다');
    }
    throw codedError('PUSH_REJECTED', `푸시 실패: ${all.trim().slice(0, 200)}`);
  }
  return { remote: 'origin', branch };
}

// ── GitHub(gh) ───────────────────────────────────────────────────────────────
/** `gh repo view --json owner,name` — SSH 별칭·다중 remote 를 gh 가 푼다(§2.4). 실패 = NOT_GITHUB. */
async function githubRepo(dir) {
  await requireGh();
  const r = await gh(['repo', 'view', '--json', 'owner,name'], { cwd: dir, timeout: 15000 });
  if (!r.ok) throw codedError(r.timedOut ? 'TIMEOUT' : 'NOT_GITHUB', 'GitHub 저장소가 아닙니다');
  try {
    const j = JSON.parse(r.out);
    const owner = j.owner && (j.owner.login || j.owner.name || j.owner);
    if (typeof owner === 'string' && owner && typeof j.name === 'string' && j.name) return { owner, repo: j.name };
  } catch (_) { /* 아래 */ }
  throw codedError('NOT_GITHUB', 'GitHub 저장소를 판정할 수 없습니다');
}

const PR_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,headRefOid,baseRefName,title,mergedAt,mergeCommit';

function checkItemStatus(c) {
  // CheckRun: status(QUEUED|IN_PROGRESS|COMPLETED) + conclusion / StatusContext: state(SUCCESS|FAILURE|PENDING|ERROR|EXPECTED)
  const concl = String(c.conclusion || '').toUpperCase();
  const state = String(c.state || '').toUpperCase();
  const status = String(c.status || '').toUpperCase();
  if (concl) {
    if (concl === 'SUCCESS' || concl === 'NEUTRAL') return 'passing';
    if (concl === 'SKIPPED') return 'skipped';
    return 'failing'; // FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE
  }
  if (state) {
    if (state === 'SUCCESS') return 'passing';
    if (state === 'FAILURE' || state === 'ERROR') return 'failing';
    return 'pending';
  }
  if (status && status !== 'COMPLETED') return 'pending';
  return 'pending';
}

/** statusCheckRollup → checks{status,total,passed,failed,pending,items[≤20]} */
function foldChecks(rollup) {
  const arr = Array.isArray(rollup) ? rollup : [];
  const items = arr.map((c) => {
    const it = { name: String(c.name || c.context || c.workflowName || 'check').slice(0, 120), status: checkItemStatus(c) };
    const url = c.detailsUrl || c.targetUrl;
    if (typeof url === 'string' && url) it.url = url;
    return it;
  });
  const passed = items.filter((i) => i.status === 'passing').length;
  const failed = items.filter((i) => i.status === 'failing').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const status = !items.length ? 'none' : failed ? 'failing' : pending ? 'pending' : 'passing';
  return { status, total: items.length, passed, failed, pending, items: items.slice(0, 20) };
}

/** gh pr view JSON → PrInfo(§3.1) */
function toPrInfo(j, now) {
  const st = String(j.state || '').toUpperCase();
  const mergeable = ['MERGEABLE', 'CONFLICTING'].includes(String(j.mergeable)) ? String(j.mergeable) : 'UNKNOWN';
  return {
    number: j.number,
    url: j.url,
    state: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : 'open',
    isDraft: !!j.isDraft,
    title: String(j.title || ''),
    mergeable,
    mergeStateStatus: String(j.mergeStateStatus || 'UNKNOWN'),
    reviewDecision: j.reviewDecision ? String(j.reviewDecision) : null,
    checks: foldChecks(j.statusCheckRollup),
    at: now,
  };
}

/** PR 조회 — {pr, mergeSha} | null(PR 없음). 그 외 실패는 throw. */
async function prView(dir, github, selector, now) {
  const r = await gh(['pr', 'view', '--repo', `${github.owner}/${github.repo}`, String(selector), '--json', PR_FIELDS], { cwd: dir, timeout: 30000 });
  if (!r.ok) {
    if (r.timedOut) throw codedError('TIMEOUT', 'gh pr view 시간 초과');
    if (/no pull requests found|could not find|not found/i.test(r.err)) return null;
    throw codedError('GH_ERROR', `gh pr view 실패: ${r.err.trim().slice(0, 200)}`);
  }
  let j;
  try { j = JSON.parse(r.out); } catch (_) { throw codedError('GH_ERROR', 'gh pr view 응답을 해석할 수 없습니다'); }
  return { pr: toPrInfo(j, now), mergeSha: (j.mergeCommit && j.mergeCommit.oid) || null, headOid: j.headRefOid ? String(j.headRefOid) : null };
}

/** gh pr create — 본문은 stdin. 이미 있으면 existed:true 로 회수(에러 아님, §2.9). */
async function prCreate(dir, github, { branch, base, title, body, draft, now }) {
  const args = ['pr', 'create', '--repo', `${github.owner}/${github.repo}`, '--head', branch, '--base', base,
    `--title=${title}`, '--body-file=-'];
  if (draft) args.push('--draft');
  const r = await gh(args, { cwd: dir, timeout: 2 * 60 * 1000, input: body || '' });
  let existed = false;
  if (!r.ok) {
    if (r.timedOut) throw codedError('TIMEOUT', 'gh pr create 시간 초과');
    if (!/already exists/i.test(r.err + r.out)) throw codedError('GH_ERROR', `PR 생성 실패: ${r.err.trim().slice(0, 300)}`);
    existed = true;
  }
  const m = /\/pull\/(\d+)/.exec(r.out + '\n' + r.err);
  const v = await prView(dir, github, m ? m[1] : branch, now);
  if (!v) throw codedError('PR_NOT_FOUND', 'PR 을 찾을 수 없습니다');
  return { pr: v.pr, existed };
}

async function prMerge(dir, github, number, method) {
  const r = await gh(['pr', 'merge', '--repo', `${github.owner}/${github.repo}`, String(number), `--${method}`], { cwd: dir, timeout: 2 * 60 * 1000 });
  if (!r.ok) {
    const all = r.err + '\n' + r.out;
    if (r.timedOut) throw codedError('TIMEOUT', 'gh pr merge 시간 초과');
    if (/not mergeable|conflict/i.test(all)) throw codedError('PR_NOT_MERGEABLE', 'PR 을 지금 머지할 수 없습니다');
    if (/check|status/i.test(all) && /fail|required/i.test(all)) throw codedError('CHECKS_FAILING', '검사가 실패한 상태입니다');
    throw codedError('GH_ERROR', `PR 머지 실패: ${all.trim().slice(0, 300)}`);
  }
  return true;
}

// ── 로컬 머지(§2.9 git.merge.local) ─────────────────────────────────────────
async function conflictFiles(cwd) {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd });
  return r.ok ? splitZ(r.out) : [];
}

/**
 * cwd(= base 가 체크아웃된 worktree 또는 임시 detached worktree)에서 branch 를 머지한다.
 *  → {ok:true, sha} | {ok:false, code:'MERGE_CONFLICT', files}. 그 외 실패는 throw.
 */
async function mergeIn(cwd, { branch, method, message, timeout }) {
  if (method !== 'ff') {
    const email = await git(['config', 'user.email'], { cwd });
    if (!email.ok || !email.out.trim()) throw codedError('GIT_IDENTITY_MISSING', 'git 사용자 이메일(user.email)이 설정되어 있지 않습니다');
  }
  let r;
  if (method === 'ff') r = await git(['merge', '--ff-only', '--', branch], { cwd, timeout });
  else if (method === 'squash') r = await git(['merge', '--squash', '--', branch], { cwd, timeout });
  else r = await git(['merge', '--no-ff', `--message=${message}`, '--', branch], { cwd, timeout });
  if (!r.ok) {
    if (r.timedOut) throw codedError('TIMEOUT', 'git merge 시간 초과');
    const files = await conflictFiles(cwd);
    if (files.length || /CONFLICT/.test(r.out + r.err)) {
      if (method === 'squash') await git(['reset', '--merge'], { cwd });
      else await git(['merge', '--abort'], { cwd });
      return { ok: false, code: 'MERGE_CONFLICT', files };
    }
    if (method === 'ff' && /Not possible to fast-forward|not possible/i.test(r.err + r.out)) {
      return { ok: false, code: 'MERGE_CONFLICT', files: [] };
    }
    throw codedError('GH_ERROR', `git merge 실패: ${(r.err || r.out).trim().slice(0, 300)}`);
  }
  if (method === 'squash') {
    const staged = await git(['diff', '--cached', '--quiet'], { cwd });
    if (!staged.ok) {
      const c = await git(['commit', `--message=${message}`], { cwd, timeout });
      if (!c.ok) {
        await git(['reset', '--merge'], { cwd });
        if (SIGN_RE.test(c.err)) throw codedError('GIT_SIGN_FAILED', '커밋 서명에 실패했습니다');
        const e = codedError('COMMIT_HOOK_FAILED', '머지 커밋이 실패했습니다');
        e.stderrTail = (c.err + '\n' + c.out).trim().slice(-2048);
        throw e;
      }
    }
  }
  const h = await git(['rev-parse', 'HEAD'], { cwd });
  return { ok: true, sha: h.out.trim() };
}

module.exports = {
  tools, baseTools, toolsCached, resetCache, git, gh, exec, requireGh,
  repoInfo, refExists, remoteUrl, worktreeList, statusItems, branches,
  worktreeAdd, worktreeRevert, copyEnvFiles,
  mergeBaseOf, changedFiles, runStat, fileDiffText, untrackedStat,
  commit, push, githubRepo, prView, prCreate, prMerge, foldChecks, toPrInfo,
  mergeIn, conflictFiles,
  codedError,
  _parse: { parseStatusZ, parseWorktreeList, parseNumstatZ, parseNameStatusZ },
  GIT_PREFIX,
};
