'use strict';
// Agent Tasks 오케스트레이션(tasks.js) — 설계 정본 docs/agent-tasks-design.md §2·§3·§7.1.
//  실제 git(임시 저장소·bare origin) + 가짜 claude/codex/gh + 터미널/tmux 는 전부 스텁.
//  ★ 실 tmux(-L codingpt)·실 데몬·back 에 닿는 경로는 없다(격리 소켓 이름까지 바꿔 둔다).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── 격리(require 전에!) ──────────────────────────────────────────────────────
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tasks-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
const GH_LOG = path.join(ROOT, 'gh.log');
const PR_JSON = path.join(ROOT, 'pr.json');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '[user]\n\temail = dev@example.com\n\tname = Dev\n');
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-tasks-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_LAN_SCOPE = 'off';
process.env.GH_LOG = GH_LOG;
process.env.GH_PR_JSON = PR_JSON;
delete process.env.CPT_E2EE;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });
fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9', deviceToken: 'cptd_test', deviceId: 42 }), { mode: 0o600 });

for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(BIN, name), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
}
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
echo "$*" >> "$GH_LOG"
need_repo() { case " $* " in *" --repo "*) ;; *) echo "missing --repo" >&2; exit 3;; esac; }
case "$1" in
  --version) echo "gh version 2.60.0"; exit 0;;
  auth) exit 0;;
  api) echo "tester"; exit 0;;
  repo) echo '{"owner":{"login":"acme"},"name":"demo"}'; exit 0;;
  pr)
    need_repo "$@"
    case "$2" in
      create) cat > /dev/null; echo "https://github.com/acme/demo/pull/7"; exit 0;;
      view) cat "$GH_PR_JSON"; exit 0;;
      merge)
        # 머지 큐 흉내($GH_PR_JSON.queue 있음): gh 는 0 으로 끝나지만 PR 은 OPEN 그대로. 아니면 MERGED 로 뒤집는다.
        if [ ! -f "$GH_PR_JSON.queue" ]; then sed -i.bak 's/"state":"OPEN"/"state":"MERGED"/' "$GH_PR_JSON"; fi
        exit 0;;
    esac;;
