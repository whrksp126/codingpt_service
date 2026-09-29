'use strict';
if (process.platform === 'win32') {
  require('node:test')('followup.test.js: win32 스킵 — POSIX 픽스처(셔뱅 가짜 gh)', { skip: true }, () => {});
  return;
}
// F2 PR 후속(tasks.js assessFollowup·followupTick·task.run.fix·dismiss) + S2 표면(internalCreate·findRunByTsession·
//  버스 이벤트) — automation-design §4 · §9.1.
//  가짜 gh(`pr view` JSON·`api …/comments` NDJSON·`run view --log-failed` 고정 출력, `--repo` assert) + 터미널/tmux 스텁.
//  ★ 실 tmux·실 데몬·back 에 닿는 경로 없음.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-followup-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GHD = path.join(ROOT, 'gh');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(GHD, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '[user]\n\temail = dev@example.com\n\tname = Dev\n');
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-followup-${process.pid}`;
process.env.GHD = GHD;
delete process.env.CPT_FOLLOWUP;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(BIN, name), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
// 가짜 gh — 호출을 로그에 남기고, 파일 픽스처를 그대로 낸다(-q 적용 결과 = NDJSON 을 미리 만들어 둔다).
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
echo "$*" >> "$GHD/log"
need_repo() { case " $* " in *" --repo "*) ;; *) echo "missing --repo" >&2; exit 3;; esac; }
case "$1" in
  --version) echo "gh version 2.60.0"; exit 0;;
  auth) exit 0;;
  repo) echo '{"owner":{"login":"acme"},"name":"demo"}'; exit 0;;
  api)
    case "$2" in
      user) echo "tester"; exit 0;;
      */pulls/*/comments*) cat "$GHD/comments.ndjson" 2>/dev/null; exit 0;;
      */pulls/*/reviews*) cat "$GHD/reviews.ndjson" 2>/dev/null; exit 0;;
      */issues/*/comments*) cat "$GHD/issue.ndjson" 2>/dev/null; exit 0;;
    esac; exit 4;;
  pr) need_repo "$@"; case "$2" in view) cat "$GHD/pr.json"; exit 0;; esac;;
  run) need_repo "$@"; case "$2" in view) cat "$GHD/runlog.txt"; exit 0;; esac;;
esac
exit 2
`, { mode: 0o755 });

const agents = require('../agents');
agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
const taskGit = require('../task-git');
taskGit.resetCache();
const realPty = require('../pty');
const tasks = require('../tasks');
const I = tasks._internals;

// ── 스텁 ─────────────────────────────────────────────────────────────────────
const sessions = new Map(); // tsession → { command }
const raw = new Map();      // tsession → rawState
let tidSeq = 5000001;
const calls = { launch: [], input: [], back: [], notify: [] };
const bus = [];
let clock = 1790000000000;
const ptyStub = {
  sessionForCwd: realPty.sessionForCwd,
  termSession: realPty.termSession,
  createTerminal: async (ns) => {
    const index = tidSeq++;
    const session = realPty.termSession(ns, index);
    sessions.set(session, { command: 'zsh' });
    return { index, name: '', session };
  },
  handleTerminalRpc: async () => ({ ok: true }),
};
const tbStub = {
  listSessionNames: async () => [...sessions.keys()],
  info: async (name) => {
    const s = sessions.get(name);
    if (!s) throw new Error("can't find session");
    return { name, command: s.command, title: '', cols: 80, rows: 24 };
  },
  rename: async () => {},
  kill: async (n) => { sessions.delete(n); },
  capture: async () => '',
};
const asStub = {
  attachmentOf: (k) => { const s = sessions.get(k); return { attached: !!(s && s.command !== 'zsh') }; },
  rawStateOf: (k) => (raw.has(k) ? raw.get(k) : 'idle'),
  subscribe: () => () => {},
  configure: () => {},
};
function sessionByTid(tid) { for (const [k, v] of sessions) if (k.endsWith(`--t-${tid}`)) return v; return null; }
tasks.configure({
  launch: async (a) => {
    calls.launch.push(a);
    const s = sessionByTid(a.index);
    if (s) s.command = a.id === 'claude' ? '2.1.220' : a.id;
    return { ok: true, ready: true };
  },
  chatInput: async (a) => { calls.input.push(a); return { ok: true }; },
  chatDialog: async () => ({ ok: true, dialog: null }),
  keys: async () => {},
  screen: async () => '',
  backFetch: async (m, p, b) => {
    calls.back.push({ m, p, b });
    if (m === 'POST' && p === '/api/daemon/workspaces') return { id: `ws_${calls.back.length}` };
    return {};
  },
  notify: (x) => calls.notify.push(x),
  poolChanged: () => {},
  deviceId: () => 42,
  log: () => {},
  now: () => clock,
  deps: {
    pty: ptyStub, termBackend: tbStub, manifest: { forget() {} }, agentState: asStub,
    agentWatch: { agentSignalOf: () => ({ on: false }) },
    events: { emit: (type, payload) => { bus.push({ type, ...payload }); return true; } },
  },
  timings: { trustWindowMs: 60, trustPollMs: 20, trustPendingPollMs: 30, readyTimeoutMs: 400, readyPollMs: 20, readyStableMs: 40, stopDebounceMs: 20, poolCoalesceMs: 10, launchTimeoutMs: 100 },
});
tasks.start();

