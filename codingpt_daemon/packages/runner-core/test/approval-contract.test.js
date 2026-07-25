// 승인 왕복 **계약** 회귀 테스트 — back 이 실제로 보내는 body 형태로만 검증한다.
//
// 왜 별도 파일인가:
//  approvals.test.js 는 데몬 단독 동작을 검증한다. 그런데 이 라운드에서 실제로 터진 버그는
//  "두 리포가 각자 정상인데 어휘가 달라서 기능이 죽는" 유형이었다 —
//   ① back 은 { decision:'answer', answer:{questionIndex,labels} } 를 보내는데 데몬은 allow|deny 만
//      인정해 defer 로 접었다 → 폰은 200(성공)을 받고 PC 는 TUI 로 다시 물었다. 선택형 전량 유실.
//   ② 데몬의 ALREADY_RESOLVED 는 code 가 rpc 응답에서 버려져 back 이 409 대신 502 를 냈다 →
//      카드가 안 걷히고 클라의 "이미 응답됨" 분기가 발화하지 않았다.
//  둘 다 각 리포의 단위 테스트를 통과했으므로, 계약은 이렇게 **상대가 보내는 형태**로 고정해야 한다.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-aprc-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const approvals = require('../approvals');

const CWD = 'other/project/proj';
const TID = 1000123;
const RESOLVED = { cwdRel: CWD, windowIndex: TID };

let advertised;
beforeEach(() => {
  approvals._reset();
  advertised = [];
  approvals.configure({
    advertise: async (payload) => { advertised.push(payload); return { ok: true }; },
    retract: async () => {},
    capCheck: () => true,          // serverCaps 게이트 통과(로컬 검증)
    noteHook: () => {},
    log: null,
  });
});

// AskUserQuestion 실측 payload(claude 2.1.220) — 선택지가 tool_input 에 그대로 온다.
const ASK = {
  agent: 'claude',
  sessionId: 'sess-A',
  toolName: 'AskUserQuestion',
  toolInput: {
    questions: [{
      question: 'Do you prefer apple or banana?',
      header: 'Fruit',
      options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana', description: 'Sweet' }],
      multiSelect: false,
    }],
  },
};

