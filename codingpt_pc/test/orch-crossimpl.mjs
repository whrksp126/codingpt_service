// orch-crossimpl — 오케스트레이션 화면 판정이 **PC ↔ 앱에서 같은가**를 고정한다.
//  두 구현(orch-model.js / orchModel.ts)이 같은 사본을 보고 다른 점·다른 합산을 그리면 "폰에서는 완료인데 PC 는 실패"
//  같은 일이 생긴다. 픽스처 하나를 양쪽에 넣고 결과를 글자까지 대조한다. 문구 사전의 필드도 대조한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };

const W = (id, ui, extra = {}) => ({ dispatchId: id, uiState: ui, state: ['succeeded', 'failed', 'stopped', 'abandoned'].includes(ui) ? ui : (ui === 'starting' ? 'starting' : 'ready'),
  terminal: 'owned', title: 't-' + id, cwd: 'proj', tid: Number(id.slice(1)) + 10, createdAt: Number(id.slice(1)), ...extra });
const FIXTURE = {
  runs: [
    { id: 'r1', state: 'active', cwd: 'proj', objective: '로그인 흐름 손보기\n자세한 설명', createdAt: 2, coordinator: { cwd: 'proj', tid: 1 },
      workers: [W('d3', 'working'), W('d1', 'succeeded'), W('d2', 'asking'), W('d4', 'failed'), W('d5', 'succeeded', { terminal: 'transferred' }),
        W('d6', 'starting', { tid: null }), W('d7', 'succeeded', { terminal: 'released' }), W('d8', 'idle_no_report'), W('d9', 'stopped')],
      gates: [{ id: 'g1' }] },
    { id: 'r0', state: 'active', cwd: 'proj', objective: '', createdAt: 1, coordinator: { cwd: 'proj', tid: 2 }, workers: [W('d20', 'succeeded')], gates: [] },
    { id: 'r2', state: 'active', cwd: 'other', objective: '다른 폴더', createdAt: 3, coordinator: { cwd: 'other', tid: 1 }, workers: [W('d30', 'exited', { cwd: 'other' })], gates: [] },
    { id: 'r3', state: 'closed', cwd: 'proj', objective: '닫힘', createdAt: 0, coordinator: { cwd: 'proj', tid: 9 }, workers: [W('d40', 'working')], gates: [] },
    // 워커이면서 하위 묶음의 코디네이터(중첩) — 그 터미널의 표시는 워커가 이긴다.
    { id: 'r4', state: 'active', cwd: 'proj', objective: '하위', createdAt: 4, coordinator: { cwd: 'proj', tid: 13 }, workers: [], gates: [] },
  ],
  notes: [{ cwd: 'proj', comment: '테스트 돌리는 중', status: 'in-progress' }, { cwd: 'empty', comment: null, status: null }],
};

