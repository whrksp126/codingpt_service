// TUI 선택 화면(다이얼로그) 미러 — 화면 파싱 + 카드 조작(chat.dialog) 회귀.
//
// 실측 캡처(2026-08-02, 격리 tmux)가 픽스처 정본이다:
//  · claude 2.1.220 `/model`  → "Select model" + 1~5 + "Enter to set as default · s to … · Esc to cancel"
//  · codex 0.146.0 `/permissions` → "Update Model Permissions" + 1~3 + "Press enter to confirm or esc to go back"
// 두 화면 모두 **숫자키 한 번에 즉시 적용**된다(실측). 그래서 카드 버튼 = 그 번호.
//
// 이 테스트가 고정하는 것:
//  · 푸터 힌트가 없는 화면은 다이얼로그가 아니다(대화 본문의 "1. …" 목록 오탐 차단)
//  · 승인/질문 다이얼로그는 미러하지 않는다(훅 경로의 자기 카드가 이미 있다 — 이중 표시 금지)
//  · 카드를 누르는 사이 화면이 바뀌었으면 **키를 치지 않는다**(다른 질문에 대신 답하는 사고 방지)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-dlg-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const sl = require('../status-line');
const { _driveChatDialog: driveChatDialog } = require('../cpt-server');

const MODEL = [
  '  본문 답변',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions.',
  '     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks',
  '   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks',
  '     3. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks',
  '     4. Sonnet                 Sonnet 5 · Efficient for routine tasks',
  '     5. Haiku                  Haiku 4.5 · Fastest for quick answers',
  '   ● High effort (default) ←/→ to adjust',
  '   Enter to set as default · s to use this session only · Esc to cancel',
  '',
].join('\n');

const PERMS = [
  '⚠ MCP startup incomplete (failed: figma)',
  '',
  '  Update Model Permissions',
  '',
  '› 1. Ask for approval (current)  Codex can read and edit files in the current workspace, and run commands.',
  '                                 Approval is required to access the internet or edit other files.',
  '  2. Approve for me              Only ask for actions detected as potentially unsafe.',
  '  3. Full Access                 Codex can edit files outside this workspace and access the internet without',
  '                                 asking for approval. Exercise caution when using.',
  '',
  '  Press enter to confirm or esc to go back',
  '',
].join('\n');

test('claude /model 화면을 카드 모양으로 읽는다', () => {
  const d = sl.extractDialog(MODEL);
  assert.strictEqual(d.title, 'Select model');
  assert.match(d.desc, /Switch between Claude models/);
  assert.deepStrictEqual(d.options.map((o) => o.n), [1, 2, 3, 4, 5]);
  assert.strictEqual(d.options[3].label, '4. Sonnet'.slice(3), '번호는 n 으로 분리하고 라벨만 남긴다');
  assert.match(d.options[3].desc, /Efficient for routine tasks/);
  assert.match(d.footer, /Esc to cancel/);
});

test('codex /permissions 는 줄바꿈된 설명까지 그 옵션에 붙는다', () => {
  const d = sl.extractDialog(PERMS);
  assert.strictEqual(d.title, 'Update Model Permissions');
  assert.deepStrictEqual(d.options.map((o) => o.label), ['Ask for approval (current)', 'Approve for me', 'Full Access']);
  assert.match(d.options[0].desc, /Approval is required to access the internet/, '이어진 줄이 설명에 붙는다');
});

test('푸터 힌트가 없으면 다이얼로그가 아니다(본문의 번호 목록 오탐 차단)', () => {
  const prose = ['에이전트 답변:', '', '1. 첫째 항목', '2. 둘째 항목', '3. 셋째 항목', '', '이상입니다.'].join('\n');
  assert.strictEqual(sl.extractDialog(prose), null);
});

