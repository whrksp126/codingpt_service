// TUI statusline 미러(status-line.js) — 추출 규칙은 2026-07-30 라이브 tmux 캡처 원문이 정본.
//  (capture-pane -e 실측: claude = 구분선 뒤 statusLine 스크립트 출력 + 푸터, codex = › 아래 한 줄)
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-statusline-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const sl = require('../status-line');

// ── 실캡처 픽스처(ANSI 원문 — 2026-07-30 cpt-other-project-tokin 세션) ──
const RULE = '\x1b[38;5;244m───────────────────────────────────────────────────────────────';
const CLAUDE_STATUS = '\x1b[39m   \x1b[1m\x1b[36m◆ Opus 5 (1M context)\x1b[0m\x1b[38;5;246m  \x1b[32m█░░░░░░░░░░░ 15%\x1b[38;5;246m \x1b[90m146k/1.0M\x1b[38;5;246m  \x1b[2m5h\x1b[0m\x1b[38;5;246m \x1b[32m23%\x1b[39m';
const CLAUDE_FOOTER = '  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m';
const CLAUDE_FOOTER_INSERT = '  -- INSERT -- \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m';
const CODEX_STATUS = '  gpt-5.6-sol low · ~/other/project/tokin';
// 좁은 폭(48컬럼) 실캡처 — 2026-08-01 cpt-other-project-tokin. 푸터 한 행이 폭을 넘겨 Ink 가 감싸면
//  vim 표시의 닫는 `--` 만 다음 줄에 남는다. 이 꼬리가 채팅에 statusline 으로 새던 것이 사용자 신고.
const NARROW_STATUS = '\x1b[39m   \x1b[1m\x1b[36m◆ Opus 5 (1M context)\x1b[0m\x1b[38;5;246m  \x1b[32m███░░░░░░░░░ 31%\x1b[38;5;246m \x1b[90m31…\x1b[39m';
const NARROW_FOOTER = '  \x1b[38;5;246m-- INSERT\x1b[39m \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to  · ←…\x1b[39m';
const NARROW_TAIL = '  \x1b[38;5;246m--\x1b[39m';

function claudeScreen({ status = [CLAUDE_STATUS], footer = CLAUDE_FOOTER } = {}) {
  return [
    '  본문 답변 텍스트', '✻ Worked for 1m 24s', RULE, '❯ 디렉터리랑 git 브랜치도 다시 넣어줘', RULE,
    ...status, footer, '', '',
  ].join('\n');
}

test('claude: 구분선 뒤 statusline 원문(ANSI 그대로)을 뽑는다', () => {
  const r = sl._extract(claudeScreen(), 'claude');
  assert.deepStrictEqual(r, [CLAUDE_STATUS]);
});

test('claude: -- INSERT -- 변형 푸터도 statusline 과 분리된다', () => {
  const r = sl._extract(claudeScreen({ footer: CLAUDE_FOOTER_INSERT }), 'claude');
  assert.deepStrictEqual(r, [CLAUDE_STATUS]);
});

test('claude: 좁은 폭에서 감싸진 푸터 꼬리(--)는 미러하지 않는다', () => {
  const screen = [
    '  본문', RULE, '❯ ', RULE, NARROW_STATUS, NARROW_FOOTER, NARROW_TAIL, '',
  ].join('\n');
  assert.deepStrictEqual(sl._extract(screen, 'claude'), [NARROW_STATUS]);
});

test('claude: statusline 이 없어도 푸터 꼬리는 폴백에 섞이지 않는다', () => {
  const screen = ['  본문', RULE, '❯ ', RULE, NARROW_FOOTER, NARROW_TAIL, ''].join('\n');
  assert.deepStrictEqual(sl._extract(screen, 'claude'), [NARROW_FOOTER]);
});

test('claude: 멀티라인 커스텀 statusline 은 전부(최대 3줄) 미러', () => {
  const two = ['첫째 줄 git:main', '둘째 줄 ██░░ 40%'];
  const r = sl._extract(claudeScreen({ status: two }), 'claude');
  assert.deepStrictEqual(r, two);
});

test('claude: 커스텀 statusline 없음 → 푸터 줄 폴백(모드 정보)', () => {
  const r = sl._extract(claudeScreen({ status: [] }), 'claude');
  assert.deepStrictEqual(r, [CLAUDE_FOOTER]);
});

