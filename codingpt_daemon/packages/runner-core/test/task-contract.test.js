'use strict';
// Agent Tasks 와이어 계약 — docs/fixtures/agent-tasks/*.json 이 데몬의 pickTask/pickRun 화이트리스트와
//  정확히 일치하는지(필드 추가/누락 감지) + 에러 코드 집합이 설계 정본 §2.13 표와 같은지 고정한다.
//  픽스처는 PC(tasks-crossimpl)·앱(jest)이 같은 파일을 읽는다 — 여기가 깨지면 세 표면이 어긋난 것이다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tasks = require('../tasks');

const DOCS = path.resolve(__dirname, '..', '..', '..', 'docs');
const FIX = path.join(DOCS, 'fixtures', 'agent-tasks');
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const sorted = (a) => [...a].sort();
const LIVE = new Set(['terminalAlive', 'agentGone']); // 응답 시점 계산값 — pickRun 재현 시 비교 제외

const RUN_STATES = ['creating', 'launching', 'running', 'review_ready', 'merging', 'merged', 'discarded', 'failed'];
const TASK_STATES = ['open', 'merged', 'closed', 'failed'];
const OP_KINDS = ['commit', 'push', 'pr.create', 'pr.merge', 'merge.local', 'discard', 'reopen', 'cleanup', 'fix'];
// automation-design §4.2 — task.v1 추가 전용 필드: 구 픽스처엔 없을 수 있다(있으면 모양을 검사). 데몬은 항상 싣는다.
const REQ_RUN = tasks.RUN_FIELDS.filter((f) => !tasks.OPTIONAL_RUN_FIELDS.includes(f));
const REQ_TASK = tasks.TASK_FIELDS.filter((f) => !tasks.OPTIONAL_TASK_FIELDS.includes(f));
function checkKeys(obj, all, req, where) {
  const keys = Object.keys(obj);
  for (const k of keys) assert.ok(all.includes(k), `${where}: 화이트리스트 밖 필드 ${k}`);
  for (const k of req) assert.ok(keys.includes(k), `${where}: 필드 누락 ${k}`);
}
function checkFollowup(f, where) {
  assert.deepStrictEqual(sorted(Object.keys(f)), ['ci', 'polledAt', 'reviews'], `${where}: followup`);
  assert.deepStrictEqual(sorted(Object.keys(f.ci)), ['detectedAt', 'dismissedAt', 'failed', 'fixOpId', 'headSha', 'seen', 'status'], `${where}: followup.ci`);
  assert.ok([null, 'failing'].includes(f.ci.status));
  assert.ok(f.ci.failed.length <= 10 && f.ci.seen.length <= 50);
  for (const x of f.ci.failed) assert.deepStrictEqual(sorted(Object.keys(x)), ['name', 'runId', 'url']);
  assert.deepStrictEqual(sorted(Object.keys(f.reviews)), ['cursor', 'detectedAt', 'dismissedAt', 'fixOpId', 'overflow', 'pending', 'seenIds'], `${where}: followup.reviews`);
  assert.ok(f.reviews.pending.length <= 30 && f.reviews.seenIds.length <= 300);
  for (const c of f.reviews.pending) {
    assert.ok(['review_comment', 'review', 'issue_comment'].includes(c.kind));
    for (const k of Object.keys(c)) assert.ok(['id', 'kind', 'author', 'bot', 'bodyHead', 'url', 'at', 'path', 'line', 'state'].includes(k), `${where}: pending ${k}`);
    assert.ok(String(c.bodyHead).length <= 300);
  }
}
function checkOrigin(o, where) {
  for (const k of Object.keys(o)) assert.ok(['kind', 'planId', 'automationId', 'firingId', 'depth'].includes(k), `${where}: origin ${k}`);
  assert.ok(['dispatch', 'automation'].includes(o.kind));
  assert.ok([0, 1, 2].includes(o.depth));
}
const LASTOP_KEYS = ['opId', 'kind', 'ok', 'code', 'message', 'result', 'at'];

