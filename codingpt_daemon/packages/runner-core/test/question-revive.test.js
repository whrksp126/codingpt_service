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
  const bodyLines = p.question.question.split('\n');
  assert.match(bodyLines[0], /^rm \/Users\/u/, '첫 줄은 명령이어야 한다');
  assert.ok(bodyLines.some((l) => /Remove the demo file/.test(l)), '설명 줄이 별도 줄로 보존돼야 한다(TUI 와 같은 모양)');
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].label, 'Yes');
  assert.match(p.options[1].label, /^Yes, and don.t ask again for: git -C/);
  assert.strictEqual(p.options[2].label, 'No', '❯ 마커가 붙은 옵션도 인식해야 한다');
  assert.ok(p.key.startsWith('perm|'));
  assert.match(p.expect, /^rm \/Users\/u/, 'expect 는 화면 검증용 한 줄(명령 첫 줄)이어야 한다');
});

// codex 0.145 실캡처(2026-07-29 PTY) — 질문 아래에 본문($ 명령)이 오는 반대 구조.
const CODEX_SCREEN = `
• Running rm x.txt

 Would you like to run the following command?

 Environment: local

 $ rm x.txt

 › 1. Yes, proceed (y)
   2. Yes, and don't ask again for commands that start with \`rm x.txt\` (p)
   3. No, and tell Codex what to do differently (esc)

 Press enter to confirm or esc to cancel
`;

test('권한 파서(codex) — 질문 아래 본문·자체 문구·3옵션을 그대로 뽑는다', () => {
  const p = qRevive._parsePermissionDialog(CODEX_SCREEN);
  assert.ok(p, 'codex 다이얼로그를 인식하지 못했다');
  assert.strictEqual(p.tool, 'Bash');
  assert.strictEqual(p.question.header, 'Bash command');
  const bodyLines = p.question.question.split('\n');
  assert.ok(bodyLines.includes('$ rm x.txt'), '질문 아래 명령 줄이 본문에 있어야 한다');
  assert.strictEqual(p.options.length, 3);
  assert.match(p.options[0].label, /^Yes, proceed/);
  assert.match(p.options[1].label, /don.t ask again for commands that start with/);
  assert.match(p.options[2].label, /^No, and tell Codex/);
  // 매핑: 라벨 없는 allow/deny 폴백도 codex 문구에서 동작해야 한다(잠금화면 버튼 등).
  assert.strictEqual(qRevive._pickForOutcome(p.options, { decision: 'allow' }), 1);
  assert.strictEqual(qRevive._pickForOutcome(p.options, { decision: 'deny' }), 3);
});

test('권한 파서 — 질문 다이얼로그/일반 화면은 건드리지 않는다', () => {
  assert.strictEqual(qRevive._parsePermissionDialog('그냥 셸 출력\n$ ls\n'), null);
  // ⚠ 규칙 정정(2026-07-29 실사고): "푸터 없으면 잔상"은 오판이었다 — claude Fetch 다이얼로그는
  //  푸터가 없다. 잔상 판정은 "옵션 아래에 다른 출력이 쌓였는가"로 한다.
  assert.strictEqual(qRevive._parsePermissionDialog('Do you want to proceed?\n 1. Yes\n 2. No\n$ 이후 셸 출력'), null,
    '푸터 없는 다이얼로그는 화면 맨 아래일 때만 라이브다(아래에 출력 = 잔상)');
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
  // codex 화면도 같은 조작기로 동작해야 한다(문구만 다르고 프로토콜은 동일 — 실측).
  const ck = [];
  let cs = CODEX_SCREEN;
  const cr = await cptServer._drivePermissionDialog(
    { screen: async () => cs, key: async (k) => { ck.push(k); cs = '$ '; }, sleep: async () => {} },
    { pick: 1, expect: '$ rm x.txt' },
  );
  assert.deepStrictEqual(ck, ['1']);
  assert.strictEqual(cr.ok, true);
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
  assert.strictEqual(slot.payload.prompt.mirror, true,
    'mirror 표식이 없으면 클라가 질문 카드 부속(기타/건너뛰기/보내기)을 붙인다 — TUI 에 없는 것');
  assert.strictEqual(slot.payload.prompt.questions[0].options.length, 3, 'TUI 선택지 3개가 그대로 실려야 한다');
  await approvals.handle('approval.resolve', {
    id: slot.id, decision: 'answer', answers: [{ questionIndex: 0, labels: [perm.options[1].label] }],
  });
  assert.deepStrictEqual(driven, [2], '카드에서 2번 라벨을 고르면 TUI 에 2를 눌러야 한다');
});

