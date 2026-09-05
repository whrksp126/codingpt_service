const HEADER_BYTES = 16;

export function decodeTerminalFrame(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (b.length < HEADER_BYTES || b[0] !== 67 || b[1] !== 80 || b[2] !== 84 || b[3] !== 50 || b[4] !== 1) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = view.getUint32(12, true);
  if (b.length !== HEADER_BYTES + len) return null;
  return { opcode: b[5], seq: view.getUint32(8, true), payload: b.slice(HEADER_BYTES) };
}

export const TERMINAL_OPCODE = Object.freeze({ OUTPUT: 1, SNAPSHOT_START: 2, SNAPSHOT_CHUNK: 3, SNAPSHOT_END: 4, RESIZED: 5, METADATA: 6, HISTORY_PAGE: 7 });
