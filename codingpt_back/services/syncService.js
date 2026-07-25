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

// ── checkpoint 2단계(begin/commit) ────────────────────────────────────────
//  왜 쪼개는가: 데몬이 back 왕복 없이 **자기 판단으로** 체크포인트를 찍을 수 있어야 한다(cpt.sock
//   `sync.checkpoint` → begin 으로 좌표만 받고, 로컬 작업은 스스로, 끝나면 commit). 서버 → 데몬 RPC
//   왕복이 사라져 PC 앱이 방아쇠를 당길 필요가 없어진다.
//  구 경로 `checkpoint()` 는 **남긴다**: ① 모바일이 그 경로만 쓴다 ② 개발 중 스테일 사이드카 데몬이
//   흔하다. 아래처럼 begin+commit 을 재사용해 재구성했으므로 구 경로의 요청/응답은 바뀌지 않는다.
//
//  발급 id 대장: commit 이 임의 checkpointId 를 들고 오면 매니페스트에 우리가 만들지 않은 키가
//   들어간다(멀티파트 경로가 서버측 키 조립을 강제하는 것과 같은 이유로 금지). begin 이 발급한 id 만
//   허용하고, 대장의 유효기간은 **presigned PUT 유효기간(1h)과 같게** 맞춘다 — 업로드가 가능한 동안은
//   commit 도 가능해야 하고, 그 뒤엔 어차피 올릴 수 없다.
const ISSUE_TTL_MS = 60 * 60 * 1000;
const ISSUE_MAX = 5000;
//  대장에는 reason 도 같이 적는다 — 데몬 commit body(cpt-server.js:252-263)에는 reason 이 **없다**.
//   begin 이 받은 이유를 여기서 기억하지 않으면 자동(periodic) 체크포인트가 매니페스트에 전부
//   'manual' 로 남아 목록/되돌리기 UI 가 거짓말을 한다(에러 0건).
const issuedCheckpoints = new Map(); // `${wsId}|${ckptId}` → { at, reason }

function noteIssued(wsId, ckptId, reason) {
  const now = Date.now();
  if (issuedCheckpoints.size > ISSUE_MAX) {
    for (const [k, v] of issuedCheckpoints) if (now - v.at > ISSUE_TTL_MS) issuedCheckpoints.delete(k);
    while (issuedCheckpoints.size > ISSUE_MAX) { const k = issuedCheckpoints.keys().next().value; issuedCheckpoints.delete(k); }
  }
  issuedCheckpoints.set(`${wsId}|${ckptId}`, { at: now, reason });
}
function takeIssued(wsId, ckptId) {
  const v = issuedCheckpoints.get(`${wsId}|${ckptId}`);
  if (!v) return null;
  if (Date.now() - v.at > ISSUE_TTL_MS) { issuedCheckpoints.delete(`${wsId}|${ckptId}`); return null; }
  return v; // 삭제하지 않는다 — 같은 id 로 commit 이 두 번 와도 멱등하게 처리돼야 한다
}
function validCheckpointId(v) { return typeof v === 'string' && /^ck_[A-Za-z0-9_-]+$/.test(v) && v.length <= 128; }
// 봉인 좌표(E2EE C단계) — 데몬이 번들을 봉인했을 때만 실린다(평문이면 필드 자체가 없다).
//  서버는 값을 해석하지 않고 매니페스트 entry 에 **보관**만 한다(감사/복호 실패 진단의 유일한 단서).
//  ※ 이 보관만으로는 `e2ee.snap.v1` 을 선언하지 않는다 — config/caps.js 주석 참조.
function normEnc(raw) {
  const enc = typeof raw.enc === 'string' && /^[A-Za-z0-9/._+-]{1,32}$/.test(raw.enc) ? raw.enc : null;
  const epoch = Number.isInteger(raw.epoch) && raw.epoch > 0 ? raw.epoch : null;
  if (!enc) return {};
  return { enc, ...(epoch != null ? { epoch } : {}) };
}

// POST /api/daemon/sync/checkpoint/begin — 좌표(체크포인트 id + presigned PUT)만 발급한다.
//  cwd 미지정이면 ws.localPath 를 응답에 실어 준다(데몬이 그대로 쓴다 — 좌표가 없으면 데몬은 throw 하고
//  호출측 PC 앱이 구 경로로 폴백한다).
async function checkpointBegin(userId, wsId, { reason = 'manual', cwd } = {}) {
  const ws = await requireLocalWorkspace(userId, wsId);
  const ckptId = newCheckpointId();
  const putUrls = {
    bundle: await s3Service.getSignedPutUrl(bundleKey(wsId, ckptId), { expiresIn: 3600 }),
    session: await s3Service.getSignedPutUrl(sessionKey(wsId, ckptId), { expiresIn: 3600 }),
  };
  const why = String(reason || 'manual').slice(0, 32);
  noteIssued(wsId, ckptId, why);
  return { checkpointId: ckptId, putUrls, cwd: cwd || ws.localPath, reason: why };
}

