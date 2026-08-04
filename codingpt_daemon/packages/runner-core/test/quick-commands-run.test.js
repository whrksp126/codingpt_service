// qc.run — 저장한 명령의 **실행 경로** 계약.
//
// 이 파일이 고정하는 것(전부 사용자 확정 사양이다):
//  · 경로는 `kind` 로만 갈린다 — 터미널에 에이전트가 떠 있는지 **감지해서 바꾸지 않는다**.
//    감지로 갈리면 같은 버튼이 터미널 상태에 따라 다르게 동작해 예측이 불가능해진다.
//     shell → send-keys 리터럴 + Enter   /   agent → chatInput(bracketed paste 계약)
//  · target 'new' 는 새 셸의 **프롬프트가 그려질 때까지 기다린 뒤** 보낸다(안 기다리면 씹힌다 —
//    launchAgentInTerminal 이 이미 겪은 함정).
//  · target 'current' 인데 tid 가 없으면 조용히 성공하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 타임아웃 경로를 실제로 밟되 초 단위로 기다리지 않는다(값은 cpt-server 가 env 로 열어 둔 탈출구).
process.env.CPT_QC_PROMPT_MS = '600';
process.env.CPT_QC_AGENT_READY_MS = '900';

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-qcr-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

// ── tmux 를 만지지 않도록 pty 를 통째로 대역으로 바꾼다(cpt-server 를 require 하기 전에) ──
const ptyLib = require('../pty');
const calls = { tmux: [], created: 0 };
let agentDetected = true;      // waitAgentReady 가 볼 값
let screenText = '❯ ';         // capture-pane 이 돌려줄 화면
let paneCommand = 'zsh';       // pane_current_command — 셸이면 '비어 있음'으로 본다

ptyLib.runTmux = async (args) => {
  calls.tmux.push(args);
  if (args[0] === 'capture-pane') return screenText;
  if (args[0] === 'display-message') {
    // launchAgentInTerminal 은 두 가지를 묻는다: 지금 뭐가 돌고 있나 / 창 폭이 안정됐나.
    const fmt = args[args.length - 1];
    return fmt.includes('pane_current_command') ? paneCommand : '80';
  }
  return '';
};
ptyLib.sessionForCwd = (cwd) => ({ session: 'cpt-' + (cwd || 'root'), abs: ROOT });
ptyLib.termSession = (ns, tid) => `${ns}--t-${tid}`;
ptyLib.migrateLegacyPool = async () => {};
ptyLib.handleTerminalRpc = async (method) => {
  if (method === 'terminal.new') { calls.created++; return { index: 900 + calls.created, name: 'zsh' }; }
  return {};
};
ptyLib.listTerminals = async () => [{ index: 901, agent: agentDetected }, { index: 902, agent: agentDetected }];

// agents 도 대역으로 — 이 PC 에 claude 가 깔려 있는지와 무관하게 계약을 검증한다.
const agentsLib = require('../agents');
agentsLib.list = async () => [{ id: 'claude', name: 'Claude Code', installed: true, bin: 'claude' }];
agentsLib.launchCommand = () => 'claude';

const cpt = require('../cpt-server');
const QC = require('../quick-commands');

function reset() {
  try { fs.unlinkSync(QC._file()); } catch (_) { /* 없으면 그만 */ }
  calls.tmux = [];
  calls.created = 0;
  agentDetected = true;
  screenText = '❯ ';
  paneCommand = 'zsh';
}

/** send-keys 로 실제 보낸 문자열들(-l 리터럴 페이로드 + 특수키 이름). */
function sentKeys() {
  return calls.tmux.filter((a) => a[0] === 'send-keys').map((a) => a[a.length - 1]);
}

