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
//  timeout: clone 처럼 네트워크 fetch 가 있는 명령은 넉넉히(기본 15s).
function runGit(args, cwd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
      // git 미설치/실패해도 스캐폴드 자체는 성공으로 본다(폴더+파일은 만들어짐).
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

// GitHub clone URL 검증 — https + github.com 호스트만 허용(SSRF/내부주소 clone 방지).
//  execFile 이라 셸 인젝션은 원천 없지만, 임의 URL clone 은 막는다. 반환: 정규화된 https URL.
function normalizeGithubUrl(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch (_) { throw new Error('올바른 GitHub 저장소 주소가 아닙니다.'); }
  if (u.protocol !== 'https:') throw new Error('https 주소만 지원합니다.');
  if (u.hostname.toLowerCase() !== 'github.com') throw new Error('github.com 저장소만 열 수 있습니다.');
  // 경로는 /<owner>/<repo>(.git)? 형태여야 한다.
  const m = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
  if (m.length !== 2 || !m[0] || !m[1]) throw new Error('저장소 경로가 올바르지 않습니다.');
  const owner = m[0];
  const repo = m[1];
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('저장소 경로에 허용되지 않은 문자가 있습니다.');
  }
  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
}

// 현재 지정된 워크스페이스 루트(홈-기준 상대). 없거나 더 이상 폴더가 아니면 null.
//  recommended: 권장 기본 루트(TCC 프롬프트 없는 위치) — 앱이 "추천 위치 원탭"으로 사용.
async function getRoot() {
  const cfg = configLib.load() || {};
  const rel = cfg.workspaceRoot;
  // recommended=TCC 프롬프트 없는 추천 위치, lastParent=마지막 선택 부모(피커 기본값),
  //  allowFullDisk=전체 디스크 모드 여부(피커가 홈 밖 탐색 허용 판단).
  const base = {
    recommended: DEFAULT_ROOT_REL,
    lastParent: (typeof cfg.lastWorkspaceParent === 'string' ? cfg.lastWorkspaceParent : null),
    allowFullDisk: cfg.allowFullDisk === true,
  };
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

// 선택한 부모 폴더 아래 새 워크스페이스 폴더 스캐폴드. name → slug, 충돌 시 -2/-3 …
//  destParent(params.parentPath): 사용자가 이번 생성마다 고르는 목적지 폴더(홈-기준 상대,
//  또는 전체 디스크 모드면 절대경로). 미지정이면 마지막 사용 위치 → (구)영구 루트 순으로 폴백.
async function create(params) {
  const cfg = configLib.load() || {};
  // 지정(designate) 모드 — 선택한 폴더 "자체"를 워크스페이스로 사용. 하위폴더 생성/스캐폴드 안 함.
  //  name 은 폴더명(basename). 사용자가 "PC 폴더를 워크스페이스로 지정"하는 기본 흐름.
  if (params && typeof params.path === 'string') {
    const abs = fsLib.safeResolve(params.path);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error('선택한 폴더가 존재하지 않습니다. 다시 선택해 주세요.');
    const rel = fsLib.relOf(abs);
    const nm = (params.name && String(params.name).trim()) || path.basename(abs) || '워크스페이스';
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    configLib.save({ ...cfg, lastWorkspaceParent: parentRel });
    return { path: rel, name: nm, slug: slugify(nm), gitInit: false, designated: true };
  }
  // (레거시) 부모+이름으로 하위폴더 스캐폴드.
  const name = (params && params.name) || '';
  // parentPath 가 문자열이면(빈문자열='홈' 포함) 그대로, 미지정이면 마지막 선택 → (구)루트 폴백.
  const parentRel = (params && typeof params.parentPath === 'string')
    ? params.parentPath
    : (cfg.lastWorkspaceParent || cfg.workspaceRoot || '');
  const rootAbs = fsLib.safeResolve(parentRel);
  const rootSt = await fsp.stat(rootAbs).catch(() => null);
  if (!rootSt || !rootSt.isDirectory()) throw new Error('선택한 폴더가 존재하지 않습니다. 다시 선택해 주세요.');

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

  // 다음 생성 시 기본값으로 쓰도록 마지막 선택 부모를 기억.
  configLib.save({ ...cfg, lastWorkspaceParent: fsLib.relOf(rootAbs) });

  return { path: fsLib.relOf(dirAbs), name: name || slug, slug, gitInit: git.ok };
}

// GitHub 레포를 선택한 부모 폴더 아래로 clone. destParent(params.parentPath)를 사용자가 매번 고른다.
//  compute:'local' 워크스페이스로 등록될 폴더를 결정적으로 만든다. AI 자격증명 무접촉(순수 git clone).
async function clone(params) {
  const { url, owner, repo } = normalizeGithubUrl(params && params.url);

  // 목적지 부모 — 사용자 선택(parentPath, 빈문자열='홈'). 미지정이면 마지막 선택 → (구)루트 폴백.
  //  ~/CodingPT 자동 생성은 하지 않는다(사용자가 위치를 명시적으로 고르는 모델).
  const cfg = configLib.load() || {};
  const parentRel = (params && typeof params.parentPath === 'string')
    ? params.parentPath
    : (cfg.lastWorkspaceParent || cfg.workspaceRoot || '');
  const rootAbs = fsLib.safeResolve(parentRel);
  const rootSt = await fsp.stat(rootAbs).catch(() => null);
  if (!rootSt || !rootSt.isDirectory()) throw new Error('선택한 폴더가 존재하지 않습니다. 다시 선택해 주세요.');

  // 폴더 이름 — 사용자 지정 name 우선, 없으면 레포명. 충돌 시 -2/-3 …
  const base = slugify((params && params.name) || repo);
  let slug = base;
  let n = 2;
  while (fs.existsSync(path.join(rootAbs, slug))) { slug = `${base}-${n}`; n += 1; }
  const dirAbs = fsLib.safeResolve(path.join(fsLib.relOf(rootAbs), slug)); // jail 재검증

  // git clone <url> <dir> — 네트워크 fetch라 넉넉한 타임아웃(120s). execFile 이라 셸 인젝션 없음.
  const git = await runGit(['clone', url, dirAbs], rootAbs, 120000);
  if (!git.ok) {
    // 실패 시 부분 생성된 폴더 정리(있으면).
    await fsp.rm(dirAbs, { recursive: true, force: true }).catch(() => {});
    throw new Error(git.err ? `clone 실패: ${git.err.split('\n').slice(-3).join(' ').trim()}` : 'clone 에 실패했습니다.');
  }

  // 다음 생성/클론 시 기본값으로 쓰도록 마지막 선택 부모를 기억.
  configLib.save({ ...cfg, lastWorkspaceParent: fsLib.relOf(rootAbs) });

  return { path: fsLib.relOf(dirAbs), name: (params && params.name) || repo, slug, owner, repo };
}

// 전체 디스크 접근 토글 저장(설정에서 켜고 끔). 실제 무프롬프트 접근은 사용자가 데몬에 macOS
//  전체 디스크 접근(FDA)을 부여해야 완성됨(앱이 안내). 이 플래그는 fs.js safeResolve 의 jail 을 완화.
async function setFullDisk(params) {
  const enabled = !!(params && params.enabled);
  const cfg = configLib.load() || {};
  configLib.save({ ...cfg, allowFullDisk: enabled });
  return { allowFullDisk: enabled };
}

async function handle(method, params) {
  switch (method) {
    case 'ws.getRoot': return getRoot();
    case 'ws.setRoot': return setRoot(params);
    case 'ws.useDefaultRoot': return useDefaultRoot();
    case 'ws.setFullDisk': return setFullDisk(params);
    case 'ws.create': return create(params);
    case 'ws.clone': return clone(params);
    default: throw new Error('알 수 없는 메서드: ' + method);
  }
}

module.exports = { handle, getRoot, setRoot, useDefaultRoot, setFullDisk, create, clone, slugify, DEFAULT_ROOT_REL };
