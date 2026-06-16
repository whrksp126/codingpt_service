const s3Service = require('./s3Service');

// 모바일 IDE 프로젝트 소스 — objectstore `codingpt/execute/ide/<projectId>/` 에 보관.
// 학습자 앱이 파일 트리 + 텍스트 파일 내용을 한 번에 받아 에디터/탐색기에 표시한다.
// 텍스트 파일은 content 포함, 이미지/폰트 등 바이너리는 path 만 (프리뷰 세션이 objectstore에서 직접 서빙).

// 에디터에서 텍스트로 열 수 있는 확장자
const TEXT_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'xml', 'svg',
  'py', 'java', 'ts', 'tsx', 'jsx', 'c', 'cpp', 'h', 'hpp', 'sql', 'yml', 'yaml',
]);

const EXT_TO_LANG = {
  html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', java: 'java',
  json: 'json', md: 'markdown', xml: 'xml', svg: 'xml', sql: 'sql', yml: 'yaml', yaml: 'yaml',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
};

const extOf = (p) => (String(p).split('.').pop() || '').toLowerCase();
const langOf = (p) => EXT_TO_LANG[extOf(p)] || 'plaintext';

// projectId 경로 탐색 공격 방지 — 안전 문자만 허용
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

// s3Service.listFiles 가 돌려주는 중첩 트리를 평탄화 → 파일 노드만 반환
const flattenTree = (nodes, acc = []) => {
  for (const n of nodes || []) {
    if (n.type === 'directory') flattenTree(n.files || [], acc);
    else acc.push(n);
  }
  return acc;
};

/**
 * IDE 프로젝트 소스 조회
 * @param {string} projectId
 * @returns {Promise<{ projectId, files: Array<{path,language,content}>, assets: Array<{path,size}> }>}
 */
// userId → 안전 문자만 (경로 주입 방지). 빈 문자열이면 워크스페이스 미적용.
const safeUid = (userId) => (userId == null ? '' : String(userId).replace(/[^A-Za-z0-9_-]/g, ''));

// 사용자별 워크스페이스 경로. s3Service 가 codingpt/execute/ prefix 를 붙이므로
// 실제 저장 위치는 codingpt/execute/workspace/<userId>/<projectId>/.
// (계획서의 사용자별 격리 의도 — s3Service prefix/allowlist 규칙에 맞춰 execute 하위에 둠)
const workspaceBase = (uid, projectId) => `workspace/${uid}/${projectId}`;
// 바이브코딩 사용자 프로젝트 경로(소스가 사는 곳) — project.json 존재로 판별.
const vibeBasePath = (uid, projectId) => `workspace/${uid}/projects/${projectId}`;
async function isVibeProject(uid, projectId) {
  if (!uid) return false;
  const r = await s3Service.getFileContent(`${vibeBasePath(uid, projectId)}/project.json`);
  return !!r.success;
}

// 한 objectstore base 에서 텍스트 파일(+선택적 에셋) 로드. 실패해도 throw 안 함(ok=false 반환).
async function loadBase(basePath, fullBase, { textOnly = false } = {}) {
  const listed = await s3Service.listFiles(basePath, true);
  if (!listed.success) return { ok: false, error: listed.error, message: listed.message, files: [], assets: [] };

  const fileNodes = flattenTree(listed.files);
  const files = [];
  const assets = [];
  for (const node of fileNodes) {
    const fullKey = node.path; // 예: codingpt/execute/ide/<id>/index.html
    const rel = fullKey.startsWith(fullBase) ? fullKey.slice(fullBase.length) : node.name;
    if (!rel || rel === '.gitkeep' || rel.endsWith('/.gitkeep')) continue; // 빈 폴더 보존용 — 숨김

    if (TEXT_EXTS.has(extOf(rel))) {
      const res = await s3Service.getFileContent(fullKey);
      if (res.success) {
        let content = res.content;
        if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
        files.push({ path: rel, language: langOf(rel), content });
      }
    } else if (!textOnly) {
      assets.push({ path: rel, size: node.size || 0 });
    }
  }
  return { ok: true, files, assets };
}

