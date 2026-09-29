'use strict';
if (process.platform === 'win32') {
  require('node:test')('dispatch.test.js: win32 스킵 — POSIX 픽스처(셔뱅 가짜 claude)', { skip: true }, () => {});
  return;
}
// F1 한 줄 지시(dispatch.js) — automation-design §3 · §9.1.
//  가짜 claude 셸 스크립트(stdin 을 읽고 고정 JSON / `--tools ""` 인자 assert / exit 1 / 무응답)로 cli·폴백 두 경로.
//  ★ 실제 claude·codex·gemini 를 부르지 않는다(탐색 경로를 가짜 bin 으로 고정). back 은 스텁.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-dispatch-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
const MODE = path.join(ROOT, 'claude.mode');
const OUT = path.join(ROOT, 'claude.out');
const STDIN = path.join(ROOT, 'claude.stdin');
const ARGS = path.join(ROOT, 'claude.args');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '[user]\n\temail = dev@example.com\n\tname = Dev\n');
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-dispatch-${process.pid}`;
process.env.FAKE_MODE = MODE;
process.env.FAKE_OUT = OUT;
process.env.FAKE_STDIN = STDIN;
process.env.FAKE_ARGS = ARGS;
delete process.env.CPT_DISPATCH;

const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: STATE, claudeHome: path.join(ROOT, '.claude') });

// 가짜 claude — FAKE_MODE 파일 내용으로 분기. 인자는 한 줄에 하나씩 기록(빈 인자도 빈 줄로 남는다).
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh
: > "$FAKE_ARGS"
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_ARGS"; done
mode=$(cat "$FAKE_MODE" 2>/dev/null)
case "$1" in --version) echo "2.1.284 (Claude Code)"; exit 0;; esac
case "$mode" in
  fail) cat > /dev/null; echo "boom: not logged in" >&2; exit 1;;
  hang) exec sleep 30;;
  trust) cat > /dev/null; echo "Do you trust the files in this folder?"; exit 0;;
esac
prev=""; found=0
for a in "$@"; do
  if [ "$prev" = "--tools" ] && [ -z "$a" ]; then found=1; fi
  prev="$a"
done
if [ "$found" != 1 ]; then echo 'missing --tools ""' >&2; exit 5; fi
cat > "$FAKE_STDIN"
cat "$FAKE_OUT"
`, { mode: 0o755 });

const agents = require('../agents');
agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
let loginReply = () => ({ code: 0, stdout: '{"loggedIn":true}' });
agents._internals.setLoginExec(async (bin, args) => loginReply(bin, args));
const taskGit = require('../task-git');
taskGit.resetCache();
const dispatch = require('../dispatch');
const I = dispatch._internals;
const FIX = path.resolve(__dirname, '..', '..', '..', 'docs', 'fixtures', 'automation');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

let clock = 1790000000000;
const notified = [];
let wsList = [];
function wire(extra = {}) {
  dispatch.configure({
    notify: (x) => notified.push(x),
    backFetch: async (m, p) => { if (m === 'GET' && p === '/api/daemon/workspaces') return wsList; return {}; },
    deviceId: () => 12,
    log: () => {},
    now: () => clock,
    tasks: { recentAgent: () => 'codex' },
    hostName: () => 'MacBook Pro',
    timings: { plannerTimeoutMs: 800 },
    ...extra,
  });
}
wire();
dispatch.start();

after(async () => {
  await I._drain();
  I._reset();
  agents._internals.setSearchOverride(null);
  agents._internals.setLoginExec(null);
  agents._internals.resetCache();
  taskGit.resetCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

const uuid = () => crypto.randomUUID();
const call = (m, p) => dispatch.handle(m, p);
const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const fb = readFix('dispatch-fallback-01.json');
const CAT = fb.catalog;
function setMode(m, out) {
  fs.writeFileSync(MODE, m || '');
  if (out !== undefined) fs.writeFileSync(OUT, typeof out === 'string' ? out : JSON.stringify(out));
}
async function planAndWait(params) {
  const acc = await call('dispatch.plan', { opId: uuid(), instruction: 'codingpt back 에 결제 실패 재시도 넣어줘', catalog: CAT, ...params });
  assert.strictEqual(acc.accepted, true);
  await I._drain();
  return { acc, got: await call('dispatch.get', { planId: acc.planId }) };
}
const claudeResult = (obj) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: `계획입니다:\n${JSON.stringify(obj)}\n끝`, total_cost_usd: 0.01 });

