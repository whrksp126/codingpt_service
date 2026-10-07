'use strict';
// 오케스트레이션(orch.js) — docs/orchestration-design.md.
//  터미널·에이전트·작업(worktree)·알림은 전부 스텁이다(tmux/back 없이 계약만 검증).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-orch-')));
const STATE = path.join(ROOT, '.codingpt');
fs.mkdirSync(STATE, { recursive: true });
delete process.env.CPT_ORCH;
const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });
const orch = require('../orch');

after(() => { orch._internals._reset(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const COORD = { via: 'cli', tsession: 'cpt-proj--t-1', cwd: 'proj', tid: 1, agent: 'claude' };
const USER = { via: 'relay' };
let env;
function setup(over = {}) {
  orch._internals._reset();
  try { fs.rmSync(orch._internals.storeFile()); } catch (_) { /* 없음 */ }
  env = {
    nextTid: 10, terms: new Map(), launches: [], inputs: [], closed: [], keys: [], notes: [], pushes: [], taskCalls: [],
    config: {},
  };
  orch.configure({
    notify: (p) => env.notes.push(p),
    createTerminal: async ({ cwd }) => {
      const tid = env.nextTid++;
      const tsession = `cpt-${cwd}--t-${tid}`;
      env.terms.set(tsession, { exists: true, shell: false, agentState: 'working', attached: true });
      return { tid, tsession };
    },
    closeTerminal: async ({ cwd, tid }) => { env.closed.push(tid); env.terms.delete(`cpt-${cwd}--t-${tid}`); },
    launch: async (a) => { env.launches.push(a); return { ok: true, ready: true }; },
    chatInput: async (a) => { env.inputs.push(a); },
    keys: async (a) => { env.keys.push(a); },
    read: async () => 'screen text',
    probe: async ({ tsession }) => env.terms.get(tsession) || { exists: false, shell: null, agentState: null, attached: false },
    shellOf: async () => 'zsh',
    agents: { CATALOG: [{ id: 'claude', promptArg: { positional: true } }, { id: 'codex', promptArg: { positional: true } }, { id: 'paste', promptArg: null }] },
    agentModels: { valid: (v) => v == null || /^[\w.\-]+$/.test(v), launchArgs: (id, s) => (s.model ? ['--model', `'${s.model}'`] : []) },
    agentState: null,
    tasks: null,
    backFetch: async (m, p, b) => { env.pushes.push(b); return {}; },
    config: () => env.config,
    timings: { tickMs: 999999, launchTimeoutMs: 100, readyTimeoutMs: 300, readyPollMs: 10, reportNudgeMs: 0 },
    ...over,
  });
  orch.start();
}
beforeEach(() => setup());

const call = (m, p, meta = COORD) => orch.rpc(m, p || {}, meta);
const workerMeta = (w) => ({ via: 'cli', tsession: w.tsession, cwd: w.cwd, tid: w.tid, agent: w.agent });
async function startWorker(spec = '로그인 폼 검증 추가\n대상: a.js', extra = {}) {
  const r = await call('orch.workerStart', { spec, agent: 'claude', ...extra });
  return r.worker;
}
const rejects = (p, code) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return true; });

test('worker-start: 묶음을 알아서 만들고, 새 터미널에서 명세 파일을 인자로 에이전트를 띄운다', async () => {
  const w = await startWorker();
  assert.strictEqual(w.state, 'ready');
  assert.strictEqual(w.placement, 'current');
  assert.strictEqual(w.cwd, 'proj');
  assert.strictEqual(w.title, '로그인 폼 검증 추가');
  assert.strictEqual(env.launches.length, 1);
  const l = env.launches[0];
  assert.strictEqual(l.id, 'claude');
  assert.strictEqual(l.index, w.tid);
  assert.strictEqual(l.fresh, true);
  const file = orch._internals.promptFile(w.dispatchId);
  assert.equal(l.args[0], '--dangerously-skip-permissions', '워커는 권한 확인 생략 옵션으로 뜬다(Orca 기본값)');
  assert.ok(l.args[l.args.length - 1].includes(file), '프롬프트는 파일 치환으로 넘긴다');
  const prompt = fs.readFileSync(file, 'utf8');
  assert.ok(prompt.includes(`cpt orch done --dispatch ${w.dispatchId}`));
  assert.ok(prompt.includes('대상: a.js'));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const st = await call('orch.status');
  assert.strictEqual(st.caller.role, 'coordinator');
  assert.strictEqual((await call('orch.status', {}, workerMeta(w))).caller.role, 'worker');
});

test('worker_done → 코디네이터 수신함. ack 전까지 같은 배달이 다시 온다', async () => {
  const w = await startWorker();
  const done = await call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'succeeded', body: '했다. 알았다. 없다.', files: 'a.js, b.js' }, workerMeta(w));
  assert.deepStrictEqual(done.settlement, { action: 'settled', outcome: 'succeeded', duplicate: false });
  const c1 = await call('orch.check');
  assert.strictEqual(c1.messages.length, 1);
  assert.strictEqual(c1.messages[0].type, 'worker_done');
  assert.deepStrictEqual(c1.messages[0].payload.filesModified, ['a.js', 'b.js']);
  assert.strictEqual(c1.replay, false);
  const c2 = await call('orch.check');
  assert.strictEqual(c2.replay, true);
  assert.strictEqual(c2.deliveryId, c1.deliveryId);
  const c3 = await call('orch.check', { ack: c1.deliveryId });
  assert.strictEqual(c3.empty, true);
  // 끝난 워커는 정리 대상으로 보인다
  assert.deepStrictEqual(c3.workers.map((x) => x.attention), [['settled_unreleased']]);
  // 같은 보고를 또 보내면 중복으로 받아들인다(다시 정산하지 않는다)
  const again = await call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'failed', body: 'x' }, workerMeta(w));
  assert.strictEqual(again.settlement.duplicate, true);
  assert.strictEqual(again.settlement.outcome, 'succeeded');
  // 묶음이 다 끝나면 사용자에게 한 번 알린다
  assert.strictEqual(env.pushes.filter((p) => p.kind === 'orch_settled').length, 1);
});

