'use strict';

// 터미널 스트림 v3(CPT3) — 헤더는 v2 와 같은 12바이트(MAGIC 4 + ver 1 + opcode 1 + seq 4 + len 2… 아님,
//  아래 HEADER 참조). v2 와 MAGIC 이 달라 서로 오인하지 않는다. 설계: docs/terminal-v3-design.md §3.
//
// 서버→클라(바이너리):
//   OUTPUT       원시 PTY 바이트. seq 는 이 opcode 에서만 단조 증가(재접속 이어받기 기준).
//   SNAPSHOT     JSON {cols,rows,owner,modes,cursor,seq,ansi} — 붙을 때·크기 바뀔 때·이어받기 불가 시.
//   RESIZED      JSON {cols,rows} — 소유자가 크기를 바꿨다. 모든 뷰어는 xterm 을 이 크기로.
//   OWNER        JSON {deviceId,name,self} — 소유자 변경. self=true 면 받는 뷰어 자신이 소유자.
//   HISTORY_PAGE JSON {start,end,total,rows:[{offset,text,ansi}]}
//   EXIT         JSON {code}
//   ERROR        JSON {message}
// 클라→서버(텍스트 JSON 한 줄): {type:'hello',lastSeq} · {type:'input',data(base64)} · {type:'resize',cols,rows}
//   · {type:'claim'} · {type:'history',before,limit} · {type:'keepalive'}
const MAGIC = Buffer.from('CPT3');
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 1 + 4 + 4; // magic, version, opcode, seq(u32), len(u32)

const OPCODE = Object.freeze({
  OUTPUT: 1,
  SNAPSHOT: 2,
  RESIZED: 3,
  OWNER: 4,
  HISTORY_PAGE: 5,
  EXIT: 6,
  ERROR: 7,
});

function encode(opcode, seq, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : String(payload));
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  MAGIC.copy(out, 0);
  out[4] = VERSION;
  out[5] = opcode | 0;
  out.writeUInt32BE(seq >>> 0, 6);
  out.writeUInt32BE(body.length >>> 0, 10);
  body.copy(out, HEADER_BYTES);
  return out;
}

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) return null;
  if (!buf.subarray(0, 4).equals(MAGIC) || buf[4] !== VERSION) return null;
  const len = buf.readUInt32BE(10);
  if (buf.length < HEADER_BYTES + len) return null;
  return { opcode: buf[5], seq: buf.readUInt32BE(6), payload: buf.subarray(HEADER_BYTES, HEADER_BYTES + len) };
}

module.exports = { MAGIC, VERSION, HEADER_BYTES, OPCODE, encode, decode };