test('승인/질문 다이얼로그는 미러하지 않는다(자기 카드가 이미 있다)', () => {
  const approval = [
    '  Do you want to run this command?',
    '  npm run deploy',
    '  1. Yes',
    '  2. No, tell Claude what to do differently',
    '  Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.strictEqual(sl.extractDialog(approval), null);
});

test('옵션이 하나뿐이거나 번호가 1부터가 아니면 무시한다', () => {
  const one = ['  제목', '  1. 하나만', '  Esc to cancel'].join('\n');
  assert.strictEqual(sl.extractDialog(one), null);
  const odd = ['  제목', '  2. 둘', '  3. 셋', '  Esc to cancel'].join('\n');
  assert.strictEqual(sl.extractDialog(odd), null);
});

// ── 카드 조작 ────────────────────────────────────────────────────────────────
function io(screens) {
  const st = { i: 0, keys: [] };
  return {
    st,
    screen: async () => screens[Math.min(st.i, screens.length - 1)],
    key: async (k) => { st.keys.push(k); st.i += 1; },
    sleep: async () => {},
  };
}

test('번호를 누르면 화면이 닫히고 그걸로 끝난다(Enter 를 덧붙이지 않는다)', async () => {
  const t = io([MODEL, '  본문만 남았다\n']);
  const r = await driveChatDialog(t, { pick: 4, expect: 'Select model' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(t.st.keys, ['4']);
});

test('숫자로 안 닫히는 화면은 Enter 를 한 번만 덧붙인다', async () => {
  // 커서만 옮기는 형식 — Enter 를 받아야 닫힌다.
  const st = { keys: [] };
  const t = {
    st,
    screen: async () => (st.keys.includes('Enter') ? '  닫혔다\n' : MODEL),
    key: async (k) => { st.keys.push(k); },
    sleep: async () => {},
  };
  const r = await driveChatDialog(t, { pick: 2 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(st.keys, ['2', 'Enter'], 'Enter 는 딱 한 번만');
});

test('★ 카드와 화면이 다르면 키를 한 개도 치지 않는다', async () => {
  const t = io([PERMS]);
  await assert.rejects(() => driveChatDialog(t, { pick: 1, expect: 'Select model' }), (e) => e.code === 'DIALOG_MISMATCH');
  assert.deepStrictEqual(t.st.keys, []);
});

test('선택 화면이 없으면 실패한다(빈 화면에 숫자 타이핑 금지)', async () => {
  const t = io(['$ ls\n']);
  await assert.rejects(() => driveChatDialog(t, { pick: 1 }), (e) => e.code === 'DIALOG_GONE');
  assert.deepStrictEqual(t.st.keys, []);
});

test('범위를 벗어난 번호는 거절한다', async () => {
  const t = io([PERMS]);
  await assert.rejects(() => driveChatDialog(t, { pick: 7 }), (e) => e.code === 'BAD_REQUEST');
  assert.deepStrictEqual(t.st.keys, []);
});

test('취소는 Escape 한 번', async () => {
  const t = io([MODEL, '  닫혔다\n']);
  const r = await driveChatDialog(t, { cancel: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(t.st.keys, ['Escape']);
});

// ── 대화 바인딩이 없어도 화면은 보인다 — 2026-08-03 실사고 회귀 ─────────────────
// 사용자 신고: "codex 에서 /model 했는데 TUI 엔 목록이 뜨는데 채팅엔 아무것도 없다".
//  진범 = 감시자가 chat.open 성공(대화 파일 짝짓기)에만 등록돼서, codex 가 `noSession: ambiguous`
//  이면 상태줄·모드·선택 화면이 **전부** 막혔다. 화면에서 오는 것은 대화 유무와 독립이어야 한다.
test('screenFor 는 대화 없이 화면만으로 상태를 준다(+다이얼로그 중엔 상태줄을 갱신하지 않는다)', async () => {
  const ptyLib = require('../pty');
  const orig = ptyLib.runTmux;
  const CODEX_DLG = [
    '• GPT-5.4 기반 Codex 모델을 사용 중입니다.',
    '',
    '› //model',                                   // 본문에 남은 컴포저 줄(오독 유발 지점)
    '',
    '  Select Model and Effort',
    '  Access legacy models by running codex -m <model>',
    '  1. gpt-5.6-sol (current)  Latest frontier agentic coding model.',
    '  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.',
    '  3. gpt-5.6-luna           Fast and affordable agentic coding model.',
    '',
    '  Press enter to confirm or esc to go back',
    '',
  ].join('\n');
  ptyLib.runTmux = async (args) => (args[0] === 'capture-pane' ? CODEX_DLG : '');
  try {
    const r = await sl.screenFor({ cwdRel: 'ws', tid: 7, agent: 'codex' });
    assert.strictEqual(r.dialog.title, 'Select Model and Effort');
    assert.strictEqual(r.dialog.options.length, 3);
    assert.strictEqual(r.lines, null, '다이얼로그가 화면을 덮는 동안 상태줄은 보이지 않는 것이다');
  } finally { ptyLib.runTmux = orig; }
});

test('tid 가 없으면 화면을 읽지 않는다(추측 조작 금지와 같은 규율)', async () => {
  assert.strictEqual(await sl.screenFor({ cwdRel: 'ws', tid: null }), null);
});
