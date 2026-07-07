/**
 * 워크스페이스 RPC — 제어 채널의 {type:'rpc', method:'ws.*'} 처리
 *
 * 목적: 사용자 PC 에 "워크스페이스(프로젝트 폴더)"를 결정적으로 스캐폴드한다.
 *  · ws.getRoot          : 지정된 워크스페이스 루트(홈-기준 상대경로) 반환. 미지정이면 null.
 *  · ws.setRoot {path}   : 워크스페이스 루트를 최초 1회(또는 변경) 지정. 존재하는 디렉토리만.
 *  · ws.create {name}    : 루트 아래 <slug> 폴더 생성 + git init + 최소 템플릿(README/.gitignore).
 *
 * 보안/경계: 모든 경로는 fs.js 의 홈 jail(safeResolve) 안. AI 자격증명 무접촉(순수 파일 + git init).
 *  git 은 시스템 git 을 child_process 로 호출(라이브러리 미도입 — 데몬 의존성 최소 원칙).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const fsLib = require('./fs');
const configLib = require('./config');

// 권장 워크스페이스 루트(홈-기준 상대). 홈 바로 아래라 macOS TCC 보호폴더가 아님 → 접근 프롬프트가 안 뜬다.
const DEFAULT_ROOT_REL = 'CodingPT/workspaces';
// macOS TCC 보호폴더(홈-기준 상대, 소문자) — 여기로 루트를 잡으면 접근 프롬프트가 뜰 수 있어 경고한다.
const PROTECTED_REL = ['desktop', 'documents', 'downloads', 'movies', 'music', 'pictures', 'library'];
function isProtectedRel(rel) {
  const first = String(rel || '').split('/')[0].toLowerCase();
  return PROTECTED_REL.includes(first);
}

// name → 안전한 폴더 slug. 한글/영숫자 유지, 공백→'-', 그 외 제거, 소문자화(라틴).
function slugify(name) {
  let s = String(name || '').trim();
  s = s.replace(/[^가-힣a-zA-Z0-9\s_-]/g, ''); // 한글/영숫자/공백/_/-
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'workspace';
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/g, '');
  return s;
}

// git 시스템 명령 실행(절대 바이너리 탐색 대신 PATH 의 git, timeout 가드).
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      // git 미설치/실패해도 스캐폴드 자체는 성공으로 본다(폴더+파일은 만들어짐).
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

// 현재 지정된 워크스페이스 루트(홈-기준 상대). 없거나 더 이상 폴더가 아니면 null.
//  recommended: 권장 기본 루트(TCC 프롬프트 없는 위치) — 앱이 "추천 위치 원탭"으로 사용.
async function getRoot() {
  const cfg = configLib.load() || {};
  const rel = cfg.workspaceRoot;
  const base = { recommended: DEFAULT_ROOT_REL };
  if (typeof rel !== 'string') return { root: null, ...base };
  try {
    const abs = fsLib.safeResolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return { root: null, ...base };
    return { root: fsLib.relOf(abs), protected: isProtectedRel(rel), ...base };
  } catch (_) { return { root: null, ...base }; }
}

// 워크스페이스 루트 지정. path 는 홈-기준 상대경로. create=true 면 없을 때 생성(추천 위치용).
async function setRoot(params) {
  const rel = (params && params.path) || '';
  const abs = fsLib.safeResolve(rel); // 홈 밖이면 throw
  let st = await fsp.stat(abs).catch(() => null);
  if (!st && params && params.create) { await fsp.mkdir(abs, { recursive: true }); st = await fsp.stat(abs).catch(() => null); }
  if (!st || !st.isDirectory()) throw new Error('존재하는 폴더를 선택해 주세요.');
  const root = fsLib.relOf(abs);
  const cfg = configLib.load() || {};
  configLib.save({ ...cfg, workspaceRoot: root });
  return { root, protected: isProtectedRel(root) };
}

// 권장 기본 루트(~/CodingPT/workspaces)를 생성하고 루트로 지정 — TCC 프롬프트 없는 위치.
async function useDefaultRoot() {
  return setRoot({ path: DEFAULT_ROOT_REL, create: true });
}

// 루트 아래 새 워크스페이스 폴더 스캐폴드. name → slug, 충돌 시 -2/-3 …
async function create(params) {
  const name = (params && params.name) || '';
  const cfg = configLib.load() || {};
  if (typeof cfg.workspaceRoot !== 'string') throw new Error('먼저 워크스페이스 루트를 지정해 주세요.');
  const rootAbs = fsLib.safeResolve(cfg.workspaceRoot);
  const rootSt = await fsp.stat(rootAbs).catch(() => null);
  if (!rootSt || !rootSt.isDirectory()) throw new Error('워크스페이스 루트 폴더가 없습니다. 다시 지정해 주세요.');

  const base = slugify(name);
  let slug = base;
  let n = 2;
  // 충돌 방지 — 이미 있으면 -2, -3 …
  while (fs.existsSync(path.join(rootAbs, slug))) { slug = `${base}-${n}`; n += 1; }
  const dirAbs = fsLib.safeResolve(path.join(fsLib.relOf(rootAbs), slug)); // jail 재검증
  await fsp.mkdir(dirAbs, { recursive: true });

  // 최소 템플릿 — 사용자가 자기 claude 로 이어서 작업할 빈 스캐폴드.
  const readme = `# ${name || slug}\n\nCodingPT 워크스페이스입니다.\n`;
  const gitignore = 'node_modules/\ndist/\nbuild/\n.next/\n.env\n.env.*\n.DS_Store\n';
  await fsp.writeFile(path.join(dirAbs, 'README.md'), readme, 'utf8');
  await fsp.writeFile(path.join(dirAbs, '.gitignore'), gitignore, 'utf8');

  // git init(실패해도 폴더/파일은 유지 — git 미설치 환경 허용).
  const git = await runGit(['init'], dirAbs);

  return { path: fsLib.relOf(dirAbs), name: name || slug, slug, gitInit: git.ok };
}

async function handle(method, params) {
  switch (method) {
    case 'ws.getRoot': return getRoot();
    case 'ws.setRoot': return setRoot(params);
    case 'ws.useDefaultRoot': return useDefaultRoot();
    case 'ws.create': return create(params);
    default: throw new Error('알 수 없는 메서드: ' + method);
  }
}

module.exports = { handle, getRoot, setRoot, useDefaultRoot, create, slugify, DEFAULT_ROOT_REL };