test('shell + current — 리터럴 타이핑 + Enter, 붙여넣기 계약을 타지 않는다', async () => {
  reset();
  const item = QC.upsert({ kind: 'shell', text: 'npm run dev', target: 'current' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app', tid: 901 });
  assert.deepEqual(r, { ok: true, index: 901, ready: true, created: false });
  const keys = sentKeys();
  assert.deepEqual(keys, ['npm run dev', 'Enter']);
  assert.ok(!keys.some((k) => k.includes('[200~')), '셸에는 bracketed paste 를 쓰지 않는다');
  assert.equal(calls.created, 0, '현재 터미널에 보낼 때는 새 터미널을 만들지 않는다');
});

test('agent + current — chatInput 계약(bracketed paste)을 탄다', async () => {
  reset();
  const item = QC.upsert({ kind: 'agent', agent: 'claude', prompt: '배포 전 점검해줘', target: 'current' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app', tid: 902 });
  assert.equal(r.ok, true);
  assert.equal(r.index, 902);
  const pasted = sentKeys().find((k) => k.includes('배포 전 점검해줘'));
  assert.ok(pasted, '프롬프트가 전송돼야 한다');
  assert.ok(pasted.includes('[200~') && pasted.includes('[201~'), 'bracketed paste 로 감싼다');
  assert.ok(sentKeys().includes('Enter'), '제출한다');
});

test('shell + new — 새 터미널을 만들고 프롬프트를 기다린 뒤 보낸다', async () => {
  reset();
  const item = QC.upsert({ kind: 'shell', text: 'npm run dev', target: 'new' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app' });
  assert.equal(r.created, true);
  assert.equal(r.index, 901);
  assert.equal(r.ready, true, '화면이 그려졌으므로 준비됨');
  assert.ok(calls.tmux.some((a) => a[0] === 'capture-pane'), '프롬프트를 확인한다');
  assert.deepEqual(sentKeys(), ['npm run dev', 'Enter']);
});

test('shell + new — 프롬프트가 안 떠도 보내되 ready:false 로 정직하게 알린다', async () => {
  reset();
  screenText = '   \n  \n';   // 아무것도 안 그려진 화면
  const item = QC.upsert({ kind: 'shell', text: 'ls', target: 'new' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app' });
  assert.equal(r.ok, true);
  assert.equal(r.ready, false);
  assert.deepEqual(sentKeys(), ['ls', 'Enter']);
});

test('agent + new — 터미널 생성 → 에이전트 기동 → 준비 대기 → 프롬프트 순서를 지킨다', async () => {
  reset();
  const item = QC.upsert({ kind: 'agent', agent: 'claude', prompt: '리팩터링해줘', target: 'new' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.agent, 'claude');
  assert.equal(r.ready, true);
  assert.equal(calls.created, 1);
  const keys = sentKeys();
  const launchAt = keys.indexOf('claude');
  const promptAt = keys.findIndex((k) => k.includes('리팩터링해줘'));
  assert.ok(launchAt >= 0, '에이전트 실행 명령을 타이핑한다');
  assert.ok(promptAt > launchAt, '프롬프트는 에이전트를 띄운 **뒤에** 보낸다');
});

test('agent + new — 에이전트가 안 뜨면 ready:false 지만 프롬프트는 보낸다', async () => {
  reset();
  agentDetected = false;   // waitAgentReady 가 끝까지 못 본다
  const item = QC.upsert({ kind: 'agent', agent: 'claude', prompt: '점검', target: 'new' }).item;
  const r = await cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app' });
  assert.equal(r.ok, true);
  assert.equal(r.ready, false, '정직하게 알린다');
  assert.ok(sentKeys().some((k) => k.includes('점검')), '그래도 보낸다 — 안 보내면 버튼이 죽은 것으로 보인다');
});

test('current 인데 tid 가 없으면 조용히 성공하지 않는다', async () => {
  reset();
  const item = QC.upsert({ kind: 'shell', text: 'x', target: 'current' }).item;
  await assert.rejects(
    () => cpt.handleQuickCommandsRpc('qc.run', { id: item.id, cwd: 'app' }),
    (e) => e.code === 'BAD_REQUEST',
  );
  assert.deepEqual(sentKeys(), [], '아무 키도 보내지 않는다');
});

test('없는 id 는 NOT_FOUND', async () => {
  reset();
  await assert.rejects(
    () => cpt.handleQuickCommandsRpc('qc.run', { id: 'qc_000000000000', cwd: 'app' }),
    (e) => e.code === 'NOT_FOUND',
  );
});

// ── 조회·편집 RPC ─────────────────────────────────────────────────────────────
test('qc.list — ws 를 주면 전역 + 그 워크스페이스, 안 주면 전역만', async () => {
  reset();
  QC.upsert({ kind: 'shell', text: 'git status' });
  QC.upsert({ kind: 'shell', text: 'npm run android', ws: 'app' });
  assert.equal((await cpt.handleQuickCommandsRpc('qc.list', { ws: 'app' })).items.length, 2);
  assert.equal((await cpt.handleQuickCommandsRpc('qc.list', { ws: 'other' })).items.length, 1);
  assert.equal((await cpt.handleQuickCommandsRpc('qc.list', {})).items.length, 1);
});

test('qc.save 실패는 BAD_REQUEST 로 올라온다(조용한 성공 금지)', async () => {
  reset();
  await assert.rejects(
    () => cpt.handleQuickCommandsRpc('qc.save', { item: { kind: 'shell', text: '  ' } }),
    (e) => e.code === 'BAD_REQUEST',
  );
});

test('qc.save/remove 는 갱신된 전체 목록을 함께 돌려준다(재조회 왕복 제거)', async () => {
  reset();
  const saved = await cpt.handleQuickCommandsRpc('qc.save', { item: { kind: 'shell', text: 'a' } });
  assert.equal(saved.items.length, 1);
  const removed = await cpt.handleQuickCommandsRpc('qc.remove', { id: saved.item.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.items.length, 0);
});

test('qc.listAll 은 상한값을 같이 준다(클라가 글자수 제한을 하드코딩하지 않게)', async () => {
  reset();
  const r = await cpt.handleQuickCommandsRpc('qc.listAll', {});
  assert.equal(r.limits.maxItems, QC.MAX_ITEMS);
  assert.equal(r.limits.maxLabel, QC.MAX_LABEL);
  assert.equal(r.limits.maxShellText, QC.MAX_SHELL_TEXT);
  assert.equal(r.limits.maxAgentPrompt, QC.MAX_AGENT_PROMPT);
});

test('모르는 qc.* 는 오류다', async () => {
  reset();
  await assert.rejects(() => cpt.handleQuickCommandsRpc('qc.nope', {}), /알 수 없는 명령/);
});
