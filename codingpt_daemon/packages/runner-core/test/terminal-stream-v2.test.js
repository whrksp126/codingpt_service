'use strict';

const test = require('node:test');
const assert = require('node:assert');
const V2 = require('../terminal-stream-v2');

test('terminal v2 frame roundtrip preserves opcode, sequence and raw bytes', () => {
  const payload = Buffer.from([0, 27, 91, 65, 255]);
  const frame = V2.encode(V2.OPCODE.OUTPUT, 42, payload);
  const got = V2.decode(frame);
  assert.strictEqual(got.opcode, V2.OPCODE.OUTPUT);
  assert.strictEqual(got.seq, 42);
  assert.deepStrictEqual(got.payload, payload);
});

test('terminal v2 decoder rejects legacy and truncated data', () => {
  assert.strictEqual(V2.decode(Buffer.from('legacy')), null);
  const frame = V2.encode(V2.OPCODE.SNAPSHOT_CHUNK, 1, 'abc');
  assert.strictEqual(V2.decode(frame.subarray(0, frame.length - 1)), null);
});

test('terminal v2 reserves a distinct history page opcode', () => {
  assert.strictEqual(V2.OPCODE.HISTORY_PAGE, 7);
  const got = V2.decode(V2.encode(V2.OPCODE.HISTORY_PAGE, 9, JSON.stringify({ start: 0, rows: [] })));
  assert.strictEqual(got.opcode, 7);
  assert.deepStrictEqual(JSON.parse(got.payload.toString()), { start: 0, rows: [] });
});
