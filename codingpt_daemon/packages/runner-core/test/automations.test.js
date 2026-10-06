'use strict';
// ── win32 CI 스킵 가드 — POSIX 픽스처(셔뱅 가짜 gh/claude·/usr/bin 탐색·유닉스 소켓). tasks.test.js 와 같은 사유.
if (process.platform === 'win32') {
  require('node:test')('automations.test.js: win32 스킵 — POSIX 픽스처', { skip: true }, () => {});
  return;
}

// 자동화 엔진(automations.js) — 설계 정본 docs/automation-design.md §5·§9.1.
//  가짜 시계(now 주입) + 작업 생성은 스텁(tasks.internalCreate) + 실제 git(임시 저장소·bare origin) + 가짜 gh.
//  ★ 실 tmux(-L codingpt)·실 데몬·back 에 닿는 경로는 없다(격리 소켓 이름까지 바꿔 둔다).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

// ── 격리(require 전에!) ──────────────────────────────────────────────────────
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-auto-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
const GH_LOG = path.join(ROOT, 'gh.log');
const GH_ISSUES = path.join(ROOT, 'issues.json');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '[user]\n\temail = dev@example.com\n\tname = Dev\n');
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-auto-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_LAN_SCOPE = 'off';
process.env.GH_LOG = GH_LOG;
process.env.GH_ISSUES = GH_ISSUES;
delete process.env.CPT_E2EE;
delete process.env.CPT_AUTOMATIONS;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });
fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9', deviceToken: 'cptd_test', deviceId: 42 }), { mode: 0o600 });

