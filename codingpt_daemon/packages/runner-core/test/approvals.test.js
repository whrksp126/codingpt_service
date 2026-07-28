// 원격 승인 왕복(기능1) 회귀 테스트 — 데몬 종단.
//
// 이 기능의 최악 회귀는 딱 두 가지고, 둘 다 사용자 신뢰를 즉시 파괴한다:
//  ① **자동 허용** — 우리가 사용자를 대신해 allow 를 낸다(오류·타임아웃·서버 장애 경로 포함).
//  ② **claude 영구 정지** — 훅이 결정을 못 받고도 계속 매달려 터미널이 죽은 것처럼 보인다.
// 따라서 모든 실패 경로가 `decision:'defer' + hookOutput:null`(= 훅 무출력 = 평소처럼 TUI 가 물어봄)
// 로 끝나는지, 그리고 결정이 **정확히 한 번만** 소비되는지를 집중적으로 본다.
//
// back/control 없이 돈다 — approvals.configure() 로 광고/회수/cap 을 주입한다.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-approval-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const approvals = require('../approvals');

const CTX = { cwdRel: 'other/project/proj', windowIndex: 1000123 };
const BASH = { agent: 'claude', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, sessionId: 'sess-A', toolUseId: 'toolu_1' };
const ASK = {
  agent: 'claude', toolName: 'AskUserQuestion', sessionId: 'sess-A', toolUseId: 'toolu_2',
  toolInput: {
    questions: [{
      question: 'Do you prefer apple or banana?', header: 'Fruit', multiSelect: false,
      options: [{ label: 'Apple', description: 'Crisp.' }, { label: 'Banana', description: 'Sweet.' }],
    }],
  },
};

let advertised;
let retracted;
let capOk;
const ENV_KEYS = ['CPT_APPROVAL', 'CPT_APPROVAL_TIMEOUT_SEC', 'CPT_APPROVAL_CAP_GATE', 'CPT_APPROVAL_CHOICE_TOOLS'];

beforeEach(() => {
  approvals._reset();
  for (const k of ENV_KEYS) delete process.env[k];
  advertised = [];
  retracted = [];
  capOk = true;
  approvals.configure({
    advertise: async (p) => { advertised.push(p); return { id: p.id }; },
    retract: async (id, reason) => { retracted.push({ id, reason }); return {}; },
    capCheck: () => capOk,
    noteHook: () => {},
    log: null,
  });
});

after(() => { approvals._reset(); });