function checkRun(r, where) {
  checkKeys(r, tasks.RUN_FIELDS, REQ_RUN, `${where}: Run 필드`);
  if (r.followup) checkFollowup(r.followup, where);
  assert.ok(RUN_STATES.includes(r.state), `${where}: state ${r.state}`);
  assert.ok(['arg', 'paste'].includes(r.promptMode), `${where}: promptMode`);
  assert.ok(/^r_[0-9a-z]+$/.test(r.id), `${where}: run id`);
  assert.ok(/^cpt\/[0-9a-z]{6}-\d$/.test(r.branch), `${where}: 브랜치는 cpt/<t6>-<k>`);
  assert.ok(/^\.codingpt\/worktrees\//.test(r.cwd), `${where}: isTaskWorkspace 술어와 맞는 cwd`);
  assert.ok(!path.basename(r.dir).includes('--'), `${where}: 폴더명에 --`);
  if (r.op) {
    assert.deepStrictEqual(sorted(Object.keys(r.op)), ['kind', 'opId', 'startedAt'], `${where}: op`);
    assert.ok(OP_KINDS.includes(r.op.kind));
  }
  if (r.lastOp) checkLastOp(r.lastOp, `${where}.lastOp`);
  if (r.error) assert.deepStrictEqual(sorted(Object.keys(r.error)), ['code', 'message'], `${where}: error`);
  if (r.diff) assert.deepStrictEqual(sorted(Object.keys(r.diff)), ['additions', 'at', 'deletions', 'files']);
  if (r.commits) assert.deepStrictEqual(sorted(Object.keys(r.commits)), ['ahead', 'at']);
  if (r.pr) checkPr(r.pr, `${where}.pr`);
  if (r.cleanup) assert.deepStrictEqual(sorted(Object.keys(r.cleanup)), ['at', 'branchDeleted', 'recoveryRef', 'workspaceDeleted', 'worktreeRemoved']);
  // pickRun 재현 — 화이트리스트 밖 필드가 섞여 있으면 여기서 떨어진다.
  const again = tasks.pickRun(r);
  for (const k of tasks.RUN_FIELDS) if (!LIVE.has(k)) assert.deepStrictEqual(again[k], r[k] === undefined ? null : r[k], `${where}: pickRun 재현 ${k}`);
}

function checkTask(t, where, { prompt }) {
  const extra = ['runs', ...(prompt ? ['prompt'] : [])];
  checkKeys(t, [...tasks.TASK_FIELDS, ...extra], [...REQ_TASK, ...extra], `${where}: Task 필드`);
  if (t.origin) checkOrigin(t.origin, where);
  assert.deepStrictEqual(sorted(Object.keys(t.repo)), sorted(tasks.REPO_FIELDS), `${where}: repo 필드`);
  assert.ok(TASK_STATES.includes(t.state), `${where}: state`);
  assert.ok(/^t_[0-9a-z]{10}$/.test(t.id), `${where}: task id`);
  if (t.state === 'merged') assert.ok(t.winnerRunId, `${where}: merged 면 winnerRunId`);
  else assert.strictEqual(t.winnerRunId, null, `${where}: merged 가 아니면 winnerRunId null`);
  t.runs.forEach((r, i) => checkRun(r, `${where}.runs[${i}]`));
}

function checkPr(pr, where) {
  assert.deepStrictEqual(sorted(Object.keys(pr)), sorted(['number', 'url', 'state', 'isDraft', 'title', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'checks', 'at']), `${where}: PrInfo`);
  assert.ok(['open', 'merged', 'closed'].includes(pr.state));
  assert.ok(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable));
  assert.deepStrictEqual(sorted(Object.keys(pr.checks)), ['failed', 'items', 'passed', 'pending', 'status', 'total']);
  assert.ok(['none', 'pending', 'passing', 'failing'].includes(pr.checks.status));
  assert.ok(pr.checks.items.length <= 20);
  for (const it of pr.checks.items) {
    assert.ok(['pending', 'passing', 'failing', 'skipped'].includes(it.status));
    for (const k of Object.keys(it)) assert.ok(['name', 'status', 'url'].includes(k), `${where}: check item ${k}`);
  }
}

function checkMergeResult(m, where) {
  if (m.ok) assert.deepStrictEqual(sorted(Object.keys(m)), ['cleanup', 'discardSkipped', 'discarded', 'ok', 'sha'], where);
  else assert.deepStrictEqual(m.code === 'MERGE_CONFLICT' && sorted(Object.keys(m)), ['code', 'files', 'ok'], where);
  if (m.ok) assert.ok(['pending', 'done'].includes(m.cleanup));
}

