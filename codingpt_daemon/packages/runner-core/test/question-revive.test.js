// question-revive(TUI 폴백 질문 재광고) 회귀 — 알림 되살리기의 계약을 고정한다.
//
// 배경(2026-07-28 사용자 확정): 데몬 재시작이 승인 배너를 회수해도, TUI 다이얼로그로 살아 있는
// 미응답 질문은 다시 광고되어야 한다("답 안 한 질문이 있으면 폰 알림도 정확히 1개").
// 여기서 조용히 틀리면: 배너 중복(멱등 깨짐) / 부분 답 증발 / 실패했는데 폰은 성공 표시.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-qr-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const approvals = require('../approvals');
const revive = require('../question-revive');

const QS = [
  { header: '계절', question: '좋아하는 계절은?', multiSelect: false, options: [{ label: '봄' }, { label: '겨울' }] },
  { header: '간식', question: '좋아하는 간식은?', multiSelect: true, options: [{ label: '과자' }, { label: '아이스크림' }] },
];
const CWD = 'other/project/proj';
const TID = 1000777;

let advertised; let retracted;
beforeEach(() => {
  approvals._reset();
  advertised = []; retracted = [];
  approvals.configure({
    advertise: async (payload) => { advertised.push(payload); return { ok: true }; },
    retract: async (id, reason) => { retracted.push({ id, reason }); },
    capCheck: () => true,
    noteHook: () => {},
    log: null,
  });
});

// ── toWire — 카드 응답 → 다이얼로그 조작 와이어(순수) ──
test('toWire: 라벨 → 1-based 번호, 자유입력 → text, 전 질문 필수', () => {
  const wire = revive._toWire(QS, [
    { questionIndex: 0, labels: ['겨울'] },
    { questionIndex: 1, labels: ['과자', '아이스크림'] },
  ]);
  assert.deepStrictEqual(wire, [
    { optionIndexes: [2], multiSelect: false, optionCount: 2 },
    { optionIndexes: [1, 2], multiSelect: true, optionCount: 2 },
  ]);
  const text = revive._toWire(QS, [
    { questionIndex: 0, labels: [], text: '가을' },
    { questionIndex: 1, labels: ['과자'] },
  ]);
  assert.deepStrictEqual(text[0], { optionIndexes: [], text: '가을', multiSelect: false, optionCount: 2 });
});

test('toWire: 답이 빠진 질문이 있으면 INCOMPLETE_ANSWERS (부분 답 조용한 증발 금지)', () => {
  assert.throws(() => revive._toWire(QS, [{ questionIndex: 0, labels: ['봄'] }]),
    (e) => e.code === 'INCOMPLETE_ANSWERS');
  // 트랜스크립트의 선택지에 없는 라벨(질문이 바뀜)도 같은 오류다 — 엉뚱한 번호를 누르면 안 된다.
  assert.throws(() => revive._toWire(QS, [
    { questionIndex: 0, labels: ['없는라벨'] }, { questionIndex: 1, labels: ['과자'] },
  ]), (e) => e.code === 'INCOMPLETE_ANSWERS');
});

// ── requestTui — 재광고 슬롯 ──
test('requestTui: 결정적 id 로 멱등(틱이 겹쳐도 광고 1건) + choice payload', async () => {
  const args = { cwdRel: CWD, tid: TID, sessionId: 's1', toolUseId: 'tu1', questions: QS, drive: async () => {} };
  const id1 = approvals.requestTui(args);
  const id2 = approvals.requestTui(args);
  assert.strictEqual(id1, id2, '같은 질문은 같은 id');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(advertised.length, 1, '광고는 1건');
  const p = advertised[0];
  assert.strictEqual(p.kind, 'choice');
  assert.strictEqual(p.tool, 'AskUserQuestion');
  assert.strictEqual(p.prompt.questions.length, 2, '클라 카드가 그릴 전체 질문');
  assert.strictEqual(p.cwd, CWD);
  assert.strictEqual(p.win, TID);
  assert.ok(approvals.tuiSlotFor(CWD, TID), '슬롯 조회 가능');
});

