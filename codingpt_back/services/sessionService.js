const crypto = require('crypto');
const s3Service = require('./s3Service');
const workspaceService = require('./workspaceService');

// 워크스페이스 하위 세션(채팅) — objectstore 영속화.
// 저장 위치: codingpt/execute/workspace/<userId>/projects/<workspaceId>/sessions/<sessionId>/
//   meta.json      — { id, title, createdAt, updatedAt, sdkSessionId, preview, msgCount }  (목록용·작음)
//   messages.json  — [ AgentMsg... ]  (세션 열 때만 로드, 턴마다 1회 재작성)
// 메시지는 append 가 아니라 전체 재작성(objectstore 는 부분추가 불가) — 앱이 턴(done)마다 1회 저장.
// 추후 멀티유저/초대형 히스토리로 가면 messages 만 DB 로 이전 — 이 서비스 인터페이스만 교체하면 됨.

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const sessionsBase = (uid, wsId) => `${workspaceService.workspaceDir(uid, wsId)}/sessions`;
const sessionDir = (uid, wsId, sessId) => `${sessionsBase(uid, wsId)}/${sessId}`;
const metaKey = (uid, wsId, sessId) => `${sessionDir(uid, wsId, sessId)}/meta.json`;
const messagesKey = (uid, wsId, sessId) => `${sessionDir(uid, wsId, sessId)}/messages.json`;

const flattenTree = (nodes, acc = []) => {
  for (const n of nodes || []) {
    if (n.type === 'directory') flattenTree(n.files || [], acc);
    else acc.push(n);
  }
  return acc;
};