esac
exit 2
`, { mode: 0o755 });

const agents = require('../agents');
agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
const taskGit = require('../task-git');
taskGit.resetCache();
const agentState = require('../agent-state');
const realPty = require('../pty');
const tasks = require('../tasks');
const I = tasks._internals;

// ── 스텁 ─────────────────────────────────────────────────────────────────────
const sessions = new Map(); // tsession → { command, title }
let tidSeq = 1000001;
let wsSeq = 1;
const calls = { launch: [], input: [], dialog: [], keys: [], back: [], notify: [], pool: 0, close: [] };
let screenFor = () => '';
let signalFor = () => ({ on: false });
let launchReply = () => ({ ok: true, ready: true });
const asNotified = [];

const ptyStub = {
  sessionForCwd: realPty.sessionForCwd,
  termSession: realPty.termSession,
  createTerminal: async (ns) => {
    const index = tidSeq++;
    const session = realPty.termSession(ns, index);
    sessions.set(session, { command: 'zsh', title: '' });
    return { index, name: '', session };
  },
  handleTerminalRpc: async (m, p) => {
    calls.close.push({ m, ...p });
    const { session } = realPty.sessionForCwd(p.cwd);
    sessions.delete(realPty.termSession(session, p.index));
    return { ok: true };
  },
};
const tbStub = {
  listSessionNames: async () => [...sessions.keys()],
  info: async (name) => {
    const s = sessions.get(name);
    if (!s) throw new Error("can't find session");
    return { name, command: s.command, title: s.title, cols: 80, rows: 24, cursor: { x: 0, y: 0 }, panePid: 1, windowName: '' };
  },
  rename: async () => {},
  kill: async (n) => { sessions.delete(n); },
  capture: async () => '',
};
function sessionByTid(tid) { for (const [k, v] of sessions) if (k.endsWith(`--t-${tid}`)) return v; return null; }

function wire() {
  tasks.configure({
    launch: async (a) => {
      calls.launch.push(a);
      const rep = launchReply(a);
      const s = sessionByTid(a.index);
      if (s && rep.ok) s.command = a.id === 'claude' ? '2.1.220' : a.id;
      return rep;
    },
    chatInput: async (a) => { calls.input.push(a); return { ok: true }; },
    chatDialog: async (a) => { calls.dialog.push(a); return { ok: true, dialog: null }; },
    keys: async (a) => { calls.keys.push(a); },
    screen: async (a) => screenFor(a),
    backFetch: async (m, p, b) => {
      calls.back.push({ m, p, b });
      if (m === 'POST' && p === '/api/daemon/workspaces') return { id: `ws_${wsSeq++}` };
      return {};
    },
    notify: (x) => { calls.notify.push(x); },
    poolChanged: () => { calls.pool += 1; },
    deviceId: () => 42,
    log: () => {},
    deps: {
      pty: ptyStub, termBackend: tbStub, manifest: { forget() {} },
      agentWatch: { agentSignalOf: (s, cmd, title) => signalFor(s, cmd, title) },
    },
    timings: {
      trustWindowMs: 600, trustPollMs: 20, trustPendingPollMs: 30,
      readyTimeoutMs: 400, readyPollMs: 20, readyStableMs: 60,
      stopDebounceMs: 30, poolCoalesceMs: 20, launchTimeoutMs: 100,
    },
  });
}
agentState.configure({ notify: async (payload) => { asNotified.push(payload); }, emit: () => false, log: () => {} });
wire();
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
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const uuid = () => crypto.randomUUID();
const call = (m, p) => tasks.rpc(m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor 시간 초과');
    await sleep(15);
  }
}
let repoSeq = 0;
function makeRepo({ origin = false, sub = null } = {}) {
  const rel = `work/proj${++repoSeq}`;
  const dir = path.join(ROOT, rel);
  fs.mkdirSync(dir, { recursive: true });
  G(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  if (sub) { fs.mkdirSync(path.join(dir, sub), { recursive: true }); fs.writeFileSync(path.join(dir, sub, 'p.txt'), 'p\n'); }
  G(dir, 'add', '-A');
  G(dir, 'commit', '-q', '-m', 'init');
  if (origin) {
    const bare = path.join(ROOT, `origin${repoSeq}.git`);
    G(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
    G(dir, 'remote', 'add', 'origin', bare);
    G(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  return { rel, dir };
}
async function getTask(id) { return (await call('task.get', { taskId: id })).task; }
async function createTask(repoRel, agentsSpec, extra = {}) {
  const r = await call('task.create', { opId: uuid(), repo: repoRel, base: 'main', prompt: '로그인 폼 검증 추가', agents: agentsSpec, ...extra });
  await I._drain();
  return getTask(r.task.id);
}
// 상한(저장소당 8·전체 12)이 테스트 사이에 누적되지 않게 앞선 작업을 종결 상태로 접는다.
function closeAll() {
  I.mutate((s) => {
    for (const t of s.items) {
      if (t.state === 'open') { t.state = 'closed'; t.closedAt = Date.now(); }
      for (const r of t.runs) if (!['merged', 'discarded'].includes(r.state)) r.state = 'discarded';
    }
  });
}
async function opDone(taskId, runId, opId) {
  return waitFor(async () => {
    await I._drain();
    const t = await getTask(taskId);
    const r = t.runs.find((x) => x.id === runId);
    return r.lastOp && r.lastOp.opId === opId && !r.op ? { t, r } : null;
  });
}

// ══════════════════════════════════════════════════════════════════════════
test('repoSlug — `--` 없음·32자·빈 값 repo', () => {
  assert.strictEqual(tasks.repoSlug('My--Repo__한글'), 'my-repo');
  assert.strictEqual(tasks.repoSlug('한글만'), 'repo');
  assert.strictEqual(tasks.repoSlug('a'.repeat(40)), 'a'.repeat(32));
  assert.ok(!tasks.repoSlug('x - - y').includes('--'));
});

test('create — 즉시 회신(creating) → 비동기 완료 후 running·promptDelivered, 런치 인자 = 프롬프트 파일(0600), 이름 규칙, poolChanged 1회', async () => {
  const { rel, dir } = makeRepo();
  calls.launch.length = 0; calls.back.length = 0; calls.notify.length = 0; calls.pool = 0;
  const r = await call('task.create', { opId: uuid(), repo: rel, base: 'main', prompt: '로그인 폼 검증 추가\n자세히', agents: [{ id: 'claude', count: 2 }, { id: 'codex', count: 2 }] });
  assert.strictEqual(r.task.state, 'open');
  assert.strictEqual(r.task.runs.length, 4);
  assert.ok(r.task.runs.every((x) => x.state === 'creating'));
  assert.ok(!('prompt' in r.task), 'TaskLite 에는 프롬프트가 없다');
  assert.strictEqual(r.task.title, '로그인 폼 검증 추가');
  assert.deepStrictEqual(Object.keys(r.task.repo).sort(), [...tasks.REPO_FIELDS].sort());
  await I._drain();
  await sleep(60); // poolChanged 코얼레싱 창
  const t = await getTask(r.task.id);
  assert.strictEqual(t.prompt, '로그인 폼 검증 추가\n자세히');
  const t6 = t.id.slice(-6);
  for (const run of t.runs) {
    assert.strictEqual(run.state, 'running', JSON.stringify(run.error));
    assert.strictEqual(run.promptMode, 'arg');
    assert.strictEqual(run.promptDelivered, true);
    assert.strictEqual(run.branch, `cpt/${t6}-${run.idx}`);
    assert.strictEqual(run.dir, `.codingpt/worktrees/${tasks.repoSlug(path.basename(dir))}-${t6}-${run.idx}`);
    assert.ok(!path.basename(run.dir).includes('--'), '폴더명에 -- 금지(liveWorkspaceNs 불변식)');
    assert.strictEqual(run.cwd, run.dir);
    assert.ok(run.baseSha && run.tid && run.tsession);
    assert.ok(run.tsession.startsWith('cpt-'), 'hasCptContext 가 cpt- 접두로 통과');
    assert.deepStrictEqual(run.copiedFiles, ['.env']);
    assert.strictEqual(run.workspaceId && run.workspaceId.startsWith('ws_'), true);
    assert.strictEqual(run.terminalAlive, true);
    assert.deepStrictEqual(Object.keys(run).sort(), [...tasks.RUN_FIELDS].sort(), '와이어 화이트리스트');
    const pf = path.join(STATE, 'tasks', t.id, `${run.id}.prompt`);
    assert.strictEqual(fs.readFileSync(pf, 'utf8'), t.prompt);
    assert.strictEqual(fs.statSync(pf).mode & 0o777, 0o600);
    const la = calls.launch.find((x) => x.index === run.tid);
    assert.deepStrictEqual(la.args, [`"$(cat '${pf}')"`], '프롬프트 내용은 셸 평가를 거치지 않는다(파일 cat)');
    assert.strictEqual(la.cwd, run.cwd);
  }
  assert.strictEqual(G(dir, 'worktree', 'list').split('\n').length, 5);
  // 워크스페이스 등록: 의미 없는 이름 + remoteUrl null
  const regs = calls.back.filter((c) => c.p === '/api/daemon/workspaces');
  assert.strictEqual(regs.length, 4);
  for (const c of regs) {
    assert.match(c.b.name, new RegExp(`^proj\\d+-${t6}-\\d$`));
    assert.strictEqual(c.b.remoteUrl, null);
    assert.strictEqual(c.b.compute, 'local');
    assert.strictEqual(c.b.hostDeviceId, 42);
    assert.match(c.b.localPath, /^\.codingpt\/worktrees\//);
  }
  assert.strictEqual(calls.pool, 1, 'poolChanged 는 작업의 모든 터미널이 생긴 뒤 1회');
  // 이벤트에는 id/reason 만(프롬프트·제목 없음)
  assert.ok(calls.notify.some((n) => n.reason === 'created'));
  assert.ok(calls.notify.every((n) => Object.keys(n).sort().join() === 'reason,taskIds'));
  assert.ok(!JSON.stringify(calls.notify).includes('로그인'));
  const tl = await call('task.list', {});
  assert.ok(tl.items.some((x) => x.id === t.id && !('prompt' in x)));
  assert.deepStrictEqual(tl.caps.gh, { gitOk: true, ghInstalled: true, ghAuthed: true });
  closeAll();
});

test('create 검증 — PROMPT_TOO_LARGE(30001B)·TASK_LIMIT·제외 에이전트·BASE_NOT_FOUND·NOT_A_REPO·AGENT_NOT_INSTALLED·opId 필수', async () => {
  const { rel } = makeRepo();
  const base = { repo: rel, base: 'main', prompt: 'x', agents: [{ id: 'claude', count: 1 }] };
  const bad = (p, code) => assert.rejects(() => call('task.create', { opId: uuid(), ...base, ...p }), (e) => e.code === code, code);
  await bad({ prompt: 'a'.repeat(30001) }, 'PROMPT_TOO_LARGE');
  await bad({ prompt: '가'.repeat(10001) }, 'PROMPT_TOO_LARGE'); // 30003 바이트(UTF-8 3바이트)
  await bad({ agents: [{ id: 'claude', count: 3 }, { id: 'codex', count: 2 }] }, 'TASK_LIMIT');
  await bad({ agents: [{ id: 'cursor-agent', count: 1 }] }, 'BAD_PARAMS');
  await bad({ agents: [{ id: 'opencode', count: 1 }] }, 'BAD_PARAMS');
  await bad({ agents: [{ id: 'gemini', count: 1 }] }, 'AGENT_NOT_INSTALLED');
  await bad({ base: 'nope' }, 'BASE_NOT_FOUND');
  await bad({ base: '-x' }, 'BAD_PARAMS');
  fs.mkdirSync(path.join(ROOT, 'work', 'plain'), { recursive: true });
  await bad({ repo: 'work/plain' }, 'NOT_A_REPO');
  await bad({ repo: '../../etc' }, 'NOT_A_REPO');
  await bad({ repo: '.codingpt' }, 'NOT_A_REPO');
  await assert.rejects(() => call('task.create', { ...base }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('task.nope', {}), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('task.get', { taskId: 't_zzzzzzzzzz' }), (e) => e.code === 'TASK_NOT_FOUND');
});

test('opId 재생 — 같은 opId 두 번 → 작업 1개 + replay:true', async () => {
  const { rel } = makeRepo();
  const opId = uuid();
  const n0 = I.load().items.length;
  const p = { opId, repo: rel, base: 'main', prompt: 'x', agents: [{ id: 'codex', count: 1 }] };
  const a = await call('task.create', p);
  const b = await call('task.create', p);
  assert.strictEqual(a.task.id, b.task.id);
  assert.strictEqual(b.replay, true);
  assert.strictEqual(I.load().items.length, n0 + 1);
  await I._drain();
  closeAll();
});

test('서브디렉토리 워크스페이스 — repo.subdir, run.cwd = dir/subdir', async () => {
  const { rel } = makeRepo({ sub: 'pkg' });
  const t = await createTask(`${rel}/pkg`, [{ id: 'claude', count: 1 }]);
  assert.strictEqual(t.repo.path, rel);
  assert.strictEqual(t.repo.subdir, 'pkg');
  const run = t.runs[0];
  assert.strictEqual(run.cwd, `${run.dir}/pkg`);
  assert.ok(run.tsession.includes('pkg'), '터미널 세션은 run.cwd 기준');
  closeAll();
});

// 2026-09-29 실측 claude 2.1.284 신뢰 화면 — 번호 없음, No 가 먼저(커서), 수락은 두 번째.
const TRUST_SCREEN = [
  '────────────────────────────────────────',
  ' Accessing workspace:',
  ' /Users/me/.codingpt/worktrees/proj-abc-1',
  ' Quick safety check: Is this a project you created or one you trust? (Like your',
  ' own code, a well-known open source project, or work from your team).',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

test('폴더 신뢰 — 다이얼로그 감지 → trustPending → task.run.trust 가 수락 선택지로 커서를 옮겨 Enter(자동 수락 없음)', async () => {
  const { rel } = makeRepo();
  let trusted = false;
  screenFor = () => (trusted ? '' : TRUST_SCREEN);
  calls.keys.length = 0;
  try {
    const t0 = await createTask(rel, [{ id: 'claude', count: 1 }]);
    const t = await waitFor(async () => { const x = await getTask(t0.id); return x.runs[0].trustPending ? x : null; });
    assert.strictEqual(calls.keys.length, 0, '자동 수락하지 않는다');
    const origPush = calls.keys.push.bind(calls.keys);
    calls.keys.push = (a) => { trusted = true; return origPush(a); };   // 키를 받으면 실화면처럼 다이얼로그가 사라진다
    const res = await call('task.run.trust', { taskId: t.id, runId: t.runs[0].id });
    calls.keys.push = origPush;
    assert.deepStrictEqual(res, { ok: true, dialog: null });
    assert.strictEqual(calls.keys.length, 1);
    // ★ 첫 선택지는 "No, exit" — pick 1 이면 claude 가 종료된다. Down 1회 후 Enter.
    assert.deepStrictEqual(calls.keys[0].keys, ['Down', 'Enter']);
    assert.strictEqual(calls.keys[0].tid, t.runs[0].tid);
    assert.strictEqual((await getTask(t.id)).runs[0].trustPending, false);
    const again = await call('task.run.trust', { taskId: t.id, runId: t.runs[0].id });
    assert.deepStrictEqual(again, { ok: true, dialog: null });
    assert.strictEqual(calls.keys.length, 1, '다이얼로그가 없으면 아무 키도 안 보낸다');
  } finally { screenFor = () => ''; }
  closeAll();
});

test('폴더 신뢰 판정 — claude(번호 없음)·codex(번호)·일반 입력창 오탐 없음', () => {
  const f = tasks._internals.trustDialogOf;
  const c = f(TRUST_SCREEN);
  assert.strictEqual(c.cursor, 0); assert.strictEqual(c.yes, 1);
  const x = f('\n  Do you trust the contents of this directory? Working with untrusted contents\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n');
  assert.strictEqual(x.cursor, 0); assert.strictEqual(x.yes, 0);
  // codex 실측: 맨 위 `> You are in …` 안내 줄의 '>' 를 커서로 잡으면 안 된다(가장 아래 표시 줄이 커서).
  const cx = f(['> You are in /Users/me/.codingpt/worktrees/p-abc-2', '', '  Do you trust the contents of this directory? Working with untrusted contents', '  comes with higher risk of prompt injection.', '', '› 1. Yes, continue', '  2. No, quit', '', '  Press enter to continue'].join('\n'));
  assert.ok(cx, 'codex 신뢰 화면 감지'); assert.strictEqual(cx.cursor, 0); assert.strictEqual(cx.yes, 0);
  assert.strictEqual(f('╭──╮\n│ > I trust you, fix it │\n╰──╯'), null);
  assert.strictEqual(f('> hello world\n  some prompt'), null);
});

test('paste 준비 판정 — pane 이 셸인 동안·rawState launching 인 동안 chatInput 을 호출하지 않는다', async () => {
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const run = t.runs[0];
  calls.input.length = 0;
  sessions.get(run.tsession).command = 'zsh';          // 에이전트가 안 돈다(셸)
  const r1 = await call('task.run.prompt', { taskId: t.id, runId: run.id });
  assert.deepStrictEqual(r1, { ok: false, delivered: false });
  assert.strictEqual(calls.input.length, 0, '셸에 그냥 타이핑하지 않는다');
  assert.strictEqual((await getTask(t.id)).runs[0].error.code, 'PROMPT_NOT_DELIVERED');
  // 훅은 왔지만 상태 미확정(launching) — 아직 준비 아님
  sessions.get(run.tsession).command = '2.1.220';
  await agentState.applyHook(run.tsession, { event: 'notification', notificationType: 'auth_success', tid: run.tid, cwdRel: run.cwd });
  assert.strictEqual(agentState.rawStateOf(run.tsession), 'launching');
  assert.strictEqual(agentState.statusOf(run.tsession), 'idle', 'statusOf 는 launching 을 idle 로 접는다 — 그래서 게이트가 못 된다');
  const r2 = await call('task.run.prompt', { taskId: t.id, runId: run.id });
  assert.strictEqual(r2.delivered, false);
  assert.strictEqual(calls.input.length, 0);
  // SessionStart → 준비됨 → 1회 붙여넣기
  await agentState.applyHook(run.tsession, { event: 'session_start', sessionId: 'sess-paste', tid: run.tid, cwdRel: run.cwd });
  const r3 = await call('task.run.prompt', { taskId: t.id, runId: run.id, text: '다시 해줘' });
  assert.deepStrictEqual(r3, { ok: true, delivered: true });
  assert.strictEqual(calls.input.length, 1);
  assert.deepStrictEqual(calls.input[0], { cwd: run.cwd, tid: run.tid, text: '다시 해줘', submit: true });
  const after = (await getTask(t.id)).runs[0];
  assert.strictEqual(after.error, null);
  assert.strictEqual(after.promptDelivered, true);
  // 재부팅 복원·/exit — 과거 SessionStart 가 기록돼 있어도 pane 이 셸이면 절대 붙여넣지 않는다.
  sessions.get(run.tsession).command = 'zsh';
  const r4 = await call('task.run.prompt', { taskId: t.id, runId: run.id, text: 'rm -rf $(pwd)' });
  assert.deepStrictEqual(r4, { ok: false, delivered: false });
  assert.strictEqual(calls.input.length, 1, '셸에는 타이핑하지 않는다');
  // session_end 는 SessionStart 기록을 지운다 — 다시 에이전트 명령이 보여도 (b) 로 즉시 준비 판정하지 않는다.
  sessions.get(run.tsession).command = '2.1.220';
  await agentState.applyHook(run.tsession, { event: 'session_end', sessionId: 'sess-paste', tid: run.tid, cwdRel: run.cwd });
  assert.strictEqual(I.load().items.find((y) => y.id === t.id).runs[0].sessionStartedAt, null);
  closeAll();
});

test('paste 준비 판정 (c) — 에이전트 신호 on + 셸 아님 + 선택 화면 없음 이 2s(테스트 60ms) 유지', async () => {
  const run = { tsession: 'cpt-x--t-1000999', tid: 1000999, cwd: 'x' };
  sessions.set(run.tsession, { command: 'gemini', title: '' });
  try {
    signalFor = () => ({ on: true });
    screenFor = () => TRUST_SCREEN;           // 다이얼로그가 떠 있으면 준비 아님
    assert.strictEqual(await I.waitAgentReady(run, { timeoutMs: 200, since: 0 }), false);
    screenFor = () => '> ';
    assert.strictEqual(await I.waitAgentReady(run, { timeoutMs: 1000, since: 0 }), true);
    sessions.get(run.tsession).command = 'zsh';  // 셸이면 신호가 on 이어도 준비 아님
    assert.strictEqual(await I.waitAgentReady(run, { timeoutMs: 200, since: 0 }), false);
  } finally { signalFor = () => ({ on: false }); screenFor = () => ''; sessions.delete(run.tsession); }
});

test('재기동 뒤 RPC 없이 stop 훅만 와도 review_ready 승격 + task_ready 1회 + done 억제, 변경 0 이면 done 통과, prompt 훅 → running', async () => {
  const { rel } = makeRepo();
  const t0 = await createTask(rel, [{ id: 'claude', count: 2 }]);
  const [run1, run2] = t0.runs;
  // 데몬 재시작 흉내 — 메모리 초기화 후 configure+start 만(아무 RPC 도 부르지 않는다).
  await I._reset();
  wire();
  await tasks.start();
  fs.writeFileSync(path.join(ROOT, run1.dir, 'a.txt'), 'one\ntwo\nthree\n');
  const notifs = () => calls.back.filter((c) => c.p === '/api/notifications').map((c) => c.b);
  const n0 = notifs().length;
  asNotified.length = 0;
  const hook = (run, ev, extra = {}) => agentState.applyHook(run.tsession, { event: ev, sessionId: `s-${run.id}`, tid: run.tid, cwdRel: run.cwd, ...extra });
  await hook(run1, 'session_start');
  await hook(run1, 'prompt');
  const st = await hook(run1, 'stop');
  assert.strictEqual(st.notified, false, 'done 은 억제된다(task_ready 로 대체)');
  const t1 = await waitFor(async () => { const x = I.load().items.find((y) => y.id === t0.id); return x.runs[0].state === 'review_ready' ? x : null; });
  assert.strictEqual(t1.runs[0].diff.files, 1);
  await sleep(120); // 디바운스 평가가 한 번 더 돌아도 알림은 1건
  await I._drain();
  const ready = notifs().slice(n0).filter((b) => b.kind === 'task_ready');
  assert.strictEqual(ready.length, 1);
  assert.strictEqual(ready[0].title, '리뷰 준비 · Claude');
  assert.match(ready[0].subtitle, /^proj\d+ · 파일 1개$/);
  assert.strictEqual(ready[0].cwd, run1.cwd);
  assert.strictEqual(ready[0].win, run1.tid);
  assert.strictEqual(ready[0].deeplink, `codingpt://task/${t0.id}?host=42&run=${run1.id}`);
  assert.ok(!JSON.stringify(ready[0]).includes('로그인'), '알림에 작업 제목을 싣지 않는다');
  assert.strictEqual(asNotified.filter((p) => p.kind === 'done' && p.win === run1.tid).length, 0);
  // shouldNotify 판정 자체
  assert.strictEqual(await I.shouldNotify({ key: run1.tsession }, 'done'), false);
  assert.strictEqual(await I.shouldNotify({ key: run1.tsession }, 'permission_request'), true);
  assert.strictEqual(await I.shouldNotify({ key: 'cpt-other--t-1' }, 'done'), true);
  // run2: 변경 0 → done 이 그대로 나간다, task_ready 없음
  await hook(run2, 'session_start');
  await hook(run2, 'prompt');
  const st2 = await hook(run2, 'stop');
  assert.strictEqual(st2.notified, true);
  assert.ok(asNotified.some((p) => p.kind === 'done' && p.win === run2.tid));
  await sleep(80); await I._drain();
  assert.strictEqual(I.load().items.find((y) => y.id === t0.id).runs[1].state, 'running');
  assert.strictEqual(notifs().slice(n0).filter((b) => b.kind === 'task_ready').length, 1);
  // 사용자가 다시 지시(prompt 훅) → running
  await hook(run1, 'prompt');
  assert.strictEqual(I.load().items.find((y) => y.id === t0.id).runs[0].state, 'running');
  await hook(run1, 'stop');
  await sleep(80); await I._drain();
  assert.strictEqual(notifs().slice(n0).filter((b) => b.kind === 'task_ready').length, 2, '다음 턴은 다시 1회');
  closeAll();
});

