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

const RPC_TIMEOUT = 600000; // checkpoint/materialize 는 대형 번들(수백MB)의 git 압축+업/다운 포함 — 분 단위 소요.

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
//  cwd: 스냅샷 대상 폴더(데몬 홈-기준 상대). 미지정=ws.localPath(로컬 러너). 역방향 핸드오프에선
//   활성=클라우드일 때 클라우드 실폴더(예 슬러그 'foo'=/workspace/foo)를 넘겨 그쪽에서 찍는다.
//  background=true: RPC 를 기다리지 않고 즉시 { accepted, checkpointId } 반환 — 대형 번들은
//   압축+업로드가 분 단위라 동기 HTTP 로 기다리면 Cloudflare 오리진 타임아웃(524, ~100s)에 걸린다.
//   완료 시 manifest 등록은 백그라운드에서 그대로 진행되고, 클라이언트는 sync_event/목록으로 확인.
async function checkpoint(userId, wsId, { reason = 'manual', includeAgentSession = true, cwd, background = false } = {}) {
  const ws = await requireLocalWorkspace(userId, wsId);
  const ckptId = newCheckpointId();
  const bKey = bundleKey(wsId, ckptId);
  const sKey = sessionKey(wsId, ckptId);
  const putUrls = {
    bundle: await s3Service.getSignedPutUrl(bKey, { expiresIn: 3600 }),
    session: await s3Service.getSignedPutUrl(sKey, { expiresIn: 3600 }),
  };

  const run = async () => {
    // 데몬이 shadow 커밋 → 번들/세션 생성 → presigned PUT 업로드. cwd 는 활성 러너 홈-기준 상대.
    //  wsId 는 대용량(>80MB) 번들의 멀티파트 업로드 콜백(/sync/multipart/*)용 좌표.
    const result = await daemonRelayService.callRpc(userId, 'sync.checkpoint', {
      cwd: cwd || ws.localPath, reason, checkpointId: ckptId, putUrls, includeAgentSession, wsId,
    }, RPC_TIMEOUT);

    // 변경 없음(중복제거) → 새 번들/manifest 항목을 만들지 않는다(자동 트리거가 무의미하게 쌓이지 않게).
    if (result && result.skipped) {
      const manifest = await loadManifest(wsId);
      return { skipped: true, unchanged: true, checkpointId: result.checkpointId || (manifest.head && manifest.head.checkpointId) || null, head: manifest.head || null };
    }

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
  };

  if (background) {
    run().catch((e) => console.warn(`[sync] 백그라운드 체크포인트 실패 ws=${wsId} ck=${ckptId}: ${e.message}`));
    return { accepted: true, background: true, checkpointId: ckptId };
  }
  return run();
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

// ── 멀티파트 업로드(대용량 번들 — Cloudflare 요청당 100MB 제한 우회) ─────────────
//  데몬이 번들 생성 후 크기가 크면 이 REST 를 콜백한다. 키는 서버측 조립(데몬의 임의 key 금지),
//  소유권은 매 호출 requireLocalWorkspace 로 확인. partNumber 1..10000(S3 규격).
function multipartKey(wsId, checkpointId, kind) {
  if (!/^ck_[A-Za-z0-9_-]+$/.test(String(checkpointId || ''))) {
    const e = new Error('잘못된 체크포인트 ID 입니다.'); e.statusCode = 400; throw e;
  }
  return kind === 'session' ? sessionKey(wsId, checkpointId) : bundleKey(wsId, checkpointId);
}
async function multipartInit(userId, { wsId, checkpointId, kind } = {}) {
  await requireLocalWorkspace(userId, wsId);
  const key = multipartKey(wsId, checkpointId, kind);
  const uploadId = await s3Service.createMultipartUpload(key);
  return { uploadId };
}
async function multipartPartUrl(userId, { wsId, checkpointId, kind, uploadId, partNumber } = {}) {
  await requireLocalWorkspace(userId, wsId);
  const key = multipartKey(wsId, checkpointId, kind);
  const n = Number(partNumber);
  if (!uploadId || !Number.isInteger(n) || n < 1 || n > 10000) {
    const e = new Error('잘못된 파트 번호입니다.'); e.statusCode = 400; throw e;
  }
  const url = await s3Service.getSignedPartUrl(key, String(uploadId), n);
  return { url };
}
async function multipartComplete(userId, { wsId, checkpointId, kind, uploadId, parts } = {}) {
  await requireLocalWorkspace(userId, wsId);
  const key = multipartKey(wsId, checkpointId, kind);
  if (!uploadId || !Array.isArray(parts) || !parts.length || parts.length > 10000) {
    const e = new Error('잘못된 파트 목록입니다.'); e.statusCode = 400; throw e;
  }
  const clean = parts.map((p) => ({ PartNumber: Number(p.PartNumber), ETag: String(p.ETag || '') }));
  if (clean.some((p) => !Number.isInteger(p.PartNumber) || p.PartNumber < 1 || !p.ETag)) {
    const e = new Error('잘못된 파트 목록입니다.'); e.statusCode = 400; throw e;
  }
  await s3Service.completeMultipartUpload(key, String(uploadId), clean);
  return { ok: true };
}
async function multipartAbort(userId, { wsId, checkpointId, kind, uploadId } = {}) {
  await requireLocalWorkspace(userId, wsId);
  const key = multipartKey(wsId, checkpointId, kind);
  if (uploadId) await s3Service.abortMultipartUpload(key, String(uploadId)).catch(() => {});
  return { ok: true };
}

module.exports = {
  checkpoint, materialize, status, resolve, listCheckpoints,
  multipartInit, multipartPartUrl, multipartComplete, multipartAbort,
};