// ── 추가 지시 텍스트(2026-07-29 실측 — TUI 인라인 입력의 채팅 동치) ──────────────
test('입력 가능 판별 — amend 는 Yes/No(always 계열 제외), interrupt 는 tell-differently 옵션만', () => {
  const can = qRevive._optionAcceptsInput;
  assert.strictEqual(can('amend', 'Yes'), true);
  assert.strictEqual(can('amend', 'No'), true);
  assert.strictEqual(can('amend', 'Yes, and always allow access to ptyperm/ from this project'), false,
    '실측: always allow 옵션은 타이핑이 무반응이다');
  assert.strictEqual(can('amend', "Yes, and don't ask again for: git status"), false);
  assert.strictEqual(can('interrupt', 'Yes, proceed (y)'), false, 'interrupt 다이얼로그의 Yes 엔 코멘트 경로가 없다');
  assert.strictEqual(can('interrupt', 'No'), false, '평범한 No 도 interrupt 에선 코멘트 경로가 없다');
  assert.strictEqual(can('interrupt', 'No, and tell Codex what to do differently (esc)'), true);
  assert.strictEqual(can('interrupt', 'No, and tell Claude what to do differently (esc)'), true);

  const p = qRevive._parsePermissionDialog(PERM_SCREEN);
  assert.strictEqual(p.flow, 'amend', '푸터의 "Tab to amend" 힌트 = 인라인 입력 지원(실측 근거)');
  assert.deepStrictEqual(p.question.options.map((o) => !!o.input), [true, false, true],
    '카드 옵션의 input 표식: Yes/No 만 입력창이 붙는다');
  const c = qRevive._parsePermissionDialog(CODEX_SCREEN);
  assert.strictEqual(c.flow, 'interrupt', 'Tab 힌트 없음 = interrupt flow(codex)');
  assert.deepStrictEqual(c.question.options.map((o) => !!o.input), [false, false, true]);
});

// claude 인라인 입력 드라이브 — 화살표 이동 → Tab(푸터에 있을 때만) → 타이핑 → Enter (실측 절차).
function mkClaudeDialog(hl, amended) {
  return [
    ' Bash command', '   rm x.txt', ' Do you want to proceed?',
    ` ${hl === 1 ? '❯' : ' '} 1. Yes`,
    ` ${hl === 2 ? '❯' : ' '} 2. Yes, and don't ask again for: rm x.txt`,
    ` ${hl === 3 ? '❯' : ' '} 3. No`,
    ` Esc to cancel${amended ? '' : ' · Tab to amend'} · ctrl+e to explain`,
  ].join('\n');
}

test('권한 조작(claude+텍스트) — 이동→Tab→타이핑→Enter, 옵션별 Tab 토글 존중', async () => {
  const cptServer = require('../cpt-server');
  const st = { hl: 1, amended: false, typed: '', closed: false };
  const keys = [];
  const io = {
    screen: async () => (st.closed ? '$ (셸)' : mkClaudeDialog(st.hl, st.amended)),
    key: async (k, literal) => {
      keys.push(k);
      if (k === 'Down') st.hl = Math.min(3, st.hl + 1);
      else if (k === 'Up') st.hl = Math.max(1, st.hl - 1);
      else if (k === 'Tab') st.amended = true;
      else if (k === 'Enter') st.closed = true;
      else if (literal) st.typed += k;
    },
    sleep: async () => {},
  };
  const r = await cptServer._drivePermissionDialog(io, { pick: 3, expect: 'rm x.txt', text: '대신 pwd 만 실행해', flow: 'amend' });
  assert.strictEqual(r.amended, true);
  assert.deepStrictEqual(keys, ['Down', 'Down', 'Tab', '대신 pwd 만 실행해', 'Enter'],
    '실측 절차: 하이라이트를 3으로 옮기고 Tab 으로 입력 모드를 켠 뒤 타이핑+Enter');
  assert.strictEqual(st.typed, '대신 pwd 만 실행해');
});

