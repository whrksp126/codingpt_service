// chat.mode(에이전트 권한 모드 전환) 회귀 — driveMode 를 io 주입으로 검증한다.
//
// 정본은 **격리 tmux 의 진짜 claude 2.1.220 실측**(2026-08-01, 40·60컬럼):
//  · shift+tab(BTab) 이 한 방향 순환: manual → accept edits → plan → auto → manual …
//    (bypass 는 --dangerously-skip-permissions 세션에서만 낌 → 순서를 코드에 박지 않는다)
//  · 푸터 라벨은 폭이 좁아도 안 잘린다(힌트가 먼저 잘림) → 화면 파싱이 판정 정본
// 이 테스트가 고정하는 것: 목표에 도달하면 **더 누르지 않는다**, 도달 못 하면 조용히 성공하지
//  않는다(모드가 틀린 채 "바꿨습니다"가 최악), 다이얼로그 위에서는 **키를 한 개도 보내지 않는다**.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cm-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const { _driveMode: driveMode } = require('../cpt-server');

const RULE = '────────────────────────────────────────────────';
const STATUS = '   ◆ Opus 5 (1M context)  ███░░░░░░░░░ 31% 31…';
// 실캡처 형태 그대로(좁은 폭 = 푸터가 감싸져 꼬리 `--` 가 따라온다).
const FOOTER = {
  default: '  -- INSERT --  ⏸ manual mode on · ← for agents',
  acceptEdits: '  -- INSERT ⏵⏵ accept edits on (shift+tab to  · ←…',
  plan: '  -- INSERT   ⏸ plan mode on (shift+tab to cycle) · ←…',
  auto: '  -- INSERT   ⏵⏵ auto mode on (shift+tab to cycle) · ←…',
};
const screenOf = (mode) => ['본문', RULE, '❯ ', RULE, STATUS, FOOTER[mode], '  --', ''].join('\n');

// 진짜 순환을 흉내내는 io — BTab 마다 다음 모드로 넘어간다(실측 순서).
function cycleIo(start, order = ['default', 'acceptEdits', 'plan', 'auto']) {
  const keys = [];
  let idx = order.indexOf(start);
  return {
    keys,
    screen: async () => screenOf(order[idx]),
    key: async (k) => { keys.push(k); if (k === 'BTab') idx = (idx + 1) % order.length; },
    sleep: async () => {},
  };
}

test('목표 모드까지 BTab 을 정확히 필요한 만큼만 누른다', async () => {
  const io = cycleIo('default');
  const r = await driveMode(io, { mode: 'plan' });
  assert.strictEqual(r.mode.id, 'plan');
  assert.strictEqual(r.mode.label, 'plan mode on', '라벨은 TUI 원문 그대로');
  assert.deepStrictEqual(io.keys, ['BTab', 'BTab']);
});

test('이미 그 모드면 키를 한 개도 보내지 않는다', async () => {
  const io = cycleIo('auto');
  const r = await driveMode(io, { mode: 'auto' });
  assert.strictEqual(r.mode.id, 'auto');
  assert.deepStrictEqual(io.keys, []);
});

test('한 바퀴 돌아 목표를 지나쳐도 결국 도달한다(순환)', async () => {
  const io = cycleIo('acceptEdits');
  const r = await driveMode(io, { mode: 'default' });
  assert.strictEqual(r.mode.id, 'default');
  assert.deepStrictEqual(io.keys, ['BTab', 'BTab', 'BTab']);
});

test('이 세션에 없는 모드(bypass)는 조용히 성공하지 않는다', async () => {
  const io = cycleIo('default');
  await assert.rejects(() => driveMode(io, { mode: 'bypassPermissions' }), (e) => e.code === 'MODE_UNREACHABLE');
  assert.ok(io.keys.length <= 6, '한 바퀴 상한에서 멈춘다');
});

test('다이얼로그가 떠 있으면 키를 한 개도 보내지 않는다', async () => {
  const io = {
    keys: [],
    screen: async () => '무엇을 할까요?\n1. 봄\n2. 여름\nEnter to select · Tab/Arrow keys to navigate',
    key: async (k) => { io.keys.push(k); },
    sleep: async () => {},
  };
  await assert.rejects(() => driveMode(io, { mode: 'plan' }), (e) => e.code === 'MODE_BLOCKED');
  assert.deepStrictEqual(io.keys, []);
});

test('모드를 읽을 수 없는 화면이면 실패(추측 조작 금지)', async () => {
  const io = { keys: [], screen: async () => '$ ls\n', key: async (k) => { io.keys.push(k); }, sleep: async () => {} };
  await assert.rejects(() => driveMode(io, { mode: 'plan' }), (e) => e.code === 'MODE_UNKNOWN');
  assert.deepStrictEqual(io.keys, []);
});

test('알 수 없는 모드 id 는 요청 자체를 거절한다', async () => {
  const io = cycleIo('default');
  await assert.rejects(() => driveMode(io, { mode: 'yolo' }), (e) => e.code === 'BAD_REQUEST');
  assert.deepStrictEqual(io.keys, []);
});

// ── 앱 내부용 명령은 워크스페이스 컨텍스트 게이트를 타지 않는다(2026-08-02 실사고) ──
// PC 앱이 로컬 데몬 소켓으로 부르는 status.poke / chat.mode 는 "cpt 오사용 방지" 게이트
//  (터미널에서 실행되는 cpt 를 위한 것)에 걸려 조용히 실패했다 — 그래서 PC 의 즉시 반영이 무효였다.
//  sync.checkpoint·forward.*·agents.* 와 같은 자리(resolveCtx 이전)에 두는 것이 정답이고,
//  이 테스트가 그 자리를 고정한다(다시 switch 안으로 옮기면 즉시 빨간불).
const { _dispatch: dispatch } = require('../cpt-server');

test('앱 내부용 명령(status.poke/chat.mode)은 컨텍스트 게이트 밖에서도 도달한다', async () => {
  const ptyLib = require('../pty');
  const orig = ptyLib.runTmux;
  const calls = [];
  ptyLib.runTmux = async (args) => {
    calls.push(args[0]);
    if (args[0] === 'capture-pane') return ['본문', '─'.repeat(20), '❯ ', '─'.repeat(20), '  -- INSERT -- ⏸ plan mode on'].join('\n');
    return '';
  };
  try {
    // ctx 없음 = 워크스페이스 밖(옛 코드에서 OUT_OF_CONTEXT 로 거부되던 상황)
    const poke = await dispatch({ cmd: 'status.poke', args: { cwd: 'x/y', tid: 4242 } });
    assert.deepStrictEqual(poke, { ok: true });
    const mode = await dispatch({ cmd: 'chat.mode', args: { cwd: 'x/y', tid: 4242 } });
    assert.strictEqual(mode.mode.id, 'plan', '조회는 화면을 읽어 현재 모드를 준다');
    assert.ok(calls.includes('capture-pane'), '실제로 화면을 읽는다');
  } finally { ptyLib.runTmux = orig; }
});

test('알 수 없는 명령은 그대로 거부된다(통로를 넓히지 않았다)', async () => {
  await assert.rejects(() => dispatch({ cmd: 'chat.input', args: {} }), (e) => /OUT_OF_CONTEXT|워크스페이스|BAD_REQUEST|알 수 없는/.test(String(e.code || e.message)));
});