test('op — RUN_BUSY · opId 재생(실행 1회) · commit 결과 · 복사한 .env 는 커밋되지 않음', async () => {
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'codex', count: 1 }]);
  const run = t.runs[0];
  const wt = path.join(ROOT, run.dir);
  fs.writeFileSync(path.join(wt, '.gitignore'), ''); // .env 를 ignore 에서 빼도 exclude pathspec 이 막는다
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  const opId = uuid();
  const acc = await call('git.commit', { opId, taskId: t.id, runId: run.id, message: 'feat: b' });
  assert.strictEqual(acc.accepted, true);
  assert.strictEqual(acc.opId, opId);
  assert.ok(acc.run.op && acc.run.op.kind === 'commit');
  await assert.rejects(() => call('git.push', { opId: uuid(), taskId: t.id, runId: run.id }), (e) => e.code === 'RUN_BUSY');
  const again = await call('git.commit', { opId, taskId: t.id, runId: run.id, message: 'feat: b' });
  assert.strictEqual(again.replay, true);
  const { r } = await opDone(t.id, run.id, opId);
  assert.strictEqual(r.lastOp.ok, true);
  assert.match(r.lastOp.result.sha, /^[0-9a-f]{40}$/);
  const done = await call('git.commit', { opId, taskId: t.id, runId: run.id, message: 'feat: b' });
  assert.strictEqual(done.replay, true);
  assert.strictEqual(done.lastOp.ok, true);
  assert.strictEqual(G(wt, 'rev-list', '--count', `${run.baseSha}..HEAD`), '1', '같은 opId 재전송은 한 번만 실행');
  assert.ok(!G(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes('.env'));
  assert.strictEqual(r.commits.ahead, 1);
  // NOTHING_TO_COMMIT 은 lastOp 코드로
  const op2 = uuid();
  await call('git.commit', { opId: op2, taskId: t.id, runId: run.id, message: 'x' });
  const d2 = await opDone(t.id, run.id, op2);
  assert.strictEqual(d2.r.lastOp.ok, false);
  assert.strictEqual(d2.r.lastOp.code, 'NOTHING_TO_COMMIT');
  // 에이전트 작업 중이면 AGENT_BUSY
  await agentState.applyHook(run.tsession, { event: 'prompt', sessionId: 'busy', tid: run.tid, cwdRel: run.cwd });
  await assert.rejects(() => call('git.commit', { opId: uuid(), taskId: t.id, runId: run.id, message: 'x' }), (e) => e.code === 'AGENT_BUSY');
  await agentState.applyHook(run.tsession, { event: 'stop', sessionId: 'busy', tid: run.tid, cwdRel: run.cwd });
  await sleep(60); await I._drain();
  closeAll();
});