test('claude: 구분선이 없는 화면(다이얼로그 등) → null(이전 값 유지)', () => {
  assert.strictEqual(sl._extract('그냥 셸 출력\n$ ls\n', 'claude'), null);
});

test('codex: › 컴포저 아래 status_line 한 줄', () => {
  const screen = ['• 답변 텍스트', '› Find and fix a bug in @filename', CODEX_STATUS, ''].join('\n');
  assert.deepStrictEqual(sl._extract(screen, 'codex'), [CODEX_STATUS]);
});

test('codex: › 가 없으면 null', () => {
  assert.strictEqual(sl._extract('셸 출력\n$ ', 'codex'), null);
});

test('빈 화면/미지원 에이전트 → null', () => {
  assert.strictEqual(sl._extract('', 'claude'), null);
  assert.strictEqual(sl._extract(null, 'codex'), null);
});

// ── 모드 파싱(채팅 알약의 원천) — 라벨은 2026-08-01 격리 tmux 실측(claude 2.1.220) ──
test('모드: 푸터 라벨 5종을 id 로 판별한다', () => {
  const cases = [
    ['  -- INSERT --  ⏸ manual mode on · ← for agents', 'default'],
    ['  -- INSERT ⏵⏵ accept edits on (shift+tab to cycle) · ←…', 'acceptEdits'],
    ['  -- INSERT   ⏸ plan mode on (shift+tab to cycle) · ← for …', 'plan'],
    ['  \x1b[38;5;220m⏵⏵ auto mode on\x1b[39m (shift+tab to cycle)', 'auto'],
    ['  ⏵⏵ bypassing permissions (shift+tab to cycle)', 'bypassPermissions'],
  ];
  for (const [line, id] of cases) assert.strictEqual(sl.parseMode(line).id, id, line);
  assert.strictEqual(sl.parseMode('  ? for shortcuts'), null, '모드 라벨이 없으면 null');
});

test('모드: 커스텀 statusline 이 있어도 화면에서 모드를 뽑는다(푸터는 미러 대상 밖)', () => {
  const screen = claudeScreen({ status: [CLAUDE_STATUS], footer: CLAUDE_FOOTER_INSERT });
  assert.deepStrictEqual(sl._extract(screen, 'claude'), [CLAUDE_STATUS]);
  assert.strictEqual(sl.extractMode(screen, 'claude').id, 'auto');
  // claude 화면을 codex 규칙으로 읽으면 아무것도 안 나온다(에이전트별 원천이 완전히 다르다).
  assert.strictEqual(sl.extractMode(screen, 'codex'), null);
});

test('모드: 좁은 폭에서 감싸진 푸터에서도 라벨이 살아 있다(40컬럼 실측)', () => {
  const screen = ['본문', RULE, '❯ ', RULE, NARROW_STATUS, NARROW_FOOTER, NARROW_TAIL, ''].join('\n');
  assert.strictEqual(sl.extractMode(screen, 'claude').id, 'auto');
});

// ── 감시/emit — pty 를 목으로 갈아끼워 실제 poll 경로를 태운다 ──
const CWD = 'other/project/proj';
const TID = 1000777;

beforeEach(() => { sl.stop(); });
after(() => { sl.stop(); });

function mockTmux(getScreen) {
  const ptyLib = require('../pty');
  const orig = ptyLib.runTmux;
  ptyLib.runTmux = async (args) => {
    if (args[0] === 'capture-pane') return getScreen();
    return '';
  };
  return () => { ptyLib.runTmux = orig; };
}

