'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CanonicalTerminalRegistry } = require('../canonical-terminal');

function fakeBackend() {
  const state = { attaches: 0, options: null, writes: [], resizes: [] };
  return {
    state,
    async attach(_name, options) {
      state.attaches++;
      state.options = options;
      return {
        write(data) { state.writes.push(String(data)); },
        resize(cols, rows) { state.resizes.push([cols, rows]); },
        close() {},
      };
    },
  };
}

test('터미널 id 하나는 backend attach와 VT 정본을 하나만 가진다', async () => {
  const backend = fakeBackend();
  const registry = new CanonicalTerminalRegistry(backend);
  const a = registry.get('term-1', { cols: 80, rows: 24 });
  const b = registry.get('term-1', { cols: 120, rows: 40 });
  await a.ready;
  assert.strictEqual(a, b);
  assert.equal(backend.state.attaches, 1);
});

test('모든 구독자가 같은 output sequence를 받고 snapshot도 같은 VT에서 나온다', async () => {
  const backend = fakeBackend();
  const model = new CanonicalTerminalRegistry(backend).get('term-2', { cols: 20, rows: 5 });
  await model.ready;
  const one = [], two = [];
  model.subscribe((f) => one.push(f));
  model.subscribe((f) => two.push(f));
  backend.state.options.onData('hello\r\nworld');
  assert.equal(one.length, 1);
  assert.equal(two.length, 1);
  assert.equal(one[0].seq, two[0].seq);
  assert.equal(one[0].payload.toString(), 'hello\r\nworld');
  const snapshot = await model.snapshot();
  assert.equal(snapshot.seq, 1);
  assert.equal(snapshot.cols, 20);
  assert.match(snapshot.ansi, /hello/);
});

test('입력과 resize는 단일 backend handle로만 전달된다', async () => {
  const backend = fakeBackend();
  const model = new CanonicalTerminalRegistry(backend).get('term-3', { cols: 80, rows: 24 });
  await model.write('echo ok\r');
  assert.equal(await model.resize(100, 30), true);
  assert.equal(await model.resize(100, 30), false);
  assert.deepEqual(backend.state.writes, ['echo ok\r']);
  assert.deepEqual(backend.state.resizes, [[100, 30]]);
});

test('history paging은 현재 viewport와 분리된 절대 offset을 사용한다', async () => {
  const backend = fakeBackend();
  const model = new CanonicalTerminalRegistry(backend).get('term-4', { cols: 10, rows: 3 });
  await model.ready;
  backend.state.options.onData('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n');
  await model.screen.flush();
  const page = await model.historyPage({ limit: 2 });
  assert.ok(page.total >= 2);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].offset, page.start);
  assert.equal(page.end, page.total);
  const older = await model.historyPage({ before: page.start, limit: 2 });
  assert.equal(older.end, page.start);
});

test('기존 backend history를 canonical VT 생성 시 한 번 seed한다', async () => {
  const backend = fakeBackend();
  backend.captureHistory = async () => 'old-1\nold-2\nold-3\nold-4';
  backend.capture = async () => 'current';
  const model = new CanonicalTerminalRegistry(backend).get('term-seed', { cols: 20, rows: 3 });
  await model.ready;
  const page = await model.historyPage({ limit: 20 });
  assert.ok(page.total >= 4, `seed history가 부족함: ${page.total}`);
  assert.ok(page.rows.some((r) => r.text.includes('old-1')));
  const snap = await model.snapshot();
  assert.match(snap.ansi, /current/);
});

test('canonical VT가 생성한 DA 응답을 단일 backend 입력으로 반환한다', async () => {
  const backend = fakeBackend();
  const model = new CanonicalTerminalRegistry(backend).get('term-da', { cols: 80, rows: 24 });
  await model.ready;
  backend.state.options.onData('\x1b[c');
  await model.screen.flush();
  assert.ok(backend.state.writes.some((s) => /\x1b\[\?/.test(s)), `DA 응답 없음: ${JSON.stringify(backend.state.writes)}`);
});

test('마지막 구독자가 떠나면 VT와 backend attach를 회수한다', async () => {
  const backend = fakeBackend();
  let closed = 0;
  const attach = backend.attach;
  backend.attach = async (name, options) => {
    const h = await attach(name, options);
    return { ...h, close() { closed++; } };
  };
  const registry = new CanonicalTerminalRegistry(backend, { idleMs: 20 });
  const model = registry.get('term-idle', { cols: 40, rows: 10 });
  await model.ready;
  const offA = model.subscribe(() => {});
  const offB = model.subscribe(() => {});

  offA();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(closed, 0, '구독자가 남아 있는데 회수했다');
  assert.equal(registry.terminals.size, 1);

  offB();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(closed, 1, '마지막 구독자 이탈 뒤에도 backend attach 가 살아 있다');
  assert.equal(model.disposed, true);
  assert.equal(registry.terminals.size, 0, '회수된 모델이 registry 에 남아 있다');
});

test('유예 안에 새 뷰어가 붙으면 회수를 취소하고 같은 VT를 계속 쓴다', async () => {
  const backend = fakeBackend();
  const registry = new CanonicalTerminalRegistry(backend, { idleMs: 40 });
  const model = registry.get('term-revive', { cols: 40, rows: 10 });
  await model.ready;
  const off = model.subscribe(() => {});
  off();
  await new Promise((r) => setTimeout(r, 10));
  model.subscribe(() => {});                     // 유예 안 재접속
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(model.disposed, false, '재접속했는데 회수됐다');
  assert.equal(registry.get('term-revive'), model);
  assert.equal(backend.state.attaches, 1, 're-attach 가 일어났다');
});

test('세션이 죽으면 exit 통지 후 VT와 registry 엔트리를 즉시 정리한다', async () => {
  const backend = fakeBackend();
  const registry = new CanonicalTerminalRegistry(backend, { idleMs: 10000 });
  const model = registry.get('term-dead', { cols: 40, rows: 10 });
  await model.ready;
  const seen = [];
  model.subscribe((f) => seen.push(f.type));
  backend.state.options.onExit(3);
  assert.deepEqual(seen, ['exit']);
  assert.equal(model.disposed, true, '세션 종료 뒤 VT 가 dispose 되지 않았다');
  assert.equal(registry.terminals.size, 0);
});

test('history page는 라이브 화면과 같은 SGR을 보존한다', async () => {
  const backend = fakeBackend();
  const model = new CanonicalTerminalRegistry(backend).get('term-color', { cols: 30, rows: 3 });
  await model.ready;
  backend.state.options.onData('\x1b[31mRED\x1b[0m tail\r\nplain\r\nx\r\ny\r\nz\r\n');
  await model.screen.flush();
  const page = await model.historyPage({ limit: 10 });
  const red = page.rows.find((r) => r.text.startsWith('RED'));
  assert.ok(red, 'RED 행이 history에 없다');
  assert.match(red.ansi, /\x1b\[38;5;1mRED\x1b\[0m tail/, `색이 유실됐다: ${JSON.stringify(red.ansi)}`);
  const plain = page.rows.find((r) => r.text.startsWith('plain'));
  assert.strictEqual(plain.ansi, 'plain', '색 없는 행에 불필요한 SGR이 붙었다');
});