// 광고가 끝난(=pending 등록 완료) 시점까지 기다린다 — request() 는 결정까지 resolve 하지 않으므로
//  advertise 호출을 폴링해 "대기 상태 진입"을 관측한다.
async function waitAdvertised(n = 1) {
  for (let i = 0; i < 200 && advertised.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(advertised.length, n, `광고 ${n}건을 기대했으나 ${advertised.length}건`);
  return advertised[n - 1];
}

test('권한형 allow → hookOutput 은 behavior:allow (updatedInput 없음)', async () => {
  const p = approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  assert.match(ad.id, /^apr_/);
  assert.strictEqual(ad.kind, 'permission');
  assert.strictEqual(ad.summary, 'rm -rf build');
  assert.strictEqual(ad.win, CTX.windowIndex);
  assert.strictEqual(ad.cwd, CTX.cwdRel);
  assert.ok(ad.deadlineAt > ad.requestedAt);

  const r2 = await approvals.handle('approval.resolve', { id: ad.id, decision: 'allow', by: { kind: 'mobile', deviceId: 42 } });
  assert.deepStrictEqual(r2, { resolved: true, id: ad.id, decision: 'allow' });

  const res = await p;
  assert.strictEqual(res.decision, 'allow');
  assert.deepStrictEqual(res.hookOutput, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.strictEqual(retracted.length, 0, 'back 발신 resolve 는 back 이 이미 안다 — 취소 통보 금지');
  assert.strictEqual(approvals.pendingCount(), 0);
});

test('권한형 deny → behavior:deny + 원격응답 접두어가 붙은 이유', async () => {
  const p = approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  await approvals.handle('approval.resolve', { id: ad.id, decision: 'deny', message: '위험해 보여서 거절' });
  const res = await p;
  const d = res.hookOutput.hookSpecificOutput.decision;
  assert.strictEqual(d.behavior, 'deny');
  assert.ok(d.message.startsWith(approvals.ANSWER_PREFIX), `접두어 필수: ${d.message}`);
  assert.match(d.message, /위험해 보여서 거절/);
});

test('선택형(AskUserQuestion) → deny + 고른 label 을 message 로 조립', async () => {
  const p = approvals.request(ASK, CTX, null);
  const ad = await waitAdvertised();
  // 폰이 선택 버튼을 그릴 재료가 그대로 실려야 한다(실측: tool_input 에 전부 온다).
  assert.strictEqual(ad.kind, 'choice');
  assert.strictEqual(ad.questions[0].header, 'Fruit');
  assert.deepStrictEqual(ad.questions[0].options.map((o) => o.label), ['Apple', 'Banana']);

  await approvals.handle('approval.resolve', {
    id: ad.id, decision: 'allow',
    answers: [{ header: 'Fruit', labels: ['Banana'] }],
  });
  const res = await p;
  const d = res.hookOutput.hookSpecificOutput.decision;
  assert.strictEqual(d.behavior, 'deny', '선택형은 allow 로 답을 전달할 수 없다 — deny+message 가 정답(실측)');
  assert.ok(d.message.startsWith(approvals.ANSWER_PREFIX));
  assert.match(d.message, /Fruit: Banana/);
});

test('선택형 multiSelect → 라벨 복수, 자유 입력 → 그 텍스트', async () => {
  const p1 = approvals.request(ASK, CTX, null);
  const a1 = await waitAdvertised(1);
  await approvals.handle('approval.resolve', { id: a1.id, decision: 'allow', answers: [{ header: 'Fruit', labels: ['Apple', 'Banana'] }] });
  assert.match((await p1).hookOutput.hookSpecificOutput.decision.message, /Fruit: Apple, Banana/);

  const p2 = approvals.request(ASK, CTX, null);
  const a2 = await waitAdvertised(2);
  await approvals.handle('approval.resolve', { id: a2.id, decision: 'allow', answers: [{ header: 'Fruit', text: '둘 다 싫고 포도' }] });
  assert.match((await p2).hookOutput.hookSpecificOutput.decision.message, /Fruit: 둘 다 싫고 포도/);
});

// ★ 질문이 **여러 개**인 경우(실측: 한 번에 4개까지 왔다). 첫 답만 전달하면 claude 는 나머지를
//  못 받은 채 턴을 끝낸다 — 사용자가 실제로 겪은 증상("4개 물었는데 1개만 답하니 바로 완료").
//  questionIndex 만 오는 back 경로도 함께 고정한다(hydrateAnswers 가 원 질문의 header 를 채운다).
const ASK4 = {
  agent: 'claude', toolName: 'AskUserQuestion', sessionId: 'sess-A', toolUseId: 'toolu_4q',
  toolInput: {
    questions: [
      { question: 'Q1?', header: '겨울 활동', multiSelect: false, options: [{ label: '겨울 스포츠' }, { label: '휴식' }] },
      { question: 'Q2?', header: '집중 시간', multiSelect: false, options: [{ label: '아침' }, { label: '밤' }] },
      { question: 'Q3?', header: '계획 성향', multiSelect: false, options: [{ label: '계획파' }, { label: '즉흥파' }] },
    ],
  },
};

test('질문 4개 — 답을 전부 모아 한 번에 전달한다(첫 답만 보내던 회귀)', async () => {
  const p = approvals.request(ASK4, CTX, null);
  const ad = await waitAdvertised();
  assert.strictEqual(ad.questions.length, 3, '선택지 재료는 질문 전부가 실려야 한다');
  // back 은 대역폭을 아끼려 questionIndex 만 보낸다 — 데몬이 원 질문의 header 를 채워야 한다.
  await approvals.handle('approval.resolve', {
    id: ad.id, decision: 'answer',
    answers: [
      { questionIndex: 0, labels: ['겨울 스포츠'] },
      { questionIndex: 1, labels: ['밤'] },
      { questionIndex: 2, labels: ['즉흥파'] },
    ],
  });
  const msg = (await p).hookOutput.hookSpecificOutput.decision.message;
  assert.match(msg, /겨울 활동: 겨울 스포츠/);
  assert.match(msg, /집중 시간: 밤/);
  assert.match(msg, /계획 성향: 즉흥파/, '세 번째 답이 빠지면 claude 가 그 질문을 미답으로 끝낸다');
});

test('선택형 거절도 deny+message (거절이 답으로 전달된다)', async () => {
  const p = approvals.request(ASK, CTX, null);
  const ad = await waitAdvertised();
  await approvals.handle('approval.resolve', { id: ad.id, decision: 'deny', message: '나중에 물어봐' });
  const d = (await p).hookOutput.hookSpecificOutput.decision;
  assert.strictEqual(d.behavior, 'deny');
  assert.match(d.message, /거절했습니다: 나중에 물어봐/);
});

test('하드 타임아웃 → defer + 무출력 + 카드 회수', async () => {
  process.env.CPT_APPROVAL_TIMEOUT_SEC = '1';
  const p = approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  const res = await p;                              // 1s 뒤 만료
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'timeout');
  assert.strictEqual(res.hookOutput, null, '만료 시 stdout 이 있으면 사용자를 대신해 결정하는 것이다');
  assert.deepStrictEqual(retracted, [{ id: ad.id, reason: 'timeout' }]);
  assert.strictEqual(approvals.pendingCount(), 0);
  // 만료 후 도착한 결정은 소비되지 않는다(늦은 탭으로 이중 실행 금지).
  await assert.rejects(() => approvals.handle('approval.resolve', { id: ad.id, decision: 'allow' }),
    (e) => e.code === 'ALREADY_RESOLVED');
});

test('폭주 가드 — 같은 (cwd,tid) 4번째부터 즉시 defer(광고조차 안 한다)', async () => {
  const held = [approvals.request(BASH, CTX, null), approvals.request(BASH, CTX, null), approvals.request(BASH, CTX, null)];
  await waitAdvertised(3);
  const res = await approvals.request(BASH, CTX, null);
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'flood');
  assert.strictEqual(res.hookOutput, null);
  assert.strictEqual(advertised.length, 3, '초과분은 서버/푸시로 나가지 않아야 한다');
  assert.strictEqual(approvals.MAX_PENDING_PER_PANE, 3);
  // 다른 터미널(tid)은 영향 없다 — 가드는 pane 단위다.
  approvals.request(BASH, { cwdRel: CTX.cwdRel, windowIndex: 999 }, null);
  await waitAdvertised(4);
  assert.strictEqual(held.length, 3);
});