// codex 인터럽트 드라이브 — 숫자키(거절) → 다이얼로그 소멸 → 컴포저에 지시 타이핑+Enter (실측 절차).
test('권한 조작(codex+텍스트) — 숫자키 후 컴포저 주입', async () => {
  const cptServer = require('../cpt-server');
  const st = { closed: false, typed: '' };
  const keys = [];
  const io = {
    screen: async () => (st.closed ? '■ Conversation interrupted - tell the model what to do differently.\n› ' : CODEX_SCREEN),
    key: async (k, literal) => {
      keys.push(k);
      if (k === '3') st.closed = true;
      else if (literal && k !== '3') st.typed += k;
    },
    sleep: async () => {},
  };
  const r = await cptServer._drivePermissionDialog(io, { pick: 3, expect: '$ rm x.txt', text: '파일 지우지 말고 pwd 만', flow: 'interrupt' });
  assert.strictEqual(r.injected, true);
  assert.deepStrictEqual(keys, ['3', '파일 지우지 말고 pwd 만', 'Enter']);
});

test('권한 재광고 왕복 — 라벨+텍스트 응답이 drive 까지 온전히 전달된다', async () => {
  const perm = qRevive._parsePermissionDialog(PERM_SCREEN);
  const seen = [];
  approvals.requestTui({
    cwdRel: CWD, tid: TID, sessionId: null, toolUseId: null,
    dedupeKey: perm.key + '#txt', revKind: 'perm', tool: perm.tool, summary: perm.summary,
    questions: [perm.question],
    drive: async (o) => { seen.push(o); },
  });
  await new Promise((r) => setTimeout(r, 10));
  const slot = approvals.tuiSlotFor(CWD, TID);
  await approvals.handle('approval.resolve', {
    id: slot.id, decision: 'answer',
    answers: [{ questionIndex: 0, labels: ['No'], text: '대신 상태만 봐줘' }],
  });
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0].answers[0].labels, ['No']);
  assert.strictEqual(seen[0].answers[0].text, '대신 상태만 봐줘',
    '카드 입력창의 텍스트가 answers[].text 로 drive 까지 와야 한다');
});

// ── TUI 원문 표시(2026-07-29 사용자 확정: "TUI 에 나오는 건 다 채팅에도") ─────────
test('파서 — 질문 줄은 ask 로 분리, askFirst 가 화면 배치 순서를 보존한다', () => {
  const p = qRevive._parsePermissionDialog(PERM_SCREEN);
  assert.strictEqual(p.question.ask, 'Do you want to proceed?', '질문 줄은 ask 로(카드가 다른 스타일로 그린다)');
  assert.strictEqual(p.question.askFirst, false, 'claude: 본문 뒤에 질문 줄');
  assert.ok(!p.question.question.includes('Do you want to proceed?'), '본문에는 질문 줄이 중복되지 않는다');
  assert.match(p.expect, /^rm \/Users\/u/, 'expect 는 여전히 명령 줄(질문 줄이면 특이성이 없다)');
  const c = qRevive._parsePermissionDialog(CODEX_SCREEN);
  assert.strictEqual(c.question.ask, 'Would you like to run the following command?');
  assert.strictEqual(c.question.askFirst, true, 'codex: 질문 줄이 본문 앞');
});

const CMD_FULL = 'rm /Users/u/other/project/tokin/approval-demo.txt && git -C /Users/u/other/project/tokin status --short';