after(async () => {
  await I._drain();
  await I._reset();
  agents._internals.setSearchOverride(null);
  agents._internals.resetCache();
  taskGit.resetCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const call = (m, p) => tasks.rpc(m, p);
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ghLog = () => { try { return fs.readFileSync(path.join(GHD, 'log'), 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const clearGhLog = () => { try { fs.rmSync(path.join(GHD, 'log')); } catch (_) { /* noop */ } };
const writeNd = (name, items) => fs.writeFileSync(path.join(GHD, name), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
function prJson({ state = 'OPEN', head = 'aaa111', checks = [] } = {}) {
  fs.writeFileSync(path.join(GHD, 'pr.json'), JSON.stringify({
    number: 7, url: 'https://github.com/acme/demo/pull/7', state, isDraft: false, title: 't', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: null, headRefName: 'cpt/x', headRefOid: head, baseRefName: 'main',
    statusCheckRollup: checks, mergedAt: null, mergeCommit: null,
  }));
}
const failing = (name, run) => ({ name, conclusion: 'FAILURE', detailsUrl: `https://github.com/acme/demo/actions/runs/${run}/job/9` });
const passing = (name) => ({ name, conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/demo/actions/runs/1' });
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
/** 작업 레코드를 직접 심는다(worktree 는 빈 폴더 — gh 만 쓰는 경로). */
function seedRun({ state = 'review_ready', prState = 'open', command = '2.1.220', github = true } = {}) {
  seq++;
  const t6 = `fu${String(seq).padStart(4, '0')}`;
  const id = `t_abcd${t6}`;
  const dir = `.codingpt/worktrees/demo-${t6}-1`;
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'work', 'demo'), { recursive: true });
  const tid = tidSeq++;
  const tsession = realPty.termSession(realPty.sessionForCwd(dir).session, tid);
  sessions.set(tsession, { command });
  const now = clock;
  const run = {
    id: `r_fu${String(seq).padStart(6, '0')}`, idx: 1, agent: 'claude', branch: `cpt/${t6}-1`, dir, cwd: dir, baseSha: 'b'.repeat(40),
    workspaceId: 'ws_1', tid, tsession, trustPending: false, state, promptMode: 'arg', promptDelivered: true,
    promptDeliveredAt: now, launchedAt: now - 1000, copiedFiles: [], diff: null, commits: null, dirty: false, pushed: true,
    pr: prState ? { number: 7, url: 'https://github.com/acme/demo/pull/7', state: prState, isDraft: false, title: 't', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, checks: { status: 'none', total: 0, passed: 0, failed: 0, pending: 0, items: [] }, at: now } : null,
    op: null, lastOp: null, lastTurnEndedAt: null, lastActivityAt: now, reviewNotifiedAt: null, lastTurnFailed: false,
    error: null, cleanup: null, createdAt: now, updatedAt: now, opIds: [],
  };
  const task = {
    id, v: 1, title: '데모', prompt: '데모 프롬프트',
    repo: { path: 'work/demo', subdir: '', common: 'work/demo/.git', name: 'demo', remoteUrl: 'git@github.com:acme/demo.git', github: github ? { owner: 'acme', repo: 'demo' } : null },
    base: 'main', workspaceId: null, state: 'open', winnerRunId: null, error: null, createdAt: now, updatedAt: now, closedAt: null, origin: null,
    opts: { copyEnv: false, fetch: false }, runs: [run],
  };
  I.mutate((s) => { s.items.push(task); });
  return { t: task, r: run, taskId: id, runId: run.id, tsession };
}
function closeAll() {
  I.mutate((s) => { for (const t of s.items) { t.state = 'closed'; for (const r of t.runs) if (!['merged', 'discarded'].includes(r.state)) r.state = 'discarded'; } });
}
const getRun = async (taskId, runId) => (await call('task.get', { taskId })).task.runs.find((x) => x.id === runId);
async function opDone(taskId, runId, opId) {
  const until = Date.now() + 5000;
  for (;;) {
    await I._drain();
    const r = await getRun(taskId, runId);
    if (r.lastOp && r.lastOp.opId === opId && !r.op) return r;
    if (Date.now() > until) throw new Error('op 대기 시간 초과');
    await sleep(15);
  }
}
const pushes = (kind) => calls.back.filter((c) => c.p === '/api/notifications' && c.b.kind === kind);

// ══════════════════════════════════════════════════════════════════════════
test('assessFollowup(순수) — CI: 새 실패 1회 감지·같은 name@sha 재감지 없음·헤드 변경 시 해제 후 재감지 / 리뷰: 첫 관찰은 cursor 만·pending 1회 감지·30개 상한', () => {
  const t = { id: 't_x', repo: { name: 'demo' } };
  const r = { id: 'r_x', followup: null };
  const pr = (status, items) => ({ number: 7, state: 'open', checks: { status, items } });
  const f1 = [{ name: 'ci / lint', status: 'failing', url: 'https://github.com/acme/demo/actions/runs/22/job/3' }, { name: 'ok', status: 'passing' }];
  let a = tasks.assessFollowup(t, r, { pr: pr('failing', f1), headOid: 'h1', now: 1000 });
  assert.strictEqual(a.ciDetected, true);
  assert.strictEqual(a.followup.ci.status, 'failing');
  assert.deepStrictEqual(a.followup.ci.failed, [{ name: 'ci / lint', url: 'https://github.com/acme/demo/actions/runs/22/job/3', runId: '22' }]);
  assert.deepStrictEqual(a.followup.ci.seen, ['ci / lint@h1']);
  assert.strictEqual(a.followup.reviews.cursor, iso(1000), '첫 관찰: cursor = now');
  assert.strictEqual(a.reviewsDetected, false);
  r.followup = a.followup;
  a = tasks.assessFollowup(t, r, { pr: pr('failing', f1), headOid: 'h1', now: 2000 });
  assert.strictEqual(a.ciDetected, false, '같은 name@sha 재감지 없음');
  // 해제(무시) 뒤 같은 실패 → 여전히 seen → 감지 없음
  r.followup = { ...a.followup, ci: { ...a.followup.ci, status: null, dismissedAt: 2000 } };
  a = tasks.assessFollowup(t, r, { pr: pr('failing', f1), headOid: 'h1', now: 3000 });
  assert.strictEqual(a.ciDetected, false);
  assert.strictEqual(a.followup.ci.status, null);
  // 헤드가 바뀌고 pending → 해제, 새 헤드에서 실패 → 재감지
  r.followup = a.followup;
  a = tasks.assessFollowup(t, r, { pr: pr('pending', [{ name: 'ci / lint', status: 'pending' }]), headOid: 'h2', now: 4000 });
  assert.strictEqual(a.followup.ci.status, null);
  r.followup = a.followup;
  a = tasks.assessFollowup(t, r, { pr: pr('failing', f1), headOid: 'h2', now: 5000 });
  assert.strictEqual(a.ciDetected, true);
  assert.strictEqual(a.followup.ci.detectedAt, 5000);
  assert.strictEqual(a.followup.ci.dismissedAt, null);
  // 통과 → 해제
  r.followup = a.followup;
  a = tasks.assessFollowup(t, r, { pr: pr('passing', [{ name: 'ci / lint', status: 'passing' }]), headOid: 'h2', now: 5500 });
  assert.strictEqual(a.followup.ci.status, null);
  assert.deepStrictEqual(a.followup.ci.failed, []);
  // 리뷰 — cursor 이전 코멘트는 무시, 이후 2개 → pending + 감지 1회
  r.followup = a.followup;
  const cm = (id, at, extra = {}) => ({ id, kind: 'review_comment', author: 'alice', bot: false, path: 'src/a.ts', line: 12, body: `본문 ${id}\n둘째 줄`, url: `u${id}`, at: iso(at), ...extra });
  a = tasks.assessFollowup(t, r, { pr: pr('none', []), comments: [cm(1, 500), cm(2, 6000)], reviews: [{ id: 3, kind: 'review', author: 'bot', bot: true, state: 'CHANGES_REQUESTED', body: '', url: 'u3', at: iso(6100) }], now: 7000 });
  assert.strictEqual(a.reviewsDetected, true);
  assert.deepStrictEqual(a.followup.reviews.pending.map((x) => x.id), [2, 3]);
  assert.strictEqual(a.followup.reviews.pending[0].bodyHead, '본문 2\n둘째 줄');
  assert.strictEqual(a.followup.reviews.pending[0].line, 12);
  assert.strictEqual(a.followup.reviews.pending[1].state, 'CHANGES_REQUESTED');
  assert.strictEqual(a.followup.reviews.detectedAt, 7000);
  r.followup = a.followup;
  a = tasks.assessFollowup(t, r, { pr: pr('none', []), comments: [cm(2, 6000), cm(4, 7500)], now: 8000 });
  assert.strictEqual(a.reviewsDetected, false, 'pending 이 남아 있는 동안 재알림 없음');
  assert.deepStrictEqual(a.followup.reviews.pending.map((x) => x.id), [2, 3, 4]);
  // 30개 상한 — 오래된 것부터 버리고 overflow
  r.followup = a.followup;
  const many = Array.from({ length: 40 }, (_, i) => cm(100 + i, 9000 + i));
  a = tasks.assessFollowup(t, r, { pr: pr('none', []), comments: many, now: 10000 });
  assert.strictEqual(a.followup.reviews.pending.length, 30);
  assert.strictEqual(a.followup.reviews.overflow, 13);
  assert.ok(a.followup.reviews.pending.every((x) => x.bodyHead.length <= 300));
  // PR 이 닫혔으면 판정 없음
  assert.strictEqual(tasks.assessFollowup(t, r, { pr: { state: 'closed', checks: { status: 'failing', items: f1 } }, headOid: 'h9', now: 1 }).ciDetected, false);
});

test('백그라운드 틱 — open PR run 만(gh 인증 시), CI 새 실패 → task_ci_failed 푸시 1회 + pr.ci_failed 이벤트, 코멘트 → task_review_comments 1회, 틱당 상한', async () => {
  closeAll();
  const A = seedRun({ state: 'review_ready' });
  const B = seedRun({ state: 'review_ready', prState: 'closed' });
  const C = seedRun({ state: 'running', prState: null });
  const D = seedRun({ state: 'failed' });
  clearGhLog(); calls.back.length = 0; bus.length = 0;
  prJson({ head: 'aaa111', checks: [failing('ci / lint', 22), passing('ci / test')] });
  writeNd('comments.ndjson', []); writeNd('reviews.ndjson', []); writeNd('issue.ndjson', []);
  let res = await I.followupTick();
  assert.strictEqual(res.polled, 1, JSON.stringify(res));
  const views = ghLog().filter((l) => l.startsWith('pr view'));
  assert.strictEqual(views.length, 1, '대상 = open PR ∧ running/review_ready 만');
  assert.match(views[0], /--repo acme\/demo 7 --json/);
  let r = await getRun(A.taskId, A.runId);
  assert.strictEqual(r.followup.ci.status, 'failing');
  assert.deepStrictEqual(r.followup.ci.failed.map((x) => x.runId), ['22']);
  assert.strictEqual(r.followup.reviews.cursor, iso(clock));
  assert.strictEqual(pushes('task_ci_failed').length, 1);
  const pb = pushes('task_ci_failed')[0].b;
  assert.strictEqual(pb.title, '검사 실패 · Claude');
  assert.strictEqual(pb.subtitle, 'demo · PR #7');
  assert.strictEqual(pb.deeplink, `codingpt://task/${A.taskId}?host=42&run=${A.runId}`);
  assert.ok(!JSON.stringify(pb).includes('ci / lint'), '알림에 검사 이름·로그 없음');
  assert.deepStrictEqual(bus.filter((e) => e.type === 'pr.ci_failed').map((e) => [e.task.id, e.run.id, e.ci.status]), [[A.taskId, A.runId, 'failing']]);
  for (const x of [B, C, D]) assert.strictEqual((await getRun(x.taskId, x.runId)).followup, null);
  // 두 번째 틱 — 같은 실패는 재알림 없음. 코멘트 2개(cursor 이후) → 리뷰 감지 1회
  clock += 60000;
  writeNd('comments.ndjson', [{ id: 11, kind: 'review_comment', author: 'alice', bot: false, path: 'src/a.ts', line: 3, body: 'null 체크', url: 'u11', at: iso(clock - 1000) }]);
  writeNd('issue.ndjson', [{ id: 12, kind: 'issue_comment', author: 'bob', bot: false, body: '테스트도', url: 'u12', at: iso(clock - 500) }]);
  res = await I.followupTick();
  assert.strictEqual(pushes('task_ci_failed').length, 1, '재알림 없음');
  assert.strictEqual(pushes('task_review_comments').length, 1);
  assert.strictEqual(pushes('task_review_comments')[0].b.title, '리뷰 코멘트 2개 · Claude');
  r = await getRun(A.taskId, A.runId);
  assert.deepStrictEqual(r.followup.reviews.pending.map((x) => x.id), [11, 12]);
  assert.ok(ghLog().some((l) => /^api repos\/acme\/demo\/pulls\/7\/comments\?per_page=100&since=/.test(l) && / --paginate -q /.test(l)), 'since= + -q 필드만');
  assert.ok(bus.some((e) => e.type === 'pr.review_comments' && e.reviews.pending.length === 2));
  // 세 번째 틱 — 같은 코멘트 재감지 없음
  await I.followupTick();
  assert.strictEqual(pushes('task_review_comments').length, 1);
  // 틱당 상한 — polledAt 오래된 순으로 N 개만
  closeAll();
  const X = seedRun({ state: 'review_ready' });
  const Y = seedRun({ state: 'running' });
  tasks.configure({ timings: { followupPerTick: 1 } });
  try {
    assert.strictEqual((await I.followupTick()).polled, 1);
    assert.strictEqual((await I.followupTick()).polled, 1);
    assert.ok((await getRun(X.taskId, X.runId)).followup && (await getRun(Y.taskId, Y.runId)).followup, '두 틱에 걸쳐 둘 다 본다');
  } finally { tasks.configure({ timings: { followupPerTick: 10 } }); }
  closeAll();
});

test('task.run.fix — 로그(run view --log-failed, --repo)·코멘트를 한국어 고정 본문으로 에이전트에게(chatInput) → running·fixOpId·pending→seenIds·lastOp(fix)', async () => {
  closeAll();
  const A = seedRun({ state: 'review_ready' });
  prJson({ head: 'bbb222', checks: [failing('ci / lint', 33)] });
  writeNd('comments.ndjson', []); writeNd('reviews.ndjson', []); writeNd('issue.ndjson', []);
  await I.followupTick();
  clock += 1000;
  writeNd('reviews.ndjson', [{ id: 21, kind: 'review', author: 'coderabbit', bot: true, state: 'CHANGES_REQUESTED', body: '에러 처리 누락', url: 'u21', at: iso(clock - 10) }]);
  await I.followupTick();
  const lines = Array.from({ length: 300 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\n');
  fs.writeFileSync(path.join(GHD, 'runlog.txt'), lines + '\n');
  clearGhLog(); calls.input.length = 0; bus.length = 0;
  // 전제 검사
  await assert.rejects(() => call('task.run.fix', { opId: uuid(), taskId: A.taskId, runId: A.runId, what: 'x' }), (e) => e.code === 'BAD_PARAMS');
  raw.set(A.tsession, 'working');
  await assert.rejects(() => call('task.run.fix', { opId: uuid(), taskId: A.taskId, runId: A.runId, what: 'ci' }), (e) => e.code === 'AGENT_BUSY');
  raw.delete(A.tsession);
  const opId = uuid();
  const acc = await call('task.run.fix', { opId, taskId: A.taskId, runId: A.runId, what: 'both' });
  assert.strictEqual(acc.accepted, true);
  assert.strictEqual(acc.run.op.kind, 'fix');
  await assert.rejects(() => call('task.run.fix', { opId: uuid(), taskId: A.taskId, runId: A.runId, what: 'ci' }), (e) => e.code === 'RUN_BUSY');
  const r = await opDone(A.taskId, A.runId, opId);
  assert.strictEqual(r.lastOp.ok, true, JSON.stringify(r.lastOp));
  assert.strictEqual(r.lastOp.kind, 'fix');
  assert.deepStrictEqual(Object.keys(r.lastOp.result).sort(), ['bytes', 'checks', 'comments', 'delivered', 'what']);
  assert.deepStrictEqual({ d: r.lastOp.result.delivered, c: r.lastOp.result.checks, m: r.lastOp.result.comments }, { d: true, c: 1, m: 1 });
  assert.ok(ghLog().some((l) => l === 'run view 33 --repo acme/demo --log-failed'), ghLog().join('\n'));
  assert.strictEqual(calls.input.length, 1);
  const text = calls.input[0].text;
  assert.strictEqual(calls.input[0].submit, true);
  assert.match(text, /^CI 실패 수정 요청 \(PR #7\)\n실패한 검사: ci \/ lint — https:\/\/github\.com\/acme\/demo\/actions\/runs\/33\/job\/9/);
  assert.match(text, /--- ci \/ lint 로그\(마지막 200줄\) ---\nline 100\n/);
  assert.ok(!text.includes('line 99\n'), '마지막 200줄');
  assert.ok(!text.includes('\x1b['), 'ANSI 제거');
  assert.match(text, /리뷰 코멘트 반영 요청 \(PR #7\)\n- @coderabbit \(review, CHANGES_REQUESTED\): 에러 처리 누락/);
  assert.match(text, /위 내용을 반영해 고치고, 커밋·푸시까지 해 주세요\. 원인을 모르겠으면 이유를 적고 멈추세요\.$/);
  assert.strictEqual(r.state, 'running', 'review_ready → running');
  assert.strictEqual(r.followup.ci.status, null);
  assert.strictEqual(r.followup.ci.fixOpId, opId);
  assert.deepStrictEqual(r.followup.reviews.pending, []);
  assert.ok(r.followup.reviews.seenIds.includes(21));
  assert.strictEqual(r.followup.reviews.fixOpId, opId);
  // 재생 — 같은 opId 는 실행 1회
  const rep = await call('task.run.fix', { opId, taskId: A.taskId, runId: A.runId, what: 'both' });
  assert.strictEqual(rep.replay, true);
  assert.strictEqual(calls.input.length, 1);
  // 보낼 것이 없으면 FOLLOWUP_NOTHING
  await assert.rejects(() => call('task.run.fix', { opId: uuid(), taskId: A.taskId, runId: A.runId, what: 'both' }), (e) => e.code === 'FOLLOWUP_NOTHING');
  // PR 없음
  const N = seedRun({ state: 'review_ready', prState: null });
  await assert.rejects(() => call('task.run.fix', { opId: uuid(), taskId: N.taskId, runId: N.runId, what: 'ci' }), (e) => e.code === 'PR_NOT_FOUND');
  closeAll();
});

test('task.run.fix — agentGone(셸만 남음)이면 같은 op 안에서 reopen(--continue) 선행 후 배달 · 준비 안 되면 PROMPT_NOT_DELIVERED', async () => {
  closeAll();
  const A = seedRun({ state: 'review_ready', command: 'zsh' });
  I.mutate(() => {
    A.r.followup = { ...I.emptyFollowup(), ci: { ...I.emptyFollowup().ci, status: 'failing', failed: [{ name: 'lint', url: null, runId: null }], seen: ['lint@x'] } };
  });
  calls.launch.length = 0; calls.input.length = 0;
  const opId = uuid();
  await call('task.run.fix', { opId, taskId: A.taskId, runId: A.runId, what: 'ci' });
  const r = await opDone(A.taskId, A.runId, opId);
  assert.strictEqual(r.lastOp.ok, true, JSON.stringify(r.lastOp));
  assert.strictEqual(calls.launch.length, 1);
  assert.deepStrictEqual(calls.launch[0].args, ['--continue'], '대화 이어가기');
  assert.strictEqual(calls.input.length, 1);
  assert.match(calls.input[0].text, /실패한 검사: lint\n/);
  // 준비 판정 실패(런치가 에이전트를 못 띄움) → PROMPT_NOT_DELIVERED, 셸에 타이핑하지 않는다
  const B = seedRun({ state: 'review_ready', command: 'zsh' });
  I.mutate(() => { B.r.followup = { ...I.emptyFollowup(), ci: { ...I.emptyFollowup().ci, status: 'failing', failed: [{ name: 'lint', url: null, runId: null }] } }; });
  tasks.configure({ launch: async (a) => { calls.launch.push(a); return { ok: true }; } });
  calls.input.length = 0;
  const op2 = uuid();
  await call('task.run.fix', { opId: op2, taskId: B.taskId, runId: B.runId, what: 'ci' });
  const r2 = await opDone(B.taskId, B.runId, op2);
  assert.strictEqual(r2.lastOp.ok, false);
  assert.strictEqual(r2.lastOp.code, 'PROMPT_NOT_DELIVERED');
  assert.strictEqual(calls.input.length, 0);
  assert.strictEqual(r2.followup.ci.status, 'failing', '배달 실패면 해제하지 않는다([다시 시도])');
  tasks.configure({
    launch: async (a) => { calls.launch.push(a); const s = sessionByTid(a.index); if (s) s.command = '2.1.220'; return { ok: true, ready: true }; },
  });
  closeAll();
});

test('task.run.followup.dismiss — ci/reviews 해제, 같은 코멘트 재감지·재알림 없음, 이후 새 코멘트는 다시 감지', async () => {
  closeAll();
  const A = seedRun({ state: 'review_ready' });
  prJson({ head: 'ccc333', checks: [failing('ci / e2e', 44)] });
  writeNd('comments.ndjson', []); writeNd('reviews.ndjson', []); writeNd('issue.ndjson', []);
  await I.followupTick();
  clock += 1000;
  writeNd('issue.ndjson', [{ id: 31, kind: 'issue_comment', author: 'carol', bot: false, body: 'a', url: 'u', at: iso(clock - 1) }]);
  await I.followupTick();
  calls.back.length = 0;
  assert.deepStrictEqual(await call('task.run.followup.dismiss', { taskId: A.taskId, runId: A.runId, what: 'both' }), { ok: true });
  let r = await getRun(A.taskId, A.runId);
  assert.strictEqual(r.followup.ci.status, null);
  assert.ok(r.followup.ci.dismissedAt);
  assert.deepStrictEqual(r.followup.reviews.pending, []);
  assert.ok(r.followup.reviews.seenIds.includes(31));
  await I.followupTick();
  r = await getRun(A.taskId, A.runId);
  assert.strictEqual(r.followup.ci.status, null, '같은 실패 재감지 없음');
  assert.deepStrictEqual(r.followup.reviews.pending, []);
  assert.strictEqual(pushes('task_ci_failed').length + pushes('task_review_comments').length, 0);
  clock += 1000;
  writeNd('issue.ndjson', [{ id: 31, kind: 'issue_comment', author: 'carol', bot: false, body: 'a', url: 'u', at: iso(clock - 1001) }, { id: 32, kind: 'issue_comment', author: 'carol', bot: false, body: 'b', url: 'u', at: iso(clock - 1) }]);
  await I.followupTick();
  r = await getRun(A.taskId, A.runId);
  assert.deepStrictEqual(r.followup.reviews.pending.map((x) => x.id), [32]);
  assert.strictEqual(pushes('task_review_comments').length, 1);
  await assert.rejects(() => call('task.run.followup.dismiss', { taskId: A.taskId, runId: A.runId, what: 'all' }), (e) => e.code === 'BAD_PARAMS');
  closeAll();
});

test('composeFixText — 28000B 상한(로그부터 자름·꼬리 문장 유지) · 코멘트만으로 넘쳐도 상한', () => {
  const big = 'ㄱ'.repeat(12000); // 36KB
  const t = tasks.composeFixText({ prNumber: 9, what: 'both', failed: [{ name: 'a', url: 'u' }, { name: 'b', url: null }],
    logs: [{ name: 'a', text: big }, { name: 'b', text: big }], comments: [{ kind: 'issue_comment', author: 'x', bodyHead: '고쳐 주세요' }] });
  assert.ok(Buffer.byteLength(t, 'utf8') <= 28000, String(Buffer.byteLength(t, 'utf8')));
  assert.match(t, /… \(잘림\)/);
  assert.match(t, /- @x: 고쳐 주세요/);
  assert.match(t, /원인을 모르겠으면 이유를 적고 멈추세요\.$/);
  const many = Array.from({ length: 300 }, (_, i) => ({ kind: 'review_comment', author: 'a', path: 'p', line: i, bodyHead: '가'.repeat(300) }));
  const t2 = tasks.composeFixText({ prNumber: 9, what: 'reviews', comments: many });
  assert.ok(Buffer.byteLength(t2, 'utf8') <= 28000);
  assert.match(t2, /멈추세요\.$/);
  assert.ok(!t2.includes('CI 실패'), "what:'reviews' 면 CI 절 없음");
});

test('internalCreate(origin automation·subdir·base 기본) · task.created 이벤트 · findRunByTsession · 릴레이 task.create 는 automation origin 거부 · 와이어 origin/followup', async () => {
  closeAll();
  const dir = path.join(ROOT, 'work', 'mono');
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'a.txt'), 'a\n');
  G(dir, 'init', '-q', '-b', 'trunk');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-q', '-m', 'init');
  bus.length = 0;
  const origin = { kind: 'automation', automationId: 'a_k3j9x2m1qa', firingId: 'f_123', depth: 1 };
  const res = await tasks.internalCreate({ repo: 'work/mono', subdir: 'pkg', agents: [{ id: 'claude', count: 1 }], title: '자동 작업', prompt: '이슈 처리' }, origin);
  assert.deepStrictEqual(res.task.origin, origin);
  assert.strictEqual(res.task.base, 'trunk', 'base 생략 → 현재 브랜치');
  assert.strictEqual(res.task.repo.subdir, 'pkg');
  await I._drain();
  const ev = bus.find((e) => e.type === 'task.created' && e.task.id === res.task.id);
  assert.ok(ev, JSON.stringify(bus.map((e) => e.type)));
  assert.deepStrictEqual(ev.origin, origin);
  assert.ok(!('prompt' in ev.task), '이벤트의 task 는 TaskLite');
  const t = (await call('task.get', { taskId: res.task.id })).task;
  assert.deepStrictEqual(t.origin, origin);
  assert.strictEqual(t.runs[0].followup, null, 'followup 은 와이어에 항상 실린다(없으면 null)');
  const hit = tasks.findRunByTsession(t.runs[0].tsession);
  assert.strictEqual(hit.task.id, t.id);
  assert.strictEqual(hit.run.id, t.runs[0].id);
  assert.deepStrictEqual(hit.task.origin, origin);
  assert.strictEqual(tasks.findRunByTsession('cpt-nope--t-1'), null);
  // 릴레이 경로: dispatch origin 만
  const d = await call('task.create', { opId: uuid(), repo: 'work/mono', base: 'trunk', prompt: 'x', agents: [{ id: 'codex', count: 1 }], origin: { kind: 'dispatch', planId: 'p_abcdefghij' } });
  assert.deepStrictEqual(d.task.origin, { kind: 'dispatch', planId: 'p_abcdefghij', depth: 0 });
  await assert.rejects(() => call('task.create', { opId: uuid(), repo: 'work/mono', base: 'trunk', prompt: 'x', agents: [{ id: 'codex', count: 1 }], origin }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => tasks.internalCreate({ repo: 'work/mono', agents: [{ id: 'claude' }], prompt: 'x' }, { kind: 'automation', automationId: 'a_x', depth: 3 }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => tasks.internalCreate({ repo: 'work/mono', subdir: '../..', agents: [{ id: 'claude' }], prompt: 'x' }, origin), (e) => e.code === 'BAD_PARAMS');
  await I._drain();
  // activeReasons — 활성 run 이 없으면 빈 목록, op 가 있으면 task:<id>
  closeAll();
  assert.deepStrictEqual(tasks.activeReasons(), []);
  I.mutate((s) => { const x = s.items.find((y) => y.id === t.id); x.runs[0].state = 'review_ready'; x.runs[0].op = { opId: 'o', kind: 'fix', startedAt: 1 }; });
  assert.deepStrictEqual(tasks.activeReasons(), [`task:${t.id}`]);
  I.mutate((s) => { const x = s.items.find((y) => y.id === t.id); x.runs[0].op = null; });
  raw.set(t.runs[0].tsession, 'working');
  assert.deepStrictEqual(tasks.activeReasons(), [`task:${t.id}`]);
  raw.delete(t.runs[0].tsession);
  closeAll();
});
