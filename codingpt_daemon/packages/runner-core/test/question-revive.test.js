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

// ── 권한 다이얼로그 되살리기(2026-07-29 — "채팅 카드 = TUI 화면의 미러") ─────────
const qRevive = require('../question-revive');

// 실캡처(claude 2.1.220, tokin 워크스페이스) — 명령 줄바꿈·❯ 마커·설명·잔상 대비 구조 그대로.
const PERM_SCREEN = `
⏺ Running 1 shell command…
  ⎿  $ rm /Users/u/other/project/tokin/approval-demo.txt && git -C
     /Users/u/other/project/tokin status --short

──────────────────────────────────────────────────────────────────────────────
 Bash command

   rm /Users/u/other/project/tokin/approval-demo.txt && git -C
   /Users/u/other/project/tokin status --short
   Remove the demo file and check repo is clean

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: git -C /Users/u/other/project/tokin status --short
 ❯ 3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

test('권한 파서 — 실캡처에서 제목/명령/선택지를 화면 문구 그대로 뽑는다', () => {
  const p = qRevive._parsePermissionDialog(PERM_SCREEN);
  assert.ok(p, '다이얼로그를 인식하지 못했다');
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.question.header, 'Bash command');
  assert.match(p.question.question, /rm \/Users\/u.*status --short/, '줄바꿈된 명령이 이어붙어야 한다');
  assert.match(p.question.question, /Remove the demo file/);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].label, 'Yes');
  assert.match(p.options[1].label, /^Yes, and don.t ask again for: git -C/);
  assert.strictEqual(p.options[2].label, 'No', '❯ 마커가 붙은 옵션도 인식해야 한다');
  assert.ok(p.key.startsWith('perm|'));
});

test('권한 파서 — 질문 다이얼로그/일반 화면은 건드리지 않는다', () => {
  assert.strictEqual(qRevive._parsePermissionDialog('그냥 셸 출력\n$ ls\n'), null);
  assert.strictEqual(qRevive._parsePermissionDialog('Do you want to proceed?\n 1. Yes\n 2. No'), null,
    'Esc to cancel 푸터가 없으면(잔상) 라이브 다이얼로그가 아니다');
});

test('권한 매핑 — 라벨→번호, 라벨 없는 allow/deny 는 Yes/No 로', () => {
  const opts = qRevive._parsePermissionDialog(PERM_SCREEN).options;
  const pick = qRevive._pickForOutcome;
  assert.strictEqual(pick(opts, { decision: 'allow', answers: [{ questionIndex: 0, labels: [opts[1].label] }] }), 2,
    '"don\'t ask again" 라벨을 고르면 2를 눌러야 한다');
  assert.strictEqual(pick(opts, { decision: 'allow' }), 1, '라벨 없는 allow(잠금화면 허용) = Yes');
  assert.strictEqual(pick(opts, { decision: 'deny' }), 3, '라벨 없는 deny = No(Esc 는 턴 취소라 금지)');
  assert.strictEqual(pick(opts, { decision: 'allow', answers: [{ questionIndex: 0, labels: ['없는 라벨'] }] }), null);
});

test('권한 조작 — 숫자키 1번으로 끝난다(실측 프로토콜) + 안전장치', async () => {
  const cptServer = require('../cpt-server');
  const keys = [];
  let screen = PERM_SCREEN;
  const io = {
    screen: async () => screen,
    key: async (k) => { keys.push(k); screen = '$ (셸 프롬프트)'; }, // 한 키에 다이얼로그 소멸
    sleep: async () => {},
  };
  const r = await cptServer._drivePermissionDialog(io, { pick: 2, expect: 'rm /Users/u' });
  assert.deepStrictEqual(keys, ['2'], 'Enter 없이 숫자키 한 번이어야 한다(실측)');
  assert.strictEqual(r.ok, true);

  // 다이얼로그 없음 → 키를 절대 치지 않는다(숫자가 셸에 타이핑되는 사고 방지).
  await assert.rejects(
    cptServer._drivePermissionDialog({ screen: async () => '$ ls', key: async () => { throw new Error('쳤다'); }, sleep: async () => {} }, { pick: 1 }),
    (e) => e.code === 'QUESTION_NOT_ON_SCREEN',
  );
  // 다른 명령의 다이얼로그 → 오조작 방지.
  await assert.rejects(
    cptServer._drivePermissionDialog({ screen: async () => PERM_SCREEN, key: async () => {}, sleep: async () => {} }, { pick: 1, expect: '완전히 다른 명령' }),
    (e) => e.code === 'QUESTION_MISMATCH',
  );
});

test('권한 재광고 왕복 — 카드(선택지 그대로) → 라벨 응답 → drive 번호 전달', async () => {
  const perm = qRevive._parsePermissionDialog(PERM_SCREEN);
  const driven = [];
  approvals.requestTui({
    cwdRel: CWD, tid: TID, sessionId: null, toolUseId: null,
    dedupeKey: perm.key, revKind: 'perm', tool: perm.tool, summary: perm.summary,
    questions: [perm.question],
    drive: async (o) => { driven.push(qRevive._pickForOutcome(perm.options, o)); },
  });
  await new Promise((r) => setTimeout(r, 10));
  const slot = approvals.tuiSlotFor(CWD, TID);
  assert.ok(slot, '권한 슬롯이 광고돼야 한다');
  assert.strictEqual(slot.meta.revKind, 'perm');
  assert.strictEqual(slot.payload.tool, 'Bash');
  assert.strictEqual(slot.payload.prompt.questions[0].options.length, 3, 'TUI 선택지 3개가 그대로 실려야 한다');
  await approvals.handle('approval.resolve', {
    id: slot.id, decision: 'answer', answers: [{ questionIndex: 0, labels: [perm.options[1].label] }],
  });
  assert.deepStrictEqual(driven, [2], '카드에서 2번 라벨을 고르면 TUI 에 2를 눌러야 한다');
});

// ── 정리 — 대기 슬롯의 ref 타이머가 프로세스를 붙잡지 않게(approval-contract.test.js 와 동일 이유) ──
test('cleanup', () => {
  approvals._reset();
  assert.strictEqual(approvals.pendingCount(), 0);
});