test('보고 규율: 요약 없는 done · 남의 시도 ID · 워커 아닌 터미널은 거부', async () => {
  const w = await startWorker();
  await rejects(call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'succeeded', body: ' ' }, workerMeta(w)), 'BAD_PARAMS');
  await rejects(call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'ok', body: 'x' }, workerMeta(w)), 'BAD_PARAMS');
  await rejects(call('orch.send', { type: 'worker_done', dispatch: 'dsp_nope', outcome: 'succeeded', body: 'x' }, workerMeta(w)), 'NOT_YOUR_DISPATCH');
  await rejects(call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'succeeded', body: 'x' }, COORD), 'NOT_YOUR_DISPATCH');
});

test('check --wait: 메시지가 오면 깨어나고, 안 오면 시간 초과(실패 아님)', async () => {
  const w = await startWorker();
  const waiting = call('orch.check', { wait: true, types: 'worker_done', timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  // 종류가 다른 메시지로는 깨어나지 않는다
  await call('orch.send', { subject: '진행', body: '반쯤' }, workerMeta(w));
  await new Promise((r) => setTimeout(r, 30));
  await call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'failed', body: '못 했다. 이유. 남음.' }, workerMeta(w));
  const got = await waiting;
  assert.deepStrictEqual(got.messages.map((m) => m.type), ['status', 'worker_done'], '배달은 쌓인 것을 순서대로 전부 준다');
  await call('orch.check', { ack: got.deliveryId });
  const t = await call('orch.check', { wait: true, timeoutMs: 1000 });
  assert.strictEqual(t.timeout, true);
  assert.deepStrictEqual(t.messages, []);
});

test('기다리던 쪽이 사라지면(소켓 닫힘) 대기를 끝낸다', async () => {
  await startWorker();
  let close;
  const p = call('orch.check', { wait: true, timeoutMs: 60000 }, { ...COORD, onClose: (fn) => { close = fn; } });
  await new Promise((r) => setTimeout(r, 20));
  close();
  assert.strictEqual((await p).cancelled, true);
});

test('ask/reply: 막고 기다리다 답을 받는다. 시간 초과 뒤의 답은 수신함으로 간다', async () => {
  const w = await startWorker();
  const asking = call('orch.ask', { dispatch: w.dispatchId, question: 'A 로 할까 B 로 할까', options: 'A,B', timeoutMs: 5000 }, workerMeta(w));
  await new Promise((r) => setTimeout(r, 20));
  const inbox = await call('orch.check');
  const q = inbox.messages.find((m) => m.type === 'question');
  assert.deepStrictEqual(q.payload.options, ['A', 'B']);
  assert.strictEqual(inbox.workers[0].uiState, 'asking');
  const rep = await call('orch.reply', { id: q.id, body: 'A' });
  assert.strictEqual(rep.delivered, 'waiter');
  assert.deepStrictEqual(await asking, { answered: true, messageId: q.id, answer: 'A', answeredBy: 'coordinator' });

  const a2 = await call('orch.ask', { dispatch: w.dispatchId, question: '두 번째', timeoutMs: 1000 }, workerMeta(w));
  assert.strictEqual(a2.answered, false);
  assert.strictEqual(a2.timeout, true);
  // 사람(폰·PC)도 답할 수 있다
  const rep2 = await call('orch.reply', { id: a2.messageId, body: '그렇게 해' }, USER);
  assert.strictEqual(rep2.delivered, 'mailbox');
  const resumed = await call('orch.ask', { resume: a2.messageId, timeoutMs: 1000 }, workerMeta(w));
  assert.strictEqual(resumed.answer, '그렇게 해');
  assert.strictEqual(resumed.answeredBy, 'user');
  const mail = await call('orch.check', {}, workerMeta(w));
  assert.deepStrictEqual(mail.messages.map((m) => m.type), ['reply']);
});

