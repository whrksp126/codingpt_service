/**
 * 동기화 채널(sync.*) — 계약 §6. objectstore git-bundle 허브로 코드+에이전트 대화를 체크포인트/복원.
 *
 *  · sync.checkpoint  : shadow 커밋(사용자 히스토리 불변) → git bundle + 세션 묶음 → presigned PUT 로 업로드.
 *  · sync.materialize : presigned GET 으로 번들/세션 다운로드 → 다른 폴더(러너)에 코드+대화 복원.
 *  · sync.status      : 로컬 git 상태(head/dirty) + manifest.head 비교 → clean/syncing/conflict.
 *  · sync.resolve     : 3-way 충돌 시 파일 단위 택1 + 진 쪽 rescue 브랜치 보존.
 *
 * 경계/규율:
 *  - shadow 커밋은 임시 인덱스(GIT_INDEX_FILE)로 만들어 사용자 refs/heads·HEAD·워킹트리·인덱스를 건드리지 않는다.
 *    우리 전용 네임스페이스 refs/codingpt/* 에만 기록(파괴적 아님).
 *  - 세션 묶음 = 대화 로그(~/.claude/projects/*.jsonl + ~/.codingpt/sessions/*.jsonl)만. 크레덴셜 무접촉.
 *  - objectstore 자격증명은 데몬에 없다. back 이 presigned URL 을 발급해 params 로 넘겨주고,
 *    데몬은 node 내장 https 로 번들을 objectstore 에 직접 업/다운(대용량 바이트가 릴레이를 우회).
 *  - git 은 execFile 로 호출(셸 인젝션 없음). 모든 경로는 fs 홈 jail(safeResolve) 안.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const fsLib = require('./fs');
const runtime = require('./runtime');

// 지연 평가(로컬=홈, 클라우드 러너=주입된 상태/클로드 홈).
const tmpDir = () => path.join(runtime.stateDir(), 'tmp');
const sessionsDir = () => path.join(runtime.stateDir(), 'sessions');
const claudeProjectsDir = () => path.join(runtime.claudeHome(), 'projects');

// claude 의 cwd→프로젝트 slug 규칙(agent.js projectSlug 와 동일해야 resume 가 맞다).
function projectSlug(absCwd) { return absCwd.replace(/[^a-zA-Z0-9]/g, '-'); }

let pushWs = null; // 최신 제어 WS — sync_event push 대상.
function emitSync(event) {
  if (pushWs && pushWs.readyState === 1) {
    try { pushWs.send(JSON.stringify({ type: 'sync_event', event })); } catch (_) { /* noop */ }
  }
}

// 진행 중 충돌 상태(resolve 에서 사용): conflictId → { targetAbs, localHead, incomingCommit, base, files, branch }
const conflicts = new Map();
// 자동 체크포인트 중복제거(M4-2): abs → { tree, id, commit }. WIP 트리가 직전 체크포인트와 같으면 skip.
//  (턴종료/주기/전환직전 트리거가 자유롭게 발사돼도 변경 없으면 번들/업로드를 안 만든다.)
const lastCheckpoint = new Map();

// git 실행 — env 주입(GIT_INDEX_FILE 등)·종료코드 포착(merge-tree 는 exit 1 로 충돌을 알린다).
function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      timeout: opts.timeout || 30000,
      maxBuffer: 128 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}
// commit-tree 등 identity 필요 명령용 — 사용자 git config 가 비어도 실패하지 않게 봇 신원 주입.
function botEnv(extra) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'CodingPT', GIT_AUTHOR_EMAIL: 'sync@codingpt.local',
    GIT_COMMITTER_NAME: 'CodingPT', GIT_COMMITTER_EMAIL: 'sync@codingpt.local',
    ...(extra || {}),
  };
}

function httpsPut(urlStr, buf) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(u, { method: 'PUT', headers: { 'Content-Length': buf.length } }, (res) => {
      const d = []; res.on('data', (c) => d.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`업로드 실패(${res.statusCode}) ${Buffer.concat(d).toString('utf8').slice(0, 200)}`));
      });
    });
    req.on('error', reject); req.write(buf); req.end();
  });
}
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      if (res.statusCode >= 300) { res.resume(); return reject(new Error(`다운로드 실패(${res.statusCode})`)); }
      const d = []; res.on('data', (c) => d.push(c));
      res.on('end', () => resolve(Buffer.concat(d)));
    }).on('error', reject);
  });
}