test('화면 보강 — 훅 카드 payload 에 TUI 원문(제목/본문/선택지+act)이 실리고 재광고된다', async () => {
  const cs = require('../cpt-server');
  const origCapture = cs.captureDialog;
  cs.captureDialog = async () => qRevive._parsePermissionDialog(PERM_SCREEN);
  try {
    const done = approvals.request(
      { toolName: 'Bash', toolInput: { command: CMD_FULL } },
      { cwdRel: CWD, windowIndex: TID }, null,
    );
    await new Promise((r) => setTimeout(r, 10));
    const id = advertised[0].id;
    const slot = approvals._slot(id);
    assert.ok(slot, '훅 슬롯이 있어야 한다');
    await approvals._enrichFromScreen(slot);
    const scr = slot.payload.prompt.screen;
    assert.ok(scr, '보강이 실려야 한다');
    assert.strictEqual(scr.title, 'Bash command', 'TUI 제목 원문');
    assert.strictEqual(scr.ask, 'Do you want to proceed?', '질문 줄은 ask 로(카드가 위계를 구분해 그린다)');
    assert.strictEqual(scr.askFirst, false);
    assert.deepStrictEqual(scr.options.map((o) => o.act), ['allow', 'always', 'deny']);
    assert.deepStrictEqual(scr.options.map((o) => !!o.input), [true, false, true], '옵션별 입력 가능 표식');
    assert.strictEqual(advertised.length, 2, '보강 후 멱등 재광고(내용 갱신)');

    // 다른 요청의 다이얼로그(내용 불일치)면 보강하지 않는다 — 카드가 거짓말하면 안 된다.
    const done2 = approvals.request(
      { toolName: 'Bash', toolInput: { command: 'echo 완전히-다른-명령' } },
      { cwdRel: CWD, windowIndex: TID + 1 }, null,
    );
    await new Promise((r) => setTimeout(r, 10));
    const slot2 = approvals._slot(advertised[2].id);
    await approvals._enrichFromScreen(slot2);
    assert.strictEqual(slot2.payload.prompt.screen, undefined, '불일치 다이얼로그로는 보강 금지');
    approvals._reset();
    await done; await done2;
  } finally {
    cs.captureDialog = origCapture;
  }
});

test('보강 카드 응답 — TUI 다이얼로그 조작 우선(always 는 2번 키 = codex 도 규칙 기록), 실패 시 훅 폴백', async () => {
  const cs = require('../cpt-server');
  const origCapture = cs.captureDialog;
  const origAnswer = cs.permissionAnswer;
  cs.captureDialog = async () => qRevive._parsePermissionDialog(PERM_SCREEN);
  const driven = [];
  cs.permissionAnswer = async (args) => { driven.push(args); return { ok: true }; };
  try {
    const done = approvals.request(
      { toolName: 'Bash', toolInput: { command: CMD_FULL } },
      { cwdRel: CWD, windowIndex: TID }, null,
    );
    await new Promise((r) => setTimeout(r, 10));
    const id = advertised[0].id;
    await approvals._enrichFromScreen(approvals._slot(id));
    await approvals.handle('approval.resolve', { id, decision: 'allow', always: true, by: 'phone' });
    assert.strictEqual(driven.length, 1);
    assert.strictEqual(driven[0].pick, 2, 'always = 화면 2번 옵션을 눌러 TUI 가 직접 규칙을 기록한다');
    assert.strictEqual(driven[0].flow, 'amend');
    const r = await done;
    assert.strictEqual(r.decision, 'defer');
    assert.strictEqual(r.reason, 'tui_driven', 'TUI 가 답을 처리했으므로 훅은 무출력');
    assert.strictEqual(r.hookOutput, null);

    // 조작 실패(다이얼로그 소멸) → 훅 출력 경로 폴백. 코멘트는 deny.message 로 전달된다.
    cs.permissionAnswer = async () => { throw Object.assign(new Error('없음'), { code: 'QUESTION_NOT_ON_SCREEN' }); };
    const done2 = approvals.request(
      { toolName: 'Bash', toolInput: { command: CMD_FULL } },
      { cwdRel: CWD, windowIndex: TID }, null,
    );
    await new Promise((r2) => setTimeout(r2, 10));
    const id2 = advertised[advertised.length - 1].id;
    await approvals._enrichFromScreen(approvals._slot(id2));
    await approvals.handle('approval.resolve', { id: id2, decision: 'deny', message: '대신 pwd 만', by: 'phone' });
    const r2 = await done2;
    assert.strictEqual(r2.decision, 'deny');
    assert.match(r2.hookOutput.hookSpecificOutput.decision.message, /대신 pwd 만/, '폴백은 기존 훅 출력(deny.message)');
  } finally {
    cs.captureDialog = origCapture;
    cs.permissionAnswer = origAnswer;
  }
});