test('DAG: 선행 일이 끝나야 시작할 수 있고, 선행이 실패하면 막힌다', async () => {
  await call('orch.runCreate', { objective: '스키마 → API' });
  const a = (await call('orch.taskCreate', { spec: '스키마 설계' })).task;
  const b = (await call('orch.taskCreate', { spec: 'API 구현', deps: a.id })).task;
  assert.strictEqual(a.status, 'ready');
  assert.strictEqual(b.status, 'pending');
  await rejects(call('orch.workerStart', { task: b.id }), 'TASK_NOT_READY');
  const wa = (await call('orch.workerStart', { task: a.id })).worker;
  await rejects(call('orch.workerStart', { task: a.id }), 'DISPATCH_ACTIVE');
  await call('orch.send', { type: 'worker_done', dispatch: wa.dispatchId, outcome: 'failed', body: '실패. 이유. 남음.' }, workerMeta(wa));
  let list = (await call('orch.taskList')).tasks;
  assert.deepStrictEqual(list.map((t) => t.status), ['failed', 'blocked']);
  // 실패한 일은 새 시도로 다시 시킨다
  const wa2 = (await call('orch.workerStart', { task: a.id, retryOf: wa.dispatchId })).worker;
  assert.notStrictEqual(wa2.dispatchId, wa.dispatchId);
  await call('orch.send', { type: 'worker_done', dispatch: wa2.dispatchId, outcome: 'succeeded', body: '했다. 됐다. 없다.' }, workerMeta(wa2));
  list = (await call('orch.taskList', { ready: true })).tasks;
  assert.deepStrictEqual(list.map((t) => t.id), [b.id]);
});

test('상한: 묶음당 동시 워커 수 · 중첩 깊이', async () => {
  env.config = { maxWorkersPerRun: 2, maxDepth: 2 };
  const w1 = await startWorker('일 1');
  await startWorker('일 2');
  await rejects(startWorker('일 3'), 'WORKER_LIMIT');
  // 워커가 하위 묶음을 만든다(깊이 1) → 그 워커의 워커(깊이 2)는 더 못 만든다
  const sub = await call('orch.workerStart', { spec: '하위 일' }, workerMeta(w1));
  assert.strictEqual(sub.run.depth, 1);
  assert.strictEqual((await call('orch.status', {}, workerMeta(w1))).caller.role, 'worker+coordinator');
  await rejects(call('orch.runCreate', { objective: '더 깊이' }, workerMeta(sub.worker)), 'DEPTH_EXCEEDED');
});

test('없음은 증거가 아니다: 살아 있는 워커는 포기할 수 없고, 끝난 것이 확인돼야 한다', async () => {
  const w = await startWorker();
  await rejects(call('orch.workerAbandon', { dispatch: w.dispatchId }), 'NOT_LIVE_PROOF');
  env.terms.set(w.tsession, { exists: true, shell: null, agentState: null, attached: false });
  assert.strictEqual((await call('orch.workerShow', { dispatch: w.dispatchId })).worker.liveness, 'unverifiable');
  await rejects(call('orch.workerAbandon', { dispatch: w.dispatchId }), 'NOT_LIVE_PROOF');
  env.terms.delete(w.tsession);
  const list = await call('orch.workerList');
  assert.strictEqual(list.workers[0].liveness, 'exited');
  assert.deepStrictEqual(list.workers[0].nextAction.argv, ['cpt', 'orch', 'worker-abandon', '--dispatch', w.dispatchId]);
  const ab = await call('orch.workerAbandon', { dispatch: w.dispatchId });
  assert.strictEqual(ab.worker.state, 'abandoned');
  assert.strictEqual((await call('orch.taskList')).tasks[0].status, 'failed');
});

test('정리: 끝나기 전에는 release 거부, 끝난 뒤 터미널을 닫는다. 재사용은 소유권을 넘긴다', async () => {
  const w = await startWorker();
  await rejects(call('orch.workerRelease', { dispatch: w.dispatchId }), 'DISPATCH_ACTIVE');
  await call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'succeeded', body: '했다. 됐다. 없다.' }, workerMeta(w));
  env.terms.set(w.tsession, { exists: true, shell: false, agentState: 'idle', attached: true });
  const next = (await call('orch.taskCreate', { spec: '다음 일' })).task;
  const w2 = (await call('orch.workerStart', { task: next.id, terminal: String(w.tid) })).worker;
  assert.strictEqual(w2.tid, w.tid);
  assert.strictEqual(env.launches.length, 1, '에이전트를 다시 띄우지 않는다');
  assert.ok(env.inputs.some((i) => i.tid === w.tid && i.text.includes('다음 일') && i.submit));
  assert.strictEqual((await call('orch.workerShow', { dispatch: w.dispatchId })).worker.terminal, 'transferred');
  await call('orch.send', { type: 'worker_done', dispatch: w2.dispatchId, outcome: 'succeeded', body: '했다. 됐다. 없다.' }, workerMeta(w2));
  const rel = await call('orch.workerRelease', { dispatch: w2.dispatchId });
  assert.strictEqual(rel.terminal, 'released');
  assert.deepStrictEqual(env.closed, [w.tid]);
  assert.strictEqual((await call('orch.workerList', { terminalState: 'reclaimable' })).workers.length, 0);
});

