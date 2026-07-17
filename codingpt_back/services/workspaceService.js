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
// 워크스페이스 세션 상태(열린 터미널/IDE/프리뷰 + 레이아웃) — PC↔모바일 이어받기용.
const sessionKey = (uid, id) => `${workspaceDir(uid, id)}/session.json`;

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

// 프로젝트(그룹) id — 같은 프로젝트의 PC별 사본(워크스페이스)들을 묶는 명시적 멤버십 키.
function genProjectId() {
  return `prj-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// git remote URL 정규화 — ssh/https/포트/`.git` 차이를 흡수해 같은 저장소면 같은 키.
//  예: git@github.com:a/b.git == https://github.com/a/b → "github.com/a/b"
function normalizeRemote(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  s = s.replace(/\.git$/i, '');
  let m = s.match(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i); // scheme://[user@]host[:port]/path
  if (!m) m = s.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);                          // scp 형식 user@host:path
  if (!m) return '';
  const path = m[2].replace(/^\/+|\/+$/g, '');
  if (!path) return '';
  return `${m[1].toLowerCase()}/${path}`;
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

// 신선도(호스트 데몬 보고) 정제 — { branch, dirty, ahead, behind, upstream, at }
function sanitizeGit(g) {
  if (!g || typeof g !== 'object') return null;
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    branch: typeof g.branch === 'string' ? g.branch.slice(0, 100) : '',
    dirty: !!g.dirty, // 미커밋 변경 존재
    ahead: int(g.ahead), // 미푸시 커밋 수(업스트림 기준)
    behind: int(g.behind),
    upstream: !!g.upstream, // 업스트림 없으면 ahead/behind 무의미
    at: typeof g.at === 'string' ? g.at : new Date().toISOString(),
  };
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
    // 실행 위치: 'cloud'(샌드박스, 기본) | 'local'(사용자 PC 데몬). localPath 는 데몬 홈-기준 상대경로.
    compute: m.compute === 'local' ? 'local' : 'cloud',
    ...(m.compute === 'local' && typeof m.localPath === 'string' && m.localPath ? { localPath: m.localPath } : {}),
    // 멀티기기: 이 로컬 워크스페이스가 사는 호스트 기기(DaemonDevice.id). 목록은 전역, 열 때 이 호스트로 라우팅.
    ...(m.compute === 'local' && m.hostDeviceId != null ? { hostDeviceId: m.hostDeviceId } : {}),
    // 프로젝트 그룹핑: 같은 프로젝트(다른 PC의 사본)를 묶는 명시적 멤버십. 생성 시 1회 자동 판단
    //  (이름/remote 일치)해 저장하고, 이후엔 이 값만 본다. 없으면(과거 데이터) 단독 — 그룹키=자기 id.
    ...(typeof m.projectId === 'string' && WORKSPACE_ID_RE.test(m.projectId) ? { projectId: m.projectId } : {}),
    // git remote 정규화 키 — 자동 연결의 보조 신호(이름이 달라도 같은 저장소면 같은 프로젝트).
    ...(typeof m.remoteUrl === 'string' && m.remoteUrl ? { remoteUrl: m.remoteUrl } : {}),
    // 신선도 캐시(호스트 데몬이 주기 보고) — 사이드바 미커밋/미푸시 배지용.
    ...(m.git && typeof m.git === 'object' ? { git: sanitizeGit(m.git) } : {}),
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

// ── 워크스페이스 세션 상태(이어받기) ──
//  session = 기기 무관 표면 목록 + (기기별) 레이아웃 트리. 아래 계약을 PC/모바일이 공유한다:
//   { version, surfaces:[{kind:'terminal'|'ide'|'preview', win?, title?, path?|files?, url?}],
//     layout?(PC 타일링 트리), focusId?, activeSurfaceId? }
//  서버는 여기에 updatedAt(서버시각) + updatedBy 를 감싸 저장한다.
async function getWorkspaceSession(userId, id) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const res = await s3Service.getFileContent(sessionKey(uid, id));
  if (!res.success) return null;
  let content = res.content;
  if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

// 로컬 워크스페이스를 특정 호스트 기기에 귀속(멀티기기 백필/클레임). local 이 아니면 무시.
async function setWorkspaceHost(userId, id, hostDeviceId) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const meta = await readMeta(uid, id);
  if (!meta) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  if (meta.compute !== 'local') return meta; // 클라우드는 호스트 귀속 개념 없음
  const next = normalizeMeta({ ...meta, hostDeviceId, updatedAt: new Date().toISOString() }, id);
  return writeMeta(uid, id, next);
}

async function saveWorkspaceSession(userId, id, session, updatedBy) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy === 'mobile' ? 'mobile' : updatedBy === 'pc' ? 'pc' : 'unknown',
    session: session && typeof session === 'object' ? session : {},
  };
  const res = await s3Service.saveFile(sessionKey(uid, id), JSON.stringify(payload, null, 2));
  if (!res.success) {
    const e = new Error(res.message || '세션 상태를 저장할 수 없습니다.');
    e.statusCode = 500;
    throw e;
  }
  return payload;
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
      compute: input.compute,
      localPath: input.localPath,
      hostDeviceId: input.hostDeviceId, // 멀티기기: 생성한 호스트 기기(로컬만)
      remoteUrl: normalizeRemote(input.remoteUrl),
      unread: 0,
      createdAt: now,
      updatedAt: now,
    },
    id,
  );
  // 프로젝트 자동 연결 — 등록 시점 1회 판단(remote 일치 우선, 폴더/워크스페이스 이름 일치 보조).
  //  결과는 projectId 로 저장돼 이후엔 재계산하지 않는다(이름/remote 가 바뀌어도 그룹 유지).
  meta.projectId = await resolveProjectId(uid, meta);
  await writeMeta(uid, id, meta);
  return meta;
}

// 새 워크스페이스가 속할 프로젝트 결정. 기존 사본과 매칭되면 그 프로젝트에 합류(매칭 사본에
//  projectId 가 없으면 백필), 아니면 새 프로젝트(단독). chat 은 그룹 대상 아님.
async function resolveProjectId(uid, meta) {
  if (meta.kind !== 'project') return undefined;
  let metas = [];
  try { metas = await listWorkspaces(uid); } catch (_) { return genProjectId(); }
  const others = metas.filter((w) => w.id !== meta.id && w.kind === 'project');
  const normName = meta.name.trim().toLowerCase();
  const match =
    (meta.remoteUrl && others.find((w) => w.remoteUrl && w.remoteUrl === meta.remoteUrl)) ||
    others.find((w) => (w.name || '').trim().toLowerCase() === normName) ||
    null;
  if (!match) return genProjectId();
  if (match.projectId) return match.projectId;
  const pid = genProjectId();
  try {
    await writeMeta(uid, match.id, normalizeMeta({ ...match, projectId: pid }, match.id));
  } catch (_) { /* 백필 실패해도 신규 생성은 계속 */ }
  return pid;
}

// 프로젝트에서 분리 — 새 단독 프로젝트로. (자동 연결이 틀렸을 때의 수동 교정, 결과 영구 저장)
async function detachProject(userId, id) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const meta = await readMeta(uid, id);
  if (!meta) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  return writeMeta(uid, id, normalizeMeta({ ...meta, projectId: genProjectId(), updatedAt: new Date().toISOString() }, id));
}

// 다른 워크스페이스의 프로젝트에 합치기 — 대상에 projectId 가 없으면 만들어 양쪽에 저장.
async function attachProject(userId, id, targetId) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  assertWorkspaceId(targetId);
  const [meta, target] = await Promise.all([readMeta(uid, id), readMeta(uid, targetId)]);
  if (!meta || !target) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  let pid = target.projectId;
  if (!pid) {
    pid = genProjectId();
    await writeMeta(uid, targetId, normalizeMeta({ ...target, projectId: pid }, targetId));
  }
  return writeMeta(uid, id, normalizeMeta({ ...meta, projectId: pid, updatedAt: new Date().toISOString() }, id));
}

// 목록 인리치(모바일·PC 공용) — 로컬 워크스페이스에 호스트 기기 이름/온라인 상태를 붙인다.
//  models/relay 는 lazy require(이 서비스는 원래 objectstore 전용이라 상단 의존 최소 유지).
async function enrichHosts(userId, metas) {
  const { DaemonDevice } = require('../models');
  const daemonRelayService = require('./daemonRelayService');
  const rows = await DaemonDevice.findAll({
    where: { user_id: userId, revoked_at: null },
    attributes: ['id', 'device_name'],
  });
  const nameById = new Map(rows.map((d) => [d.id, d.device_name]));
  const online = new Set(daemonRelayService.listRunners(userId).map((r) => r.deviceId));
  return metas.map((w) => {
    if (w.compute === 'cloud') return { ...w, hostName: '클라우드', hostOnline: true };
    const hid = w.hostDeviceId;
    return {
      ...w,
      hostName: (hid != null && nameById.get(hid)) || null,
      hostOnline: hid != null ? online.has(hid) : false,
    };
  });
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
  // 복제본은 별개 작업의 시작 — 원본 프로젝트 그룹에 넣지 않고 단독 프로젝트로.
  const meta = normalizeMeta({ ...src, id: newId, name: `${src.name} (복제)`, projectId: genProjectId(), createdAt: now, updatedAt: now }, newId);
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

/** 회원 탈퇴 정리 — 사용자 objectstore 전체(workspace/<uid>/**) 삭제(메타·세션·번들 포함) */
async function deleteAllForUser(userId) {
  const uid = requireUid(userId);
  const listed = await s3Service.listFiles(`workspace/${uid}`, true);
  const fileNodes = listed.success ? flattenTree(listed.files) : [];
  let deleted = 0;
  for (const node of fileNodes) {
    const res = await s3Service.deleteFile(node.path); // node.path = 풀키(prefix 포함)
    if (res.success) deleted++;
  }
  return { deleted };
}

/** 신선도 보고(호스트 데몬) — git 상태가 실제로 달라졌을 때만 objectstore 에 기록 */
async function updateGitStatus(userId, id, git) {
  const uid = requireUid(userId);
  assertWorkspaceId(id);
  const current = await readMeta(uid, id);
  if (!current) {
    const e = new Error('워크스페이스를 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  const next = sanitizeGit(git);
  const cmp = (g) => (g ? JSON.stringify([g.branch, g.dirty, g.ahead, g.behind, g.upstream]) : '');
  if (cmp(current.git) === cmp(next)) return current; // 변화 없음 — 쓰기 생략(objectstore churn 방지)
  // updatedAt 은 건드리지 않는다(신선도 보고가 목록 정렬/최근성 신호를 오염시키지 않게).
  return writeMeta(uid, id, normalizeMeta({ ...current, git: next }, id));
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  updateGitStatus,
  duplicateWorkspace,
  deleteWorkspace,
  deleteAllForUser,
  getWorkspaceSession,
  saveWorkspaceSession,
  setWorkspaceHost,
  detachProject,
  attachProject,
  enrichHosts,
  normalizeRemote,
  // 경로 헬퍼(세션/워크스페이스 연동용)
  workspaceDir,
  safeUid,
  assertWorkspaceId,
};