/**
 * IDE 프로젝트 소스 조회 — 공용 템플릿(관리자 등록 원본) 위에 사용자별 편집을 오버레이.
 * 첫 진입(저장 이력 없음)이면 템플릿 그대로. 저장 후엔 내 편집만 내 워크스페이스에서 덮어씀.
 * → 저장이 다른 사용자/공용 원본에 영향 주지 않음.
 * @param {string} projectId
 * @param {string|number} [userId]
 */
async function getProject(projectId, userId) {
  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    const e = new Error('유효하지 않은 projectId 입니다.');
    e.statusCode = 400;
    throw e;
  }
  const uid = safeUid(userId);

  // 1) 바이브 프로젝트(사용자가 만든 워크스페이스) — projects/<id> 가 소스+저장+에셋의 단일 위치.
  //    저장(saveProject)/에셋(getAsset) 과 동일 기준(project.json 존재)으로 판별해 경로 불일치 방지.
  if (uid && await isVibeProject(uid, projectId)) {
    const vibeBase = vibeBasePath(uid, projectId);
    const vibe = await loadBase(vibeBase, `codingpt/execute/${vibeBase}/`); // 에셋 포함
    // project.json(메타) + sessions/(세션 영속 파일)은 IDE 소스가 아니므로 제외.
    //  · sessions/ 노출 시 저장(saveProject)에서 세션 파일을 덮어써 손상시킬 위험도 있음.
    const hidden = (p) => p === 'project.json' || p.startsWith('sessions/');
    const files = (vibe.files || [])
      .filter((f) => !hidden(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    const assets = (vibe.assets || [])
      .filter((a) => !hidden(a.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { projectId, files, assets };
  }

  // 2) 템플릿 기반(관리자 등록 레슨 IDE) = 베이스(파일+에셋)
  const template = await loadBase(`ide/${projectId}`, `codingpt/execute/ide/${projectId}/`);
  if (!template.ok) {
    if (template.error === 'NoSuchBucket' || template.error === 'AccessDenied') {
      const e = new Error(template.message || '프로젝트 파일 목록을 불러올 수 없습니다.');
      e.statusCode = 500;
      throw e;
    }
    const e = new Error('프로젝트를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }

  // 3) 사용자 워크스페이스(저장된 내 편집/새 파일/가져온 에셋) 오버레이 — 에셋 포함.
  let userFiles = [];
  let userAssets = [];
  if (uid) {
    const base = workspaceBase(uid, projectId);
    const ws = await loadBase(base, `codingpt/execute/${base}/`);
    if (ws.ok) { userFiles = ws.files; userAssets = ws.assets; }
  }

  // 4) 병합: 템플릿 + 내 편집/신규(덮어쓰기/추가). 에셋도 템플릿+내 가져오기 합집합.
  const map = new Map();
  for (const f of template.files) map.set(f.path, f);
  for (const f of userFiles) map.set(f.path, f);
  const files = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  const amap = new Map();
  for (const a of template.assets) amap.set(a.path, a);
  for (const a of userAssets) amap.set(a.path, a);
  const assets = [...amap.values()].sort((a, b) => a.path.localeCompare(b.path));

  return { projectId, files, assets };
}

/**
 * IDE 프로젝트의 바이너리 에셋(이미지 등) 바이트 조회 — 모바일 이미지 프리뷰용.
 * execute/ide 는 비공개 prefix 라 공개 URL 로 못 여므로 백엔드가 중계한다.
 * @param {string} projectId
 * @param {string} relPath - projectId 기준 상대경로
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function getAsset(projectId, relPath, userId) {
  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    const e = new Error('유효하지 않은 projectId 입니다.');
    e.statusCode = 400;
    throw e;
  }
  const rel = String(relPath || '').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) {
    const e = new Error('유효하지 않은 path 입니다.');
    e.statusCode = 400;
    throw e;
  }

  // 사용자가 가져온 에셋(내 워크스페이스/바이브) 우선, 없으면 공용 템플릿(ide/<id>) fallback.
  // s3Service 가 codingpt/execute/ prefix 를 붙임.
  const uid = safeUid(userId);
  const candidates = [];
  if (uid) {
    candidates.push((await isVibeProject(uid, projectId)) ? vibeBasePath(uid, projectId) : workspaceBase(uid, projectId));
  }
  candidates.push(`ide/${projectId}`);
  let res = { success: false, error: 'NoSuchKey' };
  for (const kb of candidates) {
    res = await s3Service.getFileContent(`${kb}/${rel}`);
    if (res.success) break;
  }
  if (!res.success) {
    const e = new Error(res.message || '에셋을 불러올 수 없습니다.');
    e.statusCode = res.error === 'NoSuchKey' ? 404 : 500;
    throw e;
  }

  const buffer = res.encoding === 'base64'
    ? Buffer.from(res.content, 'base64')
    : Buffer.from(res.content, 'utf-8');
  return { buffer, contentType: res.contentType || 'application/octet-stream' };
}

/**
 * IDE 프로젝트 저장 — 현재 텍스트 파일들을 사용자별 워크스페이스에 영속화.
 * 저장 위치: codingpt/execute/workspace/<userId>/<projectId>/ (공용 템플릿/타 사용자와 격리).
 * (추가/덮어쓰기 방식 — 파일 삭제 동기화는 v1 범위 밖. 바이너리 에셋은 앱이 안 보냄.)
 * @param {string} projectId
 * @param {string|number} userId
 * @param {Array<{path:string, content:string}>} files
 * @returns {Promise<{ projectId, saved: number, failed: Array<{path,message}> }>}
 */
async function saveProject(projectId, userId, files) {
  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    const e = new Error('유효하지 않은 projectId 입니다.');
    e.statusCode = 400;
    throw e;
  }
  const uid = safeUid(userId);
  if (!uid) {
    const e = new Error('인증이 필요합니다.');
    e.statusCode = 401;
    throw e;
  }
  if (!Array.isArray(files) || files.length === 0) {
    const e = new Error('저장할 파일이 없습니다.');
    e.statusCode = 400;
    throw e;
  }

  // 바이브 프로젝트는 소스가 projects/<id> 에 있으므로 저장도 거기로(읽기 경로와 일치).
  const base = (await isVibeProject(uid, projectId)) ? vibeBasePath(uid, projectId) : workspaceBase(uid, projectId);
  let saved = 0;
  const failed = [];
  for (const f of files) {
    const rel = String((f && f.path) || '').replace(/^\/+/, '');
    // 경로 탐색 방어
    if (!rel || rel.includes('..') || rel.endsWith('/')) {
      failed.push({ path: rel, message: '잘못된 경로' });
      continue;
    }
    // 메타/세션 파일은 IDE 저장 대상 아님 — 덮어써 손상 방지.
    if (rel === 'project.json' || rel.startsWith('sessions/')) {
      failed.push({ path: rel, message: '보호된 경로' });
      continue;
    }
    // 텍스트 확장자거나, 외부 파일 가져오기(base64 바이너리)면 저장.
    // s3Service.saveFile 은 비텍스트 확장자(이미지/PDF 등)면 content 를 base64 로 디코딩해 저장한다.
    const isBinaryImport = !!(f && f.base64);
    if (!isBinaryImport && !TEXT_EXTS.has(extOf(rel))) {
      failed.push({ path: rel, message: '텍스트 파일만 저장됩니다.' });
      continue;
    }
    const res = await s3Service.saveFile(`${base}/${rel}`, f.content == null ? '' : String(f.content));
    if (res.success) saved++;
    else failed.push({ path: rel, message: res.message || '저장 실패' });
  }

  return { projectId, saved, failed };
}

module.exports = { getProject, getAsset, saveProject };
