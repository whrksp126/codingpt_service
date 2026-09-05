'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanonicalStream } = require('../canonical-stream');

test('snapshot과 live 경계에서 출력이 중복·유실되지 않는다', async () => {
  let subscriber = null;
  const model = {
    seq: 4,
    subscribe(fn) { subscriber = fn; return () => { subscriber = null; }; },
    async snapshot() {
      // snapshot 생성 중 seq=5 출력이 도착하는 경쟁.
      this.seq = 5;
      subscriber({ type: 'output', seq: 5, payload: Buffer.from('five') });
      return { seq: 4, ansi: 'snapshot', cols: 80, rows: 24 };
    },
    write() {}, resize() {},
  };
  const order = [];
  const stream = await openCanonicalStream({ get: () => model }, 't', {
    onSnapshot: (s) => order.push(`snapshot:${s.seq}`),
    onOutput: (f) => order.push(`output:${f.seq}`),
  });
  assert.deepEqual(order, ['snapshot:4', 'output:5']);
  subscriber({ type: 'output', seq: 6, payload: Buffer.from('six') });
  assert.deepEqual(order, ['snapshot:4', 'output:5', 'output:6']);
  stream.close();
});

test('snapshot에 이미 포함된 sequence는 pending queue에서 폐기한다', async () => {
  let subscriber;
  const model = {
    subscribe(fn) { subscriber = fn; return () => {}; },
    async snapshot() {
      subscriber({ type: 'output', seq: 7, payload: Buffer.from('included') });
      return { seq: 7, ansi: 'snapshot' };
    },
    write() {}, resize() {},
  };
  const seen = [];
  await openCanonicalStream({ get: () => model }, 't', { onOutput: (f) => seen.push(f.seq) });
  assert.deepEqual(seen, []);
});