test('소켓 close = 훅 프로세스 사망 → 즉시 defer + 카드 회수', async () => {
  const conn = new EventEmitter();
  const p = approvals.request(BASH, CTX, conn);
  const ad = await waitAdvertised();
  conn.emit('close');
  const res = await p;
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'hook_gone');
  assert.strictEqual(res.hookOutput, null);
  assert.deepStrictEqual(retracted, [{ id: ad.id, reason: 'hook_gone' }]);
  assert.strictEqual(approvals.pendingCount(), 0);
  // close 후 도착한 원격 결정은 무효 — 훅이 이미 죽었으므로 되살릴 수 없다.
  await assert.rejects(() => approvals.handle('approval.resolve', { id: ad.id, decision: 'allow' }),
    (e) => e.code === 'ALREADY_RESOLVED');
});

test('이미 끊긴 소켓으로 온 요청은 카드를 만들지 않는다', async () => {
  const conn = new EventEmitter();
  conn.destroyed = true;
  const res = await approvals.request(BASH, CTX, conn);
  assert.strictEqual(res.reason, 'hook_gone');
  assert.strictEqual(advertised.length, 0);
});

test('중복 응답 거부 — 두 기기가 동시에 눌러도 결정은 한 번만 소비된다', async () => {
  const p = approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  const first = await approvals.handle('approval.resolve', { id: ad.id, decision: 'allow', by: { kind: 'mobile' } });
  assert.strictEqual(first.decision, 'allow');
  await assert.rejects(() => approvals.handle('approval.resolve', { id: ad.id, decision: 'deny', by: { kind: 'pc' } }),
    (e) => e.code === 'ALREADY_RESOLVED');
  const res = await p;
  assert.strictEqual(res.decision, 'allow', '나중 결정이 앞선 결정을 덮으면 도구가 두 번 실행될 수 있다');
});

test('알 수 없는 decision 값은 결정으로 승격되지 않는다(canceled → defer)', async () => {
  const p = approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  await approvals.handle('approval.resolve', { id: ad.id, decision: 'canceled' });
  const res = await p;
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'canceled');
  assert.strictEqual(res.hookOutput, null);
});

test('킬스위치 CPT_APPROVAL=0 → 즉시 defer, 서버 접촉 0', async () => {
  process.env.CPT_APPROVAL = '0';
  const res = await approvals.request(BASH, CTX, null);
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'killswitch');
  assert.strictEqual(res.hookOutput, null);
  assert.strictEqual(advertised.length, 0);
  assert.strictEqual(approvals.pendingCount(), 0);
});