const probe = `
  const snap = FIXTURE;
  const out = {
    dots: ['starting','working','asking','blocked','needs_input','idle_no_report','exited','succeeded','failed','stopped','abandoned','??'].map((u) => [u, M.workerDot(u), M.workerTextKey(u)]),
    runs: M.runsForCwd(snap, 'proj').map((r) => [r.id, M.runTitle(r), M.runRollup(r), M.visibleWorkers(r).map((w) => w.dispatchId)]),
    other: M.runsForCwd(snap, 'other').map((r) => [r.id, M.runRollup(r)]),
    none: M.runsForCwd(snap, 'nope').length,
    notes: [M.noteFor(snap, 'proj'), M.noteFor(snap, 'empty'), M.noteFor(snap, 'nope')],
    attn: [M.attentionCount(snap, 'proj'), M.attentionCount(snap, 'other'), M.attentionCount(null, 'proj')],
    roles: [...M.terminalRoles(snap).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    long: M.runTitle({ objective: '가'.repeat(80) }).length,
    nulls: [M.runRollup(null), M.visibleWorkers(null), M.runsForCwd(null, ''), M.terminalRoles(null).size],
  };
  console.log(JSON.stringify(out));
`;
function run(importLine, flags) {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `orchprobe-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, `${importLine}\nconst FIXTURE = ${JSON.stringify(FIXTURE)};\n${probe}`);
  try { return JSON.parse(execFileSync(process.execPath, [...flags, tmp], { encoding: 'utf8' })); } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}
const pc = run(`import * as M from ${JSON.stringify('file://' + path.join(PC, 'orch-model.js'))};`, []);
const app = run(`import * as M from ${JSON.stringify('file://' + path.join(APP, 'workspace/orch/orchModel.ts'))};`, ['--experimental-strip-types', '--no-warnings']);

for (const k of Object.keys(pc)) ok(JSON.stringify(pc[k]) === JSON.stringify(app[k]), `PC ↔ 앱 같은 결과: ${k}`, `pc=${JSON.stringify(pc[k]).slice(0, 200)} app=${JSON.stringify(app[k]).slice(0, 200)}`);

// PC 전용 — 새 워커 탭을 어느 pane 에 들일지(코디네이터가 있는 pane) 정하는 조회.
{
  const M = await import('file://' + path.join(PC, 'orch-model.js'));
  ok(M.coordinatorTidOf(FIXTURE, 'proj', 13) === 1, '같은 폴더 워커 → 그 묶음 코디네이터의 터미널');
  ok(M.coordinatorTidOf(FIXTURE, 'proj', 30) === 2, '다른 묶음의 워커는 그 묶음의 코디네이터로');
  ok(M.coordinatorTidOf(FIXTURE, 'proj', 17) === null, '정리된(released) 워커 번호는 워커가 아니다');
  ok(M.coordinatorTidOf(FIXTURE, 'proj', 50) === null, '닫힌 묶음의 워커는 따지지 않는다');
  ok(M.coordinatorTidOf(FIXTURE, 'proj', 99) === null && M.coordinatorTidOf(null, 'proj', 13) === null && M.coordinatorTidOf(FIXTURE, 'proj', 'new') === null, '모르는 터미널·사본 없음·번호 아님 → null');
  ok(M.coordinatorTidOf(FIXTURE, 'other', 40) === 1 && M.coordinatorTidOf(FIXTURE, 'proj', 40) === null, '폴더가 다르면 섞지 않는다');
}

// PC 전용 — 에이전트 행 트리(채팅 대화 포함)와 터미널 링크 찾기.
{
  const M = await import('file://' + path.join(PC, 'orch-model.js'));
  const snap = { ...FIXTURE, sessions: [
    { cwd: 'proj', tid: 1, agent: 'claude', state: 'working', since: 5 }, { cwd: 'proj', tid: 13, agent: 'claude', state: 'working', since: 1 },
    { cwd: 'proj', tid: 70, agent: 'codex', state: 'idle', since: 2, detail: '끝' }, { cwd: 'proj', tid: 71, agent: 'claude', state: 'permission', since: 3 },
    { cwd: 'proj', tid: null, threadId: 'th_b', chat: true, agent: 'claude', state: 'working', title: '채팅 B' },
    { cwd: 'proj', tid: null, threadId: 'th_a', chat: true, agent: 'claude', state: 'idle', title: '채팅 A', detail: '답' },
    { cwd: 'other', tid: 5, agent: 'claude', state: 'idle' }] };
  const rows = M.sessionTree(snap, 'proj');
  ok(JSON.stringify(rows.map((r) => r.key)) === '["s:1","s:70","s:71","c:th_a","c:th_b","r:r0","r:r4"]', '터미널(번호 순) → 채팅(ID 순) → 코디네이터를 못 찾은 묶음. 워커 터미널(13)은 최상위에 없다', JSON.stringify(rows.map((r) => r.key)));
  const co = rows[0];
  ok(co.runIds[0] === 'r1' && co.lead === '로그인 흐름 손보기' && co.children.length === 8 && co.glyph === 'working', '코디네이터 행 = 부모(제목은 목표 첫 줄, 워커가 자식)');
  ok(JSON.stringify(rows.slice(1, 5).map((r) => r.glyph)) === '["done","waiting","done","working"]', '표식: 끝난 글이 있으면 체크 · 승인 대기는 물음표 · 일하는 중은 고리');
  ok(rows[3].chat && rows[3].threadId === 'th_a' && rows[3].lead === '채팅 A' && rows[3].tid === null, '채팅 행은 대화 제목과 threadId 를 갖는다');
  ok(JSON.stringify(co.children.map((c) => c.glyph)) === '["done","waiting","working","failed","working","done","unverifiable","interrupted"]', '워커 표식', JSON.stringify(co.children.map((c) => c.glyph)));
  {
    const wt = (id, branch) => ({ kind: 'worker', dispatchId: id, placement: 'worktree', branch, taskId: branch ? 'tk_' + id : null });
    const g = M.worktreeGroups([{ children: [{ dispatchId: 'a', placement: 'current' }, wt('b', 'cpt/x-1'), wt('c', '')] }, { children: [wt('d', 'cpt/x-1'), wt('e', 'cpt/y-1')] }]);
    ok(JSON.stringify(g.map((x) => [x.key, x.branch, x.workers.map((c) => c.dispatchId).join('')])) === '[["b:cpt/x-1","cpt/x-1","bd"],["d:c","","c"],["b:cpt/y-1","cpt/y-1","e"]]',
      '작업 폴더 묶음: 다른 브랜치의 워커만 브랜치별로(같은 폴더 워커는 빼고, 브랜치를 아직 모르면 워커마다)', JSON.stringify(g));
    ok(M.inWorktree({ placement: 'worktree' }) && !M.inWorktree({ placement: 'current' }) && !M.inWorktree(null), '전용 작업 폴더 워커 판정');
  }
  ok(M.shortAgo(0, 5) === '' && M.shortAgo(1, 30001) === '<1m' && M.shortAgo(1, 5 * 60000 + 1) === '5m' && M.shortAgo(1, 3 * 3600000 + 1) === '3h' && M.shortAgo(1, 50 * 3600000) === '2d', '짧은 경과 시간');
  const L = await import('file://' + path.join(PC, 'term-links.js'));
  ok(L.findLinks('보기: https://a.io/x). (http://localhost:3000/a(b)) 끝').map((x) => x.text).join('|') === 'https://a.io/x|http://localhost:3000/a(b)', '주소: 끝 문장부호·문장의 괄호는 떼고 짝 맞는 괄호는 둔다');
  ok(L.findLinks('● Update(src/js/pane.js:120) ~/.codingpt/orch.json v1.2.3 a/b').map((x) => x.text).join('|') === 'src/js/pane.js:120|~/.codingpt/orch.json', '경로: 폴더+확장자가 있는 것만(버전·낱말 오탐 없음)');
  ok(L.findLinks('한글 https://a.io/path 뒤')[0].start === 3, '위치는 문자열 인덱스(셀 열 변환은 붙이는 쪽이 한다)');
  ok(JSON.stringify(L.splitPathLine('src/a.js:12:3')) === '{"path":"src/a.js","line":12}' && L.splitPathLine('file:///U/a%20b.js').path === '/U/a b.js', '경로:줄 분리 · file:// 해석');
}

// PC 전용 — 이슈 화면의 걸러 보기·묶기·정렬(issues-model.js).
{
  const I = await import('file://' + path.join(PC, 'issues-model.js'));
  const mk = (id, status, o = {}) => ({ id, number: o.n || 1, key: '#' + (o.n || 1), title: o.title || id, status, priority: o.pri || 'none', labels: o.labels || [], cwd: o.cwd || 'a', source: { provider: o.src || 'codingpt' }, updatedAt: o.at || 0 });
  const L = [mk('a', 'todo', { pri: 'low', at: 5 }), mk('b', 'todo', { pri: 'urgent', at: 1 }), mk('c', 'in_progress', { src: 'github', cwd: 'b', labels: ['bug'] }), mk('d', 'done', { at: 9 }), mk('e', 'in_review', { title: '로그인 리다이렉트' })];
  ok(I.filterIssues(L, {}).map((x) => x.id).join('') === 'abce', '기본은 완료를 숨긴다');
  ok(I.filterIssues(L, { done: true, source: 'github' }).map((x) => x.id).join('') === 'c' && I.filterIssues(L, { cwd: 'b' }).length === 1, '출처·워크스페이스로 거른다');
  ok(I.filterIssues(L, { q: '리다이' }).map((x) => x.id).join('') === 'e' && I.filterIssues(L, { q: 'BUG' }).map((x) => x.id).join('') === 'c', '검색은 제목·번호·라벨(대소문자 무시)');
  ok(JSON.stringify(I.groupByStatus(I.filterIssues(L, { done: true })).map((g) => [g.status, g.items.map((x) => x.id).join('')])) === '[["in_progress","c"],["in_review","e"],["todo","ba"],["done","d"]]', '묶음 순서 = 진행 중 → 리뷰 중 → 할 일 → 완료, 묶음 안은 우선순위 → 최근');
  ok(I.groupByStatus([], { order: I.STATUSES, keepEmpty: true }).length === 4, '보드는 빈 열도 그린다');
  ok(I.sortTable(L, 'priority', 1)[0].id === 'b' && I.sortTable(L, 'updatedAt', -1)[0].id === 'd' && I.sortTable(L, 'status', 1)[0].status === 'todo', '표 정렬');
  ok(JSON.stringify(I.sourceOptions(L, [{ provider: 'codingpt' }])) === '["all","codingpt","github"]' && I.openCount(L) === 4, '출처 선택지 · 열린 이슈 수');
}

// 규칙 자체(둘이 같이 틀리는 것 방지)
const r1 = pc.runs.find((x) => x[0] === 'r1');
ok(JSON.stringify(pc.runs.map((x) => x[0])) === '["r0","r1","r4"]', '그 폴더의 진행 중 묶음만, 오래된 것부터(닫힌 묶음·다른 폴더 제외)');
ok(r1[1] === '로그인 흐름 손보기', '제목 = 목표 첫 줄');
ok(JSON.stringify(r1[3]) === '["d1","d2","d3","d4","d6","d7","d8","d9"]', '터미널을 넘긴(transferred) 끝난 시도는 숨긴다 · 만든 순서');
ok(r1[2].dot === 'warn' && r1[2].counts.attention === 2 && r1[2].counts.failed === 1 && r1[2].counts.live === 2 && r1[2].counts.ok === 2 && r1[2].gates === 1, '합산: 확인 필요 > 실패 > 진행 > 완료', JSON.stringify(r1[2]));
ok(pc.other[0][1].dot === 'error', '확인 필요가 없고 실패가 있으면 error');
ok(pc.runs.find((x) => x[0] === 'r0')[2].dot === 'none', '전부 끝났으면 색 없음');
ok(pc.attn[0] === 3 && pc.attn[1] === 0 && pc.attn[2] === 0, '사람이 답할 것의 수 = 질문·멈춤 2 + 결정 1');
ok(JSON.stringify(pc.notes) === JSON.stringify([{ comment: '테스트 돌리는 중', status: 'in-progress' }, null, null]), '메모: 내용이 없으면 null');
const roles = new Map(pc.roles);
ok(roles.get('proj\n1').role === 'coordinator' && roles.get('proj\n1').dot === 'warn', '코디네이터 탭 = 묶음 합산 점');
ok(roles.get('proj\n13').role === 'worker', '워커이면서 하위 묶음 코디네이터인 터미널 → 워커가 이긴다');
ok(!roles.has('proj\n17') && !roles.has('proj\n9'), '정리된 워커·닫힌 묶음은 표식 없음');
ok(pc.long === 60, '긴 제목은 60자로 자른다');
ok(pc.dots.find((x) => x[0] === '??')[2] === 'wUnknown' && pc.dots.find((x) => x[0] === '??')[1] === 'none', '모르는 상태를 작업 중으로 접지 않는다');

// 문구 사전 — 앱의 필드는 전부 PC 에도 같은 원문으로 있어야 한다(기기마다 다른 말 금지).
const pcText = fs.readFileSync(path.join(PC, 'text/orch.js'), 'utf8');
const appText = fs.readFileSync(path.join(APP, 'text/orch.ts'), 'utf8');
const grab = (src) => {
  const out = {};
  const body = src.slice(src.indexOf('ko: {'));
  for (const m of body.matchAll(/^\s+(\w+):\s*(?:\([^)]*\)\s*=>\s*i18n\.t\()?(["'])((?:(?!\2)[^\\]|\\.)*)\2/gm)) out[m[1]] = m[3];
  return out;
};
const pt = grab(pcText), at = grab(appText);
const diff = Object.keys(at).filter((k) => pt[k] !== at[k]);
ok(Object.keys(at).length >= 50 && diff.length === 0, `문구 사전: 앱 ${Object.keys(at).length}개 필드가 PC 와 같은 원문`, diff.map((k) => `${k}: ${at[k]} / ${pt[k]}`).join(' | '));

console.log(fail ? `\nNOT CONFORMANT — pass ${pass} / fail ${fail}` : `\nALL CONFORMANT — pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
