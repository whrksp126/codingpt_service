'use strict';

const MAGIC = Buffer.from('CPT2');
const VERSION = 1;
const HEADER_BYTES = 16;

const OPCODE = Object.freeze({
  OUTPUT: 1,
  SNAPSHOT_START: 2,
  SNAPSHOT_CHUNK: 3,
  SNAPSHOT_END: 4,
  RESIZED: 5,
  METADATA: 6,
  HISTORY_PAGE: 7,
});

function encode(opcode, seq, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : String(payload));
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  MAGIC.copy(out, 0);
  out[4] = VERSION;
  out[5] = opcode;
  out.writeUInt16LE(0, 6);
  out.writeUInt32LE(Math.max(0, Number(seq) || 0) >>> 0, 8);
  out.writeUInt32LE(body.length >>> 0, 12);
  body.copy(out, HEADER_BYTES);
  return out;
}

function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < HEADER_BYTES || !b.subarray(0, 4).equals(MAGIC) || b[4] !== VERSION) return null;
  const len = b.readUInt32LE(12);
  if (b.length !== HEADER_BYTES + len) return null;
  return { opcode: b[5], seq: b.readUInt32LE(8), payload: b.subarray(HEADER_BYTES) };
}

module.exports = { MAGIC, VERSION, HEADER_BYTES, OPCODE, encode, decode };