// ══════════════════════════════════════════════════════════════════════════
test('planFallback — 픽스처 dispatch-fallback-01(이름 정확·topDirs subdir·README 토큰·미매칭 null·단일 워크스페이스)', () => {
  for (const c of fb.cases) {
    const p = dispatch.planFallback(c.instruction, c.catalog || CAT, { now: fb.now, ...c.opts });
    assert.strictEqual(p.planner.mode, 'fallback', c.name);
    assert.deepStrictEqual(p.automations, [], `${c.name}: 폴백은 자동화를 제안하지 않는다`);
    assert.deepStrictEqual(p.questions, []);
    assert.strictEqual(p.tasks.length, 1, c.name);
    const t = p.tasks[0];
    const e = c.expect;
    assert.deepStrictEqual({ host: t.host, workspaceId: t.workspaceId, repo: t.repo, subdir: t.subdir, base: t.base, agent: t.agents[0].id },
      { host: e.host, workspaceId: e.workspaceId, repo: e.repo, subdir: e.subdir, base: e.base, agent: e.agent }, c.name);
    assert.strictEqual(t.agents[0].count, 1);
    assert.ok(t.confidence >= e.minConfidence && t.confidence <= 1, `${c.name}: confidence ${t.confidence}`);
    assert.strictEqual(t.prompt, c.instruction);
    assert.deepStrictEqual(Object.keys(t).sort(), [...dispatch.PLAN_TASK_FIELDS].sort());
  }
  assert.deepStrictEqual(dispatch.tokenize('좀 해줘 Codingpt_Back 추가'), ['codingpt', 'back']);
});

test('cli 모드 — 가짜 claude: 인자(-p json max-turns 1 --tools "" append-system-prompt) · stdin 카탈로그+지시 · 빈 cwd · 항목 단위 검증(BAD 항목 제거)', async () => {
  setMode('ok', claudeResult({
    summary: '결제 재시도',
    tasks: [
      { host: 12, workspaceId: 'ws_abc', subdir: 'codingpt_back', base: 'main', title: '결제 재시도', prompt: '재시도 넣어', agents: [{ id: 'claude', count: 1 }, { id: 'gemini', count: 1 }], confidence: 0.8, why: 'README' },
      { host: 99, workspaceId: 'ws_abc', title: 'x', prompt: 'x', agents: [{ id: 'claude', count: 1 }] },          // 카탈로그 밖 host
      { host: 12, workspaceId: 'ws_nope', title: 'x', prompt: 'x', agents: [{ id: 'claude', count: 1 }] },        // 없는 워크스페이스
      { host: 13, workspaceId: 'ws_blog', title: 'x', prompt: 'x', agents: [{ id: 'claude', count: 1 }] },        // 그 host 에 claude 미설치
      { host: 13, workspaceId: 'ws_blog', subdir: '../etc', title: '블로그', prompt: '정리', agents: [{ id: 'codex', count: 3 }] }, // 합계 4 = 상한
      { host: 12, workspaceId: 'ws_hey', title: 'y', prompt: 'y', agents: [{ id: 'claude', count: 1 }] },          // 합계 run 4 초과 → 탈락
    ],
    automations: [
      { host: 12, draft: { name: '매일 이슈', trigger: { type: 'schedule', cron: '0 9 * * *', tz: 'Asia/Seoul' }, actions: [{ type: 'notify', title: 'x' }] }, why: '매일' },
      { host: 12, draft: { name: '셸', trigger: { type: 'schedule', cron: '0 9 * * *' }, actions: [{ type: 'shell', cmd: 'rm -rf /' }] } },
    ],
    questions: ['정리가 닫기까지인가요?', '', 3],
  }));
  const { acc, got } = await planAndWait({});
  assert.deepStrictEqual(acc.planner, { agent: 'claude' });
  assert.match(acc.planId, /^p_[0-9a-z]{10}$/);
  assert.strictEqual(got.state, 'done');
  const plan = got.plan;
  assert.deepStrictEqual(Object.keys(plan).sort(), [...dispatch.PLAN_FIELDS].sort());
  assert.deepStrictEqual(Object.keys(plan.planner).sort(), [...dispatch.PLANNER_FIELDS].sort());
  assert.strictEqual(plan.planner.mode, 'cli');
  assert.strictEqual(plan.planner.agent, 'claude');
  assert.strictEqual(plan.planner.fallbackReason, null);
  assert.strictEqual(plan.tasks.length, 2, JSON.stringify(plan.tasks));
  assert.deepStrictEqual(plan.tasks[0].agents, [{ id: 'claude', count: 1 }], '미설치 gemini 는 버린다');
  assert.strictEqual(plan.tasks[0].subdir, 'codingpt_back');
  assert.strictEqual(plan.tasks[0].repo, 'work/codingpt');
  assert.strictEqual(plan.tasks[1].subdir, '', '카탈로그 topDirs 밖 subdir 은 무시');
  assert.deepStrictEqual(plan.tasks[1].agents, [{ id: 'codex', count: 3 }]);
  assert.ok(plan.tasks.reduce((n, t) => n + t.agents.reduce((m, a) => m + a.count, 0), 0) <= 4, '합계 run ≤ 4');
  assert.strictEqual(plan.automations.length, 1, '셸 액션 자동화는 버린다');
  assert.deepStrictEqual(plan.questions, ['정리가 닫기까지인가요?']);
  // 인자·stdin·cwd
  const args = fs.readFileSync(ARGS, 'utf8').split('\n');
  for (const a of ['-p', '--output-format', 'json', '--max-turns', '1', '--tools', '--no-session-persistence', '--append-system-prompt']) assert.ok(args.includes(a), a);
  assert.strictEqual(args[args.indexOf('--tools') + 1], '', '--tools "" (도구 0개)');
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /너는 작업 계획기다/);
  const stdin = fs.readFileSync(STDIN, 'utf8');
  assert.match(stdin, /## 카탈로그/);
  assert.match(stdin, /ws_abc/);
  assert.match(stdin, /결제 실패 재시도/);
  assert.deepStrictEqual(fs.readdirSync(path.join(STATE, 'dispatch', 'cwd')), [], '플래너 cwd 는 빈 폴더');
  // 결과 파일(0600) + 통지(planId 만)
  const file = I.planFile(acc.planId);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(notified.some((n) => n.ids[0] === acc.planId && n.reason === 'done'));
  assert.ok(!JSON.stringify(notified).includes('결제'), '통지에 내용 없음');
  assert.deepStrictEqual(dispatch.activeReasons(), []);
});