test('discard — 미커밋 거부 → 미머지 커밋 거부 → force 폐기(terminal.close 경유·복구 ref·브랜치·워크스페이스 DELETE) → task closed', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const run = t.runs[0];
  const wt = path.join(ROOT, run.dir);
  fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
  const op1 = uuid();
  await call('task.discard', { opId: op1, taskId: t.id, runId: run.id });
  let d = await opDone(t.id, run.id, op1);
  assert.strictEqual(d.r.lastOp.ok, false);
  assert.strictEqual(d.r.lastOp.code, 'UNCOMMITTED_CHANGES');
  assert.ok(fs.existsSync(wt));
  G(wt, 'add', '-A'); G(wt, 'commit', '-qm', 'c');
  const op2 = uuid();
  await call('task.discard', { opId: op2, taskId: t.id, runId: run.id });
  d = await opDone(t.id, run.id, op2);
  assert.strictEqual(d.r.lastOp.code, 'UNMERGED_COMMITS');
  const head = G(wt, 'rev-parse', 'HEAD');
  calls.close.length = 0; calls.back.length = 0;
  const op3 = uuid();
  await call('task.discard', { opId: op3, taskId: t.id, runId: run.id, force: true });
  d = await opDone(t.id, run.id, op3);
  assert.strictEqual(d.r.lastOp.ok, true, JSON.stringify(d.r.lastOp));
  assert.deepStrictEqual(d.r.lastOp.result, { discarded: [run.id], skipped: [] });
  assert.strictEqual(d.r.state, 'discarded');
  assert.strictEqual(d.t.state, 'closed');
  assert.ok(d.t.closedAt);
  assert.deepStrictEqual(calls.close.map((c) => [c.m, c.cwd, c.index]), [['terminal.close', run.cwd, run.tid]]);
  assert.ok(!fs.existsSync(wt));
  assert.strictEqual(G(dir, 'rev-parse', `refs/codingpt/discarded/${run.id}`), head, '폐기 전 복구 ref');
  assert.throws(() => G(dir, 'rev-parse', '--verify', '-q', `refs/heads/${run.branch}`));
  assert.ok(calls.back.some((c) => c.m === 'DELETE' && c.p === `/api/daemon/workspaces/${run.workspaceId}`));
  assert.ok(!fs.existsSync(path.join(STATE, 'tasks', t.id, `${run.id}.prompt`)));
  assert.strictEqual(d.r.cleanup.recoveryRef, `refs/codingpt/discarded/${run.id}`);
  assert.strictEqual(d.r.cleanup.worktreeRemoved, true);
  // 종결 뒤에는 기록 삭제 가능
  assert.deepStrictEqual(await call('task.delete', { taskId: t.id }), { ok: true });
  await assert.rejects(() => getTask(t.id), (e) => e.code === 'TASK_NOT_FOUND');
});

test('merge.local — 미커밋 변경: commitMessage 없으면 UNCOMMITTED_CHANGES, 있으면 커밋 후 머지(폰 한 시트)', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const [w] = t.runs;
  const wt = path.join(ROOT, w.dir);
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd\n');   // 에이전트가 커밋하지 않고 멈춘 상태
  const o1 = uuid();
  await call('git.merge.local', { opId: o1, taskId: t.id, runId: w.id, method: 'merge' });
  const failed = await waitFor(async () => { await I._drain(); const x = await getTask(t.id); return x.runs[0].lastOp && x.runs[0].lastOp.opId === o1 ? x : null; });
  assert.strictEqual(failed.runs[0].lastOp.code, 'UNCOMMITTED_CHANGES');
  await assert.rejects(() => call('git.merge.local', { opId: uuid(), taskId: t.id, runId: w.id, method: 'merge', commitMessage: '   ' }), (e) => e.code === 'BAD_PARAMS');
  const o2 = uuid();
  await call('git.merge.local', { opId: o2, taskId: t.id, runId: w.id, method: 'merge', commitMessage: 'dirty 반영' });
  const x = await waitFor(async () => { await I._drain(); const y = await getTask(t.id); return y.state === 'merged' ? y : null; });
  assert.strictEqual(x.runs[0].lastOp.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'dirty.txt')), '커밋된 변경이 base 로 머지됐다');
  assert.ok(G(dir, 'log', '--format=%s', '-3').includes('dirty 반영'));
  closeAll();
});

test('merge.local (b: base 체크아웃+clean) — cleanup pending 즉시 → 비동기 정리 → 나머지 폐기(merged/discarded 이벤트)', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }, { id: 'codex', count: 1 }]);
  const [w, o] = t.runs;
  const wt = path.join(ROOT, w.dir);
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'f\n');
  G(wt, 'add', '-A'); G(wt, 'commit', '-qm', 'feature');
  let snap = null;
  const reasons = [];
  const origNotify = calls.notify;
  tasks.configure({
    notify: (x) => {
      origNotify.push(x); reasons.push(x.reason);
      if (x.reason === 'merged' && !snap) {
        const r = I.load().items.find((y) => y.id === t.id).runs[0];
        snap = JSON.parse(JSON.stringify(r.lastOp));
      }
    },
  });
  const opId = uuid();
  await call('git.merge.local', { opId, taskId: t.id, runId: w.id, method: 'merge' });
  await waitFor(async () => { await I._drain(); const x = await getTask(t.id); return x.runs[0].lastOp && x.runs[0].lastOp.result && x.runs[0].lastOp.result.cleanup === 'done' ? x : null; });
  tasks.configure({ notify: (x) => { calls.notify.push(x); } });
  assert.deepStrictEqual({ ok: snap.ok, cleanup: snap.result.cleanup, ok2: snap.result.ok }, { ok: true, cleanup: 'pending', ok2: true });
  const x = await getTask(t.id);
  assert.strictEqual(x.state, 'merged');
  assert.strictEqual(x.winnerRunId, w.id);
  assert.strictEqual(x.runs[0].state, 'merged');
  assert.strictEqual(x.runs[0].op, null);
  assert.deepStrictEqual(x.runs[0].lastOp.result.discarded, [o.id]);
  assert.deepStrictEqual(x.runs[0].lastOp.result.discardSkipped, []);
  assert.strictEqual(x.runs[1].state, 'discarded');
  assert.ok(reasons.includes('merged') && reasons.includes('discarded'));
  assert.ok(fs.existsSync(path.join(dir, 'feature.txt')), 'base 체크아웃에서 머지 — 작업 트리가 곧 갱신된다');
  assert.strictEqual(G(dir, 'log', '-1', '--format=%s'), `Merge ${w.branch}`);
  assert.ok(!fs.existsSync(wt), '승자 worktree 정리');
  assert.ok(calls.back.some((c) => c.p === '/api/notifications' && c.b.kind === 'task_merged' && c.b.title === '머지 완료 · Claude'));
});

