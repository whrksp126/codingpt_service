import assert from 'node:assert/strict';
import { decodeTerminalFrame, TERMINAL_OPCODE } from '../src/js/terminal-stream-v2.js';

const body = new Uint8Array([0, 27, 255]);
const frame = new Uint8Array(16 + body.length);
frame.set([67, 80, 84, 50, 1, TERMINAL_OPCODE.OUTPUT], 0);
const view = new DataView(frame.buffer);
view.setUint32(8, 9, true);
view.setUint32(12, body.length, true);
frame.set(body, 16);
const got = decodeTerminalFrame(frame);
assert.equal(got.seq, 9);
assert.deepEqual([...got.payload], [...body]);
assert.equal(decodeTerminalFrame(new Uint8Array([1, 2, 3])), null);
console.log('PASS terminal stream v2 decoder');
