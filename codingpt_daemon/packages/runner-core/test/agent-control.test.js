'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.CODINGPT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'actl-'));
const runtime = require('../runtime');
runtime.stateDir = () => process.env.CODINGPT_STATE_DIR;
const orch = require('../orch');
const state = require('../agent-state');
const ctl = require('../agent-control');

const sent = [];
let rec = { key: 'cpt-a--t-1', tid: 1, cwdRel: 'p', agent: 'claude', state: 'idle', version: 1 };
state.snapshot = () => [rec];
orch.deps = () => ({
  createTerminal: async () => ({ tid: 1, tsession: 'cpt-a--t-1' }),
  launch: async () => ({ ok: true }),
  probe: async () => ({ exists: true, shell: false, attached: true }),
  chatInput: async (a) => { sent.push(a.text); rec = { ...rec, state: 'working', version: 2 }; },
  keys: async (a) => sent.push(a.keys),
  read: async () => 'screen',
  closeTerminal: async () => {},
  agents: { list: async () => [{ id: 'claude', installed: true }, { id: 'codex', installed: false }] },
});
orch.waitAgentLive = async () => true;

test('이름으로 시작하고 지시한다', async () => {
  const a = await ctl.handle('actl.start', { name: 'rev', kind: 'claude', cwd: '~/p' });
  assert.equal(a.ready, true);
  assert.equal(a.cwd, 'p');
  const r = await ctl.handle('actl.prompt', { target: 'rev', text: '봐 줘' });
  assert.equal(r.active, true);
  assert.deepEqual(sent, ['봐 줘']);
});

test('이미 쓰는 이름·안 깔린 에이전트·잘못된 이름을 거른다', async () => {
  await assert.rejects(ctl.handle('actl.start', { name: 'rev' }), { code: 'AGENT_NAME_TAKEN' });
  await assert.rejects(ctl.handle('actl.start', { name: 'x', kind: 'codex' }), { code: 'AGENT_NOT_INSTALLED' });
  await assert.rejects(ctl.handle('actl.start', { name: 'Bad Name' }), { code: 'BAD_PARAMS' });
});

test('승인을 기다리는 에이전트에게는 글을 넣지 않는다', async () => {
  rec = { ...rec, state: 'permission' };
  const n = sent.length;
  await assert.rejects(ctl.handle('actl.prompt', { target: 'rev', text: 'x' }), { code: 'AGENT_BLOCKED' });
  assert.equal(sent.length, n);
});

test('논리 키를 tmux 키로 바꾸고 모르는 키는 거부한다', async () => {
  await ctl.handle('actl.sendKeys', { target: 'rev', keys: ['esc', 'ctrl+c', '1'] });
  assert.deepEqual(sent[sent.length - 1], ['Escape', 'C-c', '1']);
  await assert.rejects(ctl.handle('actl.sendKeys', { target: 'rev', keys: ['hyper+x'] }), { code: 'BAD_PARAMS' });
});

test('다른 PC 로는 actl.* 만 보낸다', async () => {
  await assert.rejects(ctl.peerCall('x', 'terminal.send', {}), { code: 'BAD_METHOD' });
});

test('이름 없는 대상은 --force 없이 닫지 않는다', async () => {
  rec = { ...rec, state: 'idle' };
  await assert.rejects(ctl.handle('actl.stop', { target: 'cpt-a--t-1' }), { code: 'AGENT_NOT_OWNED' });
  assert.equal((await ctl.handle('actl.stop', { target: 'rev' })).ok, true);
});

test('사라진 터미널의 이름은 지운다', async () => {
  await ctl.handle('actl.start', { name: 'gone', kind: 'claude' });
  const d = orch.deps();
  orch.deps = () => ({ ...d, probe: async () => ({ exists: false }) });
  await assert.rejects(ctl.handle('actl.get', { target: 'gone' }), { code: 'AGENT_NOT_FOUND' });
  orch.deps = () => d;
  await assert.rejects(ctl.handle('actl.get', { target: 'gone' }), { code: 'AGENT_NOT_FOUND' });
});