test('merge.local (a: base 미체크아웃) — 임시 detached worktree + CAS update-ref, (c) MAIN_DIRTY, 충돌 → MERGE_CONFLICT 결과', async () => {
  const { rel, dir } = makeRepo();
  G(dir, 'checkout', '-q', '-b', 'other');
  const t = await createTask(rel, [{ id: 'claude', count: 1 }, { id: 'codex', count: 1 }]);
  const [w, c] = t.runs;
  const wt = path.join(ROOT, w.dir);
  fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
  G(wt, 'add', '-A'); G(wt, 'commit', '-qm', 'x');
  // 충돌 run: a.txt 를 다르게
  const ct = path.join(ROOT, c.dir);
  fs.writeFileSync(path.join(ct, 'a.txt'), 'CONFLICT\n');
  G(ct, 'commit', '-qam', 'c');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'winner\n');
  G(wt, 'commit', '-qam', 'w2');
  const before = G(dir, 'rev-parse', 'main');
  const opId = uuid();
  await call('git.merge.local', { opId, taskId: t.id, runId: w.id, method: 'squash', discardOthers: false });
  await waitFor(async () => { await I._drain(); const x = await getTask(t.id); return x.runs[0].state === 'merged' && !x.runs[0].op ? x : null; });
  assert.notStrictEqual(G(dir, 'rev-parse', 'main'), before, 'refs/heads/main 이 CAS 로 전진');
  assert.strictEqual(G(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other', '사용자 체크아웃은 불변');
  assert.strictEqual(G(dir, 'log', '-1', '--format=%s', 'main'), '로그인 폼 검증 추가', 'squash 커밋 메시지 = 작업 제목');
  assert.ok(!fs.existsSync(path.join(STATE, 'worktrees', `.merge-${t.id.slice(-6)}`)), '임시 worktree 정리');
  const x = await getTask(t.id);
  assert.strictEqual(x.runs[1].state, 'running', 'discardOthers:false 면 남긴다');
  // 머지된 작업의 다른 run 은 더 이상 머지할 수 없다(작업 종결)
  await assert.rejects(() => call('git.merge.local', { opId: uuid(), taskId: t.id, runId: c.id, method: 'merge' }), (e) => e.code === 'TASK_CLOSED');
  closeAll();

  // 충돌 + MAIN_DIRTY — 새 작업
  const r2 = makeRepo();
  const t2 = await createTask(r2.rel, [{ id: 'claude', count: 1 }]);
  const run = t2.runs[0];
  const w2 = path.join(ROOT, run.dir);
  fs.writeFileSync(path.join(w2, 'a.txt'), 'branch side\n');
  G(w2, 'commit', '-qam', 'b');
  fs.writeFileSync(path.join(r2.dir, 'dirty.txt'), 'd\n');
  const o1 = uuid();
  await call('git.merge.local', { opId: o1, taskId: t2.id, runId: run.id, method: 'merge' });
  let d = await opDone(t2.id, run.id, o1);
  assert.strictEqual(d.r.lastOp.code, 'MAIN_DIRTY');
  assert.strictEqual(d.r.state, 'review_ready');
  fs.rmSync(path.join(r2.dir, 'dirty.txt'));
  fs.writeFileSync(path.join(r2.dir, 'a.txt'), 'main side\n');
  G(r2.dir, 'commit', '-qam', 'm');
  const o2 = uuid();
  await call('git.merge.local', { opId: o2, taskId: t2.id, runId: run.id, method: 'merge' });
  d = await opDone(t2.id, run.id, o2);
  assert.strictEqual(d.r.lastOp.ok, false);
  assert.strictEqual(d.r.lastOp.code, 'MERGE_CONFLICT');
  assert.deepStrictEqual(d.r.lastOp.result, { ok: false, code: 'MERGE_CONFLICT', files: ['a.txt'] });
  assert.strictEqual(d.r.state, 'review_ready');
  assert.strictEqual(G(r2.dir, 'status', '--porcelain'), '', 'abort 로 원상복구');
  closeAll();
});

test('PR — dirty+commitMessage 한 번에 커밋·푸시·PR, pr.status checks, CHECKS_FAILING, squash 머지 → 원격 브랜치 삭제·완료', async () => {
  const { rel, dir } = makeRepo({ origin: true });
  const t = await createTask(rel, [{ id: 'codex', count: 1 }, { id: 'claude', count: 1 }]);
  const run = t.runs[0];
  const wt = path.join(ROOT, run.dir);
  fs.writeFileSync(GH_LOG, '');
  const prJson = (checks, state = 'OPEN') => JSON.stringify({
    number: 7, url: 'https://github.com/acme/demo/pull/7', state, isDraft: false, title: 'PR',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, headRefName: run.branch, baseRefName: 'main',
    statusCheckRollup: checks, mergedAt: null, mergeCommit: state === 'MERGED' ? { oid: 'f'.repeat(40) } : null,
  });
  fs.writeFileSync(PR_JSON, prJson([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]));
  // PR 없이 dirty 면 UNCOMMITTED_CHANGES
  fs.writeFileSync(path.join(wt, 'pr.txt'), 'pr\n');
  const o0 = uuid();
  await call('git.pr.create', { opId: o0, taskId: t.id, runId: run.id, title: 'PR' });
  let d = await opDone(t.id, run.id, o0);
  assert.strictEqual(d.r.lastOp.code, 'UNCOMMITTED_CHANGES');
  const o1 = uuid();
  await call('git.pr.create', { opId: o1, taskId: t.id, runId: run.id, title: 'PR', body: '본문', commitMessage: 'feat: pr' });
  d = await opDone(t.id, run.id, o1);
  assert.strictEqual(d.r.lastOp.ok, true, JSON.stringify(d.r.lastOp));
  assert.strictEqual(d.r.lastOp.result.existed, false);
  assert.strictEqual(d.r.lastOp.result.pr.number, 7);
  assert.strictEqual(d.r.pr.checks.status, 'passing');
  assert.strictEqual(d.r.pushed, true);
  assert.deepStrictEqual(d.t.repo.github, { owner: 'acme', repo: 'demo' });
  assert.ok(G(dir, 'ls-remote', 'origin', run.branch).includes(run.branch), '브랜치가 원격에 푸시됨');
  assert.match(fs.readFileSync(GH_LOG, 'utf8'), new RegExp(`pr create --repo acme/demo --head ${run.branch.replace('/', '\\/')} --base main --title=PR --body-file=-`));
  // pr.status
  const ps = await call('git.pr.status', { taskId: t.id, runId: run.id });
  assert.strictEqual(ps.pr.state, 'open');
  assert.strictEqual(ps.run.id, run.id);
  // 검사 실패 → CHECKS_FAILING, run review_ready 복귀
  fs.writeFileSync(PR_JSON, prJson([{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }]));
  const o2 = uuid();
  await call('git.pr.merge', { opId: o2, taskId: t.id, runId: run.id, method: 'squash' });
  d = await opDone(t.id, run.id, o2);
  assert.strictEqual(d.r.lastOp.code, 'CHECKS_FAILING');
  assert.strictEqual(d.r.state, 'review_ready');
  // 통과 → 머지
  fs.writeFileSync(PR_JSON, prJson([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]));
  const o3 = uuid();
  await call('git.pr.merge', { opId: o3, taskId: t.id, runId: run.id, method: 'squash' });
  await waitFor(async () => { await I._drain(); const x = await getTask(t.id); return x.runs[0].lastOp && x.runs[0].lastOp.opId === o3 && x.runs[0].lastOp.result && x.runs[0].lastOp.result.cleanup === 'done' ? x : null; });
  const x = await getTask(t.id);
  assert.strictEqual(x.state, 'merged');
  assert.strictEqual(x.runs[1].state, 'discarded', '나머지 run 폐기(기본 on)');
  const log = fs.readFileSync(GH_LOG, 'utf8');
  assert.match(log, /pr merge --repo acme\/demo 7 --squash/);
  assert.doesNotMatch(log, /--delete-branch/);
  assert.strictEqual(G(dir, 'ls-remote', 'origin', run.branch), '', '원격 브랜치 삭제');
  assert.ok(!fs.existsSync(wt));
  closeAll();
});

test('task.diff — 파일 목록·본문, file 파라미터는 허용 집합 정확 일치 + realpath(../ 거부)', async () => {
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const run = t.runs[0];
  const wt = path.join(ROOT, run.dir);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(wt, '새.md'), 'n\n');
  const d = await call('task.diff', { taskId: t.id, runId: run.id });
  assert.strictEqual(d.baseSha, run.baseSha);
  assert.strictEqual(d.uncommitted, true);
  assert.deepStrictEqual(d.files.map((f) => [f.path, f.status]), [['a.txt', 'M'], ['새.md', '?']]);
  assert.match(d.files[0].diffText, /\+three/);
  assert.deepStrictEqual(d.totals, { files: 2, additions: 2, deletions: 0 });
  const one = await call('task.diff', { taskId: t.id, runId: run.id, file: '새.md' });
  assert.strictEqual(one.files.length, 1);
  assert.match(one.files[0].diffText, /\+n/);
  await assert.rejects(() => call('task.diff', { taskId: t.id, runId: run.id, file: '../../daemon.json' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('task.diff', { taskId: t.id, runId: run.id, file: '.env' }), (e) => e.code === 'BAD_PARAMS');
  const st = await call('git.status', { taskId: t.id, runId: run.id });
  assert.strictEqual(st.branch, run.branch);
  assert.strictEqual(st.base, 'main');
  assert.strictEqual(st.upstream, null);
  assert.strictEqual(st.lastCommit.subject, 'init');
  assert.strictEqual(st.run.dirty, true);
  closeAll();
});

test('git.branches — current·dirtyCount·목록', async () => {
  const { rel, dir } = makeRepo();
  G(dir, 'branch', 'dev');
  fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
  const b = await call('git.branches', { repo: rel });
  assert.strictEqual(b.current, 'main');
  assert.strictEqual(b.detached, false);
  assert.strictEqual(b.dirtyCount, 1);
  assert.deepStrictEqual(b.branches.map((x) => x.name).sort(), ['dev', 'main']);
  assert.strictEqual(b.remoteUrl, null);
  assert.strictEqual(b.github, null);
});

test('reconcile — creating(폴더 없음)·launching → OP_INTERRUPTED, op 잔존 해제, creating(폴더 있음) 재개, 폴더 소실, agentGone', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 2 }, { id: 'codex', count: 2 }]);
  const t2 = await createTask(makeRepo().rel, [{ id: 'claude', count: 1 }]);
  const [c1, l2, o3, c4] = t.runs;
  await I._reset();
  // 디스크 상태를 "데몬이 도중에 죽은" 모양으로
  G(dir, 'worktree', 'remove', '--force', path.join(ROOT, c1.dir));
  I.mutate((s) => {
    const x = s.items.find((y) => y.id === t.id);
    x.runs[0].state = 'creating';
    x.runs[1].state = 'launching';
    x.runs[2].op = { opId: 'op-dead-1', kind: 'commit', startedAt: 1 };
    x.runs[3].state = 'creating';
  });
  sessions.delete(c4.tsession); // 재개 run 은 터미널부터 다시
  sessions.get(o3.tsession).command = 'zsh'; // 재부팅 복원 = 빈 셸
  fs.rmSync(path.join(ROOT, t2.runs[0].dir), { recursive: true, force: true });
  await I._reset({ drain: false });
  calls.launch.length = 0;
  wire();
  await tasks.start();
  await I._drain();
  const x = await getTask(t.id);
  assert.strictEqual(x.runs[0].state, 'failed');
  assert.strictEqual(x.runs[0].error.code, 'OP_INTERRUPTED');
  assert.strictEqual(x.runs[1].state, 'failed');
  assert.strictEqual(x.runs[1].error.code, 'OP_INTERRUPTED');
  assert.strictEqual(x.runs[2].op, null);
  assert.strictEqual(x.runs[2].lastOp.code, 'OP_INTERRUPTED');
  assert.strictEqual(x.runs[2].lastOp.opId, 'op-dead-1');
  assert.strictEqual(x.runs[2].terminalAlive, true);
  assert.strictEqual(x.runs[2].agentGone, true, '셸만 남은 터미널 = 에이전트 다시 실행');
  assert.strictEqual(x.runs[3].state, 'running', 'creating + worktree 있음 = 7 단계부터 재개');
  assert.ok(calls.launch.some((a) => a.index === x.runs[3].tid));
  const y = await getTask(t2.id);
  assert.strictEqual(y.runs[0].state, 'failed');
  assert.strictEqual(y.runs[0].error.code, 'WORKTREE_MISSING');
  // 에이전트 다시 실행 — 터미널이 살아 있으면 재생성 없이 resumeArgs(codex: resume --last) 로
  calls.launch.length = 0;
  const op = uuid();
  const acc = await call('task.run.reopen', { opId: op, taskId: t.id, runId: o3.id });
  assert.strictEqual(acc.accepted, true);
  const d = await opDone(t.id, o3.id, op);
  assert.strictEqual(d.r.lastOp.ok, true, JSON.stringify(d.r.lastOp));
  assert.deepStrictEqual(d.r.lastOp.result, { tid: o3.tid });
  const la = calls.launch.find((a) => a.index === o3.tid);
  assert.deepStrictEqual(la.args, o3.agent === 'codex' ? ['resume', '--last'] : ['--continue']);
  // 에이전트가 이미 돌고 있으면 LAUNCH_BUSY 로 거절하고 run 은 그대로(failed 로 떨어뜨리지 않는다)
  const op2 = uuid();
  await call('task.run.reopen', { opId: op2, taskId: t.id, runId: o3.id });
  const d2 = await opDone(t.id, o3.id, op2);
  assert.strictEqual(d2.r.lastOp.code, 'LAUNCH_BUSY');
  assert.strictEqual(d2.r.state, 'running');
  closeAll();
});