async function ensureTmp() { await fsp.mkdir(tmpDir(), { recursive: true }).catch(() => {}); }
async function isGitRepo(absCwd) { return (await git(['rev-parse', '--is-inside-work-tree'], { cwd: absCwd })).ok; }
async function headSha(absCwd) { const r = await git(['rev-parse', 'HEAD'], { cwd: absCwd }); return r.ok ? r.out.trim() : null; }

// 이 워크스페이스(cwd)의 에이전트 대화 로그를 하나의 JSON 아티팩트로 묶는다(tar 의존성 회피).
//  claude 원본 jsonl + 우리 이벤트 로그. 크레덴셜 아님.
function collectSessionArtifact(absCwd) {
  const files = [];
  const slug = projectSlug(absCwd);
  const claudeDir = path.join(claudeProjectsDir(), slug);
  let claudeFiles = [];
  try { claudeFiles = fs.readdirSync(claudeDir).filter((f) => f.endsWith('.jsonl')); } catch (_) { claudeFiles = []; }
  for (const f of claudeFiles) {
    try {
      const buf = fs.readFileSync(path.join(claudeDir, f));
      files.push({ scope: 'claude', name: f, contentB64: buf.toString('base64') });
      // 대응하는 우리 이벤트 로그(파일명 = claude session id).
      const id = f.replace(/\.jsonl$/, '');
      const ours = path.join(sessionsDir(), id + '.jsonl');
      if (fs.existsSync(ours)) files.push({ scope: 'codingpt', name: id + '.jsonl', contentB64: fs.readFileSync(ours).toString('base64') });
    } catch (_) { /* skip */ }
  }
  return { version: '1.0', sourceSlug: slug, files };
}

// 세션 아티팩트를 targetCwd 기준으로 복원 — resume 가능하게 claude 프로젝트 slug 를 타겟에 맞춘다.
function restoreSessionArtifact(artifact, targetAbsCwd) {
  if (!artifact || !Array.isArray(artifact.files)) return 0;
  const targetSlug = projectSlug(targetAbsCwd);
  const claudeDir = path.join(claudeProjectsDir(), targetSlug);
  let n = 0;
  for (const f of artifact.files) {
    try {
      const buf = Buffer.from(f.contentB64 || '', 'base64');
      if (f.scope === 'claude') {
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, f.name), buf);
        n++;
      } else if (f.scope === 'codingpt') {
        fs.mkdirSync(sessionsDir(), { recursive: true });
        fs.writeFileSync(path.join(sessionsDir(), f.name), buf);
        n++;
      }
    } catch (_) { /* skip */ }
  }
  return n;
}

