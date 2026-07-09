/**
 * 동기화 서비스(M4) — objectstore git-bundle 허브의 back 측 오케스트레이터.
 *
 *  · 정본(허브) = objectstore `codingpt/sync/<wsId>/manifest.json`
 *      { head:{checkpointId,commit,baseCommit,at}, checkpoints:[{id,reason,baseCommit,commit,bundleKey,sessionKey,sizeBytes,hasSession,at}] }
 *  · 번들/세션 바이트는 데몬↔objectstore 직결(presigned) — back 은 presigned URL 발급 + manifest 관리만.
 *  · 소유권: 모든 작업은 wsId 가 req.user 소유 워크스페이스인지 확인(getWorkspace uid-scoped).
 *
 * 크레덴셜/경계: back 은 objectstore 자격증명만 보유. 데몬은 AI 크레덴셜 무접촉(계약 §5.3·§6.3).
 */
const crypto = require('crypto');
const s3Service = require('./s3Service');
const workspaceService = require('./workspaceService');
const daemonRelayService = require('./daemonRelayService');

const RPC_TIMEOUT = 120000; // checkpoint/materialize 는 네트워크(번들 업/다운) 포함 → 넉넉히.

function newCheckpointId() {
  return `ck_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
function manifestKey(wsId) { return `codingpt/sync/${wsId}/manifest.json`; }
function bundleKey(wsId, ckptId) { return `codingpt/sync/${wsId}/${ckptId}.bundle`; }
function sessionKey(wsId, ckptId) { return `codingpt/sync/${wsId}/${ckptId}.session.json`; }

// wsId 검증(경로 안전 + 소유권) → 워크스페이스 메타 반환. compute='local' 만 sync 대상(MVP).
async function requireLocalWorkspace(userId, wsId) {
  if (!wsId || typeof wsId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(wsId)) {
    const e = new Error('잘못된 워크스페이스 ID 입니다.'); e.statusCode = 400; throw e;
  }
  const ws = await workspaceService.getWorkspace(userId, wsId); // 404/소유권 throw
  if (ws.compute !== 'local' || !ws.localPath) {
    const e = new Error('로컬(내 PC) 워크스페이스만 동기화할 수 있습니다.'); e.statusCode = 400; throw e;
  }
  return ws;
}

async function loadManifest(wsId) {
  const r = await s3Service.getFileContent(manifestKey(wsId)).catch(() => null);
  if (r && r.success && r.content) {
    try { return JSON.parse(r.content); } catch (_) { /* 손상 → 새로 시작 */ }
  }
  return { version: '1.0', head: null, checkpoints: [] };
}
async function saveManifest(wsId, manifest) {
  await s3Service.saveFile(manifestKey(wsId), JSON.stringify(manifest), { contentType: 'application/json' });
}

// ── checkpoint ───────────────────────────────────────────────────────────
async function checkpoint(userId, wsId, { reason = 'manual', includeAgentSession = true } = {}) {
  const ws = await requireLocalWorkspace(userId, wsId);
  const ckptId = newCheckpointId();
  const bKey = bundleKey(wsId, ckptId);
  const sKey = sessionKey(wsId, ckptId);
  const putUrls = {
    bundle: await s3Service.getSignedPutUrl(bKey),
    session: await s3Service.getSignedPutUrl(sKey),
  };
  // 데몬이 shadow 커밋 → 번들/세션 생성 → presigned PUT 업로드.
  const result = await daemonRelayService.callRpc(userId, 'sync.checkpoint', {
    cwd: ws.localPath, reason, checkpointId: ckptId, putUrls, includeAgentSession,
  }, RPC_TIMEOUT);

  const at = new Date().toISOString();
  const entry = {
    id: ckptId, reason, at,
    baseCommit: result.baseCommit || null,
    commit: result.commit || null,
    bundleKey: bKey,
    sessionKey: result.hasSession ? sKey : null,
    sizeBytes: result.sizeBytes || 0,
    hasSession: !!result.hasSession,
  };
  const manifest = await loadManifest(wsId);
  manifest.checkpoints = (manifest.checkpoints || []).filter((c) => c.id !== ckptId);
  manifest.checkpoints.push(entry);
  if (manifest.checkpoints.length > 200) manifest.checkpoints = manifest.checkpoints.slice(-200);
  manifest.head = { checkpointId: ckptId, commit: entry.commit, baseCommit: entry.baseCommit, at };
  await saveManifest(wsId, manifest);

  return { ...entry, head: manifest.head };
}

// ── materialize ────────────────────────────────────────────────────────────
//  targetCwd: 복원 대상 폴더(데몬 홈-기준 상대). PC→둘째 폴더(다른 러너 시뮬)/핸드오프 대상.
async function materialize(userId, wsId, { checkpointId, targetCwd, reinstall = false } = {}) {
  const ws = await requireLocalWorkspace(userId, wsId);
  const manifest = await loadManifest(wsId);
  const ckptId = checkpointId || (manifest.head && manifest.head.checkpointId);
  if (!ckptId) { const e = new Error('복원할 체크포인트가 없습니다.'); e.statusCode = 404; throw e; }
  const entry = (manifest.checkpoints || []).find((c) => c.id === ckptId);
  if (!entry) { const e = new Error('체크포인트를 찾을 수 없습니다.'); e.statusCode = 404; throw e; }

  const getUrls = { bundle: await s3Service.getSignedGetUrl(entry.bundleKey) };
  if (entry.sessionKey) getUrls.session = await s3Service.getSignedGetUrl(entry.sessionKey);

  const result = await daemonRelayService.callRpc(userId, 'sync.materialize', {
    checkpointId: ckptId, targetCwd: targetCwd || ws.localPath, getUrls, reinstall,
  }, RPC_TIMEOUT);
  return { checkpointId: ckptId, targetCwd: targetCwd || ws.localPath, ...result };
}

// ── status ──────────────────────────────────────────────────────────────────
async function status(userId, wsId, { cwd } = {}) {
  const ws = await requireLocalWorkspace(userId, wsId);
  const manifest = await loadManifest(wsId);
  const result = await daemonRelayService.callRpc(userId, 'sync.status', {
    cwd: cwd || ws.localPath, head: manifest.head && manifest.head.commit,
  }, 20000);
  return { ...result, lastCheckpointId: manifest.head && manifest.head.checkpointId, lastAt: manifest.head && manifest.head.at };
}

// ── resolve ──────────────────────────────────────────────────────────────────
async function resolve(userId, wsId, { conflictId, choices, bulk } = {}) {
  await requireLocalWorkspace(userId, wsId);
  if (!conflictId) { const e = new Error('conflictId 가 필요합니다.'); e.statusCode = 400; throw e; }
  return daemonRelayService.callRpc(userId, 'sync.resolve', { conflictId, choices: choices || [], bulk: bulk || null }, RPC_TIMEOUT);
}

// ── listCheckpoints ───────────────────────────────────────────────────────────
async function listCheckpoints(userId, wsId) {
  await requireLocalWorkspace(userId, wsId);
  const manifest = await loadManifest(wsId);
  return { head: manifest.head || null, checkpoints: (manifest.checkpoints || []).slice().reverse() };
}

module.exports = { checkpoint, materialize, status, resolve, listCheckpoints };