test('act 매핑 — 화면 라벨 → 훅 응답 어휘(못 알아보면 null)', () => {
  const act = approvals._screenActOf;
  assert.strictEqual(act('Yes'), 'allow');
  assert.strictEqual(act('Yes, proceed (y)'), 'allow');
  assert.strictEqual(act("Yes, and don't ask again for example.com"), 'always');
  assert.strictEqual(act('Yes, and always allow access to ptyperm/ from this project'), 'always');
  assert.strictEqual(act('No'), 'deny');
  assert.strictEqual(act('No, and tell Claude what to do differently (esc)'), 'deny');
  assert.strictEqual(act('Maybe later'), null);
});

// ── 푸터 없는 다이얼로그(2026-07-29 실사고 — claude Fetch 는 "Esc to cancel" 푸터가 없다) ────
// 실캡처(claude 2.1.220, tokin): 훅 마감 후 미러가 이 다이얼로그를 영영 못 잡아 카드가 실종됐다.
const FETCH_SCREEN = `
⏺ Fetch(https://example.com)
────────────────────────────────────────────────────────────────────────────────────
 Fetch
   url: "https://example.com", prompt: "이 페이지의 제목과 본문 내용을 한 줄로
   요약해줘."
   Claude wants to fetch content from example.com

 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.com
   3. No, and tell Claude what to do differently (esc)
`;

test('푸터 없는 다이얼로그(Fetch) — 옵션 블록이 화면 맨 아래면 라이브로 인식한다', () => {
  const p = qRevive._parsePermissionDialog(FETCH_SCREEN);
  assert.ok(p, 'Fetch 다이얼로그를 인식해야 한다(실사고 회귀)');
  assert.strictEqual(p.title, 'Fetch');
  assert.strictEqual(p.tool, 'WebFetch');
  // 실측(2026-07-29): Fetch 다이얼로그는 Tab·타이핑 무반응(인라인 입력 없음), 3번 선택 →
  //  "Interrupted · What should Claude do instead?" → 컴포저 지시 전달. = interrupt flow 이고
  //  코멘트는 3번(tell … differently)에만 실을 수 있다 — 카드도 그 행에만 입력칸을 그린다.
  assert.strictEqual(p.flow, 'interrupt', 'Tab 힌트 없는 다이얼로그 = 인라인 입력 없음(실측)');
  assert.ok(p.question.question.includes('Claude wants to fetch content from example.com'), '회색 설명 줄');
  assert.strictEqual(p.question.ask, 'Do you want to allow Claude to fetch this content?', '질문 줄은 ask 로');
  assert.deepStrictEqual(p.question.options.map((o) => !!o.input), [false, false, true],
    '코멘트 입력칸은 TUI 가 실제로 받는 옵션에만(상황별 판별 — 항상 고정 아님)');
  assert.strictEqual(approvals._screenActOf(p.question.options[1].label), 'always');

  // 잔상: 옵션 아래에 다른 출력이 쌓였으면(= 살아 있는 다이얼로그가 아니면) 무시해야 한다.
  assert.strictEqual(qRevive._parsePermissionDialog(FETCH_SCREEN + '\n$ ls\nfoo.txt\n'), null,
    '푸터 없는 다이얼로그는 화면 맨 아래일 때만 라이브다');
});

test('푸터 없는 다이얼로그 — 드라이버도 조작할 수 있어야 한다(up 게이트가 푸터 비의존)', async () => {
  const cptServer = require('../cpt-server');
  const keys = [];
  let screen = FETCH_SCREEN;
  const io = { screen: async () => screen, key: async (k) => { keys.push(k); screen = '$ '; }, sleep: async () => {} };
  const r = await cptServer._drivePermissionDialog(io, { pick: 1, expect: 'url: "https://example.com"' });
  assert.deepStrictEqual(keys, ['1']);
  assert.strictEqual(r.ok, true);
});

// ── 정리 — 대기 슬롯의 ref 타이머가 프로세스를 붙잡지 않게(approval-contract.test.js 와 동일 이유) ──
test('cleanup', () => {
  approvals._reset();
  assert.strictEqual(approvals.pendingCount(), 0);
});