function checkLastOp(op, where) {
  assert.deepStrictEqual(sorted(Object.keys(op)), sorted(LASTOP_KEYS), `${where}: lastOp 필드`);
  assert.ok(OP_KINDS.includes(op.kind), `${where}: kind ${op.kind}`);
  if (op.code) assert.ok(tasks.ERROR_CODES.includes(op.code), `${where}: code ${op.code}`);
  if ((op.kind === 'pr.merge' || op.kind === 'merge.local') && op.result) checkMergeResult(op.result, `${where}.result`);
  if (op.kind === 'fix' && op.result) {
    const want = op.ok ? ['bytes', 'checks', 'comments', 'delivered', 'what'] : ['delivered', 'what'];
    assert.deepStrictEqual(sorted(Object.keys(op.result)), want, `${where}: fix 결과`);
    assert.ok(['ci', 'reviews', 'both'].includes(op.result.what));
  }
}

test('rpc-task.list.json — TaskLite(prompt 없음) + caps.gh', () => {
  const f = read('rpc-task.list.json');
  assert.strictEqual(f.method, 'task.list');
  assert.deepStrictEqual(sorted(Object.keys(f.result)), ['caps', 'items']);
  assert.deepStrictEqual(sorted(Object.keys(f.result.caps.gh)), ['ghAuthed', 'ghInstalled', 'gitOk']);
  f.result.items.forEach((t, i) => checkTask(t, `items[${i}]`, { prompt: false }));
});

test('rpc-task.get.json — Task = TaskLite + prompt', () => {
  const f = read('rpc-task.get.json');
  checkTask(f.result.task, 'task', { prompt: true });
  assert.strictEqual(typeof f.result.task.prompt, 'string');
});

test('rpc-task.diff.json — TaskDiff', () => {
  const d = read('rpc-task.diff.json').result;
  assert.deepStrictEqual(sorted(Object.keys(d)), sorted(['taskId', 'runId', 'base', 'baseSha', 'head', 'mergeBase', 'uncommitted', 'files', 'totals', 'truncatedTotal']));
  assert.deepStrictEqual(sorted(Object.keys(d.totals)), ['additions', 'deletions', 'files']);
  for (const fl of d.files) {
    for (const k of Object.keys(fl)) assert.ok(['path', 'status', 'additions', 'deletions', 'binary', 'diffText', 'truncated', 'omitted'].includes(k), k);
    assert.ok(['A', 'M', 'D', 'R', '?', 'B'].includes(fl.status));
  }
});

test('rpc-git.pr.status.json — {pr: PrInfo|null, run: RunLite}', () => {
  const f = read('rpc-git.pr.status.json');
  checkPr(f.result.pr, 'pr');
  checkRun(f.result.run, 'run');
  assert.strictEqual(f.examples.noPr.pr, null);
  assert.strictEqual(f.examples.closed.pr.state, 'closed');
});

test('rpc-op-accepted.json — OpAccepted + replay + lastOp 예시', () => {
  const f = read('rpc-op-accepted.json');
  const shapes = [f.result, ...Object.values(f.examples)];
  for (const a of shapes) {
    for (const k of Object.keys(a)) assert.ok(['accepted', 'opId', 'replay', 'run', 'lastOp'].includes(k), `OpAccepted ${k}`);
    assert.strictEqual(a.accepted, true);
    checkRun(a.run, 'op.run');
    if (a.lastOp) checkLastOp(a.lastOp, 'op.lastOp');
  }
  for (const [name, op] of Object.entries(f.lastOpExamples)) checkLastOp(op, name);
});

test('rpc-merge-result.json — ok:true(pending/done) · ok:false MERGE_CONFLICT(결과 코드)', () => {
  const f = read('rpc-merge-result.json');
  const names = f.cases.map((c) => c.name);
  assert.deepStrictEqual(names, ['ok-pending', 'ok-done', 'conflict']);
  for (const c of f.cases) checkLastOp(c.lastOp, c.name);
  const conflict = f.cases.find((c) => c.name === 'conflict').lastOp;
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.code, 'MERGE_CONFLICT');
  assert.ok(Array.isArray(conflict.result.files) && conflict.result.files.length);
});

