const crypto = require('crypto');
const s3Service = require('./s3Service');

// 바이브코딩 사용자 워크스페이스 — objectstore 가상 워크스페이스 기반.
// 저장 위치: codingpt/execute/workspace/<userId>/projects/<workspaceId>/
//   (s3Service 가 codingpt/execute/ prefix 를 자동으로 붙이므로 여기선 workspace/.. 부터 다룬다)
//   ※ 내부 저장 세그먼트(projects/, workspace.json 이전의 project.json)는 호환을 위해 그대로 둔다.
//      사용자/코드/ API 상의 표현만 "워크스페이스"로 통일한다(마이그레이션 불필요).
// 각 워크스페이스 폴더 안에 메타데이터 project.json + 실제 코드 파일들 + sessions/ 가 들어간다.
// DB 없이 objectstore 만으로 관리한다(단일/소수 사용자 전제, 메타는 작은 json).

// 경로 주입 방지 — userId/workspaceId 모두 안전 문자만 허용
const safeUid = (userId) => (userId == null ? '' : String(userId).replace(/[^A-Za-z0-9_-]/g, ''));
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]+$/;

const workspacesBase = (uid) => `workspace/${uid}/projects`;
const workspaceDir = (uid, id) => `workspace/${uid}/projects/${id}`;
const metaKey = (uid, id) => `${workspaceDir(uid, id)}/project.json`;

// s3Service.listFiles 중첩 트리 평탄화 → 파일 노드만
const flattenTree = (nodes, acc = []) => {
  for (const n of nodes || []) {
    if (n.type === 'directory') flattenTree(n.files || [], acc);
    else acc.push(n);
  }
  return acc;
};