test('daemon.json approval.remote=false → 이 PC 만 기능 OFF', async () => {
  const cfgFile = path.join(runtime.stateDir(), 'daemon.json');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ serverUrl: 'http://x', approval: { remote: false } }));
  try {
    const res = await approvals.request(BASH, CTX, null);
    assert.strictEqual(res.reason, 'disabled');
    assert.strictEqual(advertised.length, 0);
  } finally { fs.unlinkSync(cfgFile); }
});

test('서버가 approval.v1 을 선언하지 않으면 기능 OFF(구 서버 안전)', async () => {
  capOk = false;
  const res = await approvals.request(BASH, CTX, null);
  assert.strictEqual(res.reason, 'no_server');
  assert.strictEqual(advertised.length, 0);
  assert.strictEqual(approvals.CAP, 'approval.v1');
});

test('광고 실패(back 장애) → 즉시 defer — 서버 장애로 에이전트를 세우지 않는다', async () => {
  approvals.configure({ advertise: async () => { throw new Error('HTTP 502'); } });
  const res = await approvals.request(BASH, CTX, null);
  assert.strictEqual(res.decision, 'defer');
  assert.strictEqual(res.reason, 'advertise_failed');
  assert.strictEqual(res.hookOutput, null);
  assert.strictEqual(retracted.length, 0, '만들어지지 않은 카드를 취소하면 안 된다');
  assert.strictEqual(approvals.pendingCount(), 0);
});

test('back 이 defer 를 지시하면(유저 상한) 훅은 즉시 폴백', async () => {
  approvals.configure({ advertise: async (p) => { advertised.push(p); return { defer: true }; } });
  const res = await approvals.request(BASH, CTX, null);
  assert.strictEqual(res.reason, 'server_defer');
  assert.strictEqual(res.hookOutput, null);
});

test('approval.list / resync — back 재시작 시 pending 을 되살린다', async () => {
  approvals.request(BASH, CTX, null);
  const ad = await waitAdvertised();
  const listed = await approvals.handle('approval.list', {});
  assert.strictEqual(listed.approvals.length, 1);
  assert.strictEqual(listed.approvals[0].id, ad.id);
  const r = await approvals.resync();
  assert.deepStrictEqual(r, { resynced: 1, failed: 0, total: 1 });
  assert.strictEqual(advertised.length, 2, '같은 id 로 재광고(멱등)');
});

test('세션 소멸 / 전체 취소 → 전부 defer', async () => {
  const p = approvals.request(BASH, CTX, null);
  await waitAdvertised();
  assert.strictEqual(approvals.cancelBySession('sess-A'), 1);
  const res = await p;
  assert.strictEqual(res.reason, 'session_gone');
  assert.strictEqual(res.hookOutput, null);

  const p2 = approvals.request(BASH, CTX, null);
  await waitAdvertised(2);
  assert.strictEqual(approvals.cancelAll(), 1);
  assert.strictEqual((await p2).decision, 'defer');
});

test('민감 키는 서버로 나가는 프리뷰에서 마스킹된다', async () => {
  approvals.request({ toolName: 'Write', toolInput: { file_path: '/x/.env', content: 'ok', apiKey: 'sk-live-123', nested: { password: 'p@ss' } } }, CTX, null);
  const ad = await waitAdvertised();
  const s = JSON.stringify(ad.inputPreview);
  assert.doesNotMatch(s, /sk-live-123/);
  assert.doesNotMatch(s, /p@ss/);
  assert.match(ad.summary, /\.env/);
});

test('예산 순서 불변식: 데몬 하드 < CLI 대기 < claude 훅 timeout', () => {
  process.env.CPT_APPROVAL_TIMEOUT_SEC = '120';
  const b = approvals.budget();
  assert.strictEqual(b.hardMs, 120000);
  assert.ok(b.cliWaitMs > b.hardMs, 'CLI 가 먼저 끊기면 데몬이 카드를 회수하지 못한다');
  assert.ok(b.hookTimeoutSec * 1000 > b.cliWaitMs, 'claude 가 먼저 끊기면 defer 를 우리가 제어할 수 없다');
});