test('폴백 — exit 1(PLANNER_FAILED)·신뢰 문구(PLANNER_FAILED)·무응답(PLANNER_TIMEOUT)·스키마 위반(BAD_PLAN)·미로그인(PLANNER_UNAVAILABLE)', async () => {
  setMode('fail');
  let { got } = await planAndWait({});
  assert.strictEqual(got.state, 'done');
  assert.strictEqual(got.plan.planner.mode, 'fallback');
  assert.strictEqual(got.plan.planner.fallbackReason, 'PLANNER_FAILED');
  assert.strictEqual(got.plan.planner.agent, 'claude');
  assert.strictEqual(got.plan.tasks[0].workspaceId, 'ws_abc');
  assert.strictEqual(got.plan.tasks[0].agents[0].id, 'codex', '폴백 에이전트 = 이 PC 최근 작업');
  assert.deepStrictEqual(got.plan.automations, []);

  setMode('trust');
  ({ got } = await planAndWait({}));
  assert.strictEqual(got.plan.planner.fallbackReason, 'PLANNER_FAILED');

  setMode('ok', claudeResult({ tasks: [{ host: 12, workspaceId: 'nope', agents: [{ id: 'claude' }] }] }));
  ({ got } = await planAndWait({}));
  assert.strictEqual(got.plan.planner.fallbackReason, 'BAD_PLAN');

  setMode('ok', { type: 'result', is_error: false, result: '계획을 못 세웠어요' });
  ({ got } = await planAndWait({}));
  assert.strictEqual(got.plan.planner.fallbackReason, 'BAD_PLAN');

  setMode('hang');
  const t0 = Date.now();
  ({ got } = await planAndWait({}));
  assert.strictEqual(got.plan.planner.fallbackReason, 'PLANNER_TIMEOUT');
  assert.ok(Date.now() - t0 < 5000, '데드라인(테스트 800ms) 뒤 SIGTERM');

  // 미로그인 — claude auth status 가 loggedIn:false → 쓸 플래너 없음(캐시 무효화 필요)
  loginReply = () => ({ code: 1, stdout: '{"loggedIn":false}' });
  agents._internals.setLoginExec(async (bin, args) => loginReply(bin, args));
  I._reset(); wire(); dispatch.start();
  setMode('ok', claudeResult({}));
  const r = await planAndWait({});
  assert.strictEqual(r.acc.planner, null);
  assert.strictEqual(r.got.plan.planner.fallbackReason, 'PLANNER_UNAVAILABLE');
  assert.strictEqual(r.got.plan.planner.agent, null);
  loginReply = () => ({ code: 0, stdout: '{"loggedIn":true}' });
  agents._internals.setLoginExec(async (bin, args) => loginReply(bin, args));
  I._reset(); wire(); dispatch.start();
});