test('TASKS_DISABLED — worktree 루트가 홈 jail 밖이면 handle 을 숨기고(caps 미광고) 모든 RPC 거부', async () => {
  const control = require('../control');
  assert.ok(control.daemonCaps().includes('task.v1'));
  assert.strictEqual(typeof tasks.handle, 'function');
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tasks-out-')));
  runtime.init({ root: ROOT, stateDir: outside, claudeHome: path.join(ROOT, '.claude') });
  try {
    assert.strictEqual(tasks.handle, undefined);
    assert.ok(!control.daemonCaps().includes('task.v1'));
    await assert.rejects(() => call('task.list', {}), (e) => e.code === 'TASKS_DISABLED');
  } finally {
    runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  assert.strictEqual(typeof tasks.handle, 'function');
});

test('control.dispatchRpc — git.gh.status / task.* 위임(cpt-server.handleTaskRpc), 모르는 메서드는 BAD_PARAMS', async () => {
  const control = require('../control');
  const viaDispatch = (m, p) => new Promise((res, rej) => control.dispatchRpc({ readyState: 1, send() {} }, m, p, res, rej));
  const gh = await viaDispatch('git.gh.status', {});
  assert.strictEqual(gh.git.ok, true);
  assert.deepStrictEqual({ installed: gh.gh.installed, authenticated: gh.gh.authenticated, user: gh.gh.user, host: gh.gh.host },
    { installed: true, authenticated: true, user: 'tester', host: 'github.com' });
  const list = await viaDispatch('task.list', { includeClosed: true });
  assert.ok(Array.isArray(list.items));
  await assert.rejects(() => viaDispatch('task.bogus', {}), (e) => e.code === 'BAD_PARAMS');
  // 서버 킬스위치 — hello_ack serverCaps 에 task.v1 이 없으면 원격(평문·봉인 공용 디스패처) 작업 RPC 거부
  control._setServerCaps(['agentstate.v1', 'e2ee.rpc.v1']);
  try {
    await assert.rejects(() => viaDispatch('task.list', {}), (e) => e.code === 'TASKS_DISABLED');
    await assert.rejects(() => viaDispatch('git.pr.merge', { opId: 'x' }), (e) => e.code === 'TASKS_DISABLED');
    control._setServerCaps(['task.v1']);
    assert.ok(Array.isArray((await viaDispatch('task.list', {})).items));
  } finally { control._setServerCaps([]); }
});

test('cpt-server 로컬 소켓 디스패치 — task.* 는 컨텍스트 게이트 밖, CAPABILITIES 는 task.list/get 만', async () => {
  const cptServer = require('../cpt-server');
  const r = await cptServer._dispatch({ cmd: 'task.list', args: {}, ctx: {} });
  assert.ok(Array.isArray(r.items));
  const caps = await cptServer._dispatch({ cmd: 'capabilities', args: {}, ctx: { ws: '' } });
  const tc = caps.commands.filter((c) => c.startsWith('task.') || c.startsWith('git.'));
  assert.deepStrictEqual(tc, ['task.list', 'task.get']);
});

test('봉인 경로 — control.handleSealedRpc 로 task.list 왕복(서버는 메서드명도 못 본다)', async () => {
  const e2ee = require('../e2ee');
  const gate = require('../e2ee-gate');
  const control = require('../control');
  e2ee.removeState();
  e2ee.ensureIdentity({ deviceId: 42 });
  e2ee.setMasterKey(1, e2ee.randomBytes(32));
  gate.resetCache();
  const encOpts = { epoch: 1, hostDeviceId: 42 };
  const env = e2ee.sealRpc('task.list', { includeClosed: true }, encOpts);
  const res = await new Promise((ok, fail) => control.handleSealedRpc({ readyState: 1, send() {} }, { env, hostDeviceId: 42 }, ok, fail));
  const opened = e2ee.openRpcResult(res.env, encOpts);
  assert.strictEqual(opened.ok, true);
  assert.ok(Array.isArray(opened.r.items) && opened.r.items.length > 0);
  assert.ok(opened.r.caps && opened.r.caps.gh);
  // 실패도 봉인되어 code 만 남는다
  const env2 = e2ee.sealRpc('task.get', { taskId: 't_zzzzzzzzzz' }, encOpts);
  const res2 = await new Promise((ok, fail) => control.handleSealedRpc({ readyState: 1, send() {} }, { env: env2, hostDeviceId: 42 }, ok, fail));
  const o2 = e2ee.openRpcResult(res2.env, encOpts);
  assert.strictEqual(o2.ok, false);
  assert.strictEqual(o2.code, 'TASK_NOT_FOUND');
});

test('tasks.json — 0600, 와이어에 없는 내부 필드(opIds·opts)는 디스크에만, 깨진 항목은 버린다', async () => {
  const f = I.storeFile();
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(disk.v, 1);
  assert.ok(disk.items.length > 0);
  disk.items.push({ id: 'broken' }, { id: 't_aaaaaaaaaa', repo: null, runs: [] });
  fs.writeFileSync(f, JSON.stringify(disk), { mode: 0o600 });
  await I._reset();
  wire();
  const loaded = I.load();
  assert.strictEqual(loaded.items.length, disk.items.length - 2);
  const t = loaded.items[0];
  const wireT = tasks.pickTask(t);
  assert.ok(!('opts' in wireT) && !('prompt' in wireT));
  assert.ok(wireT.runs.every((r) => !('opIds' in r) && !('trustTitle' in r) && !('sessionStartedAt' in r)));
});

test('cpt task list|get — 읽기 2개, 자기 run 은 CPT_TSESSION 으로 찾는다(가짜 소켓)', async () => {
  const net = require('net');
  const { execFile } = require('child_process');
  const fix = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'fixtures', 'agent-tasks', f), 'utf8'));
  const list = fix('rpc-task.list.json').result;
  const get = fix('rpc-task.get.json').result;
  const seen = [];
  const sock = path.join(ROOT, 'fake-cpt.sock');
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      seen.push(req.cmd);
      const result = req.cmd === 'task.list' ? list : req.cmd === 'task.get' ? get : null;
      c.end(JSON.stringify({ id: req.id, ok: !!result, result, error: result ? undefined : 'nope' }) + '\n');
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const cli = path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js');
  const self = list.items[0].runs[1].tsession;
  const run = (args) => new Promise((res) => execFile(process.execPath, [cli, ...args], {
    // CPT_WS 를 비워 두면 CLI 가 tmux show-environment 로 되묻지 않는다(실 tmux 무접촉).
    env: { ...process.env, CPT_SOCK: sock, CPT_WS: '', CPT_TSESSION: self, CPT_TID: String(list.items[0].runs[1].tid), TMUX_PANE: '' },
  }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
  try {
    const l = await run(['task', 'list']);
    assert.strictEqual(l.code, 0, l.stderr);
    assert.match(l.stdout, /t_k3j9x2m1qa \[open\] 로그인 폼 유효성 검사 추가/);
    assert.match(l.stdout, /\* \[2\] codex running \(폴더 신뢰 확인 필요\)/, '자기 run 표시');
    const g = await run(['task', 'get']);
    assert.strictEqual(g.code, 0, g.stderr);
    assert.match(g.stdout, /프롬프트:\n로그인 폼에 이메일/);
    assert.deepStrictEqual(seen.slice(-2), ['task.list', 'task.get']);
    const bad = await run(['task', 'create']);
    assert.strictEqual(bad.code, 2, '쓰기 명령은 CLI 에 없다');
  } finally { srv.close(); }
});