test('전용 작업 폴더 워커: 작업을 만들고, release --merge 가 머지 op 를 끝까지 기다린다', async () => {
  const store = { items: [] };
  const tasks = {
    _internals: { load: () => store },
    pickTask: (t) => t,
    internalCreate: async (p, origin) => {
      env.taskCalls.push(['create', p, origin]);
      const t = { id: 'tk1', runs: [{ id: 'r1', state: 'creating', branch: 'cpt/abc-1', cwd: '.codingpt/worktrees/x', tid: null, tsession: null }] };
      store.items.push(t);
      return { task: t };
    },
    rpc: async (m, p) => {
      env.taskCalls.push([m, p]);
      const r = store.items[0].runs[0];
      if (m === 'git.merge.local') { setTimeout(() => { r.lastOp = { opId: p.opId, ok: true, result: { sha: 'abc' } }; r.state = 'merged'; }, 30); return { accepted: true, opId: p.opId, run: r }; }
      if (m === 'task.get') return { task: store.items[0] };
      return {};
    },
  };
  setup({ tasks });
  const w = await startWorker('큰 리팩터', { worktree: 'new', model: 'opus' });
  assert.strictEqual(w.placement, 'worktree');
  assert.strictEqual(w.state, 'starting');
  const [, cp, origin] = env.taskCalls[0];
  assert.strictEqual(cp.repo, 'proj');
  assert.deepStrictEqual(cp.agents, [{ id: 'claude', model: 'opus', effort: null }]);
  assert.deepStrictEqual(origin, { kind: 'orch', planId: w.dispatchId });
  assert.ok(cp.prompt.includes('전용 git worktree'));
  // 터미널은 나중에 생긴다 — 좌표를 뒤늦게 채운다
  Object.assign(store.items[0].runs[0], { state: 'running', tid: 77, tsession: 'cpt-wt--t-77' });
  env.terms.set('cpt-wt--t-77', { exists: true, shell: false, agentState: 'working', attached: true });
  const wm = { via: 'cli', tsession: 'cpt-wt--t-77', cwd: '.codingpt/worktrees/x', tid: 77 };
  assert.strictEqual((await call('orch.status', {}, wm)).caller.role, 'worker');
  await call('orch.send', { type: 'worker_done', dispatch: w.dispatchId, outcome: 'succeeded', body: '했다. 됐다. 없다.' }, wm);
  const rel = await call('orch.workerRelease', { dispatch: w.dispatchId, merge: true, message: 'feat: x' });
  assert.strictEqual(rel.merged, true);
  const m = env.taskCalls.find((c) => c[0] === 'git.merge.local')[1];
  assert.strictEqual(m.taskId, 'tk1');
  assert.strictEqual(m.commitMessage, 'feat: x');
  assert.deepStrictEqual(env.closed, [], '작업 폴더 워커의 터미널은 작업 기능이 정리한다');
});

test('사람(릴레이·PC 앱)은 보기와 답하기·멈추기만 — 워커를 띄울 수 없다', async () => {
  const w = await startWorker();
  await rejects(call('orch.workerStart', { spec: 'x' }, USER), 'NOT_IN_TERMINAL');
  await rejects(call('orch.runCreate', { objective: 'x' }, USER), 'NOT_IN_TERMINAL');
  await rejects(call('orch.check', {}, USER), 'NOT_IN_TERMINAL');
  const list = await call('orch.list', {}, USER);
  assert.strictEqual(list.runs.length, 1);
  assert.strictEqual(list.runs[0].workers[0].uiState, 'working');
  assert.strictEqual(list.runs[0].coordinator.tid, 1);
  const st = await call('orch.workerStop', { dispatch: w.dispatchId }, USER);
  assert.strictEqual(st.worker.state, 'stopped');
  assert.deepStrictEqual(env.keys[0].keys, ['Escape']);
  // 좌표 없는 CLI 호출(일반 셸)은 거부
  await rejects(call('orch.status', {}, { via: 'cli', tsession: null, cwd: 'proj' }), 'NOT_IN_TERMINAL');
});

