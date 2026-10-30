'use strict';
// 외부 연동(external.js) — 세션 소유 격리·허용 폴더·승인 없이 실행 게이트. conv 엔진은 가짜로 바꾼다.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-ext-')));
const runtime = require('../runtime');
runtime.init({ ...runtime.get(), stateDir: path.join(tmpHome, 'state'), root: tmpHome });
fs.mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'allowed/app'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'secret'), { recursive: true });
fs.symlinkSync(path.join(tmpHome, 'secret'), path.join(tmpHome, 'allowed/link'));

const conv = require('../conv');
const calls = [];
let seq = 0;
const modes = {};
conv.rpc = async (method, p) => {
  calls.push({ method, p });
  if (method === 'conv.create') { seq++; modes['t' + seq] = p.mode; return { thread: { id: 't' + seq, agent: 'claude', state: 'working', title: '', mode: p.mode }, seq: 1 }; }
  if (method === 'conv.set') return { thread: { id: p.threadId, state: 'working', title: p.title, mode: p.mode || modes[p.threadId] } };
  if (method === 'conv.since') return { thread: { id: p.threadId, state: 'waiting' }, events: [{ seq: 5, op: 'msg', msg: { key: 'm', role: 'assistant' } }, { seq: 6, op: 'state', state: 'idle' }, { seq: 7, op: 'req', req: { id: 'r1' } }], live: [], pending: [{ id: 'r1' }] };
  return { ok: true };
};
const X = require('../external');
const A = { keyId: 1, keyName: '쇼핑몰', paths: [path.join(tmpHome, 'allowed')], allowBypass: false };
const B = { keyId: 2, keyName: '다른키', paths: [], allowBypass: true };
const ok = (m, p) => X.handle(m, p);
const code = async (m, p) => { try { await ok(m, p); return null; } catch (e) { return e.code; } };

test('키 없이는 아무것도 못 한다', async () => {
  assert.strictEqual(await code('ext.list', {}), 'UNAUTHORIZED');
});

test('허용 폴더 밖·심링크로 빠져나가는 경로를 막는다', async () => {
  assert.strictEqual(await code('ext.create', { auth: A, cwd: path.join(tmpHome, 'secret') }), 'PATH_NOT_ALLOWED');
  assert.strictEqual(await code('ext.create', { auth: A, cwd: path.join(tmpHome, 'allowed/link') }), 'PATH_NOT_ALLOWED');
  assert.strictEqual(await code('ext.create', { auth: A, cwd: path.join(tmpHome, 'allowed-evil') }), 'PATH_NOT_ALLOWED');
});

test('승인 없이 실행은 키가 허용해야 한다', async () => {
  const cwd = path.join(tmpHome, 'allowed/app');
  assert.strictEqual(await code('ext.create', { auth: A, cwd, mode: 'bypassPermissions' }), 'BYPASS_NOT_ALLOWED');
  const { session } = await ok('ext.create', { auth: B, cwd, mode: 'bypassPermissions' });
  assert.strictEqual(session.mode, 'bypassPermissions');
  assert.strictEqual(await code('ext.set', { auth: A, id: session.id, mode: 'dontAsk' }), 'SESSION_NOT_FOUND');
});

test('다른 키의 세션은 없는 세션이다 — 읽기·이어가기·답하기·지우기 전부', async () => {
  const cwd = path.join(tmpHome, 'allowed/app');
  const { session } = await ok('ext.create', { auth: A, cwd, prompt: '고쳐', title: '문구' });
  for (const m of ['ext.get', 'ext.send', 'ext.respond', 'ext.interrupt', 'ext.stop', 'ext.delete']) {
    assert.strictEqual(await code(m, { auth: B, id: session.id, text: 'x' }), 'SESSION_NOT_FOUND', m);
  }
  assert.ok(!(await ok('ext.list', { auth: B })).sessions.some((s) => s.id === session.id));
  assert.ok((await ok('ext.list', { auth: A })).sessions.some((s) => s.id === session.id));
  //  표에 없는 대화(사람이 CodingPT 에서 하던 것)도 마찬가지다
  assert.strictEqual(await code('ext.get', { auth: A, id: 'human-thread' }), 'SESSION_NOT_FOUND');
});

test('이벤트는 공개 모양으로, 승인은 호출자에게 그대로 간다', async () => {
  const { session } = await ok('ext.create', { auth: A, cwd: path.join(tmpHome, 'allowed/app') });
  const r = await ok('ext.get', { auth: A, id: session.id, after: 4 });
  assert.deepStrictEqual(r.events.map((e) => e.type), ['message', 'request']);
  assert.strictEqual(r.cursor, 7);
  assert.deepStrictEqual(r.pending, [{ id: 'r1' }]);
  await ok('ext.respond', { auth: A, id: session.id, requestId: 'r1', decision: 'allow' });
  const c = calls.filter((x) => x.method === 'conv.respond').pop();
  assert.strictEqual(c.p.reqId, 'r1');
  assert.strictEqual(c.p.by, '쇼핑몰');
});