// ── sync.checkpoint ────────────────────────────────────────────────────
async function checkpoint(p) {
  const cwd = p.cwd || '';
  const id = p.checkpointId;
  if (!id) throw new Error('checkpointId 가 필요합니다.');
  const abs = fsLib.safeResolve(cwd);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('워크스페이스 폴더가 없습니다.');
  await ensureTmp();

  // git repo 아니면 init(빈 워크스페이스도 체크포인트 가능하게).
  if (!(await isGitRepo(abs))) { await git(['init'], { cwd: abs }); }

  emitSync({ type: 'sync_progress', phase: 'checkpoint', checkpointId: id });

  const base = await headSha(abs); // null=커밋 없는 새 repo
  const ref = `refs/codingpt/checkpoints/${id}`;
  const idxFile = path.join(tmpDir(), `idx-${id}`);
  await fsp.rm(idxFile, { force: true }).catch(() => {});
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };

  // shadow 커밋: 임시 인덱스로 WIP 스냅샷 → 사용자 인덱스/워킹트리/HEAD 무접촉.
  if (base) await git(['read-tree', 'HEAD'], { cwd: abs, env });
  const add = await git(['add', '-A'], { cwd: abs, env });
  if (!add.ok) { await fsp.rm(idxFile, { force: true }).catch(() => {}); throw new Error('스냅샷 준비 실패: ' + add.err.slice(0, 200)); }
  const wt = await git(['write-tree'], { cwd: abs, env });
  if (!wt.ok) { await fsp.rm(idxFile, { force: true }).catch(() => {}); throw new Error('write-tree 실패: ' + wt.err.slice(0, 200)); }
  const tree = wt.out.trim();

  // 중복제거: 직전 체크포인트와 WIP 트리가 같으면 새 번들/업로드를 만들지 않고 skip.
  //  (자동 트리거가 변경 없이 반복돼도 무의미한 체크포인트가 쌓이지 않게.)
  const prev = lastCheckpoint.get(abs);
  if (prev && prev.tree === tree) {
    await fsp.rm(idxFile, { force: true }).catch(() => {});
    emitSync({ type: 'sync_status', state: 'clean', head: prev.commit, base, lastCheckpointId: prev.id });
    return { checkpointId: prev.id, baseCommit: base, commit: prev.commit, sizeBytes: 0, hasSession: false, excluded: [], skipped: true, unchanged: true };
  }

  const ctArgs = ['commit-tree', tree, '-m', `codingpt checkpoint ${p.reason || 'manual'}`];
  if (base) { ctArgs.push('-p', base); }
  const ct = await git(ctArgs, { cwd: abs, env: botEnv({ GIT_INDEX_FILE: idxFile }) });
  await fsp.rm(idxFile, { force: true }).catch(() => {});
  if (!ct.ok) throw new Error('commit-tree 실패: ' + ct.err.slice(0, 200));
  const commit = ct.out.trim();
  await git(['update-ref', ref, commit], { cwd: abs });

  // 번들 생성(도달 가능 객체 전체 — 자기완결). .gitignore 로 node_modules 등은 이미 제외.
  const bundleFile = path.join(tmpDir(), `${id}.bundle`);
  const bd = await git(['bundle', 'create', bundleFile, ref], { cwd: abs, timeout: 120000 });
  if (!bd.ok) throw new Error('번들 생성 실패: ' + bd.err.slice(0, 200));
  const bundleBuf = await fsp.readFile(bundleFile);

  // 세션 묶음.
  const includeSession = p.includeAgentSession !== false;
  let sessionBuf = null;
  if (includeSession && p.putUrls && p.putUrls.session) {
    const artifact = collectSessionArtifact(abs);
    sessionBuf = Buffer.from(JSON.stringify(artifact), 'utf8');
  }

  // 업로드(presigned PUT).
  emitSync({ type: 'sync_progress', phase: 'upload', checkpointId: id });
  await httpsPut(p.putUrls.bundle, bundleBuf);
  if (sessionBuf) await httpsPut(p.putUrls.session, sessionBuf);

  await fsp.rm(bundleFile, { force: true }).catch(() => {});
  lastCheckpoint.set(abs, { tree, id, commit }); // 다음 자동 트리거의 중복제거 기준.

  const result = {
    checkpointId: id,
    baseCommit: base,
    commit,
    sizeBytes: bundleBuf.length,
    hasSession: !!sessionBuf,
    excluded: [],
  };
  emitSync({ type: 'sync_status', state: 'clean', head: commit, base, lastCheckpointId: id });
  return result;
}

// ── sync.materialize ────────────────────────────────────────────────────
async function materialize(p) {
  const id = p.checkpointId;
  const targetCwd = p.targetCwd || '';
  if (!id) throw new Error('checkpointId 가 필요합니다.');
  if (!targetCwd) throw new Error('targetCwd 가 필요합니다.');
  if (!p.getUrls || !p.getUrls.bundle) throw new Error('번들 URL 이 필요합니다.');
  const targetAbs = fsLib.safeResolve(targetCwd);
  await ensureTmp();
  await fsp.mkdir(targetAbs, { recursive: true });

  emitSync({ type: 'sync_progress', phase: 'materialize', checkpointId: id });

  // 번들 다운로드.
  const bundleFile = path.join(tmpDir(), `mat-${id}.bundle`);
  const bundleBuf = await httpsGet(p.getUrls.bundle);
  await fsp.writeFile(bundleFile, bundleBuf);

  const ref = `refs/codingpt/checkpoints/${id}`;
  const existingRepo = await isGitRepo(targetAbs);
  const hadHead = existingRepo ? await headSha(targetAbs) : null;

  if (!existingRepo) await git(['init'], { cwd: targetAbs });
  // 번들에서 체크포인트 ref 를 가져온다.
  const fetch = await git(['fetch', bundleFile, `refs/codingpt/checkpoints/*:refs/codingpt/checkpoints/*`], { cwd: targetAbs, timeout: 120000 });
  if (!fetch.ok) { await fsp.rm(bundleFile, { force: true }).catch(() => {}); throw new Error('번들 fetch 실패: ' + fetch.err.slice(0, 200)); }
  const rp = await git(['rev-parse', ref], { cwd: targetAbs });
  if (!rp.ok) { await fsp.rm(bundleFile, { force: true }).catch(() => {}); throw new Error('체크포인트 커밋을 찾지 못했습니다.'); }
  const incoming = rp.out.trim();

  // 기존 repo 에 로컬 변경이 있으면 3-way 충돌 검사.
  if (hadHead && hadHead !== incoming) {
    const conflict = await detectConflict(targetAbs, hadHead, incoming, id);
    await fsp.rm(bundleFile, { force: true }).catch(() => {});
    if (conflict.files.length) {
      conflicts.set(conflict.conflictId, { targetAbs, localHead: hadHead, incomingCommit: incoming, base: conflict.base, files: conflict.files, branch: conflict.branch });
      emitSync({ type: 'sync_conflict', conflictId: conflict.conflictId, files: conflict.files.map((f) => ({ path: f, kind: 'text' })), canBulkPick: true });
      return { conflict: true, conflictId: conflict.conflictId, files: conflict.files };
    }
    // 충돌 없음 → 자동 머지 트리 적용.
    await applyTree(targetAbs, conflict.mergedTree, [hadHead, incoming], conflict.branch);
    const sessN = await downloadAndRestoreSession(p, targetAbs);
    emitSync({ type: 'sync_progress', phase: 'materialize', checkpointId: id, pct: 100 });
    return { baseCommit: conflict.base, restored: true, merged: true, restoredSessions: sessN };
  }

  // 신규/빈 타겟 → 체크포인트 그대로 체크아웃(정상 브랜치 main 으로).
  const co = await git(['checkout', '-B', 'main', incoming], { cwd: targetAbs });
  if (!co.ok) {
    // 워킹트리가 비어있지 않아 checkout 이 막힌 경우: read-tree + checkout-index 강제.
    await git(['read-tree', incoming], { cwd: targetAbs });
    await git(['checkout-index', '-a', '-f'], { cwd: targetAbs });
    await git(['update-ref', 'refs/heads/main', incoming], { cwd: targetAbs });
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: targetAbs });
  }
  await fsp.rm(bundleFile, { force: true }).catch(() => {});

  const sessN = await downloadAndRestoreSession(p, targetAbs);
  emitSync({ type: 'sync_progress', phase: 'materialize', checkpointId: id, pct: 100 });
  return { baseCommit: hadHead, restored: true, restoredSessions: sessN };
}