test('결정 게이트: 그 일은 고를 때까지 멈추고, 고르면 수신함으로 온다', async () => {
  await call('orch.runCreate', { objective: '갈림길' });
  const t = (await call('orch.taskCreate', { spec: '마이그레이션 적용' })).task;
  const g = (await call('orch.gateCreate', { task: t.id, question: '운영 DB 에 바로 적용할까', options: '적용,보류' })).gate;
  assert.strictEqual(env.pushes.some((p) => p.kind === 'orch_gate'), true);
  await rejects(call('orch.workerStart', { task: t.id }), 'TASK_NOT_READY');
  await call('orch.gateResolve', { id: g.id, resolution: '적용' }, USER);
  const inbox = await call('orch.check');
  assert.strictEqual(inbox.messages[0].type, 'decision_gate');
  assert.strictEqual(inbox.messages[0].payload.resolvedBy, 'user');
  assert.strictEqual((await call('orch.taskList', { ready: true })).tasks.length, 1);
});

test('깨우기: 기다리는 쪽이 없고 한가할 때만 입력창에 한 줄. 보고 없이 멈춘 워커는 두 번까지 알린다', async () => {
  const w = await startWorker();
  env.terms.set(COORD.tsession, { exists: true, shell: false, agentState: 'working', attached: true });
  await call('orch.send', { subject: '중간', body: '보고' }, workerMeta(w));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(env.inputs.length, 0, '일하는 중인 코디네이터에게는 넣지 않는다');
  env.terms.set(COORD.tsession, { exists: true, shell: false, agentState: 'idle', attached: true });
  await call('orch.send', { type: 'escalation', dispatch: w.dispatchId, subject: '막힘', body: '권한 없음' }, workerMeta(w));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(env.inputs.length, 1);
  assert.strictEqual(env.inputs[0].tid, 1);
  assert.ok(env.inputs[0].text.includes('cpt orch check'));
  assert.strictEqual(env.pushes.some((p) => p.kind === 'orch_escalation'), true);
  // 워커가 보고 없이 유휴가 됐다
  env.inputs.length = 0;
  env.terms.set(w.tsession, { exists: true, shell: false, agentState: 'idle', attached: true });
  await orch._internals.tick();
  await new Promise((r) => setTimeout(r, 15));
  await orch._internals.tick();
  await orch._internals.tick();
  await new Promise((r) => setTimeout(r, 10));
  const toWorker = env.inputs.filter((i) => i.tid === w.tid);
  assert.strictEqual(toWorker.length, 1, '연달아 두 번 넣지 않는다(1분 간격)');
  assert.ok(toWorker[0].text.includes(`--dispatch ${w.dispatchId}`));
  assert.ok((await call('orch.workerList')).workers[0].attention.categories.includes('idle_without_report'));
});

test('워커 시작 실패는 남은 자원을 알려 준다(그대로 다시 띄우지 않게)', async () => {
  setup({ launch: async () => ({ ok: false, busy: true }) });
  await assert.rejects(startWorker(), (e) => {
    assert.strictEqual(e.code, 'WORKER_START_FAILED');
    assert.strictEqual(e.failedStage, 'launch');
    assert.strictEqual(e.residualResources[0].kind, 'terminal');
    return true;
  });
  const run = (await call('orch.runList')).runs[0];
  assert.strictEqual(run.counts.failed, 1);
  assert.strictEqual(run.counts.active, 0);
});

test('워크스페이스 메모 · 묶음 닫기 · 재기동 뒤 복원 · 조용한 터미널 판정', async () => {
  const n = await call('orch.noteSet', { comment: '테스트 돌리는 중', status: 'in-progress' });
  assert.strictEqual(n.cwd, 'proj');
  await rejects(call('orch.noteSet', { status: 'nope' }), 'BAD_PARAMS');
  const w = await startWorker();
  assert.strictEqual(orch.quietSession(w.tsession), true);
  assert.strictEqual(orch.quietSession(COORD.tsession), false);
  await rejects(call('orch.runClose'), 'DISPATCH_ACTIVE');
  // 디스크에서 다시 읽어도 같다
  orch._internals._reset();
  orch.start();
  const list = await call('orch.list', {}, USER);
  assert.strictEqual(list.runs[0].workers[0].dispatchId, w.dispatchId);
  assert.deepStrictEqual(list.notes.map((x) => [x.cwd, x.comment, x.status]), [['proj', '테스트 돌리는 중', 'in-progress']]);
  const closed = await call('orch.runClose', { force: true });
  assert.strictEqual(closed.run.state, 'closed');
  assert.deepStrictEqual(closed.released, [w.dispatchId]);
  assert.strictEqual((await call('orch.list', {}, USER)).runs.length, 0);
  await rejects(call('orch.check'), 'NO_RUN');
});

