'use strict';
// ── win32 CI 스킵 가드 — POSIX 픽스처(셔뱅 가짜 gh/claude·유닉스 소켓). tasks.test.js 와 같은 사유.
if (process.platform === 'win32') {
  require('node:test')('automation-e2e.test.js: win32 스킵 — POSIX 픽스처', { skip: true }, () => {});
  return;
}

// 자동화 헤드리스 E2E(in-process) — docs/automation-design.md §9.1 마지막 항목.
//  cpt-server 를 **이 테스트 프로세스 안에서** 임시 stateDir 로 띄우고(이 Mac 의 라이브 데몬은 추가 기동 금지)
//  로컬 소켓 NDJSON 으로: auto.create(github.issues, 가짜 gh 이슈 2개) → 폴러 강제 틱 → task.list 에 origin 있는
//  작업 2개 → 그 run 터미널의 tsession 으로 `cpt auto create -` → AUTO_LOOP → auto.pauseAll → 틱 → 0건.
//  터미널(pty/tmux)·back 은 스텁 — 실제는 git worktree·tasks 상태기계·automations 엔진·cpt-server 소켓·cpt CLI.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

// ── 격리(require 전에!) ──────────────────────────────────────────────────────
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ae2e-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
const GH_ISSUES = path.join(ROOT, 'issues.json');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '[user]\n\temail = dev@example.com\n\tname = Dev\n');
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-ae2e-${process.pid}`;
process.env.CPT_E2EE_SCOPE = 'rpc';
process.env.CPT_LAN_SCOPE = 'off';
process.env.CPT_SKILL_INSTALL = '0';
process.env.CPT_DISPATCH = '0'; // 이 E2E 는 자동화만 — 플래너 CLI·pmset/caffeinate 경로는 절대 건드리지 않는다
process.env.CPT_POWER = '0';
process.env.GH_ISSUES = GH_ISSUES;
delete process.env.CPT_E2EE;
delete process.env.CPT_AUTOMATIONS;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });
fs.writeFileSync(path.join(STATE, 'daemon.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9', deviceToken: 'cptd_test', deviceId: 42 }), { mode: 0o600 });

for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(BIN, name), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/sh
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
const realPty = require('../pty');
const tasks = require('../tasks');
const auto = require('../automations');
const events = require('../events');
const cptServer = require('../cpt-server');

// ── 저장소 ───────────────────────────────────────────────────────────────────
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const REPO = 'work/app';
const REPO_DIR = path.join(ROOT, REPO);
fs.mkdirSync(REPO_DIR, { recursive: true });
G(REPO_DIR, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'one\n');
G(REPO_DIR, 'add', '-A');
G(REPO_DIR, 'commit', '-q', '-m', 'init');

// ── 터미널 스텁(tasks.test.js 와 같은 모양) — 실 tmux 무접촉 ─────────────────
const sessions = new Map(); // tsession → { command, title }
let tidSeq = 1000001;
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
  sendKeys: async () => {},
  isHostBackend: () => false,
};
const back = [];
let wsSeq = 1;
const backStub = async (m, p, b) => {
  back.push({ m, p, b });
  if (m === 'POST' && p === '/api/daemon/workspaces') return { id: `ws_${wsSeq++}` };
  return {};
};
// cpt-server 기동 전에 deps 를 먼저 꽂는다 — wireTasks 의 start/reconcile 이 실 tmux 를 부르지 않게.
tasks.configure({
  deps: { pty: ptyStub, termBackend: tbStub, manifest: { forget() {} }, agentWatch: { agentSignalOf: () => ({ on: false }) } },
  log: () => {},
});

let srv = null;
after(async () => {
  try { if (srv) await new Promise((r) => srv.close(() => r())); } catch (_) { /* noop */ }
  await auto._internals._reset();
  await tasks._internals._drain();
  await tasks._internals._reset();
  events._reset();
  agents._internals.setSearchOverride(null);
  agents._internals.resetCache();
  taskGit.resetCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

// 로컬 소켓 NDJSON one-shot(PC 앱 auto_local/task_local 과 같은 모양 — ctx 없음).
function sock(cmd, args, ctx) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(cptServer.sockPath());
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify({ id: 'e2e', cmd, args: args || {}, ...(ctx ? { ctx } : {}) }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const res = JSON.parse(buf.slice(0, i));
      c.end();
      if (res.ok) resolve(res.result); else reject(Object.assign(new Error(res.error), { code: res.code }));
    });
    c.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor 시간 초과');
    await sleep(20);
  }
}
async function settle() {
  await auto._internals._drain();
  await tasks._internals._drain();
}

test('헤드리스 E2E — 이슈 2개 → 자동화 작업 2개(origin) → 그 터미널의 cpt auto create 는 AUTO_LOOP → 전체 일시정지 뒤 0건', async () => {
  srv = cptServer.start();
  await waitFor(() => srv.listening);
  // 기동 뒤 배선 교체 — 실 back/터미널 대신 스텁(엔진·상태기계·소켓은 실물 그대로)
  tasks.configure({
    launch: async (a) => { const s = [...sessions.entries()].find(([k]) => k.endsWith(`--t-${a.index}`)); if (s) s[1].command = a.id; return { ok: true, ready: true }; },
    chatInput: async () => ({ ok: true }),
    chatDialog: async () => ({ ok: true, dialog: null }),
    keys: async () => {},
    screen: async () => '',
    backFetch: backStub,
    notify: () => {},
    poolChanged: () => {},
    deviceId: () => 42,
    timings: { trustWindowMs: 200, trustPollMs: 20, trustPendingPollMs: 30, readyTimeoutMs: 200, readyPollMs: 20, readyStableMs: 40, launchTimeoutMs: 100 },
  });
  auto.configure({ backFetch: backStub, log: () => {}, notify: () => {}, timings: { firstPollMs: 3600 * 1000 } });

  // caps — 배선이 모듈 존재대로 광고(auto 는 켜짐, dispatch/power 는 env 킬스위치로 꺼짐)
  const caps = require('../control').daemonCaps();
  assert.ok(caps.includes('auto.v1') && caps.includes('task.v1'));
  assert.ok(!caps.includes('dispatch.v1') && !caps.includes('power.v1'));
  await assert.rejects(() => sock('power.status', {}), (e) => e.code === 'POWER_DISABLED');

  // 1) auto.create — 로컬 소켓(PC 앱 경로, ctx 없음)
  const issue = (number, title) => ({ number, title, body: `본문 ${number}`, url: `https://github.com/acme/demo/issues/${number}`, labels: ['bug'], author: 'alice', at: '2026-09-28T00:00:00Z' });
  fs.writeFileSync(GH_ISSUES, JSON.stringify([issue(11, '로그인 버그'), issue(12, '결제 버그')]));
  const created = await sock('auto.create', {
    opId: crypto.randomUUID(),
    draft: {
      name: 'bug 이슈마다 작업',
      trigger: { type: 'github.issues', repo: REPO, labels: ['bug'] },
      actions: [{ type: 'task.create', repo: REPO, agents: [{ id: 'claude', count: 1 }], title: '{issue.title}', prompt: '이슈 #{issue.number} 를 처리해라.\n\n{issue.body}' }],
      guards: { cooldownMs: 0 },
    },
  });
  const autoId = created.automation.id;
  assert.strictEqual(created.automation.createdBy.kind, 'user');

  // 2) 폴러 강제 틱 → 작업 2개(origin 있음)
  await auto._internals.poll({ force: true });
  await settle();
  const list = await waitFor(async () => {
    const l = await sock('task.list', { includeClosed: true });
    const mine = l.items.filter((t) => t.origin && t.origin.kind === 'automation');
    return mine.length === 2 && mine.every((t) => t.runs[0].tsession) ? mine : null;
  });
  assert.deepStrictEqual(list.map((t) => t.title).sort(), ['결제 버그', '로그인 버그']);
  for (const t of list) {
    assert.strictEqual(t.origin.automationId, autoId);
    assert.strictEqual(t.origin.depth, 1);
    assert.match(t.origin.firingId, /^f_[0-9a-z]{10}$/);
    assert.match(t.runs[0].cwd, /^\.codingpt\/worktrees\//, 'worktree 작업만');
  }
  const full = await sock('task.get', { taskId: list[0].id });
  assert.ok(full.task.prompt.endsWith(auto._internals.LOOP_NOTE('bug 이슈마다 작업')));
  assert.strictEqual(G(REPO_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '메인 체크아웃 불가침');
  const a1 = (await sock('auto.get', { id: autoId })).automation;
  assert.strictEqual(a1.state.runsToday, 2);
  assert.strictEqual(a1.state.lastResult.ok, true);

  // 3) 그 run 터미널 안의 에이전트가 자동화를 만들려 하면 AUTO_LOOP (실제 cpt CLI → 실제 소켓)
  const run0 = list[0].runs[0];
  const cli = path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js');
  const res = await new Promise((resolve) => {
    const ch = execFile(process.execPath, [cli, 'auto', 'create', '-'], {
      env: { ...process.env, CPT_SOCK: cptServer.sockPath(), CPT_WS: run0.cwd, CPT_TSESSION: run0.tsession, CPT_TID: String(run0.tid), TMUX_PANE: '' },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    ch.stdin.end(JSON.stringify({ trigger: { type: 'pr.ci_failed' }, actions: [{ type: 'notify', title: 'x' }] }));
  });
  assert.strictEqual(res.code, 1, res.stdout);
  assert.match(res.stderr, /오류\(AUTO_LOOP\)/);
  assert.strictEqual((await sock('auto.list', {})).items.length, 1, '만들어지지 않았다');

  // 4) 전체 일시정지 → 새 이슈가 와도 0건
  assert.deepStrictEqual(await sock('auto.pauseAll', { paused: true }), { paused: true });
  fs.writeFileSync(GH_ISSUES, JSON.stringify([issue(11, '로그인 버그'), issue(12, '결제 버그'), issue(13, '새 버그')]));
  await auto._internals.poll({ force: true });
  auto._internals.tick();
  await settle();
  const after2 = (await sock('task.list', { includeClosed: true })).items.filter((t) => t.origin && t.origin.kind === 'automation');
  assert.strictEqual(after2.length, 2, '일시정지 중엔 0건');
  // 감사 로그 — 프롬프트 본문 없음
  const log = (await sock('auto.log', { id: autoId })).lines;
  assert.deepStrictEqual(log.filter((l) => l.stage === 'end').map((l) => l.ok), [true, true]);
  assert.ok(!JSON.stringify(log).includes('처리해라'));
});
