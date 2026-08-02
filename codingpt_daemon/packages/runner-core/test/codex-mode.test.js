// codex 모드(계획 토글 + 권한 3종) 회귀 — 화면 파싱과 driveCodexMode 를 io 주입으로 검증한다.
//
// 정본은 **격리 tmux 의 진짜 codex 0.146.0 실측**(2026-08-02). 아래 화면 조각은 그 캡처 원문이다:
//  · 상태줄: `gpt-5.6-sol low fast · Context 0% used · Fast on · Ask for approval · 1M window`
//    계획 모드를 켜면 같은 줄 오른쪽 끝에 `Plan mode` 가 붙는다(권한 라벨은 그대로 남는다 = 독립).
//  · shift+tab = 계획 모드 **토글**(claude 처럼 순환이 아니다).
//  · 권한은 `/permissions` → 번호 다이얼로그, 숫자키 한 번에 즉시 적용(Enter 불필요).
//
// 이 테스트가 고정하는 함정 3가지(전부 실측에서 나온 것):
//  ① 다이얼로그의 선택 커서도 `›` 라서 컴포저로 오인하면 선택지 줄을 상태줄로 읽어 **틀린 모드**를 띄운다.
//  ② 대화 본문에 `• Permissions updated to Ask for approval` 기록이 남는다 — 화면 전체를 훑으면 오독한다.
//  ③ 슬래시 명령은 컴포저에 **타이핑**하는 것이라, 사용자가 쓰던 글이 있으면 Enter 가 그 글을 전송한다.
//     → 타이핑 후 컴포저 줄이 정확히 `/permissions` 일 때만 Enter 를 친다.
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
const {
  _driveCodexMode: driveCodexMode, _codexComposerText: composerText,
  _codexPermOptions: permOptions, _codexFullAccessConfirm: fullAccessConfirm,
} = require('../cpt-server');

// ── 실캡처 화면 ────────────────────────────────────────────────────────────────
const HEAD = [
  '⚠ MCP startup incomplete (failed: figma)',
  '',
  '• Permissions updated to Ask for approval',   // ← 본문 기록(현재값이 아니다)
  '',
];
const screenOf = ({ perm = 'Ask for approval', plan = false, composer = 'Run /review on my current changes' } = {}) => [
  ...HEAD,
  '',
  `› ${composer}`,
  '',
  `  gpt-5.6-sol low fast · Context 0% used · Fast on · ${perm} · 1M window${plan ? '               Plan mode' : ''}`,
  '',
].join('\n');

// Full Access 를 고르면 codex 가 한 번 더 확인한다(실캡처).
const CONFIRM = [
  ...HEAD,
  '  Enable full access?',
  '  When Codex runs with full access, it can edit any file on your computer and run commands with network,',
  '  without your approval. Exercise caution when enabling full access.',
  '',
  '› 1. Yes, continue anyway  Apply full access for this session',
  '  2. Cancel                Go back without enabling full access',
  '',
  '  Press enter to confirm or esc to go back',
  '',
].join('\n');