test('opId 멱등 · 24h 만료 · 파라미터 검증(BAD_PARAMS·CATALOG_TOO_LARGE·DISPATCH_NOT_FOUND)', async () => {
  setMode('fail');
  const opId = uuid();
  const a = await call('dispatch.plan', { opId, instruction: 'codingpt 고쳐', catalog: CAT });
  const b = await call('dispatch.plan', { opId, instruction: 'codingpt 고쳐', catalog: CAT });
  assert.strictEqual(a.planId, b.planId);
  assert.strictEqual(b.replay, true);
  await I._drain();
  const g = await call('dispatch.get', { planId: a.planId });
  assert.strictEqual(g.state, 'done');
  // 파일에서도 읽힌다(메모리 소실 = 재기동)
  I.plans.delete(a.planId);
  assert.strictEqual((await call('dispatch.get', { planId: a.planId })).state, 'done');
  // 24h 뒤
  clock += 24 * 3600 * 1000 + 1;
  await assert.rejects(() => call('dispatch.get', { planId: a.planId }), (e) => e.code === 'DISPATCH_NOT_FOUND');
  assert.ok(!fs.existsSync(I.planFile(a.planId)));
  await assert.rejects(() => call('dispatch.get', { planId: 'p_zzzzzzzzzz' }), (e) => e.code === 'DISPATCH_NOT_FOUND');
  await assert.rejects(() => call('dispatch.get', { planId: '../x' }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('dispatch.plan', { opId: uuid(), instruction: '가'.repeat(1334), catalog: CAT }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('dispatch.plan', { opId: uuid(), instruction: 'x', catalog: {} }), (e) => e.code === 'BAD_PARAMS');
  await assert.rejects(() => call('dispatch.plan', { instruction: 'x', catalog: CAT }), (e) => e.code === 'BAD_PARAMS');
  const big = { hosts: [{ host: 1, workspaces: [{ id: 'w', readmeHead: 'x'.repeat(270 * 1024) }] }] };
  await assert.rejects(() => call('dispatch.plan', { opId: uuid(), instruction: 'x', catalog: big }), (e) => e.code === 'CATALOG_TOO_LARGE');
  await assert.rejects(() => call('dispatch.nope', {}), (e) => e.code === 'BAD_PARAMS');
  await I._drain();
});

test('dispatch.catalog — 이 PC 로컬 워크스페이스만(작업 worktree·다른 PC·폴더 없음 제외), git 정보·README 머리·topDirs·github, 10분 캐시', async () => {
  const mk = (rel, readme) => {
    const dir = path.join(ROOT, rel);
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'a.txt'), 'a\n');
    if (readme != null) fs.writeFileSync(path.join(dir, 'README.md'), readme);
    G(dir, 'init', '-q', '-b', 'main');
    G(dir, 'add', '-A');
    G(dir, 'commit', '-q', '-m', 'first commit');
    G(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    return dir;
  };
  mk('work/demo', `# Demo\n${'설명 줄입니다\n'.repeat(80)}`);
  mk('work/plain', null);
  fs.mkdirSync(path.join(ROOT, 'work', 'notgit'), { recursive: true });
  fs.mkdirSync(path.join(STATE, 'worktrees', 'demo-abcdef-1'), { recursive: true });
  wsList = [
    { id: 'w1', name: 'demo', compute: 'local', hostDeviceId: 12, localPath: 'work/demo' },
    { id: 'w2', name: 'plain', compute: 'local', hostDeviceId: 12, localPath: 'work/plain' },
    { id: 'w3', name: 'task', compute: 'local', hostDeviceId: 12, localPath: '.codingpt/worktrees/demo-abcdef-1' },
    { id: 'w4', name: 'other', compute: 'local', hostDeviceId: 13, localPath: 'work/demo' },
    { id: 'w5', name: 'gone', compute: 'local', hostDeviceId: 12, localPath: 'work/gone' },
    { id: 'w6', name: 'cloud', compute: 'cloud', hostDeviceId: 12, localPath: 'work/demo' },
    { id: 'w7', name: 'notgit', compute: 'local', hostDeviceId: 12, localPath: 'work/notgit' },
  ];
  const cat = await call('dispatch.catalog', { refresh: true });
  assert.deepStrictEqual(Object.keys(cat).sort(), [...dispatch.CATALOG_FIELDS].sort());
  assert.strictEqual(cat.host, 12);
  assert.strictEqual(cat.hostName, 'MacBook Pro');
  assert.deepStrictEqual(cat.workspaces.map((w) => w.id).sort(), ['w1', 'w2']);
  const w = cat.workspaces.find((x) => x.id === 'w1');
  assert.deepStrictEqual(Object.keys(w).sort(), [...dispatch.WORKSPACE_FIELDS].sort());
  assert.strictEqual(w.path, 'work/demo');
  assert.strictEqual(w.subdir, '');
  assert.strictEqual(w.branch, 'main');
  assert.deepStrictEqual(w.github, { owner: 'acme', repo: 'demo' });
  assert.deepStrictEqual(w.recentCommits, ['first commit']);
  assert.deepStrictEqual(w.topDirs, ['server'], '점 폴더·node_modules 제외');
  assert.ok(Buffer.byteLength(w.readmeHead, 'utf8') <= 600);
  assert.ok(w.readmeHead.startsWith('# Demo'));
  assert.ok(!w.readmeHead.endsWith('설명'), '줄 경계에서 자른다');
  assert.ok(w.lastActivityAt > 0);
  assert.strictEqual(cat.workspaces.find((x) => x.id === 'w2').readmeHead, '');
  assert.deepStrictEqual(cat.agents.map((a) => a.id), ['claude', 'codex', 'gemini']);
  assert.deepStrictEqual(cat.agents[0], { id: 'claude', installed: true, loggedIn: true });
  assert.deepStrictEqual(cat.agents[1], { id: 'codex', installed: false, loggedIn: false });
  assert.strictEqual(cat.truncated, false);
  // 캐시(10분) — 목록이 바뀌어도 그대로, refresh 로 무효화
  wsList = [];
  assert.strictEqual((await call('dispatch.catalog', {})).workspaces.length, 2);
  assert.strictEqual((await call('dispatch.catalog', { refresh: true })).workspaces.length, 0);
});

test('카탈로그 상한 — 40개·48KB 초과분은 lastActivityAt 오래된 순으로 잘라 truncated:true', () => {
  const ws = Array.from({ length: 60 }, (_, i) => ({ id: `w${i}`, name: `n${i}`, readmeHead: 'x'.repeat(1500), lastActivityAt: i }));
  const cat = I.capCatalog({ host: 1, hostName: 'h', generatedAt: 0, agents: [], workspaces: ws, truncated: false });
  assert.strictEqual(cat.truncated, true);
  assert.ok(cat.workspaces.length <= 40);
  assert.ok(Buffer.byteLength(JSON.stringify(cat), 'utf8') <= 48 * 1024);
  assert.strictEqual(cat.workspaces[0].id, 'w59', '최신부터 남긴다');
  const small = I.capCatalog({ host: 1, hostName: 'h', generatedAt: 0, agents: [], workspaces: ws.slice(0, 3), truncated: false });
  assert.strictEqual(small.truncated, false);
});

test('extractJson — 첫 { ~ 마지막 } · 실패 null · 킬스위치 CPT_DISPATCH=0 이면 handle undefined', () => {
  assert.deepStrictEqual(I.extractJson('앞말 {"a":{"b":1}} 뒷말'), { a: { b: 1 } });
  assert.strictEqual(I.extractJson('없음'), null);
  assert.strictEqual(I.extractJson('{깨짐}'), null);
  assert.strictEqual(typeof dispatch.handle, 'function');
  process.env.CPT_DISPATCH = '0';
  try { assert.strictEqual(dispatch.handle, undefined); } finally { delete process.env.CPT_DISPATCH; }
});