// POST /api/daemon/sync/checkpoint/commit — 업로드 결과를 매니페스트에 등록한다.
//  · 소유권은 여기서 **다시** 검사한다(begin 만 믿으면 남의 매니페스트를 오염시킬 수 있다).
//  · 멱등: 같은 checkpointId 로 두 번 와도 항목이 중복되지 않는다(filter 후 push).
//  · skipped=true 면 매니페스트를 건드리지 않고 현재 head 를 돌려준다.
async function checkpointCommit(userId, wsId, raw = {}) {
  await requireLocalWorkspace(userId, wsId);
  const given = typeof raw.checkpointId === 'string' ? raw.checkpointId : '';

  if (raw.skipped) {
    // 변경 없음(중복제거) — 새 번들/항목을 만들지 않는다(자동 트리거가 무의미하게 쌓이지 않게).
    const manifest = await loadManifest(wsId);
    const headId = (manifest.head && manifest.head.checkpointId) || null;
    return { skipped: true, unchanged: true, checkpointId: (validCheckpointId(given) ? given : headId), head: manifest.head || null };
  }

  if (!validCheckpointId(given)) {
    const e = new Error('잘못된 체크포인트 ID 입니다.'); e.statusCode = 400; throw e;
  }
  const issued = takeIssued(wsId, given);
  if (!issued) {
    // 서버가 발급하지 않은 id = 클라가 매니페스트 키를 임의로 정하려는 것(또는 1시간 초과 지각 commit).
    const e = new Error('발급되지 않은 체크포인트 ID 입니다.'); e.statusCode = 400; throw e;
  }

  const at = new Date().toISOString();
  const entry = {
    // reason 은 commit body 에 없으면 begin 이 기억한 값을 쓴다(자동 트리거가 'manual' 로 위장되지 않게).
    id: given, reason: String(raw.reason || issued.reason || 'manual').slice(0, 32), at,
    baseCommit: raw.baseCommit || null,
    commit: raw.commit || null,
    bundleKey: bundleKey(wsId, given),
    sessionKey: raw.hasSession ? sessionKey(wsId, given) : null,
    sizeBytes: Number.isFinite(Number(raw.sizeBytes)) ? Number(raw.sizeBytes) : 0,
    hasSession: !!raw.hasSession,
    ...normEnc(raw),
  };
  const manifest = await loadManifest(wsId);
  manifest.checkpoints = (manifest.checkpoints || []).filter((c) => c.id !== given);
  manifest.checkpoints.push(entry);
  if (manifest.checkpoints.length > 200) manifest.checkpoints = manifest.checkpoints.slice(-200);
  manifest.head = { checkpointId: given, commit: entry.commit, baseCommit: entry.baseCommit, at };
  await saveManifest(wsId, manifest);
  return { ...entry, head: manifest.head };
}

// ── checkpoint(구 경로 — 서버가 데몬 RPC 를 오케스트레이션) ─────────────────
//  cwd: 스냅샷 대상 폴더(데몬 홈-기준 상대). 미지정=ws.localPath(로컬 러너). 역방향 핸드오프에선
//   활성=클라우드일 때 클라우드 실폴더(예 슬러그 'foo'=/workspace/foo)를 넘겨 그쪽에서 찍는다.
//  background=true: RPC 를 기다리지 않고 즉시 { accepted, checkpointId } 반환 — 대형 번들은
//   압축+업로드가 분 단위라 동기 HTTP 로 기다리면 Cloudflare 오리진 타임아웃(524, ~100s)에 걸린다.
//   완료 시 manifest 등록은 백그라운드에서 그대로 진행되고, 클라이언트는 sync_event/목록으로 확인.
async function checkpoint(userId, wsId, { reason = 'manual', includeAgentSession = true, cwd, background = false } = {}) {
  const begun = await checkpointBegin(userId, wsId, { reason, cwd });
  const ckptId = begun.checkpointId;

  const run = async () => {
    // 데몬이 shadow 커밋 → 번들/세션 생성 → presigned PUT 업로드. cwd 는 활성 러너 홈-기준 상대.
    //  wsId 는 대용량(>80MB) 번들의 멀티파트 업로드 콜백(/sync/multipart/*)용 좌표.
    const result = await daemonRelayService.callRpc(userId, 'sync.checkpoint', {
      cwd: begun.cwd, reason, checkpointId: ckptId, putUrls: begun.putUrls, includeAgentSession, wsId,
    }, RPC_TIMEOUT) || {};

    // 응답 형태는 신 경로(commit)와 완전히 같다 — 두 경로가 같은 한 벌을 타야 매니페스트가 갈라지지 않는다.
    return checkpointCommit(userId, wsId, {
      // ★ 비-skipped 는 **서버가 발급한 id** 를 쓴다(구 경로의 기존 동작 그대로). 데몬이 다른 id 를
      //  echo 해도 매니페스트 키는 서버가 정한다. skipped 는 데몬 id 를 존중하고 없으면 head 로 폴백.
      checkpointId: result.skipped ? (result.checkpointId || '') : ckptId,
      reason,
      skipped: !!result.skipped,
      unchanged: !!result.unchanged,
      baseCommit: result.baseCommit || null,
      commit: result.commit || null,
      sizeBytes: result.sizeBytes || 0,
      hasSession: !!result.hasSession,
      // 봉인 좌표(데몬이 봉인했을 때만) — 구 경로에서도 반드시 보관한다(§5.7).
      ...(result.enc ? { enc: result.enc, epoch: result.epoch } : {}),
    });
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
  checkpoint, checkpointBegin, checkpointCommit, materialize, status, resolve, listCheckpoints,
  multipartInit, multipartPartUrl, multipartComplete, multipartAbort,
  _issuedCheckpoints: issuedCheckpoints, // 테스트 노출 — 발급 대장(미발급 id 거부 계약)
  _normEnc: normEnc,
};