test('rpc-errors.json — 코드 집합 = tasks.ERROR_CODES = 설계 §2.13 표 = §9 ERROR_KEY 키', () => {
  const f = read('rpc-errors.json');
  // automation-design 이 더한 코드(FOLLOWUP_*)는 이 표 밖 — rpc-errors-automation.json 이 정본(아래 테스트).
  const core = tasks.ERROR_CODES.filter((c) => !tasks.FOLLOWUP_ERROR_CODES.includes(c));
  assert.deepStrictEqual(sorted(f.codes), sorted(core));
  assert.strictEqual(new Set(f.codes).size, f.codes.length, '중복 없음');
  const doc = fs.readFileSync(path.join(DOCS, 'agent-tasks-design.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 2.13'), doc.indexOf('## 3. RPC 계약'));
  const docCodes = new Set();
  for (const line of sec.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1];
    for (const m of first.matchAll(/`([A-Z_]+)`/g)) docCodes.add(m[1]);
  }
  assert.deepStrictEqual(sorted(docCodes), sorted(core), '§2.13 표와 데몬 코드 집합이 같아야 한다(§12 변경 규칙)');
  const ek = doc.slice(doc.indexOf('**`ERROR_KEY`'));
  const keyed = new Set([...ek.slice(0, ek.indexOf('\n\n', ek.indexOf('`BAD_PARAMS'))).matchAll(/([A-Z_]{3,})→/g)].map((m) => m[1]));
  for (const c of core) assert.ok(keyed.has(c), `§9 ERROR_KEY 에 ${c} 없음`);
  assert.deepStrictEqual(f.resultOnlyCodes, ['MERGE_CONFLICT']);
  assert.match(f.wire.localSocket.example, /^[A-Z_]+: /);
  assert.strictEqual(f.wire.relayPlain.example.detail.code, 'TASK_NOT_FOUND');
});

test('model-*.json(PC 소유) 의 TaskLite 입력도 같은 화이트리스트를 쓴다', () => {
  const files = fs.readdirSync(FIX).filter((f) => /^model-.*\.json$/.test(f));
  for (const f of files) {
    const j = read(f);
    for (const h of (j.input && j.input.tasks) || []) {
      for (const t of h.items) {
        checkKeys(t, [...tasks.TASK_FIELDS, 'runs'], [...REQ_TASK, 'runs'], `${f} ${t.id}`);
        for (const r of t.runs) checkKeys(r, tasks.RUN_FIELDS, REQ_RUN, `${f} ${t.id}/${r.id}`);
      }
    }
  }
});

// ══ automation-design(S2) — docs/fixtures/automation/rpc-{dispatch.*,power.status,task.run.fix}.json ══════════
const AFIX = path.join(DOCS, 'fixtures', 'automation');
const aread = (f) => JSON.parse(fs.readFileSync(path.join(AFIX, f), 'utf8'));

test('rpc-task.get.json — origin·followup 추가 전용 필드 샘플이 있다(§8.3)', () => {
  const t = read('rpc-task.get.json').result.task;
  assert.ok(t.origin && t.origin.kind === 'automation');
  assert.ok(t.runs.some((r) => r.followup && r.followup.ci.status === 'failing' && r.followup.reviews.pending.length));
  assert.deepStrictEqual(sorted(tasks.OPTIONAL_TASK_FIELDS), ['origin']);
  assert.deepStrictEqual(sorted(tasks.OPTIONAL_RUN_FIELDS), ['followup']);
});

test('rpc-task.run.fix.json — OpAccepted(op fix) · lastOp 결과 키 · 이후 run(followup 해제)', () => {
  const f = aread('rpc-task.run.fix.json');
  assert.strictEqual(f.method, 'task.run.fix');
  assert.deepStrictEqual(sorted(Object.keys(f.result)), ['accepted', 'opId', 'run']);
  checkRun(f.result.run, 'fix.run');
  assert.strictEqual(f.result.run.op.kind, 'fix');
  for (const [name, op] of Object.entries(f.lastOpExamples)) checkLastOp(op, name);
  assert.strictEqual(f.lastOpExamples.notDelivered.code, 'PROMPT_NOT_DELIVERED');
  checkRun(f.runAfter, 'runAfter');
  assert.strictEqual(f.runAfter.followup.ci.status, null);
  assert.deepStrictEqual(f.runAfter.followup.reviews.pending, []);
  assert.deepStrictEqual(f.resultKeys, ['delivered', 'what', 'bytes', 'checks', 'comments']);
  assert.deepStrictEqual(f.dismiss.result, { ok: true });
});