test('워커 권한 — 기본은 확인 생략 인자(Orca 기본값), orch.workerPermissions="ask" 면 붙이지 않는다', () => {
  const orch = require('../orch');
  orch.configure({ config: () => ({}) });
  assert.deepEqual(orch.permissionArgs('claude'), ['--dangerously-skip-permissions']);
  assert.deepEqual(orch.permissionArgs('codex'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(orch.permissionArgs('gemini'), ['--yolo']);
  assert.deepEqual(orch.permissionArgs('unknown-agent'), []);
  orch.configure({ config: () => ({ workerPermissions: 'ask' }) });
  assert.deepEqual(orch.permissionArgs('claude'), []);
  orch.configure({ config: () => ({}) });
  const pre = orch.buildPreamble({ task: { id: 't', spec: 's' }, dispatch: { id: 'd' }, run: null, placement: 'current', canDispatch: false });
  assert.match(pre, /되돌리기 어려운 일은 \*\*하기 전에\*\*/);
});

// ── 흔적 정리(2026-10-08) — 이슈에서 시작한 터미널의 이름 · 에이전트가 적은 한 줄 메모의 수명 ──
//  실제 사고: 이슈 #7 을 "이슈로 시작" → 완료 처리 → /clear → exit → 다시 claude. 탭·사이드바는 계속 "#7 제목",
//  워크스페이스 메모는 계속 "완료 · 이슈 #7 완료" 였다(이름을 푸는 경로도, 메모를 지우는 경로도 없었다).
function traceSetup() {
  const t = { names: new Map(), renames: [], subs: new Set() };
  setup({
    createTerminal: async ({ cwd, name }) => {
      const tid = env.nextTid++;
      const tsession = `cpt-${cwd}--t-${tid}`;
      env.terms.set(tsession, { exists: true, shell: false, agentState: 'idle', attached: true });
      t.names.set(tsession, name || 'zsh');
      return { tid, tsession };
    },
    renameTerminal: async ({ tsession, name }) => { t.renames.push([tsession, name]); t.names.set(tsession, name || 'proj'); },
    termName: async ({ tsession }) => { if (!t.names.has(tsession)) throw new Error('no session'); return t.names.get(tsession); },
    agentState: { subscribe: (fn) => { t.subs.add(fn); return () => t.subs.delete(fn); }, snapshot: () => [] },
  });
  // agent-state 의 bump 통지 그대로: fn(rec, prev)
  t.agent = (tsession, state, prev) => { for (const fn of t.subs) fn({ key: tsession, state, cwdRel: 'proj' }, prev); };
  t.flush = () => new Promise((r) => { setImmediate(r); });
  t.startIssue = async (title) => {
    const x = (await call('orch.issueCreate', { title, cwd: 'proj' }, USER)).issue;
    const st = await call('orch.issueStart', { id: x.id, mode: 'terminal', agent: 'claude' }, USER);
    const tsession = `cpt-proj--t-${st.started.tid}`;
    return { issue: x, tid: st.started.tid, tsession, meta: { via: 'cli', tsession, cwd: 'proj', tid: st.started.tid, agent: 'claude' } };
  };
  return t;
}
const noteOf = async (cwd = 'proj') => (await call('orch.list', {}, USER)).notes.find((n) => n.cwd === cwd) || null;

test('흔적: 에이전트 종료 → 이슈로 붙인 터미널 이름이 풀린다(자동 개명 복귀). 일하는 동안에는 그대로', async () => {
  const t = traceSetup();
  const a = await t.startIssue('헤이보카 신규 qa');
  assert.strictEqual(t.names.get(a.tsession), `${a.issue.key} 헤이보카 신규 qa`);
  assert.strictEqual(orch._internals.load().labels[a.tsession].issueId, a.issue.id);
  t.agent(a.tsession, 'idle', 'launching'); t.agent(a.tsession, 'working', 'idle'); t.agent(a.tsession, 'idle', 'working');
  await t.flush();
  assert.deepStrictEqual(t.renames, [], '세션이 살아 있는 동안에는 이름을 건드리지 않는다');
  t.agent(a.tsession, 'ended', 'idle');   // exit(셸 복귀) 또는 /clear 의 session_end
  await t.flush();
  assert.deepStrictEqual(t.renames, [[a.tsession, '']], '빈 이름 = 보통 터미널 이름 규칙으로');
  assert.strictEqual(orch._internals.load().labels[a.tsession], undefined);
  // 그 뒤 새로 띄운 에이전트가 또 끝나도 다시 건드리지 않는다(대장에서 빠졌다)
  t.agent(a.tsession, 'idle', 'ended'); t.agent(a.tsession, 'ended', 'idle');
  await t.flush();
  assert.strictEqual(t.renames.length, 1);
});

test('흔적: 사람이 다시 지은 탭 이름은 풀지 않는다', async () => {
  const t = traceSetup();
  const a = await t.startIssue('이름 바꿀 것');
  t.names.set(a.tsession, '내가 지은 이름');
  t.agent(a.tsession, 'ended', 'idle');
  await t.flush();
  assert.deepStrictEqual(t.renames, []);
  assert.strictEqual(orch._internals.load().labels[a.tsession], undefined, '대장에서는 뺀다(더 따라다니지 않는다)');
});

test('흔적: 이슈 완료 → 그 이슈의 터미널 이름과, 그 이슈 터미널이 적은 메모가 정리된다', async () => {
  const t = traceSetup();
  const a = await t.startIssue('완료될 이슈');
  await call('orch.noteSet', { comment: 'qa 진행 중', status: 'in-progress' }, a.meta);
  assert.strictEqual((await noteOf()).issueId, a.issue.id, '이슈 터미널이 적은 메모는 그 이슈에 묶인다');
  await call('orch.issueUpdate', { id: a.issue.id, status: 'in_review' }, a.meta);
  await t.flush();
  assert.ok(await noteOf(), '완료가 아니면 남는다');
  assert.deepStrictEqual(t.renames, []);
  await call('orch.issueUpdate', { id: a.issue.id, status: 'done' }, a.meta);
  await t.flush();
  assert.strictEqual(await noteOf(), null);
  assert.deepStrictEqual(t.renames, [[a.tsession, '']]);
  assert.ok((await call('orch.issueGet', { id: a.issue.id }, USER)).issue.link, '이슈의 "시작한 일" 기록은 남긴다');
  assert.ok(env.notes.some((n) => n.reason === 'note'), '화면에 메모가 바뀌었다고 알린다');
});

test('흔적: 완료 뒤에 적은 "완료" 메모는 그 에이전트 세션이 끝나면 사라진다 — 실제 사고 순서', async () => {
  const t = traceSetup();
  const a = await t.startIssue('헤이보카 신규 qa');
  await call('orch.issueUpdate', { id: a.issue.id, status: 'done' }, a.meta);
  await call('orch.noteSet', { comment: `이슈 ${a.issue.key} 완료 — prod 배포됨`, status: 'completed' }, a.meta);
  await t.flush();
  assert.ok(await noteOf(), '세션이 살아 있는 동안에는 보인다(방금 한 보고다)');
  t.agent(a.tsession, 'ended', 'idle');   // /clear 또는 exit
  await t.flush();
  assert.strictEqual(await noteOf(), null);
});

test('흔적: 지우지 않는 것 — 사람이 적은 메모, 다른 터미널이 적은 메모, 끝나지 않은 단계의 메모', async () => {
  const t = traceSetup();
  const a = await t.startIssue('남의 메모');
  // ① 사람이 화면에서 적은 메모
  await call('orch.noteSet', { cwd: 'proj', comment: '내 메모', status: 'completed' }, USER);
  t.agent(a.tsession, 'ended', 'idle');
  await call('orch.issueUpdate', { id: a.issue.id, status: 'done' }, USER);
  await t.flush();
  assert.strictEqual((await noteOf()).comment, '내 메모');
  // ② 다른 터미널(코디네이터)이 적은 완료 메모 — 이 터미널이 끝나도 남는다
  await call('orch.noteSet', { comment: '배포 끝', status: 'completed' }, COORD);
  t.agent(a.tsession, 'ended', 'idle');
  await t.flush();
  assert.strictEqual((await noteOf()).comment, '배포 끝');
  // ③ 적은 터미널이 끝나도 진행 중 메모는 남는다(이어서 할 일일 수 있다). completed 로 바꾸면 끝날 때 치운다
  await call('orch.noteSet', { comment: '리팩터링 중', status: 'in-progress' }, COORD);
  t.agent(COORD.tsession, 'ended', 'idle');
  await t.flush();
  assert.strictEqual((await noteOf()).comment, '리팩터링 중');
  await call('orch.noteSet', { status: 'completed' }, COORD);
  t.agent(COORD.tsession, 'ended', 'idle');
  await t.flush();
  assert.strictEqual(await noteOf(), null);
});

test('흔적: 놓친 사건 따라잡기 — 데몬이 꺼진 사이 끝난 세션·옛 메모(적은 터미널 모름)', async () => {
  const t = traceSetup();
  const a = await t.startIssue('재기동 사이에 끝남');
  await call('orch.noteSet', { comment: '끝', status: 'completed' }, a.meta);
  // 막 만든 터미널은 에이전트가 뜨기 전까지 셸이다 — 그 사이를 끝난 것으로 읽지 않는다
  env.terms.set(a.tsession, { exists: true, shell: true, agentState: null, attached: false });
  orch._internals.load().notes.proj.tsession = null;   // 메모는 따로 본다
  await orch._internals.reconcileTraces({ force: true });
  assert.deepStrictEqual(t.renames, []);
  // 시간이 지났고 셸이다(에이전트 없음이 확인됐다) → 이름을 푼다
  orch._internals.load().labels[a.tsession].at = Date.now() - 5 * 60 * 1000;
  orch._internals.load().notes.proj.tsession = a.tsession;
  await orch._internals.reconcileTraces({ force: true });
  assert.deepStrictEqual(t.renames, [[a.tsession, '']]);
  assert.strictEqual(await noteOf(), null, '적은 터미널에 에이전트가 없으면 완료 메모도 치운다');
  // 모름(조회 실패)은 증거가 아니다
  const b = await t.startIssue('조회 실패');
  orch._internals.load().labels[b.tsession].at = Date.now() - 5 * 60 * 1000;
  orch.configure({ probe: async () => null });
  await orch._internals.reconcileTraces({ force: true });
  assert.ok(orch._internals.load().labels[b.tsession]);
  // 옛 메모: 누가 적었는지 모르지만 글의 #번호가 이 폴더의 완료된 자체 이슈다 → 그 이슈의 흔적
  const s = orch._internals.load();
  s.notes.proj = { comment: `이슈 ${a.issue.key} 완료 — prod 배포됨`, status: 'completed', by: 'claude', at: 1 };
  await orch._internals.reconcileTraces({ force: true });
  assert.ok(await noteOf(), '그 이슈가 아직 완료가 아니면 남는다');
  await call('orch.issueUpdate', { id: a.issue.id, status: 'done' }, USER);
  s.notes.proj = { comment: `이슈 ${a.issue.key} 완료 — prod 배포됨`, status: 'completed', by: 'claude', at: 1 };
  s.notes.other = { comment: `이슈 ${a.issue.key} 완료`, status: 'completed', by: 'claude', at: 1 };
  await orch._internals.reconcileTraces({ force: true });
  assert.strictEqual(await noteOf(), null);
  assert.ok(await noteOf('other'), '다른 폴더의 같은 번호는 근거가 아니다');
});

test('흔적: 진짜 agent-state 와 맞물린다 — session_end(/clear·exit) 와 셸 복귀 관찰이 이름을 푼다', async () => {
  const as = require('../agent-state');
  as._reset();
  as.configure({ notify: async () => {}, emit: () => true, log: () => {} });
  const t = traceSetup();
  orch._internals._reset();
  orch.configure({ agentState: as });
  orch.start();
  try {
    // /clear: session_end → session_start. 지운 대화의 이름(이슈)이 새 대화에 따라붙지 않는다.
    const a = await t.startIssue('clear 로 지울 대화');
    const id = { tid: a.tid, cwdRel: 'proj', agent: 'claude', sessionId: 's1' };
    await as.applyHook(a.tsession, { ...id, event: 'session_start' });
    await as.applyHook(a.tsession, { ...id, event: 'prompt' });
    await as.applyHook(a.tsession, { ...id, event: 'stop' });
    await t.flush();
    assert.deepStrictEqual(t.renames, []);
    await as.applyHook(a.tsession, { ...id, event: 'session_end' });
    await as.applyHook(a.tsession, { ...id, sessionId: 's2', event: 'session_start' });
    await t.flush();
    assert.deepStrictEqual(t.renames, [[a.tsession, '']]);
    // 훅 없이 죽은 에이전트(폴백 관찰: 셸 복귀)
    const b = await t.startIssue('훅 없이 종료');
    await as.applyWatch(b.tsession, { tid: b.tid, cwdRel: 'proj', agent: 'codex', observedState: 'working' });
    await as.applyWatch(b.tsession, { tid: b.tid, cwdRel: 'proj', shell: true });
    await t.flush();
    assert.deepStrictEqual(t.renames.map((r) => r[0]), [a.tsession, b.tsession]);
  } finally { as._reset(); }
});

test('흔적: 대장이 생기기 전에 이슈로 시작한 터미널도 따라잡는다(탭 이름이 우리가 붙인 그대로일 때만)', async () => {
  const t = traceSetup();
  const a = await t.startIssue('옛 이슈 터미널');
  const b = await t.startIssue('옛 이슈 · 사람이 이름을 바꿈');
  await call('orch.issueUpdate', { id: a.issue.id, status: 'done' }, USER);   // 대장이 있으면 여기서 풀린다 — 옛 상태를 다시 만든다
  await t.flush();
  t.renames.length = 0;
  t.names.set(a.tsession, `${a.issue.key} 옛 이슈 터미널`);
  t.names.set(b.tsession, '내 이름');
  orch._internals.load().labels = {};
  orch._internals._reset();
  orch.configure({ sessionOf: async ({ cwd, tid }) => `cpt-${cwd}--t-${tid}` });
  orch.start();
  await orch._internals.reconcileTraces({ force: true });
  assert.deepStrictEqual(t.renames, [[a.tsession, '']], '완료된 이슈의 이름만 풀린다');
  assert.strictEqual(t.names.get(b.tsession), '내 이름');
});
