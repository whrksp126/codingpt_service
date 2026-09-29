// capture 형식 교차검증(웨이브1 주의점 1) — term-host 의 capture(serialize/버퍼 스크랩)는 tmux
//  capture-pane 과 **바이트 동일이 아니다**. win32 에서 화면을 읽는 소비자(status-line 의
//  statusline/모드/선택 다이얼로그, question-revive 의 권한 다이얼로그, cpt-server 의 컴포저 감지)가
//  양쪽 형식 모두에서 같은 판정을 내는지 여기서 고정한다.
//
//  방법: 같은 화면 내용을 ① tmux 형식 픽스처(기존 테스트들이 쓰는 '\n' join 원문) ② term-host
//  Screen 에 실제로 write 한 뒤 captureText/captureEscapes 로 떠낸 산물 — 두 입력에 파서를 태워
//  결과를 대조한다.
const { test } = require('node:test');
const assert = require('node:assert');

const { Screen } = require('../../term-host/lib/screen');
const statusLib = require('../status-line');
const revive = require('../question-revive');

// 화면에 "그린다" — 각 줄을 \r\n 이동으로 출력(래핑 방지 위해 80컬럼 내 줄만 사용).
async function paint(lines, cols = 80, rows = 24) {
  const s = new Screen(cols, rows);
  s.write(lines.join('\r\n'));
  await s.flush();
  return s;
}

// ── claude statusline + 모드 푸터 ───────────────────────────────────────────
const CLAUDE_LINES = [
  '⏺ 작업을 마쳤습니다.',
  '',
  '─'.repeat(30),
  '❯ ',
  '─'.repeat(30),
  '\x1b[38;5;208mopus | ctx 43%\x1b[0m',           // 사용자 statusLine 스크립트 출력(ANSI)
  '  ⏸ plan mode on (shift+tab to cycle)',
];

test('claude statusline/모드 — tmux 형식과 term-host 형식(escapes)이 같은 판정', async () => {
  const tmuxForm = CLAUDE_LINES.join('\n');
  const scr = await paint(CLAUDE_LINES);
  const hostForm = scr.captureEscapes();

  for (const [label, form] of [['tmux', tmuxForm], ['term-host', hostForm]]) {
    const lines = statusLib._extract(form, 'claude');
    assert.ok(lines && lines.length >= 1, `${label}: statusline 추출 실패`);
    assert.match(lines[0], /opus \| ctx 43%/, `${label}: statusline 원문이 아니다`);
    const mode = statusLib.extractMode(form, 'claude');
    assert.ok(mode && mode.id === 'plan', `${label}: 모드 판정 실패(${mode && mode.id})`);
  }
  // escapes 캡처는 \n 구분(\r\n 정규화)이어야 소비자의 split('\n') 이 성립한다.
  assert.ok(!/\r\n/.test(hostForm), 'captureEscapes 는 \\r\\n 을 \\n 으로 정규화해야 한다');
});

// ── 선택 다이얼로그(/model 류) — extractDialog ─────────────────────────────
const DIALOG_LINES = [
  '› /model',
  '',
  '  Select Model and Effort',
  '  Access legacy models by running codex -m',
  '  1. gpt-a (current)  Latest frontier model.',
  '  2. gpt-b            Balanced model.',
  '  3. gpt-c            Fast model.',
  '',
  '  Press enter to confirm or esc to go back',
];

test('선택 다이얼로그 — captureText 산물에서도 extractDialog 동일', async () => {
  const tmuxForm = DIALOG_LINES.join('\n');
  const scr = await paint(DIALOG_LINES);
  const hostForm = scr.captureText();
  for (const [label, form] of [['tmux', tmuxForm], ['term-host', hostForm]]) {
    const d = statusLib.extractDialog(form);
    assert.ok(d, `${label}: 다이얼로그 추출 실패`);
    assert.strictEqual(d.title, 'Select Model and Effort', label);
    assert.strictEqual(d.options.length, 3, label);
    assert.strictEqual(d.options[0].n, 1, label);
  }
});

// ── 권한 다이얼로그 — question-revive.parsePermissionDialog ────────────────
const PERM_LINES = [
  '─'.repeat(20),
  ' Bash command',
  ' rm demo.txt',
  ' Remove the demo file',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again for: rm',
  '   3. No',
  ' Esc to cancel · Tab to amend',
];

test('권한 다이얼로그 — captureText 산물에서도 parsePermissionDialog 동일', async () => {
  const tmuxForm = PERM_LINES.join('\n');
  const scr = await paint(PERM_LINES);
  const hostForm = scr.captureText();
  for (const [label, form] of [['tmux', tmuxForm], ['term-host', hostForm]]) {
    const p = revive._parsePermissionDialog(form);
    assert.ok(p, `${label}: 권한 다이얼로그 파싱 실패`);
    assert.strictEqual(p.options.length, 3, label);
    assert.strictEqual(p.tool, 'Bash', label);
    assert.strictEqual(p.flow, 'amend', label);
  }
});

// ── 컴포저 잔재 감지(cpt-server.clearComposerResidue 의 화면 판정 재료) ─────
test('컴포저 줄(❯/›) — captureText 에서도 마지막 프롬프트 줄이 보존된다', async () => {
  const LINES = ['본문 출력', '', '❯ /mo'];
  const scr = await paint(LINES);
  const hostForm = scr.captureText();
  const rows = hostForm.split('\n');
  const idx = rows.findIndex((l) => /^\s*❯/.test(l));
  assert.ok(idx >= 0, '컴포저 줄이 소실됐다');
  assert.match(rows[idx], /❯ \/mo/);
  // 커서 좌표(정보용) — term-host info.cursor 의 재료가 화면과 일치해야 한다.
  const cur = scr.cursor();
  assert.strictEqual(cur.y, 2, '커서가 컴포저 줄에 있어야 한다');
});