function genId() {
  return `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function requireUid(userId) {
  const uid = workspaceService.safeUid(userId);
  if (!uid) {
    const e = new Error('인증이 필요합니다.');
    e.statusCode = 401;
    throw e;
  }
  return uid;
}

function assertSessionId(id) {
  if (!id || !SESSION_ID_RE.test(id)) {
    const e = new Error('유효하지 않은 sessionId 입니다.');
    e.statusCode = 400;
    throw e;
  }
}

function normalizeMeta(raw, id) {
  const m = raw && typeof raw === 'object' ? raw : {};
  return {
    id: m.id || id,
    title: typeof m.title === 'string' && m.title.trim() ? m.title : '새 채팅',
    sdkSessionId: typeof m.sdkSessionId === 'string' ? m.sdkSessionId : null,
    preview: typeof m.preview === 'string' ? m.preview : '',
    msgCount: Number.isInteger(m.msgCount) ? m.msgCount : 0,
    createdAt: m.createdAt || null,
    updatedAt: m.updatedAt || m.createdAt || null,
  };
}

async function readJson(key) {
  const res = await s3Service.getFileContent(key);
  if (!res.success) return null;
  let content = res.content;
  if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
  try {
    return JSON.parse(content);
  } catch (_) {
    return null;
  }
}

async function writeJson(key, value, failMsg) {
  const res = await s3Service.saveFile(key, JSON.stringify(value, null, 2));
  if (!res.success) {
    const e = new Error(res.message || failMsg || '세션 정보를 저장할 수 없습니다.');
    e.statusCode = 500;
    throw e;
  }
}

// 메시지 배열에서 미리보기/개수 파생 — 첫 user 메시지를 preview 로
function deriveFromMessages(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const firstUser = arr.find((m) => m && m.role === 'user' && typeof m.text === 'string');
  const preview = firstUser ? firstUser.text.slice(0, 80) : '';
  return { preview, msgCount: arr.length };
}

/** 워크스페이스의 세션 목록(최신 수정순) — meta.json 만 스캔 */
async function listSessions(userId, workspaceId) {
  const uid = requireUid(userId);
  workspaceService.assertWorkspaceId(workspaceId);
  const listed = await s3Service.listFiles(sessionsBase(uid, workspaceId), true);
  if (!listed.success) return [];
  const ids = [];
  for (const node of flattenTree(listed.files)) {
    const m = String(node.path || '').match(/\/sessions\/([A-Za-z0-9_-]+)\/meta\.json$/);
    if (m) ids.push(m[1]);
  }
  const metas = [];
  for (const id of ids) {
    const raw = await readJson(metaKey(uid, workspaceId, id));
    if (raw) metas.push(normalizeMeta(raw, id));
  }
  metas.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return metas;
}

/** 세션 생성 — meta.json + 빈 messages.json. 워크스페이스 존재 검증 */
async function createSession(userId, workspaceId, input = {}) {
  const uid = requireUid(userId);
  await workspaceService.getWorkspace(userId, workspaceId); // 없으면 404 throw
  const id = genId();
  const now = new Date().toISOString();
  const meta = normalizeMeta(
    { id, title: input.title, sdkSessionId: null, preview: '', msgCount: 0, createdAt: now, updatedAt: now },
    id,
  );
  await writeJson(metaKey(uid, workspaceId, id), meta);
  await writeJson(messagesKey(uid, workspaceId, id), []);
  return meta;
}

/** 단일 세션 — meta + messages */
async function getSession(userId, workspaceId, sessionId) {
  const uid = requireUid(userId);
  workspaceService.assertWorkspaceId(workspaceId);
  assertSessionId(sessionId);
  const rawMeta = await readJson(metaKey(uid, workspaceId, sessionId));
  if (!rawMeta) {
    const e = new Error('세션을 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  const messages = (await readJson(messagesKey(uid, workspaceId, sessionId))) || [];
  return { meta: normalizeMeta(rawMeta, sessionId), messages: Array.isArray(messages) ? messages : [] };
}

/**
 * 세션 갱신 — title/sdkSessionId 패치 + (옵션) messages 전체 저장.
 * messages 가 주어지면 messages.json 재작성 + preview/msgCount/updatedAt 갱신.
 */
async function updateSession(userId, workspaceId, sessionId, patch = {}) {
  const uid = requireUid(userId);
  workspaceService.assertWorkspaceId(workspaceId);
  assertSessionId(sessionId);
  const rawMeta = await readJson(metaKey(uid, workspaceId, sessionId));
  if (!rawMeta) {
    const e = new Error('세션을 찾을 수 없습니다.');
    e.statusCode = 404;
    throw e;
  }
  const current = normalizeMeta(rawMeta, sessionId);

  let derived = { preview: current.preview, msgCount: current.msgCount };
  if (Array.isArray(patch.messages)) {
    derived = deriveFromMessages(patch.messages);
    await writeJson(messagesKey(uid, workspaceId, sessionId), patch.messages);
  }

  const next = normalizeMeta(
    {
      ...current,
      ...(typeof patch.title === 'string' && patch.title.trim() ? { title: patch.title.trim() } : {}),
      ...(typeof patch.sdkSessionId === 'string' ? { sdkSessionId: patch.sdkSessionId } : {}),
      preview: derived.preview,
      msgCount: derived.msgCount,
      updatedAt: new Date().toISOString(),
    },
    sessionId,
  );
  await writeJson(metaKey(uid, workspaceId, sessionId), next);
  return next;
}

/** 세션 삭제 — 폴더 내 모든 파일 제거 */
async function deleteSession(userId, workspaceId, sessionId) {
  const uid = requireUid(userId);
  workspaceService.assertWorkspaceId(workspaceId);
  assertSessionId(sessionId);
  const listed = await s3Service.listFiles(sessionDir(uid, workspaceId, sessionId), true);
  const fileNodes = listed.success ? flattenTree(listed.files) : [];
  let deleted = 0;
  for (const node of fileNodes) {
    const res = await s3Service.deleteFile(node.path);
    if (res.success) deleted++;
  }
  return { id: sessionId, deleted };
}

module.exports = {
  listSessions,
  createSession,
  getSession,
  updateSession,
  deleteSession,
};