test('rpc-dispatch.catalog.json / rpc-dispatch.get.json — dispatch 화이트리스트(done·fallback·planning)', () => {
  const dispatch = require('../dispatch');
  const c = aread('rpc-dispatch.catalog.json').result;
  assert.deepStrictEqual(sorted(Object.keys(c)), sorted(dispatch.CATALOG_FIELDS));
  for (const a of c.agents) assert.deepStrictEqual(sorted(Object.keys(a)), ['id', 'installed', 'loggedIn']);
  for (const w of c.workspaces) {
    assert.deepStrictEqual(sorted(Object.keys(w)), sorted(dispatch.WORKSPACE_FIELDS), w.id);
    assert.ok(Buffer.byteLength(w.readmeHead, 'utf8') <= 600 && w.recentCommits.length <= 5 && w.topDirs.length <= 12);
  }
  const g = aread('rpc-dispatch.get.json');
  assert.deepStrictEqual(sorted(Object.keys(g.planAccepted)), ['accepted', 'planId', 'planner']);
  assert.deepStrictEqual(sorted(Object.keys(g.examples)), ['done', 'fallback', 'planning']);
  for (const [name, rec] of Object.entries(g.examples)) {
    for (const k of Object.keys(rec)) assert.ok(['planId', 'state', 'plan', 'error', 'startedAt', 'finishedAt'].includes(k), `${name}: ${k}`);
    assert.ok(/^p_[0-9a-z]{10}$/.test(rec.planId), name);
    assert.ok(['planning', 'done', 'failed'].includes(rec.state));
    if (!rec.plan) continue;
    const p = rec.plan;
    assert.deepStrictEqual(sorted(Object.keys(p)), sorted(dispatch.PLAN_FIELDS), name);
    assert.deepStrictEqual(sorted(Object.keys(p.planner)), sorted(dispatch.PLANNER_FIELDS), name);
    assert.ok(['cli', 'fallback'].includes(p.planner.mode));
    if (p.planner.fallbackReason) assert.ok(dispatch.ERROR_CODES.includes(p.planner.fallbackReason));
    assert.ok(p.tasks.length <= 4 && p.automations.length <= 3 && p.questions.length <= 3);
    assert.ok(p.tasks.reduce((n, t) => n + t.agents.reduce((m, a) => m + a.count, 0), 0) <= 4);
    for (const t of p.tasks) assert.deepStrictEqual(sorted(Object.keys(t)), sorted(dispatch.PLAN_TASK_FIELDS), name);
    for (const a of p.automations) assert.deepStrictEqual(sorted(Object.keys(a)), ['draft', 'host', 'why'], name);
  }
  assert.strictEqual(g.examples.fallback.plan.planner.mode, 'fallback');
  assert.deepStrictEqual(g.examples.fallback.plan.automations, [], '폴백은 자동화를 제안하지 않는다');
});

test('rpc-power.status.json — power.STATUS_FIELDS · 열거값', () => {
  const power = require('../power');
  const f = aread('rpc-power.status.json');
  for (const st of [f.result, ...Object.values(f.examples)]) {
    assert.deepStrictEqual(sorted(Object.keys(st)), sorted(power.STATUS_FIELDS));
    assert.deepStrictEqual(sorted(Object.keys(st.layers)), ['caffeinate', 'disableSleep']);
    assert.ok(f.setupValues.includes(st.setup));
    assert.ok(f.lidBlockedValues.includes(st.lidBlocked));
    assert.ok(['ac', 'battery', 'unknown'].includes(st.power));
    if (st.setupError) assert.ok(power.ERROR_CODES.includes(st.setupError));
  }
});

test('rpc-errors-automation.json — dispatch/power/followup 절 = 데몬 코드 집합(S2)', () => {
  const file = path.join(AFIX, 'rpc-errors-automation.json');
  if (!fs.existsSync(file)) return; // S1 소유 — 아직 없으면 건너뛴다
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(sorted(f.dispatch), sorted(require('../dispatch').ERROR_CODES));
  assert.deepStrictEqual(sorted(f.power), sorted(require('../power').ERROR_CODES));
  assert.deepStrictEqual(sorted(f.followup), sorted(tasks.FOLLOWUP_ERROR_CODES));
  for (const c of tasks.FOLLOWUP_ERROR_CODES) assert.ok(tasks.ERROR_CODES.includes(c), c);
});