async function downloadAndRestoreSession(p, targetAbs) {
  if (!p.getUrls || !p.getUrls.session) return 0;
  try {
    const buf = await httpsGet(p.getUrls.session);
    const artifact = JSON.parse(buf.toString('utf8'));
    return restoreSessionArtifact(artifact, targetAbs);
  } catch (_) { return 0; }
}

// ── 3-way 충돌 탐지(git 2.38+ merge-tree --write-tree) ──────────────────
async function detectConflict(targetAbs, localHead, incoming, checkpointId) {
  const conflictId = `cf_${checkpointId}`;
  const mb = await git(['merge-base', localHead, incoming], { cwd: targetAbs });
  const base = mb.ok ? mb.out.trim() : null;
  // merge-tree --write-tree: 성공(exit 0)이면 머지 트리 oid, 충돌(exit 1)이면 충돌 파일 목록.
  const mt = await git(['merge-tree', '--write-tree', '--name-only', localHead, incoming], { cwd: targetAbs });
  const lines = mt.out.split('\n');
  const mergedTree = (lines[0] || '').trim();
  if (mt.code === 0) return { conflictId, base, files: [], mergedTree, branch: 'main' };
  // 충돌 출력 포맷(git 2.38+ --name-only): 1줄=트리 oid, 그 다음~첫 빈 줄=충돌 파일명, 빈 줄 이후=메시지.
  const files = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === '') break; // 섹션2(파일명) 끝 — 이후는 정보 메시지라 무시.
    files.push(ln.trim());
  }
  // --name-only 미지원 구형 폴백: 파일 목록 못 뽑으면 diff 교집합으로 근사.
  if (!files.length && base) {
    const a = new Set((await git(['diff', '--name-only', base, localHead], { cwd: targetAbs })).out.split('\n').map((s) => s.trim()).filter(Boolean));
    for (const f of (await git(['diff', '--name-only', base, incoming], { cwd: targetAbs })).out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (a.has(f)) files.push(f);
    }
  }
  return { conflictId, base, files, mergedTree, branch: 'main' };
}

