// codex 모드(shift+tab = Default ↔ Plan) 회귀 — 화면 파싱과 driveCodexMode 를 io 주입으로 검증한다.
//
// 정본은 **격리 tmux 의 진짜 codex 0.146.0 실측**(2026-08-02~03):
//  · 상태줄: `gpt-5.6-sol low fast · Context 0% used · Fast on · Approve for me · 1M window`
//    계획 모드를 켜면 같은 줄 오른쪽 끝에 `Plan mode` 가 붙는다.
//  · shift+tab = **Default ↔ Plan 두 상태**(claude 처럼 여러 권한 모드를 순환하는 것이 아니다).
//
// ★ 사용자 확정(2026-08-03): 알약은 **shift+tab 이 바꾸는 것만** 담는다. 권한 3종(`/permissions`)은
//  다른 축이라 섞지 않는다 — 팔레트에서 그 명령을 실행하면 선택 화면 카드가 떠서 거기서 고른다.
//  그래서 모드 전환은 컴포저를 한 글자도 건드리지 않는다(슬래시 타이핑 경로 자체가 사라졌다).
//
// 이 파일이 고정하는 함정:
//  ① 대화 본문에 `• Model changed … for Plan mode.` 기록이 남는다 — 화면 전체를 훑으면 오독한다.
//  ② 다이얼로그가 화면을 덮으면 상태줄이 안 보인다 → "Plan 아님 = Default" 로 단정하면 안 된다.
//  ③ 채팅 전송 전 컴포저 잔재 청소는 codex(`›`)도 해야 한다(`//model` 사고).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cx-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const statusLib = require('../status-line');
const { _driveCodexMode: driveCodexMode, _clearComposerResidue: clearResidue } = require('../cpt-server');

// ── 실캡처 화면 ────────────────────────────────────────────────────────────────
const HEAD = [
  '⚠ MCP startup incomplete (failed: figma)',
  '',
  '• Model changed to gpt-5.6-sol medium for Plan mode.',   // ← 본문 기록(현재값이 아니다)
  '',
];
const screenOf = ({ plan = false, perm = 'Approve for me', composer = 'Run /review on my current changes' } = {}) => [
  ...HEAD,
  '',
  `› ${composer}`,
  '',
  `  gpt-5.6-sol low fast · Context 0% used · Fast on · ${perm} · 1M window${plan ? '               Plan mode' : ''}`,
  '',
].join('\n');