test('cpt-server launchAgentInTerminal — args 는 명령 뒤에 literal 로 붙는다(없으면 기존과 동일)', async () => {
  const tb = require('../term-backend');
  const cptServer = require('../cpt-server');
  const saved = { info: tb.info, capture: tb.capture, sendKeys: tb.sendKeys, mig: realPty.migrateLegacyPool };
  const sent = [];
  tb.info = async () => ({ command: 'zsh', cols: 80, rows: 24 });
  tb.capture = async () => '$ ';
  tb.sendKeys = async (name, spec) => { sent.push({ name, spec }); };
  realPty.migrateLegacyPool = async () => {};
  try {
    const a = await cptServer.handleAgentsRpc('agents.launch', { id: 'claude', index: 1000123, cwd: '', args: [`"$(cat '/tmp/p')"`] });
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(sent[0].spec, { keys: [`claude "$(cat '/tmp/p')"`], literal: true });
    assert.deepStrictEqual(sent[1].spec, { keys: ['Enter'] });
    sent.length = 0;
    await cptServer.handleAgentsRpc('agents.launch', { id: 'codex', index: 1000123, cwd: '' });
    assert.deepStrictEqual(sent[0].spec, { keys: ['codex'], literal: true }, '일반 런치는 인자 없음(기존 원칙)');
  } finally {
    tb.info = saved.info; tb.capture = saved.capture; tb.sendKeys = saved.sendKeys; realPty.migrateLegacyPool = saved.mig;
  }
});

test('onReconnect(hello_ack) — 등록 못 한 run 만 60s 스로틀을 무시하고 재등록', async () => {
  wire();
  await tasks.start(); // 앞선 테스트가 _reset 으로 내렸을 수 있다(기동 전이면 onReconnect 는 무동작 — 아래에서 따로 본다)
  closeAll();
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const runId = t.runs[0].id;
  // back 에 못 닿아 등록이 실패한 상태를 흉내: workspaceId 없음 + 방금 시도함(스로틀 창 안).
  I.mutate((s) => { const r = s.items.find((x) => x.id === t.id).runs[0]; r.workspaceId = null; r.wsTriedAt = Date.now(); });
  calls.back.length = 0;
  assert.strictEqual(tasks.onReconnect(), 1);
  await waitFor(async () => (await getTask(t.id)).runs[0].workspaceId);
  const regs = calls.back.filter((c) => c.m === 'POST' && c.p === '/api/daemon/workspaces');
  assert.strictEqual(regs.length, 1);
  assert.strictEqual((await getTask(t.id)).runs.find((r) => r.id === runId).workspaceId.startsWith('ws_'), true);
  // 이미 등록된 run 은 건드리지 않는다.
  calls.back.length = 0;
  assert.strictEqual(tasks.onReconnect(), 0);
  await sleep(30);
  assert.strictEqual(calls.back.filter((c) => c.p === '/api/daemon/workspaces').length, 0);
  // 기동 전(또는 기능 꺼짐)이면 무동작.
  await I._drain();
  await I._reset();
  assert.strictEqual(tasks.onReconnect(), 0);
  wire();
  await tasks.start();
});