for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(BIN, name), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1" in
  --version) echo "gh version 2.60.0"; exit 0;;
  auth) exit 0;;
  repo) echo '{"owner":{"login":"acme"},"name":"demo"}'; exit 0;;
  api)
    case "$2" in
      user) echo "tester"; exit 0;;
      repos/*) cat "$GH_ISSUES"; exit 0;;
    esac;;
esac
exit 2
`, { mode: 0o755 });

const agents = require('../agents');
agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
const taskGit = require('../task-git');
taskGit.resetCache();
const events = require('../events');
const auto = require('../automations');
const I = auto._internals;

// ── 실제 git 저장소(work/codingpt + bare origin) ─────────────────────────────
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const REPO = 'work/codingpt';
const REPO_DIR = path.join(ROOT, REPO);
const BARE = path.join(ROOT, 'origin.git');
fs.mkdirSync(REPO_DIR, { recursive: true });
G(REPO_DIR, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'one\n');
G(REPO_DIR, 'add', '-A');
G(REPO_DIR, 'commit', '-q', '-m', 'init');
G(ROOT, 'init', '-q', '--bare', '-b', 'main', BARE);
G(REPO_DIR, 'remote', 'add', 'origin', BARE);
G(REPO_DIR, 'push', '-q', '-u', 'origin', 'main');

// 자동화 출신 작업(AUTO_LOOP 판정용) — 실제 tasks.js 스토어에 미리 넣어 둔다(cpt-server 게이트가 findRunByTsession 으로 읽는다).
const LOOP_TSESSION = 'cpt-codingpt-worktrees-codingpt-l00p01-1--t-1000777';
fs.writeFileSync(path.join(STATE, 'tasks.json'), JSON.stringify({
  v: 1, savedAt: 1, createOps: [],
  items: [{
    id: 't_l00pl00p01', v: 1, title: '자동화가 만든 작업', prompt: 'x',
    repo: { path: REPO, subdir: '', common: `${REPO}/.git`, name: 'codingpt', remoteUrl: null, github: null },
    base: 'main', workspaceId: null, state: 'open', winnerRunId: null, error: null, createdAt: 1, updatedAt: 1, closedAt: null,
    opts: { copyEnv: true, fetch: false },
    origin: { kind: 'automation', automationId: 'a_zzzzzzzzzz', firingId: 'f_zzzzzzzzzz', depth: 1 },
    runs: [{
      id: 'r_l00p0001', idx: 1, agent: 'claude', branch: 'cpt/l00p01-1', dir: '.codingpt/worktrees/codingpt-l00p01-1',
      cwd: '.codingpt/worktrees/codingpt-l00p01-1', baseSha: null, workspaceId: null, tid: 1000777, tsession: LOOP_TSESSION,
      trustPending: false, state: 'running', promptMode: 'arg', promptDelivered: true, promptDeliveredAt: 1, launchedAt: 1,
      copiedFiles: [], diff: null, commits: null, dirty: false, pushed: false, pr: null, op: null, lastOp: null,
      lastTurnEndedAt: null, lastActivityAt: 1, reviewNotifiedAt: null, lastTurnFailed: false, error: null, cleanup: null,
      createdAt: 1, updatedAt: 1, opIds: [],
    }],
  }],
}), { mode: 0o600 });

// ── 스텁 ─────────────────────────────────────────────────────────────────────
let NOW = Date.parse('2026-09-29T00:00:00Z'); // 서울 화요일 09:00
let serverCaps = [];
const created = [];     // internalCreate 호출 [{params, origin}]
const back = [];        // backFetch 호출
const notified = [];    // automations.changed
const inputs = [];      // chatInput
let createFail = null;  // () => Error | null
let notifyGate = null;  // auto_notify 를 붙잡아 두는 promise(동시 실행 가드 검증)
const fakeTaskStore = { items: [] };
const attach = {};      // tsession → attachmentOf
const rawState = {};    // tsession → rawStateOf

const tasksStub = {
  internalCreate: async (params, origin) => {
    if (createFail) { const e = createFail(); if (e) throw e; }
    const n = created.length + 1;
    const id = `t_${String(n).padStart(10, '0')}`;
    created.push({ params, origin });
    const task = { id, title: params.title || '', repo: { path: params.repo, subdir: '' }, origin, runs: [{ id: `r_${String(n).padStart(8, '0')}`, agent: params.agents[0].id }] };
    fakeTaskStore.items.push(task);
    return { task };
  },
  _internals: { load: () => fakeTaskStore },
};

function wire() {
  auto.configure({
    notify: (x) => notified.push(x),
    backFetch: async (m, p, b) => {
      back.push({ m, p, b });
      if (b && b.kind === 'auto_notify' && notifyGate) await notifyGate;
      return {};
    },
    deviceId: () => 42,
    log: () => {},
    tasks: tasksStub,
    chatInput: async (a) => { inputs.push(a); return { ok: true }; },
    serverCaps: () => serverCaps,
    now: () => NOW,
    deps: {
      agentState: {
        attachmentOf: (k) => attach[k] || { attached: false, agent: null },
        rawStateOf: (k) => (k in rawState ? rawState[k] : null),
      },
      waitReady: async () => true,
    },
    timings: { firstPollMs: 3600 * 1000 },
  });
}
wire();

after(async () => {
  await I._reset();
  events._reset();
  agents._internals.setSearchOverride(null);
  agents._internals.resetCache();
  taskGit.resetCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const call = (m, p, meta) => auto.rpc(m, p || {}, meta);
async function reset() {
  await I._reset();
  events._reset();
  events.configure({ log: () => {} });
  for (const f of [I.storeFile(), I.logFile(), `${I.logFile()}.1`]) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
  created.length = 0; back.length = 0; notified.length = 0; inputs.length = 0; fakeTaskStore.items.length = 0;
  createFail = null; notifyGate = null; serverCaps = [];
  NOW = Date.parse('2026-09-29T00:00:00Z');
  I.timings.logMaxBytes = 2 * 1024 * 1024;
  wire();
}
async function create(draft, meta) { return (await call('auto.create', { opId: uuid(), draft }, meta)).automation; }
const get = (id) => I.load().items.find((a) => a.id === id);
const backOf = (kind) => back.filter((x) => x.b && x.b.kind === kind);
const logLines = () => fs.readFileSync(I.logFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const NOTIFY = (title = 'n') => ({ type: 'notify', title });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor 시간 초과');
    await sleep(10);
  }
}

// ── 스케줄 ───────────────────────────────────────────────────────────────────
test('스케줄 firing(가짜 시계) → tasks.internalCreate(origin depth 1) + 매크로 {prev.taskId} + 금지 문구', async () => {
  await reset();
  const a = await create({
    name: '매일 아침 정리',
    trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'Asia/Seoul' },
    actions: [
      { type: 'task.create', repo: REPO, title: '정리 {now}', prompt: '할 일: {auto.name}' },
      { type: 'notify', title: '작업 {prev.taskId} 시작', subtitle: '{repo.name}' },
    ],
    guards: { cooldownMs: 0 },
  });
  assert.match(a.id, /^a_[0-9a-z]{10}$/);
  assert.strictEqual(new Date(a.state.nextRunAt).toISOString(), '2026-09-30T00:00:00.000Z', '지금(09:00 정각)은 제외 — 다음날');
  assert.deepStrictEqual(a.createdBy.kind, 'user');
  NOW = a.state.nextRunAt - 1000;
  I.tick(); await I._drain();
  assert.strictEqual(created.length, 0, '아직 이르다');
  NOW = a.state.nextRunAt + 5000;
  I.tick(); I.tick(); await I._drain();
  assert.strictEqual(created.length, 1, '겹친 틱에도 한 번');
  const c = created[0];
  assert.deepStrictEqual({ ...c.origin, firingId: 'x' }, { kind: 'automation', automationId: a.id, firingId: 'x', depth: 1 });
  assert.match(c.origin.firingId, /^f_[0-9a-z]{10}$/);
  assert.strictEqual(c.params.repo, REPO);
  assert.strictEqual(c.params.base, 'main', 'base:null → 저장소 현재 브랜치');
  assert.strictEqual(c.params.opId, `auto_${c.origin.firingId}_0`);
  assert.ok(c.params.prompt.startsWith('할 일: 매일 아침 정리\n\n'));
  assert.ok(c.params.prompt.endsWith(I.LOOP_NOTE('매일 아침 정리')), '자동화 작업 프롬프트 끝에 금지 문구');
  assert.strictEqual(c.params.title, '정리 2026-09-30T09:00:05+09:00');
  const n = backOf('auto_notify');
  assert.strictEqual(n.length, 1);
  assert.deepStrictEqual(n[0].b, { source: 'agent', kind: 'auto_notify', title: '작업 t_0000000001 시작', subtitle: 'codingpt', deeplink: `codingpt://auto/${a.id}?host=42` });
  const st = get(a.id).state;
  assert.strictEqual(st.inflight, 0);
  assert.strictEqual(st.runsToday, 1);
  assert.strictEqual(st.dayKey, '2026-09-30');
  assert.strictEqual(new Date(st.nextRunAt).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepStrictEqual(st.lastResult.steps, [{ type: 'task.create', ok: true, taskId: 't_0000000001' }, { type: 'notify', ok: true }]);
  assert.deepStrictEqual(st.lastResult.taskIds, ['t_0000000001']);
  assert.ok(notified.some((x) => x.reason === 'fired') && notified.some((x) => x.reason === 'result'));
  const stages = logLines().filter((l) => l.autoId === a.id).map((l) => l.stage);
  assert.deepStrictEqual(stages, ['created', 'start', 'step', 'step', 'end']);
  assert.ok(!fs.readFileSync(I.logFile(), 'utf8').includes('할 일'), '감사 로그에 프롬프트 본문 없음');
});

test('놓친 스케줄 — once(24h 안 1회 실행)·skip·24h 초과·일회(at) 실행 후 꺼짐', async () => {
  await reset();
  const mk = (missed) => create({ trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'Asia/Seoul', ...(missed ? { missed } : {}) }, actions: [NOTIFY()], guards: { cooldownMs: 0 } });
  const once = await mk(null);
  const skip = await mk('skip');
  const old = await mk('once');
  I.mutate(() => {
    get(once.id).state.nextRunAt = NOW - 2 * 3600 * 1000;
    get(skip.id).state.nextRunAt = NOW - 2 * 3600 * 1000;
    get(old.id).state.nextRunAt = NOW - 25 * 3600 * 1000;
  });
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 1, 'once 만 따라잡는다');
  assert.ok(get(once.id).state.lastResult.ok);
  assert.ok(logLines().some((l) => l.autoId === once.id && l.stage === 'start' && l.message === 'missed'));
  for (const id of [skip.id, old.id]) {
    assert.strictEqual(get(id).state.lastResult, null);
    assert.ok(logLines().some((l) => l.autoId === id && l.stage === 'skip' && l.code === 'MISSED'), id);
    assert.ok(get(id).state.nextRunAt > NOW, '다음 시각으로 건너뜀');
  }
  // 일회(at)
  const at = await create({ trigger: { type: 'schedule', at: NOW + 60000, tz: 'Asia/Seoul' }, actions: [NOTIFY('once')], guards: { cooldownMs: 0 } });
  assert.strictEqual(at.state.nextRunAt, NOW + 60000);
  NOW += 61000;
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').filter((x) => x.b.title === 'once').length, 1);
  assert.strictEqual(get(at.id).enabled, false, '일회는 실행 후 꺼진다');
  assert.strictEqual(get(at.id).state.nextRunAt, null);
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').filter((x) => x.b.title === 'once').length, 1);
  await assert.rejects(() => create({ trigger: { type: 'schedule', at: NOW - 3600 * 1000, tz: 'UTC' }, actions: [NOTIFY()] }), (e) => e.code === 'AUTO_BAD_TRIGGER');
});

// ── 가드 ─────────────────────────────────────────────────────────────────────
test('가드 — 하루 상한(lastResult AUTO_RATE_LIMITED)·runNow 는 상한 무시·날짜 넘어가면 리셋·쿨다운은 미룸만', async () => {
  await reset();
  const a = await create({ trigger: { type: 'pr.ci_failed', repo: null }, actions: [NOTIFY()], guards: { maxRunsPerDay: 2, cooldownMs: 0 } });
  assert.strictEqual((await I.fire(a.id, { source: 't' })).started, true);
  assert.strictEqual((await I.fire(a.id, { source: 't' })).started, true);
  const r3 = await I.fire(a.id, { source: 't' });
  assert.deepStrictEqual(r3, { started: false, code: 'AUTO_RATE_LIMITED', defer: true });
  assert.strictEqual(get(a.id).state.lastResult.code, 'AUTO_RATE_LIMITED');
  assert.strictEqual(get(a.id).state.lastResult.ok, false);
  const rn = await call('auto.runNow', { opId: uuid(), id: a.id });
  assert.strictEqual(rn.accepted, true);
  assert.match(rn.firingId, /^f_/);
  await I._drain();
  assert.strictEqual(get(a.id).state.runsToday, 3, 'runNow 는 하루 상한을 무시한다');
  assert.strictEqual(get(a.id).state.lastResult.firingId, rn.firingId);
  assert.strictEqual(get(a.id).state.lastResult.ok, true);
  NOW += 24 * 3600 * 1000;
  assert.strictEqual((await I.fire(a.id, { source: 't' })).started, true, '다음날(tz 기준) 리셋');
  assert.strictEqual(get(a.id).state.runsToday, 1);
  // 쿨다운 — 결과를 실패로 덮지 않고 미룬다
  const b = await create({ trigger: { type: 'pr.ci_failed', repo: null }, actions: [NOTIFY()], guards: { cooldownMs: 60000 } });
  assert.strictEqual((await I.fire(b.id, {})).started, true);
  const rb = await I.fire(b.id, {});
  assert.deepStrictEqual(rb, { started: false, code: 'AUTO_RATE_LIMITED', defer: true });
  assert.strictEqual(get(b.id).state.lastResult.ok, true, '쿨다운 스킵은 lastResult 를 덮지 않는다');
  assert.ok(logLines().some((l) => l.autoId === b.id && l.stage === 'skip' && l.message === 'cooldown'));
  NOW += 61000;
  assert.strictEqual((await I.fire(b.id, {})).started, true);
});

test('가드 — 동시 1: 실행 중에는 runNow·update·remove 가 AUTO_BUSY', async () => {
  await reset();
  const a = await create({ trigger: { type: 'pr.ci_failed', repo: null }, actions: [NOTIFY('slow')], guards: { cooldownMs: 0 } });
  let release;
  notifyGate = new Promise((r) => { release = r; });
  const p = I.fire(a.id, {});
  await waitFor(() => get(a.id).state.inflight === 1);
  assert.deepStrictEqual(auto.activity(), { active: true, reasons: [`automation:${a.id}`] });
  await assert.rejects(() => call('auto.runNow', { opId: uuid(), id: a.id }), (e) => e.code === 'AUTO_BUSY');
  await assert.rejects(() => call('auto.update', { id: a.id, patch: { name: 'x' } }), (e) => e.code === 'AUTO_BUSY');
  await assert.rejects(() => call('auto.remove', { id: a.id }), (e) => e.code === 'AUTO_BUSY');
  release();
  await p;
  assert.strictEqual(get(a.id).state.inflight, 0);
  assert.deepStrictEqual(auto.activity(), { active: false, reasons: [] });
});

test('연속 실패 5회 → paused(error) + auto_paused 알림 1회(1~4회는 auto_failed), 재개하면 0 부터', async () => {
  await reset();
  createFail = () => Object.assign(new Error('동시에 실행할 수 있는 작업 수를 넘었습니다'), { code: 'TASK_LIMIT' });
  const a = await create({ trigger: { type: 'pr.ci_failed', repo: null }, actions: [{ type: 'task.create', repo: REPO, prompt: 'p' }], guards: { cooldownMs: 0, maxRunsPerDay: 50 } });
  for (let i = 0; i < 5; i++) {
    const r = await I.fire(a.id, {});
    assert.strictEqual(r.started, true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'TASK_LIMIT');
  }
  await I._drain();
  const cur = get(a.id);
  assert.strictEqual(cur.paused, true);
  assert.strictEqual(cur.pausedReason, 'error');
  assert.strictEqual(cur.state.consecutiveFailures, 5);
  assert.strictEqual(backOf('auto_failed').length, 4);
  assert.deepStrictEqual(backOf('auto_failed')[0].b, { source: 'agent', kind: 'auto_failed', title: '자동화 실패', subtitle: '검사 실패 · 작업 수 상한에 걸렸어요', deeplink: `codingpt://auto/${a.id}?host=42` });
  assert.strictEqual(backOf('auto_paused').length, 1);
  assert.strictEqual(backOf('auto_paused')[0].b.subtitle, '연속 실패 5회');
  assert.ok(!JSON.stringify(back).includes(cur.name) || cur.name === '검사 실패', '알림에 이름 없음');
  const again = await I.fire(a.id, {});
  assert.deepStrictEqual(again, { started: false, code: 'AUTO_PAUSED', defer: true });
  assert.strictEqual(backOf('auto_paused').length, 1, '재알림 없음');
  const rs = await call('auto.resume', { id: a.id });
  assert.strictEqual(rs.automation.paused, false);
  assert.strictEqual(rs.automation.pausedReason, null);
  assert.strictEqual(rs.automation.state.consecutiveFailures, 0);
});

test('pauseAll(킬스위치) — 틱·이벤트·runNow 전부 0건, 재개 시 스케줄은 지금부터 다시(몰아서 실행 안 함)', async () => {
  await reset();
  const a = await create({ trigger: { type: 'schedule', cron: '0 * * * *', tz: 'UTC' }, actions: [NOTIFY()], guards: { cooldownMs: 0 } });
  assert.deepStrictEqual(await call('auto.pauseAll', { paused: true }), { paused: true });
  NOW = a.state.nextRunAt + 5 * 60 * 1000;
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 0);
  await assert.rejects(() => call('auto.runNow', { opId: uuid(), id: a.id }), (e) => e.code === 'AUTO_PAUSED');
  assert.strictEqual((await call('auto.list')).paused, true);
  await call('auto.pauseAll', { paused: false });
  assert.ok(get(a.id).state.nextRunAt > NOW, '재개 시점부터 다시 센다');
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 0);
  await assert.rejects(() => call('auto.pauseAll', {}), (e) => e.code === 'BAD_PARAMS');
});

test('서버 킬스위치 — serverCaps 가 있는데 auto.v1 이 없으면 실행 0건·runNow AUTO_DISABLED, env CPT_AUTOMATIONS=0 이면 handle 없음', async () => {
  await reset();
  const a = await create({ trigger: { type: 'schedule', cron: '0 * * * *', tz: 'UTC' }, actions: [NOTIFY()], guards: { cooldownMs: 0 } });
  serverCaps = ['task.v1'];
  NOW = a.state.nextRunAt + 1000;
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 0);
  await assert.rejects(() => call('auto.runNow', { opId: uuid(), id: a.id }), (e) => e.code === 'AUTO_DISABLED');
  serverCaps = ['task.v1', 'auto.v1'];
  NOW = get(a.id).state.nextRunAt + 1000;
  I.tick(); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 1);
  process.env.CPT_AUTOMATIONS = '0';
  try {
    assert.strictEqual(auto.handle, undefined);
    assert.ok(!require('../control').daemonCaps().includes('auto.v1'));
    await assert.rejects(() => call('auto.list'), (e) => e.code === 'AUTO_DISABLED');
  } finally { delete process.env.CPT_AUTOMATIONS; }
  assert.strictEqual(typeof auto.handle, 'function');
  assert.ok(require('../control').daemonCaps().includes('auto.v1'));
});

// ── 이벤트 트리거 ────────────────────────────────────────────────────────────
test('task.event — 저장소 매칭·자기 유발 무시·depth 3 거부(AUTO_DEPTH)·terminal.prompt {event:true}', async () => {
  await reset();
  auto.start();
  const a = await create({ trigger: { type: 'task.event', event: 'review_ready', repo: REPO }, actions: [NOTIFY('ready {task.id} {run.agent} {branch}')], guards: { cooldownMs: 0 } });
  const ev = (origin, repo = REPO) => ({
    task: { id: 't_aaaaaaaaaa', title: 't', repo: { path: repo, subdir: '' }, origin },
    run: { id: 'r_aaaa0001', agent: 'codex', branch: 'cpt/aaaaaa-1', cwd: '.codingpt/worktrees/x', tid: 1000999, tsession: 'cpt-x--t-1000999' },
  });
  events.emit('task.review_ready', ev(null));
  events.emit('task.merged', ev(null)); // 다른 이벤트
  events.emit('task.review_ready', ev(null, 'work/other')); // 다른 저장소
  events.emit('task.review_ready', ev({ kind: 'automation', automationId: a.id, depth: 1 })); // 자기 유발
  await events.flush(); await I._drain();
  assert.deepStrictEqual(backOf('auto_notify').map((x) => x.b.title), ['ready t_aaaaaaaaaa codex cpt/aaaaaa-1']);
  // 연쇄 깊이 — 트리거 작업 depth 2 → 이 firing 은 3 → 실패(AUTO_DEPTH), 작업 안 만든다
  const b = await create({ trigger: { type: 'task.event', event: 'merged', repo: null }, actions: [{ type: 'task.create', repo: REPO, prompt: 'next' }], guards: { cooldownMs: 0 } });
  events.emit('task.merged', ev({ kind: 'automation', automationId: 'a_zzzzzzzzzz', depth: 2 }));
  await events.flush(); await I._drain();
  assert.strictEqual(created.length, 0);
  assert.strictEqual(get(b.id).state.lastResult.code, 'AUTO_DEPTH');
  events.emit('task.merged', ev({ kind: 'automation', automationId: 'a_zzzzzzzzzz', depth: 1 }));
  await events.flush(); await I._drain();
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].origin.depth, 2, '트리거 작업 depth + 1');
  // terminal.prompt {event:true} — 에이전트가 붙어 있고 쉬고 있을 때만, 작업 중이면 AGENT_BUSY(실패로 안 셈)
  const c = await create({ trigger: { type: 'pr.ci_failed', repo: REPO }, actions: [{ type: 'terminal.prompt', target: { event: true }, text: 'CI 깨짐: {ci.failedChecks}\n{review.comments}' }], guards: { cooldownMs: 0 } });
  const ts = 'cpt-x--t-1000999';
  const ci = { status: 'failing', failed: [{ name: 'ci / lint', url: 'https://x/actions/runs/2/job/9', runId: '2' }] };
  events.emit('pr.ci_failed', { ...ev(null), ci });
  await events.flush(); await I._drain();
  assert.strictEqual(get(c.id).state.lastResult.code, 'PROMPT_NOT_DELIVERED', '붙은 에이전트 없음 → 셸에 타이핑하지 않는다');
  assert.strictEqual(inputs.length, 0);
  attach[ts] = { attached: true, agent: 'codex' };
  rawState[ts] = 'working';
  events.emit('pr.ci_failed', { ...ev(null), ci });
  await events.flush(); await I._drain();
  assert.strictEqual(get(c.id).state.lastResult.code, 'AGENT_BUSY');
  assert.strictEqual(get(c.id).state.consecutiveFailures, 1, 'AGENT_BUSY 는 연속 실패로 세지 않는다(앞의 1회만)');
  rawState[ts] = 'idle';
  events.emit('pr.ci_failed', { ...ev(null), ci });
  await events.flush(); await I._drain();
  assert.strictEqual(get(c.id).state.lastResult.ok, true);
  assert.deepStrictEqual(inputs, [{ cwd: '.codingpt/worktrees/x', tid: 1000999, text: 'CI 깨짐: ci / lint\n', submit: true }]);
  assert.deepStrictEqual(get(c.id).state.lastResult.steps, [{ type: 'terminal.prompt', ok: true }]);
});

// ── 폴링 트리거 ──────────────────────────────────────────────────────────────
test('github.issues — 가짜 gh 이슈 2개 → 작업 2개(번호순)·seen·since, 하루 상한에 걸린 이슈는 다음날 따라잡는다', async () => {
  await reset();
  taskGit.resetCache();
  fs.writeFileSync(GH_LOG, '');
  const issue = (number, title) => ({ number, title, body: `본문 ${number}`, url: `https://github.com/acme/demo/issues/${number}`, labels: ['bug', 'p1'], author: 'alice', at: '2026-09-28T00:00:00Z' });
  fs.writeFileSync(GH_ISSUES, JSON.stringify([issue(5, '다섯'), issue(3, '셋')]));
  const a = await create({
    trigger: { type: 'github.issues', repo: REPO, labels: ['bug'] },
    actions: [{ type: 'task.create', repo: REPO, title: '{issue.title}', prompt: '이슈 #{issue.number} ({issue.labels}) by {issue.author}\n{issue.body}\n{issue.url}' }],
    guards: { cooldownMs: 0, maxRunsPerDay: 3 },
  });
  await I.poll({ force: true }); await I._drain();
  assert.deepStrictEqual(created.map((c) => c.params.title), ['셋', '다섯']);
  assert.ok(created[0].params.prompt.startsWith('이슈 #3 (bug, p1) by alice\n본문 3\nhttps://github.com/acme/demo/issues/3'));
  const ghCalls = fs.readFileSync(GH_LOG, 'utf8');
  assert.match(ghCalls, /^api repos\/acme\/demo\/issues\?state=open&per_page=30&labels=bug -q /m);
  const cur = get(a.id).state.cursor;
  assert.deepStrictEqual(cur.seen, [3, 5]);
  assert.ok(cur.sinceIso && cur.github);
  assert.ok(!('seen' in (await call('auto.get', { id: a.id })).automation.state.cursor), 'seen 은 와이어에 싣지 않는다');
  await I.poll({ force: true }); await I._drain();
  assert.strictEqual(created.length, 2, '본 이슈는 다시 안 만든다');
  assert.match(fs.readFileSync(GH_LOG, 'utf8'), /&since=\d{4}-\d{2}-\d{2}T/);
  // 하루 상한(3) — 새 이슈 2개 중 1개만, since 는 전진하지 않는다
  const since0 = get(a.id).state.cursor.sinceIso;
  fs.writeFileSync(GH_ISSUES, JSON.stringify([issue(7, '일곱'), issue(8, '여덟')]));
  await I.poll({ force: true }); await I._drain();
  assert.deepStrictEqual(created.map((c) => c.params.title), ['셋', '다섯', '일곱']);
  assert.strictEqual(get(a.id).state.cursor.sinceIso, since0, '미뤄진 이슈가 있으면 since 고정');
  NOW += 24 * 3600 * 1000;
  await I.poll({ force: true }); await I._drain();
  assert.deepStrictEqual(created.map((c) => c.params.title), ['셋', '다섯', '일곱', '여덟']);
  // dryRun — 최근 표본(마지막 이슈)으로 렌더만
  const dr = await call('auto.runNow', { id: a.id, dryRun: true });
  assert.strictEqual(dr.rendered[0].title, '여덟');
  assert.ok(dr.rendered[0].prompt.endsWith(I.LOOP_NOTE(get(a.id).name)));
  assert.strictEqual(created.length, 4, 'dryRun 은 실행하지 않는다');
});

test('git.commits — 첫 폴링은 커서만, 원격에 새 커밋 2개 → firing 1회({commits.*}), 로컬 체크아웃 불변', async () => {
  await reset();
  const a = await create({ trigger: { type: 'git.commits', repo: REPO, branch: 'main' }, actions: [NOTIFY('{commits.count}개 {commits.range} {branch}')], guards: { cooldownMs: 0 } });
  assert.deepStrictEqual(a.trigger, { type: 'git.commits', repo: REPO, branch: 'main', remote: 'origin' });
  await I.poll({ force: true }); await I._drain();
  const sha0 = get(a.id).state.cursor.sha;
  assert.match(sha0, /^[0-9a-f]{40}$/);
  assert.strictEqual(backOf('auto_notify').length, 0, '과거 커밋을 재생하지 않는다');
  const other = path.join(ROOT, 'other-clone');
  G(ROOT, 'clone', '-q', BARE, other);
  for (const n of [1, 2]) { fs.writeFileSync(path.join(other, `f${n}.txt`), `${n}\n`); G(other, 'add', '-A'); G(other, 'commit', '-q', '-m', `feat ${n}`); }
  G(other, 'push', '-q', 'origin', 'main');
  const sha1 = G(other, 'rev-parse', 'HEAD');
  const headBefore = G(REPO_DIR, 'rev-parse', 'HEAD');
  await I.poll({ force: true }); await I._drain();
  assert.deepStrictEqual(backOf('auto_notify').map((x) => x.b.title), [`2개 ${sha0.slice(0, 7)}..${sha1.slice(0, 7)} main`]);
  assert.strictEqual(get(a.id).state.cursor.sha, sha1);
  assert.strictEqual(G(REPO_DIR, 'rev-parse', 'HEAD'), headBefore, '사용자 체크아웃은 건드리지 않는다(fetch 만)');
  assert.deepStrictEqual(get(a.id).state.cursor.lastVars.commits.subjects, 'feat 1\nfeat 2'.split('\n').reverse().join('\n'));
  await I.poll({ force: true }); await I._drain();
  assert.strictEqual(backOf('auto_notify').length, 1);
});

// ── 검증·RPC ─────────────────────────────────────────────────────────────────
test('auto.validate — rpc-auto.validate.json 픽스처와 동일 + 에러 표(NOT_A_REPO·AGENT_NOT_INSTALLED·TEMPLATE)', async () => {
  await reset();
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'fixtures', 'automation', 'rpc-auto.validate.json'), 'utf8'));
  assert.deepStrictEqual(await call('auto.validate', fx.params), fx.result);
  for (const e of fx.errors) await assert.rejects(() => call('auto.validate', { draft: e.draft }), (x) => x.code === e.code, e.why);
  const act = (o) => ({ trigger: { type: 'pr.ci_failed' }, actions: [{ type: 'task.create', repo: REPO, prompt: 'p', ...o }] });
  await assert.rejects(() => call('auto.validate', { draft: act({ repo: 'work/nope' }) }), (e) => e.code === 'NOT_A_REPO');
  await assert.rejects(() => call('auto.validate', { draft: act({ repo: '../../etc' }) }), (e) => e.code === 'NOT_A_REPO');
  await assert.rejects(() => call('auto.validate', { draft: act({ agents: [{ id: 'gemini', count: 1 }] }) }), (e) => e.code === 'AGENT_NOT_INSTALLED');
  await assert.rejects(() => call('auto.validate', { draft: act({ agents: [{ id: 'claude', count: 3 }, { id: 'codex', count: 2 }] }) }), (e) => e.code === 'AUTO_BAD_ACTION');
  await assert.rejects(() => call('auto.validate', { draft: act({ prompt: 'x'.repeat(20001) }) }), (e) => e.code === 'AUTO_TEMPLATE_TOO_LARGE');
  await assert.rejects(() => call('auto.validate', { draft: { trigger: { type: 'pr.ci_failed' }, actions: [NOTIFY(), NOTIFY(), NOTIFY(), NOTIFY(), NOTIFY(), NOTIFY()] } }), (e) => e.code === 'AUTO_BAD_ACTION');
  await assert.rejects(() => call('auto.validate', { draft: { trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'UTC' }, actions: [NOTIFY()], guards: { maxRunsPerDay: 51 } } }), (e) => e.code === 'AUTO_BAD_TRIGGER');
  await assert.rejects(() => call('auto.validate', { draft: { trigger: { type: 'git.commits', repo: REPO, branch: '--upload-pack=x' }, actions: [NOTIFY()] } }), (e) => e.code === 'AUTO_BAD_TRIGGER');
  const v = await call('auto.validate', { draft: { trigger: { type: 'schedule', cron: '0 9 * * 1-5', tz: 'Asia/Seoul' }, actions: [NOTIFY()] } });
  assert.strictEqual(new Date(v.nextRunAt).toISOString(), '2026-09-30T00:00:00.000Z');
  assert.strictEqual(v.normalized.name, '매일 일정');
  await assert.rejects(() => call('auto.bogus'), (e) => e.code === 'BAD_PARAMS');
});

test('create/update/remove/log — opId 멱등·PC 당 30개 상한·트리거 바꾸면 커서 리셋·와이어 화이트리스트', async () => {
  await reset();
  const opId = uuid();
  const draft = { name: '  공백   정리 ', trigger: { type: 'pr.ci_failed' }, actions: [NOTIFY()] };
  const r1 = await call('auto.create', { opId, draft });
  const r2 = await call('auto.create', { opId, draft });
  assert.strictEqual(r2.replay, true);
  assert.strictEqual(r2.automation.id, r1.automation.id);
  assert.strictEqual(r1.automation.name, '공백 정리');
  // 릴레이 경로 createdBy 는 user|dispatch 만(agent 사칭 불가)
  const d = await call('auto.create', { opId: uuid(), draft, createdBy: { kind: 'dispatch', planId: 'p_abc' } });
  assert.deepStrictEqual({ ...d.automation.createdBy, at: 0 }, { kind: 'dispatch', agent: null, tsession: null, taskId: null, planId: 'p_abc', deviceId: 42, at: 0 });
  const fake = await call('auto.create', { opId: uuid(), draft, createdBy: { kind: 'agent', agent: 'claude' } });
  assert.strictEqual(fake.automation.createdBy.kind, 'user');
  assert.strictEqual(backOf('auto_created').length, 0, '사람이 만든 자동화는 알리지 않는다');
  const keys = Object.keys(r1.automation).sort();
  assert.deepStrictEqual(keys, [...auto.AUTO_FIELDS].sort());
  assert.deepStrictEqual(Object.keys(r1.automation.state).sort(), [...auto.STATE_FIELDS].sort());
  // update — 트리거 변경 시 커서 리셋, 스케줄로 바꾸면 nextRunAt
  I.mutate(() => { get(r1.automation.id).state.cursor = { seen: [1], lastVars: { issue: { title: 'x' } }, sha: 'abc1234' }; });
  const u = await call('auto.update', { id: r1.automation.id, patch: { trigger: { type: 'schedule', cron: '30 8 * * *', tz: 'UTC' }, guards: { maxRunsPerDay: 3 } } });
  assert.deepStrictEqual(u.automation.state.cursor, {});
  assert.strictEqual(new Date(u.automation.state.nextRunAt).toISOString(), '2026-09-29T08:30:00.000Z');
  assert.deepStrictEqual(u.automation.guards, { maxRunsPerDay: 3, maxConcurrent: 1, cooldownMs: 300000 });
  await assert.rejects(() => call('auto.update', { id: r1.automation.id, patch: { createdBy: { kind: 'agent' } } }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('auto.update', { id: 'a_nonexistent', patch: {} }), (e) => e.code === 'AUTO_NOT_FOUND');
  const p = await call('auto.pause', { id: r1.automation.id });
  assert.deepStrictEqual([p.automation.paused, p.automation.pausedReason], [true, 'user']);
  const list = await call('auto.list');
  assert.deepStrictEqual(list.counts, { total: 3, paused: 1, attention: 0 });
  assert.deepStrictEqual(list.limits, auto.AUTO_LIMITS);
  assert.deepStrictEqual(await call('auto.remove', { id: fake.automation.id }), { ok: true });
  assert.strictEqual((await call('auto.list')).items.length, 2);
  const lg = await call('auto.log', { id: fake.automation.id });
  assert.deepStrictEqual(lg.lines.map((l) => l.stage), ['created', 'removed']);
  // 상한 30
  for (let i = (await call('auto.list')).items.length; i < 30; i++) await create(draft);
  await assert.rejects(() => create(draft), (e) => e.code === 'AUTO_LIMIT');
  assert.ok(notified.some((x) => x.reason === 'created') && notified.some((x) => x.reason === 'removed'));
});

test('감사 로그 회전(상한 초과 → .1 한 세대) + auto.log 꼬리는 회전분까지 읽는다', async () => {
  await reset();
  I.timings.logMaxBytes = 1500;
  for (let i = 0; i < 40; i++) await call('auto.pauseAll', { paused: i % 2 === 0 });
  assert.ok(fs.existsSync(`${I.logFile()}.1`), '회전됨');
  assert.ok(fs.statSync(I.logFile()).size < 1500 + 400);
  assert.strictEqual(fs.statSync(I.logFile()).mode & 0o777, 0o600);
  const all = (await call('auto.log', { limit: 500 })).lines;
  assert.ok(all.length > fs.readFileSync(I.logFile(), 'utf8').split('\n').filter(Boolean).length, '.1 세대도 읽는다');
  assert.ok(all.every((l) => l.stage === 'pauseAll'));
});

test('재시작 — 실행 중이던 firing 은 inflight 0 + OP_INTERRUPTED, nextRunAt 은 저장값 유지, 스토어 0600·깨진 항목 버림', async () => {
  await reset();
  const a = await create({ trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'Asia/Seoul' }, actions: [NOTIFY()] });
  I.mutate(() => { get(a.id).state.inflight = 1; });
  const disk = JSON.parse(fs.readFileSync(I.storeFile(), 'utf8'));
  disk.items.push({ id: 'broken' }, { id: 'a_bbbbbbbbbb', trigger: { type: 'shell' }, actions: [], state: {} });
  fs.writeFileSync(I.storeFile(), JSON.stringify(disk));
  await I._reset({ drain: false });
  auto.start();
  const cur = get(a.id);
  assert.strictEqual(cur.state.inflight, 0);
  assert.strictEqual(cur.state.lastResult.code, 'OP_INTERRUPTED');
  assert.strictEqual(cur.state.nextRunAt, a.state.nextRunAt);
  assert.strictEqual(I.load().items.length, 1, '깨진 항목은 버린다');
  assert.strictEqual(fs.statSync(I.storeFile()).mode & 0o777, 0o600);
  auto.stop();
});

test('와이어 픽스처 — rpc-auto.list/get 이 pickAuto 화이트리스트와 일치, rpc-errors-automation.auto == ERROR_CODES', () => {
  const FIX = path.join(__dirname, '..', '..', '..', 'docs', 'fixtures', 'automation');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  const check = (a, where, { strictCursor = true } = {}) => {
    assert.deepStrictEqual(Object.keys(a).sort(), [...auto.AUTO_FIELDS].sort(), `${where}: Automation 필드`);
    assert.deepStrictEqual(Object.keys(a.state).sort(), [...auto.STATE_FIELDS].sort(), `${where}: state 필드`);
    assert.ok(/^a_[0-9a-z]{10}$/.test(a.id), `${where}: id`);
    assert.ok(auto.TRIGGER_TYPES.includes(a.trigger.type), `${where}: trigger`);
    assert.ok(a.actions.length >= 1 && a.actions.every((x) => auto.ACTION_TYPES.includes(x.type)), `${where}: actions`);
    assert.ok(['agent', 'dispatch', 'user'].includes(a.createdBy.kind));
    if (!strictCursor) return; // 모델 픽스처(S6)는 cursor 에 디스크 전용 필드가 섞여도 무해(모델이 읽지 않는다)
    assert.ok(Object.keys(a.state.cursor).every((k) => ['sha', 'sinceIso', 'polledAt'].includes(k)), `${where}: cursor 와이어`);
    assert.deepStrictEqual(auto.pickAuto(a), a, `${where}: pickAuto 재현`);
  };
  const list = read('rpc-auto.list.json').result;
  list.items.forEach((a, i) => check(a, `list[${i}]`));
  assert.deepStrictEqual(list.limits, auto.AUTO_LIMITS);
  const get1 = read('rpc-auto.get.json').result;
  check(get1.automation, 'get');
  for (const l of get1.log) {
    assert.ok(Object.keys(l).every((k) => ['at', 'autoId', 'firingId', 'stage', 'type', 'ok', 'code', 'message', 'taskId'].includes(k)), 'LogLine 필드');
  }
  const errs = read('rpc-errors-automation.json');
  assert.deepStrictEqual(errs.auto, auto.ERROR_CODES);
  // S6 모델 픽스처의 입력도 같은 모양이어야 한다(두 표면이 이 데몬 출력을 그대로 먹는다)
  for (const f of ['auto-01-list.json']) {
    const fx = read(f);
    for (const a of fx.input.items) check(a, `${f}:${a.id}`, { strictCursor: false });
  }
});

// ── 소켓 경로(에이전트 게이트) ───────────────────────────────────────────────
test('cpt-server 소켓 — auto.* 는 컨텍스트 게이트 + 에이전트 게이트(AUTO_OUT_OF_TERMINAL·AUTO_LOOP), createdBy.kind agent + auto_created 알림', async () => {
  await reset();
  const cptServer = require('../cpt-server');
  const draft = { name: 'CI 알림', trigger: { type: 'pr.ci_failed', repo: null }, actions: [NOTIFY('x')] };
  const sock = (ctx, cmd = 'auto.create', args = { opId: uuid(), draft }) => cptServer._dispatch({ cmd, args, ...(ctx === undefined ? {} : { ctx }) });
  // (a) 무관 폴더 CWD 폴백 — 컨텍스트 게이트
  await assert.rejects(() => sock({ cwd: path.join(ROOT, 'work') }), (e) => e.code === 'OUT_OF_CONTEXT');
  // (b) CPT_WS 는 있지만 tmux 자기좌표 없음 — 조회는 되고 생성은 안 된다
  assert.ok(Array.isArray((await sock({ ws: REPO, cwd: REPO_DIR }, 'auto.list', {})).items));
  await assert.rejects(() => sock({ ws: REPO, cwd: REPO_DIR }), (e) => e.code === 'AUTO_OUT_OF_TERMINAL');
  await assert.rejects(() => sock({ ws: REPO, tmux: { session: 'main', windowIndex: 1 } }), (e) => e.code === 'AUTO_OUT_OF_TERMINAL');
  // (c) CodingPT 터미널 — 에이전트 생성
  const ts = 'cpt-work-codingpt--t-1000555';
  const r = await sock({ ws: REPO, cwd: REPO_DIR, tmux: { session: ts, windowIndex: 1000555 } });
  assert.deepStrictEqual({ ...r.automation.createdBy, at: 0 }, { kind: 'agent', agent: null, tsession: ts, taskId: null, planId: null, deviceId: 42, at: 0 });
  await I._drain();
  assert.deepStrictEqual(backOf('auto_created').map((x) => x.b), [{ source: 'agent', kind: 'auto_created', title: '자동화 생성 · 에이전트', subtitle: '검사 실패', deeplink: `codingpt://auto/${r.automation.id}?host=42` }]);
  assert.ok(!JSON.stringify(backOf('auto_created')).includes('CI 알림'), '알림에 이름 없음');
  // (d) 자동화가 만든 작업의 실행 터미널 — AUTO_LOOP(생성·수정·재개·실행 전부)
  const loopCtx = { ws: '.codingpt/worktrees/codingpt-l00p01-1', tmux: { session: LOOP_TSESSION, windowIndex: 1000777 } };
  await assert.rejects(() => sock(loopCtx), (e) => e.code === 'AUTO_LOOP');
  await assert.rejects(() => sock(loopCtx, 'auto.runNow', { opId: uuid(), id: r.automation.id }), (e) => e.code === 'AUTO_LOOP');
  await assert.rejects(() => sock(loopCtx, 'auto.update', { id: r.automation.id, patch: { name: 'y' } }), (e) => e.code === 'AUTO_LOOP');
  assert.strictEqual((await sock(loopCtx, 'auto.pause', { id: r.automation.id })).automation.paused, true, '줄이는 쪽은 허용');
  // (e) 전체 일시정지는 CLI 불가, PC 앱(ctx 없음)은 가능
  await assert.rejects(() => sock({ ws: REPO, tmux: { session: ts, windowIndex: 1 } }, 'auto.pauseAll', { paused: false }), (e) => e.code === 'BAD_PARAMS');
  assert.deepStrictEqual(await sock(undefined, 'auto.pauseAll', { paused: true }), { paused: true });
  // PC 앱 경로 생성 = user(알림 없음)
  await call('auto.pauseAll', { paused: false });
  const app = await sock(undefined, 'auto.create', { opId: uuid(), draft });
  assert.strictEqual(app.automation.createdBy.kind, 'user');
  // CAPABILITIES — auto.* 10개 공개, pauseAll 비공개
  const caps = (await sock({ ws: '' }, 'capabilities', {})).commands.filter((c) => c.startsWith('auto.'));
  assert.deepStrictEqual(caps, ['auto.list', 'auto.get', 'auto.create', 'auto.update', 'auto.remove', 'auto.pause', 'auto.resume', 'auto.runNow', 'auto.log', 'auto.validate']);
});

test('control.dispatchRpc — auto.* 위임(via relay)·서버 킬스위치 AUTO_DISABLED·power.event 원격 거부', async () => {
  await reset();
  const control = require('../control');
  const via = (m, p) => new Promise((res, rej) => control.dispatchRpc({ readyState: 1, send() {} }, m, p, res, rej));
  assert.ok(Array.isArray((await via('auto.list', {})).items));
  const r = await via('auto.create', { opId: uuid(), draft: { trigger: { type: 'pr.ci_failed' }, actions: [NOTIFY()] }, createdBy: { kind: 'agent' } });
  assert.strictEqual(r.automation.createdBy.kind, 'user', '릴레이 경로는 agent 를 주장할 수 없다');
  await assert.rejects(() => via('power.event', { kind: 'willSleep' }), (e) => e.code === 'BAD_PARAMS' || e.code === 'POWER_DISABLED');
  control._setServerCaps(['task.v1']);
  try {
    await assert.rejects(() => via('auto.list', {}), (e) => e.code === 'AUTO_DISABLED');
    await assert.rejects(() => via('dispatch.get', { planId: 'p' }), (e) => e.code === 'DISPATCH_DISABLED');
    await assert.rejects(() => via('power.status', {}), (e) => e.code === 'POWER_DISABLED');
    control._setServerCaps(['auto.v1']);
    assert.ok(Array.isArray((await via('auto.list', {})).items));
    await assert.rejects(() => via('power.event', { kind: 'willSleep' }), (e) => e.code === 'POWER_DISABLED');
  } finally { control._setServerCaps([]); }
  assert.deepStrictEqual(control.serverCaps(), []);
  const hello = control.helloFrame({ deviceName: 'T', daemonVersion: 't' });
  assert.strictEqual(typeof hello.busy, 'boolean');
  assert.strictEqual(typeof hello.awake, 'boolean');
});

// ── cpt CLI ──────────────────────────────────────────────────────────────────
test('cpt auto create - (stdin) 왕복·--dry-run·schema = 안내서(auto) 7-3 절·에러 코드 표시(가짜 소켓)', async () => {
  const net = require('net');
  const seen = [];
  let reply = null;
  const sockPath = path.join(ROOT, 'fake-cpt.sock');
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      seen.push(req);
      c.end(JSON.stringify({ id: req.id, ...reply(req) }) + '\n');
    });
  });
  await new Promise((r) => srv.listen(sockPath, r));
  const cli = path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js');
  const ts = 'cpt-work-codingpt--t-1000555';
  const run = (args, input) => new Promise((res) => {
    const ch = execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, CPT_SOCK: sockPath, CPT_WS: REPO, CPT_TSESSION: ts, CPT_TID: '1000555', TMUX_PANE: '' },
    }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr }));
    if (input != null) ch.stdin.end(input); else ch.stdin.end();
  });
  const draft = { name: '매일', trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'Asia/Seoul' }, actions: [{ type: 'notify', title: 'hi' }] };
  try {
    reply = (req) => ({ ok: true, result: { automation: { id: 'a_k3j9x2m1qa', name: req.args.draft.name, trigger: req.args.draft.trigger } } });
    const c1 = await run(['auto', 'create', '-'], JSON.stringify(draft));
    assert.strictEqual(c1.code, 0, c1.stderr);
    assert.match(c1.stdout, /^a_k3j9x2m1qa {2}매일 — 0 9 \* \* \* \(Asia\/Seoul\)/);
    const req = seen[seen.length - 1];
    assert.strictEqual(req.cmd, 'auto.create');
    assert.deepStrictEqual(req.args.draft, draft);
    assert.match(req.args.opId, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(req.ctx.tmux, { session: ts, windowIndex: 1000555 });
    assert.strictEqual(req.ctx.ws, REPO);
    // --dry-run - (파서가 - 를 플래그 값으로 먹어도 stdin)
    reply = () => ({ ok: true, result: { ok: true, normalized: { trigger: draft.trigger }, nextRunAt: Date.parse('2026-09-30T00:00:00Z'), warnings: ['w1'] } });
    const c2 = await run(['auto', 'create', '--dry-run', '-'], JSON.stringify(draft));
    assert.strictEqual(c2.code, 0, c2.stderr);
    assert.strictEqual(seen[seen.length - 1].cmd, 'auto.validate');
    assert.match(c2.stdout, /검증 통과[\s\S]*경고:\n {2}w1/);
    // --file
    const f = path.join(ROOT, 'spec.json');
    fs.writeFileSync(f, JSON.stringify(draft));
    reply = (rq) => ({ ok: true, result: { automation: { id: 'a_k3j9x2m1qb', name: rq.args.draft.name, trigger: rq.args.draft.trigger } } });
    assert.strictEqual((await run(['auto', 'create', '--file', f])).code, 0);
    // 에러 코드 표시(에이전트가 스스로 물러날 근거)
    reply = () => ({ ok: false, error: '자동화가 만든 작업에서는 자동화를 만들 수 없습니다', code: 'AUTO_LOOP' });
    const c3 = await run(['auto', 'create', '-'], JSON.stringify(draft));
    assert.strictEqual(c3.code, 1);
    assert.match(c3.stderr, /오류\(AUTO_LOOP\): 자동화가 만든 작업/);
    // 깨진 JSON / 파일 없음 — 소켓까지 가지 않는다
    const n0 = seen.length;
    assert.strictEqual((await run(['auto', 'create', '-'], '{nope')).code, 2);
    assert.strictEqual((await run(['auto', 'create'])).code, 2);
    assert.strictEqual(seen.length, n0);
    // run/pause/log 는 올바른 메서드로
    reply = () => ({ ok: true, result: { accepted: true, firingId: 'f_abc' } });
    const c4 = await run(['auto', 'run', 'a_k3j9x2m1qa']);
    assert.match(c4.stdout, /실행 요청됨 f_abc/);
    assert.deepStrictEqual([seen[seen.length - 1].cmd, seen[seen.length - 1].args.id], ['auto.runNow', 'a_k3j9x2m1qa']);
    reply = () => ({ ok: true, result: { lines: [{ at: 0, autoId: 'a_k3j9x2m1qa', stage: 'end', ok: false, code: 'TASK_LIMIT' }] } });
    const c5 = await run(['auto', 'log', 'a_k3j9x2m1qa', '--limit', '5']);
    assert.match(c5.stdout, /a_k3j9x2m1qa end fail TASK_LIMIT/);
    assert.deepStrictEqual(seen[seen.length - 1].args, { id: 'a_k3j9x2m1qa', limit: 5 });
    // schema = guides/auto.md 의 7-3 절 그대로(소켓 불필요)
    const n1 = seen.length;
    const sc = await run(['auto', 'schema']);
    assert.strictEqual(sc.code, 0);
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'guides', 'auto.md'), 'utf8');
    const i = guide.indexOf('## 7-3. 자동화');
    assert.ok(i > 0);
    assert.strictEqual(sc.stdout, guide.slice(i));   // 그 주제 파일의 본문 전부(머리말 빼고)
    assert.match(sc.stdout, /예시 1[\s\S]*예시 2[\s\S]*예시 3/);
    assert.match(sc.stdout, /AUTO_LOOP/);
    assert.strictEqual(seen.length, n1);
    // schema 의 예시 JSON 3개는 실제 검증을 통과한다(문서가 거짓말하지 않게 — repo 만 이 테스트 저장소로)
    const blocks = [...sc.stdout.matchAll(/```\n(\{"name"[\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1].replace(/work\/app/g, REPO)));
    assert.strictEqual(blocks.length, 3);
    for (const b of blocks) assert.strictEqual((await call('auto.validate', { draft: b })).ok, true, b.name);
    // HELP 에 자동화 절
    const h = await run(['help']);
    assert.match(h.stdout, /# 자동화[\s\S]*auto create --file <spec\.json> \| -/);
  } finally { srv.close(); }
});

test('SKILL.md — 자동화 트리거 구문 + 자기-스코핑 문장 유지', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'SKILL.md'), 'utf8');
  const desc = /^---\n([\s\S]*?)\n---/.exec(md)[1];
  //  설명은 **할 일 → 기능 표**다(2026-10-07): 스킬 목록에는 앞 ~1000자만 보이므로 기능마다 한 줄씩만 둔다.
  //  자세한 트리거 구문은 세션 시작 때 들어가는 인덱스(guides/index.md)와 주제별 안내서가 맡는다.
  for (const w of ['"매일"', 'cpt auto', 'cpt browser', 'cpt orch', 'cpt preview', 'cpt skills get index']) {
    assert.ok(desc.includes(w), `description 에 ${w}`);
  }
  assert.ok(desc.length <= 1024, 'description 은 스킬 목록에 다 보여야 한다(~1000자): ' + desc.length);
  const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'guides', 'index.md'), 'utf8');
  for (const w of ['every day', 'whenever', '`auto`', '`browser`', '`orch`']) assert.ok(idx.includes(w), `인덱스에 ${w}`);
  //  특정 외부 도구를 이름으로 금지하지 않는다 — 무엇이 있는지 알려 주는 것으로 충분했다(2026-10-07 비교 실험: 명시 6/6 · 중립 6/6).
  assert.ok(!/Claude in Chrome/.test(desc) && !/Claude in Chrome/.test(idx), '외부 도구 이름을 박지 않는다');
  assert.match(desc, /does NOT make this a CodingPT terminal/);
  assert.match(desc, /ONLY for terminals launched by the CodingPT app/);
});

// ── PATH 없는 사이드카 환경 ──────────────────────────────────────────────────
test('env -i PATH=/usr/bin:/bin — 폴링이 쓰는 gh 는 로그인 셸/표준 위치에서 해석된다(Finder 실행 앱 PATH 함정)', async (t) => {
  const std = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p));
  if (!std) { t.skip('이 PC 에 gh 가 표준 위치에 없음'); return; }
  const script = `
    const tg = require(${JSON.stringify(path.join(__dirname, '..', 'task-git.js'))});
    tg.baseTools().then((b) => { process.stdout.write(JSON.stringify({ installed: b.gh.installed, path: b.gh.path, envPath: b.env.PATH })); });
  `;
  const out = await new Promise((res, rej) => execFile('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', `HOME=${ROOT}`, process.execPath, '-e', script],
    { timeout: 30000 }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(JSON.parse(stdout)))));
  assert.strictEqual(out.installed, true);
  assert.ok(out.path && fs.existsSync(out.path), out.path);
  assert.ok(out.envPath.split(':').includes(path.dirname(out.path)), '자식(gh) PATH 에 gh 디렉토리가 들어간다');
});
