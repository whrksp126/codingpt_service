/**
 * 파일시스템 RPC — 제어 채널의 {type:'rpc', method:'fs.*'} 처리
 *
 * 보안(필수): allowlist 루트(기본 홈 디렉토리) 밖은 절대 접근 불가.
 *  - 모든 경로는 루트 기준 상대경로로 받고, resolve 후 realpath 로 심링크 탈출까지 차단.
 *  - 기본 deny: 루트를 벗어나면 에러.
 * P1 MVP 는 단일 루트(홈). P3 에서 워크스페이스별 다중 allowlist 로 확장.
 */
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');

const ROOT = os.homedir();

// 목록에서 숨기고 순회도 막을 디렉토리(성능/노이즈/보안).
const HIDDEN_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.venv', '__pycache__',
  'Library', 'Applications', '.Trash', '.npm', '.cargo', '.rustup', 'go',
]);
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB 초과 텍스트는 편집 대상에서 제외
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
  const abs = path.resolve(ROOT, rel || '.');
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
  return path.relative(ROOT, abs).split(path.sep).join('/');
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
async function read(params) {
  const abs = safeResolve(params?.path || '');
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('디렉토리는 열 수 없습니다.');
  if (st.size > MAX_READ_BYTES) return { path: relOf(abs), tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  // NUL 바이트가 있으면 바이너리로 간주.
  if (buf.includes(0)) return { path: relOf(abs), binary: true, size: st.size };
  return { path: relOf(abs), content: buf.toString('utf8'), size: st.size };
}

// fs.write — 텍스트 저장(존재하는 파일만 P1; 신규 생성은 P1 후반/워크스페이스에서).
async function write(params) {
  const abs = safeResolve(params?.path || '');
  if (typeof params?.content !== 'string') throw new Error('content 가 필요합니다.');
  await fsp.writeFile(abs, params.content, 'utf8');
  const st = await fsp.stat(abs);
  return { path: relOf(abs), size: st.size };
}

// ── 파일 감시(watch) ──
// 앱이 현재 보고 있는 디렉토리 하나만 감시(단일 watcher). 새 watch 오면 이전 것 close.
//  claude 등 외부 프로세스가 PC 파일을 수정하면 이벤트를 push → 앱이 목록/에디터 즉시 갱신.
let watcher = null;
let watchedRel = null;

function startWatch(rel, onEvent) {
  const abs = safeResolve(rel || '');
  stopWatch();
  watchedRel = rel || '';
  // depth:1 — 현재 디렉토리 + 직속 항목(파일 편집은 cwd 안이므로 커버). 무거운 디렉토리 무시.
  watcher = chokidar.watch(abs, {
    depth: 1,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ignored: /(^|[/\\])(node_modules|\.git|\.next|dist|build|\.cache|__pycache__)([/\\]|$)/,
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
    default: throw new Error('알 수 없는 메서드: ' + method);
  }
}

module.exports = { handle, startWatch, stopWatch, ROOT, safeResolve, relOf };