test('resolve(answer): 다이얼로그 조작 **성공 후에야** 해소된다', async () => {
  const driven = [];
  approvals.requestTui({ cwdRel: CWD, tid: TID, sessionId: 's1', toolUseId: 'tu1', questions: QS,
    drive: async (o) => { driven.push(o); } });
  await new Promise((r) => setTimeout(r, 10));
  const id = approvals.tuiSlotFor(CWD, TID).id;
  const r = await approvals.handle('approval.resolve', {
    id, decision: 'answer',
    answers: [{ questionIndex: 0, labels: ['겨울'] }, { questionIndex: 1, labels: ['과자'] }],
  });
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(driven.length, 1);
  assert.strictEqual(driven[0].decision, 'allow', 'answer 는 allow 로 승격(훅 경로와 동일 어휘)');
  assert.strictEqual(driven[0].answers[0].header, '계절', 'hydrate 로 원 질문이 붙는다');
  assert.strictEqual(approvals.tuiSlotFor(CWD, TID), null, '해소 후 슬롯 소멸');
});

test('resolve: 조작 실패면 throw 하고 슬롯을 유지한다(폰 카드가 남아 재시도)', async () => {
  let fail = true;
  approvals.requestTui({ cwdRel: CWD, tid: TID, sessionId: 's1', toolUseId: 'tu1', questions: QS,
    drive: async () => { if (fail) throw Object.assign(new Error('nope'), { code: 'QUESTION_NOT_ON_SCREEN' }); } });
  await new Promise((r) => setTimeout(r, 10));
  const id = approvals.tuiSlotFor(CWD, TID).id;
  await assert.rejects(
    () => approvals.handle('approval.resolve', { id, decision: 'answer', answers: [{ questionIndex: 0, labels: ['봄'] }] }),
    (e) => e.code === 'QUESTION_NOT_ON_SCREEN');
  assert.ok(approvals.tuiSlotFor(CWD, TID), '실패 후에도 슬롯 유지');
  fail = false;
  const r = await approvals.handle('approval.resolve', { id, decision: 'answer', answers: [{ questionIndex: 0, labels: ['봄'] }] });
  assert.strictEqual(r.resolved, true, '재시도 성공');
});

test('deny 는 조작(drive)으로 전달되고, cancelTui 는 배너까지 회수한다', async () => {
  const driven = [];
  approvals.requestTui({ cwdRel: CWD, tid: TID, sessionId: 's1', toolUseId: 'tuX', questions: QS,
    drive: async (o) => { driven.push(o); } });
  await new Promise((r) => setTimeout(r, 10));
  const id = approvals.tuiSlotFor(CWD, TID).id;
  await approvals.handle('approval.resolve', { id, decision: 'deny' });
  assert.strictEqual(driven[0].decision, 'deny');

  // 다이얼로그 소멸 시나리오 — 재광고 후 로컬에서 답함 → cancelTui → retract(배너 회수)까지.
  approvals.requestTui({ cwdRel: CWD, tid: TID, sessionId: 's1', toolUseId: 'tuY', questions: QS, drive: async () => {} });
  await new Promise((r) => setTimeout(r, 10));
  const slot = approvals.tuiSlotFor(CWD, TID);
  approvals.cancelTui(slot.id, 'dialog_gone');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(retracted.some((x) => x.id === slot.id), 'retract 로 폰 배너가 걷힌다');
  assert.strictEqual(approvals.tuiSlotFor(CWD, TID), null);
});

// ── 정리 — 대기 슬롯의 ref 타이머가 프로세스를 붙잡지 않게(approval-contract.test.js 와 동일 이유) ──
test('cleanup', () => {
  approvals._reset();
  assert.strictEqual(approvals.pendingCount(), 0);
});
