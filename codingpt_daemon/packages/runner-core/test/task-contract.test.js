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
const OP_KINDS = ['commit', 'push', 'pr.create', 'pr.merge', 'merge.local', 'discard', 'reopen', 'cleanup'];
const LASTOP_KEYS = ['opId', 'kind', 'ok', 'code', 'message', 'result', 'at'];

function checkRun(r, where) {
  assert.deepStrictEqual(sorted(Object.keys(r)), sorted(tasks.RUN_FIELDS), `${where}: Run 필드`);
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
  for (const k of tasks.RUN_FIELDS) if (!LIVE.has(k)) assert.deepStrictEqual(again[k], r[k], `${where}: pickRun 재현 ${k}`);
}

function checkTask(t, where, { prompt }) {
  const want = [...tasks.TASK_FIELDS, 'runs', ...(prompt ? ['prompt'] : [])];
  assert.deepStrictEqual(sorted(Object.keys(t)), sorted(want), `${where}: Task 필드`);
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
  assert.deepStrictEqual(sorted(f.codes), sorted(tasks.ERROR_CODES));
  assert.strictEqual(new Set(f.codes).size, f.codes.length, '중복 없음');
  const doc = fs.readFileSync(path.join(DOCS, 'agent-tasks-design.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 2.13'), doc.indexOf('## 3. RPC 계약'));
  const docCodes = new Set();
  for (const line of sec.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1];
    for (const m of first.matchAll(/`([A-Z_]+)`/g)) docCodes.add(m[1]);
  }
  assert.deepStrictEqual(sorted(docCodes), sorted(tasks.ERROR_CODES), '§2.13 표와 데몬 코드 집합이 같아야 한다(§12 변경 규칙)');
  const ek = doc.slice(doc.indexOf('**`ERROR_KEY`'));
  const keyed = new Set([...ek.slice(0, ek.indexOf('\n\n', ek.indexOf('`BAD_PARAMS'))).matchAll(/([A-Z_]{3,})→/g)].map((m) => m[1]));
  for (const c of tasks.ERROR_CODES) assert.ok(keyed.has(c), `§9 ERROR_KEY 에 ${c} 없음`);
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
        assert.deepStrictEqual(sorted(Object.keys(t).filter((k) => k !== 'runs')), sorted(tasks.TASK_FIELDS), `${f} ${t.id}`);
        for (const r of t.runs) assert.deepStrictEqual(sorted(Object.keys(r)), sorted(tasks.RUN_FIELDS), `${f} ${t.id}/${r.id}`);
      }
    }
  }
});
