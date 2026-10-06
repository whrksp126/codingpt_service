// 이슈(issues.js) 계약 — node --test. 진짜 gh·tmux 없이 주입으로 돈다.
//  지키는 것: 자체 이슈와 외부 이슈가 같은 모양으로 한 목록에 온다 · 외부 이슈는 복사하지 않고 작업 상태만 얹는다 ·
//  시작하면 진행 중이 되고, 작업(worktree)의 상태를 따라 리뷰 중·완료·할 일로 옮겨진다 · 사람이 옮긴 완료는 덮지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-issues-'));
runtime.init({ root: HOME, stateDir: path.join(HOME, '.codingpt'), claudeHome: path.join(HOME, '.claude') });
const issues = require('../issues');

const GH = [
  { number: 7, title: '로그인 리다이렉트', body: '본문', state: 'OPEN', labels: [{ name: 'bug' }], url: 'https://github.com/me/app/issues/7', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
  { number: 3, title: '닫힌 것', body: '', state: 'CLOSED', labels: [], url: 'https://github.com/me/app/issues/3', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
];
const ghCalls = [];
const taskItems = [];
const launched = [];
let clock = 1000;
issues.configure({
  now: () => ++clock,
  absOf: (rel) => path.join(HOME, rel),
  taskGit: { gh: async (args, o) => {
    ghCalls.push(args.join(' '));
    if (!o.cwd.endsWith('work/app')) return { ok: false, err: 'fatal: not a git repository', out: '' };
    if (args[1] === 'list') return { ok: true, out: JSON.stringify(GH) };
    if (args[1] === 'close') { GH[0].state = 'CLOSED'; return { ok: true, out: '' }; }
    if (args[1] === 'reopen') { GH[0].state = 'OPEN'; return { ok: true, out: '' }; }
    return { ok: true, out: '' };
  } },
  tasks: { internalCreate: async (p, origin) => { const t = { id: 'task_' + (taskItems.length + 1), state: 'open', runs: [{ state: 'running' }], p, origin }; taskItems.push(t); return { task: t }; },
    _internals: { load: () => ({ items: taskItems }) } },
  launchPrompted: async (a) => { launched.push(a); return { tid: 55, tsession: 'cpt-x--t-55' }; },
  notify: () => {},
});
const M = issues.METHODS;

test('자체 이슈 — 만들기·번호·고치기·지우기', async () => {
  const a = (await M.issueCreate({ title: ' 결제 재시도 ', body: '세 번까지', cwd: 'work/app', priority: 'high', labels: 'bug, pay' })).issue;
  assert.equal(a.number, 1); assert.equal(a.key, '#1'); assert.equal(a.title, '결제 재시도'); assert.equal(a.status, 'todo');
  assert.deepEqual(a.labels, ['bug', 'pay']); assert.equal(a.source.provider, 'codingpt');
  const b = (await M.issueCreate({ title: '둘째' })).issue;
  assert.equal(b.number, 2);
  const u = (await M.issueUpdate({ id: '#1', status: 'in_review', title: '결제 재시도 v2' })).issue;
  assert.equal(u.status, 'in_review'); assert.equal(u.title, '결제 재시도 v2');
  await assert.rejects(M.issueUpdate({ id: a.id, status: 'nope' }), { code: 'BAD_PARAMS' });
  await assert.rejects(M.issueCreate({ title: '   ' }), { code: 'BAD_PARAMS' });
  await M.issueDelete({ id: b.id });
  await assert.rejects(M.issueGet({ id: b.id }), { code: 'ISSUE_NOT_FOUND' });
  assert.equal((await M.issueCreate({ title: '셋째' })).issue.number, 3, '지운 번호를 다시 쓰지 않는다');
  assert.equal(fs.statSync(issues._internals.file()).mode & 0o777, 0o600);
});

test('한 목록 — 자체 + GitHub 가 같은 모양으로, 저장소가 아닌 폴더는 조용히 빠진다', async () => {
  const r = await M.issueList({ cwds: ['work/app', 'work/plain'] });
  const gh = r.issues.filter((x) => x.source.provider === 'github');
  assert.equal(gh.length, 2);
  const open = gh.find((x) => x.number === 7);
  assert.equal(open.id, 'gh:me/app#7'); assert.equal(open.key, 'app#7'); assert.equal(open.status, 'todo'); assert.equal(open.cwd, 'work/app');
  assert.deepEqual(open.labels, ['bug']); assert.equal(open.source.url, GH[0].url);
  assert.equal(gh.find((x) => x.number === 3).status, 'done', '닫힌 이슈 = 완료');
  assert.ok(r.issues.some((x) => x.source.provider === 'codingpt'));
  assert.deepEqual(r.sources.map((s) => [s.provider, s.cwd, s.ok]), [['codingpt', null, true], ['github', 'work/app', true]]);
  const keys = Object.keys(open).sort().join(',');
  assert.equal(keys, Object.keys(r.issues.find((x) => x.source.provider === 'codingpt')).sort().join(','), '두 출처의 필드가 같다');
  const n = ghCalls.length;
  await M.issueList({ cwds: ['work/app'] });
  assert.equal(ghCalls.length, n, '1분 안에는 다시 묻지 않는다');
});

test('외부 이슈 — 작업 상태는 우리가 얹고, 완료/다시 열기만 그 서비스에 쓴다', async () => {
  let u = (await M.issueUpdate({ id: 'gh:me/app#7', status: 'in_progress', priority: 'urgent' })).issue;
  assert.equal(u.status, 'in_progress'); assert.equal(u.priority, 'urgent');
  assert.ok(!ghCalls.some((c) => /^issue (close|edit)/.test(c)), '진행 중은 GitHub 에 쓰지 않는다');
  u = (await M.issueUpdate({ id: 'gh:me/app#7', status: 'done' })).issue;
  assert.ok(ghCalls.includes('issue close 7')); assert.equal(u.status, 'done');
  u = (await M.issueUpdate({ id: 'gh:me/app#7', status: 'todo' })).issue;
  assert.ok(ghCalls.includes('issue reopen 7')); assert.equal(u.status, 'todo');
  await assert.rejects(M.issueDelete({ id: 'gh:me/app#7' }), { code: 'BAD_PARAMS' });
});

test('시작 — 작업으로: 진행 중이 되고 작업 상태를 따라간다(리뷰 준비 → 머지 / 폐기)', async () => {
  const r = await M.issueStart({ id: '#1', mode: 'task', agent: 'claude', model: 'sonnet' });
  assert.equal(r.issue.status, 'in_progress'); assert.equal(r.started.taskId, 'task_1');
  const t = taskItems[0];
  assert.equal(t.origin.kind, 'issue'); assert.equal(t.p.repo, 'work/app'); assert.match(t.p.prompt, /^이슈 #1: 결제 재시도 v2\n\n세 번까지/);
  assert.match(t.p.prompt, /cpt issue update/); assert.deepEqual(t.p.agents, [{ id: 'claude', model: 'sonnet' }]);
  t.runs[0].state = 'review_ready';
  assert.equal((await M.issueList({})).issues.find((x) => x.number === 1 && x.source.provider === 'codingpt').status, 'in_review');
  t.state = 'merged';
  assert.equal((await M.issueGet({ id: '#1' })).issue.status, 'in_review', 'get 은 끌어오지 않는다(목록이 한다)');
  assert.equal((await M.issueList({})).issues.find((x) => x.id === r.issue.id).status, 'done');
  // 사람이 옮긴 상태는 덮지 않는다
  await M.issueUpdate({ id: '#1', status: 'todo' });
  assert.equal((await M.issueList({})).issues.find((x) => x.id === r.issue.id).status, 'todo');
  // 폐기 → 다시 할 일
  const r3 = await M.issueStart({ id: '#3', cwd: 'work/app', mode: 'task' });
  taskItems[1].state = 'discarded';
  const back = (await M.issueList({})).issues.find((x) => x.id === r3.issue.id);
  assert.equal(back.status, 'todo'); assert.equal(back.link, null);
});

test('시작 — 새 터미널/오케스트레이션: 프롬프트로 에이전트를 띄운다. 외부 이슈는 주소를 넘긴다', async () => {
  const a = await M.issueStart({ id: 'gh:me/app#7', mode: 'terminal', agent: 'codex' });
  assert.equal(a.started.tid, 55); assert.equal(a.issue.status, 'in_progress'); assert.equal(a.issue.link.mode, 'terminal');
  assert.match(launched[0].prompt, /^이 이슈를 해결해 주세요: https:\/\/github\.com\/me\/app\/issues\/7/); assert.equal(launched[0].cwd, 'work/app');
  await M.issueStart({ id: '#3', cwd: 'work/app', mode: 'orch', agent: 'claude' });
  assert.match(launched[1].prompt, /^\/orch 이슈 #3: 셋째/);
  await M.issueStart({ id: '#3', cwd: 'work/app', mode: 'orch', agent: 'codex' });
  assert.match(launched[2].prompt, /^\$orch 이슈 #3/);
  const c = (await M.issueCreate({ title: '폴더 없음' })).issue;
  await assert.rejects(M.issueStart({ id: c.id, mode: 'terminal' }), { code: 'BAD_PARAMS' });
});

test('첨부 — 파일을 이 PC 에 복사하고, 시작할 때 본문의 자리를 실제 경로로 바꾼다', async () => {
  const img = path.join(HOME, 'shot.png'); fs.writeFileSync(img, Buffer.from('89504e47', 'hex'));
  const log = path.join(HOME, 'err.log'); fs.writeFileSync(log, 'boom');
  const x = (await M.issueCreate({ title: '화면이 깨짐', body: '여기 보세요 ![캡처](att:aaaaaa1) 끝', cwd: 'work/app' })).issue;
  const r1 = await M.issueAttach({ id: x.id, path: img, attId: 'aaaaaa1' });
  assert.equal(r1.attachment.image, true); assert.equal(r1.attachment.mime, 'image/png'); assert.ok(fs.existsSync(r1.attachment.path));
  assert.equal(fs.statSync(r1.attachment.path).mode & 0o777, 0o600);
  assert.ok(r1.attachment.path.startsWith(issues._internals.filesRoot()));
  const again = await M.issueAttach({ id: x.id, path: img, attId: 'aaaaaa1' });
  assert.equal(again.issue.attachments.length, 1, '같은 attId 를 다시 보내도 하나다(재시도 안전)');
  const r2 = await M.issueAttach({ id: x.id, path: log });
  assert.equal(r2.issue.attachments.length, 2); assert.equal(r2.attachment.image, false);
  await assert.rejects(M.issueAttach({ id: x.id, path: 'relative.png' }), { code: 'BAD_PARAMS' });
  await assert.rejects(M.issueAttach({ id: x.id, path: path.join(HOME, 'nope.png') }), { code: 'BAD_PARAMS' });
  await M.issueStart({ id: x.id, mode: 'terminal', agent: 'claude' });
  const prompt = launched[launched.length - 1].prompt;
  assert.ok(prompt.includes(`[첨부 이미지 "캡처": ${r1.attachment.path}]`), prompt);
  assert.ok(prompt.includes(`- err.log: ${r2.attachment.path}`));
  assert.ok(!prompt.includes('att:aaaaaa1'));
  const d = await M.issueDetach({ id: x.id, attId: r2.attachment.id });
  assert.equal(d.issue.attachments.length, 1); assert.equal(fs.existsSync(r2.attachment.path), false);
  // 외부 이슈에도 붙일 수 있다(그 서비스에 올리지 않고 여기에만)
  const e = await M.issueAttach({ id: 'gh:me/app#7', path: img });
  assert.equal(e.issue.attachments.length, 1); assert.ok(!ghCalls.some((c) => /upload|attach/.test(c)));
  await M.issueDelete({ id: x.id });
  assert.equal(fs.existsSync(r1.attachment.path), false, '이슈를 지우면 첨부도 지운다');
});