const DIALOG = [
  ...HEAD,
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

// ── 화면 파싱 ──────────────────────────────────────────────────────────────────
test('상태줄의 Plan mode 유무로만 판정한다(본문 기록이 아니라)', () => {
  assert.strictEqual(statusLib.extractMode(screenOf({ plan: true }), 'codex').id, 'codexPlan');
  const d = statusLib.extractMode(screenOf({ plan: false }), 'codex');
  assert.strictEqual(d.id, 'codexDefault');
  assert.strictEqual(d.label, 'Default mode', '라벨은 codex 가 쓰는 그 단어');
});

test('권한(Approve for me / Full Access)은 알약 값에 섞이지 않는다', () => {
  const a = statusLib.extractMode(screenOf({ plan: false, perm: 'Approve for me' }), 'codex');
  const b = statusLib.extractMode(screenOf({ plan: false, perm: 'never' }), 'codex');
  assert.deepStrictEqual([a.id, b.id], ['codexDefault', 'codexDefault'], '권한이 달라도 모드는 같다');
  assert.strictEqual(a.label, b.label);
});

test('★ 다이얼로그가 떠 있으면 판정하지 않는다(Default 로 단정 금지)', () => {
  assert.strictEqual(statusLib.extractMode(DIALOG, 'codex'), null);
});

test('에이전트 판정은 화면으로 한다', () => {
  assert.strictEqual(statusLib.detectAgent(screenOf()), 'codex');
  assert.strictEqual(statusLib.detectAgent('  -- INSERT -- ⏸ plan mode on'), 'claude');
  assert.strictEqual(statusLib.detectAgent('$ ls\n'), null);
});

// ── 조작 ──────────────────────────────────────────────────────────────────────
/** 진짜 codex 를 흉내내는 io — BTab 이 Default ↔ Plan 을 뒤집는다. */
function codexIo(init = {}) {
  const st = { plan: !!init.plan };
  const keys = [];
  return {
    st,
    keys,
    screen: async () => screenOf(st),
    key: async (k) => { keys.push(k); if (k === 'BTab') st.plan = !st.plan; },
    sleep: async () => {},
  };
}

test('shift+tab 한 번으로 Plan 으로 간다', async () => {
  const io = codexIo();
  const r = await driveCodexMode(io, { mode: 'codexPlan' });
  assert.strictEqual(r.mode.id, 'codexPlan');
  assert.deepStrictEqual(io.keys, ['BTab']);
});

test('이미 그 상태면 키를 한 개도 보내지 않는다(누르면 반대로 간다)', async () => {
  const io = codexIo({ plan: true });
  const r = await driveCodexMode(io, { mode: 'codexPlan' });
  assert.strictEqual(r.mode.id, 'codexPlan');
  assert.deepStrictEqual(io.keys, []);
});

test('Plan 에서 Default 로도 한 번', async () => {
  const io = codexIo({ plan: true });
  const r = await driveCodexMode(io, { mode: 'codexDefault' });
  assert.strictEqual(r.mode.id, 'codexDefault');
  assert.deepStrictEqual(io.keys, ['BTab']);
});

test('모드를 읽을 수 없는 화면이면 실패(추측 조작 금지)', async () => {
  const io = { keys: [], screen: async () => '$ ls\n', key: async (k) => { io.keys.push(k); }, sleep: async () => {} };
  await assert.rejects(() => driveCodexMode(io, { mode: 'codexPlan' }), (e) => e.code === 'MODE_UNKNOWN');
  assert.deepStrictEqual(io.keys, []);
});

test('권한 id 는 이제 모드가 아니다 — 요청 자체를 거절한다', async () => {
  const io = codexIo();
  for (const bad of ['codexAuto', 'codexFull', 'yolo']) {
    await assert.rejects(() => driveCodexMode(io, { mode: bad }), (e) => e.code === 'BAD_REQUEST');
  }
  assert.deepStrictEqual(io.keys, [], '컴포저도 화면도 건드리지 않는다');
});

// ── 컴포저 잔재 청소(codex) — 2026-08-02 실사고 회귀 ─────────────────────────
// 사용자 신고: 채팅에서 `/model` 을 보냈는데 TUI 에 `//model` 이 들어갔다.
//  진범 = 잔재 청소가 claude(`❯`)만 감지해 codex 는 그냥 통과 → TUI 컴포저에 남아 있던 `/` 위에
//  붙어 버렸다. 채팅 전송의 계약은 "채팅 텍스트 = 제출 본문" 이므로 이건 계약 위반이다.
//  ★ 글자 수는 커서로 잰다: codex 는 빈 컴포저에도 회색 플레이스홀더를 같은 자리에 그려서
//   화면 텍스트만으로는 초안과 구분할 수 없다(실측: 빈 컴포저 커서 x=2, `/mo` 면 x=5).
function tmuxStub({ line, cursor }) {
  const ptyLib = require('../pty');
  const orig = ptyLib.runTmux;
  const calls = [];
  const st = { line, cursor };
  ptyLib.runTmux = async (args) => {
    calls.push(args);
    if (args[0] === 'capture-pane') return ['본문', '', st.line, '  gpt-5.6-sol low · Context 0% used'].join('\n');
    if (args[0] === 'display-message') return st.cursor;
    if (args[0] === 'send-keys' && args.includes('BSpace')) {
      st.line = '› Write tests for @filename';   // 비었으니 플레이스홀더
      st.cursor = '2 2';
    }
    return '';
  };
  return { calls, restore: () => { ptyLib.runTmux = orig; } };
}

test('★ codex 컴포저에 남은 글자만큼 Backspace 를 보낸다(`//model` 사고)', async () => {
  const t = tmuxStub({ line: '› /model', cursor: '8 2' });   // 커서 x=8 → 입력 6자(`/model`)
  try {
    await clearResidue('=t:0');
    const bs = t.calls.filter((a) => a[0] === 'send-keys');
    assert.strictEqual(bs.length, 1);
    assert.deepStrictEqual(bs[0].slice(-3), ['-N', '6', 'BSpace'], '커서로 잰 글자 수(=6)만큼 정확히');
  } finally { t.restore(); }
});

test('플레이스홀더(빈 컴포저)는 건드리지 않는다', async () => {
  const t = tmuxStub({ line: '› Write tests for @filename', cursor: '2 2' });
  try {
    await clearResidue('=t:0');
    assert.deepStrictEqual(t.calls.filter((a) => a[0] === 'send-keys'), [], '키를 한 개도 보내지 않는다');
  } finally { t.restore(); }
});

test('커서가 컴포저 줄이 아니면(다이얼로그 등) 손대지 않는다', async () => {
  const t = tmuxStub({ line: '› /model', cursor: '8 9' });
  try {
    await clearResidue('=t:0');
    assert.deepStrictEqual(t.calls.filter((a) => a[0] === 'send-keys'), []);
  } finally { t.restore(); }
});

test('다이얼로그 선택 커서(`› 1.`)는 컴포저로 보지 않는다', async () => {
  const t = tmuxStub({ line: '› 1. Ask for approval', cursor: '8 2' });
  try {
    await clearResidue('=t:0');
    assert.deepStrictEqual(t.calls.filter((a) => a[0] === 'send-keys'), []);
  } finally { t.restore(); }
});