const DIALOG = [
  ...HEAD,
  '• Model changed to gpt-5.6-sol medium for Plan mode.',
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

// ── 화면 파싱 ──────────────────────────────────────────────────────────────────
test('상태줄에서 권한 라벨을 읽는다(본문 기록이 아니라)', () => {
  const m = statusLib.extractMode(screenOf({ perm: 'Approve for me' }), 'codex');
  assert.strictEqual(m.id, 'codexAuto');
  assert.strictEqual(m.label, 'Approve for me', '라벨은 TUI 원문 그대로');
  assert.strictEqual(m.plan, false);
});

test('계획 모드는 권한과 **함께** 읽힌다(둘은 독립)', () => {
  const m = statusLib.extractMode(screenOf({ perm: 'Full Access', plan: true }), 'codex');
  assert.strictEqual(m.id, 'codexFull');
  assert.strictEqual(m.plan, true);
  assert.strictEqual(m.label, 'Plan mode · Full Access', '알약 한 줄에 화면의 두 값을 그대로');
});

test('권한 다이얼로그가 떠 있으면 모드를 읽지 않는다(선택지를 현재값으로 오독 금지)', () => {
  assert.strictEqual(statusLib.extractMode(DIALOG, 'codex'), null);
});

test('★ Full Access 는 상태줄에 `never` 로 뜬다(다이얼로그 이름과 다르다 — 라이브 실측)', () => {
  const m = statusLib.extractMode(screenOf({ perm: 'never' }), 'codex');
  assert.strictEqual(m.id, 'codexFull');
  assert.strictEqual(m.label, 'Full Access', '보여줄 이름은 사용자가 고른 그 이름으로 통일');
});

test('확인 다이얼로그는 그 제목일 때만 "예"를 찾아 준다(아무 번호 다이얼로그나 누르지 않는다)', () => {
  assert.strictEqual(fullAccessConfirm(CONFIRM), 1);
  assert.strictEqual(fullAccessConfirm(DIALOG), null);
  assert.strictEqual(fullAccessConfirm('1. 봄\n2. 여름\nEnter to select'), null);
});

test('에이전트 판정은 화면으로 한다', () => {
  assert.strictEqual(statusLib.detectAgent(screenOf()), 'codex');
  assert.strictEqual(statusLib.detectAgent('  -- INSERT -- ⏸ plan mode on'), 'claude');
  assert.strictEqual(statusLib.detectAgent('$ ls\n'), null);
});

test('컴포저 텍스트 추출은 다이얼로그 커서(`› 1.`)를 컴포저로 보지 않는다', () => {
  assert.strictEqual(composerText(screenOf({ composer: '' })), '');
  assert.strictEqual(composerText(screenOf({ composer: '/permissions' })), '/permissions');
  assert.strictEqual(composerText(DIALOG), null);
});

test('다이얼로그 선택지는 번호와 함께 화면에서 읽는다(번호를 코드에 박지 않는다)', () => {
  const opts = permOptions(DIALOG);
  assert.deepStrictEqual(opts.map((o) => o.n), [1, 2, 3]);
  assert.ok(opts[2].text.includes('Full Access'));
  assert.strictEqual(permOptions(screenOf()), null);
});

// ── 조작 ──────────────────────────────────────────────────────────────────────
/** 진짜 codex 를 흉내내는 io — BTab=계획 토글, /permissions+숫자=권한 변경. */
function codexIo(init = {}) {
  const st = { perm: init.perm || 'Ask for approval', plan: !!init.plan, composer: init.composer || '', dialog: false, confirm: false };
  const keys = [];
  return {
    st,
    keys,
    screen: async () => (st.confirm ? CONFIRM : st.dialog ? DIALOG : screenOf(st)),
    key: async (k, literal) => {
      keys.push(k);
      if (k === 'BTab') { st.plan = !st.plan; return; }
      if (k === 'BSpace') { st.composer = st.composer.slice(0, -1); return; }
      if (k === 'Escape') { st.dialog = false; st.confirm = false; return; }
      if (k === 'Enter') {
        if (st.composer === '/permissions') { st.composer = ''; st.dialog = true; }
        return;
      }
      if (st.confirm && literal && /^[1-9]$/.test(k)) {
        // 1 = Yes, continue anyway (실측) — 그때만 실제로 적용된다.
        if (k === '1') st.perm = 'never';   // 상태줄 표기는 never(= Full Access)
        st.confirm = false;
        return;
      }
      if (st.dialog && literal && /^[1-9]$/.test(k)) {
        const pick = parseInt(k, 10);
        st.dialog = false;
        // Full Access(3번)만 확인 다이얼로그를 한 번 더 띄운다(실측).
        if (pick === 3) { st.confirm = true; return; }
        st.perm = ['Ask for approval', 'Approve for me'][pick - 1];
        return;
      }
      if (literal) st.composer += k;
    },
    sleep: async () => {},
  };
}

test('계획 모드는 shift+tab 한 번으로 켜고 끈다', async () => {
  const io = codexIo();
  const on = await driveCodexMode(io, { mode: 'codexPlan' });
  assert.strictEqual(on.mode.plan, true);
  assert.deepStrictEqual(io.keys, ['BTab']);

  const io2 = codexIo({ plan: true });
  const off = await driveCodexMode(io2, { mode: 'codexPlan' });
  assert.strictEqual(off.mode.plan, false);
  assert.deepStrictEqual(io2.keys, ['BTab'], '토글이므로 한 번만 — 두 번 누르면 제자리로 돌아온다');
});

test('권한은 /permissions 다이얼로그의 번호를 눌러 바꾼다', async () => {
  const io = codexIo();
  const r = await driveCodexMode(io, { mode: 'codexAuto' });
  assert.strictEqual(r.mode.id, 'codexAuto');
  assert.deepStrictEqual(io.keys, ['/permissions', 'Enter', '2']);
});

test('Full Access 는 확인 다이얼로그까지 통과해야 적용된다', async () => {
  const io = codexIo();
  const r = await driveCodexMode(io, { mode: 'codexFull' });
  assert.strictEqual(r.mode.id, 'codexFull');
  assert.deepStrictEqual(io.keys, ['/permissions', 'Enter', '3', '1'], '3=Full Access → 1=Yes, continue anyway');
});

test('권한이 이미 그 값이면 컴포저를 건드리지 않는다', async () => {
  const io = codexIo({ perm: 'Approve for me' });
  const r = await driveCodexMode(io, { mode: 'codexAuto' });
  assert.strictEqual(r.mode.id, 'codexAuto');
  assert.deepStrictEqual(io.keys, []);
});

test('계획 모드가 켜져 있어도 권한만 바꾼다(계획은 유지)', async () => {
  const io = codexIo({ plan: true });
  const r = await driveCodexMode(io, { mode: 'codexAuto' });
  assert.strictEqual(r.mode.id, 'codexAuto');
  assert.strictEqual(r.mode.plan, true);
});

test('★ 컴포저에 사용자의 글이 있으면 Enter 를 치지 않고, 친 글자를 되돌린다', async () => {
  const io = codexIo({ composer: '이거 고쳐줘' });
  await assert.rejects(() => driveCodexMode(io, { mode: 'codexFull' }), (e) => e.code === 'MODE_BLOCKED');
  assert.ok(!io.keys.includes('Enter'), '전송은 절대 하지 않는다');
  assert.strictEqual(io.st.composer, '이거 고쳐줘', '사용자 글은 그대로 남는다');
  assert.strictEqual(io.keys.filter((k) => k === 'BSpace').length, '/permissions'.length);
});

test('모드를 읽을 수 없는 화면이면 실패(추측 조작 금지)', async () => {
  const io = { keys: [], screen: async () => '$ ls\n', key: async (k) => { io.keys.push(k); }, sleep: async () => {} };
  await assert.rejects(() => driveCodexMode(io, { mode: 'codexAuto' }), (e) => e.code === 'MODE_UNKNOWN');
  assert.deepStrictEqual(io.keys, []);
});

test('알 수 없는 모드 id 는 요청 자체를 거절한다', async () => {
  const io = codexIo();
  await assert.rejects(() => driveCodexMode(io, { mode: 'yolo' }), (e) => e.code === 'BAD_REQUEST');
  assert.deepStrictEqual(io.keys, []);
});

// ── 컴포저 잔재 청소(codex) — 2026-08-02 실사고 회귀 ─────────────────────────
// 사용자 신고: 채팅에서 `/model` 을 보냈는데 TUI 에 `//model` 이 들어갔다.
//  진범 = 잔재 청소가 claude(`❯`)만 감지해 codex 는 그냥 통과 → TUI 컴포저에 남아 있던 `/` 위에
//  붙어 버렸다. 채팅 전송의 계약은 "채팅 텍스트 = 제출 본문" 이므로 이건 계약 위반이다.
//  ★ 글자 수는 커서로 잰다: codex 는 빈 컴포저에도 회색 플레이스홀더를 같은 자리에 그려서
//   화면 텍스트만으로는 초안과 구분할 수 없다(실측: 빈 컴포저 커서 x=2, `/mo` 면 x=5).
const { _clearComposerResidue: clearResidue } = require('../cpt-server');

// 진짜 codex 처럼: Backspace 를 받으면 지워지고, 비면 회색 플레이스홀더가 같은 자리에 남는다.
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
  const t = tmuxStub({ line: '› Write tests for @filename', cursor: '2 2' });  // 커서가 프롬프트 바로 뒤 = 비었다
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