test('pr.merge — 머지 큐(gh 0 종료 + PR OPEN) 면 완료가 아니다: run 유지·원격 브랜치 유지 → 웹 MERGED 감지로 마무리, 로컬 후속 커밋이 있으면 승자 정리 보류', async () => {
  const { rel, dir } = makeRepo({ origin: true });
  const t = await createTask(rel, [{ id: 'codex', count: 1 }, { id: 'claude', count: 1 }]);
  const run = t.runs[0];
  const wt = path.join(ROOT, run.dir);
  const prJson = (state) => JSON.stringify({
    number: 7, url: 'https://github.com/acme/demo/pull/7', state, isDraft: false, title: 'PR',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, headRefName: run.branch, baseRefName: 'main',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], mergedAt: null, mergeCommit: null,
  });
  fs.writeFileSync(PR_JSON, prJson('OPEN'));
  fs.writeFileSync(path.join(wt, 'q.txt'), 'q\n');
  const o1 = uuid();
  await call('git.pr.create', { opId: o1, taskId: t.id, runId: run.id, title: 'PR', commitMessage: 'feat: q' });
  let d = await opDone(t.id, run.id, o1);
  assert.strictEqual(d.r.lastOp.ok, true, JSON.stringify(d.r.lastOp));
  fs.writeFileSync(`${PR_JSON}.queue`, '1');
  try {
    const o2 = uuid();
    await call('git.pr.merge', { opId: o2, taskId: t.id, runId: run.id, method: 'squash' });
    d = await opDone(t.id, run.id, o2);
  } finally { fs.rmSync(`${PR_JSON}.queue`, { force: true }); }
  assert.strictEqual(d.r.lastOp.ok, true);
  assert.strictEqual(d.r.lastOp.result.queued, true, JSON.stringify(d.r.lastOp));
  assert.strictEqual(d.r.lastOp.result.merged, false);
  assert.strictEqual(d.t.state, 'open', '큐에 들어간 것은 머지가 아니다');
  assert.strictEqual(d.r.state, 'review_ready');
  assert.strictEqual(d.t.runs[1].state, 'running', '나머지 run 을 폐기하지 않는다');
  assert.ok(G(dir, 'ls-remote', 'origin', run.branch).includes(run.branch), '원격 브랜치를 지우지 않는다(지우면 큐에서 빠져 PR 이 닫힌다)');
  assert.ok(fs.existsSync(wt));
  // 에이전트가 후속 커밋을 하나 더(푸시 안 함) — 그 사이 웹에서 머지됨
  fs.writeFileSync(path.join(wt, 'more.txt'), 'm\n');
  G(wt, 'add', '-A'); G(wt, 'commit', '-qm', 'follow-up');
  fs.writeFileSync(PR_JSON, prJson('MERGED'));
  await call('git.pr.status', { taskId: t.id, runId: run.id });
  const x = await waitFor(async () => { await I._drain(); const y = await getTask(t.id); return y.runs[0].lastOp && y.runs[0].lastOp.result && y.runs[0].lastOp.result.cleanup === 'done' ? y : null; });
  assert.strictEqual(x.state, 'merged');
  assert.strictEqual(x.runs[0].state, 'merged');
  assert.strictEqual(x.runs[0].lastOp.result.cleanupSkipped, 'UNMERGED_COMMITS');
  assert.ok(fs.existsSync(wt), '푸시 안 한 후속 커밋이 있는 worktree 는 지우지 않는다');
  assert.strictEqual(G(wt, 'log', '-1', '--format=%s'), 'follow-up');
  assert.ok(G(dir, 'branch', '--list', run.branch).includes(run.branch), '브랜치도 남긴다');
  // I-8 — 정리 안 된 worktree 가 남은 작업은 기록 삭제 거부
  await assert.rejects(() => call('task.delete', { taskId: t.id }), (e) => e.code === 'BAD_PARAMS');
  closeAll();
});

test('승자 1명 원자성 — 같은 작업 두 run 을 동시에 merge.local → 하나만 머지, 나머지는 TASK_CLOSED/RUN_BUSY', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }, { id: 'codex', count: 1 }]);
  const [a, b] = t.runs;
  for (const [r, f] of [[a, 'fa.txt'], [b, 'fb.txt']]) {
    const wt = path.join(ROOT, r.dir);
    fs.writeFileSync(path.join(wt, f), 'x\n');
    G(wt, 'add', '-A'); G(wt, 'commit', '-qm', f);
  }
  const oa = uuid(); const ob = uuid();
  await Promise.all([
    call('git.merge.local', { opId: oa, taskId: t.id, runId: a.id, method: 'merge', discardOthers: false }),
    call('git.merge.local', { opId: ob, taskId: t.id, runId: b.id, method: 'merge', discardOthers: false }),
  ]);
  await waitFor(async () => { await I._drain(); const x = await getTask(t.id); return x.runs.every((r) => !r.op) ? x : null; });
  const x = await getTask(t.id);
  assert.strictEqual(x.state, 'merged');
  assert.strictEqual(x.winnerRunId, a.id);
  assert.strictEqual(x.runs[0].state, 'merged');
  assert.notStrictEqual(x.runs[1].state, 'merged');
  assert.ok(['TASK_CLOSED', 'RUN_BUSY'].includes(x.runs[1].lastOp.code), JSON.stringify(x.runs[1].lastOp));
  assert.ok(fs.existsSync(path.join(dir, 'fa.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'fb.txt')), '두 번째 구현은 base 에 머지되지 않는다');
  closeAll();
});

test('task.delete — 실패 run 의 worktree 가 남아 있으면 거부(고아 방지), 정리 뒤엔 삭제 + 복구 ref 도 지운다', async () => {
  const { rel, dir } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }, { id: 'codex', count: 1 }]);
  const [w, f] = t.runs;
  const wt = path.join(ROOT, w.dir);
  fs.writeFileSync(path.join(wt, 'w.txt'), 'w\n');
  G(wt, 'add', '-A'); G(wt, 'commit', '-qm', 'w');
  fs.writeFileSync(path.join(ROOT, f.dir, 'dirty.txt'), 'd\n'); // 미커밋 → 머지 후 폐기 건너뜀
  I.mutate((s) => { const x = s.items.find((y) => y.id === t.id); x.runs[1].state = 'failed'; x.runs[1].error = { code: 'OP_INTERRUPTED', message: 'x' }; });
  const op = uuid();
  await call('git.merge.local', { opId: op, taskId: t.id, runId: w.id, method: 'merge' });
  const x = await waitFor(async () => { await I._drain(); const y = await getTask(t.id); return y.runs[0].lastOp && y.runs[0].lastOp.result && y.runs[0].lastOp.result.cleanup === 'done' ? y : null; });
  assert.deepStrictEqual(x.runs[0].lastOp.result.discardSkipped, [{ runId: f.id, code: 'UNCOMMITTED_CHANGES' }]);
  assert.strictEqual(x.runs[1].state, 'failed');
  await assert.rejects(() => call('task.delete', { taskId: t.id }), (e) => e.code === 'BAD_PARAMS');
  assert.ok(await getTask(t.id));
  // 사용자가 강제 폐기 → 이제 삭제 가능, 복구 ref 도 사라진다
  const od = uuid();
  await call('task.discard', { opId: od, taskId: t.id, runIds: [f.id], force: true });
  await opDone(t.id, f.id, od);
  assert.ok(G(dir, 'for-each-ref', 'refs/codingpt/discarded/').length > 0);
  assert.deepStrictEqual(await call('task.delete', { taskId: t.id }), { ok: true });
  assert.strictEqual(G(dir, 'for-each-ref', 'refs/codingpt/discarded/'), '', '복구 ref 정리');
});

test('알림 — run 이 failed 라 task_ready 가 안 나가면 done 을 억제하지 않는다 · 턴 도중 종료는 턴 끝으로 센다 · 일하는 failed run 은 running 으로', async () => {
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const run = t.runs[0];
  fs.writeFileSync(path.join(ROOT, run.dir, 'a.txt'), 'changed\n');
  I.mutate((s) => { const x = s.items.find((y) => y.id === t.id); x.runs[0].state = 'failed'; x.runs[0].error = { code: 'OP_INTERRUPTED', message: 'x' }; });
  assert.strictEqual(await I.shouldNotify({ key: run.tsession }, 'done'), true, 'failed run — task_ready 가 없으니 done 을 통과');
  // 실제로 에이전트가 일하고 있음이 보이면 running 으로 되살린다
  const hook = (ev) => agentState.applyHook(run.tsession, { event: ev, sessionId: `s-${run.id}`, tid: run.tid, cwdRel: run.cwd });
  await hook('session_start');
  await hook('prompt');
  const r1 = I.load().items.find((y) => y.id === t.id).runs[0];
  assert.strictEqual(r1.state, 'running');
  assert.strictEqual(r1.error, null);
  // 턴 도중 종료 → lastTurnEndedAt 갱신 → 변경 있음 → task_ready
  const before = r1.lastTurnEndedAt || 0;
  await sleep(5);
  await hook('session_end');
  const r2 = I.load().items.find((y) => y.id === t.id).runs[0];
  assert.ok(r2.lastTurnEndedAt > before);
  await sleep(80); await I._drain();
  assert.strictEqual(I.load().items.find((y) => y.id === t.id).runs[0].state, 'review_ready');
  assert.ok(calls.back.some((c) => c.p === '/api/notifications' && c.b.kind === 'task_ready' && c.b.win === run.tid));
  closeAll();
});

test('reconcile — creating 재개 시 tmux 에 살아 있는 run 터미널은 재사용(고아 터미널 금지)', async () => {
  const { rel } = makeRepo();
  const t = await createTask(rel, [{ id: 'claude', count: 1 }]);
  const run = t.runs[0];
  await I._reset();
  I.mutate((s) => { const x = s.items.find((y) => y.id === t.id); x.runs[0].state = 'creating'; });
  sessions.get(run.tsession).command = 'zsh';
  await I._reset({ drain: false });
  const before = sessions.size;
  calls.launch.length = 0;
  wire();
  await tasks.start();
  await I._drain();
  const x = (await getTask(t.id)).runs[0];
  assert.strictEqual(x.state, 'running');
  assert.strictEqual(x.tid, run.tid, '같은 터미널');
  assert.strictEqual(x.tsession, run.tsession);
  assert.strictEqual(sessions.size, before, '새 터미널을 만들지 않는다');
  assert.ok(calls.launch.some((a) => a.index === run.tid));
  closeAll();
});
