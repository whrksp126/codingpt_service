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
async function getProject(projectId) {
  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    const e = new Error('유효하지 않은 projectId 입니다.');
    e.statusCode = 400;
    throw e;
  }

  const basePath = `ide/${projectId}`; // s3Service 가 codingpt/execute/ prefix 를 붙임
  const fullBase = `codingpt/execute/ide/${projectId}/`;

  const listed = await s3Service.listFiles(basePath, true);
  if (!listed.success) {
    const e = new Error(listed.message || '프로젝트 파일 목록을 불러올 수 없습니다.');
    e.statusCode = listed.error === 'NoSuchBucket' || listed.error === 'AccessDenied' ? 500 : 404;
    throw e;
  }

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
    } else {
      assets.push({ path: rel, size: node.size || 0 });
    }
  }

  // 경로 기준 정렬 (탐색기 표시 일관성)
  files.sort((a, b) => a.path.localeCompare(b.path));
  assets.sort((a, b) => a.path.localeCompare(b.path));

  return { projectId, files, assets };
}

/**
 * IDE 프로젝트의 바이너리 에셋(이미지 등) 바이트 조회 — 모바일 이미지 프리뷰용.
 * execute/ide 는 비공개 prefix 라 공개 URL 로 못 여므로 백엔드가 중계한다.
 * @param {string} projectId
 * @param {string} relPath - projectId 기준 상대경로
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function getAsset(projectId, relPath) {
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

  // s3Service 가 codingpt/execute/ prefix 를 붙임
  const res = await s3Service.getFileContent(`ide/${projectId}/${rel}`);
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
 * IDE 프로젝트 저장 — 현재 텍스트 파일들을 objectstore 에 영속화.
 * 에이전트/사용자 편집을 codingpt/execute/ide/<projectId>/ 로 되써 컨테이너 재시작에도 보존.
 * (추가/덮어쓰기 방식 — 파일 삭제 동기화는 v1 범위 밖. 바이너리 에셋은 앱이 안 보냄.)
 * @param {string} projectId
 * @param {Array<{path:string, content:string}>} files
 * @returns {Promise<{ projectId, saved: number, failed: Array<{path,message}> }>}
 */
async function saveProject(projectId, files) {
  if (!projectId || !PROJECT_ID_RE.test(projectId)) {
    const e = new Error('유효하지 않은 projectId 입니다.');
    e.statusCode = 400;
    throw e;
  }
  if (!Array.isArray(files) || files.length === 0) {
    const e = new Error('저장할 파일이 없습니다.');
    e.statusCode = 400;
    throw e;
  }

  let saved = 0;
  const failed = [];
  for (const f of files) {
    const rel = String((f && f.path) || '').replace(/^\/+/, '');
    // 경로 탐색 방어 + 텍스트 확장자만(바이너리 에셋은 별도 흐름)
    if (!rel || rel.includes('..') || rel.endsWith('/')) {
      failed.push({ path: rel, message: '잘못된 경로' });
      continue;
    }
    if (!TEXT_EXTS.has(extOf(rel))) {
      failed.push({ path: rel, message: '텍스트 파일만 저장됩니다.' });
      continue;
    }
    // s3Service 가 codingpt/execute/ prefix 를 붙임
    const res = await s3Service.saveFile(`ide/${projectId}/${rel}`, f.content == null ? '' : String(f.content));
    if (res.success) saved++;
    else failed.push({ path: rel, message: res.message || '저장 실패' });
  }

  return { projectId, saved, failed };
}

module.exports = { getProject, getAsset, saveProject };
