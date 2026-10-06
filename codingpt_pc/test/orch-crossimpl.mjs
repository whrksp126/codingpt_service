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