test('선택형 — back 이 보내는 {decision:"answer", answer:{...}} 를 소화한다', async () => {
  const p = approvals.request({ ...ASK, cwdRel: CWD, tid: TID }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  const id = advertised[0].id;

  // ★ back 의 실제 body 형태 — labels 는 배열, header 없음, questionIndex 만 있다.
  await approvals.handle('approval.resolve', {
    id, decision: 'answer', answer: { questionIndex: 0, labels: ['Banana'], text: '' }, by: 'phone',
  });

  const r = await p;
  assert.strictEqual(r.decision, 'allow', `answer 는 결정으로 승격돼야 한다 (실제: ${r.decision}/${r.reason})`);
  assert.ok(r.hookOutput, 'hookOutput 이 null 이면 훅이 무출력으로 끝나 PC 가 다시 묻는다');
  const d = r.hookOutput.hookSpecificOutput.decision;
  assert.strictEqual(d.behavior, 'deny', '선택형은 deny+message 로 답을 전달한다(실측 규약)');
  assert.match(d.message, /^\[CodingPT 원격응답\] /);
  assert.match(d.message, /Banana/);
  // ★ questionIndex → header 하이드레이션: "- 답:" 이 아니라 "- Fruit:" 이어야 한다.
  assert.match(d.message, /- Fruit: Banana/,
    `질문 헤더가 채워져야 한다 — 질문이 여러 개면 어느 답인지 알 수 없다. 실제: ${JSON.stringify(d.message)}`);
});

test('선택형 multiSelect — 라벨 복수를 그대로 전달', async () => {
  const p = approvals.request({
    ...ASK,
    toolInput: { questions: [{ question: '무엇을?', header: '작업', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] },
    cwdRel: CWD, tid: TID,
  }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  await approvals.handle('approval.resolve', {
    id: advertised[0].id, decision: 'answer', answer: { questionIndex: 0, labels: ['A', 'B'] },
  });
  const r = await p;
  assert.match(r.hookOutput.hookSpecificOutput.decision.message, /- 작업: A, B/);
});

test('선택형 자유 입력 — text 를 그대로 전달', async () => {
  const p = approvals.request({ ...ASK, cwdRel: CWD, tid: TID }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  await approvals.handle('approval.resolve', {
    id: advertised[0].id, decision: 'answer', answer: { questionIndex: 0, labels: [], text: '둘 다 싫어' },
  });
  const r = await p;
  assert.match(r.hookOutput.hookSpecificOutput.decision.message, /둘 다 싫어/);
});

test('권한형 allow/deny 는 그대로 (선택형 승격이 권한형을 오염시키지 않는다)', async () => {
  const mk = () => approvals.request(
    { agent: 'claude', sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls -la' }, cwdRel: CWD, tid: TID },
    RESOLVED, null,
  );
  let p = mk();
  await new Promise((r) => setTimeout(r, 10));
  await approvals.handle('approval.resolve', { id: advertised[0].id, decision: 'allow' });
  let r = await p;
  assert.strictEqual(r.hookOutput.hookSpecificOutput.decision.behavior, 'allow');
  assert.strictEqual(r.hookOutput.hookSpecificOutput.decision.message, undefined);

  advertised = [];
  p = mk();
  await new Promise((r2) => setTimeout(r2, 10));
  await approvals.handle('approval.resolve', { id: advertised[0].id, decision: 'deny', message: '위험함' });
  r = await p;
  assert.strictEqual(r.hookOutput.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(r.hookOutput.hookSpecificOutput.decision.message, /위험함/);
});

test('canceled 등 미지의 decision 은 결정으로 승격되지 않는다(무출력)', async () => {
  for (const bad of ['canceled', 'expired', 'ask', '']) {
    approvals._reset(); advertised = [];
    approvals.configure({ advertise: async (x) => { advertised.push(x); return { ok: true }; }, retract: async () => {}, capCheck: () => true, noteHook: () => {}, log: null });
    const p = approvals.request({ ...ASK, cwdRel: CWD, tid: TID }, RESOLVED, null);
    await new Promise((r) => setTimeout(r, 10));
    await approvals.handle('approval.resolve', { id: advertised[0].id, decision: bad }).catch(() => {});
    const r = await p;
    assert.strictEqual(r.decision, 'defer', `'${bad}' 는 defer 여야 한다`);
    assert.strictEqual(r.hookOutput, null, `'${bad}' 에서 훅이 출력을 내면 안 된다`);
  }
});

test('중복 응답은 ALREADY_RESOLVED code 를 단다 (back 이 409 로 접는 근거)', async () => {
  const p = approvals.request({ ...ASK, cwdRel: CWD, tid: TID }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  const id = advertised[0].id;
  await approvals.handle('approval.resolve', { id, decision: 'answer', answer: { questionIndex: 0, labels: ['Apple'] } });
  await p;
  await assert.rejects(
    approvals.handle('approval.resolve', { id, decision: 'allow' }),
    (e) => {
      assert.strictEqual(e.code, 'ALREADY_RESOLVED',
        'code 가 없으면 back 이 한글 메시지를 정규식으로 맞춰야 하고 문구가 바뀌면 502 로 떨어진다');
      return true;
    },
  );
});

test('광고 payload — back 화이트리스트를 통과하는 prompt/relPath 를 싣는다', async () => {
  approvals.request({ ...ASK, cwdRel: CWD, tid: TID }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  const p = advertised[0];
  assert.ok(p.prompt, 'prompt 가 없으면 back normalizeCreate 가 버려 클라가 선택 UI 를 못 그린다');
  assert.strictEqual(p.prompt.kind, 'choice');
  assert.ok(Array.isArray(p.prompt.questions) && p.prompt.questions.length === 1);
  assert.strictEqual(p.prompt.questions[0].header, 'Fruit');
  assert.ok(Array.isArray(p.prompt.questions[0].options));

  // 파일 대상 도구는 relPath 를 실어 푸시 본문이 명령 원문 대신 경로를 쓰게 한다.
  approvals._reset(); advertised = [];
  approvals.configure({ advertise: async (x) => { advertised.push(x); return { ok: true }; }, retract: async () => {}, capCheck: () => true, noteHook: () => {}, log: null });
  approvals.request({
    agent: 'claude', sessionId: 's', toolName: 'Write',
    toolInput: { file_path: path.join(os.homedir(), CWD, 'src/a.js') }, cwdRel: CWD, tid: TID,
  }, RESOLVED, null);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(advertised[0].relPath, 'relPath 가 있어야 잠금화면에 파일명이 보인다');
  assert.match(advertised[0].relPath, /a\.js$/);
});

test('Bash summary 는 값 단위로 시크릿을 지운다 (잠금화면·DB 유출 차단)', async () => {
  const cases = [
    ['export API_KEY=sk-abcdefghijklmnop && npm run build', /sk-abcdef/],
    ['curl -H "Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAA" x', /ghp_AAAA/],
    ['PGPASSWORD=hunter2 psql -h db', /hunter2/],
    ['git clone https://user:s3cr3t@github.com/x/y', /s3cr3t/],
  ];
  for (const [cmd, leak] of cases) {
    approvals._reset(); advertised = [];
    approvals.configure({ advertise: async (x) => { advertised.push(x); return { ok: true }; }, retract: async () => {}, capCheck: () => true, noteHook: () => {}, log: null });
    approvals.request({ agent: 'claude', sessionId: 's', toolName: 'Bash', toolInput: { command: cmd }, cwdRel: CWD, tid: TID }, RESOLVED, null);
    await new Promise((r) => setTimeout(r, 10));
    assert.doesNotMatch(advertised[0].summary, leak,
      `시크릿이 summary 로 나갔다: ${advertised[0].summary}`);
  }
});