// 짧고 충돌 없는 워크스페이스 id (경로 안전 문자만). 이름은 메타에 별도 저장(한글 허용).
function genId() {
  return `p-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function requireUid(userId) {
  const uid = safeUid(userId);
  if (!uid) {
    const e = new Error('인증이 필요합니다.');
    e.statusCode = 401;
    throw e;
  }
  return uid;
}

function assertWorkspaceId(id) {
  if (!id || !WORKSPACE_ID_RE.test(id)) {
    const e = new Error('유효하지 않은 workspaceId 입니다.');
    e.statusCode = 400;
    throw e;
  }
}

// 메타 정규화 — 누락 필드 기본값 채움(과거/손상 데이터 방어)
function normalizeMeta(raw, id) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    id: m.id || id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name : (m.id || id),
    description: typeof m.description === 'string' ? m.description : '',
    stack: Array.isArray(m.stack) ? m.stack.filter((s) => typeof s === 'string') : [],
    thumb: ['list', 'page', 'chart'].includes(m.thumb) ? m.thumb : 'list',
    // 워크스페이스 종류: 'chat'(일반 채팅 전용) | 'project'(바이브코딩). 누락=과거 데이터→'project'.
    kind: m.kind === 'chat' ? 'chat' : 'project',
    unread: Number.isInteger(m.unread) ? m.unread : 0,
    createdAt: m.createdAt || null,
    updatedAt: m.updatedAt || m.createdAt || null,
  };
}

async function readMeta(uid, id) {
  const res = await s3Service.getFileContent(metaKey(uid, id));
  if (!res.success) return null;
  let content = res.content;
  if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
  try {
    return normalizeMeta(JSON.parse(content), id);
  } catch (_) {
    return normalizeMeta(null, id);
  }
}

async function writeMeta(uid, id, meta) {
  const res = await s3Service.saveFile(metaKey(uid, id), JSON.stringify(meta, null, 2));
  if (!res.success) {
    const e = new Error(res.message || '워크스페이스 정보를 저장할 수 없습니다.');
    e.statusCode = 500;
    throw e;
  }
  return meta;
}

/**
 * 사용자 워크스페이스 목록 — projects/ 하위 각 폴더의 project.json 을 읽어 메타 배열로.
 * @param {string|number} userId
 * @returns {Promise<Array>} 최신 수정순 정렬
 */
async function listWorkspaces(userId) {
  const uid = requireUid(userId);
  const listed = await s3Service.listFiles(workspacesBase(uid), true);
  // 폴더가 아예 없으면(첫 사용자) 빈 목록
  if (!listed.success) {
    if (listed.error === 'NoSuchBucket' || listed.error === 'AccessDenied') {
      const e = new Error(listed.message || '워크스페이스 목록을 불러올 수 없습니다.');
      e.statusCode = 500;
      throw e;
    }
    return [];
  }

  const fileNodes = flattenTree(listed.files);
  // 각 워크스페이스 폴더의 project.json 만 추림 → id 추출
  const ids = [];
  for (const node of fileNodes) {
    const key = node.path || '';
    const m = key.match(/\/projects\/([A-Za-z0-9_-]+)\/project\.json$/);
    if (m) ids.push(m[1]);
  }

  const metas = [];
  for (const id of ids) {
    const meta = await readMeta(uid, id);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return metas;
}

/**
 * 워크스페이스 생성 — 폴더(project.json) 생성. 실제 코드 파일은 이후 에이전트/저장으로 채워진다.
 * @param {string|number} userId
 * @param {{name?:string, description?:string, stack?:string[], thumb?:string}} input
 */
async function createWorkspace(userId, input = {}) {
  const uid = requireUid(userId);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '새 워크스페이스';
  const id = genId();
  const now = new Date().toISOString();
  const meta = normalizeMeta(
    {
      id,
      name,
      description: input.description,
      stack: input.stack,
      thumb: input.thumb,
      kind: input.kind,
      unread: 0,
      createdAt: now,
      updatedAt: now,
    },
    id,
  );
  await writeMeta(uid, id, meta);
  return meta;
}

/** 단일 워크스페이스 메타 조회 */
async function getWorkspace(userId, id) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const meta = await readMeta(uid, id);
  if (!meta) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  return meta;
}

/** 이름 변경(+그 외 메타 패치) */
async function updateWorkspace(userId, id, patch = {}) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const current = await readMeta(uid, id);
  if (!current) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  const next = normalizeMeta(
    {
      ...current,
      ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...(typeof patch.description === 'string' ? { description: patch.description } : {}),
      ...(Array.isArray(patch.stack) ? { stack: patch.stack } : {}),
      ...(['list', 'page', 'chart'].includes(patch.thumb) ? { thumb: patch.thumb } : {}),
      ...(Number.isInteger(patch.unread) ? { unread: patch.unread } : {}),
      updatedAt: new Date().toISOString(),
    },
    id,
  );
  await writeMeta(uid, id, next);
  return next;
}

/** 워크스페이스 복제 — 폴더 전체 복사 후 메타 갱신 */
async function duplicateWorkspace(userId, id) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const src = await readMeta(uid, id);
  if (!src) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  const newId = genId();
  // 폴더 단위 복사(s3Service.copy 는 trailing slash 면 재귀 복사)
  const cp = await s3Service.copy(`${workspaceDir(uid, id)}/`, `${workspaceDir(uid, newId)}/`);
  if (!cp.success) {
    const e = new Error(cp.message || '워크스페이스 복제에 실패했습니다.');
    e.statusCode = 500;
    throw e;
  }
  const now = new Date().toISOString();
  const meta = normalizeMeta({ ...src, id: newId, name: `${src.name} (복제)`, createdAt: now, updatedAt: now }, newId);
  await writeMeta(uid, newId, meta);
  return meta;
}

/** 워크스페이스 삭제 — 폴더 내 모든 파일 제거 */
async function deleteWorkspace(userId, id) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const listed = await s3Service.listFiles(workspaceDir(uid, id), true);
  const fileNodes = listed.success ? flattenTree(listed.files) : [];
  let deleted = 0;
  for (const node of fileNodes) {
    // node.path 는 codingpt/execute/.. 풀키 — 그대로 deleteFile 에 전달(prefix 이미 포함)
    const res = await s3Service.deleteFile(node.path);
    if (res.success) deleted++;
  }
  // 폴더가 비어 메타조차 없던 경우도 성공으로 본다
  return { id, deleted };
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  duplicateWorkspace,
  deleteWorkspace,
  // 경로 헬퍼(세션/워크스페이스 연동용)
  workspaceDir,
  safeUid,
  assertWorkspaceId,
};
