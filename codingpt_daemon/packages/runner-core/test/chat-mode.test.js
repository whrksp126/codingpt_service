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
