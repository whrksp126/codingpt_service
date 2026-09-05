// 터미널 스트림 v3(CPT3) 디코더 — 데몬 runner-core/terminal-stream-v3.js 와 바이트 단위로 같은 계약.
//  헤더 14B: MAGIC 'CPT3' · ver(1) · opcode(1) · seq(u32 BE) · len(u32 BE). 설계: daemon/docs/terminal-v3-design.md §3.
const MAGIC = [0x43, 0x50, 0x54, 0x33];
const HEADER_BYTES = 14;
export const TERMINAL_OPCODE_V3 = Object.freeze({ OUTPUT: 1, SNAPSHOT: 2, RESIZED: 3, OWNER: 4, HISTORY_PAGE: 5, EXIT: 6, ERROR: 7 });

export function decodeTerminalFrameV3(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < HEADER_BYTES) return null;
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC[i]) return null;
  if (u8[4] !== 1) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = dv.getUint32(10);
  if (u8.length < HEADER_BYTES + len) return null;
  return { opcode: u8[5], seq: dv.getUint32(6), payload: u8.subarray(HEADER_BYTES, HEADER_BYTES + len) };
}