test('watch → 즉시 1회 추출·emit, 같은 값이면 재emit 하지 않는다(dedupe)', async () => {
  let screen = claudeScreen();
  const restore = mockTmux(() => screen);
  const emitted = [];
  sl.setEmitter((chatId, lines) => emitted.push({ chatId, lines }));
  try {
    sl.watch('c_test1', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(emitted.length, 1, 'watch 직후 1회 emit');
    assert.deepStrictEqual(emitted[0], { chatId: 'c_test1', lines: [CLAUDE_STATUS] });
    const snap = await sl.snapshotFor('c_test1');
    assert.deepStrictEqual(snap.lines, [CLAUDE_STATUS], '스냅샷 = 캐시(재캡처·재emit 없음)');
    assert.strictEqual(snap.mode.id, 'auto', '스냅샷에 모드도 실린다(커스텀 statusline 이 있어도)');
    assert.strictEqual(emitted.length, 1, 'snapshotFor 는 emit 하지 않는다');
  } finally { restore(); sl.stop(); }
});

test('unwatch 후엔 폴링·emit 이 없다', async () => {
  const restore = mockTmux(() => claudeScreen());
  const emitted = [];
  sl.setEmitter((chatId, lines) => emitted.push(lines));
  try {
    sl.watch('c_test2', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    sl.unwatch('c_test2');
    const n = emitted.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(emitted.length, n, 'unwatch 후 추가 emit 없음');
    assert.strictEqual(sl._watches.size, 0);
  } finally { restore(); sl.stop(); }
});

test('shift+tab(CSI Z)이 입력 경로를 지나가면 3초 폴링을 기다리지 않고 즉시 다시 읽는다', async () => {
  // 사용자 요청(2026-08-02): "바꾸는 순간 바로" — 폴링은 놓쳤을 때의 안전망이고, 우리 터미널
  //  입력으로 지나가는 그 키는 즉시 확인한다. (Mac 터미널에서 직접 누른 건 폴링/캐치업이 잡는다.)
  const ptyLib = require('../pty');
  let screen = claudeScreen({ footer: CLAUDE_FOOTER });          // auto
  const restore = mockTmux(() => screen);
  const emitted = [];
  sl.setEmitter((chatId, lines, mode) => emitted.push(mode && mode.id));
  try {
    sl.watch('c_poke', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(emitted, ['auto']);
    const term = ptyLib.termSession(ptyLib.sessionForCwd(CWD).session, TID);
    // 화면이 plan 으로 바뀐 직후 그 키가 지나간다 → 폴링 주기(3s) 전에 emit 돼야 한다.
    screen = claudeScreen({ footer: '  -- INSERT -- ⏸ plan mode on (shift+tab to cycle)' });
    sl.onTerminalInput(term, Buffer.from('\x1b[Z'));
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(emitted, ['auto', 'plan'], '즉시 확인이 새 모드를 알린다(폴링 3s 전에)');
    await new Promise((r) => setTimeout(r, 500));   // 리페인트 보정용 2차 확인까지 소진시킨다
    // 다른 키/다른 터미널은 아무 일도 하지 않는다(폴링 폭주 방지).
    screen = claudeScreen({ footer: CLAUDE_FOOTER });
    sl.onTerminalInput(term, 'abc');
    sl.onTerminalInput('cpt-other--t-1', Buffer.from('\x1b[Z'));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(emitted, ['auto', 'plan'], '무관한 입력에는 재확인하지 않는다');
  } finally { restore(); sl.stop(); }
});

test('★ 제출 직후 burst 는 선택 화면을 폴링 주기(3s) 한참 전에 알린다', async () => {
  // 사용자 신고(2026-08-03): "채팅에서 /model 을 쳤는데 선택 UI 가 너무 늦게 뜬다".
  //  격리 tmux 실측: claude 는 제출(Enter) **51ms** 뒤에 이미 선택 화면을 그려 놨다 — 즉 CLI 는
  //  즉시였고 늦은 건 우리 3초 폴링뿐이었다. chatInput 이 제출 직후 burst 로 깨우는 것이 그 수정.
  const ptyLib = require('../pty');
  let screen = claudeScreen({ footer: CLAUDE_FOOTER });
  const restore = mockTmux(() => screen);
  const dialogs = [];
  sl.setEmitter((chatId, lines, mode, dialog) => dialogs.push(dialog && dialog.title));
  try {
    sl.watch('c_burst', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    const n0 = dialogs.length;
    const term = ptyLib.termSession(ptyLib.sessionForCwd(CWD).session, TID);
    // 제출 직후 화면에 선택 화면이 떴다고 치고 burst 를 건다.
    screen = [
      '  Select model', '  Switch between Claude models.', '',
      '❯ 1. Default (recommended)  Opus 5 with 1M context',
      '  2. Sonnet                 Sonnet 5 · Efficient for routine tasks',
      '', '  Esc to cancel', '',
    ].join('\n');
    sl.pokeTermSession(term, { burst: true });
    await new Promise((r) => setTimeout(r, 200));   // 첫 확인은 80ms — 3s 폴링과는 비교가 안 된다
    assert.deepStrictEqual(dialogs.slice(n0), ['Select model'], '제출 직후 200ms 안에 카드가 실린다');
    // 사라지면 null 을 실어 카드를 걷는다(같은 burst 안에서).
    screen = claudeScreen({ footer: CLAUDE_FOOTER });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(dialogs[dialogs.length - 1], null, '없어지면 null 로 걷힌다');
  } finally { restore(); sl.stop(); }
});

test('★ chatInput 이 제출 직후 그 터미널을 스스로 깨운다(배선 자체를 고정)', async () => {
  // 위 테스트는 burst 가 동작함을, 이건 **전송 경로가 실제로 burst 를 건다**는 것을 고정한다.
  //  (배선이 빠지면 화면 파싱이 아무리 빨라도 사용자는 3초를 기다린다 — 그게 원래 버그였다.)
  let screen = claudeScreen({ footer: CLAUDE_FOOTER });
  const restore = mockTmux(() => screen);
  const dialogs = [];
  sl.setEmitter((chatId, lines, mode, dialog) => dialogs.push(dialog && dialog.title));
  try {
    sl.watch('c_wire', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    const n0 = dialogs.length;
    // 제출 = 사용자가 채팅에서 `/model` 을 보낸 그 호출. 보내는 동안 TUI 에 선택 화면이 떴다.
    screen = [
      '  Select model', '', '❯ 1. Default (recommended)  Opus 5', '  2. Sonnet  Sonnet 5',
      '', '  Esc to cancel', '',
    ].join('\n');
    await require('../cpt-server').chatInput({ cwd: CWD, tid: TID, text: '/model', submit: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepStrictEqual(dialogs.slice(n0), ['Select model'], '제출 경로가 burst 를 걸어야 한다');
  } finally { restore(); sl.stop(); }
});

test('burst 는 무관한 터미널을 깨우지 않는다', async () => {
  const restore = mockTmux(() => claudeScreen());
  const emitted = [];
  sl.setEmitter(() => emitted.push(1));
  try {
    sl.watch('c_burst2', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    const n = emitted.length;
    sl.pokeTermSession('cpt-other--t-9', { burst: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(emitted.length, n, '다른 세션 이름이면 아무 확인도 하지 않는다');
  } finally { restore(); sl.stop(); }
});

test('★ 아직 못 읽었으면 lines 는 null 로 나간다(빈 배열로 지우지 않는다)', async () => {
  // 2026-08-03 사용자 신고 "claude statusline 이 안 나온다"의 진범 중 하나.
  //  종전엔 캐시가 비어 있을 때 **빈 배열**을 실었고 클라는 그걸 "감춰라"로 읽었다. 그리고
  //  statusLines 에는 pull 이 없어서(mode/dialog 와 달리) 되살아날 계기가 오지 않았다.
  //  → 모름 = null(유지) / 값 = 교체 로 계약을 나눈다.
  const DIALOG_ONLY = [
    '  Select model', '', '❯ 1. Default  Opus 5', '  2. Sonnet  Sonnet 5', '', '  Esc to cancel', '',
  ].join('\n');
  const restore = mockTmux(() => DIALOG_ONLY);      // 상태줄을 한 번도 못 읽는 화면
  const seen = [];
  sl.setEmitter((chatId, lines) => seen.push(lines));
  try {
    sl.watch('c_null', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(seen.length >= 1, '다이얼로그 변화로 프레임은 나간다');
    assert.strictEqual(seen[0], null, '빈 배열이 아니라 null — 클라는 이전 값을 유지한다');
  } finally { restore(); sl.stop(); }
});

test('★ 캐치업(pull)이 statusline 의 정본이다 — push 를 놓쳐도 복구된다', async () => {
  // 실측: 유휴 터미널 3개를 60초 관측했더니 내용 변화 0회 = push 0건이었다. push 만으로는
  //  "한 번 놓치면 영영"이 구조적으로 불가피하다 → 캐시를 pull 응답에 싣는다.
  const restore = mockTmux(() => claudeScreen());
  sl.setEmitter(() => {});
  try {
    sl.watch('c_pull', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 60));
    const lines = sl.linesFor('c_pull');
    assert.ok(Array.isArray(lines) && lines.length, 'chat.since 가 실어 줄 값이 있다');
    assert.strictEqual(sl.linesFor('없는채팅'), null);
  } finally { restore(); sl.stop(); }
});

test('chat.open 스냅샷은 캐시가 아니라 지금 화면을 읽는다(토글 즉시 정확)', async () => {
  let screen = claudeScreen({ footer: CLAUDE_FOOTER });          // auto
  const restore = mockTmux(() => screen);
  sl.setEmitter(() => {});
  try {
    sl.watch('c_fresh', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    screen = claudeScreen({ footer: '  -- INSERT -- ⏸ plan mode on (shift+tab to cycle)' });
    const snap = await sl.snapshotFor('c_fresh');
    assert.strictEqual(snap.mode.id, 'plan', '토글 시점의 화면이 정본(캐시 auto 가 아니다)');
  } finally { restore(); sl.stop(); }
});

test('codex: 계획 모드가 바뀌면 다시 알린다(알약은 shift+tab 축만 본다)', async () => {
  // 실측(0.146.0): 상태줄 오른쪽 끝의 `Plan mode` 유무가 곧 모드다. 권한(`Approve for me`)이
  //  같은 줄에 있어도 알약 값에는 섞지 않는다(사용자 확정 2026-08-03 — 축이 다르다).
  const line = (plan) => `  gpt-5.6-sol low fast · Context 0% used · Fast on · Approve for me · 1M window${plan ? '        Plan mode' : ''}`;
  let screen = ['본문', '', '› ', '', line(false), ''].join('\n');
  const restore = mockTmux(() => screen);
  const modes = [];
  sl.setEmitter((chatId, lines, mode) => modes.push(mode && `${mode.id}|${mode.plan ? 1 : 0}`));
  try {
    sl.watch('c_codex', { cwdRel: CWD, tid: TID, agent: 'codex' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(modes, ['codexDefault|0']);
    screen = ['본문', '', '› ', '', line(true), ''].join('\n');
    const snap = await sl.snapshotFor('c_codex');
    assert.strictEqual(snap.mode.plan, true);
    assert.deepStrictEqual(modes, ['codexDefault|0', 'codexPlan|1'], '계획 모드 전환이 곧 모드 변경');
    assert.strictEqual(sl.modeFor('c_codex').label, 'Plan mode');
  } finally { restore(); sl.stop(); }
});

test('지원 외 에이전트/tid 없음은 등록되지 않는다', () => {
  sl.watch('c_x', { cwdRel: CWD, tid: TID, agent: 'gemini' });
  sl.watch('c_y', { cwdRel: CWD, tid: null, agent: 'claude' });
  assert.strictEqual(sl._watches.size, 0);
});

test('★ pokeChat — 공식 상태 갱신을 "지금 확인해" 신호로 쓴다(TUI 에서 직접 눌러도 즉시)', async () => {
  // 종전 신호는 **우리 pty 를 지나가는 CSI Z** 하나뿐이라, 사용자가 Mac 터미널에 attach 해서
  //  직접 shift+tab 을 누르면 알약이 최대 3초 늦었다. 이제 claude statusLine 훅(shift+tab 에 즉시
  //  발화)·codex rollout(106ms) 이 그 순간을 알려 준다 → agent-status 갱신을 트리거로 삼는다.
  //  ⚠ 모드의 정본은 여전히 **화면 하나**다(두 원천이 어긋나면 판정 근거가 사라진다).
  let screen = claudeScreen({ footer: CLAUDE_FOOTER });        // auto
  const restore = mockTmux(() => screen);
  const modes = [];
  sl.setEmitter((chatId, lines, mode) => modes.push(mode && mode.id));
  try {
    sl.watch('c_hook', { cwdRel: CWD, tid: TID, agent: 'claude' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(modes, ['auto']);
    // 사용자가 TUI 에서 직접 눌렀다 → 우리 입력 경로엔 아무것도 안 지나간다. 훅만 온다.
    screen = claudeScreen({ footer: '  -- INSERT -- ⏸ plan mode on (shift+tab to cycle)' });
    sl.pokeChat('c_hook');
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(modes, ['auto', 'plan'], '3초 폴링을 기다리지 않는다');
  } finally { restore(); sl.stop(); }
});

test('pokeChat 은 모르는 chatId 에 아무 일도 하지 않는다', async () => {
  const restore = mockTmux(() => claudeScreen());
  const seen = [];
  sl.setEmitter(() => seen.push(1));
  try {
    sl.pokeChat('없는채팅');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(seen.length, 0);
  } finally { restore(); sl.stop(); }
});