test('같은 clientId 는 세션을 하나만 만든다', async () => {
  const cwd = path.join(tmpHome, 'allowed/app');
  const a = await ok('ext.create', { auth: A, cwd, clientId: 'req-1' });
  const b = await ok('ext.create', { auth: A, cwd, clientId: 'req-1' });
  assert.strictEqual(a.session.id, b.session.id);
});

test('사람도 볼 수 있게 대화 탭을 열고, 지우면 닫는다', async () => {
  const S = require('../surfaces');
  const cwd = path.join(tmpHome, 'allowed/app');
  const { session } = await ok('ext.create', { auth: A, cwd, title: '문구' });
  assert.ok(S.list({ cwd }).items.some((i) => i.id === 'c-' + session.id && i.kind === 'chat'));
  assert.ok(calls.some((c) => c.method === 'conv.set' && /^\[쇼핑몰\] 문구/.test(c.p.title)));
  await ok('ext.delete', { auth: A, id: session.id });
  assert.ok(!S.list({ cwd }).items.some((i) => i.id === 'c-' + session.id));
});

test('worktree — 전용 브랜치를 만들고 지워도 남긴다', async () => {
  const { execFileSync } = require('child_process');
  const repo = path.join(tmpHome, 'allowed/repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x');
  const { session } = await ok('ext.create', { auth: A, cwd: repo, worktree: { branch: 'fix/copy', base: 'main' } });
  assert.strictEqual(session.branch, 'fix/copy');
  assert.ok(session.cwd.startsWith(X._internals.worktreesDir()));
  assert.ok(fs.existsSync(session.cwd));
  const r = await ok('ext.delete', { auth: A, id: session.id });
  assert.strictEqual(r.keptBranch, 'fix/copy');
  assert.ok(fs.existsSync(session.cwd));
  assert.strictEqual(await code('ext.create', { auth: A, cwd: repo, worktree: { branch: '../evil' } }), 'BAD_REQUEST');
});

test('이 PC 에서 끄면 전부 막힌다', async () => {
  process.env.CPT_EXTERNAL = '0';
  assert.strictEqual(await code('ext.list', { auth: A }), 'EXTERNAL_DISABLED');
  delete process.env.CPT_EXTERNAL;
});

test('키 관리 — 원문은 파일로만, 응답에는 경로뿐, 프로젝트에는 경로만', async () => {
  const cptServer = require('../cpt-server');
  const config = require('../config');
  const origLoad = config.load;
  config.load = () => ({ deviceId: 9, serverUrl: 'http://back.test' });
  const SECRET = 'cptx_secret_value';
  const keys = [];
  cptServer.backFetch = async (method, p, body) => {
    if (method === 'POST' && p === '/api/daemon/api-keys') {
      const key = { id: keys.length + 1, name: body.name, prefix: 'cptx_secret', deviceId: 9, allowedPaths: body.allowedPaths, allowBypass: !!body.allowBypass };
      keys.push(key);
      return { key, secret: SECRET };
    }
    if (method === 'GET') return { keys: keys.concat([{ id: 99, name: '다른PC', deviceId: 1, allowedPaths: [] }]) };
    if (method === 'DELETE') { keys.splice(keys.findIndex((k) => p.endsWith('/' + k.id)), 1); return { ok: true }; }
    return {};
  };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => 'FILE' });
  try {
    const dir = path.join(tmpHome, 'allowed/app');
    const r = await X.local('external.connect', { dir, mcp: true });
    assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.deepStrictEqual(r.allowedPaths, [dir]);
    assert.strictEqual(fs.readFileSync(r.keyFile, 'utf8').trim(), SECRET);
    assert.strictEqual(fs.statSync(r.keyFile).mode & 0o777, 0o600);
    const cfg = fs.readFileSync(path.join(dir, '.codingpt.json'), 'utf8');
    assert.ok(!cfg.includes(SECRET));
    assert.strictEqual(JSON.parse(cfg).keyFile, r.keyFile);
    assert.ok(fs.existsSync(path.join(dir, '.claude/skills/codingpt/SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'codingpt.mjs')));
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.codingpt);
    //  다시 연결하면 키를 또 만들지 않는다
    assert.strictEqual((await X.local('external.connect', { dir })).reused, true);
    assert.strictEqual(keys.length, 1);
    //  다른 PC 의 키는 목록에 없고, 폐기하면 파일도 사라진다
    assert.deepStrictEqual((await X.local('external.keyList')).keys.map((k) => k.id), [1]);
    await X.local('external.keyRevoke', { target: 'app' });
    assert.ok(!fs.existsSync(r.keyFile));
    await assert.rejects(X.local('external.keyRevoke', { target: 'app' }), (e) => e.code === 'KEY_NOT_FOUND');
  } finally { config.load = origLoad; global.fetch = origFetch; }
});
