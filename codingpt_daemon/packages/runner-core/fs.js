/**
 * 파일시스템 RPC — 제어 채널의 {type:'rpc', method:'fs.*'} 처리
 *
 * 보안(필수): allowlist 루트(기본 홈 디렉토리) 밖은 절대 접근 불가.
 *  - 모든 경로는 루트 기준 상대경로로 받고, resolve 후 realpath 로 심링크 탈출까지 차단.
 *  - 기본 deny: 루트를 벗어나면 에러.
 * P1 MVP 는 단일 루트(홈). P3 에서 워크스페이스별 다중 allowlist 로 확장.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');
const runtime = require('./runtime');
const configLib = require('./config');

// fs jail 루트 — 지연 평가(runner-core 로드 후 부트스트랩이 init 해도 반영되게).
//  로컬 데몬=사용자 홈, 클라우드 러너=컨테이너 workdir.
const rootDir = () => runtime.root();

// 전체 디스크 접근 토글 — config.allowFullDisk=true 면 홈 jail 을 우회한다(홈 밖 절대경로 허용).
//  기본은 false(홈 jail 유지). safeResolve 가 아주 자주 불리므로 2초 TTL 캐시로 config 재읽기를 억제.
//  전제: 사용자가 이 토글을 켤 땐 데몬 프로세스(터미널/앱)에 macOS 전체 디스크 접근(FDA)을 부여해야
//  실제 파일 접근 시 TCC 프롬프트가 안 뜬다. jail 완화는 원격 조작이라 신중히(사용자 명시 opt-in).
let _fullDiskCache = { at: 0, val: false };
function allowFullDisk() {
  const now = Date.now();
  if (now - _fullDiskCache.at < 2000) return _fullDiskCache.val;
  const cfg = configLib.load() || {};
  _fullDiskCache = { at: now, val: cfg.allowFullDisk === true };
  return _fullDiskCache.val;
}

// 목록에서 숨기고 순회도 막을 디렉토리(성능/노이즈/보안).
const HIDDEN_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', '__pycache__',
  'Library', 'Applications', '.Trash', '.npm', '.cargo', '.rustup', 'go',
]);
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB 초과 텍스트는 편집 대상에서 제외
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 이미지 미리보기 base64 상한
// 목록/트리에 노출할 점파일(대부분의 점파일은 숨기되 흔한 편집 대상만 화이트리스트).
const SHOWN_DOTFILES = new Set([
  '.env', '.gitignore', '.gitattributes', '.eslintrc', '.prettierrc', '.babelrc',
  '.editorconfig', '.npmrc', '.nvmrc', '.dockerignore', '.eslintignore', '.prettierignore',
]);
const isShownDotfile = (name) => SHOWN_DOTFILES.has(name) || name.toLowerCase().startsWith('.env');
const TEXT_EXT = new Set([
  'js','jsx','ts','tsx','mjs','cjs','json','html','htm','css','scss','less','md','txt',
  'py','java','c','cpp','h','hpp','go','rs','rb','php','sh','bash','yml','yaml','xml','svg',
  'sql','toml','ini','env','gitignore','dockerfile','vue','svelte','kt','swift','lua','pl','r',
  'conf','cfg','log','properties','lock','gradle','bat','ps1','zsh','fish','tsv','csv','graphql',
  'gql','proto','tf','hcl','rst','tex','astro','cjson','jsonc','editorconfig','prettierrc',
  'eslintrc','babelrc','npmrc','nvmrc','mdx','vim','makefile','cmake','gitattributes',
]);

// 루트 기준 상대경로 → 안전한 절대경로. 탈출 시 throw.
function safeResolve(rel) {
  const ROOT = rootDir();
  const abs = path.resolve(ROOT, rel || '.');
  // 전체 디스크 허용 시 jail 검증을 건너뛴다(절대경로면 그대로, 상대면 홈 기준).
  //  나중에 쉽게 되돌릴 수 있도록 config 플래그 하나로만 게이팅.
  if (allowFullDisk()) return abs;
  const rootReal = fs.realpathSync(ROOT);
  // 존재하는 경로면 realpath 로, 없으면(신규 파일 write) 부모까지 realpath 로 검증.
  let checkAbs = abs;
  if (!fs.existsSync(abs)) checkAbs = path.dirname(abs);
  let real;
  try { real = fs.realpathSync(checkAbs); } catch (_) { real = checkAbs; }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    const err = new Error('허용되지 않은 경로입니다.');
    err.code = 'EACCES_JAIL';
    throw err;
  }
  return abs;
}

function relOf(abs) {
  const rel = path.relative(rootDir(), abs).split(path.sep).join('/');
  // 홈 밖(전체 디스크 모드)이면 상대경로가 '../../…' 로 지저분해지므로 절대경로를 식별자로 사용.
  //  safeResolve 는 절대경로 입력을 그대로 처리하므로 왕복이 안전하다.
  if (rel.startsWith('..')) return abs.split(path.sep).join('/');
  return rel;
}

function isTextFile(name) {
  const lower = name.toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (lower.startsWith('.env')) return true; // .env / .env.local / .env.production …
  if (name.startsWith('.') && TEXT_EXT.has(name.slice(1).toLowerCase())) return true;
  return TEXT_EXT.has(ext) || lower === 'dockerfile' || lower === 'makefile' || lower === 'procfile' || lower === 'brewfile';
}

// fs.list — 한 디렉토리의 항목(디렉토리 우선, 숨김/무거운 디렉토리 제외).
async function list(params) {
  const rel = params?.path || '';
  const abs = safeResolve(rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && !isShownDotfile(e.name)) continue; // 점파일은 대체로 숨김(흔한 편집 대상만 노출)
    const isDir = e.isDirectory();
    if (isDir && HIDDEN_DIRS.has(e.name)) continue;
    items.push({
      name: e.name,
      path: relOf(path.join(abs, e.name)),
      dir: isDir,
      text: isDir ? false : isTextFile(e.name),
    });
  }
  items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { root: relOf(abs), items };
}

// fs.tree — 선택한 폴더(rel) 아래를 bounded 재귀 순회해 "파일 flat 목록"을 반환.
//  모바일 IDE 는 objectstore 프로젝트처럼 파일 경로 flat 목록으로 트리를 구성한다(디렉토리는 경로에서 파생).
//  → 데몬 폴더를 IDE 프로젝트로 그대로 소비 가능. path 는 선택 루트(rel) 기준 상대경로.
//  깊이/개수 상한으로 거대한 폴더에서도 안전(초과 시 truncated=true).
const TREE_MAX_DEPTH = 8;
const TREE_MAX_FILES = 4000;
async function tree(params) {
  const rel = (params?.path || '').replace(/^\/+|\/+$/g, '');
  const rootAbs = safeResolve(rel);
  const st = await fsp.stat(rootAbs);
  if (!st.isDirectory()) throw new Error('폴더가 아닙니다.');
  const items = [];
  let truncated = false;
  // rootAbs 기준 상대경로(선택 폴더가 트리 루트가 되도록).
  const relToRoot = (abs) => path.relative(rootAbs, abs).split(path.sep).join('/');
  const walk = async (absDir, depth) => {
    if (truncated || depth > TREE_MAX_DEPTH) return;
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch (_) { return; } // 권한 없는 디렉토리 건너뜀
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (items.length >= TREE_MAX_FILES) { truncated = true; return; }
      const isDir = e.isDirectory();
      if (e.name.startsWith('.') && !isShownDotfile(e.name)) continue;
      const absChild = path.join(absDir, e.name);
      if (isDir) {
        if (HIDDEN_DIRS.has(e.name)) continue;
        await walk(absChild, depth + 1);
      } else {
        items.push({ path: relToRoot(absChild), text: isTextFile(e.name) });
      }
    }
  };
  await walk(rootAbs, 0);
  return { root: rel, items, truncated };
}

// fs.read — 텍스트 파일 내용. 바이너리/초과 크기는 편집 불가로 표시.
//  base64:true 면 원본 바이트를 base64 로 반환(이미지 미리보기 — 바이너리도 허용).
async function read(params) {
  const abs = safeResolve(params?.path || '');
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('디렉토리는 열 수 없습니다.');
  if (params?.base64) {
    if (st.size > MAX_IMAGE_BYTES) return { path: relOf(abs), tooLarge: true, size: st.size };
    const buf = await fsp.readFile(abs);
    return { path: relOf(abs), base64: buf.toString('base64'), size: st.size };
  }
  if (st.size > MAX_READ_BYTES) return { path: relOf(abs), tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  // NUL 바이트가 있으면 바이너리로 간주.
  if (buf.includes(0)) return { path: relOf(abs), binary: true, size: st.size };
  return { path: relOf(abs), content: buf.toString('utf8'), size: st.size };
}

// fs.grep — 프로젝트 폴더(path) 아래 텍스트 파일에서 리터럴(대소문자 무시) 검색.
//  결과 path 는 검색 루트(path) 기준 상대경로 → IDE 트리 키와 동일해 바로 openFile 가능.
const GREP_MAX_RESULTS = 300;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_MAX_SCAN_FILES = 5000;
async function grep(params) {
  const baseRel = (params?.path || '').replace(/^\/+|\/+$/g, '');
  const q = String(params?.query || '');
  if (!q.trim()) return { matches: [], truncated: false };
  const rootAbs = safeResolve(baseRel);
  const st = await fsp.stat(rootAbs);
  if (!st.isDirectory()) throw new Error('폴더가 아닙니다.');
  const relToRoot = (abs) => path.relative(rootAbs, abs).split(path.sep).join('/');
  const lowerQ = q.toLowerCase();
  const matches = [];
  let truncated = false;
  let scanned = 0;
  const walk = async (absDir, depth) => {
    if (truncated || depth > TREE_MAX_DEPTH) return;
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith('.') && !isShownDotfile(e.name)) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) { if (HIDDEN_DIRS.has(e.name)) continue; await walk(abs, depth + 1); continue; }
      if (!isTextFile(e.name)) continue;
      if (++scanned > GREP_MAX_SCAN_FILES) { truncated = true; return; }
      let st2; try { st2 = await fsp.stat(abs); } catch (_) { continue; }
      if (st2.size > GREP_MAX_FILE_BYTES) continue;
      let text; try { text = await fsp.readFile(abs, 'utf8'); } catch (_) { continue; }
      if (text.indexOf('\0') >= 0) continue; // 바이너리
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(lowerQ);
        if (idx < 0) continue;
        matches.push({ path: relToRoot(abs), line: i + 1, col: idx + 1, text: lines[i].slice(0, 300) });
        if (matches.length >= GREP_MAX_RESULTS) { truncated = true; return; }
      }
    }
  };
  await walk(rootAbs, 0);
  return { matches, truncated };
}

// fs.write — 텍스트 저장(존재하는 파일만 P1; 신규 생성은 P1 후반/워크스페이스에서).
async function write(params) {
  const abs = safeResolve(params?.path || '');
  if (typeof params?.content !== 'string') throw new Error('content 가 필요합니다.');
  await fsp.writeFile(abs, params.content, 'utf8');
  const st = await fsp.stat(abs);
  return { path: relOf(abs), size: st.size };
}

// fs.mkdir — 디렉토리 생성(중간 경로 포함).
async function mkdir(params) {
  const abs = safeResolve(params?.path || '');
  await fsp.mkdir(abs, { recursive: true });
  return { path: relOf(abs) };
}

// fs.createFile — 빈 파일 생성(이미 있으면 유지). 부모 디렉토리 자동 생성.
async function createFile(params) {
  const abs = safeResolve(params?.path || '');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const fh = await fsp.open(abs, 'a'); // 없으면 생성, 있으면 그대로
  await fh.close();
  return { path: relOf(abs) };
}

// fs.rename — 이름 변경/이동(둘 다 jail 검증).
async function rename(params) {
  const from = safeResolve(params?.path || '');
  const to = safeResolve(params?.dest || '');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { path: relOf(to) };
}

// fs.delete — 파일/디렉토리 삭제(재귀).
async function remove(params) {
  const abs = safeResolve(params?.path || '');
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: relOf(abs), deleted: true };
}

// ── 파일 감시(watch) ──
// 앱이 현재 보고 있는 워크스페이스 루트 하나를 감시(단일 watcher). 새 watch 오면 이전 것 close.
//  claude/터미널/다른 기기 IDE 등 어떤 경로로든 파일이 바뀌면 이벤트를 push → 앱이 목록/에디터 즉시 갱신.
let watcher = null;
let watchedRel = null;

function startWatch(rel, onEvent) {
  const abs = safeResolve(rel || '');
  stopWatch();
  watchedRel = rel || '';
  // 루트 재귀(depth 12) — IDE 라이브 동기화: 하위 폴더의 열린 파일 변경도 잡는다.
  //  node_modules 등 무거운 디렉토리는 ignore 로 걸러 감시 비용을 제한.
  watcher = chokidar.watch(abs, {
    depth: 12,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: /(^|[/\\])(node_modules|\.git|\.next|dist|build|out|coverage|\.cache|\.venv|venv|__pycache__|\.DS_Store)([/\\]|$)/,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const emit = (event) => (p) => { try { onEvent({ event, path: relOf(p) }); } catch (_) { /* noop */ } };
  watcher
    .on('add', emit('add')).on('change', emit('change')).on('unlink', emit('unlink'))
    .on('addDir', emit('addDir')).on('unlinkDir', emit('unlinkDir'));
  return { watched: watchedRel };
}

function stopWatch() {
  if (watcher) { try { watcher.close(); } catch (_) { /* noop */ } watcher = null; watchedRel = null; }
}

async function handle(method, params) {
  switch (method) {
    case 'fs.list': return list(params);
    case 'fs.tree': return tree(params);
    case 'fs.read': return read(params);
    case 'fs.write': return write(params);
    case 'fs.grep': return grep(params);
    case 'fs.mkdir': return mkdir(params);
    case 'fs.createFile': return createFile(params);
    case 'fs.rename': return rename(params);
    case 'fs.delete': return remove(params);
    default: throw new Error('알 수 없는 메서드: ' + method);
  }
}

module.exports = { handle, startWatch, stopWatch, rootDir, safeResolve, relOf };
