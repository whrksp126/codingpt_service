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
  assert.strictEqual(sl.extractMode(screen, 'codex'), null, 'codex 는 모드 개념이 달라 미지원');
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

test('지원 외 에이전트/tid 없음은 등록되지 않는다', () => {
  sl.watch('c_x', { cwdRel: CWD, tid: TID, agent: 'gemini' });
  sl.watch('c_y', { cwdRel: CWD, tid: null, agent: 'claude' });
  assert.strictEqual(sl._watches.size, 0);
});