// ── 소스 계약(다른 패키지가 배선을 되돌리는 것을 막는다) ─────────────────────
test('shim: PermissionRequest 만 approval-hook 으로, 나머지 6종은 무변경', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-apshim-'));
  const prev = { root: runtime.root(), stateDir: runtime.stateDir() };
  try {
    runtime.init({ root: iso, stateDir: path.join(iso, '.codingpt') });
    process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
    require('../shim').ensureShims();
    const hooks = JSON.parse(fs.readFileSync(path.join(iso, '.codingpt', 'shim', 'claude-hooks.json'), 'utf8')).hooks;
    assert.deepStrictEqual(Object.keys(hooks).sort(), [
      'Notification', 'PermissionRequest', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit',
    ], '훅 7종 유지');

    const h = hooks.PermissionRequest[0].hooks[0];
    assert.match(h.command, /approval-hook/, 'PermissionRequest 는 승인 훅으로 라우팅돼야 한다');
    assert.match(h.command, /--wait-ms \d+/, 'CLI 대기 상한은 shim 이 예산에서 파생해 넘긴다');
    assert.ok(!h.async, '승인 훅은 동기여야 결정을 stdout 으로 낼 수 있다');
    assert.ok(h.timeout * 1000 > approvals.budget().hardMs,
      'claude 훅 timeout 이 데몬 하드 타임아웃보다 작으면 claude 가 먼저 훅을 잘라 카드가 남는다');
    assert.ok(h.statusMessage, '대기 중 사용자에게 이유를 보여줘야 한다');

    // fire-and-forget 6종도 **절대경로**다(2026-07-29, approval-hook 과 동일 규칙) — 맨 이름 `cpt` 는
    //  PATH 조회라 전역 심링크(이제 옵션)에 묶이고 워킹트리 동명 실행파일에 가로채일 수 있다.
    const cptAbs = path.join(iso, '.codingpt', 'bin', 'cpt');
    for (const [ev, sub] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Notification', 'notification'],
      ['Stop', 'stop'], ['StopFailure', 'stop-failure'], ['SessionEnd', 'session-end']]) {
      assert.strictEqual(hooks[ev][0].hooks[0].command, `"${cptAbs}" claude-hook ${sub}`, `${ev} 는 절대경로 fire-and-forget 이어야 한다`);
      assert.strictEqual(hooks[ev][0].hooks[0].async, true, `${ev} 가 블로킹되면 claude 가 느려진다`);
    }
    // zdot(ZDOTDIR 체인)은 손대지 않는다 — mtime 이 바뀌면 healStaleTerminals 가 유휴 터미널을 전부 respawn 한다.
    const zlogin = fs.readFileSync(path.join(iso, '.codingpt', 'shim', 'zdot', '.zlogin'), 'utf8');
    assert.doesNotMatch(zlogin, /approval/i, 'zdot 에 승인 관련 배선을 넣지 말 것');
  } finally { runtime.init({ root: prev.root, stateDir: prev.stateDir }); }
});

test('cpt.js: approval-hook 은 어떤 경로에서도 exit 0 + stdout 계약 JSON 만', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js'), 'utf8');
  const i = src.indexOf('async function approvalHook');
  assert.ok(i > 0, 'approval-hook 구현이 있어야 한다');
  const block = src.slice(i, src.indexOf('function validApprovalOutput'));
  assert.doesNotMatch(block, /process\.exitCode/, '비-0 종료는 claude 가 훅 오류로 표시한다');
  assert.doesNotMatch(block, /\b(out|printJson|console\.log)\(/, 'stdout 은 결정 JSON 전용 — 한 글자라도 섞이면 계약 위반');
  assert.match(block, /CPT_APPROVAL === '0'/, '킬스위치를 유지해야 한다');
  // 상태 보고(hook.event)는 킬스위치보다 앞이어야 한다 — 승인을 껐다고 상태 감지가 죽으면 안 된다.
  assert.ok(block.indexOf("request('hook.event'") < block.indexOf("CPT_APPROVAL === '0'"),
    '킬스위치 OFF 에서도 기존 상태 보고는 그대로 살아 있어야 한다');
  assert.match(src, /c1 === 'approval-hook'/, 'main catch 가 승인 훅의 오류를 조용히 삼켜야 한다');
});

test('cpt.js validApprovalOutput: allow/deny 이외는 stdout 에 나가지 않는다', () => {
  const { validApprovalOutput } = require('../../cpt-cli/bin/cpt.js');
  const ok = (behavior, message) => validApprovalOutput({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, message } } });
  assert.strictEqual(ok('allow'), true);
  assert.strictEqual(ok('deny', '이유'), true);
  assert.strictEqual(ok('deny'), false, 'deny 는 message 가 필수(선택형 답 전달 경로)');
  assert.strictEqual(ok('ask'), false);
  assert.strictEqual(validApprovalOutput(null), false);
  assert.strictEqual(validApprovalOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', decision: { behavior: 'allow' } } }), false);
});