// 머지 트리를 워킹트리·인덱스·브랜치에 적용(충돌 없을 때, 또는 resolve 후).
async function applyTree(targetAbs, tree, parents, branch) {
  await git(['read-tree', tree], { cwd: targetAbs });
  await git(['checkout-index', '-a', '-f'], { cwd: targetAbs });
  const ctArgs = ['commit-tree', tree, '-m', 'codingpt sync merge'];
  for (const par of parents) if (par) ctArgs.push('-p', par);
  const ct = await git(ctArgs, { cwd: targetAbs, env: botEnv() });
  const commit = ct.out.trim();
  await git(['update-ref', `refs/heads/${branch || 'main'}`, commit], { cwd: targetAbs });
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch || 'main'}`], { cwd: targetAbs }).catch(() => {});
  // 워킹트리를 최종 커밋에 맞춰 인덱스 재설정.
  await git(['reset', '--mixed', commit], { cwd: targetAbs }).catch(() => {});
  return commit;
}

// ── sync.resolve ────────────────────────────────────────────────────────
async function resolve(p) {
  const conflictId = p.conflictId;
  const c = conflicts.get(conflictId);
  if (!c) throw new Error('충돌 정보를 찾을 수 없습니다(만료되었거나 이미 해결됨).');
  const { targetAbs, localHead, incomingCommit, base } = c;

  // 진 쪽(현재 로컬 상태)을 rescue 브랜치로 보존 — 되돌리기 가능.
  const rescueRef = `refs/codingpt/rescue/${conflictId}`;
  await git(['update-ref', rescueRef, localHead], { cwd: targetAbs });

  // bulk('local'|'cloud') 우선, 아니면 파일별 choices.
  const bulk = p.bulk === 'local' || p.bulk === 'cloud' ? p.bulk : null;
  const pickOf = (file) => {
    if (bulk) return bulk;
    const ch = (p.choices || []).find((x) => x.path === file);
    return ch && (ch.side === 'local' || ch.side === 'cloud') ? ch.side : 'local';
  };

  // 임시 인덱스로 머지 결과 구성: base 트리에서 시작해 파일별 승자 blob 을 stage.
  await ensureTmp();
  const idxFile = path.join(tmpDir(), `resolve-${conflictId}`);
  await fsp.rm(idxFile, { force: true }).catch(() => {});
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };
  // 자동 머지된 부분을 살리기 위해 incoming 트리를 베이스로 두고, 충돌 파일만 승자로 덮는다.
  await git(['read-tree', incomingCommit], { cwd: targetAbs, env });
  for (const file of c.files) {
    const side = pickOf(file);
    const srcCommit = side === 'local' ? localHead : incomingCommit;
    // 해당 파일 blob oid 조회 → 인덱스에 강제 stage(없으면=삭제).
    const ls = await git(['ls-tree', '-z', srcCommit, '--', file], { cwd: targetAbs });
    const entry = ls.out.replace(/\0$/, '');
    if (entry) {
      const m = entry.match(/^(\d+) blob ([0-9a-f]+)\t/);
      if (m) await git(['update-index', '--add', '--cacheinfo', m[1], m[2], file], { cwd: targetAbs, env });
    } else {
      await git(['update-index', '--force-remove', file], { cwd: targetAbs, env });
    }
  }
  const wt = await git(['write-tree'], { cwd: targetAbs, env });
  await fsp.rm(idxFile, { force: true }).catch(() => {});
  if (!wt.ok) throw new Error('머지 트리 작성 실패: ' + wt.err.slice(0, 200));
  const commit = await applyTree(targetAbs, wt.out.trim(), [localHead, incomingCommit], c.branch);

  conflicts.delete(conflictId);
  emitSync({ type: 'sync_status', state: 'clean', head: commit });
  return { resolved: c.files.length, rescueBranch: rescueRef, head: commit };
}

// ── sync.status ─────────────────────────────────────────────────────────
async function status(p) {
  const abs = fsLib.safeResolve(p.cwd || '');
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) return { state: 'clean', base: null, head: null, dirty: false };
  if (!(await isGitRepo(abs))) return { state: 'clean', base: null, head: null, dirty: false, noGit: true };
  const head = await headSha(abs);
  const porcelain = (await git(['status', '--porcelain'], { cwd: abs })).out.trim();
  const dirty = porcelain.length > 0;
  // state 는 "동기화" 상태(허브 대비)다 — 로컬 미커밋(dirty)과는 별개 축(계약 §6.1).
  //  진행 중 충돌이 이 타겟에 걸려 있으면 conflict, 아니면 clean. syncing 은 진행 이벤트로만 표기.
  let state = 'clean';
  for (const [, c] of conflicts) { if (c.targetAbs === abs) { state = 'conflict'; break; } }
  return { state, base: p.head || null, head, dirty };
}

// ── RPC 디스패치(control.js 에서 호출) ──────────────────────────────────
async function handle(method, params, ws) {
  pushWs = ws;
  const p = params || {};
  switch (method) {
    case 'sync.checkpoint': return checkpoint(p);
    case 'sync.materialize': return materialize(p);
    case 'sync.status': return status(p);
    case 'sync.resolve': return resolve(p);
    default: throw new Error('알 수 없는 sync 메서드: ' + method);
  }
}

module.exports = { handle };
